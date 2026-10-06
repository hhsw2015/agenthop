# 5/n board-admission — impl plan (UNCOMMITTED scratch)

Branch `feat/board-admission` (from main=b5fde65). Spec: `docs/swarm/cluster-liveness-design.md` §2d.
Full subsystem map: `/Users/wowdd1/Dev/agenthop/docs/swarm/board-admission-map.md` (file:lines there).

## Scope (coordinator ruling = (a), 3 HARD boundaries)
§2d-b admission chain is ONE unit, built in this batch: board producer + claim → prepareDispatch
admission on CURRENT CONTROL → grant (commit intent+binding+wait + receipt + board `granted`) /
reject (board `rejected` + reason) + orphan reaping. Execution chain (startTask/V8) + flipping the
gate = A2, a SEPARATE batch — NOT here.
1. `SWARM_BOARD_ADMIT` defaults OFF; nothing in this batch flips it on.
2. grant-commit happens ONLY inside the gate-open branch; gate-off ⇒ whole chain dry (no board
   writes, no CONTROL commit).
3. receipt triggers NO execution side-effect (pre-A2).
doneLine: design+impl+test green+self-review → review packet (fixed SHA to codex 01a0ead5, S12 cc
fe0376cd), then STOP. stopSet: no merge/push/deploy. exclusions: no console/voice/vm-ssh; A2 separate.

## OPEN DESIGN Q (routed to coordinator) — the grant's "信封 wait" (§2d-b "intent+binding+信封 wait")
FINDING: `openDelegation` (delegation-envelope.ts, the envelope OPEN side) is NOT called anywhere in production
(grep: zero callers) — only the CONSUME side (observeCandidate/scanCompletionSlots) is wired (swarm-dispatch.ts:800+).
So a grant that opens a real §2b envelope would be the FIRST envelope-opener (pulls in registry write +
production-wait + completion-slot pre-register + the dual-custody observer contract). §2b-b also says 派发即登记 is
satisfied by EITHER a CONTROL wait OR intent+binding. Three readings of the grant:
  (A) FULL §2b envelope: prepareDispatch(intent+binding) + openDelegation(envelope registry + production-wait +
      completion slot) + receipt. Most literal ("信封"); biggest; wires the envelope-open side for the first time.
  (B) LIGHT supervision wait: prepareDispatch(intent+binding) + an openWait BUSINESS_EXEC-style supervision wait +
      receipt. Faithful to "+wait", defers the unbuilt envelope-open.
  (C) intent+binding only (IS the 派发即登记 registration per §2b-b) + receipt; no separate wait.
LEAN: (B) for the dormant v1 — satisfies "intent+binding + a supervision wait + receipt" without wiring the whole
unbuilt §2b envelope-open side (that is its own batch). Awaiting coordinator ruling before implementing Inc 3's grant.

## DONE — ALL INCREMENTS COMPLETE (HEAD 3fda743, review packet sent)
- Increment 4 @3fda743 (+@a793744): §2d-b admission FINISH. `planClaimAdmission` (PURE decider in task-board.ts:
  plan+CONTROL+claim → grant|reject|reconcile; same-member lost-rename reconciles, different-member single-active-race
  rejects, via the grant wait owner). `runBoardConsumer` kept thin IO. projection.parseBoardFileName recognizes
  granted/rejected (was claimed/done → would mis-read as phantom open item); kanban buckets granted→in-progress.
  delegation-observer.parseBoardFile verified generic (comment updated). +4 integration tests on the real control engine.
- Increment 3 @0a82254: §2d-b admission CONSUMER. `buildGrantBodies`/`grantWaitId` (pure, option B: intent+attempt
  (+retired)+BUSINESS_EXEC supervision wait, NO startTask). `runBoardConsumer` (gated, per-claim fail-soft: grant commits
  via commitTask + receipt + rename claimed→granted; orphan = commit-fail leaves claim for re-review; no 2nd ledger).
