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
# Deterministic state changes: the smoke (SMOKE_SNAP_MARK hook) creates $MARK.<n> right after its n-th agents.json read;
# state k is written only after read k. Never a timer: a timer drifts against the smoke's own reads under load.
after_first(){ # $@ = state k for k = 1..n: written right after the smoke's read k ($MARK.k), never on a timer
  local MARK="$TMP/mark.$RANDOM"; rm -f "$MARK".*; export SMOKE_SNAP_MARK="$MARK"
  ( k=0; for j in "$@"; do k=$((k + 1))
      for _ in $(seq 1 200); do [ -e "$MARK.$k" ] && break; sleep 0.02; done
      [ -e "$MARK.$k" ] || exit 0          # the smoke stopped reading earlier: later states are never written
      echo "$j" >"$C/agents.json"
    done ) &
  TICKER=$!
}
done_identity(){ stop_ticker; unset SMOKE_SNAP_MARK; }

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
check "$([[ "$OUT" == *'FAIL - 1 tick: did not advance in 1s (5 -> 5, vm ccc; sweep flag SWARM_TERN_BRIDGE:'* && "$OUT" == *'vm: ccc, tick_ms=61 tick_ms_max=88'* ]] && echo true)" "r4 frozen: FAIL with vm, diagnostics show tick_ms"

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
after_first '{"tick":1,"vm":"new","agents":[]}'
run env; done_identity
check "$([ $RC -eq 1 ] && [[ "$OUT" =~ 'FAIL - 1 tick: reloaded (vm old -> new), re-baselined at '[0-9]+'; did not advance' ]] && echo true)" "reload once then frozen (reload_once_frozen) => FAIL"
: >"$L"; echo '{"tick":1,"vm":"v1","agents":[]}' >"$C/agents.json"; after_first '{"tick":1,"vm":"v2","agents":[]}' '{"tick":1,"vm":"v3","agents":[]}'
run env; done_identity
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'vm changed AGAIN'* ]] && echo true)" "vm keeps changing (reload loop) => FAIL"
# r8 bridge: timer=stopped-late with a slow sweep is reported as by-design, not LOW
: >"$L"; ( i=1; while :; do echo "{\"tick\":$i,\"vm\":\"z\",\"timer\":\"stopped-late\",\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 1.5; done ) & TICKER=$!
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=4 bash "$SMOKE" 2>&1)"; RC=$?
stop_ticker
check "$([[ "$OUT" == *'PASS - 1 tick'*'timer=stopped-late (accelerator stopped, by design)'* && "$OUT" != *'LOW:'* ]] && echo true)" "timer=stopped-late + sweep-only tick => PASS, reported as by design"

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

# sweep flag in check 1's FAIL line: off vs on vs unreadable recipe
: >"$L"; frozen
echo '{"env":{"SWARM_COORDINATOR":"x"}}' >"$TMP/recipe-off.json"; echo '{"env":{"SWARM_TERN_BRIDGE":"1"}}' >"$TMP/recipe-on.json"
run env SWARM_DISPATCHER_RECIPE="$TMP/recipe-off.json"; o_off="$OUT"
run env SWARM_DISPATCHER_RECIPE="$TMP/recipe-on.json"; o_on="$OUT"
run env SWARM_DISPATCHER_RECIPE="$TMP/no-such-recipe.json"; o_none="$OUT"
check "$([[ "$o_off" == *'sweep flag SWARM_TERN_BRIDGE: off (unset): no outside mirror sweep'* && "$o_on" == *'sweep flag SWARM_TERN_BRIDGE: on (1)'* && "$o_none" == *'sweep flag SWARM_TERN_BRIDGE: unknown'* ]] && echo true)" "check 1 FAIL names the sweep flag: off / on / unknown"

