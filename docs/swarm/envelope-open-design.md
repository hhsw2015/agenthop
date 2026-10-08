# Envelope-open side — design (§2b open chain, an R14 pre-flight; dual to BA9)

Problem: BA9 supervises the board-POST side (unclaimed posts). The post-CLAIM side is unwired — when admission GRANTS a board claim it commits intent + attempt + a supervision wait, but it does NOT open a delegation envelope (`buildGrantBodies` notes `openDelegation` is a separate batch). So a granted unit has no dual-custody envelope to open / ack / supervise before `SWARM_BOARD_ADMIT` can flip (R14).

## The chain (post-claim-grant: open → receipt → start)
- OPEN: at grant, open a PRODUCTION delegation envelope for the granted work via `openDelegation` — requestId = the attempt ID, payloadDigest = specDigest + inputBindingDigest, subject = the job + revision, owner = the granted member, completionSlot = the node's required output, productionDeadlineSec. Reuses openDelegation's contract: idempotent on the same (requestId, payloadDigest) (replay-safe), a same-ID different-payload is a CONFLICT (rejected, never overwritten).
- RECEIPT: the grant receipt to the member carries the envelope requestId + the payload locator (a reconstructable source) — the member's proof it may open and produce.
- START: A2 — this batch does NOT start execution (boundary #3, same as the grant path); the member actually opening + producing is gated separately.

## Supervision (dual of BA9; reuse, do not rebuild)
A granted-but-unproduced envelope past productionDeadlineSec escalates through the EXISTING production-wait that `openDelegation` emits (timeoutPolicy = escalate; the sentinel/sweep already watches escalate-waits). No new ladder — BA9 owns the post side, the production-wait owns the claim side.

## Shape
- Pure `planGrantEnvelope(grantedClaim, plan, nowSec, owner)` → OpenSpec (maps a granted claim to the open spec); `openDelegation` (exists) produces the envelope + production-wait.
- Thin wiring at the grant commit (the admission consumer): commit the production-wait FIRST, persist the registry, then the receipt carries the envelope reference. Dormant behind `SWARM_BOARD_ADMIT`; no CONTROL execution.
- selftest: planGrantEnvelope maps identity correctly; a re-grant is idempotent (no duplicate envelope); a same-ID different-payload conflict is rejected; gate-off writes nothing.

doneLine: design approved → implement + selftest + send-to-review + S26.
