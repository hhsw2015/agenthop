# S14 live-sentinel wiring — review packet

**Branch** `feat/sentinel-wiring` · **HEAD** `8b534f3` · **Base** `main=c3439cd` · **Author/fixOwner** d7f6c917 · **Reviewer** codex 01a0ead5 · **Gates** bus tsc 0, dispatch tsc 0, herdr selftest, 1002/1002 vitest (+11)

## Scope
Wire the live member sentinel into the dispatcher sweep loop, driven by herdr BLOCKING primitives (not tick-polling); each primitive replaces a poll. Detect and escalate blocked (S19 approval), working-fake-death, idle-timeout. Gated and dormant.

## Primitives used (each replaces a poll or manual step)
- `agent wait --until` via herdrWait/waitLeave: idle-leave, done-wake, blocked-unblock. Replaces idle/state polling.
- `pane wait-output` via herdrWaitOutput: a working member silent past the timeout becomes fake-death. Replaces the screen-hash-diff poll.
- `agent explain` via herdrExplain: block characterization attached to the S19 approval. Replaces raw-screen-only.
- `agent prompt --wait` via herdrPromptWait: inject-back primitive provided, replacing blind send-keys; its trigger is the coordinator decision-relay, not wired in this detection ticket.

## Design
- `live-sentinel.ts` superviseMember: per-member async state machine over an injected WatchOps; one blocking wait per step, no racing, so no orphan child execs. Pure over the ops, unit-tested with scripted responses, no herdr and no clock.
- `live-sentinel.ts` decideLiveSentinel: pure presence-only fallback; blocked via self-report, idle-timeout via status age, no screen so no fake-death.
- `herdr.ts`: pure builders buildPaneWaitOutput and buildAgentExplain, plus IO wrappers; herdrRun gains an AbortSignal for watcher cancellation.
- `swarm-dispatch.ts` runLiveSentinel: one watcher per herdr-identified member, started and reaped each sweep tick, aborted on gate-off or herdr-unreachable, plus the fallback. Blocked runs sentinelDecision (R12 escalate) then buildApprovalDoc (S19 with explain and screen).

## Invariants and boundaries
- Verified-only: every decision reads the `agent list` state or the status file, never an unparsed herdr wait receipt, the same discipline as WAIT_SETTLE_TYPES. waitOutput classifies only output, timeout, or error.
- Gate SWARM_SENTINEL default-off plus a herdrServerReachable guard, so it is dormant-ahead-of-use; gate-off or unreachable aborts all watchers.
- R12: a blocked member always escalates with zero whitelist; the sentinel never auto-answers; the detection loop issues no send-keys.
- Fail-soft with per-member isolation; per-member-and-kind dedup over NOTIFY_DEDUP_MS; the sweep tick never blocks on a watcher.

## Tests
packages/bus/test/swarm-live-sentinel.test.ts, 11 cases. superviseMember: blocked gives explain, emit, then leave-wait; working plus timeout while still working gives fake-death; working plus output gives none; working plus timeout after a state change gives none; idle that stays gives idle-timeout; idle that leaves gives none; done gives none; output-error gives none. decideLiveSentinel: self-reported blocked; idle age at or below threshold; missing age gives none; working or absent gives none. Scripted WatchOps end the loop by exhaustion, no real herdr or clock.

## Known limitations and follow-ups (not defects this ticket)
- The herdr-name to bus-sid mapping is the open identification work, 1/7 lit. Until it lands, a both-identified member that self-reports idle may double-notify; this is benign, one notice per ID and no wrong action, and blocked cannot double because a stuck member cannot self-report. A best-effort exact-name exclusion is applied.
- The live `agent wait --until`, `pane wait-output`, and `agent explain` receipt shapes are unverified against herdr 0.9.3, 1/7 lit; the wrappers are conservative and decide on verified state only. Item 3's real-scenario proof rides the live acceptance when members are herdr-lit, per THREE-rollout-roster.
- The inject-back loop, decision-relay to herdrPromptWait, is the coordinator's step; the primitive is provided with a tested path.

## Out of scope
A2 execution; flipping SWARM_SENTINEL; the decision inject-back trigger; BA9 and envelope-open from other pool items.

## Reproduce
`cd packages/bus && npx vitest run test/swarm-live-sentinel.test.ts`, then `npx tsx src/swarm/herdr.selftest.mts`, plus tsc per the gates. No merge, push, or deploy performed.

