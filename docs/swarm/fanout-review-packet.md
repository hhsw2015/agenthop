# Review packet — fanout-native phase-1 (sovereign self-built backend), ROUND 2

- **Branch** `feat/fanout-native`  **HEAD** `c55f9e5`  **Base** `c3439cd`  (round-1 reviewed at `ff16594`)
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Contract pointers (N1)**: design `docs/swarm/fanout-native-design.md` @`fc799d9` + pre-study `docs/swarm/fanout-prestudy.md` @`cd42840`, both on branch `feat/fanout-native-design`.

## What this is
Phase-1 of fan-out nativization: the SOVEREIGN self-built backend a long-lived member wields as a stateless sub-tool. A pure governance core (`fanout.ts`) + a visible-chain pure layer (`fanout-herdr.ts`) + a thin IO driver (`swarm-fanout.ts`) that composes the AS-IS spawn stack, single-flight, and the herdr CLI. DORMANT behind `SWARM_FANOUT`. Round-1 was 8P1 + 1P2; all resolved below.

## Round 2 — round-1 REMAIN resolved (FN1-FN9 + FN4-B, N1)
- FN1 budget breaker now meters a conservative per-launch reservation (ceiling from the budget ticket); on overrun it stops launching and `markAborted` gives every un-launched/running unit a terminal `aborted` state (honest aggregate).
- FN2 single-flight lock per `runKey` serializes replays; the ledger row is durably written BEFORE each spawn; `planResume` reuses prior DONE rows by key (no re-pay); a `try/finally` releases leases and despawns launched children on any throw.
- FN3 the aggregate (`red.items`) is persisted to `aggregate.json` FIRST; only then does `nextReceipt(priorReceipt, allTerminal, persistOk)` advance — never a fake accept, never a re-deliver, never a revoke.
- FN4-B VISIBLE chain (user ruling B): `fanout-herdr.ts` composes herdr's OWN CLI — workspace create/rename (the `fanout-<runKey>` zone) -> pane split -> `pane run` the full command with the tier-model on the command line (task + model explicit; F41: atomic, not send-text) -> `pane wait-output` -> harvest `rc` + output -> `workspace close` (canReapZone / F42). herdr is NOT forked; `spawn.ts` is untouched; degrades to headless on zone-open fail or over-16 panes.
- FN5 `runKey` restricted to a safe slug at validation; the ledger path cannot escape the fanout dir.
- FN6 depth carried in `FANOUT_DEPTH`; `admitDepth` checked before spawn; children get `depth+1`; at the cap no child launches.
- FN7 the width gate consumes REAL evidence bound to the run: `validRoiEstimate` / `validBudgetTicket` over files the env only POINTS to (`FANOUT_ROI_FILE` / `FANOUT_TICKET_FILE`), never a bare flag.
- FN8 `classifyExit` from the registry `exitCode` + `spawn.ok` + output evidence (a non-zero exit is failed; an empty yield is not a silent success); the visible path reads a real exit code from the `rc` sidecar.
- FN9 a cross-run shared admission lease under a global single-flight lock, with stale (dead-pid) leases reaped — the cap now holds across concurrent runs, not just one call.
- N1 packet HEAD + contract pointers updated (above).

## Boundaries
1. Dormant: `SWARM_FANOUT` defaults off; the driver exits early when unset.
2. Additive only: modifies NO AS-IS component. `spawn.ts`, the herdr binary, control-log, `model-tier.ts` are untouched; the herdr chain uses the herdr CLI by direct exec (not a fork), and `shquote` is imported read-only.
3. No merge/push/deploy. Native (claude `Workflow`) backend = phase-2.

## Files + tests
| Module | ~lines | Tests | Purpose |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/fanout.ts` | ~320 | 90 | pure governance (schema/width/tier/display/reduce/receipt/budget/sweep/zone/depth/classify/evidence/resume/abort) |
| `packages/bus/src/swarm/fanout-herdr.ts` | ~75 | 22 | pure visible-chain builders/parsers + the unit command (tier-model + F41 atomic + rc sidecar) |
| `packages/bus/src/swarm/fanout.selftest.mts` | ~230 | 90 | one named counterexample per pit + per round-1 finding |
| `packages/bus/src/swarm/fanout-herdr.selftest.mts` | ~55 | 22 | builders/parsers + the char-swallow defense |
| `scripts/swarm-fanout.ts` | ~230 | live | driver: single-flight, resume, width-evidence, depth, pool + shared lease, both backends, breaker, classify, persist-then-receipt, F42 cleanup |

## Gates
- bus tsc 0; scripts tsc 0; fanout selftest 90/90; fanout-herdr selftest 22/22; bus vitest 991/991 (unchanged — additive files).

## Open self-flags (reviewer please rule)
- FN1 metering is a conservative per-launch RESERVATION (`FANOUT_UNIT_TOKEN_EST`), not a parse of real post-hoc token usage — the breaker is bounded-above-correct (never overshoots), but a real-usage parse is a phase-2 refinement. Reviewer: confirm reservation is acceptable for phase-1.
- FN9 shared lease uses a file-per-unit dir under a global single-flight lock with stale (dead-pid) reaping; acceptable for same-machine phase-1 (cross-machine is out of scope).
