# TUI seat switch runbook (Phase 3: one seat from `tern acp` to a bare TUI block)

Brief: `docs/swarm/tui-migration-brief.md` §4 Phase 3. Recorded run: Reserve b90ccae9, 2026-10-16 05:18Z
(`~/.agenthop/swarm/seat-switch-reserve-1792127908.log`, PROGRESS #1129-#1130). Measurements: `docs/research/tui-seat-spike.md`.

The coordinator runs this, one seat at a time, never two at once. A seat keeps its sid: the new block **resumes** the same session,
so its durable inbox, transcript and bus handle stay the same. Every step has a command, the output to expect, and what to do when
the output is different. Stop at the first step that does not match. Do not "fix forward".

Variables for one seat (from the roster row and `tern ls --json`):

```bash
SID=<full session id>          # roster "sid"
CWD=<seat cwd>                 # roster "cwd"
MODEL='<model>'                # roster "model" (claude only)
OLD=<old ACP block id>         # tern ls --json: the block whose command is "tern acp … <SID>" (or the seat's tab)
P=~/.agenthop/presence
LOG=~/.agenthop/swarm/seat-switch-<role>-$(date +%s).log
```

## 1. Preflight (nothing changes yet)

```bash
tern process $OLD --json | python3 -c 'import json,sys;c=json.load(sys.stdin)["child"];print(c["pid"], c["argv"])' | tee -a $LOG
```

Expect: one pid, and argv `[…/tern, acp, claude|codex, …]`. The SID must be proven by one of:

- it is in that argv (`--resume $SID`);
- for a `tern acp claude` block started without `--resume`: its agent child process carries it
  (`for k in $(pgrep -P $OLDPID); do pgrep -P $k | xargs -I{} ps -o command= -p {}; done | grep -o "session-id[= ]$SID"`;
  checked 2026-10-16 for Infra Dev, Platform Dev and Model Gateway).

If the SID is not proven, stop: closing the wrong block kills another seat.

```bash
OLDPID=<pid printed above>
tail -1 <transcript> | python3 -c 'import json,sys;o=json.loads(sys.stdin.read());print(o.get("type"), o.get("timestamp"))'
```

Expect: the seat is idle (last entry is not a tool call in progress). If it is working, wait for its turn to end. A seat that is
mid-task loses the turn when its block closes. Write the rollback line now (section 5) into `$LOG` and into PROGRESS.

## 2. Close the old block, and wait for it to be fully gone

Same-sid resume needs **no overlap**: two processes on one sid write one transcript.

```bash
tern close $OLD | tee -a $LOG
for i in $(seq 1 20); do kill -0 $OLDPID 2>/dev/null || break; sleep 0.5; done
kill -0 $OLDPID 2>/dev/null && echo "OLD STILL ALIVE" || echo "old pid gone after $((i/2))s"
```

Expect: `old pid gone after <10s`. If it is still alive after 10 s, stop and decide by hand (do not SIGKILL by reflex).

**Presence race fix (claude seats).** The old session's SessionEnd hook runs
`kill $(cat presence/$SID.pid); rm -f presence/$SID.pid`, keyed by sid. If the new block starts before that hook finishes, the
hook deletes the file the new session just wrote, and the presence helper writes the file only once (`presence.ts:54`), so it stays
missing (#1130). Wait for the old file to disappear, then 3 s more:

```bash
for i in $(seq 1 20); do [ -e $P/$SID.pid ] || break; sleep 0.5; done
[ -e $P/$SID.pid ] && echo "OLD .pid STILL THERE" || { sleep 3; echo "old .pid gone, +3s"; }
```

Expect: `old .pid gone, +3s`. If the file is still there after 10 s, the hook did not run (or the old session was killed). Remove
it only if `kill -0 $(cat $P/$SID.pid)` says that pid is dead; otherwise stop.

## 3. Start the TUI block

claude seat:

```bash
tern new tab agenthop --cwd $CWD --keep-open --json -- \
  claude --permission-mode bypassPermissions --model "$MODEL" --resume $SID | tee -a $LOG
```

codex seat (always with the session id; without it codex starts a new thread):

```bash
tern new tab agenthop --cwd $CWD --keep-open --json -- \
  codex resume $SID -a never -s danger-full-access | tee -a $LOG
```

Expect: JSON with `"block": <NEW>`. Then `tern rename $NEW "<role>"`. `--keep-open` keeps the block on screen if the agent exits,
so a failed start is visible instead of closing silently.

**codex first-run screens.** The first launch on a machine (and after a codex upgrade) shows up to two screens before the prompt:

| screen | key | do not |
|---|---|---|
| `Update available · …` with `1. Update now / 2. Skip / 3. Skip until next version` | `tern send $NEW keys 2`, then `keys Enter` | do not press 1 (it runs a `curl … | sh` installer) |
| hooks review (`Event … Installed Active Review`, footer `t trust all · enter review · esc close`) | `tern send $NEW keys Escape` | do not press `t`: it trusts every hook and rewrites `~/.codex` |

Check with `tern capture $NEW | tail -6` until the composer line (`› Ask Codex to do anything` or the resumed thread) is visible.

## 4. Verify the new seat (three checks, all must pass)

**4a. Identity: the child argv carries the sid.**

```bash
tern process $NEW --json | python3 -c 'import json,sys;c=json.load(sys.stdin)["child"];print(c["pid"]); print(" ".join(c["argv"]))' | tee -a $LOG
```

Expect within 5 s: argv contains `$SID` (`--resume $SID` / `resume $SID`). Record `NEWPID`.

**4b. Presence (claude seats).**

```bash
sleep 10; cat $P/$SID.pid
```

Expect: a pid, and that pid is a live `bun …/presence.mjs` whose environment has `AGENTHOP_HOST_PID=$NEWPID`. The file holds the
**helper's** pid, not claude's (`docs/research/tui-seat-spike.md` U4). If the file is missing, find the helper and write its pid:

```bash
for h in $(pgrep -f presence.mjs); do
  ps -E -ww -o command= -p $h | tr ' ' '\n' | grep -qx "AGENTHOP_PID_FILE=$P/$SID.pid" && \
  ps -E -ww -o command= -p $h | tr ' ' '\n' | grep -qx "AGENTHOP_HOST_PID=$NEWPID" && echo $h > $P/$SID.pid && echo "restored $h"
done
```

codex seats have no presence file; their pid is `tern process $NEW --json` `.child.pid`. Presence is a projection: a missing file
does not stop the seat from working, but the inbox sentinel and seat lists will show it as absent until it is fixed.

**4c. Inbox reachable.** From the coordinator:

```bash
# writeInbox(home, "$SID", composeInboxMsg({ … text: "[switch check] reply with SWITCH-OK-<role> by agenthop_send" }), "switch-check-$SID")
```

Expect: `published`, and within 2 min the seat answers. Then open the seat's first line through the screen if needed
(section 6, `ask`).

**4d. Bus reachable.**

```bash
# agenthop_peers  → the seat's handle (claude:<dir>-<sid8> / codex:<dir>-<thread8>) is listed, state idle or working
```

Expect: listed, and the answer to 4c arrives as a bus message. Write one PROGRESS line: role, old block, new block, NEWPID, the
three checks, and the rollback line.

## 5. Rollback (one line per seat)

Close the new block (`tern close $NEW`, wait until `NEWPID` is gone and, for claude, `$P/$SID.pid` is gone + 3 s), then start the
original ACP command. The argv below are the ones running on 2026-10-16 (`tern process <block> --json`):

| seat | sid | rollback |
|---|---|---|
| Reserve | b90ccae9-4adb-4925-b5a2-0b81e1b53dc9 | `tern new tab agenthop --cwd ~/Work --keep-open -- tern acp claude --resume b90ccae9-4adb-4925-b5a2-0b81e1b53dc9 --mode bypassPermissions --model 'cpa-local/claude-opus-5-5[1m]'` |
| Infra Dev | 8a53f4e8-c756-4302-a8dd-a9b6427c8fca | `tern new tab agenthop --cwd ~/Dev/agenthop --keep-open -- tern acp claude --resume 8a53f4e8-c756-4302-a8dd-a9b6427c8fca --mode bypassPermissions --model 'cpa-local/claude-opus-5-5[1m]'` |
| Platform Dev | 378177a0-84ea-48a1-8a69-2fadcf750a0d | `tern new tab agenthop --cwd ~/Dev/agenthop --keep-open -- tern acp claude --resume 378177a0-84ea-48a1-8a69-2fadcf750a0d --mode bypassPermissions --model 'cpa-local/claude-opus-5-5[1m]'` |
| OpenDot Dev | aad02248-c76b-4a1a-b191-95da3f0bfb5a | `tern new tab agenthop --cwd ~/Dev/OpenDots --keep-open -- tern acp claude --resume aad02248-c76b-4a1a-b191-95da3f0bfb5a --mode bypassPermissions --model 'cpa-local/claude-opus-5-5[1m]'` |
| Model Gateway | e555b371-2574-4b6c-8654-8186b3aac691 | `tern new tab agenthop --cwd ~/Dev/CLIProxyAPIPlus --keep-open -- tern acp claude --resume e555b371-2574-4b6c-8654-8186b3aac691 --mode bypassPermissions --model 'cpa-local/claude-opus-4-8[1m]'` |
| Chief Review | 01a13284-d361-74a0-a026-ad56f1fdf355 | `tern new tab agenthop --cwd ~/Work --keep-open -- tern acp codex --resume 01a13284-d361-74a0-a026-ad56f1fdf355` |
| Second Voice | 01a13e9a-ea58-7a30-a8db-35cd3ad3f879 | `tern new tab agenthop --cwd ~/Dev/happycapy --keep-open -- env INITIAL_AGENT_MODE=agent-full-access tern acp codex --resume 01a13e9a-ea58-7a30-a8db-35cd3ad3f879` |
| Manager | c5beaa7c (role address) / current session per handoff | the coordinator's own line comes from `coordinator-handoff.md` at switch time (L8) |

Three running ACP blocks (Infra Dev 10797547782146, Platform Dev 10999411245058, Model Gateway 11072425689090) were started
**without** `--resume`; their rollback still names the sid explicitly so the restored block cannot open a new session.

## 6. Talking to a TUI seat after the switch

- Send: `tern send $NEW text '<message>'`, wait 0.3 s, `tern send $NEW keys Enter`. For codex the wait is required: Enter at once
  submitted only 2 of 7 times (spike U3).
- Confirm by the screen, not by the return code: within 6 s the composer no longer holds the text, or the turn started
  (`esc to interrupt` / a spinner). If neither, press Enter once more and check again.
- State from the screen: claude is read well (214/215). For codex, `working` is not detected by the classifier until T1a lands
  (0/56 in the spike), so do not take "idle" on a codex screen as "free".

## 7. Order

One seat per round; the next starts only after the previous one passed section 4.

1. Reserve: done (2026-10-16, block 38306813313026).
2. Infra Dev, then Platform Dev (developer seats; each between two deliveries, worktree clean).
3. Model Gateway.
4. Review seats, Chief Review and Second Voice (codex): after A r11 is merged. Their MCP server runs under the codex app-server
   daemon, not under the Tern block, so it **survives** `tern close` of the old block (spike: `agenthop mcp` stayed under the
   daemon). Check `agenthop_peers` for a stale handle after the switch; stopping the daemon is not part of this runbook.
5. Manager (coordinator) last, through L8 self-succession into a TUI block.

## 8. Not covered

- Rotating a seat to a **new** session (different sid): that is the seat-lifecycle runbook, not a switch.
- The presence fix itself (helper rewrites a missing file on every beat): T3, Infra Dev.
- Stopping the codex app-server daemon or its MCP children.
