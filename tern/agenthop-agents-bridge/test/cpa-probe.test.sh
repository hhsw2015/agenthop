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

# --- A2-CPA-STATE: state-write fail on recovery => exit 3 (incomplete) + streak NOT reset (alert cleanup is a separate concern below) ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '3' >"$L0/cpa-probe.state"
chmod 500 "$L0"                                  # L0 read-exec only => temp (mktemp in L0) + atomic persist fail
rc=$(up "$L0"); chmod 700 "$L0"
ck "state-write-fail recovery: exit 3 (incomplete)" "3" "$rc"
ck "state-write-fail recovery: streak NOT reset" "3" "$(streak "$L0")"
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

# --- A2-CPA-STATE fix a: a success idempotently clears a standing alert even when the streak is already 0 (no fast-path skip) ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '0' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
rc=$(up "$L0"); ck "zero-count recovery: standing alert cleared" "0" "$(alert "$L0")"; ck "zero-count recovery: exit 0" "0" "$rc"
rm -rf "$L0"

# --- A2-CPA-STATE fix a: a failed alert removal reports incomplete, never a silent success ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '0' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
chmod 500 "$L0/alerts"
rc=$(up "$L0"); chmod 700 "$L0/alerts"
ck "recovery removal-fail: exit 3 (incomplete)" "3" "$rc"
ck "recovery removal-fail: alert NOT silently cleared" "1" "$(alert "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE fix b: a present-but-unreadable symlink carrier is NA and PRESERVED (not clobbered to a fake count) ---
L0="$(newL0)"; mkdir -p "$L0/alerts" "$L0/prot"; printf '2' >"$L0/prot/real"; ln -s "$L0/prot/real" "$L0/cpa-probe.state"; chmod 000 "$L0/prot"
rc=$(down "$L0"); chmod 700 "$L0/prot"
ck "symlink-EACCES carrier: exit 2 (unavailable)" "2" "$rc"
ck "symlink-EACCES carrier: still a symlink (not clobbered)" "1" "$([ -L "$L0/cpa-probe.state" ] && echo 1 || echo 0)"
ck "symlink-EACCES carrier: underlying count untouched" "2" "$(cat "$L0/prot/real")"
rm -rf "$L0"

# --- A2-CPA-TEMP-OWN: foreign objects in the state dir are never written/moved/removed; no leftover temp (mktemp exclusive) ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf 'VICTIM' >"$L0/victim"; printf 'DECOY' >"$L0/decoy"; ln -s "$L0/victim" "$L0/decoy-link"
down "$L0" >/dev/null; down "$L0" >/dev/null; down "$L0" >/dev/null
ck "temp-own: foreign regular file untouched" "DECOY" "$(cat "$L0/decoy")"
ck "temp-own: symlink victim untouched" "VICTIM" "$(cat "$L0/victim")"
ck "temp-own: foreign symlink preserved" "1" "$([ -L "$L0/decoy-link" ] && echo 1 || echo 0)"
ck "temp-own: no leftover temp files" "0" "$(find "$L0" -maxdepth 1 -name '.cpa-probe.*' 2>/dev/null | wc -l | tr -d ' ')"
ck "temp-own: write succeeded (alert at 3-strike)" "1" "$(alert "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE close-out: NA state on the RECOVERY path must NOT report up+clean; it preserves everything and reports incomplete ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '3' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
chmod 000 "$L0/cpa-probe.state"
rc=$(up "$L0")
ck "NA-recovery: exit 3 (not a silent up+clean)" "3" "$rc"
ck "NA-recovery: alert NOT removed (recovery unconfirmed)" "1" "$(alert "$L0")"
chmod 600 "$L0/cpa-probe.state"
ck "NA-recovery: count preserved (still 3, not laundered)" "3" "$(streak "$L0")"
# once readable, a real recovery completes: reset + clear + exit 0
rc=$(up "$L0"); ck "post-NA recovery (readable): exit 0" "0" "$rc"; ck "post-NA recovery: alert cleared" "0" "$(alert "$L0")"; ck "post-NA recovery: streak 0" "0" "$(streak "$L0")"
# and the 3-strike is intact afterward (no re-alert at one strike)
down "$L0" >/dev/null; ck "post-NA recovery: single fail does NOT re-alert" "0" "$(alert "$L0")"
rm -rf "$L0"

# --- A2-CPA-TEMP-OWN-GATE: deterministic same-PID collision. A wrapper plants a symlink at the r3 fixed-name temp ($state.$PID.tmp),
# then EXECs cpa-probe (same PID). A fixed-name + bare-redirect writer would follow it and clobber the victim; mktemp (r4) ignores it. ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf 'SAFE' >"$L0/victim"
cat >"$L0/wrap.sh" <<WRAP
#!/usr/bin/env bash
ln -s "$L0/victim" "$L0/cpa-probe.state.\$\$.tmp" 2>/dev/null
exec env AGENTHOP_CPA_PROBE=false bash "$PROBE" "$L0"
WRAP
chmod +x "$L0/wrap.sh"
bash "$L0/wrap.sh" >/dev/null 2>&1
ck "temp-own GATE: victim not clobbered via same-PID fixed-name temp" "SAFE" "$(cat "$L0/victim")"
rm -rf "$L0"

if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