# r9 bridge: timer=overdue with a sweep-paced tick => PASS as by design (not "timer chain alive", not LOW)
: >"$L"; ( i=1; while :; do echo "{\"tick\":$i,\"vm\":\"o\",\"timer\":\"overdue\",\"agents\":[]}" >"$C/agents.json"; i=$((i+1)); sleep 1.5; done ) & TICKER=$!
OUT="$(TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=4 bash "$SMOKE" 2>&1)"
stop_ticker
check "$([[ "$OUT" == *'PASS - 1 tick'*'timer=overdue (accelerator stopped, by design)'* && "$OUT" != *'timer chain alive'* ]] && echo true)" "timer=overdue + sweep-paced tick => PASS, labelled accelerator stopped"
# timer=overdue and frozen => still FAIL, line names the timer state
: >"$L"; echo '{"tick":9,"vm":"o","timer":"overdue","agents":[]}' >"$C/agents.json"
run env
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'did not advance'*'timer=overdue; sweep flag'* ]] && echo true)" "timer=overdue + frozen => FAIL naming timer state and sweep flag"

# ---- r9: six findings (main review a05d379 + second voice 024ba34), one full-chain counterexample each ------------
now_iso(){ python3 -c 'import datetime; print(datetime.datetime.now().astimezone().isoformat(timespec="milliseconds"))'; }

# 1 (BSM-TRUNCATE-REGROW / BSM-SV-P2-3): same inode, truncated then regrown LONGER than before; new first line = kill
python3 -c 'print("old line " * 50)' >"$L"   # ~450 bytes
start_ticker
( sleep 0.4; { printf '%s 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin="agenthop-agents-bridge" hook="timer"\n' "$(now_iso)"; python3 -c 'print("new line " * 150)'; } 1<>"$L" ) &
run env
stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'mirror kills=1 [timer x1]'* ]] && echo true)" "r9-1 same inode truncated + regrown past old size: first-line kill counted"
# 1b helper-level race: the file is renamed in between stat and open in the OLD helper; the new helper reads by fd only
python3 -c 'print("old " * 150)' >"$L"; M="$(python3 "$HERE/smoke-logwindow.py" mark "$L")"
{ printf '2026-10-15T11:00:01+08:00 WARN plugin hook exceeded its budget; disabled until reload plugin="agenthop-agents-bridge" hook="timer"\n'; python3 -c 'print("new " * 300)'; } >"$L.new"; mv -f "$L.new" "$L"
check "$(python3 "$HERE/smoke-logwindow.py" offset "$L" "$M" 2>/dev/null | grep -q 'exceeded its budget' && echo true)" "r9-1b log replaced by rename before open: helper reads the new file whole"

# 2 (BSM-TIME-UNKNOWN / BSM-R8-P2-1): our kill line with a broken timestamp => undecidable => FAIL, not skipped
for bad in '2026-10-15T11:xx:01+08:00' '2026-10-15T10:00:00+oops' 'BROKEN-TIME'; do
  : >"$L"; printf '%s 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin="agenthop-agents-bridge" hook="timer"\n' "$bad" >"$L"
  start_ticker; run env SINCE=2026-10-15T11:00:00+08:00; stop_ticker
  check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 4 kill window could not be read'*'unparseable timestamp'* ]] && echo true)" "r9-2 kill line with timestamp '$bad' => FAIL (undecidable), not 0 kills"
done
# control: a stack-trace continuation (no timestamp, not a kill) and ANOTHER plugin's broken kill line are ignored
printf 'stack traceback:\n\t[C]: in ?\nBROKEN 1 WARN x: plugin hook exceeded its budget; disabled until reload plugin="other-plugin" hook="timer"\n' >"$L"
start_ticker; run env SINCE=2026-10-15T11:00:00+08:00; stop_ticker
check "$([ $RC -eq 0 ] && [[ "$OUT" == *'PASS - 4 mirror kills=0'* ]] && echo true)" "r9-2 control: continuation lines and another plugin's broken line ignored"

