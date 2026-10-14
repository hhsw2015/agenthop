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

# --- A2-CPA-STATE ① ancestor EACCES: L0 dir itself unreadable => NA (not laundered to 0 by a boolean -e); recovery reports incomplete ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '3' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
chmod 000 "$L0"
rc=$(up "$L0")
chmod 700 "$L0"
ck "L0-000 recovery: exit 3 (ancestor EACCES not laundered to up+clean)" "3" "$rc"
ck "L0-000 recovery: alert preserved" "1" "$(alert "$L0")"
ck "L0-000 recovery: count untouched" "3" "$(streak "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE ① ancestor EACCES on the DOWN path: L0 dir 000 => read_cur must be NA (exit 2), not laundered to 0 and advanced ---
# (isolates read_cur's ancestor classification; the recovery case above is also caught by remove_alert, this one is not)
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '2' >"$L0/cpa-probe.state"
chmod 000 "$L0"
rc=$(down "$L0")
chmod 700 "$L0"
ck "L0-000 down: exit 2 (ancestor EACCES => NA, not advanced)" "2" "$rc"
ck "L0-000 down: count not advanced (still 2)" "2" "$(streak "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE ② ancestor EACCES: alerts parent dir unreadable => remove_alert reports incomplete, not a silent clean ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '0' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
chmod 000 "$L0/alerts"
rc=$(up "$L0")
chmod 700 "$L0/alerts"
ck "alerts-000 recovery: exit 3 (cleanup incomplete, not silent)" "3" "$rc"
ck "alerts-000 recovery: alert NOT silently cleared" "1" "$(alert "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE ③ order: persist ZERO before clearing the alert — a failed persist must leave the alert (not clear-then-fail) ---
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '3' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
chmod 500 "$L0"
rc=$(up "$L0")
chmod 700 "$L0"
ck "persist-first order: exit 3 (write-zero failed)" "3" "$rc"
ck "persist-first order: alert NOT cleared before a confirmed zero" "1" "$(alert "$L0")"
ck "persist-first order: count still 3 (not reset)" "3" "$(streak "$L0")"
rm -rf "$L0"

# --- A2-CPA-STATE Unicode digits: a carrier of Unicode digits (fullwidth/Arabic — str.isdigit() accepts them) must be NA, never passed
# to Bash arithmetic. Assert: unavailable exit 2 + count unchanged + no arithmetic breakage (clean exit 2, not a stray code). ---
for u in 'ff13:fullwidth' '0663:arabic'; do
  cp="${u%%:*}"; name="${u##*:}"
  L0="$(newL0)"; mkdir -p "$L0/alerts"
  python3 -c 'import sys; open(sys.argv[1],"w").write(chr(int(sys.argv[2],16)))' "$L0/cpa-probe.state" "$cp"
  before="$(cat "$L0/cpa-probe.state")"
  rc=$(down "$L0")
  ck "unicode-digit ($name): exit 2 (NA, not advanced, no arithmetic)" "2" "$rc"
  ck "unicode-digit ($name): carrier unchanged" "$before" "$(cat "$L0/cpa-probe.state")"
  rm -rf "$L0"
done

# --- F1 three-state probe: UNKNOWN (CPA listening but non-200, e.g. the auth-gated 401 behind F1's false alarm) is a NO-OP, never a
# false DOWN. Uses the AGENTHOP_CPA_HTTP seam to inject an HTTP code so the classification is tested without a live server. ---
httprc() { AGENTHOP_CPA_HTTP="$2" AGENTHOP_CPA_RC="${3:-0}" bash "$PROBE" "$1" >/dev/null 2>&1; echo $?; }

for code in 401 404 503; do
  L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '2' >"$L0/cpa-probe.state"
  rc=$(httprc "$L0" "$code")
  ck "F1 unknown ($code): exit 4 (inconclusive no-op)" "4" "$rc"
  ck "F1 unknown ($code): streak untouched (still 2, not advanced to a false DOWN)" "2" "$(streak "$L0")"
  ck "F1 unknown ($code): no alert fabricated" "0" "$(alert "$L0")"
  rm -rf "$L0"
done