## Round 2 — fixes for the 8b534f3 review (code a77b1fd, base c3439cd)
- LS1 (P1): buildPaneWaitOutput uses a positional pane argument; a wait-output error backs off (bounded) instead of spinning.
- LS2 (P1): fake-death rests on a content-hash diff (new-output evidence) with the pane re-resolved each cycle; pane wait-output is only a bounded block, its match is not trusted as progress.
- LS3 (P2): herdrWait returns an outcome (reached, timeout, error); idle-timeout fires only on a real timeout still-idle, and a wait error backs off.
- LS4 (P1): sentinelEscalate records the dedup slot only after a non-failed delivery; a failed send keeps the obligation and the next tick retries.
- N1 (nit): approval text no longer claims prompt --wait injects into a blocked agent; the authorized party chooses the inject per the real UI. Changed line: scripts/swarm-dispatch.ts:1229, sha256 568703a90049df6d5f4fd351f271f5d947e76706409ca0a0ce9c90540488b34e.
- Tests updated: 11 superviseMember + fallback cases cover LS1 backoff, LS2 content-diff both ways, LS3 wait-error-not-timeout. Gates: bus tsc 0, dispatch tsc 0, herdr selftest, 1002/1002 vitest.

## Round 3 — fixes for the a77b1fd review (code 9f7a345, base c3439cd)
- LS4 (P1): a failed escalation is parked in sentinelPending and sentinelRetryPending re-attempts it every sweep tick, so recovery is automatic and independent of the watcher re-emitting; success records dedup and clears pending; a dk already pending is not rebuilt.
- LS2 (P2): herdrReadContent returns null on a failed read so an error is never hashed as progress; a null read floors and retries without moving the silence clock or emitting; the fake-death emit re-checks state is still working after the window; a non-timeout wait-output return floors the sample rate.
- LS3 (P2): herdrWait measures elapsed and only calls a deadline-length run a timeout; a fast successful exit that is no longer at the target reached a target then fell back, not a timeout, so a 75 ms reach-then-idle no longer reports 1800 s.
- Tests: 13 superviseMember and fallback cases, adding null-read, pre-emit state re-check, and the content-diff paths. Gates: bus tsc 0, dispatch tsc 0, herdr selftest, 1004/1004 vitest.

## Round 4 — fixes for the 9f7a345 review (code 6f2941d, base c3439cd)
- LS3 (P2): a new pure classifyWaitOutcome decides the wait result; a timeout needs a positive marker (error code timeout or wait_timeout, result.timed_out, a result.type matching timeout, or a timeout word on a failed exit) and is never inferred from near-deadline elapsed, so a success that lands at 1919 ms and falls back to idle is reached, not a false timeout. herdrWait delegates to it and is now selftested.
- LS2 (P2): the fake-death emit re-checks both state==working and stopped() AFTER the state read, so an abort during that read no longer emits.
- LS4/R23-A (P1): sentinelRetryPending runs before the herdr-reachability gate, so a parked escalation retries every sweep tick even while the observation source is down; a new observation still needs herdr.
- Tests: classifyWaitOutcome selftest (8 cases incl. the success-fallback) + an abort-during-re-check case; 14 superviseMember/fallback cases. Gates: bus tsc 0, dispatch tsc 0, herdr selftest, 1005/1005 vitest.

## Round 5 — fix for the 6f2941d review (code 665df18, base c3439cd)
- LS3 (P2): classifyWaitOutcome now derives a timeout ONLY from a structured marker (error code timeout or wait_timeout, result.timed_out, a result.type matching timeout); the raw-text substring heuristic is removed, so a member named timeout-worker under permission_denied, or a socket timed out connection failure, is an error, never a member-wait timeout. Any failed exit without a structured marker is error; a recognized non-timeout code takes priority.
- Selftest: the former raw-text case now expects error, plus two counterexamples (non-timeout code with timeout in the text; socket timed out failed exit). Gates: bus tsc 0, dispatch tsc 0, herdr selftest, 1005/1005 vitest.

## FINAL — review CLEARED (codex 01a0ead5, round 5): 0 REMAIN + N2 nit closed
- Behavior acceptance PASSED at 665df18: LS1/LS2/LS3/LS4 + N1 all CLOSED across 5 rounds.
- N2 (nit, S27③ line-hash closure): the classifyWaitOutcome doc-comment described a removed raw-text timeout path; rewritten to state timeout comes only from a structured marker. Comment-only, code 2df0b86; comment block (herdr.ts:240-245 incl. trailing LF) sha256 436a1cfd12859a0a2fa3363ec6e22fc852004d1c24c96468d55a2edac8ae039a (canonical per reviewer; my earlier ac3d7637 was a different line range).
- Gates at 2df0b86: bus tsc 0, dispatch tsc 0, herdr selftest, 1005/1005 vitest, packet stcn100 lint-only deterministic-clean. No merge/push/deploy — merge is the coordinator's per existing gates.
- Out of scope / packet-exempt (recorded): herdr-name↔sid identification mapping; real-member receipt shapes; the inject-back trigger; A2; flipping SWARM_SENTINEL.
