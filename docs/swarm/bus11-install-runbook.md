# bus.11 install runbook (TUI era)

Replaces `tern-two-shell-cutover-runbook.md` (#1056, void since the ACP → TUI decision #1115). Use it once, after the bus.11 branch
(`fix/dispatcher-env-and-presence`) is cleared by both review seats. Each step: command, expected output, and what to do when the
output is different. Stop at the first step that does not match. Do not fix forward.

Notation: `$R` = `~/Dev/agenthop`; `$S` = `~/.agenthop/swarm`; `$P` = `~/.agenthop/tern-panes` (the bridge control dir; always under
the OS home, never `AH_HOME`).

Who runs it: the coordinator, from its own seat. Step 5 (MCP restart) also needs one action in every seat.

## 0. Gate and baseline

```bash
cd $R && git fetch -q && git log -1 --format='%h %s' main
grep -n "bus.11" ~/.agenthop/swarm/PROGRESS.md | tail -3
```

Expect: the last PROGRESS lines record bus.11 CLEARED by Chief Review and Second Voice at one fixed SHA. If not, stop.

Baseline (the rollback of every later step uses these files):

```bash
B=$S/install-bus11-$(date +%s); mkdir -p $B
cp ~/.local/bin/agenthop $B/agenthop
cp ~/.agenthop/presence.mjs $B/presence.mjs
cp $S/dispatcher-recipe.json $B/dispatcher-recipe.json
cp -R "$HOME/Library/Application Support/Tern/plugins/agenthop-agents-bridge" $B/bridge
~/.local/bin/agenthop --version | tee $B/version.txt
echo "$B" > $S/install-bus11.last
ls $B
```

Expect: `agenthop  bridge  dispatcher-recipe.json  presence.mjs  version.txt`, and `version.txt` reads `agenthop v0.6.1-bus.10 …`.

## 1. Merge bus.11 into main

```bash
cd $R && git switch main && git pull --ff-only
git merge --no-ff fix/dispatcher-env-and-presence -m "merge bus.11 — <one line>"
git log -1 --format='%h %s'
```

Expect: a merge commit; no conflicts. A conflict ⇒ `git merge --abort`, stop, and hand the conflict back to the branch owner.

Rollback: `git reset --hard ORIG_HEAD` before anything is pushed.

## 2. Version

There are two version files. `agenthop --version` prints `packages/bus/src/version.ts`; `packages/cli/src/version.ts` is the CLI
package's own. Change both, or step 3 builds a binary that still says bus.10 (found on install day, 2026-10-16).

```bash
cd $R && for f in packages/cli/src/version.ts packages/bus/src/version.ts; do sed -i '' 's/0.6.1-bus.10/0.6.1-bus.11/' $f; echo "$f: $(cat $f)"; done
git grep -n "0.6.1-bus.10" -- 'packages/*/src/version.ts'; echo "old version left: rc=$?"
git commit -q -m "chore: version 0.6.1-bus.11" -- packages/cli/src/version.ts packages/bus/src/version.ts && git log -1 --format='%h %s'
```

Expect: both files print `export const version = "0.6.1-bus.11";`, `old version left: rc=1` (no match), and the commit line. The
commit names its two files, so nothing else in the tree (for example files left by an earlier build) goes into it.

## 3. Build

```bash
cd $R && pnpm install --frozen-lockfile && node scripts/build-release.mjs 2>&1 | tail -5
dist/agenthop-macos-arm64 --version
cmp -s dist/agenthop-macos-arm64 ~/.local/bin/agenthop; echo "cmp rc=$?"
```

Expect: the build ends without an error; `--version` prints `agenthop v0.6.1-bus.11 (with session bus)`; `cmp rc=1` (the new binary
differs from the installed one). `rc=0` ⇒ nothing changed, stop and check the version step. `--version` still printing `bus.10` ⇒
`packages/bus/src/version.ts` was not changed: go back to step 2.

The build also regenerates `packages/cli/src/presence-text.ts` (the presence daemon bundle that `install` writes) and the skill text.

## 4. Install

```bash
cd /tmp && $R/dist/agenthop-macos-arm64 install 2>&1 | tail -8
~/.local/bin/agenthop --version
cmp -s $R/dist/agenthop-macos-arm64 ~/.local/bin/agenthop; echo "cmp rc=$?"
ls -la ~/.agenthop/presence.mjs
```

Run it from the NEW binary in `dist/`, not from `~/.local/bin/agenthop`: `install` copies the program that runs it. `placeCommand`
copies beside the target and renames it into place, and `isSameFile` (inode + device) refuses to copy a file onto itself, so a
second run from the installed copy is harmless.

Expect: `install` prints `/Users/<you>/.local/bin/agenthop`, one line per skill file it wrote (the dirs in
`~/.agenthop/install.json` `skillDirs`), and `Presence: wrote /Users/<you>/.agenthop/presence.mjs`. A line `Presence: could not
write the bundle (…)` ⇒ stop and roll back. Then `--version` shows `0.6.1-bus.11`, `cmp rc=0`, and `presence.mjs` has a new mtime.
New claude sessions start the new presence daemon; running ones keep their old helper until the seat restarts (step 5).

Rollback:

```bash
B=$(cat $S/install-bus11.last)
cp $B/agenthop ~/.local/bin/agenthop.new && mv -f ~/.local/bin/agenthop.new ~/.local/bin/agenthop
cp $B/presence.mjs ~/.agenthop/presence.mjs.new && mv -f ~/.agenthop/presence.mjs.new ~/.agenthop/presence.mjs
~/.local/bin/agenthop --version   # expect 0.6.1-bus.10
```

## 5. Restart each seat's MCP server

A running `agenthop mcp` keeps the old program until its seat restarts it. Order: low-risk seats first, the coordinator last:
Reserve → OpenDot Dev → Model Gateway → Platform Dev → Infra Dev → Second Voice → Chief Review → Manager.

Per seat (TUI and ACP seats alike):

- claude TUI seat: `/mcp`, reconnect `agenthop`. `/mcp` is a slash command typed into the block; the seat itself has no tool that
  runs it, so the coordinator drives the menu from its own seat (found on install day, 2026-10-16):
  ```bash
  B=<block id>   # the seat's TUI block (tern ls --json)
  tern capture $B | tail -4      # the block must be idle: a busy block swallows the first Enter
  tern send $B text '/mcp' && sleep 0.3 && tern send $B keys Enter    # opens the MCP menu
  tern capture $B | tail -12     # find agenthop in the list; move to it with keys Down, open it with keys Enter
  # choose Reconnect (keys Down / keys Enter as the menu shows), then keys Escape to leave the menu
  tern capture $B | grep -F "Reconnected to agenthop"
  ```
  Expect: `Reconnected to agenthop` on screen. The block, its session and its context stay as they were. Read the menu from the
  screen at each key; do not replay a fixed key sequence blindly, the list order can differ per seat.
- claude ACP seat: there is no screen menu to drive. Its MCP restarts when the seat moves to TUI (seat switch runbook
  `tui-seat-switch-runbook.md` §2-§4, same sid); until then it keeps the old program.
- Never kill an `agenthop mcp` process to restart it: nothing guarantees the client starts a new one, and the seat would lose its
  bus tools mid-install.
- codex: its MCP runs under the codex app-server daemon, not under the Tern block (`docs/research/codex-tui-mcp-parent-probe.md`).
  Restart the thread's MCP from inside codex (`/mcp`); closing the Tern block does not restart it.

Check each seat from any shell:

```bash
for p in $(pgrep -f "agenthop mcp"); do printf "%s ppid=%s start=%s\n" "$p" "$(ps -o ppid= -p $p | tr -d ' ')" "$(ps -o lstart= -p $p)"; done
```

Expect: for each seat, its `agenthop mcp` process started after step 4, and its old one is gone. An older start time ⇒ that seat
still runs the old program. Then, in the seat: `agenthop_peers` lists the seat's own handle. `agenthop_tui` is the T2 tool
(`feat/tui-seat-ops`); it appears only after T2 is merged and installed, so it is not part of this install's acceptance.

A seat that does not come back: stop here and use the switch runbook rollback line for that seat. Do not go to the next seat.

## 6. Bridge plugin (install day, and once more after T1a)

T1b (screen state) is on main since a21f9a5, so the bridge is installed on install day. The classifier (T1a, `feat/tui-classify-r6`)
is not merged yet: install day gives the T1b `screen` command with the classifier main has now. When T1a merges, run this step
again (same commands) so the installed copy carries the new classifier. `tern-install.sh` skips a plugin only when both its
installed and its proven commit equal the checkout's, so the post-T1a run installs and proves again.

```bash
cd $R && git log --oneline -1 && git merge-base --is-ancestor a21f9a5 HEAD && echo "T1b on main"   # expect: T1b on main
bash scripts/tern-install.sh                                          # dry run: prints what --live would do
bash scripts/tern-install.sh --live 2>&1 | tail -6
```

`tern-install.sh --live` runs `tern plugin install … --force`, `tern plugin reload`, and then a load proof: it runs the plugin's
`mirror` command and requires `agents.json` to be rewritten by the reloaded instance, and it checks `tern.log` for load failures and
budget kills. Do not run `tern plugin install` / `reload` by hand: `tern plugin list` reports "ready" even without a daemon, so it is
not a proof.

Expect: exit 0 (loaded and proven). Exit 1 = failed (install/reload error, load failure or budget kill in `tern.log`): roll back.
Exit 2 = installed but the load could not be proven: do not count it as installed; rerun once, then roll back. Then:

```bash
ls $P/screens/ && python3 -c 'import json,glob;f=sorted(glob.glob("'$P'/screens/*.json"))[-1];d=json.load(open(f));print(f, len(d["screens"]))'
```

Expect: at least one `screens/<vm>.json` within a minute (the sweep triggers `screen` every round).

Rollback:

```bash
B=$(cat $S/install-bus11.last)
rm -rf "$HOME/Library/Application Support/Tern/plugins/agenthop-agents-bridge"
cp -R $B/bridge "$HOME/Library/Application Support/Tern/plugins/agenthop-agents-bridge"
tern plugin reload
```

## 7. Restart the dispatcher

`SWARM_TERN_BRIDGE` stays `0` in the recipe. Turning it on is a separate decision.

```bash
python3 -c 'import json,os;d=json.load(open(os.path.expanduser("~/.agenthop/swarm/dispatcher-recipe.json")));print(d["env"].get("SWARM_TERN_BRIDGE"))'
```

Expect: `0`. Anything else ⇒ stop and ask the coordinator.

Restart with the `bash -s` block in `tern-two-shell-cutover-runbook.md` §③ ("停旧起新"). Use that block exactly. It stops only
the lock holder after proving its argv and cwd against the recipe. It starts from the recipe, and it checks that the new pid holds
the lock and carries the recipe env. Do not use `swarm-recover.ts`: it restores from `fleet-snapshot.json` and also starts the
member seats.

Expect: `stopped: <old pid>`, `SWARM_TERN_BRIDGE=0`, `TERN_BIN=…/tern`, `OK: dispatcher pid <new> holds the lock and carries the
recipe env`, `restart rc=0`. `rc=2` = nothing started (handle the ABORT line); `rc=3` = the old one stopped and the new one did not
start: read the `dispatcher.log` tail, then rerun with `START_ONLY=1`.

Rollback: `cp $B/dispatcher-recipe.json $S/dispatcher-recipe.json`, then the same restart block.

## 8. Acceptance (wait 2 minutes after step 7)

```bash
tail -3 $S/dispatcher.log | cut -c1-80
```

Expect: every new line starts with an ISO timestamp (`2026-…T…Z [dispatch disp-<new pid>] …`). A line without it ⇒ the
dispatcher is still the old code; check step 7.

```bash
wc -l $S/soak/inbox-oldest.jsonl; sleep 60; wc -l $S/soak/inbox-oldest.jsonl
```

Expect: the file exists and the second count is larger. It does not exist or does not grow ⇒ look for
`[soak-evidence] could not append` in `dispatcher.log` and in the coordinator's box.

```bash
grep -c "inbox-sentinel] STALL" $S/dispatcher.log; sleep 300; grep -c "inbox-sentinel] STALL" $S/dispatcher.log
```

Expect: the two counts are equal (no new STALL in five minutes). A new STALL for the coordinator's box means the coordinator is not
draining it: check that the coordinator seat's MCP restarted (step 5) and that its inbox is being read.

Write one PROGRESS line: main SHA, version, the baseline dir `$B`, the result of steps 4-8, and which seats were restarted in step 5.

## 9. After

- 12 h soak from the step 7 restart (`docs/swarm/liveness-tier.md` §3).
- After T1a merges: step 6 once more (install + reload + load proof), then check `$P/screens/` again.
- `SWARM_TERN_BRIDGE=1` is a separate decision with its own restart (same block, recipe value `1`).
- Remove `$B` only after the soak passed.
