/**
 * Pure derivations for §2c-b evidence-driven liveness renewal (two-clocks). A liveness/probe wait (owner-supervision, see
 * f32a0507's isRenewable) may have its PROBE deadline renewed — but ONLY by subject-matching PROGRESS evidence, and a
 * semantic deadline (retry/validation/query/physical) is never deferred. These helpers answer, from the AUTHORITATIVE
 * control-log alone (fe0376cd's ruling: derive, never a second durable account that could drift — F13 "state is evidence,
 * not belief"), the two facts the sweep compares: how far the subject has progressed, and when the wait was last armed.
 */
import type { CommittedBatch } from "./control-log.js";

/** What a wait's renewal is anchored to — the MOST SPECIFIC field present wins (review 4c617fa-E1). A wait that supervises one
 *  BINDING (bindingId set) renews ONLY on THAT binding's progress; one that supervises an ATTEMPT (attemptId, no bindingId)
 *  renews only on that attempt's; a job-level wait (neither) renews on any of the job's progress. A bindingId may be present
 *  WITHOUT attemptId (WaitSubject allows it) — it must still anchor to the binding, not degrade to job scope. */
export type ProgressSubject = { jobId: string; attemptId?: string; bindingId?: string };

/** The max control-log seq at which the SUBJECT made PROGRESS. BINDING-ANCHORED (bindingId set, MOST specific): ONLY that
 *  binding's own observed/intent count — a sibling binding of the SAME attempt can NOT renew it, and a bindingId-only subject
 *  must NOT degrade to job scope (review 4c617fa-E1). ATTEMPT-ANCHORED (attemptId, no bindingId): ONLY that attempt's own
 *  progress counts — its attempt/observed/intent/accepted — so a sibling attempt of the SAME job can NOT renew a wait anchored
 *  to a different attempt (review ab1bf81-P1#1). JOB-LEVEL (neither): a plan/attempt/accepted for the job, or an
 *  observed/intent on one of the job's attempts. WAIT changes are EXCLUDED entirely (incl renew/action_done/close) so a wait's
 *  own churn never counts as its subject's progress — that would loop renew→"progress"→renew (confirmed with f32a0507). Forward
 *  scan: an attempt is committed before its observed/intent, so the job's attempt set fills in time. 0 ⇒ no progress in the log. */
export function subjectProgressSeq(batches: readonly CommittedBatch[], subject: ProgressSubject): number {
  const { jobId, attemptId, bindingId } = subject;
  const jobAttempts = new Set<string>();
  let max = 0;
  for (const batch of batches) {
    let hit = false;
    for (const c of batch.changes) {
      if (bindingId !== undefined) {
        switch (c.put) { // binding-anchored (MOST specific): ONLY this binding's own progress — observed/intent carry bindingId.
          case "observed": if (c.observed.bindingId === bindingId) hit = true; break; // a sibling binding (b0) of the SAME attempt does NOT renew a wait anchored to b1 (review 4c617fa-E1)
          case "intent": if (c.intent.bindingId === bindingId) hit = true; break;
          // attempt/accepted/plan are above a binding — not this binding's own progress; a bindingId-only subject must NOT fall to job scope
        }
      } else if (attemptId !== undefined) {
        switch (c.put) { // attempt-anchored: ONLY this attempt's own progress (not plan/job-level, not a sibling attempt)
          case "attempt": if (c.attempt.attemptId === attemptId) hit = true; break;
          case "observed": if (c.observed.attemptId === attemptId) hit = true; break;
          case "intent": if (c.intent.attemptId === attemptId) hit = true; break;
          case "accepted": if (c.accepted.attemptId === attemptId) hit = true; break;
        }
      } else {
        switch (c.put) {
          case "plan": if (c.plan.jobId === jobId) hit = true; break;
          case "attempt": if (c.attempt.jobId === jobId) { jobAttempts.add(c.attempt.attemptId); hit = true; } break;
          case "accepted": if (c.accepted.jobId === jobId) hit = true; break;
          case "observed": if (jobAttempts.has(c.observed.attemptId)) hit = true; break;
          case "intent": if (jobAttempts.has(c.intent.attemptId)) hit = true; break;
          // wait/validationRun/rejected/supersede/lifecycle/scan/tombstone: NOT subject progress for renewal (§2c-b v1)
        }
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
export function hasFreshSubjectEvidence(batches: readonly CommittedBatch[], subject: ProgressSubject, waitId: string): boolean {
  return subjectProgressSeq(batches, subject) > waitArmSeq(batches, waitId);
}

/** The operationId the sweep stamps on an evidence renewal: distinguishable (carries the record, §2c-b acceptance ③) and
 *  idempotent by the triggering progress seq — the SAME progress yields the SAME id, so a re-attempted renew is a control-log
 *  replay no-op, and each distinct renewal is one countable id. (A later renew needs strictly newer progress — see waitArmSeq
 *  — so its seq, hence its id, differs.) */
export function renewOperationId(waitId: string, progressSeq: number): string {
  return `wait:${waitId}#renew@${progressSeq}`;
}

/** How many evidence RENEWALS this wait has had, derived from the authoritative log (no separate counter to drift — F13): the
 *  count of distinct renew-stamped operationIds for it. The sweep caps a NON-A1-approved wait at a finite number of free
 *  renewals (§2c-b: "不许无限 re-arm"); past the cap it escalates instead of renewing. Create / action_done re-arms are NOT
 *  renewals (they carry their own ids), so they never consume the free-renewal budget. The change must be a put-wait for THIS
 *  EXACT waitId — not merely an operationId with this prefix: another wait whose id happens to start with `<waitId>#renew@`
 *  would otherwise burn this wait's quota (review ab1bf81-E3). */
export function renewalCount(batches: readonly CommittedBatch[], waitId: string): number {
  const prefix = `wait:${waitId}#renew@`;
  const seen = new Set<string>();
  for (const batch of batches) for (const c of batch.changes) {
    if (c.put !== "wait" || c.wait.waitId !== waitId) continue;        // a put-wait for THIS exact wait (not a sibling whose id starts with it)
    if (c.operationId.startsWith(prefix)) seen.add(c.operationId);     // ...stamped as one of its renewals
  }
  return seen.size;
}
