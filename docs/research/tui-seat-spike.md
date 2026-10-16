# TUI seat spike (Phase 0 of the ACP → TUI migration)

> Evidence corpus (652 captures, probe.tsv, states/truth/u3 tables, sampler scripts) lives on branch `spike/tui-seat` @d323713 under `docs/research/tui-seat-spike/`; it is not on main (45k lines of screen dumps).


Owner: Reserve b90ccae9. Brief: `docs/swarm/tui-migration-brief.md` §4 Phase 0. Branch `spike/tui-seat`, no production change.
Window: 2026-10-16 03:56Z → 05:06Z (70 min). Evidence: `docs/research/tui-seat-spike/` (captures, `states.tsv`, `probe.tsv`,
`u1-truth-table.tsv`, `u3-results.tsv`, scripts). The eight live seats were not touched.

## Short answers

| Question | Answer |
|---|---|
| U1 classifier truth rate | claude **214/215 (99.5%)**; codex **359/415 (86.5%)**, and 0 of 56 codex *working* samples correct |
| U2 codex manifest | blocked and idle hit; **working never hits** (the rules read only the OSC title, codex sets none) |
| U3 submit | claude: any method, first Enter. codex: **text or paste → 0.3 s → Enter** is 7/7; Enter at once is 2/7 |
| U4 presence | claude: the SessionStart hook writes `presence/<sid>.pid` by itself, but with the **helper's pid**, not claude's. codex: no presence file; pid = `tern process <block> --json` `.child.pid` |
| U5 bus | all test blocks appear in `agenthop_peers`; claude round trip proven (it answered `U5-CLAUDE-OK`); codex round trip not tested |

## Launch commands (input for roster v2)

```bash
tern new tab agenthop --cwd ~/Dev/agenthop -- claude --permission-mode bypassPermissions --model 'cpa-local/claude-opus-5-5[1m]' --session-id <uuid>
tern new tab agenthop --cwd ~/Work -- codex -a never -s danger-full-access
```

- claude: `--session-id <uuid>` fixes the sid of a new seat, so its presence file and transcript are known before it starts. A resumed seat uses `--resume <sid>`; the coordinator used that to move this seat (block 38306813313026).
- codex: `-a` takes only `on-request` or `never` (`untrusted` exits with an error). The first launch shows two screens that need a key:
  an update notice (`2` = Skip, then Enter) and a hooks review (Esc closes it). Do **not** press `t` there: it trusts every hook and changes `~/.codex`.
- codex `-a on-request -s read-only` is the setting that produces approval prompts (used here only for the blocked samples).

## U1 — classifier against the screen

Method: every 30 s `tern capture --scrollback` of each block; the visible screen (last 24 lines) and the block title go through the production
`classify.luau` (`classify-file.lua`, offline, no bridge load). A second sampler every 4 s for 5 min. Truth = what a person reads on the same capture:
a permission dialog ⇒ blocked; `esc to interrupt`, a spinner verb or a working title ⇒ working; else idle (`score-u1.py`).

| tool | truth idle | truth working | truth blocked | total |
|---|---|---|---|---|
| claude | 200/200 | 6/7 | 8/8 | 214/215 |
| codex | 347/347 | **0/56** | 12/12 | 359/415 |

- claude blocked came from two rules: `agenthop_file_permission_dialog` (Write dialog, 3 cases) and `generic_permission_prompt` (Bash `find -exec`
  and an MCP tool prompt). The one claude miss is a capture less than 1 s after submit: the body already showed `✢ Incubating…`, the title had not
  changed yet, and the classifier reads the title first.
- codex blocked: `live_strong_blocker` matched every approval prompt ("Would you like to run…" / "Press enter to confirm or esc to cancel").
- Idle is right for both tools in every sample. A miss is always working → idle, never idle → working or blocked → anything else.

## U2 — why codex *working* is never seen

The codex manifest (herdr `2026.06.10.3`) has two title rules (`osc_title_working`: a braille spinner; `osc_title_blocked`: "Action Required")
and three body rules, all of them blockers. In this codex (0.162.1) the block title stays **empty** for the whole session, also during
`Working (16s • esc to interrupt)`. Our `~/.codex/config.toml` has `[tui] terminal_title = []`. With `-c 'tui.terminal_title=["spinner","project"]'`
the title becomes the project name (`tui-spike-codex4`) and still shows no spinner while working. An unknown item is rejected with the warning
`Ignored invalid terminal title item: "bogus-item"`, so the key is read.

