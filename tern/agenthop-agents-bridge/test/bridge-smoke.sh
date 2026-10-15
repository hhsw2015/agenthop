#!/usr/bin/env bash
# bridge-smoke.sh — LIVE gate for the A1 agents-bridge on a real running Tern (#1032-D).
# The structural fixtures prove the code shape; this proves the plugin is actually alive and serving:
#   1. agents.json `tick` advances within TICK_WAIT seconds (the window VM's poll loop runs)
#   2. {op:list}  published -> drain action -> results/<id>.json exists within RESULT_WAIT s with ok=true
#      (one drain = one request since r7, so the drain is re-triggered every 0.5 s until our own result appears)
#   3. {op:eval, code:BRIDGE_EVAL_CODE} -> same, and the value is a number (default `return #cx.session:panes()`,
#      ~0.2 ms; `#cx.agents:list()` costs ~28 ms and can itself push the drain hook over budget)
#   4. budget kills of this plugin's hooks during the run, reported in columns, not one bit:
#        mirror kills   — timer / await / `command mirror` (status liveness)
#        command kills  — `command drain` / drain-start / arm (the request path; a caller's expensive op lands here)
#        tick after     — did agents.json tick still advance after the LAST kill? (yes / no / n/a)
#      PASS only if both kill counts are 0. kills > 0 with tick after = yes is a half-failure (one VM's hook died, another
#      still writes the mirror — several windows each run a window-half) and is reported as such, not as PASS.
# Every check runs on its own and reports PASS/FAIL; nothing short-circuits, so a half-failure (command
# path alive while the status mirror is dead, or the reverse) is visible. If any check fails, the summary is
# followed by diagnostics (tick, the plugin's last budget failure, unconsumed requests, log tail) and exit 1.
# The only early exit is a missing prerequisite (no timeout/jq, or the plugin not loaded): exit 2.
# Every tern call is wrapped in `timeout`.
#
# Soak (the r6 acceptance gate: kills=0 for >= 5 minutes):
#   bridge-smoke.sh --soak            runs checks 1-4 at t=0, then again 2.5 min later, then counts kills over the
#                                     WHOLE window (not just the two runs). Exit 0 only if both runs pass AND no kill
#                                     in between. SOAK_GAP (seconds, default 150) sets the gap.
#   SINCE=<ISO time> bridge-smoke.sh  check 4 counts kills since that time instead of since this run's start.
#                                     Both sides are parsed to epoch (fractional seconds, Z / +HH:MM; no zone = local);
#                                     an unparseable SINCE or log timestamp FAILs check 4, never reads as an empty window.
#
# Interface (confirmed by the coordinator on r2 @5f6294b; override if it changes):
#   BRIDGE_DRAIN_ACTION  action run via `tern ctl plugins run`   default plugin.agenthop-agents-bridge.drain
#   BRIDGE_EVAL_FIELD    result field holding the eval value     default value
set -uo pipefail

if [ "${1:-}" = "--soak" ]; then
  self="${BASH_SOURCE[0]}"; gap="${SOAK_GAP:-150}"
  since="$(python3 -c 'import datetime; print(datetime.datetime.now().astimezone().isoformat(timespec="milliseconds"))')"
  echo "=== soak run 1 of 2 ($since) ==="
  bash "$self"; r1=$?
  echo ""; echo "=== waiting ${gap}s ==="; sleep "$gap"
  echo "=== soak run 2 of 2 ($(date '+%H:%M:%S')), check 4 counts kills since $since ==="
  SINCE="$since" bash "$self"; r2=$?
  echo ""
  echo "soak: run 1 exit $r1, run 2 exit $r2, window $since -> $(date '+%H:%M:%S') (${gap}s gap)"
  [ "$r1" -eq 0 ] && [ "$r2" -eq 0 ] && { echo "soak: PASS"; exit 0; }
  echo "soak: FAIL"; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH="$HERE/../publish.sh"
TERN="${TERN_BIN:-tern}"
CTRL="${BRIDGE_CTRL_DIR:-$HOME/.agenthop/tern-panes}"
LOG="${TERN_LOG:-$HOME/Library/Logs/Tern/tern.log}"
DRAIN_ACTION="${BRIDGE_DRAIN_ACTION:-plugin.agenthop-agents-bridge.drain}"
EVAL_FIELD="${BRIDGE_EVAL_FIELD:-value}"
# r7: cx.agents:list() alone costs ~28 ms of the 50 ms drain budget, so the smoke must not use it as its probe.
EVAL_CODE="${BRIDGE_EVAL_CODE:-return #cx.session:panes()}"
TICK_WAIT="${TICK_WAIT:-3}"
RESULT_WAIT="${RESULT_WAIT:-2}"
TERN_TIMEOUT="${TERN_TIMEOUT:-5}"
PLUGIN_ID="agenthop-agents-bridge"

