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
ck "summary line counts" "gc: results=1 requests_quarantined=1 tmp=1 quarantine_expired=1" "$out"
ck "old result deleted, fresh kept" "no:yes" "$([ -e "$D/results/old.json" ] && echo yes || echo no):$([ -e "$D/results/fresh.json" ] && echo yes || echo no)"
ck "orphan request MOVED to quarantine (not deleted)" "no:yes" "$([ -e "$D/requests/orphan.json" ] && echo yes || echo no):$([ -e "$D/requests/quarantine/orphan.json" ] && echo yes || echo no)"
ck "young request untouched" "yes" "$([ -e "$D/requests/new.json" ] && echo yes || echo no)"
ck "crashed temp deleted, in-flight temp kept" "no:yes" "$([ -e "$D/requests/.crash.tmp-ab" ] && echo yes || echo no):$([ -e "$D/requests/.live.tmp-cd" ] && echo yes || echo no)"
ck "expired quarantine entry deleted" "no" "$([ -e "$D/requests/quarantine/ancient.json" ] && echo yes || echo no)"
out2="$(AGENTHOP_TERN_PANES="$D" GC_NOW=$NOW bash "$GC")"
ck "idempotent: second run cleans nothing" "gc: results=0 requests_quarantined=0 tmp=0 quarantine_expired=0" "$out2"
out3="$(AGENTHOP_TERN_PANES="$W/does-not-exist" GC_NOW=$NOW bash "$GC")"; rc3=$?
ck "unreadable control dir ⇒ exit 1 (UNKNOWN), not 'nothing to clean'" "1" "$rc3"
rm -rf "$W"
if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