# UNKNOWN must NOT clear a STANDING alert (401 is not an UP)
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '3' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
rc=$(httprc "$L0" 401)
ck "F1 unknown: exit 4" "4" "$rc"
ck "F1 unknown: standing alert NOT cleared (not UP)" "1" "$(alert "$L0")"
ck "F1 unknown: streak preserved (still 3)" "3" "$(streak "$L0")"
rm -rf "$L0"

# UP via injected 200 => recovery clears the alert
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '2' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
rc=$(httprc "$L0" 200)
ck "F1 up (200): exit 0" "0" "$rc"; ck "F1 up (200): alert cleared" "0" "$(alert "$L0")"; ck "F1 up (200): streak reset 0" "0" "$(streak "$L0")"
rm -rf "$L0"

# DOWN only on a real connection failure (000) — the single true DOWN; advances to the 3-strike alert
L0="$(newL0)"; mkdir -p "$L0/alerts"
httprc "$L0" 000 >/dev/null; httprc "$L0" 000 >/dev/null
rc=$(httprc "$L0" 000)
ck "F1 down (000 connfail): 3-strike alert" "1" "$(alert "$L0")"
ck "F1 down (000 connfail): exit 1" "1" "$rc"
ck "F1 down (000 connfail): streak 3" "3" "$(streak "$L0")"
rm -rf "$L0"

# hook three-state mapping: a hook exiting 2 => UNKNOWN (exit 4), streak untouched
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '1' >"$L0/cpa-probe.state"
cat >"$L0/hook2.sh" <<'HK'
#!/usr/bin/env bash
exit 2
HK
chmod +x "$L0/hook2.sh"
rc=$(AGENTHOP_CPA_PROBE="$L0/hook2.sh" bash "$PROBE" "$L0" >/dev/null 2>&1; echo $?)
ck "F1 hook exit2 => UNKNOWN exit 4" "4" "$rc"
ck "F1 hook exit2 => streak untouched (still 1)" "1" "$(streak "$L0")"
rm -rf "$L0"

# --- F1 r2 (F1-CURL-RESULT): a 200 is only the HEADER; a failed transfer (curl rc != 0) must be DOWN, never UP/clear. The status-code x
# exit-code matrix. Uses the AGENTHOP_CPA_RC seam to inject the curl exit. TEETH: with the old "200 first" order, 200+rc18/rc28 read UP. ---

# 200 + rc0 (complete) — positive control => UP, clears a standing alert
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '2' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
rc=$(httprc "$L0" 200 0)
ck "F1r2 200+rc0 (complete): exit 0 UP" "0" "$rc"
ck "F1r2 200+rc0: alert cleared" "0" "$(alert "$L0")"
rm -rf "$L0"

# 200 + rc18 (truncated body mid-transfer) => DOWN: must NOT clear a standing alert, must advance the streak
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '2' >"$L0/cpa-probe.state"; printf '{"kind":"cpa_down"}' >"$L0/alerts/cpa_down.json"
rc=$(httprc "$L0" 200 18)
ck "F1r2 200+rc18 (truncated): NOT UP — exit 1 DOWN" "1" "$rc"
ck "F1r2 200+rc18: standing alert NOT cleared (transfer failed)" "1" "$(alert "$L0")"
ck "F1r2 200+rc18: streak advanced (2->3)" "3" "$(streak "$L0")"
rm -rf "$L0"

# 200 + rc28 (read timeout mid-transfer) => DOWN: three strikes raise the alert
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '0' >"$L0/cpa-probe.state"
httprc "$L0" 200 28 >/dev/null; httprc "$L0" 200 28 >/dev/null; rc=$(httprc "$L0" 200 28)
ck "F1r2 200+rc28 (timeout): 3-strike alert (true DOWN)" "1" "$(alert "$L0")"
ck "F1r2 200+rc28: exit 1" "1" "$rc"
rm -rf "$L0"

# 401 + rc0 (complete) => still UNKNOWN (reorder must not regress the UNKNOWN face)
L0="$(newL0)"; mkdir -p "$L0/alerts"; printf '2' >"$L0/cpa-probe.state"
rc=$(httprc "$L0" 401 0)
ck "F1r2 401+rc0: still UNKNOWN exit 4 (reorder preserved)" "4" "$rc"
ck "F1r2 401+rc0: streak untouched (still 2)" "2" "$(streak "$L0")"
rm -rf "$L0"

if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
