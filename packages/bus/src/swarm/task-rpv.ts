/**
 * RPV validation-timeout anchor — option (b): a ValidationRun is accompanied by a validation-WAIT, opened in the SAME
 * CONTROL batch (team-collab §0b; anchor decision (b)). The ValidationRun itself stays on pure CONTROL seq (no wall
 * clock); the TIMEOUT lives on the companion wait, so the liveness sweep sees an overdue wait and drives the
 * validator-swap via the normal wait machinery. This module is PURE composition only — it adds same-batch constructors
 * over the existing openValidationRun / openWait / advance* transitions; it changes NO reducer or transition semantics.
 * The IO wiring (sweep's RPV rule, actually moving the validator) is the sweep batch's job (20cab0a5), not here.
 */

import { openValidationRun, advanceValidationRun, moveValidator } from "./task-validation.js";
import { openWait, advanceWait } from "./task-wait.js";
import type { ValidationRun, ValidationCandidateRef, WaitRecord, WaitSubject, WaitResolution, PendingAction, ChangeBody } from "./control-log.js";

export type OpenRpvInput = {
  jobId: string;
  attemptId: string;
  candidateRef: ValidationCandidateRef;
  validationRunId: string;
  generation: number;
  validatorLocation: string;
  openedAtSeq: number;
  // companion validation-wait:
  waitId: string;
  deadlineSec: number;
  owner: string;
  timeoutPolicy: WaitRecord["timeoutPolicy"]; // parameterized by the acceptance policy (bypass | escalate)
};

/** Open a ValidationRun AND its companion validation-wait as one same-batch pair. The wait is anchored to the run via
 *  WaitSubject.validationRunId (typed anchoring, P2-1) so a stale wait never acts on a different run. */
export function openValidationRunWithWait(i: OpenRpvInput): { run: ValidationRun; wait: WaitRecord; changes: ChangeBody[] } {
  const run = openValidationRun({
    validationRunId: i.validationRunId,
    attemptId: i.attemptId,
    candidateRef: i.candidateRef,
    generation: i.generation,
    validatorLocation: i.validatorLocation,
    openedAtSeq: i.openedAtSeq,
  });
  const subject: WaitSubject = { jobId: i.jobId, attemptId: i.attemptId, validationRunId: run.validationRunId };
  const wait = openWait({ waitId: i.waitId, kind: "wait", subject, deadlineSec: i.deadlineSec, owner: i.owner, timeoutPolicy: i.timeoutPolicy });
  return { run, wait, changes: [{ put: "validationRun", validationRun: run }, { put: "wait", wait }] };
}

export type RpvPair = { run: ValidationRun; wait: WaitRecord; changes: ChangeBody[] } | { error: string };

/** Normal completion (P2-1 race): the ValidationRun's verdict is accepted (resolve) AND its companion wait is closed in
 *  the SAME batch, so a timeout handler that re-reads the subject sees the wait already closed and does not act. Requires
 *  the run in verdict_pending and the wait still live. */
export function closeValidationWithWait(run: ValidationRun, wait: WaitRecord, opts: { atSeq: number; resolution: WaitResolution }): RpvPair {
  const r = advanceValidationRun(run, { type: "resolve", atSeq: opts.atSeq });
  if (!r.ok) return { error: r.error };
  const w = advanceWait(wait, { type: "close", resolution: opts.resolution });
  if (!w.ok) return { error: w.error };
  return { run: r.run, wait: w.wait, changes: [{ put: "validationRun", validationRun: r.run }, { put: "wait", wait: w.wait }] };
}

/** The timeout action the sweep CAS-commits on the companion wait before swapping the validator (begin_action payload).
 *  move-validator-shaped: target is the new validator location; expectedSubjectVersion fences a stale subject. */
export function moveValidatorAction(i: { actionId: string; newValidatorLocation: string; expectedSubjectVersion: number }): PendingAction {
  return { actionId: i.actionId, actionKind: "move-validator", target: i.newValidatorLocation, expectedSubjectVersion: i.expectedSubjectVersion };
}

export type MoveRpv =
  | { next: ValidationRun; closedOldRun: ValidationRun; closedOldWait: WaitRecord; newWait: WaitRecord; changes: ChangeBody[] }
  | { error: string };

/** MOVE validator = a reassignment-class terminal (§0b "改派(close+new)"). The old companion wait is CLOSED (never
 *  action_done — a reminder/bypass never resolves), the stuck run is superseded, and a fresh run (generation+1, SAME
 *  pinned candidate — business not re-run) is opened WITH its own new companion wait, all in one batch. The stuck
 *  validator's late verdict is then fenced (closed run) and a late reply on the old wait is rejected (resolved). */
export function moveValidatorWithWait(
  oldRun: ValidationRun,
  oldWait: WaitRecord,
  to: { newValidationRunId: string; validatorLocation: string; openedAtSeq: number; atSeq: number; newWaitId: string; deadlineSec: number; owner: string; timeoutPolicy: WaitRecord["timeoutPolicy"]; resolution: WaitResolution },
): MoveRpv {
  const closedWait = advanceWait(oldWait, { type: "close", resolution: to.resolution });
  if (!closedWait.ok) return { error: closedWait.error };
  const moved = moveValidator(oldRun, { validationRunId: to.newValidationRunId, validatorLocation: to.validatorLocation, openedAtSeq: to.openedAtSeq, atSeq: to.atSeq });
  if ("error" in moved) return { error: moved.error };
  const subject: WaitSubject = { jobId: oldWait.subject.jobId, attemptId: oldRun.attemptId, validationRunId: moved.next.validationRunId };
  const newWait = openWait({ waitId: to.newWaitId, kind: "wait", subject, deadlineSec: to.deadlineSec, owner: to.owner, timeoutPolicy: to.timeoutPolicy });
  return {
    next: moved.next,
    closedOldRun: moved.closedOld,
    closedOldWait: closedWait.wait,
    newWait,
    changes: [
      { put: "wait", wait: closedWait.wait },
      { put: "validationRun", validationRun: moved.closedOld },
      { put: "validationRun", validationRun: moved.next },
      { put: "wait", wait: newWait },
    ],
  };
}
