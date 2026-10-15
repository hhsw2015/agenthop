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
# r4-style file with a vm id; reload() swaps vm and restarts tick from 1 (a reload, not a stall)
start_ticker_vm(){ ( i=1; while :; do echo "{\"tick\":$i,\"vm\":\"$1\",\"tick_ms\":3,\"tick_ms_max\":9,\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 0.2; done ) & TICKER=$!; }
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
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 4 kills=1 [await x1] (since start)  tick after=yes'* ]] && echo true)" "kill + tick alive: 4 FAILs as kills=1, tick after=yes"
check "$([[ "$OUT" == *'3 passed, 1 failed'* ]] && echo true)" "kill + tick alive: checks 1-3 unaffected"
check "$([[ "$OUT" == *'sessions: 2 [agenthop, work]'* && "$OUT" == *'window clients: 1'* ]] && echo true)" "diagnostics print tern session and window-client counts"

# D2. a kill and the tick is frozen afterwards: tick after=no.
: >"$L"; frozen
( sleep 0.3; printf '%s\n%s\n%s\n' "$KILL" "$KILL2" "${KILL/await/drain}" >>"$L" ) &
run env
check "$([[ "$OUT" == *'FAIL - 4 kills=2 [await x1, drain x1] (since start)  tick after=no'* ]] && echo true)" "kill + tick frozen: kills=2 per hook, tick after=no"

# D3. no kill: column form on PASS too.
: >"$L"; start_ticker
run env
stop_ticker
check "$([[ "$OUT" == *'PASS - 4 kills=0 (since start)  tick after=n/a'* ]] && echo true)" "no kill: PASS - 4 kills=0  tick after=n/a"

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

# G. r4 file: a reload during the wait (vm changes, tick restarts lower) is not a stall.
: >"$L"; echo '{"tick":40,"vm":"aaa","agents":[]}' >"$C/agents.json"
( sleep 0.4; i=1; while :; do echo "{\"tick\":$i,\"vm\":\"bbb\",\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 0.2; done ) & TICKER=$!
run env
stop_ticker
check "$([[ "$OUT" == *'PASS - 1 tick: plugin reloaded during the wait (vm aaa -> bbb'* ]] && echo true)" "r4 reload: vm change counted as alive, reported"

# H. r4 file, same vm, tick frozen: FAIL and the diagnostics show vm + tick_ms.
: >"$L"; echo '{"tick":5,"vm":"ccc","tick_ms":61,"tick_ms_max":88,"agents":[]}' >"$C/agents.json"
run env
check "$([[ "$OUT" == *'FAIL - 1 tick: did not advance in 1s (5 -> 5, vm ccc)'* && "$OUT" == *'vm: ccc, tick_ms=61 tick_ms_max=88'* ]] && echo true)" "r4 frozen: FAIL with vm, diagnostics show tick_ms"

# I. r4 file, same vm, advancing: normal PASS mentions the vm.
: >"$L"; start_ticker_vm ddd
run env
stop_ticker
check "$([[ "$OUT" == *'PASS - 1 tick advances ('*'vm ddd)'* ]] && echo true)" "r4 healthy: PASS mentions vm"

# J. r5 breadcrumb: killed mid-segment => diagnostics name the segment; completed => per-segment ms; absent => said so.
: >"$L"; echo '{"tick":5,"vm":"eee","agents":[]}' >"$C/agents.json"
echo '{"vm":"eee","tick":6,"phase":"encode","at_ms":31.20,"list_ms":28.10,"slim_ms":30.90}' >"$C/mirror-phase.json"
run env
check "$([[ "$OUT" == *'STOPPED IN SEGMENT: encode (vm eee, tick 6, 31.20ms into the tick)'* ]] && echo true)" "r5 breadcrumb: killed segment named"
echo '{"vm":"eee","tick":6,"phase":"done","at_ms":40.00,"list_ms":28.10,"slim_ms":30.90,"encode_ms":36.00,"write_ms":40.00}' >"$C/mirror-phase.json"
run env
check "$([[ "$OUT" == *'last tick completed: list 28.10ms, slim 30.90ms, encode 36.00ms, write 40.00ms'* ]] && echo true)" "r5 breadcrumb: completed tick shows per-segment ms"
rm -f "$C/mirror-phase.json"
run env
check "$([[ "$OUT" == *'(absent: bridge older than r5, or r6+ with the phase debug switch off'* ]] && echo true)" "r5 breadcrumb absent: reported, not an error"

# K. SINCE: a kill BEFORE this run but inside the soak window is counted; one before SINCE is not.
: >"$L"
echo "2026-10-15T09:00:00.000+08:00 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin=\"agenthop-agents-bridge\" hook=\"timer\"" >>"$L"
echo "2026-10-15T11:30:00.000+08:00 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin=\"agenthop-agents-bridge\" hook=\"command mirror\"" >>"$L"
start_ticker
run env SINCE=2026-10-15T11:00:00
stop_ticker
check "$([[ "$OUT" == *'FAIL - 4 kills=1 [command x1] (since 2026-10-15T11:00:00)'* ]] && echo true)" "SINCE: kill inside the window counted, kill before it not"

# L. --soak: both runs pass and no kill in the gap => PASS; a kill written DURING the gap => run 2 FAILs => soak FAIL.
: >"$L"; start_ticker
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 SOAK_GAP=2 bash "$SMOKE" --soak 2>&1)"; RC=$?
check "$([ $RC -eq 0 ] && [[ "$OUT" == *'soak: PASS'* && "$(grep -c 'bridge-smoke: PASS' <<<"$OUT")" -eq 2 ]] && echo true)" "--soak: two clean runs => soak PASS"
: >"$L"
( sleep 6; echo "$(date '+%Y-%m-%dT%H:%M:%S').000+08:00 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin=\"agenthop-agents-bridge\" hook=\"timer\"" >>"$L" ) &
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 SOAK_GAP=4 bash "$SMOKE" --soak 2>&1)"; RC=$?
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'soak: FAIL'* && "$OUT" == *'kills=1 [timer x1] (since'* ]] && echo true)" "--soak: a kill in the gap between runs => soak FAIL"

echo ""
echo "bridge-smoke gate: $t passed, $f failed"
[ "$f" -eq 0 ]
