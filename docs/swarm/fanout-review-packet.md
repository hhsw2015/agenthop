# Review packet — fanout-native phase-1 (sovereign self-built backend), ROUND 10

- **Branch** `feat/fanout-native`  **HEAD** `9dde6ef`  **Base** `c3439cd`  (r1 `ff16594`, r2 `c55f9e5`, r3 `64bfb17`, r4 `b7b5fd9`, r5 `5e58b48`, r6 `9c15c20`, r7 `6a2380b`, r8 `0111607`, r9 `8401017`)

## Round 10 — round-9 REMAIN resolved (FN9; the headless rollback branch)
- FN9 (P2) round-9's headless rollback despawned the child, IGNORED the result, then deleted the lease unconditionally — a despawn that kept failing (child alive) freed the slot → over-admission. Now the childPid write is RETRIED (a transient glitch clears, keeping the launch tracked and proceeding normally); only if it persistently fails does the undo run, and it despawns + VERIFIES the pid is dead (bounded loop) before releasing. A child that survives despawn HOLDS the lease (never deleted under a live execution) and hands back loudly — capacity is never freed while the child runs. (Visible bind-save-fail stays stopped pre-launch from r9.)
- Gates: bus tsc 0, scripts tsc 0, fanout selftest 142, fanout-herdr selftest 23, bus vitest 991/991.

## Round 9 — round-8 REMAIN resolved (FN9; a failed lease-identity write stops the launch)

## Round 9 — round-8 REMAIN resolved (FN9; a failed lease-identity write stops the launch)
- FN9 (P2) `bindLeaseZone`/`bindLeaseChild` ignored `writeJsonAtomic`'s result, so a lease-identity write failure left a BARE driver-pid lease while the task still launched — another run then reaped that slot on driver death (child/pane still running) → over-admission. Both now RETURN the write result and the launch is GATED on it: visible — `bindLeaseZone` runs BEFORE the pane-run, a failed write releases the lease, fails the unit, and skips the launch (nothing spawned); headless — `bindLeaseChild` runs post-spawn (the pid is only known then), a failed write UNDOES the launch (despawn the child, fail the unit, release the lease) so no executed slot ever outlives its durable binding.
- Gates: bus tsc 0, scripts tsc 0, fanout selftest 142, fanout-herdr selftest 23, bus vitest 991/991.

## Round 8 — round-7 REMAIN resolved (FN9; positive terminal evidence, not todo-absence)

## Round 8 — round-7 REMAIN resolved (FN9; positive terminal evidence, not todo-absence)
- FN9 (P2) round-7 treated a MISSING cleanup-pending todo as "zone closed", so when the todo WRITE itself failed (unwritable dir) a close-failed visible slot was still reaped on driver death — over-admission with no terminal evidence. A missing / write-failed / not-yet-written todo is UNKNOWN, never proof the zone ended. `leaseOccupied` now frees a visible slot ONLY on POSITIVE evidence: THIS launch's rc sidecar exists (the command actually exited). Driver death and todo state are irrelevant to the decision. The lease records its rc path (`bindLeaseZone(zoneId, rcPath)`); an explicit CLOSE fact still frees it out-of-band (settleUnit on rc / the outer finally on a confirmed close / a future zone-reaper removes the lease), so `acquireLease` auto-reaps only on the rc fact. A stuck command with no rc holds its slot until an explicit reap — never freed by bookkeeping that may have failed. `leaseOccupied` is pure + tested (the visible cases now assert driver-death-with-no-rc stays occupied).
- Gates: bus tsc 0, scripts tsc 0, fanout selftest 142 (`leaseOccupied` rcPresent), fanout-herdr selftest 23, bus vitest 991/991.
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Contract pointers**: design `docs/swarm/fanout-native-design.md` @`fc799d9` + pre-study `docs/swarm/fanout-prestudy.md` @`cd42840`, both on branch `feat/fanout-native-design`.

## What this is
Phase-1 of fan-out nativization: the SOVEREIGN self-built backend a long-lived member wields as a stateless sub-tool. A pure governance core (`fanout.ts`) + a visible-chain pure layer (`fanout-herdr.ts`) + a thin IO driver (`swarm-fanout.ts`) that composes the AS-IS spawn stack, single-flight, and the herdr CLI. DORMANT behind `SWARM_FANOUT`. Headless is the DEFAULT; the temp-workspace visible chain is an explicit opt-in (`visible:true`). Round-1 and round-2 were each 8P1 + 1P2 (N1 closed in round-2); round-3 resolves every threshold below.

