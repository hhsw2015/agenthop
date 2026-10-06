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

---

# v2 (round 2) — fixes for codex review of 3fda743 (6P1 + 3P2)

**Code frozen at** `fcb8834` (base `main=b5fde65`, branch `feat/board-admission`). Prior round `3fda743`.
**Verdict addressed:** BA1-BA8 FIXED; BA9 DEFERRED under coordinator ruling **#R14**.
Gates: bus tsc 0, dispatch tsc 0, projection tsc 0, **962/962** vitest green.

## Board key v2 (BA4) — ON-DISK CONVENTION CHANGE, since 3fda743
Board item id is now JOB-NAMESPACED: `itemId = <jobId>__<nodeId>` (was bare `<nodeId>`). Two jobs' same nodeId no longer
collide on the one shared board dir, and a producer can tell its own posts from another job's. `__` is dot/slash/whitespace-
free (survives isValidItemId + the `.`-separated file-name convention). All three board parsers already tolerate it; dormant
⇒ no live files to migrate. (Coordinator-approved: "改约窗口就是现在".)

## Per-finding
- **BA1** (plan not from CONTROL): `planClaimAdmission` and `runBoardProducer` resolve the plan via `currentPlan(state, jobId)`
  (the liveness-review canonical). Missing PlanPut ⇒ DEFER (consumer) / fall back to startup only pre-PlanPut (producer).
- **BA2** (claim body unvalidated): new `parseClaimApplication` narrows the untrusted body; the decider validates
  jobId/nodeId/specDigest/inputBindingDigest against the current plan (drift ⇒ reject) and rejects any `requiresApproval`
  claim (no node-level approval source exists in TaskSpec; board admission does not auto-satisfy an approval gate in v1 —
  future follow-up if the plan model adds one). The consumer rejects an unreadable/malformed body.
- **BA3** (global sched input): attempts/accepted/usage are filtered to the claim's OWN job (`a.jobId === jobId`) before
  readyTasks/prepareDispatch, so a grant can never retire or budget-charge another job.
- **BA4** (cross-job reap + nodeId collision): job-namespaced keys + `planBoardWrites` scoped to `<jobId>__` prefix; another
  job's entries are never posted-over or reaped.
- **BA5** (receipt loss): `deliverGrantAndMark` writes the receipt FIRST and marks the item `granted` only on success; a
  failed receipt keeps the claim; reconcile re-delivers then marks. At-least-once (benign duplicate possible).
- **BA6** (no capacity check): the consumer computes `freeSlots = CAP - physicalSlotsOccupied(state)` (global VM pool, shared
  with the push path) and the decider DEFERS a grant when it is 0; recomputed per claim from the reloaded state.
- **BA7** (historical owner): reconcile-vs-reject follows the CURRENT-generation LIVE (non-terminal) attempt's supervision-wait
  owner, not the first historical grant.
- **BA8** (terminal/stale blocks repost): a terminal `rejected` file no longer blocks a READY node (re-post + clear it); a
  stale-revision `posted` file (digest drifted) is reaped + re-posted fresh.
- **BA9** (posted-but-unclaimed supervision): DEFERRED — coordinator ruling **#R14**. Same seam-class as envelope-open and
  §2d-c ping; it couples the producer into CONTROL-commit lifecycle. **Hard precondition before SWARM_BOARD_ADMIT is ever
  flipped on.** Tracked in the todo pool as "§2d-a posted supervision (claim deadline + sweep escalate)".

## New / changed tests (real control engine)
`parseClaimApplication` (valid/malformed/approval); planClaimAdmission: BA1 defer, BA2 spec-drift + input-drift + approval
reject, BA6 capacity defer, BA7 two-generation owner, BA3 cross-job non-interference; planBoardWrites: BA8a terminal-no-block,
BA8b stale-refresh, BA4 other-job-untouched. 22 board tests; 962/962 suite.

## Still out of scope (recorded)
A2 execution + gate flip; §2b envelope-open; §2d-c ping; **BA9 posted-supervision (R14, pre-flip blocker)**.

---

# v3 (round 3) — fixes for codex re-review of fcb8834 (2P1 + 1P2 residual)