for bin in timeout jq; do command -v "$bin" >/dev/null || { echo "bridge-smoke: missing $bin" >&2; exit 2; }; done

# Log identity at start (dev:inode:size). Check 4 reads only what was appended after it, or the whole file if the log
# was replaced (rotation) or truncated meanwhile. A log that cannot be stat'ed now is recorded and makes check 4 FAIL.
LOGWIN="$HERE/smoke-logwindow.py"
LOG_MARK=""; LOG_MARK_ERR=""
if [ -e "$LOG" ]; then
  LOG_MARK="$(python3 "$LOGWIN" mark "$LOG" 2>&1)" || { LOG_MARK_ERR="$LOG_MARK"; LOG_MARK=""; }
fi

tick(){ jq -r '.tick // empty' "$CTRL/agents.json" 2>/dev/null; }
# r4+ writes `vm` (a per-load id). A different vm means the plugin was reloaded and tick restarted from 1, which is
# not a stall. Older bridges write no vm: then only the tick is compared.
vm(){ jq -r '.vm // empty' "$CTRL/agents.json" 2>/dev/null; }
tick_ms(){ jq -r '"tick_ms=\(.tick_ms // "-") tick_ms_max=\(.tick_ms_max // "-")"' "$CTRL/agents.json" 2>/dev/null; }

PASSED=() FAILED=()
pass(){ echo "PASS - $1"; PASSED+=("$1"); }
fail(){ echo "FAIL - $1"; FAILED+=("$1"); }

# Publish a request, trigger the drain action, wait for its result. On success prints the result JSON and
# returns 0; on failure prints the reason and returns 1 (the caller records the FAIL, the script continues).
roundtrip(){
  local json="$1" id res i
  id="$("$PUBLISH" "$CTRL" "$json")" || { echo "publish.sh could not publish"; return 1; }
  res="$CTRL/results/$id.json"
  # r7: one drain handles ONE request. Someone else's request may be ahead of ours, so re-trigger the drain every
  # 0.5 s until our result appears (never touch other requests). Triggers are counted and reported on failure.
  local triggers=0
  for ((i = 0; i < RESULT_WAIT * 10; i++)); do
    if (( i % 5 == 0 )); then
      timeout "$TERN_TIMEOUT" "$TERN" ctl plugins run "$DRAIN_ACTION" >/dev/null 2>&1 \
        || { echo "\`tern ctl plugins run $DRAIN_ACTION\` failed or timed out (${TERN_TIMEOUT}s), request $id"; return 1; }
      triggers=$((triggers + 1))
    fi
    [ -s "$res" ] && break
    sleep 0.1
  done
  [ -s "$res" ] || { echo "no results/$id.json within ${RESULT_WAIT}s ($triggers drain triggers)"; return 1; }
  cat "$res"
  rm -f "$res"
}

# 0. prerequisite: tern answers and the plugin is loaded. Without it every check below is meaningless.
if ! timeout "$TERN_TIMEOUT" "$TERN" plugin list --json 2>/dev/null \
  | jq -e --arg id "$PLUGIN_ID" '.plugins[] | select(.id == $id)' >/dev/null; then
  echo "bridge-smoke: plugin $PLUGIN_ID not loaded (or \`tern plugin list\` timed out) — cannot run the checks" >&2
  exit 2
fi
echo "ok   - plugin $PLUGIN_ID loaded"

# 1. tick advances (status mirror alive).
#    r4+: `vm` is a per-load id. A vm change = reload: the tick restarted, so the baseline restarts on the new vm and
#    PASS still needs that SAME vm to advance afterwards. A reload followed by a freeze, or a vm that keeps changing,
#    is a FAIL. r8+: `timer=stopped-late` means the timer accelerator stopped itself (background throttling); liveness
#    is then the outside `mirror` command sweep (~5 s), so the expected rate is the sweep's, not 750 ms — reported.
t0="$(tick)"; v0="$(vm)"
if ! [[ "$t0" =~ ^[0-9]+$ ]]; then
  fail "1 tick: agents.json tick unreadable or not a number: '$t0'"
