/**
 * Pure derivations for §2c-b evidence-driven liveness renewal (two-clocks). A liveness/probe wait (owner-supervision, see
 * f32a0507's isRenewable) may have its PROBE deadline renewed — but ONLY by subject-matching PROGRESS evidence, and a
 * semantic deadline (retry/validation/query/physical) is never deferred. These helpers answer, from the AUTHORITATIVE
 * control-log alone (fe0376cd's ruling: derive, never a second durable account that could drift — F13 "state is evidence,
 * not belief"), the two facts the sweep compares: how far the subject has progressed, and when the wait was last armed.
 */
import { liveEntities, type Change, type ChangeBody, type CommitResult, type CommittedBatch, type LogState } from "./control-log.js";
import { advanceWait, isRenewable } from "./task-wait.js";

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

/**
 * DISP1-1 (codex:Work): the §2c-b renewal pass itself, extracted from the dispatcher's main() closure so the REAL fault paths
 * are offline-testable against a real control-store (not just an orchestration stub). Renew every EXPIRED open renewable
 * liveness wait that has FRESH subject evidence, BEFORE the expiry sweep escalates it. The two control reads are ATOMIC and
 * fail-soft: a fault in EITHER (`loadState` returns null, or `readBatches` throws) aborts the WHOLE pass and returns
 * `{ ok: false }` — a HALF-read is UNKNOWN, never a partial renewal. The caller skips the expiry sweep on `ok:false`, so an
 * expired-but-renewable wait is never escalated on the back of a renewal we failed to apply (the r2 defect: a transient
 * renew-read fault that then reloaded clean still ran the sweep and escalated a wait that should have renewed). On both reads
 * good, each eligible wait is renewed via the real reducer (`advanceWait`) + the injected `commit` (persisted). It returns
 * `{ ok: true }` ONLY when the pass is COMPLETE — every wait we decided to renew actually committed; if any such commit does
 * NOT persist (returns not-ok, or throws), the pass is INCOMPLETE and it returns `{ ok: false }` too, so the caller still skips
 * the expiry sweep rather than escalating a wait whose renewal we failed to apply (DISP1-1 r4). Per-wait isolated;
 * deterministic given (state, batches, now, config). All IO + commit injected. */
export function renewExpiredLivenessWaits(deps: {
  loadState: () => LogState | null;                 // fail-soft control load; null ⇒ read#1 fault (already escalated by the loader)
  readBatches: () => readonly CommittedBatch[];     // may throw ⇒ read#2 fault
  onBatchesFault: (e: unknown) => void;             // escalate a read#2 fault (deduped by the caller)
  now: number;
  maxFreeRenewals: number;
  renewWindowSec: number;
  commit: (state: LogState, changes: Change[]) => { state: LogState; result: CommitResult };
  log: (s: string) => void;
}): { ok: boolean } {
  const st0 = deps.loadState();
  if (st0 === null) return { ok: false };                              // read#1 fault ⇒ atomic abort (unknown) ⇒ caller skips sweep
  let batches: readonly CommittedBatch[];
  try { batches = deps.readBatches(); }
  catch (e) { deps.onBatchesFault(e); return { ok: false }; }          // read#2 fault ⇒ atomic abort (unknown) ⇒ caller skips sweep
  let st = st0;
  // DISP1-1 r4 (codex:Work): a wait we DECIDED to renew (eligible: expired + renewable + under cap + fresh evidence, and the
  // reducer accepted it) whose COMMIT does not persist (returns not-ok, or throws) leaves the renewal pass INCOMPLETE. The
  // previous version logged "deferred/failed" but still returned ok:true, so the gate reloaded the STALE deadline and the
  // expiry sweep escalated a wait that should have renewed (chmod-EACCES: 0 renewal, 1 spurious escalation). Track that and
  // return ok:false so the caller SKIPS the expiry sweep this tick (an expired-but-should-renew wait is never escalated on a
  // tick where we failed to persist its renewal); the next tick reloads fresh and retries. Independent duties keep running
  // (they are outside the renew→sweep gate). A reducer REFUSAL (adv.ok=false) is NOT incomplete — that wait legitimately cannot
  // renew, so letting the sweep escalate it is correct; only a legal-renew-that-did-not-commit blocks the sweep.
  let incomplete = false;
  for (const b of Object.values(liveEntities(st))) {
    if (b.put !== "wait") continue;
    const w = (b as Extract<ChangeBody, { put: "wait" }>).wait;
    if (w.state !== "open" || !isRenewable(w) || w.deadlineSec > deps.now) continue; // only an EXPIRED open renewable wait (the probe moment)
    if (renewalCount(batches, w.waitId) >= deps.maxFreeRenewals) continue;           // §2c-b ③: finite free renewals ⇒ let the sweep escalate
    // §2c-b evidence anchored to the wait's FULL subject, most-specific field first (binding > attempt > job — review 4c617fa-E1).
    const progressSubject = { jobId: w.subject.jobId, attemptId: w.subject.attemptId, bindingId: w.subject.bindingId };
    if (!hasFreshSubjectEvidence(batches, progressSubject, w.waitId)) continue;      // no subject progress since the arm ⇒ let the sweep escalate
    const adv = advanceWait(w, { type: "renew", newDeadlineSec: deps.now + deps.renewWindowSec, nowSec: deps.now });
    if (!adv.ok) { deps.log(`renew ${w.waitId} rejected by reducer: ${adv.error}`); continue; } // reducer refuses ⇒ legitimately let the sweep escalate (not incomplete)
    const progressSeq = subjectProgressSeq(batches, progressSubject);               // idempotent id by the triggering progress (countable, §2c-b ③)
    const rev = st.revisions[`wait:${w.waitId}`] ?? 0;
    try {
      const res = deps.commit(st, [{ put: "wait", wait: adv.wait, operationId: renewOperationId(w.waitId, progressSeq), expectedEntityRevision: rev }]);
      if (res.result.ok) { st = res.state; deps.log(`renewed liveness wait ${w.waitId} (subject ${w.subject.jobId} progressed @${progressSeq}) +${deps.renewWindowSec}s`); }
      else { incomplete = true; deps.log(`renew ${w.waitId} NOT committed (${JSON.stringify(res.result)}) — pass INCOMPLETE, skip expiry sweep this tick`); } // DISP1-1 r4: a should-renew wait that did not persist blocks the sweep
    } catch (e) { incomplete = true; deps.log(`renew ${w.waitId} commit failed (${e instanceof Error ? e.message : e}) — pass INCOMPLETE, skip expiry sweep this tick`); }
  }
  return { ok: !incomplete };
}
