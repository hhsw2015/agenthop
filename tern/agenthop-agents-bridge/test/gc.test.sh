#!/usr/bin/env bash
# Fixture for gc.sh (r10 no-leak cleanup). Builds a control dir with files of controlled mtimes and a fixed GC_NOW.
# Run: bash test/gc.test.sh
set -u
umask 022 # fixtures expect mode=755 control dirs
GC="$(cd "$(dirname "$0")/.." && pwd)/gc.sh"
fails=0
ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got: $(printf %q "$3"), want: $(printf %q "$2"))"; fails=$((fails+1)); fi; }
NOW=1800000000
mk() { mkdir -p "$(dirname "$1")"; echo x >"$1"; touch -t "$(date -r $((NOW - $2)) +%Y%m%d%H%M.%S)" "$1"; } # path age_seconds

W="$(mktemp -d)"; D="$W/ctl"
mk "$D/results/old.json" 3700        # > 1h ⇒ deleted
mk "$D/results/fresh.json" 60        # kept
mk "$D/requests/orphan.json" 400     # > 5min ⇒ quarantined
mk "$D/requests/new.json" 30         # kept (drain may still claim it)
mk "$D/requests/.crash.tmp-0a1b2c3d" 400   # crashed agenthop_tern publish (.<id>.tmp-<8hex>) ⇒ deleted
mk "$D/requests/.crash2.tmp" 400   # crashed publish.sh publish (.<id>.tmp) ⇒ deleted
mk "$D/requests/.live.tmp-0c0d0e0f" 10     # in-flight publish ⇒ kept
mk "$D/requests/quarantine/ancient.json" 90000 # > 24h ⇒ deleted
out="$(AGENTHOP_TERN_PANES="$D" GC_NOW=$NOW bash "$GC")"; rc=$?
ck "exit 0" "0" "$rc"
ck "summary line counts" "gc: results=1 requests_quarantined=1 requests_held=0 tmp=2 quarantine_expired=1 mode=755" "$out"
ck "old result deleted, fresh kept" "no:yes" "$([ -e "$D/results/old.json" ] && echo yes || echo no):$([ -e "$D/results/fresh.json" ] && echo yes || echo no)"
qf() { ls "$D/requests/quarantine/" | grep "^$1\.[0-9]*\.[0-9a-f]*\.json$" | head -1; }
ck "orphan request MOVED to quarantine under a fresh name <id>.<epoch>.<rand>.json (not deleted)" "no:yes" "$([ -e "$D/requests/orphan.json" ] && echo yes || echo no):$([ -n "$(qf orphan)" ] && echo yes || echo no)"
ck "young request untouched" "yes" "$([ -e "$D/requests/new.json" ] && echo yes || echo no)"
ck "crashed temp deleted, in-flight temp kept" "no:yes" "$([ -e "$D/requests/.crash.tmp-0a1b2c3d" ] || [ -e "$D/requests/.crash2.tmp" ] && echo yes || echo no):$([ -e "$D/requests/.live.tmp-0c0d0e0f" ] && echo yes || echo no)"
ck "expired quarantine entry deleted" "no" "$([ -e "$D/requests/quarantine/ancient.json" ] && echo yes || echo no)"
out2="$(AGENTHOP_TERN_PANES="$D" GC_NOW=$NOW bash "$GC")"
ck "idempotent: second run cleans nothing" "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0 mode=755" "$out2"
# r12 BTF-GC-QUARANTINE-AGE: the OLDEST request (90000s, older than the quarantine TTL itself) on its FIRST gc is quarantined and
# KEPT — the 24h window runs from the quarantine moment, not the request's birth
W2="$(mktemp -d)"; D2="$W2/ctl"
mk "$D2/requests/ancient-start.json" 90000; printf '{"op":"start","prompt":"p"}' >"$D2/requests/ancient-start.json"; touch -t "$(date -r $((NOW - 90000)) +%Y%m%d%H%M.%S)" "$D2/requests/ancient-start.json"
o4="$(AGENTHOP_TERN_PANES="$D2" GC_NOW=$NOW bash "$GC")"
q4="$(ls "$D2/requests/quarantine/" | grep '^ancient-start\.' | head -1)"
ck "oldest request, first gc: quarantined, NOT expired in the same run" "gc: results=0 requests_quarantined=1 requests_held=0 tmp=0 quarantine_expired=0 mode=755" "$o4"
ck "oldest request, first gc: its body survives in quarantine" '{"op":"start","prompt":"p"}' "$(cat "$D2/requests/quarantine/$q4" 2>/dev/null)"
o5="$(AGENTHOP_TERN_PANES="$D2" GC_NOW=$((NOW + 3600)) bash "$GC")"
ck "1h after quarantine it is still kept" "yes" "$([ -e "$D2/requests/quarantine/$q4" ] && echo yes || echo no)"
o6="$(AGENTHOP_TERN_PANES="$D2" GC_NOW=$((NOW + 86500)) bash "$GC")"
ck "24h after QUARANTINE (not birth) it expires" "no" "$([ -e "$D2/requests/quarantine/$q4" ] && echo yes || echo no)"
rm -rf "$W2"

