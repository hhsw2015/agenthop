/**
 * liveness sweep (team-collab §0b R2) — the dispatcher pass's fixed step that REPLACES the human coordinator: each round
 * it scans the durable wait entities + member liveness and mechanically matches the §0b rules, so "any single point stuck
 * ⇒ job stalls forever" can't happen without a code path catching it. R2: progress is a property of the LOOP, not any
 * member's memory — a member may die/idle/forget; the loop + durable records move it forward.
 *
 * This increment implements the two highest-value rules (fe0376cd's acceptance scenarios A/B):
 *   - EXPIRED wait (owner alive)    → begin_action (bypass|escalation) → IO → action_done   [scenario A]
 *   - owner DEAD (isAlive)          → reassign: begin_action → IO → close old + open new    [scenario B]
 * Remaining rules (blocked×approval reminder, overload×idle R8, validation RPV-timeout moveValidator, idle×ready which
 * taskPass already covers) layer on next. All decisions are pure; all IO + liveness are injected (SweepOps), so the
 * ordering (CAS-then-IO, bounded delay, single suspected ≠ dead) is offline-testable.
 *
 * CAS-then-IO + bounded delay (P2-3): a timeout handler CAS-commits the recoverable action intent (open→action_pending)
 * BEFORE the IO, and an already-action_pending wait is SKIPPED this tick (its IO is in flight / will be confirmed) — a
 * slow supervised action never blocks the sweep from running. isAlive is injected (bus-identity owns the impl + its
 * known defects, §4); a SINGLE "suspected" is NOT dead (only a trustworthy "dead" reassigns).
 */

import { liveEntities, type WaitRecord, type PendingAction, type LogState, type ChangeBody, type CommitResult, type ValidationRun } from "./control-log.js";
import { advanceWait, openWait, isLive } from "./task-wait.js";
import { moveValidator } from "./task-validation.js";

export type Liveness = "alive" | "suspected" | "dead";

export type SweepOps = {
  nowSec: () => number;
  loadState: () => LogState;
  /** Stamp operationId + expectedEntityRevision per body + persist (same convention as the task commit). */
  commit: (state: LogState, bodies: ChangeBody[]) => { state: LogState; result: CommitResult };
  /** Member liveness — injected; bus-identity owns the implementation + its known defects (§4). */
  isAlive: (memberId: string) => Liveness;
  /** An idle same-role successor for a dead owner's wait; null = none available ⇒ don't reassign (leave for escalation). */
  pickReassignee: (wait: WaitRecord) => string | null;
  /** A fresh validator execution location for a stuck/dead RPV validator; null = none ⇒ leave for escalation (v1, same
   *  convention as pickReassignee — the real picker needs the validator roster, owned by bus-identity). */
  pickValidator: (wait: WaitRecord, run: ValidationRun) => string | null;
  newWaitId: (base: string) => string;
  newValidationRunId: (base: string) => string;
  newActionId: () => string;
  /** Deadline for a freshly reassigned wait. */
  freshDeadlineSec: () => number;
  /** The bounded supervised IO (bypass ping / escalation notice / reassign notify) via an R5 channel; resolves true when
   *  delivered with evidence. The action intent is ALREADY committed (begin_action) before this runs. */
  doAction: (wait: WaitRecord, action: PendingAction) => Promise<boolean>;
  log: (m: string) => void;
};

const subjectTarget = (w: WaitRecord): string => w.subject.attemptId ?? w.subject.bindingId ?? w.subject.jobId;