Fix belongs to T1a (classifier), not to the seat: add a codex body rule such as `bottom_non_empty_lines(6)` contains `esc to interrupt`
(state working, below the blockers). Checked offline on this run's captures: the last 6 non-empty lines contain
`esc to interrupt` in **56/56** codex working samples and in **0/347** idle samples. Until then a codex seat that works looks idle,
so a sentinel must not take "idle" from a codex screen as proof that the seat is free.

## U3 — does text + Enter submit?

Judged only by the screen (capture before/after) and the transcript (a new `user` message), never by the return code of `tern send`.
Seven rounds per method, two-line messages (`u3-test.sh`, `u3-results.tsv`).

| method | claude | codex |
|---|---|---|
| `text`, then `keys Enter` at once | 7/7 | **2/7** (5 needed a second Enter) |
| `text`, `sleep 0.3`, `keys Enter` | 7/7 | 7/7 |
| `paste`, `sleep 0.3`, `keys Enter` | 7/7 | 7/7 |

Rule for `ask`: send the text (or paste), wait 0.3 s, press Enter, then check the screen. Press Enter once more only if the composer still
holds the text and no turn started. This is the herdr sequence (bracketed paste, 300 ms, Enter).

## U4 — presence and pid

- claude: the SessionStart hook in `~/.claude/settings.json` (`agenthop-presence-hook:start`) wrote `~/.agenthop/presence/c84b7fc5-….pid`
  2 s after start, with no help. The file holds **91019 = `bun presence.mjs`** (parent 1), the long-lived helper. claude itself is 90925
  (`tern process … .child.pid`). A reader that needs the agent's pid must use the helper's `AGENTHOP_HOST_PID`, or `tern process`.
- codex: no file under `presence/` for its thread id. The pid comes from `tern process <block> --json` (`.child.pid`, 91513 here).
- After the coordinator moved this seat to TUI (resume of b90ccae9), `presence/b90ccae9-….pid` was **absent**, although its helper (55491,
  `AGENTHOP_HOST_PID=55227`, `AGENTHOP_PID_FILE` = that path) was running. A likely cause is the old ACP block's SessionEnd hook deleting the
  file after the new helper wrote it. The coordinator confirmed it: the SessionEnd hook removes `presence/<sid>.pid` by sid, and the helper
  (presence.ts:54) writes the file only once, so a same-sid close-then-start loses it for good. The coordinator restored it (55491).
  Fix goes with T3; the switch template waits until the old `.pid` is gone, plus 3 s, before starting the new block.

## U5 — bus

- `agenthop_peers` lists the claude test block (`claude:agenthop-c84b7fc5`, state idle) and the codex blocks (`codex:Work-01a142d9`,
  `codex:tui-spike-codex-…`, state unknown).
- claude round trip: my `agenthop_send` reached the block as a bus message; it answered with `agenthop_send` and I received `U5-CLAUDE-OK`.
  In manual permission mode that tool call raised a permission dialog (classified blocked); in bypassPermissions it does not.
- codex: listed, not tested end to end.

## What this means for the switch (Phase 3)

1. Seat command lines: as above; codex needs the two first-run screens answered once per machine.
2. `ask` must wait 0.3 s before Enter and confirm by screen; the codex cases make a plain text+Enter unreliable.
3. Presence: claude is automatic but records the helper pid; codex needs the pid from Tern. Check the `.pid` file after every switch (it was missing after this seat's switch).
4. Do not trust a codex *idle* until T1a adds a body rule for working.

## Not done

- codex bus round trip; codex `--resume` command line; a run longer than 70 min.
- All three test blocks were closed with `tern close` after checking their pids (90925, 91513, 5593) were gone. The claude
  presence helper (91019) exited about 20 s after claude, by itself.
- Left running on purpose: `agenthop mcp` pid 5833, cwd `/tmp/tui-spike-codex`, parent = the codex **app-server daemon** (83554, 0.163.0),
  not the Tern block. A codex TUI seat's MCP server therefore lives under the shared codex daemon and survives `tern close` of the block;
  whoever owns that daemon decides whether to stop it. Seat stop (T2) cannot assume the MCP process ends with the block.