# r12 BTF-GC-QUARANTINE-OWN: a same-named, unexpired quarantine entry is never overwritten
W3="$(mktemp -d)"; D3="$W3/ctl"
mk "$D3/requests/quarantine/event.json" 60; printf '{"op":"stop","agent":1}' >"$D3/requests/quarantine/event.json"; touch -t "$(date -r $((NOW - 60)) +%Y%m%d%H%M.%S)" "$D3/requests/quarantine/event.json"
mk "$D3/requests/event.json" 400; printf '{"op":"start","prompt":"p"}' >"$D3/requests/event.json"; touch -t "$(date -r $((NOW - 400)) +%Y%m%d%H%M.%S)" "$D3/requests/event.json"
o7="$(AGENTHOP_TERN_PANES="$D3" GC_NOW=$NOW bash "$GC")"
ck "same basename: the earlier quarantined stop is untouched" '{"op":"stop","agent":1}' "$(cat "$D3/requests/quarantine/event.json")"
q7="$(ls "$D3/requests/quarantine/" | grep '^event\.[0-9]' | head -1)"
ck "same basename: the new start is quarantined beside it under its own name" '{"op":"start","prompt":"p"}' "$(cat "$D3/requests/quarantine/$q7" 2>/dev/null)"
ck "same basename: both traceable (2 files in quarantine)" "2" "$(ls "$D3/requests/quarantine/" | wc -l | tr -d ' ')"
rm -rf "$W3"

# r12: a quarantine that cannot be written (read-only quarantine dir) leaves the request in requests/ — held, never deleted
W4="$(mktemp -d)"; D4="$W4/ctl"
mk "$D4/requests/held.json" 400; mkdir -p "$D4/requests/quarantine"; chmod 0555 "$D4/requests/quarantine"
o8="$(AGENTHOP_TERN_PANES="$D4" GC_NOW=$NOW bash "$GC" 2>/dev/null)"; chmod 0755 "$D4/requests/quarantine"
ck "quarantine unwritable ⇒ request held in requests/ and reported" "yes:gc: results=0 requests_quarantined=0 requests_held=1 tmp=0 quarantine_expired=0 mode=755" "$([ -e "$D4/requests/held.json" ] && echo yes || echo no):$o8"
rm -rf "$W4"