## Round 7 — round-6 REMAIN resolved (FN2/FN9; the SETTLE path + visible-lease-across-driver-exit)
- FN2 (P1) round-6 bound the RESUME path (`reconcileRunning`) to launchId, but the LIVE settle path (`settleUnit`) still matched the registry by `launchId === row.id || r.pid === row.pid`. `readRegistry` has NO ordering, so an old launch that reused this pid and exited 0 could be found FIRST and confirm a still-running new task (done/accepted) + despawn it. A new shared `exitForLaunch(home, launchId)` matches by launchId ONLY and is now used by BOTH settle entries (settleUnit + reconcileRunning) — a pid never confirms a launch. A dead pid with no THIS-launch exit falls to `classifyExit(null)` = failed (never a false done).
- FN9 (P2) a visible lease was bound only to the DRIVER pid, so `acquireLease` reaped its slot on driver death — a close-failed zone (no rc, wait + close both failed) lost its slot across a driver restart (over-admission). A visible lease now records its `zoneId` (`bindLeaseZone`); the pure `leaseOccupied(rec, probe)` decides a slot frees ONLY on a confirmed terminal: headless -> child alive; visible -> driver alive OR the zone still open (its cleanup-pending todo exists). Driver death alone NEVER frees a visible slot; it is reclaimed only once the zone is confirmed gone (the close fact removes the cleanup-pending todo). `leaseOccupied` is pure + tested (8 cases).
- Boundary: a HARD crash before the outer finally writes the cleanup-pending todo leaves a zoneId lease with no todo ⇒ reaped on driver death (the only remaining driver-death path). This is the orphan-recovery class (same family as the headless orphan sweep), not the close-FAIL path the finding targets — flagged, not silently closed. FN4's cleanup-pending semantics are unchanged (not reopened).
- Gates: bus tsc 0, scripts tsc 0, fanout selftest 141 (+8 `leaseOccupied`), fanout-herdr selftest 23, bus vitest 991/991.

## Round 6 — round-5 REMAIN resolved (FN2/FN9; identity-binding + visible-capacity)
- FN2 (P1) terminal evidence is now bound to the SAME launch by `launchId` ONLY. `reconcileRunning`'s registry lookup no longer falls back to `r.pid === pr.pid` — a pid is recyclable, so another launch that reused this pid and exited 0 could be read as this row's result (false `done`). No `launchId` (or none matches) -> no registry evidence; fall to the launch-bound rc sidecar (its path is unique per launch, FN8), else `uncertain`. The spend check is now the pure `validSpent`: a PRESENT cumulative spend must be a plain object with BOTH `tokens` and `usd` finite + non-negative — an array, `{}`, a partial object (one field missing), or a non-finite/negative value REFUSES the launch instead of being read through `?? 0` as a silent zero (which would corrupt the reservation math).
- FN9 (P2) a VISIBLE unit has no pid, so "no pid" no longer means "released". `settleUnit` frees a visible slot only once its rc sidecar proves the command EXITED; a unit still without rc (timeout / pane still running) is retained. The run's outer finally then releases any still-held visible lease ONLY after a CONFIRMED zone close — a failed close RETAINS the lease (capacity obligation; it is driver-pid-bound, so `acquireLease` reaps it when this driver exits) rather than freeing a slot whose pane may still run. (Headless unchanged: release on confirmed child-exit.)
- Gates: bus tsc 0, scripts tsc 0, fanout selftest 133 (+9 `validSpent`), fanout-herdr selftest 23, bus vitest 991/991.