# 3 (BSM-TEMP-OWN): a symlink planted at the OLD fixed path /tmp/smoke-logwin.<pid> is never written or removed.
#    Exact ownership in the gate itself (BSM-GATE-TEMP-OWN): the smoke runs under `exec` in a child whose pid we know,
#    the link is created with `ln -s` (no -f: an existing entry at that path is never replaced — the case is skipped),
#    only that exact path is checked, and only that exact path is removed, and only if it is still OUR symlink to OUR
#    victim. No glob over /tmp, no broad rm.
: >"$L"; VICTIM="$TMP/victim"; echo victim-bytes >"$VICTIM"; start_ticker
GO="$TMP/go"; mkfifo "$GO"
TERN_BIN="$FAKE" BRIDGE_CTRL_DIR="$C" TERN_LOG="$L" TICK_WAIT=1 bash -c 'read -r _ <"$1"; exec bash "$2"' _ "$GO" "$SMOKE" >"$TMP/r9-3.out" 2>&1 &
CHILD=$!; PLANTED="/tmp/smoke-logwin.$CHILD"; planted_ok=0
if ln -s "$VICTIM" "$PLANTED" 2>/dev/null; then planted_ok=1; fi
echo go >"$GO"; wait "$CHILD"; stop_ticker; rm -f "$GO"
if [ "$planted_ok" -eq 1 ]; then
  check "$([ "$(cat "$VICTIM")" = victim-bytes ] && echo true)" "r9-3 symlink planted at /tmp/smoke-logwin.<pid>: victim bytes untouched"
  check "$([ -L "$PLANTED" ] && [ "$(readlink "$PLANTED")" = "$VICTIM" ] && echo true)" "r9-3 the planted symlink itself is not removed"
  # remove only the exact link we created, and only if it is still ours
  [ -L "$PLANTED" ] && [ "$(readlink "$PLANTED")" = "$VICTIM" ] && rm -f -- "$PLANTED"
else
  echo "skip - r9-3 /tmp/smoke-logwin.$CHILD already exists (not ours): symlink case not run, nothing touched"
fi
# mktemp failure, with a TMPDIR that is our own private (non-existent) path
: >"$L"; start_ticker; run env TMPDIR="$TMP/no-such-dir"; stop_ticker
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'cannot create a private temp file'* ]] && echo true)" "r9-3 mktemp fails => check 4 FAILs, says why"
# leftovers: run the smoke with a private TMPDIR and check that exact dir is empty afterwards (no /tmp glob)
PRIV="$TMP/privtmp"; mkdir -p "$PRIV"; : >"$L"; start_ticker; run env TMPDIR="$PRIV"; stop_ticker
check "$([ -z "$(ls -A "$PRIV")" ] && echo true)" "r9-3 no private temp file left behind (checked in our own TMPDIR)"