**Code frozen at** `b32b25e` (base `main=b5fde65`, branch `feat/board-admission`). Prior rounds `3fda743` → `fcb8834`.
**Verdict addressed:** BA2, BA4, BA8 residual sub-cases FIXED. BA1/BA3/BA5/BA6/BA7 remain CLOSED; BA9 deferred (#R14).
Gates: bus tsc 0, dispatch tsc 0, projection tsc 0, **966/966** vitest + projection selftest green.

## Board key v3 (BA4) — ON-DISK CONVENTION CHANGE, since fcb8834
`boardItemId` is now LENGTH-PREFIXED and injective: `<len(jobId)>-<jobId>-<nodeId>` (was v2 `<jobId>__<nodeId>`). The v2
`__` form was not prefix-injective — `A/B__C` and `A__B/C` both mapped to `A__B__C`. The length prefix makes the mapping
injective over the allowed id domain, so two different (job,node) pairs never collide on the shared board. Ownership is judged
from the item BODY jobId + a filename↔body binding, never a string prefix. Still dormant ⇒ no live files to migrate.

## Per-finding (residual)
- **BA2a** (path traversal via untrusted jobId): `parseClaimApplication` now rejects a jobId/nodeId that is not a path-safe
  identifier (reuses isValidItemId: no `.`/`/`/whitespace), so `../../victim` is dropped before the consumer builds any path
  from it. `jobStartSec` additionally encodes a separator-bearing jobId to a single safe segment (defense-in-depth;
  backward-compatible for plain identifiers).
- **BA2b** (filename not bound to body): the consumer rejects a claim whose file name itemId ≠ `boardItemId(body.jobId,
  body.nodeId)` — an "A-named file, B-body" claim can no longer be granted/renamed under A's key.
- **BA2c** (reconcile skips input check): a same-owner reconcile now also requires the claim's inputBindingDigest to match the
  LIVE attempt's inputBindingDigest; a different input is rejected (not replayed as a recovery).
- **BA4** (key not injective + prefix ownership): injective length-prefixed key + ownership-by-body + filename↔body binding in
  `planBoardWrites`; a sibling job (`A__B`) is neither collided-with nor reaped by job `A`.
- **BA8a** (refresh writes-then-deletes): a stale-revision posted file is OVERWRITTEN in place (post only, no same-path reap);
  the producer also reaps-before-posts (robust ordering).
- **BA8b** (revoked grant blocks forever): a granted/rejected file for a node that is READY again is stale (ready ⟹ no live
  attempt ⟹ the grant was revoked) ⇒ it is reaped and the fresh READY identity re-posted, while a truly-live grant (node not
  ready) is untouched.

## New / changed tests
`parseClaimApplication` BA2a path-safety; boardItemId injectivity (BA4); planBoardWrites BA8a overwrite-no-reap, BA8b
granted-stale-reap, BA4 body-ownership + sibling-job, name↔body mismatch left-alone; planClaimAdmission BA2c reconcile input
identity. 26 board tests; 966/966 suite. (BA2b filename↔body binding + BA8a reap-before-post ordering are in the shell
runBoardConsumer/runBoardProducer — AST-checkable.)

## Still out of scope (recorded)
A2 execution + gate flip; §2b envelope-open; §2d-c ping; **BA9 posted-supervision (#R14, pre-flip blocker)**.

---

# v4 (round 4) — fix for codex re-review of b32b25e (1P1 residual: BA4 fs-alias)

**Code frozen at** `08f9d54` (base `main=b5fde65`, branch `feat/board-admission`). Prior: `3fda743`→`fcb8834`→`b32b25e`.
**Verdict addressed:** BA4 native-filesystem aliasing FIXED. BA1/BA2/BA3/BA5/BA6/BA7/BA8 remain CLOSED; BA9 deferred (#R14).
Gates: bus tsc 0, dispatch tsc 0, projection tsc 0, **966/966** vitest + projection selftest green.

## Board key v4 (BA4) — ON-DISK CONVENTION CHANGE, since b32b25e
`boardItemId` is now `<hex(utf8(jobId))>-<hex(utf8(nodeId))>`. The v3 length-prefix key was string-injective but embedded
raw jobId/nodeId, so a case-insensitive / Unicode-normalizing filesystem (default macOS APFS) folded distinct string keys
onto one file — jobs `A` vs `a`, or NFC `é` vs NFD `é`, overwrote each other (reviewer reproduced on this machine:
`st_dev` 16777242). Lowercase hex is single-case, pure-ASCII and normalization-stable, so **string-equality ⟺ on-disk
equality**; `-` stays unambiguous (hex has no `-`) so the encoding is injective. Ownership + filename↔body checks are
unchanged — they recompute `boardItemId`, now filesystem-accurate. Still dormant ⇒ no live files to migrate.

Note (cosmetic, non-blocking): board FILE names are now hex; the item body still carries readable jobId/nodeId, and the
projection/kanban views read the body. A follow-up could show `body.nodeId` instead of the hex itemId in the viz.

## New / changed test
`boardItemId` injectivity + FILESYSTEM-SAFETY: keys stay distinct after NFC-normalize + lowercase folding (jobs A/a; NFC é
vs NFD é) and are single-case ASCII hex. 26 board tests; 966/966 suite; projection selftest (86 checks) green.

## Still out of scope (recorded)
A2 execution + gate flip; §2b envelope-open; §2d-c ping; **BA9 posted-supervision (#R14, pre-flip blocker)**.

---

# v5 (round 5) — fix for codex re-review of 08f9d54 (0P1 + 1P2: BA4 encoding boundary)

**Code frozen at** `facfaf2` (base `main=b5fde65`, branch `feat/board-admission`). Prior: `3fda743`→`fcb8834`→`b32b25e`→`08f9d54`.
**Verdict addressed:** BA4 encoding input-domain / filename-length (P2, 2 sub-cases) FIXED. BA4 P1 + BA1/2/3/5/6/7/8 stay
CLOSED; BA9 deferred (#R14). Gates: bus tsc 0, dispatch tsc 0, projection tsc 0, **967/967** vitest + projection selftest.

## Board key v5 (BA4/P2) — ON-DISK CONVENTION CHANGE, since 08f9d54
`boardItemId` is now the SHA-256 hex of a length-prefixed `<len(jobId)>-<jobId>-<nodeId>` preimage — a CONSTANT 64 lowercase
hex chars. Replaces the v4 variable-length `hex(jobId)-hex(nodeId)`.

- **BA4/P2b (filename length / ENAMETOOLONG)**: the v4 hex key grew with the identity, so a 36-char UUID job + 67-char node +
  UUID claimant produced a 257-byte `<key>.claimed.<who>.json` that failed atomic rename (NAME_MAX 255) — an item the
  producer published but no normal member could claim. The bounded 64-char key keeps the full state file name well under
  NAME_MAX for any identity length + a normal member id (test: 36-char job + 67-char node + 36-char who ⇒ ≤255).
- **BA4/P2a (ill-formed UTF-16)**: identity components must be well-formed UTF-8 (`isValidIdComponent` = isValidItemId AND a
  UTF-8 round-trip). A lone surrogate (U+D800) folds to U+FFFD under the encoder and would alias a distinct accepted identity;
  it is now rejected at BOTH board entries — `parseClaimApplication` (consumer) and `boardItemsToPost` (producer skips the
  node, or the whole job if its id is ill-formed). The genuine replacement char U+FFFD is well-formed ⇒ still allowed.

The v4 filesystem-injectivity (BA4 P1: `A` vs `a`, NFC vs NFD) is preserved — the length-prefixed preimage is injective over
well-formed ids, SHA-256 keeps it collision-free, lowercase hex stays single-case ASCII. Ownership + filename↔body checks are
unchanged (recompute `boardItemId`).

## New / changed tests
boardItemId: 64-hex bounded key (long identity ⇒ still 64; claimed filename for UUID-job/67-node/UUID-who ≤255 bytes) +
NFC/NFD + case-fold distinctness. parseClaimApplication: lone-surrogate jobId/nodeId rejected, genuine U+FFFD allowed. 27
board tests; 967/967 suite; projection selftest green.

## Still out of scope (recorded)
A2 execution + gate flip; §2b envelope-open; §2d-c ping; **BA9 posted-supervision (#R14, pre-flip blocker)**. Hex filenames
remain a non-blocking cosmetic (body carries readable jobId/nodeId; viz follow-up).

---

# FINAL — review CLEARED (codex seat 01a0ead5, 2026-10-06)

**0 REMAIN at `facfaf2`** (docs `2d4b0f9`, base `main=b5fde65`, branch `feat/board-admission`).
BA1-BA8 all closed across 5 review rounds (3fda743 → fcb8834 → b32b25e → 08f9d54 → facfaf2). BA9 (posted-item
supervision) explicitly DEFERRED under coordinator ruling **#R14** — a HARD precondition before `SWARM_BOARD_ADMIT` is ever
flipped on, alongside §2b envelope-open and §2d-c R8-idle ping. **0 REMAIN does NOT lift the BA9/#R14 pre-flip blocker.**
Gates: bus/dispatch/projection tsc 0; 967/967 vitest; projection selftest (86 checks); no source-hash drift.
Scope held throughout: gate default-off, grant-commit only in the gate-open branch, receipt triggers no execution (A2
separate). No merge/push/deploy performed — merge is the coordinator's per existing gates.
Reviewer report: `/Users/wowdd1/Work/review-reports/board-admission-codex-rereview-facfaf2.md`
(SHA-256 bf8add2682f906e9bc18ea9955272bc22a5969c411426f945a64dc9796ec9aff).
