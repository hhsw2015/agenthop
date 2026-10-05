/**
 * Pure derivations for §2c-b evidence-driven liveness renewal (two-clocks). A liveness/probe wait (owner-supervision, see
 * f32a0507's isRenewable) may have its PROBE deadline renewed — but ONLY by subject-matching PROGRESS evidence, and a
 * semantic deadline (retry/validation/query/physical) is never deferred. These helpers answer, from the AUTHORITATIVE
 * control-log alone (fe0376cd's ruling: derive, never a second durable account that could drift — F13 "state is evidence,
 * not belief"), the two facts the sweep compares: how far the subject has progressed, and when the wait was last armed.
 */
import type { CommittedBatch } from "./control-log.js";

/** The max control-log seq at which `jobId` made PROGRESS: a plan/attempt/accepted FOR the job (jobId carried directly), or an
 *  observed/intent on one of the job's attempts (linked via attemptId). WAIT changes are EXCLUDED entirely (incl renew /
 *  action_done / close) so a wait's own churn can never count as its subject's progress — that would loop renew→"progress"→
 *  renew (confirmed with f32a0507, §2c-b v1). A forward scan is correct because an attempt is always committed before its
 *  observed/intent, so the job's attempt set is populated in time. Returns 0 when the job has no progress in the log. */
export function subjectProgressSeq(batches: readonly CommittedBatch[], jobId: string): number {
  const jobAttempts = new Set<string>();
  let max = 0;
  for (const batch of batches) {
    let hit = false;
    for (const c of batch.changes) {
      switch (c.put) {
        case "plan": if (c.plan.jobId === jobId) hit = true; break;
        case "attempt": if (c.attempt.jobId === jobId) { jobAttempts.add(c.attempt.attemptId); hit = true; } break;
        case "accepted": if (c.accepted.jobId === jobId) hit = true; break;
        case "observed": if (jobAttempts.has(c.observed.attemptId)) hit = true; break;
        case "intent": if (jobAttempts.has(c.intent.attemptId)) hit = true; break;
        // wait/validationRun/rejected/supersede/lifecycle/scan/tombstone: NOT subject progress for renewal (§2c-b v1)
      }
    }
    if (hit) max = batch.seq;
  }
  return max;
}

/** The max control-log seq at which wait `waitId` was ARMED — a `put wait` that left it in state 'open' (the create, a renew,
 *  or an action_done re-arm). An escalation step (begin_action → 'action_pending') or a close ('resolved') is NOT an arm, so
 *  it never advances this baseline. The sweep renews only when subjectProgressSeq > this (progress SINCE the last arm); after
 *  a renew, this advances past that progress, so the SAME evidence never renews twice (repeat = no-op). 0 ⇒ never armed. */
export function waitArmSeq(batches: readonly CommittedBatch[], waitId: string): number {
  let max = 0;
  for (const batch of batches) {
    for (const c of batch.changes) {
      if (c.put === "wait" && c.wait.waitId === waitId && c.wait.state === "open") { max = batch.seq; break; }
    }
  }
  return max;
}

/** Is there subject-matching progress evidence SINCE the wait was last armed? (The sweep's renew-vs-escalate test for a
 *  liveness wait: true ⇒ renew the probe deadline; false ⇒ no new evidence ⇒ let the escalation proceed. Repeat evidence is
 *  a no-op because a renew advances the arm seq past the progress that triggered it.) */
export function hasFreshSubjectEvidence(batches: readonly CommittedBatch[], jobId: string, waitId: string): boolean {
  return subjectProgressSeq(batches, jobId) > waitArmSeq(batches, waitId);
}