else
  sleep "$TICK_WAIT"
  t1="$(tick)"; v1="$(vm)"
  reload_note=""
  if [ -n "$v0" ] && [ -n "$v1" ] && [ "$v0" != "$v1" ] && [[ "$t1" =~ ^[0-9]+$ ]]; then
    reload_note="reloaded (vm $v0 -> $v1), re-baselined at $t1; "
    t0="$t1"; v0="$v1"
    sleep "$TICK_WAIT"
    t1="$(tick)"; v1="$(vm)"
  fi
  timer_state="$(jq -r '.timer // empty' "$CTRL/agents.json" 2>/dev/null)"
  if [ -n "$v0" ] && [ -n "$v1" ] && [ "$v0" != "$v1" ]; then
    fail "1 tick: ${reload_note}vm changed AGAIN ($v0 -> $v1): no single vm observed advancing"
  elif [[ "$t1" =~ ^[0-9]+$ ]] && [ "$t1" -gt "$t0" ]; then
    # Rate column: the bridge's timer chain ticks every 750 ms; an outside sweep (`tern ctl ... mirror`) every few
    # seconds also moves it. With the timer running, a low rate means the chain is dying; with timer=stopped-late,
    # the sweep alone is expected.
    steps=$((t1 - t0)); want=$(( TICK_WAIT * 1000 / 750 ))
    if [ "$timer_state" = "stopped-late" ]; then rate="timer=stopped-late (throttled, by design): liveness from the outside mirror sweep"
    elif [ "$steps" -ge $(( want / 2 )) ]; then rate="timer chain alive"
    else rate="LOW: timer chain likely dead, tick kept alive by outside mirror calls"; fi
    pass "1 tick ${reload_note}advances ($t0 -> $t1 in ${TICK_WAIT}s = $steps steps, ~$want expected; $rate${v1:+; vm $v1})"
  else
    fail "1 tick: ${reload_note}did not advance in ${TICK_WAIT}s ($t0 -> $t1${v1:+, vm $v1}${timer_state:+, timer=$timer_state})"
  fi
fi

# 2. list round-trip (command path alive)
if r="$(roundtrip '{"op":"list"}')"; then
  if echo "$r" | jq -e '.ok == true and (.agents | type == "array")' >/dev/null 2>&1; then
    pass "2 list round-trip ok ($(echo "$r" | jq '.agents | length') agents)"
  else
    fail "2 list: result not ok/agents[]: $r"
  fi
else
  fail "2 list: $r"
fi

# 3. eval round-trip
if r="$(roundtrip "$(jq -cn --arg c "$EVAL_CODE" '{op: "eval", code: $c}')")"; then
  if echo "$r" | jq -e --arg f "$EVAL_FIELD" '.ok == true and (.[$f] | type == "number")' >/dev/null 2>&1; then
    pass "3 eval round-trip ok ($EVAL_CODE => $(echo "$r" | jq --arg f "$EVAL_FIELD" '.[$f]'))"
  else
    fail "3 eval: result not ok with numeric .$EVAL_FIELD: $r"
  fi
else
  fail "3 eval: $r"
fi

# 4. budget kills since start, two columns. Runs last so it covers checks 1-3. Tern logs
#    `... exceeded its budget; disabled until reload plugin="<id>" hook="<hook>"` (the id AFTER `exceeded`), plus a second
#    `handler failed ... exceeded 50 ms` line for the same kill — only the first form is counted, so one kill = 1.
window_err=""
if [ -n "${SINCE:-}" ]; then
  window_desc="since $SINCE"
  window_lines="$(python3 "$LOGWIN" since "$LOG" "$SINCE" 2>/tmp/smoke-logwin.$$)" || window_err="$(cat /tmp/smoke-logwin.$$)"
elif [ -n "$LOG_MARK_ERR" ]; then
  window_desc="since start"; window_err="log unreadable at start: $LOG_MARK_ERR"
elif [ -z "$LOG_MARK" ]; then
  window_desc="since start (log appeared during the run)"
  [ -e "$LOG" ] && { window_lines="$(python3 "$LOGWIN" offset "$LOG" "0:0:0" 2>/tmp/smoke-logwin.$$)" || window_err="$(cat /tmp/smoke-logwin.$$)"; }
else
  window_desc="since start"
  window_lines="$(python3 "$LOGWIN" offset "$LOG" "$LOG_MARK" 2>/tmp/smoke-logwin.$$)" || window_err="$(cat /tmp/smoke-logwin.$$)"
fi
rm -f /tmp/smoke-logwin.$$
if [ ! -e "$LOG" ]; then
  fail "4 tern log not found at $LOG"
elif [ -n "$window_err" ]; then
  fail "4 kill window could not be read ($window_desc): $window_err"
