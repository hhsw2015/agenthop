#!/usr/bin/env bash
# Offline gate for bridge-smoke.sh: a fake `tern` + fake control dir + fake log, never the real Tern.
# Pins the no-short-circuit rule: every check reports on its own, so a half-failure is visible.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE="$HERE/bridge-smoke.sh"

t=0; f=0
check(){ if [ "$1" = "true" ]; then echo "ok   - $2"; t=$((t+1)); else echo "FAIL - $2"; f=$((f+1)); fi; }

TMP="$(mktemp -d)"
TICKER=""
trap '[ -n "$TICKER" ] && kill "$TICKER" 2>/dev/null; rm -rf "$TMP"' EXIT

C="$TMP/ctrl"; L="$TMP/tern.log"; FAKE="$TMP/tern"
mkdir -p "$C/requests" "$C/results"

# fake tern: `plugin list` reports the bridge; `ctl plugins run` drains requests unless FAKE_DRAIN=dead.
cat >"$FAKE" <<EOF
#!/usr/bin/env bash
case "\$1 \$2" in
  "plugin list") echo '{"plugins":[{"id":"agenthop-agents-bridge"}],"problems":[]}' ;;
  "ls --json") echo '{"sessions":[{"name":"agenthop"},{"name":"work"}]}' ;;
  "inspect --json") echo '{"clients":[{"kind":"cli"},{"kind":"window"}]}' ;;
  "ctl plugins")
    [ "\${FAKE_DRAIN:-}" = dead ] && exit 0
    for q in "$C"/requests/*.json; do
      [ -f "\$q" ] || continue
      id="\$(basename "\$q" .json)"; op="\$(jq -r .op "\$q")"; rm -f "\$q"
      if [ "\$op" = list ]; then echo '{"ok":true,"agents":[{"pane":1},{"pane":2}]}'; else echo '{"ok":true,"value":2}'; fi >"$C/results/\$id.json"
    done ;;
esac
EOF
chmod +x "$FAKE"

start_ticker(){ ( i=1; while :; do echo "{\"tick\":$i,\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 0.2; done ) & TICKER=$!; }
stop_ticker(){ [ -n "$TICKER" ] && kill "$TICKER" 2>/dev/null; wait "$TICKER" 2>/dev/null; TICKER=""; }
frozen(){ echo '{"tick":2,"agents":[]}' >"$C/agents.json"; }
run(){ OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 "$@" bash "$SMOKE" 2>&1)"; RC=$?; }

bash -n "$SMOKE"; check "$([ $? -eq 0 ] && echo true)" "bash -n parses bridge-smoke.sh"

# A. healthy: all four PASS, exit 0
: >"$L"; start_ticker
run env
stop_ticker
check "$([ $RC -eq 0 ] && echo true)" "healthy: exit 0"
check "$([ "$(grep -c '^PASS - ' <<<"$OUT")" -eq 4 ] && echo true)" "healthy: 4 PASS lines"
check "$([[ "$OUT" == *'4 passed, 0 failed'* ]] && echo true)" "healthy: summary 4 passed, 0 failed"

# B. the coordinator's live case: mirror dead (tick frozen), command path alive. 1 FAIL, 2-4 still run and PASS.
: >"$L"; frozen
run env
check "$([ $RC -eq 1 ] && echo true)" "mirror dead: exit 1"
check "$([[ "$OUT" == *'FAIL - 1 tick'* ]] && echo true)" "mirror dead: check 1 FAIL"
check "$([[ "$OUT" == *'PASS - 2 list'* && "$OUT" == *'PASS - 3 eval'* ]] && echo true)" "mirror dead: checks 2 and 3 still run and PASS"
check "$([[ "$OUT" == *'PASS - 4 kills=0'* ]] && echo true)" "mirror dead: check 4 still runs"
check "$([[ "$OUT" == *'3 passed, 1 failed'* && "$OUT" == *'tick now: 2'* ]] && echo true)" "mirror dead: summary + diagnostics"

# C. the reverse: mirror alive, command path dead. 2 and 3 FAIL, 1 and 4 PASS, request left unconsumed.
: >"$L"; rm -f "$C"/requests/*.json; start_ticker
run env FAKE_DRAIN=dead RESULT_WAIT=1
stop_ticker
check "$([ $RC -eq 1 ] && echo true)" "commands dead: exit 1"
check "$([[ "$OUT" == *'PASS - 1 tick'* && "$OUT" == *'FAIL - 2 list'* && "$OUT" == *'FAIL - 3 eval'* ]] && echo true)" "commands dead: 1 PASS, 2 and 3 FAIL"
check "$([[ "$OUT" == *'2 passed, 2 failed'* ]] && echo true)" "commands dead: summary 2 passed, 2 failed"
check "$([[ "$(sed -n '/unconsumed requests:/,/last agenthop/p' <<<"$OUT")" == *'.json'* ]] && echo true)" "commands dead: diagnostics list the unconsumed requests"

KILL='WARN stencil_plugins: plugin hook exceeded its budget; disabled until reload plugin="agenthop-agents-bridge" hook="await"'
KILL2='WARN stencil_tern: plugin handler failed plugin="agenthop-agents-bridge" hook="await" error=runtime error: tern: await exceeded 50 ms'

# D. a kill during the run while the tick keeps going (another VM still writes): half-failure, both columns shown.
#    Tern's two log lines for ONE kill count as 1.
: >"$L"; rm -f "$C"/requests/*.json; start_ticker
( sleep 0.5; printf '%s\n%s\n' "$KILL" "$KILL2" >>"$L" ) &
run env
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 4 kills=1 [await x1]  tick after=yes'* ]] && echo true)" "kill + tick alive: 4 FAILs as kills=1, tick after=yes"
check "$([[ "$OUT" == *'3 passed, 1 failed'* ]] && echo true)" "kill + tick alive: checks 1-3 unaffected"
check "$([[ "$OUT" == *'sessions: 2 [agenthop, work]'* && "$OUT" == *'window clients: 1'* ]] && echo true)" "diagnostics print tern session and window-client counts"

# D2. a kill and the tick is frozen afterwards: tick after=no.
: >"$L"; frozen
( sleep 0.3; printf '%s\n%s\n%s\n' "$KILL" "$KILL2" "${KILL/await/drain}" >>"$L" ) &
run env
check "$([[ "$OUT" == *'FAIL - 4 kills=2 [await x1, drain x1]  tick after=no'* ]] && echo true)" "kill + tick frozen: kills=2 per hook, tick after=no"

# D3. no kill: column form on PASS too.
: >"$L"; start_ticker
run env
stop_ticker
check "$([[ "$OUT" == *'PASS - 4 kills=0  tick after=n/a'* ]] && echo true)" "no kill: PASS - 4 kills=0  tick after=n/a"

# E. an OLD budget line (before start) is not counted.
echo "$KILL" >"$L"
start_ticker
run env
stop_ticker
check "$([ $RC -eq 0 ] && echo true)" "old budget line before start: not counted, exit 0"

# F. prerequisite missing: plugin not loaded => exit 2, no checks run.
printf '#!/usr/bin/env bash\necho %s\n' "'{\"plugins\":[],\"problems\":[]}'" >"$TMP/tern-empty"; chmod +x "$TMP/tern-empty"
OUT="$(TERN_BIN="$TMP/tern-empty" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 bash "$SMOKE" 2>&1)"; RC=$?
check "$([ $RC -eq 2 ] && [[ "$OUT" != *'PASS - '* && "$OUT" != *'FAIL - '* ]] && echo true)" "plugin not loaded: exit 2, no checks run"

echo ""
echo "bridge-smoke gate: $t passed, $f failed"
[ "$f" -eq 0 ]
