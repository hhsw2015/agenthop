#!/usr/bin/env bash
# Fixture for gc.sh (r10 no-leak cleanup). Builds a control dir with files of controlled mtimes and a fixed GC_NOW.
# Run: bash test/gc.test.sh
set -u
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
mk "$D/requests/.crash.tmp-ab" 400   # crashed publish ⇒ deleted
mk "$D/requests/.live.tmp-cd" 10     # in-flight publish ⇒ kept
mk "$D/requests/quarantine/ancient.json" 90000 # > 24h ⇒ deleted
out="$(AGENTHOP_TERN_PANES="$D" GC_NOW=$NOW bash "$GC")"; rc=$?
ck "exit 0" "0" "$rc"
ck "summary line counts" "gc: results=1 requests_quarantined=1 requests_held=0 tmp=1 quarantine_expired=1" "$out"
ck "old result deleted, fresh kept" "no:yes" "$([ -e "$D/results/old.json" ] && echo yes || echo no):$([ -e "$D/results/fresh.json" ] && echo yes || echo no)"
qf() { ls "$D/requests/quarantine/" | grep "^$1\.[0-9]*\.[0-9a-f]*\.json$" | head -1; }
ck "orphan request MOVED to quarantine under a fresh name <id>.<epoch>.<rand>.json (not deleted)" "no:yes" "$([ -e "$D/requests/orphan.json" ] && echo yes || echo no):$([ -n "$(qf orphan)" ] && echo yes || echo no)"
ck "young request untouched" "yes" "$([ -e "$D/requests/new.json" ] && echo yes || echo no)"
ck "crashed temp deleted, in-flight temp kept" "no:yes" "$([ -e "$D/requests/.crash.tmp-ab" ] && echo yes || echo no):$([ -e "$D/requests/.live.tmp-cd" ] && echo yes || echo no)"
ck "expired quarantine entry deleted" "no" "$([ -e "$D/requests/quarantine/ancient.json" ] && echo yes || echo no)"
out2="$(AGENTHOP_TERN_PANES="$D" GC_NOW=$NOW bash "$GC")"
ck "idempotent: second run cleans nothing" "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0" "$out2"
# r12 BTF-GC-QUARANTINE-AGE: the OLDEST request (90000s, older than the quarantine TTL itself) on its FIRST gc is quarantined and
# KEPT — the 24h window runs from the quarantine moment, not the request's birth
W2="$(mktemp -d)"; D2="$W2/ctl"
mk "$D2/requests/ancient-start.json" 90000; printf '{"op":"start","prompt":"p"}' >"$D2/requests/ancient-start.json"; touch -t "$(date -r $((NOW - 90000)) +%Y%m%d%H%M.%S)" "$D2/requests/ancient-start.json"
o4="$(AGENTHOP_TERN_PANES="$D2" GC_NOW=$NOW bash "$GC")"
q4="$(ls "$D2/requests/quarantine/" | grep '^ancient-start\.' | head -1)"
ck "oldest request, first gc: quarantined, NOT expired in the same run" "gc: results=0 requests_quarantined=1 requests_held=0 tmp=0 quarantine_expired=0" "$o4"
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
ck "quarantine unwritable ⇒ request held in requests/ and reported" "yes:gc: results=0 requests_quarantined=0 requests_held=1 tmp=0 quarantine_expired=0" "$([ -e "$D4/requests/held.json" ] && echo yes || echo no):$o8"
rm -rf "$W4"

out3="$(AGENTHOP_TERN_PANES="$W/does-not-exist" GC_NOW=$NOW bash "$GC")"; rc3=$?
ck "unreadable control dir ⇒ exit 1 (UNKNOWN), not 'nothing to clean'" "1" "$rc3"
rm -rf "$W"
if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
