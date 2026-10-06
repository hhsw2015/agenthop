# Review packet — 5/n board admission (§2d "拉式领活" pull-based claiming)

**Branch** `feat/board-admission`  **HEAD** `3fda743`  **Base** `main=b5fde65`
**Reviewer** codex `01a0ead5` (cc coordinator `fe0376cd`)  **Author** bus-pen `d7f6c917`
**Spec** `docs/swarm/cluster-liveness-design.md` §2d (§2d-a board, §2d-b admission; §2d-c sweep adjacent, out of scope)

## What this is
The §2d pull path: a producer posts READY plan-nodes as claimable board items; a consumer RE-ADMITS each member
claim on the CURRENT CONTROL (a claim is a reservation application, not authority) and grants or rejects. The whole
chain is DORMANT behind `SWARM_BOARD_ADMIT` (default-off) — nothing in this batch flips it, and nothing here executes
work (A2 = startTask/V8 is a separate gate).

## 3 HARD boundaries (coordinator ruling) — all held
1. `SWARM_BOARD_ADMIT` defaults OFF; nothing flips it. `boardAdmitEnabled` = `/^(1|true|yes|on)$/i`. Unit-tested.
2. Grant-commit happens ONLY inside the gate-open branch: `runBoardConsumer` returns immediately on `!boardAdmitEnabled()`;
   the only admission `commitTask` is past that guard. Gate-off ⇒ no board writes, no CONTROL commit (dry).
3. Receipt triggers NO execution: `buildGrantBodies` emits intent+attempt(+retired)+wait only — never a startTask/exec
   body; `runBoardConsumer` never calls `startTask`; the receipt text explicitly says "DO NOT begin execution".

## Design decision (coordinator-ruled option B)
Grant = `prepareDispatch` (intent + new attempt + retired) + a BUSINESS_EXEC-style supervision wait (`openWait`,
`timeoutPolicy=escalate`, subject-anchored to the admitted attempt+binding) + a receipt. NOT the full §2b envelope
(`openDelegation`) — that open side is UNWIRED in production today (grep: zero callers), so opening a real envelope would
be the first opener and pulls in registry write + production-wait + completion-slot pre-register. **Deferred as a known
follow-up batch** (per herdr H-P2-7). §2b-b: 派发即登记 is satisfied by intent+binding OR a CONTROL wait — a grant commits
both, so the invariant holds.

## Pure / IO split (repo discipline)
- PURE (task-board.ts, unit-tested): `boardItemsToPost`, `planBoardWrites`, `buildGrantBodies`, `grantWaitId`,
  `planClaimAdmission` (the admission DECISION: grant|reject|reconcile), file-name convention + `parseBoardItemName`,
  `isValidItemId`, `boardAdmitEnabled`.
- IO shell (scripts/swarm-dispatch.ts, thin): `runBoardProducer` (atomic write/unlink), `runBoardConsumer`
  (loadControlLog → `planClaimAdmission` → commitTask + receipt + rename), `rejectClaim`.

## Key invariants
- **Single-active**: `prepareDispatch` enforces §3.1 node single-active. After a grant commits, the attempt is RUNNING
  ⇒ the node is no longer ready. A re-claim by the SAME member is an idempotent lost-rename ⇒ `reconcile` (fix board,
  no re-grant, `grantWaitId` stable per attempt); a DIFFERENT member lost the race ⇒ `reject` (owner on the grant's
  supervision wait distinguishes them).
- **Orphan / no 2nd ledger**: a grant whose `commitTask` fails leaves the claim file in place to be re-reviewed next
  tick. The board is an application-queue + fact-projection; authority is ONLY the CONTROL commit.
- **派发即登记**: every grant commits a supervision wait (never broken).
- **Budget basis**: admission's wall-clock usage uses `jobStartSec(plan.jobId)` — the same basis the push path
  (`taskPass`, swarm-dispatch.ts:607) passes as `planCommittedAtSec`, so pull and push agree.
- **Same-tick consistency**: `commitTask` → `commitControl` persists to disk, so a second claim's `loadControlLog`
  in the same tick sees the first grant.

## Projection / observer compatibility
- `projection.parseBoardFileName` now recognizes granted/rejected (was claimed/done only — would have mis-read
  `x.granted.who.json` as a phantom OPEN item with a long id). Kanban buckets granted→in-progress; rejected is a dead
  claim (not columned).
- `delegation-observer.parseBoardFile` is generic over the state token (verified) — flows granted/rejected through
  unchanged; doc comment updated.

## Verification
- bus tsc 0, dispatch tsc 0, projection tsc 0.
- 953/953 vitest (73 files) + projection selftest green. New: 4 `planClaimAdmission` integration tests on the REAL
  control-log engine (grant shape / not-in-plan reject / reconcile-vs-reject-by-owner) + 1 `buildGrantBodies` unit test.

## Files (vs main)
```
packages/bus/src/swarm/task-board.ts          +212   (schema + all pure deciders + planClaimAdmission)
packages/bus/test/swarm-task-board.test.ts    +167   (13 tests)
scripts/swarm-dispatch.ts                      +77    (runBoardProducer + runBoardConsumer + rejectClaim, gated)
scripts/projection.ts                          ±8     (granted/rejected parse + kanban bucket)
packages/bus/src/swarm/delegation-observer.ts  ±4     (doc comment)
```

## Out of scope (recorded follow-ups)
- A2: real dispatch/V8 execution + flipping `SWARM_BOARD_ADMIT` (separate gate).
- §2b envelope-open side (`openDelegation` wiring) — first-opener, its own batch.
- §2d-c sweep R8-idle member ping — adjacent, not this batch.

## doneLine / stopSet
Design + impl + test green + self-review DONE → this packet. STOP: no merge, no push, no deploy. Awaiting verdict.
