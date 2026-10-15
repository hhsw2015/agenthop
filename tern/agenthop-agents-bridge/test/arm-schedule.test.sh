#!/usr/bin/env bash
# Fixture for arm-schedule.sh (#1036 r9). A FAKE tern records argv and plays (a) `ctl carly task add` (adds one task; fails like the
# real ctl when a raw '#' is present; mode okghost answers ok WITHOUT creating anything) and (b) the plugin's read-only
# `…arm-scan` command (writes sentinel.json {step:"scanned", count}); mode deadscan makes arm-scan write nothing.
# Run: bash test/arm-schedule.test.sh

set -u
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/arm-schedule.sh"
fails=0
ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got: $(printf %q "$3"), want: $(printf %q "$2"))"; fails=$((fails+1)); fi; }

setup() { # mode initial-task-count
  W="$(mktemp -d)"; mkdir -p "$W/ctl"
  echo "$1" >"$W/mode"; echo "${2:-0}" >"$W/count"
  cat >"$W/tern" <<'EOF'
#!/usr/bin/env bash
W="$(dirname "$0")"; echo "$*" >>"$W/argv.log"; MODE=$(cat "$W/mode")
if [ "$1 $2 $3 $4" = "ctl carly task add" ]; then
  shift 4; spec="$*"
  case "$spec" in *'#'*) echo '{"ok":false,"error":"EOF while parsing a string"}'; exit 0;; esac
  printf '%s' "$spec" >"$W/task.json"
  [ "$MODE" = okghost ] || echo $(( $(cat "$W/count") + 1 )) >"$W/count"
  echo '{"ok":true}'; exit 0
fi
if [ "$1 $2 $3 $4" = "ctl plugins run plugin.agenthop-agents-bridge.arm-scan" ]; then
  [ "$MODE" = deadscan ] && { echo '{"ok":true}'; exit 0; }
  printf '{"step":"scanned","count":%s}' "$(cat "$W/count")" >"$W/ctl/sentinel.json"
  echo '{"ok":true}'; exit 0
fi
echo '{"ok":true}'; exit 0
EOF
  chmod +x "$W/tern"
  printf '%s\n' 'return function(ev, cx, state) -- see #924; #agents' 'return nil end' >"$W/src.luau"
}
run() { TERN_BIN="$W/tern" AGENTHOP_TERN_PANES="$W/ctl" AGENTHOP_SENTINEL_SRC="$W/src.luau" bash "$SCRIPT" >"$W/out" 2>&1; echo $?; }
adds() { cat "$W/argv.log" 2>/dev/null | grep 'carly task add' | wc -l | tr -d ' '; }

# 1) happy path: count 0 ⇒ add ('#' escaped) ⇒ arm-scan verifies count 1
setup normal 0; rc=$(run)
ck "happy: exit 0" "0" "$rc"
ck "happy: the spec sent to ctl has NO raw '#'" "0" "$(grep -c '#' "$W/task.json")"
ck "happy: '#' arrives as the JSON escape \\u0023" "1" "$(grep -c 'u0023924' "$W/task.json")"
ck "happy: exactly one add" "1" "$(adds)"
ck "happy: verified by a SECOND arm-scan after the add" "2" "$(grep -c 'arm-scan' "$W/argv.log")"

# 2) ctl says ok but no task appears ⇒ FAILED (ctl ok is not proof)
setup okghost 0; rc=$(run)
ck "ctl ok but task absent (scan count stays 0) ⇒ exit 1" "1" "$rc"

# 3) idempotent: a patrol already exists ⇒ refused, no add
setup normal 1; rc=$(run)
ck "count==1 already ⇒ exit 2 (refused)" "2" "$rc"
ck "count==1 already ⇒ NO add" "0" "$(adds)"

# 4) extras exist (count 2) ⇒ refused (they must be cancelled in-plugin first)
setup normal 2; rc=$(run)
ck "count==2 ⇒ exit 2, no add" "2:0" "$rc:$(adds)"

# 5) arm-scan does not answer ⇒ failed, never schedules blind (a stale status cannot answer for it)
setup deadscan 0; printf '{"step":"scanned","count":0}' >"$W/ctl/sentinel.json"; rc=$(run)
ck "scan unanswered (stale status present) ⇒ exit 1" "1" "$rc"
ck "scan unanswered ⇒ NO add" "0" "$(adds)"

if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
