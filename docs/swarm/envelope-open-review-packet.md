# Review packet — envelope-open side (§2b OPEN, an R14 pre-flight, dual to BA9), ROUND 1

- **Branch** `feat/envelope-open`  **HEAD** `a39d129`  **Base** `main` (`3732f4b`)
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Design** `docs/swarm/envelope-open-design.md` @`41c48e4` (coordinator-dispatched to implement during the re-review wait)

## What this is
The post-CLAIM dual of BA9. BA9 supervises the board POST side (unclaimed posts); this wires the CLAIM side. When §2d-b admission GRANTS a claim it commits intent + attempt + a supervision wait, but it never opened a §2b delegation envelope (`buildGrantBodies` notes `openDelegation` is a separate batch). So a granted unit had no dual-custody production envelope to open / supervise before `SWARM_BOARD_ADMIT` can flip (R14). This opens it. DORMANT behind `SWARM_BOARD_ADMIT`; START stays A2 (opens + supervises, never executes).

## The chain (grant → open → receipt)
- OPEN: at grant, map the granted claim to an OpenSpec and `openDelegation` a PRODUCTION envelope + production-wait. requestId = the attemptId (stable ⇒ idempotent replay); payloadDigest = `digestOf({specDigest, inputBindingDigest})`; an INLINE immutable, reconstructable `payload` (jobId/nodeId/digests/planRevision — satisfies openDelegation's reconstructable-source rule d3ac478-P1-1); subject = job + planRevision; completionSlot from the node's first required output; owner = the granted member; acceptor = the granter (SELF).
- RECEIPT: the grant receipt notes the envelope requestId (= the attempt) so the member has its proof to open + produce.
- START: A2 — not wired here (same boundary #3 as the grant path). The member actually producing is gated separately.

## Supervision (reuse, not rebuild)
The envelope's own production-wait (emitted by `openDelegation`, `timeoutPolicy=escalate`) is committed to CONTROL; the existing sweep/observer already watches escalate-waits + scans completion slots. No new ladder — BA9 owns the post side, this production-wait owns the claim side.

## Shape + layering
- Pure `planGrantEnvelope` lives in a NEW `packages/bus/src/swarm/board-envelope.ts` — imports are downward only (`task-plan` type, `delegation-envelope` type, `digest`); it does NOT touch `task-board` or make `delegation-envelope` depend on the plan, so neither module is polluted.
- Thin IO in `scripts/swarm-dispatch.ts` (`openGrantEnvelope` in `runBoardConsumer`): `planGrantEnvelope` → `openDelegation` → commit the production-wait FIRST, then `writeDelegations`. Called in BOTH the grant and reconcile branches (idempotent on the attemptId), so a deferred open retries on the next reconcile.

## Key decisions / boundaries
1. Dormant: runs only inside the existing `boardAdmitEnabled()` guard; gate off ⇒ nothing (no CONTROL write, no registry write).
2. Wait-before-registry: the production-wait is committed to CONTROL BEFORE the registry is persisted, so the sweep never sees a persisted envelope with no wait. A deferred wait-commit (seq conflict) returns without persisting ⇒ the next reconcile retries.
3. Corrupt registry ⇒ SKIP (never overwrite): `readDelegations` returns empty on ENOENT (first envelope) but THROWS on a malformed registry; the catch skips the open (never clobbers existing envelopes), retried next reconcile.
4. Idempotent: requestId = attemptId. A re-grant/reconcile replay with the same payload re-opens nothing (no new wait); a same-attemptId DIFFERENT payload is an `openDelegation` CONFLICT (rejected, logged).
5. `targetDigest = specDigest`: the real artifact digest is unknowable at grant (START=A2). specDigest is a deterministic grant-time anchor that FAILS SAFE under `observeCandidate` (a mismatch only REJECTS a candidate, never falsely accepts); A2's production reconciles the real digest. A node with no required output ⇒ no completionSlot ⇒ `planGrantEnvelope` returns null (no envelope).
6. No execution (boundary #3): no `startTask`/V8. Best-effort + per-claim isolated (an open failure logs; the grant + receipt still stand).

## Files + tests
| Module | ~lines | Tests | Purpose |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/board-envelope.ts` | +40 | 8 | pure `planGrantEnvelope` (granted claim → OpenSpec; null when no output/absent node) |
| `scripts/swarm-dispatch.ts` | +25 | live | `openGrantEnvelope` wiring (grant + reconcile; wait-first, registry-skip-on-corrupt, receipt note) |
| `packages/bus/test/board-envelope.test.ts` | +70 | 8 | identity mapping, locator fallback, null cases, determinism, digest binding, end-to-end open (idempotent replay + conflict via the real `openDelegation`) |

## Gates
- bus tsc 0; scripts tsc 0; board-envelope test 8 (new); bus vitest 1132/1132.

## Counterexamples the tests lock
- requestId=attemptId, subject={job,revision}, owner, completionSlot from the required output, deadline = now + estimatedRuntimeSec; payloadDigest is a sha256 bound to BOTH specDigest and inputBindingDigest (input drift changes it).
- a node with no required output / absent from the plan ⇒ null; a pathHint-less output falls back to logicalName.
- end-to-end: the spec opens a production envelope + wait; a replay (same requestId+payload) emits NO new wait (idempotent); a same-requestId different-payload is rejected (conflict).

## Open self-flags (reviewer please rule)
- A granted unit now has TWO waits: the §2d-b board-exec supervision wait (`board-exec:<attemptId>`) + the §2b production-wait (`deleg-<attemptId>-prod`). Intentional (grant supervision vs delegation production custody) but redundant-looking — confirm the dual is wanted, or fold.
- A deferred open (seq conflict / unreadable registry) retries only via the reconcile path; if the claim is marked `granted` before a later reconcile fires, the retry window is the reconcile re-entry. Acceptable for a DORMANT A2 pre-flight; flag if a stronger guarantee is wanted.