# r13 BTF-R10-P2-4: managed subdirs that are symlinks (or resolve outside the control dir) are skipped, never followed
W5="$(mktemp -d)"; D5="$W5/ctl"; X="$W5/outside"; mkdir -p "$D5" "$X/res" "$X/req" "$X/q"
mk "$X/res/victim.json" 9000; mk "$X/req/victim.json" 9000; mk "$X/q/victim.json" 900000
ln -s "$X/res" "$D5/results"
o9="$(AGENTHOP_TERN_PANES="$D5" GC_NOW=$NOW bash "$GC")"
ck "results -> outside: the outside file is untouched" "yes" "$([ -e "$X/res/victim.json" ] && echo yes || echo no)"
ck "results -> outside: reported skipped" "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0 mode=755 skipped=results(symlink)" "$o9"
rm "$D5/results"; ln -s "$X/req" "$D5/requests"
AGENTHOP_TERN_PANES="$D5" GC_NOW=$NOW bash "$GC" >/dev/null
ck "requests -> outside: the outside request is neither moved nor deleted, no quarantine created there" "yes:no" "$([ -e "$X/req/victim.json" ] && echo yes || echo no):$([ -e "$X/req/quarantine" ] && echo yes || echo no)"
rm "$D5/requests"; mkdir -p "$D5/requests"; ln -s "$X/q" "$D5/requests/quarantine"; mk "$D5/requests/orph.json" 400
o10="$(AGENTHOP_TERN_PANES="$D5" GC_NOW=$NOW bash "$GC")"
ck "quarantine -> outside: the outside entry is not expired, the request is held in place" "yes:yes" "$([ -e "$X/q/victim.json" ] && echo yes || echo no):$([ -e "$D5/requests/orph.json" ] && echo yes || echo no)"
ck "quarantine -> outside: reported held + skipped" "gc: results=0 requests_quarantined=0 requests_held=1 tmp=0 quarantine_expired=0 mode=755 skipped=quarantine(symlink)" "$o10"
rm -f "$D5/requests/quarantine" "$D5/requests/orph.json"; ln -s "$X/req/victim.json" "$D5/requests/link.json"
m0="$(stat -f %m "$X/req/victim.json")"
AGENTHOP_TERN_PANES="$D5" GC_NOW=$NOW bash "$GC" >/dev/null
ck "a symlinked request ENTRY is skipped: outside target's mtime unchanged and the link not moved" "$m0:yes" "$(stat -f %m "$X/req/victim.json"):$([ -L "$D5/requests/link.json" ] && echo yes || echo no)"
rm -rf "$W5"

# r14 BTF-GC-SOURCE-OWN: the drain claims a 400s-old list and agenthop_tern re-publishes it under the SAME id (mtime = now)
# BETWEEN gc's age check and its move. A fake `stat` (first PATH entry) plays that race: on its first look at requests/race.json it
# reports the OLD mtime, then swaps in the fresh same-id request. gc must not quarantine the fresh one; the drain must still see it.
W6="$(mktemp -d)"; D6="$W6/ctl"; mkdir -p "$D6/requests" "$W6/bin"
printf '{"op":"list","v":"old"}' >"$D6/requests/race.json"; touch -t "$(date -r $((NOW - 400)) +%Y%m%d%H%M.%S)" "$D6/requests/race.json"
cat >"$W6/bin/stat" <<SH
#!/bin/sh
f="\$3"
case "\$f" in *requests/race.json)
  if [ ! -e "$W6/raced" ]; then
    : >"$W6/raced"; echo $((NOW - 400))
    rm -f "$D6/requests/race.json"; printf '{"op":"list","v":"new"}' >"$D6/requests/race.json"; touch -t "$(date -r $NOW +%Y%m%d%H%M.%S)" "$D6/requests/race.json"
    exit 0
  fi;;
esac
exec /usr/bin/stat "\$@"
SH
chmod +x "$W6/bin/stat"
o11="$(PATH="$W6/bin:$PATH" AGENTHOP_TERN_PANES="$D6" GC_NOW=$NOW bash "$GC")"
ck "race: the swap really happened (fixture sanity)" "yes" "$([ -e "$W6/raced" ] && echo yes || echo no)"
ck "race: the FRESH same-id request is back under its own name, drainable" '{"op":"list","v":"new"}' "$(cat "$D6/requests/race.json" 2>/dev/null)"
ck "race: nothing quarantined, no held .gc-* left" "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0 mode=755:0" "$o11:$(ls -A "$D6/requests" | grep -c '^\.gc-')"
rm -rf "$W6"

# r14: a gc that crashed while holding leaves requests/.gc-<id>.<pid>.<rand>; once old, the next run quarantines it (kept)
W7="$(mktemp -d)"; D7="$W7/ctl"; mkdir -p "$D7/requests"
printf '{"op":"stop"}' >"$D7/requests/.gc-held1.123.abcd"; touch -t "$(date -r $((NOW - 400)) +%Y%m%d%H%M.%S)" "$D7/requests/.gc-held1.123.abcd"
o12="$(AGENTHOP_TERN_PANES="$D7" GC_NOW=$NOW bash "$GC")"
ck "crashed hold: quarantined under its id, body kept" '{"op":"stop"}' "$(cat "$D7"/requests/quarantine/held1.*.json 2>/dev/null)"
rm -rf "$W7"

