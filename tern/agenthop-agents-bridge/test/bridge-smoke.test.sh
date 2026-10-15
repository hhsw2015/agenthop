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
    for q in \$(ls -1 "$C"/requests/*.json 2>/dev/null | head -1); do
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
check "$([[ "$OUT" == *'PASS - 2 list'* && "$OUT" == *'PASS - 3 eval round-trip ok (return #cx.session:panes() =>'* ]] && echo true)" "mirror dead: checks 2 and 3 still run and PASS"
check "$([[ "$OUT" == *'PASS - 4 mirror kills=0'* ]] && echo true)" "mirror dead: check 4 still runs"
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
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 4 mirror kills=1 [await x1]  command kills=0  (since start)  tick after=yes'* ]] && echo true)" "kill + tick alive: 4 FAILs as kills=1, tick after=yes"
check "$([[ "$OUT" == *'3 passed, 1 failed'* ]] && echo true)" "kill + tick alive: checks 1-3 unaffected"
check "$([[ "$OUT" == *'sessions: 2 [agenthop, work]'* && "$OUT" == *'window clients: 1'* ]] && echo true)" "diagnostics print tern session and window-client counts"

# D2. a kill and the tick is frozen afterwards: tick after=no.
: >"$L"; frozen
( sleep 0.3; printf '%s\n%s\n%s\n' "$KILL" "$KILL2" "${KILL/await/drain}" >>"$L" ) &
run env
check "$([[ "$OUT" == *'FAIL - 4 mirror kills=1 [await x1]  command kills=1 [drain x1]  (since start)  tick after=no'* ]] && echo true)" "kill + tick frozen: one mirror + one command kill, tick after=no"

# D3. no kill: column form on PASS too.
: >"$L"; start_ticker
run env
stop_ticker
check "$([[ "$OUT" == *'PASS - 4 mirror kills=0  command kills=0  (since start)  tick after=n/a'* ]] && echo true)" "no kill: PASS - 4 kills=0  tick after=n/a"

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
check "$([[ "$OUT" == *'PASS - 1 tick reloaded (vm aaa -> bbb), re-baselined at'*'advances ('*'vm bbb)'* ]] && echo true)" "r4 reload: re-baselined on the new vm, which then advances => PASS"

# H. r4 file, same vm, tick frozen: FAIL and the diagnostics show vm + tick_ms.
: >"$L"; echo '{"tick":5,"vm":"ccc","tick_ms":61,"tick_ms_max":88,"agents":[]}' >"$C/agents.json"
run env
check "$([[ "$OUT" == *'FAIL - 1 tick: did not advance in 1s (5 -> 5, vm ccc)'* && "$OUT" == *'vm: ccc, tick_ms=61 tick_ms_max=88'* ]] && echo true)" "r4 frozen: FAIL with vm, diagnostics show tick_ms"

# I. r4 file, same vm, advancing: normal PASS mentions the vm.
: >"$L"; start_ticker_vm ddd
run env
stop_ticker
check "$([[ "$OUT" == *'PASS - 1 tick advances ('*'timer chain alive; vm ddd)'* ]] && echo true)" "r4 healthy: PASS mentions rate + vm"

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
check "$([[ "$OUT" == *'FAIL - 4 mirror kills=1 [command mirror x1]  command kills=0  (since 2026-10-15T11:00:00)'* ]] && echo true)" "SINCE: kill inside the window counted, kill before it not"

# L. --soak: both runs pass and no kill in the gap => PASS; a kill written DURING the gap => run 2 FAILs => soak FAIL.
: >"$L"; start_ticker
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 SOAK_GAP=2 bash "$SMOKE" --soak 2>&1)"; RC=$?
check "$([ $RC -eq 0 ] && [[ "$OUT" == *'soak: PASS'* && "$(grep -c 'bridge-smoke: PASS' <<<"$OUT")" -eq 2 ]] && echo true)" "--soak: two clean runs => soak PASS"
: >"$L"
( sleep 6; echo "$(date '+%Y-%m-%dT%H:%M:%S').000+08:00 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin=\"agenthop-agents-bridge\" hook=\"timer\"" >>"$L" ) &
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 SOAK_GAP=4 bash "$SMOKE" --soak 2>&1)"; RC=$?
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'soak: FAIL'* && "$OUT" == *'mirror kills=1 [timer x1]  command kills=0  (since'* ]] && echo true)" "--soak: a kill in the gap between runs => soak FAIL"

# M. hook names with spaces are kept whole, per hook.
: >"$L"; start_ticker
( sleep 0.4; printf '%s\n' "${KILL/await/command drain}" "${KILL/await/command drain}" "${KILL/await/timer}" >>"$L" ) &
run env
stop_ticker
check "$([[ "$OUT" == *'mirror kills=1 [timer x1]  command kills=2 [command drain x2]'* ]] && echo true)" "mirror and command kills reported in separate columns, hook names with spaces kept whole"

# N. tick only moved by a slow outside sweep (1 step in 1s, 750 ms timer expects ~1): with TICK_WAIT=4, 1 step => LOW.
: >"$L"; ( i=1; while :; do echo "{\"tick\":$i,\"vm\":\"sss\",\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 3; done ) & TICKER=$!
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=4 bash "$SMOKE" 2>&1)"
stop_ticker
check "$([[ "$OUT" == *'LOW: timer chain likely dead'* ]] && echo true)" "slow sweep-only tick: rate reported LOW (timer chain dead)"

# O. r7 one-request-per-drain: someone else's request queued AHEAD of ours. Ours still gets answered (drain
#    re-triggered), and the other request is not deleted by the smoke (the fake bridge answers it, as Tern would).
: >"$L"; rm -f "$C"/requests/*.json "$C"/results/*.json
echo '{"op":"list"}' >"$C/requests/a-stale-other.json"
start_ticker
run env
stop_ticker
check "$([ $RC -eq 0 ] && [[ "$OUT" == *'PASS - 2 list'* ]] && echo true)" "r7: a request queued ahead of ours does not cause a false FAIL"
check "$([ -f "$C/results/a-stale-other.json" ] && echo true)" "r7: the other request was answered by the bridge, not deleted by the smoke"
rm -f "$C"/results/*.json

# ---- r8: second-voice counterexamples (happycapy smoke-audit), ported -----------------------------------------
kill_at(){ printf '%s 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin="agenthop-agents-bridge" hook="%s"\n' "$1" "${2:-timer}"; }
since_case(){ # $1 name, $2 SINCE, $3 log timestamp, $4 expected exit
  : >"$L"; kill_at "$3" >>"$L"; start_ticker
  OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 SINCE="$2" bash "$SMOKE" 2>&1)"; RC=$?
  stop_ticker
  check "$([ $RC -eq "$4" ] && echo true)" "SINCE $1 (SINCE=$2, kill=$3) => exit $4"
}
# BSM-SV-P2-1: fractional seconds and zones are compared as instants
since_case fraction_later_same_second   2026-10-15T11:00:00.100+08:00 2026-10-15T11:00:00.900+08:00 1
since_case fraction_before_same_second  2026-10-15T11:00:00.900+08:00 2026-10-15T11:00:00.100+08:00 0
since_case zone_suffix_same_second      2026-10-15T11:00:00+08:00     2026-10-15T11:00:00.900+08:00 1
since_case zone_cross_day_later         2026-10-15T03:00:00+08:00     2026-10-14T20:00:00.000Z      1
since_case zone_earlier_but_lex_later   2026-10-15T03:00:00Z          2026-10-15T10:00:00.000+08:00 0
since_case next_second_full_iso         2026-10-15T11:00:00.100+08:00 2026-10-15T11:00:01.000+08:00 1
since_case same_timezone_cross_midnight 2026-10-14T23:59:59+08:00     2026-10-15T00:00:00.001+08:00 1
since_case before_midnight_excluded     2026-10-15T00:00:00+08:00     2026-10-14T23:59:59.999+08:00 0
# a SINCE that cannot be parsed is a FAIL with a reason, not an empty window
: >"$L"; start_ticker
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 SINCE="yesterday-ish" bash "$SMOKE" 2>&1)"; RC=$?
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 4 kill window could not be read'*'SINCE not an ISO time'* ]] && echo true)" "SINCE unparseable => check 4 FAILs with the reason"

# BSM-SV-P2-2: a reload followed by a freeze is NOT alive; a vm that keeps changing is not alive either
: >"$L"; echo '{"tick":40,"vm":"old","agents":[]}' >"$C/agents.json"
( sleep 0.3; echo '{"tick":1,"vm":"new","agents":[]}' >"$C/agents.json" ) & TICKER=$!
run env
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 1 tick: reloaded (vm old -> new), re-baselined at 1; did not advance'* ]] && echo true)" "reload once then frozen (reload_once_frozen) => FAIL"
: >"$L"; ( i=1; while :; do echo "{\"tick\":1,\"vm\":\"v$i\",\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 0.4; done ) & TICKER=$!
run env
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'vm changed AGAIN'* ]] && echo true)" "vm keeps changing (reload loop) => FAIL"
# r8 bridge: timer=stopped-late with a slow sweep is reported as by-design, not LOW
: >"$L"; ( i=1; while :; do echo "{\"tick\":$i,\"vm\":\"z\",\"timer\":\"stopped-late\",\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 1.5; done ) & TICKER=$!
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=4 bash "$SMOKE" 2>&1)"; RC=$?
stop_ticker
check "$([[ "$OUT" == *'PASS - 1 tick'*'timer=stopped-late (throttled, by design)'* && "$OUT" != *'LOW:'* ]] && echo true)" "timer=stopped-late + sweep-only tick => PASS, reported as by design"

# BSM-SV-P2-3: rotation and unreadable logs
# rotation_regrown: the log is replaced during the run by a LONGER file whose first line is a kill => counted
: >"$L"; printf 'old 1\nold 2\n' >"$L"
cat >"$TMP/tern-rotate" <<EOF2
#!/usr/bin/env bash
if [ "\$1 \$2" = "plugin list" ] && [ ! -e "$TMP/rotated" ]; then
  touch "$TMP/rotated"; mv "$L" "$L.old"
  { printf '%s 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin="agenthop-agents-bridge" hook="timer"\n' "\$(date '+%Y-%m-%dT%H:%M:%S').000+08:00"; echo new 2; echo new 3; } >"$L"
fi
exec "$FAKE" "\$@"
EOF2
chmod +x "$TMP/tern-rotate"; rm -f "$TMP/rotated"; start_ticker
OUT="$(TERN_BIN="$TMP/tern-rotate" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 bash "$SMOKE" 2>&1)"; RC=$?
stop_ticker; rm -f "$L.old"
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'mirror kills=1 [timer x1]'* ]] && echo true)" "rotation_regrown: log replaced by a longer file, its first-line kill is counted"
# truncated in place, then a kill appended => counted
printf 'a\nb\nc\nd\n' >"$L"; start_ticker
( sleep 0.3; : >"$L"; kill_at "$(date '+%Y-%m-%dT%H:%M:%S').000+08:00" >>"$L" ) &
run env
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'mirror kills=1'* ]] && echo true)" "log truncated in place then a kill appended => counted"
# unreadable log (EACCES), offset path and SINCE path => FAIL, never 0 kills
if [ "$(id -u)" -ne 0 ]; then
  kill_at "2026-10-15T11:00:01.000+08:00" >"$L"; chmod 000 "$L"; start_ticker
  run env
  r1=$RC; o1="$OUT"
  run env SINCE=2026-10-15T11:00:00+08:00
  stop_ticker; chmod 600 "$L"
  check "$([ $r1 -eq 1 ] && [[ "$o1" == *'FAIL - 4 kill window could not be read'* && "$o1" != *'kills=0'* ]] && echo true)" "EACCES log, offset path => FAIL, not 0 kills"
  check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 4 kill window could not be read'*'cannot read'* ]] && echo true)" "EACCES log, SINCE path => FAIL, not 0 kills"
fi
# command-only kill is a FAIL (a gate that ignored the command column would pass this)
: >"$L"; start_ticker
( sleep 0.3; kill_at "$(date '+%Y-%m-%dT%H:%M:%S').000+08:00" "command drain" >>"$L" ) &
run env
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'mirror kills=0  command kills=1 [command drain x1]'* ]] && echo true)" "command-only kill (command_kill_only_control) => FAIL"

echo ""
echo "bridge-smoke gate: $t passed, $f failed"
[ "$f" -eq 0 ]