export async function sweepPass(ops: SweepOps): Promise<void> {
  let state = ops.loadState();
  const waits: WaitRecord[] = [];
  const runs = new Map<string, ValidationRun>();
  for (const body of Object.values(liveEntities(state))) {
    if (body.put === "wait") waits.push(body.wait);
    else if (body.put === "validationRun") runs.set(body.validationRun.validationRunId, body.validationRun);
  }

  // Commit-then-IO barrier (P1-1): a REJECTED commit must NOT proceed to IO and must NOT be logged as success. Ordering
  // the calls commit→IO is not enough — the result must be checked. Advance local state only on ok; on reject, log
  // honestly and return false so the caller bails (the durable record is left recoverable — it never claims success).
  const commitOk = (bodies: ChangeBody[], ctx: string): boolean => {
    const r = ops.commit(state, bodies);
    if (!r.result.ok) { ops.log(`sweep ${ctx}: commit rejected (${r.result.reason}) — no IO, no completion claim`); return false; }
    state = r.state;
    return true;
  };

  for (const w of waits) {
    if (!isLive(w)) continue;                     // resolved — nothing to supervise
    if (w.state === "action_pending") continue;   // an action is already in flight (begin committed) — bounded delay: skip re-begin
    const live = ops.isAlive(w.owner);

    // Rule — RPV validation-wait (subject.validationRunId set) ⇒ moveValidator (§0b RPV / P2-2). A validation-wait tracks a
    // stuck validator seat, not a normal owner: a validator that is DEAD (gone) or ALIVE-but-past-deadline (env broke /
    // too slow) is replaced by opening a fresh run+wait at a new location over the SAME pinned candidate — business is
    // NEVER re-run, and the old generation's late verdict is fenced. This is NOT bypass (never auto-accepts a candidate)
    // and NOT owner-reassign (that keeps the same subject). A single "suspected" is not convicted; pickValidator v1 may
    // return null ⇒ defer to escalation. The validation-wait's deadline is the recoverable absolute clock (anchor (b)).
    if (w.subject.validationRunId !== undefined) {
      if (live === "suspected") continue;
      if (live === "alive" && ops.nowSec() < w.deadlineSec) continue; // validator working within deadline — leave it
      const run = runs.get(w.subject.validationRunId);
      if (!run) { ops.log(`sweep ${w.waitId}: validation-wait references unknown run ${w.subject.validationRunId} — skipping`); continue; }
      const to = ops.pickValidator(w, run);
      if (to === null) { ops.log(`sweep ${w.waitId}: validator ${run.validatorLocation} stuck/dead, no replacement — leaving for escalation`); continue; }
      const action: PendingAction = { actionId: ops.newActionId(), actionKind: "move-validator", target: run.validationRunId, expectedSubjectVersion: run.generation };
      const begun = advanceWait(w, { type: "begin_action", pendingAction: action });
      if (!begun.ok) { ops.log(`sweep ${w.waitId}: begin move-validator rejected: ${begun.error}`); continue; }
      if (!commitOk([{ put: "wait", wait: begun.wait }], `${w.waitId} begin move-validator`)) continue; // CAS BEFORE IO
      const delivered = await ops.doAction(begun.wait, action);                        // IO: notify the new validator seat (R5)
      if (!delivered) { ops.log(`sweep ${w.waitId}: move-validator notify unconfirmed — holding action_pending, retry next tick`); continue; }
      const atSeq = state.seq + 1;                                                     // the batch seq the moved run/wait commit at
      const moved = moveValidator(run, { validationRunId: ops.newValidationRunId(run.validationRunId), validatorLocation: to, openedAtSeq: atSeq, atSeq });
      if ("error" in moved) { ops.log(`sweep ${w.waitId}: moveValidator rejected: ${moved.error}`); continue; }
      const closedWait = advanceWait(begun.wait, { type: "close", resolution: { outcome: "validator-moved", reason: `validator ${run.validatorLocation} stuck/dead → ${to}`, sourceOperationId: action.actionId } });
      if (!closedWait.ok) { ops.log(`sweep ${w.waitId}: close(validator-moved) rejected: ${closedWait.error}`); continue; }
      const freshWait = openWait({ waitId: ops.newWaitId(w.waitId), kind: w.kind, subject: { ...w.subject, validationRunId: moved.next.validationRunId }, deadlineSec: ops.freshDeadlineSec(), owner: to, timeoutPolicy: w.timeoutPolicy });
      if (!commitOk([
        { put: "validationRun", validationRun: moved.closedOld },  // old run → closed (fences its late verdict)
        { put: "validationRun", validationRun: moved.next },       // new run, gen+1, SAME pinned candidate
        { put: "wait", wait: closedWait.wait },                    // old validation-wait resolved
        { put: "wait", wait: freshWait },                          // new validation-wait for the new run, same batch
      ], `${w.waitId} move-validator confirm`)) continue;
      ops.log(`sweep ${w.waitId}: RPV stuck ⇒ moveValidator ${run.validatorLocation} → ${to} (run ${run.validationRunId}→${moved.next.validationRunId} gen ${moved.next.generation}, new wait ${freshWait.waitId})`);
      continue;
    }

    // Rule — owner DEAD ⇒ reassign (close old + open new, same batch), regardless of deadline (R5 / scenario B). A single
    // "suspected" is NOT dead (fe0376cd §4): we leave it. "alive" falls through to the expiry check.
    if (live === "dead") {
      const to = ops.pickReassignee(w);
      if (to === null) { ops.log(`sweep ${w.waitId}: owner ${w.owner} dead, no reassignee — leaving for escalation`); continue; }
      const action: PendingAction = { actionId: ops.newActionId(), actionKind: "reassign", target: subjectTarget(w), expectedSubjectVersion: 0 };
      const begun = advanceWait(w, { type: "begin_action", pendingAction: action });
      if (!begun.ok) { ops.log(`sweep ${w.waitId}: begin reassign rejected: ${begun.error}`); continue; }
      if (!commitOk([{ put: "wait", wait: begun.wait }], `${w.waitId} begin reassign`)) continue;         // CAS BEFORE IO
      const delivered = await ops.doAction(begun.wait, action);                        // IO: notify the new owner (R5)
      if (!delivered) { ops.log(`sweep ${w.waitId}: reassign notify unconfirmed — holding action_pending, retry next tick`); continue; }
      const closed = advanceWait(begun.wait, { type: "close", resolution: { outcome: "owner-dead", reason: `owner ${w.owner} unreachable`, sourceOperationId: action.actionId } });
      if (!closed.ok) { ops.log(`sweep ${w.waitId}: close(owner-dead) rejected: ${closed.error}`); continue; }
      const fresh = openWait({ waitId: ops.newWaitId(w.waitId), kind: w.kind, subject: w.subject, deadlineSec: ops.freshDeadlineSec(), owner: to, timeoutPolicy: w.timeoutPolicy });
      if (!commitOk([{ put: "wait", wait: closed.wait }, { put: "wait", wait: fresh }], `${w.waitId} reassign confirm`)) continue; // close old + open new, same batch
      ops.log(`sweep ${w.waitId}: owner-dead ⇒ reassigned ${w.owner} → ${to} (new ${fresh.waitId})`);
      continue;
    }

    // Rule — EXPIRED (owner alive) ⇒ bypass (reversible) / escalation (§0b sweep rules 2+3). SAFETY RED LINE
    // (§0b pendingApprovals): an approval is NEVER auto-resolved or bypassed on timeout — the completed escalation NOTICE
    // REOPENS it with a fresh deadline + escalatedAt (supervision transfers; only a real `decide` grants/denies, 终审②).
    // Only a reversible `wait` resolves on timeout. (A1 auto-extension budget is the round-2 draft — not implemented here.)
    if (live === "alive" && ops.nowSec() >= w.deadlineSec) {
      const isApproval = w.kind === "approval" && (w.decision ?? "pending") === "pending";
      const kind = isApproval || w.timeoutPolicy !== "bypass" ? "escalation" : "bypass"; // an approval always escalates
      const action: PendingAction = { actionId: ops.newActionId(), actionKind: kind, target: subjectTarget(w), expectedSubjectVersion: 0 };
      const begun = advanceWait(w, { type: "begin_action", pendingAction: action });
      if (!begun.ok) { ops.log(`sweep ${w.waitId}: begin ${kind} rejected: ${begun.error}`); continue; }
      if (!commitOk([{ put: "wait", wait: begun.wait }], `${w.waitId} begin ${kind}`)) continue;          // CAS BEFORE IO
      const delivered = await ops.doAction(begun.wait, action);                        // IO: send the ping / escalation notice (R5)
      if (!delivered) { ops.log(`sweep ${w.waitId}: ${kind} unconfirmed — holding action_pending, retry next tick`); continue; }
      // Approval (decision pending): the escalation NOTICE reopens with a fresh deadline (never resolves, never grants —
      // safety red line). Reversible wait: action_done resolves with evidence.
      const done = isApproval
        ? advanceWait(begun.wait, { type: "action_done", newDeadlineSec: ops.freshDeadlineSec(), nowSec: ops.nowSec() })
        : advanceWait(begun.wait, { type: "action_done", resolution: { outcome: kind, reason: `deadline passed; ${kind} sent`, sourceOperationId: action.actionId } });
      if (!done.ok) { ops.log(`sweep ${w.waitId}: action_done rejected: ${done.error}`); continue; }
      if (!commitOk([{ put: "wait", wait: done.wait }], `${w.waitId} ${kind} confirm`)) continue;
      ops.log(isApproval
        ? `sweep ${w.waitId}: approval expired ⇒ escalation sent, REOPENED (deadline ${done.wait.deadlineSec}, escalatedAt ${done.wait.escalatedAt})`
        : `sweep ${w.waitId}: expired ⇒ ${kind} sent, resolved`);
    }
  }
}