# 4 (BSM-R8-P2-2 / BSM-VM-APPEARS): identity transitions. Deterministic: the smoke touches $MARK right after its FIRST
#    snapshot (SMOKE_SNAP_MARK hook), and the fixture writes the next state only after that. r11: every read is
#    numbered, and state k is written only after read k (r10 waited for the first read only, then wrote on a 1 s timer
#    that drifted against the smoke's own 1 s reads). r9's version slept 0.3 s
#    instead; if the smoke's first read came later than that (slow prerequisite under load), it saw the SECOND state as
#    the first and reported "did not advance (100 -> 100)" instead of "identity unknown" — the 65/66 the main review saw.
# known vm, then a snapshot without vm => identity unknown
: >"$L"; echo '{"tick":1,"vm":"old","agents":[]}' >"$C/agents.json"; after_first '{"tick":100,"agents":[]}'
run env; done_identity
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'FAIL - 1 tick: identity unknown — vm old was seen, then the next snapshot had no vm field'* ]] && echo true)" "r10-4 vm seen then vanished => FAIL identity unknown (deterministic)"
# known vm, then unreadable => identity unknown
: >"$L"; echo '{"tick":1,"vm":"old","agents":[]}' >"$C/agents.json"; after_first '{not json'
run env; done_identity
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'identity unknown'*'no readable file'* ]] && echo true)" "r10-4 vm seen then agents.json unreadable => FAIL identity unknown"
# legacy -> vm appears once, then frozen => FAIL (was 4 PASS in r9: BSM-VM-APPEARS / legacy_to_known_frozen)
: >"$L"; echo '{"tick":1,"agents":[]}' >"$C/agents.json"; after_first '{"tick":2,"vm":"new","agents":[]}'
run env; done_identity
check "$([ $RC -eq 1 ] && [[ "$OUT" =~ 'FAIL - 1 tick: vm new appeared (no vm before), re-baselined at '[0-9]+'; did not advance' ]] && echo true)" "r10-4 legacy then vm appears then frozen => FAIL"
# legacy -> vm appears, then THAT vm advances => PASS, labelled as appeared + re-baselined
: >"$L"; echo '{"tick":1,"agents":[]}' >"$C/agents.json"; after_first '{"tick":2,"vm":"new","agents":[]}' '{"tick":3,"vm":"new","agents":[]}' '{"tick":4,"vm":"new","agents":[]}'
run env; done_identity
check "$([ $RC -eq 0 ] && [[ "$OUT" =~ 'PASS - 1 tick vm new appeared (no vm before), re-baselined at '([0-9]+)'; advances ('([0-9]+)' -> '([0-9]+) ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ] && [ "${BASH_REMATCH[3]}" -gt "${BASH_REMATCH[2]}" ] && [[ "$OUT" == *'vm new)'* ]] && echo true)" "r10-4 legacy then vm appears and advances => PASS: same vm moved past its own baseline"
# legacy -> vm appears, then vm vanishes again => identity unknown
: >"$L"; echo '{"tick":1,"agents":[]}' >"$C/agents.json"; after_first '{"tick":2,"vm":"new","agents":[]}' '{"tick":9,"agents":[]}'
run env; done_identity
check "$([ $RC -eq 1 ] && [[ "$OUT" == *'identity unknown — vm new was seen after the re-baseline'* ]] && echo true)" "r10-4 legacy then vm then no vm => FAIL identity unknown"
# known vm -> new vm (reload) -> frozen => FAIL (kept from r8)
: >"$L"; echo '{"tick":40,"vm":"old","agents":[]}' >"$C/agents.json"; after_first '{"tick":1,"vm":"new","agents":[]}'
run env; done_identity
check "$([ $RC -eq 1 ] && [[ "$OUT" =~ 'reloaded (vm old -> new), re-baselined at '[0-9]+'; did not advance' ]] && echo true)" "r10-4 known vm then reload then frozen => FAIL"
# control: a legacy bridge that never shows a vm is compared by tick and labelled
: >"$L"; start_ticker; run env; stop_ticker
check "$([ $RC -eq 0 ] && [[ "$OUT" == *'legacy bridge (no vm field): tick-only comparison'* ]] && echo true)" "r10-4 control: never-vm legacy bridge => tick-only PASS, labelled legacy"

# 5 (BSM-DIAG-P3-1): sweep flag truth table = #1033 reader /^(1|true|yes|on)$/i
: >"$L"; frozen; ok=1
for v in 1 true TRUE yes Yes on ON; do
  printf '{"env":{"SWARM_TERN_BRIDGE":"%s"}}' "$v" >"$TMP/recipe.json"
  run env SWARM_DISPATCHER_RECIPE="$TMP/recipe.json"; [[ "$OUT" == *"sweep flag SWARM_TERN_BRIDGE: on ($v)"* ]] || ok=0
done
for v in 0 false off no "" maybe; do
  printf '{"env":{"SWARM_TERN_BRIDGE":"%s"}}' "$v" >"$TMP/recipe.json"
  run env SWARM_DISPATCHER_RECIPE="$TMP/recipe.json"; [[ "$OUT" == *"sweep flag SWARM_TERN_BRIDGE: off ("* ]] || ok=0
done
check "$([ $ok -eq 1 ] && echo true)" "r10-5 sweep flag: 1/true/TRUE/yes/Yes/on/ON => on; 0/false/off/no/empty/other => off"

echo ""
echo "bridge-smoke gate: $t passed, $f failed"
[ "$f" -eq 0 ]
