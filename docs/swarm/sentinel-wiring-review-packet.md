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
