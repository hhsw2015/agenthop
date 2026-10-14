#!/usr/bin/env bash
# Fixture for the A2 r2 ④ CPA probe (cpa-probe.sh). Injects up/down via AGENTHOP_CPA_PROBE (no real server). Proves the 3-strike gate
# (alert only on the THIRD consecutive failure) and recovery-clears (one success removes the alert + resets the streak). Run: bash test/cpa-probe.test.sh
set -u
PROBE="$(cd "$(dirname "$0")/.." && pwd)/cpa-probe.sh"
L0="$(mktemp -d)"
fails=0
ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got $(printf %q "$3") want $(printf %q "$2"))"; fails=$((fails+1)); fi; }
down() { AGENTHOP_CPA_PROBE=false bash "$PROBE" "$L0" >/dev/null 2>&1; }  # `false` => exit 1 => CPA down
up()   { AGENTHOP_CPA_PROBE=true  bash "$PROBE" "$L0" >/dev/null 2>&1; }  # `true`  => exit 0 => CPA up
alert() { [ -f "$L0/alerts/cpa_down.json" ] && echo 1 || echo 0; }
streak() { tr -dc '0-9' <"$L0/cpa-probe.state" 2>/dev/null; }

down; ck "fail 1: no alert yet" "0" "$(alert)"
down; ck "fail 2: no alert yet" "0" "$(alert)"
down; ck "fail 3: CPA-DOWN alert written (3-strike)" "1" "$(alert)"
ck "streak recorded" "3" "$(streak)"
up;   ck "recovery: alert cleared" "0" "$(alert)"
ck    "recovery: streak reset to 0" "0" "$(streak)"
# streak must restart after recovery: a single fail does NOT immediately re-alert
down; ck "post-recovery fail 1: no alert" "0" "$(alert)"
down; ck "post-recovery fail 2: no alert" "0" "$(alert)"
down; ck "post-recovery fail 3: re-alerts" "1" "$(alert)"

rm -rf "$L0"
if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
