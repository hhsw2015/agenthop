/**
 * Validation-run transitions (team-collab §0b, R2 P2-2) — PURE, immutable. When a candidate sits in RESULT_PENDING_
 * VALIDATION but can't be VALIDATED (the V8 execution environment broke / timed out), this is NOT business
 * transient-infra: the pinned candidate is fine, only the validator is stuck. The attempt STAYS in RPV; we open a new
 * validation run at a different validator location re-using the SAME pinned candidate (business is NOT re-run), and
 * fence the old validator's late verdict by generation — exactly the ExecutionBinding (launchId, generation) peer-late
 * seam, moved to the validation side. The ValidationRun type is durable (control-log.ts {put:validationRun}); this
 * module is the pure state machine over one run.
 *
 * Invariants pinned by tests:
 *  - the candidate is PINNED: moveValidator carries candidateRef byte-identically; business is never re-run.
 *  - generation is monotonic; a verdict is eligible ONLY from the current (non-closed) run — an older/superseded run's
 *    late verdict is fenced (peer-late), so the stuck validator's eventual reply cannot double-accept.
 */

import type { ValidationRun, ValidationCandidateRef, ValidationRunState } from "./control-log.js";

export type NewValidationRun = {
  validationRunId: string;
  attemptId: string;
  candidateRef: ValidationCandidateRef;
  generation: number;
  validatorLocation: string;
  openedAtSeq: number;
};

export function openValidationRun(i: NewValidationRun): ValidationRun {
  return {
    validationRunId: i.validationRunId,
    attemptId: i.attemptId,
    candidateRef: i.candidateRef,
    generation: i.generation,
    validatorLocation: i.validatorLocation,
    state: "running",
    openedAtSeq: i.openedAtSeq,
  };
}

export type ValidationEvent =
  | { type: "verdict_observed" } // the validator at this run produced a verdict (to be validated by the caller)
  | { type: "resolve"; atSeq: number } // the verdict was accepted/applied — this run is done
  | { type: "supersede"; atSeq: number } // moved to a new validator — this run (and its late verdict) is fenced
  | { type: "cancel"; atSeq: number }; // the candidate/attempt went away upstream — abandon this run

export type ValidationAdvance = { ok: true; run: ValidationRun } | { ok: false; error: string };

export function advanceValidationRun(run: ValidationRun, event: ValidationEvent): ValidationAdvance {
  const bad = (error: string): ValidationAdvance => ({ ok: false, error });
  const ok = (patch: Partial<ValidationRun>): ValidationAdvance => ({ ok: true, run: { ...run, ...patch } });

  switch (event.type) {
    case "verdict_observed":
      if (run.state !== "running") return bad(`verdict_observed from ${run.state}`);
      return ok({ state: "verdict_pending" });
    case "resolve":
      if (run.state !== "verdict_pending") return bad(`resolve from ${run.state}`);
      return ok({ state: "closed", closedAtSeq: event.atSeq, closeReason: "verdict-accepted" });
    case "supersede":
      if (run.state === "closed") return bad("supersede on a closed run");
      return ok({ state: "closed", closedAtSeq: event.atSeq, closeReason: "superseded" });
    case "cancel":
      if (run.state === "closed") return bad("cancel on a closed run");
      return ok({ state: "closed", closedAtSeq: event.atSeq, closeReason: "cancelled" });
  }
}

export type ValidationMove = { next: ValidationRun; closedOld: ValidationRun } | { error: string };

/** Move validation to a new validator location: close the stuck run (fencing its late verdict) and open a fresh run at
 *  generation+1 over the SAME pinned candidate (business NOT re-run). Caller commits both in one batch. */
export function moveValidator(old: ValidationRun, to: { validationRunId: string; validatorLocation: string; openedAtSeq: number; atSeq: number }): ValidationMove {
  if (old.state === "closed") return { error: "moveValidator from a closed run" };
  const supersede = advanceValidationRun(old, { type: "supersede", atSeq: to.atSeq });
  if (!supersede.ok) return { error: supersede.error };
  const next = openValidationRun({
    validationRunId: to.validationRunId,
    attemptId: old.attemptId,
    candidateRef: old.candidateRef, // PINNED — same candidate, business not re-run
    generation: old.generation + 1,
    validatorLocation: to.validatorLocation,
    openedAtSeq: to.openedAtSeq,
  });
  return { next, closedOld: supersede.run };
}

/** Is a verdict that claims to come from `run` eligible? Only if that run is the live (non-closed) one — an older /
 *  superseded run's late verdict is fenced (the stuck validator's eventual reply cannot double-accept). */
export function verdictEligible(run: ValidationRun): boolean {
  return run.state !== "closed";
}