## Round 5 — round-4 REMAIN resolved (FN2/FN8/FN9; the last crash/failure-recovery seams)
- FN2 (P1) a prior RUNNING row is UNKNOWN after a crash, so resume RECONCILES it from real evidence before deciding — never blind re-run (a double-spend of a launch that may have completed or still be live). New PURE `resumeVerdict(ev)` is the only safe mapping: live pid -> `alive` (carry); explicit 0 exit WITH output -> `done` (reuse); confirmed non-zero / no output -> `failed-terminal` (safe retry); pid gone AND no terminal record -> `uncertain` (quarantine, NEVER re-run). The driver gathers evidence (live pid, headless registry exit, visible `rc` sidecar, output presence) and maps through it. `readLedgerState` now also validates EACH inner row (object with a string `key` and a known `status`; a present `pid` must be a number) AND the cumulative spend (`tokens`/`usd` finite and non-negative) — an illegal row status or a negative/NaN spend REFUSES the launch instead of flowing into resume/reservation math.
- FN8 (P1) each launch writes to a UNIQUE per-launch evidence path (`<key>.<ts>-<rand>.out` + its `rc`), so an old attempt's `rc`/output can never share the path — success is bound to THIS launch BY CONSTRUCTION. The fragile stale-file delete (whose `EACCES` failure could pass off old evidence) is removed entirely; there is nothing stale to clear.
- FN9 (P2) a child's capacity is freed ONLY once it is confirmed gone. On timeout the driver despawns, then releases the lease only if the child pid is no longer alive; a failed/unconfirmed despawn KEEPS the lease bound to the child pid (`acquireLease` reaps that slot when the child actually dies) rather than freeing capacity while the child still runs. Applied in BOTH `settleUnit`'s finally and the run's outer finally (despawn-then-confirm-then-release, never release-first).
- Gates: bus tsc 0, scripts tsc 0, fanout selftest ALL pass (+7 `resumeVerdict` cases), fanout-herdr selftest 23, bus vitest 991/991.

## Round 4 — round-3 REMAIN resolved (cross-attempt seams; FN6/N1 were closed in r3)
- FN1 `reserveValid` refuses a capped domain with no positive estimate and rejects negative/NaN reserves; `reservationFits` replaces the `>=` pre-check (exactly-equal admitted, over rejected); USD is metered (no more zero/negative charge).
- FN2 `readLedgerState` validates SHAPE + IDENTITY (`null`/`{}`/array/foreign `runKey` -> throw, never a fresh run); `markAborted` aborts ONLY a never-launched (no-pid) row, so an in-flight live-pid carry is left running (not re-run); a headless spawn that returns ok-but-no-pid is `delivery_uncertain` (quarantined, never re-run).
- FN3 an already-ACCEPTED run short-circuits at entry (its results + receipt are immutable — no same-generation overwrite).
- FN4 the cleanup todo is per-ZONE (`cleanup-pending/<zoneId>.json`, never overwrites another leaked zone); a todo-write failure logs an explicit hand-back (never silent).
- FN5 duplicate unit keys are rejected case-INSENSITIVELY (a case-folding volume maps `item`/`ITEM` to one file).
- FN7 `validBudgetTicket` validates EVERY provided cap (a non-finite `maxTokens` is not excused by a valid `maxUsd`).
- FN8 a unit's stale `output`/`rc` are cleared at launch, so an old `rc=0` cannot impersonate this attempt.
- FN9 the lease binds the detached CHILD pid; a slot is held until the child's terminal state, even if the driver died.

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
| `packages/bus/src/swarm/fanout.ts` | ~375 | 117 | pure governance (schema/width/tier/display/reduce/receipt/budget/sweep/zone/depth/classify/evidence/resume/abort/finiteness) |
| `packages/bus/src/swarm/fanout-herdr.ts` | ~80 | 23 | pure visible-chain builders/parsers + the unit command (tier-model + depth + F41 atomic + rc sidecar) |
| `packages/bus/src/swarm/fanout.selftest.mts` | ~300 | 117 | one named counterexample per pit + per round-1/2 finding |
| `packages/bus/src/swarm/fanout-herdr.selftest.mts` | ~60 | 23 | builders/parsers + the char-swallow + child-depth defenses |
| `scripts/swarm-fanout.ts` | ~255 | live | driver: single-flight + resume (corrupt-vs-missing), width-evidence, strict depth, upfront-register, reservation pre-check + durable spend, shared lease (no-lease-no-launch), both backends, classify, persist-then-receipt, finally cleanup |

## Gates
- bus tsc 0; scripts tsc 0; fanout selftest 117/117; fanout-herdr selftest 23/23; bus vitest 991/991 (unchanged — additive files).

## Self-flags (per the round-2 ruling)
- FN1 metering is a conservative per-launch RESERVATION (`FANOUT_UNIT_TOKEN_EST` + `FANOUT_UNIT_USD_EST`) — the reviewer accepted a conservative reserve for phase-1; it is now enforceable (pre-checked to fit, no overshoot) and durably cumulative across attempts. A real post-hoc token parse is a phase-2 refinement.
- FN9 shared lease is same-machine (file-per-unit under a global single-flight lock, stale-reaped) — the reviewer accepted the single-machine scope; cross-machine is out of scope.