# r15 BTF-R14-P2-1: a gc HOLD whose id contains ".tmp" is an obligation, never a publish temp. Quarantine blocked (a plain FILE
# sits where the quarantine dir should be) ⇒ the hold is kept and counted held; the real publish temps next to it are deleted.
W8="$(mktemp -d)"; D8="$W8/ctl"; mkdir -p "$D8/requests"; : >"$D8/requests/quarantine"
printf '{"op":"start","prompt":"p"}' >"$D8/requests/.gc-job.tmp.999999.abcd"; touch -t "$(date -r $((NOW - 400)) +%Y%m%d%H%M.%S)" "$D8/requests/.gc-job.tmp.999999.abcd"
printf '{"op":"stop","agent":3}' >"$D8/requests/.gc-a.123.tmp"; touch -t "$(date -r $((NOW - 400)) +%Y%m%d%H%M.%S)" "$D8/requests/.gc-a.123.tmp" # a hold whose WHOLE name ends in .tmp (id "a", pid 123, rand "tmp")
mk "$D8/requests/.pub.tmp" 400
o13="$(AGENTHOP_TERN_PANES="$D8" GC_NOW=$NOW bash "$GC")"
ck "hold with .tmp in its id, quarantine blocked: the obligation survives byte-for-byte" '{"op":"start","prompt":"p"}' "$(cat "$D8/requests/.gc-job.tmp.999999.abcd" 2>/dev/null)"
ck "a hold whose whole name ends in .tmp is still a hold (never a temp)" '{"op":"stop","agent":3}' "$(cat "$D8/requests/.gc-a.123.tmp" 2>/dev/null)"
ck "hold with .tmp in its id: counted held, only the real publish temp deleted" "gc: results=0 requests_quarantined=0 requests_held=2 tmp=1 quarantine_expired=0 mode=755 skipped=quarantine(not-a-dir):no" "$o13:$([ -e "$D8/requests/.pub.tmp" ] && echo yes || echo no)"
rm "$D8/requests/quarantine"
o14="$(AGENTHOP_TERN_PANES="$D8" GC_NOW=$NOW bash "$GC")"
ck "positive control: quarantine available ⇒ the .tmp-named hold is quarantined with its body" '{"op":"start","prompt":"p"}' "$(cat "$D8"/requests/quarantine/job.tmp.*.json 2>/dev/null)"
rm -rf "$W8"
# a file that merely CONTAINS .tmp mid-name is not a publish temp either
W9="$(mktemp -d)"; D9="$W9/ctl"; mkdir -p "$D9/requests"; mk "$D9/requests/.notes.tmp.bak" 400; mk "$D9/requests/.x.tmp-zz" 400
AGENTHOP_TERN_PANES="$D9" GC_NOW=$NOW bash "$GC" >/dev/null
ck "only exact temp shapes: .notes.tmp.bak and .x.tmp-zz (not 8 hex) are left alone" "yes:yes" "$([ -e "$D9/requests/.notes.tmp.bak" ] && echo yes || echo no):$([ -e "$D9/requests/.x.tmp-zz" ] && echo yes || echo no)"
rm -rf "$W9"
# r15 unsafe mode: a group/other-writable control dir ⇒ exit 1, nothing done
W10="$(mktemp -d)"; D10="$W10/ctl"; mkdir -p "$D10/results"; mk "$D10/results/old.json" 9000; chmod 0777 "$D10"
o15="$(AGENTHOP_TERN_PANES="$D10" GC_NOW=$NOW bash "$GC")"; rc15=$?
ck "group/other-writable control dir ⇒ exit 1 unsafe_mode, nothing deleted" "1:yes" "$rc15:$([ -e "$D10/results/old.json" ] && echo yes || echo no)"
chmod 0755 "$D10"; rm -rf "$W10"

out3="$(AGENTHOP_TERN_PANES="$W/does-not-exist" GC_NOW=$NOW bash "$GC")"; rc3=$?
ck "unreadable control dir ⇒ exit 1 (UNKNOWN), not 'nothing to clean'" "1" "$rc3"
rm -rf "$W"
if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