- Increment 2 @cd5b87b: §2d-a producer — planBoardWrites (pure) + runBoardProducer (thin IO, gated, passTick). +3 tests.
- Increment 1 @7836d8b: `packages/bus/src/swarm/task-board.ts` (PURE) + `test/swarm-task-board.test.ts`:
  BoardItem schema; `boardItemsToPost` (ready nodes → items); canonical file-name convention +
  `parseBoardItemName` (posted/claimed/granted/rejected/done, explicit, unknown→null); `isValidItemId`;
  `boardAdmitEnabled` gate. bus tsc 0, 6 tests.
- GATES at HEAD: bus tsc 0, dispatch tsc 0, projection tsc 0, 953/953 vitest + projection selftest green.
- STOPSET honored: no merge/push/deploy; SWARM_BOARD_ADMIT still default-off (nothing flips it); A2 (startTask/V8) untouched.

## REMAINING increments (all gated on boardAdmitEnabled(); gate-off ⇒ step is a no-op)
- Inc 2 — PRODUCER IO (scripts/swarm-dispatch.ts, new gated step in `passTick` ~:1046, beside taskPass):
  build SchedInput like taskPass (loadControlLog → attempts/accepted → readyTasks) — mirror the exact
  readyTasks call in `packages/bus/src/swarm/task-pass.ts:190-243`; `boardItemsToPost` → for each item
  NOT already present (idempotent: skip if any of `<id>.json`/`.claimed.`/`.granted.`/`.done.` exists,
  or node has an active attempt), atomic temp+rename write to BOARD_DIR (`swarm-dispatch.ts:107`;
  reuse `atomicWrite` ~:155). Validate itemId via isValidItemId. mkdir BOARD_DIR lazily.
- Inc 3 — CONSUMER IO / admission (dispatch, new gated step): scan BOARD_DIR for `*.claimed.<who>.json`
  (parseBoardItemName); per claim, on CURRENT control: build ReadyTask for that node (readyTasks,
  confirm still ready) → `prepareDispatch` (`task-dispatch.ts:54`, enforces §3.1 node single-active
  :122-125) + budget/cap re-check (`task-pass.ts:194-224`). GRANT: commit intent+binding+wait EXACTLY
  as taskPass commits (`task-pass.ts:218-225`) but DO NOT call startTask (boundary #3); write receipt to
  the claimant's inbox (`writeInbox`); rename item → `granted`. REJECT (not ready / single-active loss /
  token-fit / budget): rename → `rejected` + reason (the board file content gets the reason). ORPHAN: a
  `*.claimed.*` whose commit failed/crashed or whose node is no longer admittable = powerless orphan →
  re-review next tick or expire (claim age); board is app-queue+projection, never a 2nd ledger.
- Inc 4 — projection compat + integration + close:
  - `scripts/projection.ts` `parseBoardFileName:356-364` must recognize `granted`/`rejected` (today only
    claimed/done; it would mis-read `x.granted.who` as open item `x.granted.who`). delegation-observer's
    `parseBoardFile` already generic (last-two-segments) — OK, verify.
  - Integration test: gate-OFF ⇒ dispatch writes nothing to board, commits nothing (dry). gate-ON ⇒
    produce ready nodes → simulate a claim rename → admit → assert grant commits intent+binding+wait +
    receipt + `granted` file (NO startTask side-effect); two claims same node → 2nd rejected
    (single-active); orphan claim → reaped. Use real control-store + task modules (like swarm-task-pass
    / swarm-task-sweep tests).
  - self-review → review packet (fixed SHA → codex 01a0ead5, S12 cc fe0376cd) → STOP, await verdict.

## Watch-outs (from the map)
- `priority` / `conflictsWith` have NO TaskSpec source — priority left absent (curator-supplied later);
  conflictsWith would derive from overlapping scopes (not needed for admission itself).
- Two legacy board parsers disagree on unknown states — align projection on granted/rejected (Inc 4).
- §2d-c (sweep R8-idle member ping) is ADJACENT and out of scope for this batch — note in review packet.
- "派发即登记" invariant: admission commits a wait for every grant (don't break it). admission = matching
  grant (task-wait.ts:193), not "no unresolved wait".
