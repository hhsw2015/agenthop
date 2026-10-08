// board-envelope — §2b OPEN side (an R14 pre-flight, dual to BA9's post-side supervision). Maps a GRANTED board claim to a
// delegation OpenSpec so the admission consumer can `openDelegation` a PRODUCTION envelope + production-wait for the granted
// work. PURE (no IO) — the dispatcher does the commit/persist. START stays A2: this only OPENS + supervises, never executes.
//
// Design: docs/swarm/envelope-open-design.md. The envelope's actual completion-discovery (observeCandidate's target-digest
// match) is A2, when real production is wired; at OPEN the slot anchors to the task-identity contract (specDigest) — a value
// known deterministically at grant that FAILS SAFE under the observer (a mismatch only REJECTS a candidate, never falsely
// accepts one), which A2 reconciles to the real artifact digest.
import { digestOf, canonicalJson } from "./digest.js";
import type { TaskPlan } from "./task-plan.js";
import type { OpenSpec } from "./delegation-envelope.js";

/** The committed GRANT identity the envelope opens over: the attempt + the task/input digests the admission validated. */
export type GrantedClaim = {
  jobId: string;
  nodeId: string;
  attemptId: string;        // = the envelope requestId (stable per attempt ⇒ a re-grant/reconcile replay is idempotent)
  specDigest: string;
  inputBindingDigest: string;
};

/** Map a granted claim → the OpenSpec `openDelegation` consumes. Returns null when the node has NO required output (nothing to
 *  produce ⇒ nothing to observe ⇒ no envelope) or is absent from the plan (defensive — the grant already validated presence).
 *  - requestId     = attemptId (stable identity; openDelegation is idempotent on the same (requestId, payloadDigest)).
 *  - payloadDigest = digest of {specDigest, inputBindingDigest} (verify-only; the task identity + frozen inputs).
 *  - payload       = an INLINE immutable, reconstructable source (jobId/nodeId/digests/planRevision) so the recovery loop can
 *                    rebuild the request from the durable record alone (openDelegation d3ac478-P1-1 requires this).
 *  - subject       = { jobId, revision = planRevision }.
 *  - completionSlot= the node's FIRST required output (locator = pathHint ?? logicalName, resultFormat = its kind), acceptor =
 *                    the granter, targetDigest = specDigest (the A2-reconciled, fail-safe contract anchor noted above).
 *  - owner         = the granted member (production owner); acceptor MUST differ (it closes the consumption wait). */
export function planGrantEnvelope(claim: GrantedClaim, plan: TaskPlan, nowSec: number, owner: string, acceptor: string): OpenSpec | null {
  const node = plan.nodes.find((n) => n.nodeId === claim.nodeId);
  if (node === undefined) return null;
  const out = node.outputContract.requiredOutputs[0];
  if (out === undefined) return null; // no required output ⇒ no completion slot ⇒ no envelope
  return {
    requestId: claim.attemptId,
    payloadDigest: digestOf({ specDigest: claim.specDigest, inputBindingDigest: claim.inputBindingDigest }),
    payload: canonicalJson({ jobId: claim.jobId, nodeId: claim.nodeId, specDigest: claim.specDigest, inputBindingDigest: claim.inputBindingDigest, planRevision: plan.planRevision }),
    subject: { jobId: claim.jobId, revision: plan.planRevision },
    completionSlot: { locator: out.pathHint ?? out.logicalName, targetDigest: claim.specDigest, resultFormat: out.kind, acceptor },
    owner,
    productionDeadlineSec: nowSec + node.estimatedRuntimeSec,
  };
}
