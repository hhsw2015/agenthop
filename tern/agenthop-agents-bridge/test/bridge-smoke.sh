#!/usr/bin/env bash
# bridge-smoke.sh — LIVE gate for the A1 agents-bridge on a real running Tern (#1032-D).
# The structural fixtures prove the code shape; this proves the plugin is actually alive and serving:
#   1. agents.json `tick` advances within TICK_WAIT seconds (the window VM's poll loop runs)
#   2. {op:list}  published -> drain action -> results/<id>.json exists within RESULT_WAIT s with ok=true
#   3. {op:eval, code:"return #cx.agents:list()"} -> same, and the value is a number
#   4. tern.log has no `exceeded ... agenthop-agents-bridge` budget line since this script started
# Any failure prints the tick, the log tail and the unconsumed requests, and exits non-zero.
# Every tern call is wrapped in `timeout`.
#
# Interface defaults (#1032-A not landed yet; override if Platform Dev ships different names):
#   BRIDGE_DRAIN_ACTION  action run via `tern ctl plugins run`   default plugin.agenthop-agents-bridge.drain
#   BRIDGE_EVAL_FIELD    result field holding the eval value     default value
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH="$HERE/../publish.sh"
TERN="${TERN_BIN:-tern}"
CTRL="${BRIDGE_CTRL_DIR:-$HOME/.agenthop/tern-panes}"
LOG="${TERN_LOG:-$HOME/Library/Logs/Tern/tern.log}"
DRAIN_ACTION="${BRIDGE_DRAIN_ACTION:-plugin.agenthop-agents-bridge.drain}"
EVAL_FIELD="${BRIDGE_EVAL_FIELD:-value}"
TICK_WAIT="${TICK_WAIT:-3}"
RESULT_WAIT="${RESULT_WAIT:-2}"
TERN_TIMEOUT="${TERN_TIMEOUT:-5}"
PLUGIN_ID="agenthop-agents-bridge"

for bin in timeout jq; do command -v "$bin" >/dev/null || { echo "bridge-smoke: missing $bin" >&2; exit 2; }; done

# Log offset at start: only lines appended after this count are checked (a shrunk/rotated log is scanned whole).
LOG_START_LINES=0
[ -f "$LOG" ] && LOG_START_LINES="$(wc -l <"$LOG" | tr -d ' ')"

tick(){ jq -r '.tick // empty' "$CTRL/agents.json" 2>/dev/null; }

diag(){
  echo "--- diagnostics ---" >&2
  echo "tick now: $(tick || echo '(unreadable)')" >&2
  echo "unconsumed requests:" >&2
  ls -1 "$CTRL/requests/" 2>/dev/null | grep '\.json$' >&2 || echo "  (none)" >&2
  echo "last $PLUGIN_ID budget/handler failure in tern.log (any time):" >&2
  { grep -E "exceeded|handler failed" "$LOG" 2>/dev/null | grep -F "$PLUGIN_ID" | tail -n 2 || true; } >&2
  echo "tern.log tail:" >&2
  tail -n 15 "$LOG" >&2 2>/dev/null || echo "  (no log at $LOG)" >&2
}
fail(){ echo "FAIL - $*" >&2; diag; exit 1; }
ok(){ echo "ok   - $*"; }

# Publish a request, trigger the drain action, wait for its result. Prints the result JSON on stdout.
roundtrip(){
  local json="$1" id res i
  id="$("$PUBLISH" "$CTRL" "$json")" || fail "publish.sh could not publish $json"
  timeout "$TERN_TIMEOUT" "$TERN" ctl plugins run "$DRAIN_ACTION" >/dev/null 2>&1 \
    || fail "\`tern ctl plugins run $DRAIN_ACTION\` failed or timed out (${TERN_TIMEOUT}s) for request $id"
  res="$CTRL/results/$id.json"
  for ((i = 0; i < RESULT_WAIT * 10; i++)); do
    [ -s "$res" ] && break
    sleep 0.1
  done
  [ -s "$res" ] || fail "no results/$id.json within ${RESULT_WAIT}s for $json"
  cat "$res"
  rm -f "$res"
}

# 0. preflight: tern answers and the plugin is loaded
timeout "$TERN_TIMEOUT" "$TERN" plugin list --json 2>/dev/null \
  | jq -e --arg id "$PLUGIN_ID" '.plugins[] | select(.id == $id)' >/dev/null \
  || fail "plugin $PLUGIN_ID not loaded (or \`tern plugin list\` timed out)"
ok "plugin $PLUGIN_ID loaded"

# 1. tick advances
t0="$(tick)"
[[ "$t0" =~ ^[0-9]+$ ]] || fail "agents.json tick unreadable or not a number: '$t0'"
sleep "$TICK_WAIT"
t1="$(tick)"
[[ "$t1" =~ ^[0-9]+$ ]] && [ "$t1" -gt "$t0" ] || fail "tick did not advance in ${TICK_WAIT}s ($t0 -> $t1)"
ok "tick advances ($t0 -> $t1)"

# 2. list round-trip
r="$(roundtrip '{"op":"list"}')" || exit 1
echo "$r" | jq -e '.ok == true and (.agents | type == "array")' >/dev/null || fail "list result not ok/agents[]: $r"
ok "list round-trip ok ($(echo "$r" | jq '.agents | length') agents)"

# 3. eval round-trip
r="$(roundtrip '{"op":"eval","code":"return #cx.agents:list()"}')" || exit 1
echo "$r" | jq -e --arg f "$EVAL_FIELD" '.ok == true and (.[$f] | type == "number")' >/dev/null \
  || fail "eval result not ok with numeric .$EVAL_FIELD: $r"
ok "eval round-trip ok (#cx.agents:list() = $(echo "$r" | jq --arg f "$EVAL_FIELD" '.[$f]'))"

# 4. no budget-exceeded line for this plugin since start. Tern writes `... exceeded its budget ... plugin="<id>" hook=...`,
#    so the plugin id comes AFTER `exceeded`; match both orders.
if [ -f "$LOG" ]; then
  now_lines="$(wc -l <"$LOG" | tr -d ' ')"
  from=$((LOG_START_LINES + 1))
  [ "$now_lines" -lt "$LOG_START_LINES" ] && from=1
  hit="$(tail -n +"$from" "$LOG" | grep -E "exceeded" | grep -F "$PLUGIN_ID" || true)"
  [ -z "$hit" ] || fail "budget exceeded since start: $hit"
  ok "no $PLUGIN_ID budget-exceeded lines since start"
else
  fail "tern log not found at $LOG"
fi

echo "bridge-smoke: PASS"
