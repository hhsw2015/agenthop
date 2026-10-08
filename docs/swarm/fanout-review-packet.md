# Review packet — fanout-native phase-1 (sovereign self-built backend), ROUND 3

- **Branch** `feat/fanout-native`  **HEAD** `64bfb17`  **Base** `c3439cd`  (round-1 `ff16594`, round-2 `c55f9e5`)
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Contract pointers**: design `docs/swarm/fanout-native-design.md` @`fc799d9` + pre-study `docs/swarm/fanout-prestudy.md` @`cd42840`, both on branch `feat/fanout-native-design`.

## What this is
Phase-1 of fan-out nativization: the SOVEREIGN self-built backend a long-lived member wields as a stateless sub-tool. A pure governance core (`fanout.ts`) + a visible-chain pure layer (`fanout-herdr.ts`) + a thin IO driver (`swarm-fanout.ts`) that composes the AS-IS spawn stack, single-flight, and the herdr CLI. DORMANT behind `SWARM_FANOUT`. Headless is the DEFAULT; the temp-workspace visible chain is an explicit opt-in (`visible:true`). Round-1 and round-2 were each 8P1 + 1P2 (N1 closed in round-2); round-3 resolves every threshold below.

## Round 3 — round-2 REMAIN resolved (FN1-FN9, precise thresholds)
- FN1 the reservation is PRE-CHECKED to fit (`spent + reserve <= cap`) before each launch (no overshoot); cumulative spend (tokens + USD) is persisted in the ledger and resumed, counting ALL attempts; every unit row is registered UPFRONT so an un-launched unit still reaches `aborted`.
- FN2 `readLedgerState` distinguishes MISSING (fresh) from CORRUPT/unreadable (throws — never re-spawns on unknown prior state; a directory at the path is corrupt); a prior still-LIVE `running` or a `delivery_uncertain` row is carried, not re-run; the register write is checked BEFORE any spawn (fail -> no launch).
- FN3 `nextReceipt` makes an ACCEPTED generation FINAL (never downgraded, even on a later not-all-terminal pass); interim ledger writes preserve the prior receipt (never clobber accepted with false).
- FN4 headless is the DEFAULT; `visible:true` is required for the temp-workspace chain; zone close moved to `finally` (exception-safe, canReapZone-guarded); a failed close writes a durable `cleanup-pending.json` todo.
- FN5 `unit.key` is validated as a safe slug (the traversal can no longer move to the key).
- FN6 `parseDepth` rejects a present-but-invalid depth (NaN/negative/non-integer), never coerces to 0; the visible `unitCommand` carries `FANOUT_DEPTH` to the child, so both backends depth-cap.
- FN7 all ticket/ROI numbers must be FINITE (`Infinity`/`NaN` rejected).
- FN8 `classifyExit` is done ONLY on an explicit 0 exit WITH output; a launch failure is failed immediately (no timeout wait); an exception is failed; a visible unit with no `rc` evidence is timeout, never a fake done.
- FN9 after the bounded lease wait, a unit with NO lease is NOT launched (remaining units stay registered and reach `aborted`).

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
| `packages/bus/src/swarm/fanout.ts` | ~345 | 105 | pure governance (schema/width/tier/display/reduce/receipt/budget/sweep/zone/depth/classify/evidence/resume/abort/finiteness) |
| `packages/bus/src/swarm/fanout-herdr.ts` | ~80 | 23 | pure visible-chain builders/parsers + the unit command (tier-model + depth + F41 atomic + rc sidecar) |
| `packages/bus/src/swarm/fanout.selftest.mts` | ~270 | 105 | one named counterexample per pit + per round-1/2 finding |
| `packages/bus/src/swarm/fanout-herdr.selftest.mts` | ~60 | 23 | builders/parsers + the char-swallow + child-depth defenses |
| `scripts/swarm-fanout.ts` | ~255 | live | driver: single-flight + resume (corrupt-vs-missing), width-evidence, strict depth, upfront-register, reservation pre-check + durable spend, shared lease (no-lease-no-launch), both backends, classify, persist-then-receipt, finally cleanup |

## Gates
- bus tsc 0; scripts tsc 0; fanout selftest 105/105; fanout-herdr selftest 23/23; bus vitest 991/991 (unchanged — additive files).

## Self-flags (per the round-2 ruling)
- FN1 metering is a conservative per-launch RESERVATION (`FANOUT_UNIT_TOKEN_EST` + `FANOUT_UNIT_USD_EST`) — the reviewer accepted a conservative reserve for phase-1; it is now enforceable (pre-checked to fit, no overshoot) and durably cumulative across attempts. A real post-hoc token parse is a phase-2 refinement.
- FN9 shared lease is same-machine (file-per-unit under a global single-flight lock, stale-reaped) — the reviewer accepted the single-machine scope; cross-machine is out of scope.
