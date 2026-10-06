# herdr phase-2 real-machine verification — raw receipt archive + findings (2026-10-06, S14, 90b58f9c)

Per coordinator R13 phase-2 ticket. **Isolated** herdr TUI (dedicated `XDG_CONFIG_HOME=/tmp/herdr-p2-cfg`,
dedicated session `ahp2probe`, a real codex probe agent `probeagent`) launched in its own Ghostty window via
AppleScript; driven purely over the isolated socket; **never touched the live swarm sessions**. Environment fully
torn down after capture (session stopped+deleted, probe window closed, temp config removed, no leftover process).

herdr 0.9.3, binary `~/.local/bin/herdr`. Probe kind: codex (GPT-6-Astra). Raw JSON in this directory, filenames
`01..08`. This is a USER-APPROVED one-off real-machine run (minimal API usage).

## Captured receipts (raw files)

Two runs. Run 1 (01–08) captured the shapes but did NOT archive the completion read for the stalled working
prompt (a gap the reviewer caught). Run 2 (09–11) re-captured the decisive `--wait` case with a complete,
timestamped archive. Both runs are isolated+torn-down.

| # | file | what it proves |
|---|------|----------------|
| 01 | `01-agent-started.json` | `agent start` success shape |
| 02 | `02-agent-get.json` | `agent get` success shape (pane binding field) |
| 03 | `03-prompt-wait-success.json` | run-1 `agent prompt --wait` (multiplication) → stalled; run-1 completion read was NOT archived (the gap; fixed by 09–11) |
| 04 | `04-prompt-stalled.json` | run-1 `agent prompt --wait` (trivial "OK") → stalled BECAUSE codex was still on the startup hook page (see 05): not-ready, NOT a detection miss |
| 05 | `05-read-recent-unwrapped.txt` | run-1 read AT the first stall: codex on the startup hook-trust page (explains 04). A real noise sample. **Does NOT contain 391 / "Worked for 7s".** |
| 06 | `06-submit-agent-prompted.json` | `agent prompt` (no --wait) success shape |
| 07 | `07-agent-name-taken.json` | duplicate `agent start` error code |
| 08 | `08-prompt-not-found.json` | `agent prompt` to a nonexistent agent |
| 09 | `09-input-ready-read.txt` + `09b-status-before.json` | run-2: codex AT its input prompt, status `idle` + `interactive_ready:true`, BEFORE the prompt |
| 10 | `10-prompt-wait.json` + `10-sequence-timing.txt` | run-2 `agent prompt --wait` on the input-ready agent → `agent_prompt_stalled` at ~5.4s (T0→T1) |
| 11 | `11-read-after-completion.txt` | run-2 read right after: codex DID complete — "17 × 23 = … = 391 … Worked for 7s" |

## Findings vs the five ticket items

**① `agent prompt` success shape — CONFIRMED (06).**
`{"result":{"type":"agent_prompted","agent":{"agent":"codex","agent_status":"idle","name":"probeagent","pane_id":"w1:p2",...}}}`.
Success is `result.type==="agent_prompted"` with `result.agent` an AgentInfo carrying a string `pane_id` and the
`name` we targeted. This exactly matches `classifySubmit`'s positive path (type + agent + pane_id + name===target).
`name` is **populated** (="probeagent"), not null.

**① `agent prompt --wait` settle — NO RELIABLE SIGNAL (09 → 10 → 11, timestamped).**
Two stalls were seen, with DIFFERENT causes — run 1 did not separate them, so run 2 re-captured the decisive case:
 - run-1 trivial "OK" prompt stalled because codex was still on its startup hook-trust page (read 05) — the agent
   was not ready, NOT a detection miss.
 - run-2 is decisive: codex was confirmed AT its input prompt, `idle` + `interactive_ready:true` (09 / 09b); the
   working prompt was sent; `agent prompt --wait` returned `agent_prompt_stalled` at ~5.4s (10 + timing T0→T1); the
   immediate read (11) shows codex DID receive and complete it — "17 × 23 = … = 391 … Worked for 7s". herdr's 5000ms
   working-state detector missed a genuinely working+completed codex turn.
So in herdr 0.9.3 `--wait` does **not** yield a trustworthy settle receipt for codex: it reports stalled on a real,
input-ready, submitted, completed prompt. **WAIT_SETTLE_TYPES empty is empirically justified, not merely
conservative;** settle stays `unknown`.

**② post-submit timeout / stalled — CONFIRMED (09 → 10 → 11).**
In run 2, `agent_prompt_stalled` was returned for a prompt submitted to a confirmed input-ready agent that then
completed the work (391). This is the reviewer's R3-P2-1 exactly: a `--wait`/prompt error can post-date a real
submission AND completion. Mapping it to `no` would be wrong; `unknown` (never replay) is correct.

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

**⑤ `agent read recent-unwrapped` noise — SAMPLES CAPTURED (05, 11).**
Real chrome across the reads: codex startup hook-review/trust screen + `› Ask Codex to do anything` + the
`GPT-… · Context … · …` status line + `← for agents · ? for shortcuts` (05); `Worked for Ns` (11). Confirms the
`stripTui` drop-list targets are realistic. (Also a real finding: a freshly-started codex probe can BLOCK on a
hook-trust prompt while herdr reports it `idle` — a herdr state-detection gap relevant to the future sentinel, not
to this module.)

## Code narrowing applied (evidence-driven)

1. **herdrPrompt** now confirms submission from the plain `agent prompt` receipt (reliably `agent_prompted`, 06) and
   does **not** use `--wait` for confirmation: `--wait` stalls even on an input-ready, submitted, completed prompt
   (09 → 10 → 11), which would turn a real success into `unknown`. `settled` stays `false` (no reliable settle signal
   in 0.9.3). This converts real successes from `unknown` → `yes` while never fabricating a settle.
2. **WAIT_SETTLE_TYPES** stays empty — now with the empirical reason (no reliable `--wait` settle receipt exists in
   0.9.3). `settledFrom` / `buildAgentPromptWait` are kept as the dormant re-enable seam for a future herdr that
   emits a trustworthy settle/working signal.
3. **classifySubmit / HARD_NOT_STARTED / SUBMIT_REJECTED / agentPaneId** are all confirmed against real receipts; no
   logic change needed, comments cite the archived evidence.
4. **null-name NOT relaxed**: real starts/prompts populate `name`, so the positive binding is kept strict.

## Boundary

Two isolated real-machine runs (run 1: shapes 01–08; run 2: the decisive input-ready→stalled→completed sequence
09–11, added after the reviewer caught that run 1 never archived the completion read). Each run: dedicated config +
session + one short-lived codex probe in its own Ghostty window, driven only over the isolated socket, fully torn
down. No live swarm session was prompted, read, or closed. Not merged, not pushed. Re-review of archive↔narrowing
consistency pending (01a0ff49).
