#!/usr/bin/env bash
# Fixture for the A2 r2 ④ CPA probe (cpa-probe.sh). Injects up/down via AGENTHOP_CPA_PROBE. Covers the 3-strike gate + recovery-clears,
# and the r2 seams: A2-CPA-STATE (read-unavailable must not launder to 0 / reset; write-fail must not false-clear; bad text = unavailable)
# and A2-CPA-JSON (a quoted URL stays parseable). Run: bash test/cpa-probe.test.sh
set -u
PROBE="$(cd "$(dirname "$0")/.." && pwd)/cpa-probe.sh"
fails=0
ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got $(printf %q "$3") want $(printf %q "$2"))"; fails=$((fails+1)); fi; }
newL0() { mktemp -d; }
down() { AGENTHOP_CPA_PROBE=false bash "$PROBE" "$1" >/dev/null 2>&1; echo $?; }
up()   { AGENTHOP_CPA_PROBE=true  bash "$PROBE" "$1" >/dev/null 2>&1; echo $?; }
alert() { [ -f "$1/alerts/cpa_down.json" ] && echo 1 || echo 0; }
streak() { tr -dc '0-9' <"$1/cpa-probe.state" 2>/dev/null; }

# --- 3-strike + recovery ---
L0="$(newL0)"
down "$L0" >/dev/null; ck "fail 1: no alert" "0" "$(alert "$L0")"
down "$L0" >/dev/null; ck "fail 2: no alert" "0" "$(alert "$L0")"
rc=$(down "$L0"); ck "fail 3: alert (3-strike)" "1" "$(alert "$L0")"; ck "fail 3: exit 1" "1" "$rc"
ck "streak=3" "3" "$(streak "$L0")"
rc=$(up "$L0"); ck "recovery: alert cleared" "0" "$(alert "$L0")"; ck "recovery: exit 0" "0" "$rc"; ck "recovery: streak 0" "0" "$(streak "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE: read-unavailable must NOT launder to 0 / reset the streak ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '2' >"$L0/cpa-probe.state"; chmod 000 "$L0/cpa-probe.state"
rc=$(down "$L0"); ck "read-unavailable: exit 2 (not advanced)" "2" "$rc"
chmod 600 "$L0/cpa-probe.state"
ck "read-unavailable: streak preserved (not reset to 0)" "2" "$(streak "$L0")"
ck "read-unavailable: no alert fabricated" "0" "$(alert "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE: bad text = unavailable (not silently 0) ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf 'garbage' >"$L0/cpa-probe.state"
rc=$(down "$L0"); ck "bad-text: exit 2 (unavailable)" "2" "$rc"
ck "bad-text: not laundered to a count" "garbage" "$(cat "$L0/cpa-probe.state")"
ck "bad-text: no alert" "0" "$(alert "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE: write-fail on recovery must NOT false-clear the alert ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '3' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
chmod 500 "$L0"                                  # dir read-exec only => temp write (atomic persist) fails
rc=$(up "$L0"); ck "write-fail recovery: exit 3" "3" "$rc"
chmod 700 "$L0"
ck "write-fail recovery: alert NOT false-cleared" "1" "$(alert "$L0")"
ck "write-fail recovery: streak NOT reset" "3" "$(streak "$L0")"
rm -rf "$L0"

# --- A2-CPA-JSON: a quoted URL stays parseable; fields round-trip ---
L0="$(newL0)"
qurl='http://127.0.0.1:8318/v1/models?x="q"&y=1'
AGENTHOP_CPA_URL="$qurl" AGENTHOP_CPA_PROBE=false bash "$PROBE" "$L0" >/dev/null 2>&1
AGENTHOP_CPA_URL="$qurl" AGENTHOP_CPA_PROBE=false bash "$PROBE" "$L0" >/dev/null 2>&1
AGENTHOP_CPA_URL="$qurl" AGENTHOP_CPA_PROBE=false bash "$PROBE" "$L0" >/dev/null 2>&1
parsed="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["kind"], d["consecutive_fails"], d["url"]==sys.argv[2])' "$L0/alerts/cpa_down.json" "$qurl" 2>&1)"
ck "quoted-url: alert JSON parses + fields round-trip" "cpa_down 3 True" "$parsed"
rm -rf "$L0"

if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