else
  kills="$(printf '%s\n' "$window_lines" | grep -F "exceeded its budget" | grep -F "plugin=\"$PLUGIN_ID\"" || true)"
  # Two groups, reported separately: the MIRROR (status liveness: timer / await / command mirror) and the COMMAND
  # path (command drain / drain-start / arm / anything else). One bit would hide which half died.
  count_hooks(){ # stdin: kill lines -> "N|hook x a, hook x b"
    local lines; lines="$(cat)"
    [ -z "$lines" ] && { echo "0|"; return; }
    printf '%s\n' "$(printf '%s\n' "$lines" | grep -c .)|$(printf '%s\n' "$lines" | sed -n 's/.*hook="\([^"]*\)".*/\1/p' | sort | uniq -c \
      | awk '{n=$1; $1=""; sub(/^ /, ""); printf "%s%s x%s", (NR>1?", ":""), $0, n}')"
  }
  mirror_re='hook="(timer|await|command mirror)"'
  m="$(printf '%s\n' "$kills" | grep -E "$mirror_re" | count_hooks)"
  c="$(printf '%s\n' "$kills" | grep -vE "$mirror_re" | grep . | count_hooks)"
  mk="${m%%|*}"; mh="${m#*|}"; ck="${c%%|*}"; ch="${c#*|}"
  after="n/a"
  if [ $((mk + ck)) -gt 0 ]; then
    a="$(tick)"; sleep "$TICK_WAIT"; b="$(tick)"   # does the mirror still move after the last kill?
    if [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]] && [ "$b" -gt "$a" ]; then after="yes ($a -> $b)"; else after="no ($a -> $b)"; fi
  fi
  line="4 mirror kills=$mk${mh:+ [$mh]}  command kills=$ck${ch:+ [$ch]}  ($window_desc)  tick after=$after"
  if [ $((mk + ck)) -eq 0 ]; then pass "$line"; else fail "$line"; fi
fi

echo ""
echo "bridge-smoke summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed"
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "bridge-smoke: PASS"
  exit 0
fi
for f in "${FAILED[@]}"; do echo "  FAIL - $f"; done
{
  echo "--- diagnostics ---"
  echo "tick now: $(tick || echo '(unreadable)'), vm: $(vm || true), $(tick_ms || true), agents.json last written $(date -r "$CTRL/agents.json" '+%H:%M:%S' 2>/dev/null || echo '?')"
  echo "tern sessions / window clients (each window runs its own window-half VM, all writing agents.json):"
  timeout "$TERN_TIMEOUT" "$TERN" ls --json 2>/dev/null | jq -r '"  sessions: \(.sessions | length) [\([.sessions[].name] | join(", "))]"' 2>/dev/null || echo "  sessions: (tern ls failed)"
  timeout "$TERN_TIMEOUT" "$TERN" inspect --json 2>/dev/null | jq -r '"  window clients: \([.clients[] | select(.kind == "window")] | length)"' 2>/dev/null || echo "  window clients: (tern inspect failed)"
  # r5 (always) / r6+ (only with the debug switch on): the mirror writes mirror-phase.json BEFORE each segment. phase != done with the same vm/tick as a stalled
  # agents.json names the segment that was running when the hook was killed.
  echo "mirror-phase.json (phase breadcrumb):"
  if [ -f "$CTRL/mirror-phase.json" ]; then
    echo "  $(cat "$CTRL/mirror-phase.json") (written $(date -r "$CTRL/mirror-phase.json" '+%H:%M:%S'))"
    jq -r 'if .phase == "done" then "  last tick completed: list \(.list_ms)ms, slim \(.slim_ms)ms, encode \(.encode_ms)ms, write \(.write_ms)ms (cumulative)"
           else "  STOPPED IN SEGMENT: \(.phase) (vm \(.vm), tick \(.tick), \(.at_ms)ms into the tick)" end' \
      "$CTRL/mirror-phase.json" 2>/dev/null || echo "  (unparseable)"
  else
    echo "  (absent: bridge older than r5, or r6+ with the phase debug switch off — AGENTHOP_BRIDGE_DEBUG_PHASE=1 or kv bridge.debug_phase=true)"
  fi
  echo "unconsumed requests:"
  ls -1 "$CTRL/requests/" 2>/dev/null | grep '\.json$' || echo "  (none)"
  echo "last $PLUGIN_ID budget/handler failure in tern.log (any time):"
  grep -E "exceeded|handler failed" "$LOG" 2>/dev/null | grep -F "$PLUGIN_ID" | tail -n 2 || true
  echo "tern.log tail:"
  tail -n 15 "$LOG" 2>/dev/null || echo "  (no log at $LOG)"
} >&2
echo "bridge-smoke: FAIL"
exit 1
