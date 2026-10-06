# herdr phase-2 real-machine verification — raw receipt archive + findings (2026-10-06, S14, 90b58f9c)

Per coordinator R13 phase-2 ticket. **Isolated** herdr TUI (dedicated `XDG_CONFIG_HOME=/tmp/herdr-p2-cfg`,
dedicated session `ahp2probe`, a real codex probe agent `probeagent`) launched in its own Ghostty window via
AppleScript; driven purely over the isolated socket; **never touched the live swarm sessions**. Environment fully
torn down after capture (session stopped+deleted, probe window closed, temp config removed, no leftover process).

herdr 0.9.3, binary `~/.local/bin/herdr`. Probe kind: codex (GPT-6-Astra). Raw JSON in this directory, filenames
`01..08`. This is a USER-APPROVED one-off real-machine run (minimal API usage).

## Captured receipts (raw files)

| # | file | what it proves |
|---|------|----------------|
| 01 | `01-agent-started.json` | `agent start` success shape |
| 02 | `02-agent-get.json` | `agent get` success shape (pane binding field) |
| 03 | `03-prompt-wait-success.json` | `agent prompt --wait` on a real working task |
| 04 | `04-prompt-stalled.json` | `agent prompt --wait` stalled (first trivial prompt) |
| 05 | `05-read-recent-unwrapped.txt` | real `agent read recent-unwrapped` noise sample |
| 06 | `06-submit-agent-prompted.json` | `agent prompt` (no --wait) success shape |
| 07 | `07-agent-name-taken.json` | duplicate `agent start` error code |
| 08 | `08-prompt-not-found.json` | `agent prompt` to a nonexistent agent |

## Findings vs the five ticket items

**① `agent prompt` success shape — CONFIRMED (06).**
`{"result":{"type":"agent_prompted","agent":{"agent":"codex","agent_status":"idle","name":"probeagent","pane_id":"w1:p2",...}}}`.
Success is `result.type==="agent_prompted"` with `result.agent` an AgentInfo carrying a string `pane_id` and the
`name` we targeted. This exactly matches `classifySubmit`'s positive path (type + agent + pane_id + name===target).
`name` is **populated** (="probeagent"), not null.

**① `agent prompt --wait` settle — NO RELIABLE SIGNAL (03, 04).**
`--wait` returned `{"error":{"code":"agent_prompt_stalled","message":"agent prompt produced no observed working or
blocked state within 5000 ms; current status is idle"}}` — on BOTH a trivial prompt AND a real working task. The
pane read (05) proves the second prompt **was submitted and codex completed it** ("17 × 23 = 391 ... Worked for 7s"),
yet `--wait` still declared stalled: herdr's 5000ms working-state detector never observed codex's 7s of work. So in
herdr 0.9.3 `--wait` does **not** yield a trustworthy settle receipt for codex. **WAIT_SETTLE_TYPES stays empty is
now empirically justified, not merely conservative.** settle remains `unknown`.

**② post-submit timeout / stalled — CONFIRMED (03, 04).**
`agent_prompt_stalled` occurred even though the prompt was submitted and the work completed. This is the reviewer's
R3-P2-1 exactly: a `--wait`/prompt error can post-date a real submission. Mapping it to `no` would be wrong;
`unknown` (never replay) is correct.

**③ `agent_name_taken` — CONFIRMED (07).**
Starting a second agent with an existing name: `{"error":{"code":"agent_name_taken","message":"agent name
probeagent is already used; candidates: ..."}}`. The second agent did NOT start. Matches `HARD_NOT_STARTED`.
`08` confirms `agent prompt` to a missing agent → `{"error":{"code":"agent_not_found",...}}`, validating
`SUBMIT_REJECTED = {agent_not_found}` (the one provably-not-submitted prompt code observed).

**④ `agent_started` null-name — DOES NOT OCCUR (01).**
`{"result":{"type":"agent_started","agent":{"name":"probeagent","pane_id":"w1:p2","agent_status":"idle",
"agent":"codex","interactive_ready":true,...},"argv":["codex"]}}`. A start-by-name yields a populated `name`. So the
schema-legal null-name case was NOT observed in practice — the positive target binding (require name===target) stays
correct and is NOT relaxed. `02` `agent get` → `result.type==="agent_info"`, `result.agent.pane_id` present
(validates `agentPaneId`/`paneBound`, R2-P2-5).

**⑤ `agent read recent-unwrapped` noise — SAMPLE CAPTURED (05).**
Real chrome seen: codex startup hook-review/trust screen, `Worked for Ns`, `› Ask Codex to do anything`, the
`GPT-… · Context … · …` status line, `← for agents · ? for shortcuts`. Confirms the `stripTui` drop-list targets are
realistic. (Also a real finding: a freshly-started codex probe BLOCKS on a hook-trust prompt while herdr reports it
`idle` — a herdr state-detection gap relevant to the future sentinel, not to this module.)

## Code narrowing applied (evidence-driven)

1. **herdrPrompt** now confirms submission from the plain `agent prompt` receipt (reliably `agent_prompted`, 06) and
   does **not** use `--wait` for confirmation: `--wait` stalls even on success (03/04), which would turn a real
   success into `unknown`. `settled` stays `false` (no reliable settle signal in 0.9.3). This converts real
   successes from `unknown` → `yes` while never fabricating a settle.
2. **WAIT_SETTLE_TYPES** stays empty — now with the empirical reason (no reliable `--wait` settle receipt exists in
   0.9.3). `settledFrom` / `buildAgentPromptWait` are kept as the dormant re-enable seam for a future herdr that
   emits a trustworthy settle/working signal.
3. **classifySubmit / HARD_NOT_STARTED / SUBMIT_REJECTED / agentPaneId** are all confirmed against real receipts; no
   logic change needed, comments cite the archived evidence.
4. **null-name NOT relaxed**: real starts/prompts populate `name`, so the positive binding is kept strict.

## Boundary

One isolated real codex agent, minimal prompts, torn down. No live swarm session was prompted, read, or closed.
Not merged, not pushed. Re-review of archive↔narrowing consistency pending (01a0ff49).
