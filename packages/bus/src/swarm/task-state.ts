/**
 * TaskAttempt / ExecutionBinding — the business-task axis (§2.2, §2.3, §3.1). PURE, immutable: every transition
 * returns a NEW record ({...base, ...patch}), mirroring control.ts `advance`. No IO, no scheduling.
 *
 * What lives here (T1): the attempt/binding data model, inputBindingDigest, the §2.3 binding tri-state candidate
 * rule, and the §3.1 LOCAL attempt transitions. What does NOT (T2): readyTasks / currentAccepted recursion,
 * supersede CASCADE (who gets superseded), and commitControl batching/seq allocation. The seqs here are passed in by
 * the caller; this module never invents them.
 *
 * Three invariants Codex's review rounds turned into counterexamples — each is pinned by a test:
 *  - retriesUsed has ONE count point: a business-fail entering RETRY_WAIT (+1). A retry SUCCESSION inherits it
 *    as-is (NO +1); transient-infra / stale / inconsistent-snapshot / handoff never charge it. (v2-P2-3: charging at
 *    both the fail AND the succession double-deducts — retryBudget=2 would really allow only 1 retry.)
 *  - a retry succession abandons the old attempt as ABANDONED(retry-succession), NEVER FAILED. FAILED is written
 *    ONLY on a terminal fail (permanent / retryBudget exhausted / job budget exhausted). (P1-2: writing the
 *    superseded attempt as FAILED makes a later look-back misjudge the node as terminally failed.)
 *  - a VM handoff (add_binding) leaves attemptId, status and retriesUsed UNCHANGED — one attempt spans VM
 *    continuations; a normal handoff is not a business failure (§3.2 X2).
 */

import { digestOf } from "./digest.js";

export type AttemptStatus =
  | "RUNNING"
  | "RESULT_PENDING_VALIDATION"
  | "SUCCEEDED"
  | "RETRY_WAIT"
  | "FAILED"
  | "ABANDONED";

export type FailureClass = "transient-infra" | "business-fail" | "stale" | "inconsistent-snapshot" | "permanent";

export type AbandonReason = "stale-input" | "stale-plan" | "retry-succession" | "intent-revoked";

/** A frozen dependency input of an attempt: bound to a dependency's ACCEPTED RESULT id (not its node status), so
 *  "is the input still the one we started on" is mechanically decidable (§2.2,硬问题 #1). */
export type InputBinding = {
  depNodeId: string;
  acceptedResultId: string;
  workCommit: string;
  resultPath: string;
};

/** The one seam between the business layer and the lifecycle layer (§2.3): a concrete VM execution of an attempt. */
export type ExecutionBinding = {
  bindingId: string;
  assignmentId: string;
  launchId: string;
  publishGeneration: number;
  continuationOf?: string;
  /** Registered at creation (pending) — BEFORE the assignment/allocate IO, so O1 scans it even if takeover never
   *  confirms (§2.3, F19/P2-4). */
  openedAtSeq: number;
  /** startTask-confirm / takeover-confirm. */
  activatedAtSeq?: number;
  /** Cutoff step 1: the confirmed tip pinned when closing begins, or "empty". "empty" is allowed ONLY when a
   *  SUCCESSFUL ls-remote confirmed the branch does not exist (clean-fail / never-published, v2-P2-1 rebuttal B);
   *  a query ERROR must NOT be reported as "empty" — leave the binding open (that is the caller's duty). */
  closing?: { cutoffTip: string | "empty" };
  /** Cutoff step 2: written only after the full cutoffTip-ancestry scan has registered everything (§2.3, P1-5). */
  closedAtSeq?: number;
};

export type TaskAttempt = {
  attemptId: string;
  jobId: string;
  planRevision: number;
  nodeId: string;
  status: AttemptStatus;
  inputBindings: InputBinding[];
  inputBindingDigest: string;
  baseSourceCommit?: string;
  /** Copied from the plan's node spec at creation — V5 compares against THIS (§2.2). */
  specDigest: string;
  executionBindings: ExecutionBinding[];
  retriesUsed: number;
  retryAt?: number;
  failureClass?: FailureClass;
  /** Audit of WHY an attempt is ABANDONED (§2.2). Not a failure taxonomy — that is failureClass. */
  abandonReason?: AbandonReason;
  /** Free-form audit note, e.g. the conflict detail when an op-conflict terminated this attempt (§2.6). */
  note?: string;
  createdAtSeq: number;
};

export const attemptIdOf = (jobId: string, nodeId: string, n: number): string => `${jobId}/${nodeId}/a${n}`;
export const bindingIdOf = (attemptId: string, k: number): string => `${attemptId}/b${k}`;

/** inputBindingDigest = canonical-JSON SHA-256 of the inputBindings SORTED on (depNodeId, acceptedResultId), so the
 *  digest is order-independent and comparable byte-for-byte on both ends (§2.2; V4 compares this field). */
export function computeInputBindingDigest(bindings: InputBinding[]): string {
  const sorted = [...bindings].sort((a, b) =>
    a.depNodeId < b.depNodeId ? -1 : a.depNodeId > b.depNodeId ? 1
    : a.acceptedResultId < b.acceptedResultId ? -1 : a.acceptedResultId > b.acceptedResultId ? 1 : 0,
  );
  return digestOf(sorted);
}

// ---- binding tri-state (§2.3) --------------------------------------------------------------------------------------

export function bindingState(b: ExecutionBinding): "open" | "closing" | "closed" {
  if (b.closedAtSeq !== undefined) return "closed";
  if (b.closing !== undefined) return "closing";
  return "open";
}

export type Eligibility = { eligible: boolean; reason: string };

/** Is a candidate observed on THIS binding's branch eligible for validation? The caller (V3 / O1) decides branch
 *  membership (launchId+generation) and, for a closing/closed binding, whether the candidate commit is within the
 *  cutoffTip ancestry — that is git IO, passed in as `withinCutoffAncestry`. Pure decision over §2.3's three states:
 *  open => always; closing => inside cutoffTip ancestry; closed => only what was registered before close (same
 *  predicate: registration happened during the cutoffTip-ancestry scan). "empty" cutoff => nothing is eligible.
 *  NOTE for closed bindings: `withinCutoffAncestry` must mean "was this candidate REGISTERED before closedAtSeq"
 *  (a fact the caller reads from CONTROL), NOT a fresh git ancestry computation — after close O1 no longer scans. */
export function candidateEligibility(b: ExecutionBinding, withinCutoffAncestry: boolean): Eligibility {
  const st = bindingState(b);
  if (st === "open") return { eligible: true, reason: "open binding" };
  const cutoff = b.closing!.cutoffTip;
  if (cutoff === "empty") return { eligible: false, reason: "peer-late: binding closed empty (no branch)" };
  if (withinCutoffAncestry) return { eligible: true, reason: st === "closing" ? "within cutoffTip ancestry" : "registered before close" };
  return { eligible: false, reason: "peer-late: beyond cutoffTip ancestry" };
}

// ---- binding record transitions (pure builders) --------------------------------------------------------------------

export function activateBinding(b: ExecutionBinding, atSeq: number): ExecutionBinding {
  return { ...b, activatedAtSeq: atSeq };
}

/** Pin cutoffTip (step 1). Pass "empty" ONLY for a confirmed-absent branch (see ExecutionBinding.closing). */
export function beginClosing(b: ExecutionBinding, cutoffTip: string | "empty"): ExecutionBinding {
  return { ...b, closing: { cutoffTip } };
}

/** Mark the binding closed (step 2) after the cutoffTip-ancestry scan finished. Requires closing to be pinned. */
export function finishClosing(b: ExecutionBinding, atSeq: number): ExecutionBinding {
  if (b.closing === undefined) throw new Error("finishClosing: binding never entered closing (cutoffTip not pinned)");
  return { ...b, closedAtSeq: atSeq };
}

// ---- attempt constructor + transitions (§3.1) ----------------------------------------------------------------------

export type NewAttempt = {
  jobId: string;
  nodeId: string;
  n: number;
  planRevision: number;
  specDigest: string;
  inputBindings: InputBinding[];
  baseSourceCommit?: string;
  firstBinding: ExecutionBinding;
  createdAtSeq: number;
  /** Inherited on a retry succession; omitted (=> 0) for a fresh node attempt. */
  retriesUsed?: number;
};

export function createAttempt(i: NewAttempt): TaskAttempt {
  return {
    attemptId: attemptIdOf(i.jobId, i.nodeId, i.n),
    jobId: i.jobId,
    planRevision: i.planRevision,
    nodeId: i.nodeId,
    status: "RUNNING",
    inputBindings: i.inputBindings,
    inputBindingDigest: computeInputBindingDigest(i.inputBindings),
    ...(i.baseSourceCommit !== undefined ? { baseSourceCommit: i.baseSourceCommit } : {}),
    specDigest: i.specDigest,
    executionBindings: [i.firstBinding],
    retriesUsed: i.retriesUsed ?? 0,
    createdAtSeq: i.createdAtSeq,
  };
}

// jitterSec: the caller samples it ONCE and persists it in the operation payload; a crash-recovery REPLAY must reuse
// the same value, never re-sample (§2.2 retryAt "采样一次持久,重放不再随机"). This pure layer only applies it.
export type AttemptEvent =
  | { type: "observed" }                                              // non-closed binding ResultObserved
  | { type: "accepted" }                                             // validation passed
  | { type: "business_fail"; retryBudget: number; jitterSec?: number } // outcome=failure / V7/V8 on a consistent snapshot
  | { type: "transient_infra"; jitterSec?: number }                  // all bindings dead, no result
  | { type: "stale"; which: "input" | "plan" }                       // V4 / V5 reject (at validation time, from RPV)
  | { type: "inconsistent_snapshot" }                                // V7/V8 on an inconsistent rescue snapshot
  | { type: "permanent" }                                            // V1 / scope-violation on a milestone (structural)
  | { type: "conflict"; note?: string }                              // §2.6 op-conflict terminates the victim attempt
  | { type: "revoke"; reason: "intent-revoked" | "stale-input" }      // abandon a RUNNING, never-activated attempt
  | { type: "add_binding"; binding: ExecutionBinding };               // VM handoff continuation (X2)

export type AttemptAdvance = { ok: true; attempt: TaskAttempt } | { ok: false; error: string };

/** Apply one §3.1 event to an attempt. Pure; rejects illegal source states (like control.ts advance). */
export function advanceAttempt(a: TaskAttempt, event: AttemptEvent, nowSec: number): AttemptAdvance {
  const bad = (error: string): AttemptAdvance => ({ ok: false, error });
  const ok = (patch: Partial<TaskAttempt>): AttemptAdvance => ({ ok: true, attempt: { ...a, ...patch } });

  switch (event.type) {
    case "observed":
      if (a.status === "RUNNING") return ok({ status: "RESULT_PENDING_VALIDATION" });
      if (a.status === "RESULT_PENDING_VALIDATION") return ok({}); // another candidate observed; status already pending
      return bad(`observed from ${a.status}`);

    case "accepted":
      if (a.status !== "RESULT_PENDING_VALIDATION") return bad(`accepted from ${a.status}`);
      return ok({ status: "SUCCEEDED", failureClass: undefined });

    case "business_fail": {
      if (a.status !== "RESULT_PENDING_VALIDATION") return bad(`business_fail from ${a.status}`);
      const next = a.retriesUsed + 1; // THE single count point
      if (next > event.retryBudget) return ok({ status: "FAILED", failureClass: "business-fail", retriesUsed: next });
      const retryAt = nowSec + Math.min(60 * 2 ** next, 1800) + (event.jitterSec ?? 0);
      return ok({ status: "RETRY_WAIT", failureClass: "business-fail", retriesUsed: next, retryAt });
    }

    case "transient_infra":
      if (a.status !== "RUNNING") return bad(`transient_infra from ${a.status}`);
      // retriesUsed UNCHANGED (VM side is already bounded by MAX_ALLOC_ATTEMPTS). There is deliberately NO per-attempt
      // "job budget exhausted" terminal event: when a RUNNING attempt's bindings are all dead with no result AND the
      // job budget is spent, the attempt stays in RETRY_WAIT (audit) and job-level termination is expressed by
      // jobStatus=failed — readyTasks won't re-dispatch it (budgetGone). The §3.1 "预算尽→FAILED" is the retryBudget
      // path inside business_fail, already implemented (fe0376cd ruling reconciling the frozen §3.1 line; Codex P2-3).
      return ok({ status: "RETRY_WAIT", failureClass: "transient-infra", retryAt: nowSec + 60 + (event.jitterSec ?? 0) });

    case "stale":
      if (a.status !== "RESULT_PENDING_VALIDATION") return bad(`stale from ${a.status}`);
      // retriesUsed UNCHANGED — input/plan changed, not the task's fault.
      return ok({ status: "ABANDONED", failureClass: "stale", abandonReason: event.which === "input" ? "stale-input" : "stale-plan" });

    case "inconsistent_snapshot":
      if (a.status !== "RESULT_PENDING_VALIDATION") return bad(`inconsistent_snapshot from ${a.status}`);
      // retriesUsed UNCHANGED — wait for the worker's frozen (milestone) snapshot.
      return ok({ status: "RUNNING", failureClass: "inconsistent-snapshot" });

    case "permanent":
      if (a.status !== "RESULT_PENDING_VALIDATION") return bad(`permanent from ${a.status}`);
      return ok({ status: "FAILED", failureClass: "permanent" });

    case "conflict":
      // §2.6: an operation conflict (control-log froze the entity) terminates the victim attempt. Legal from any live
      // state — the conflicting op could arrive while the attempt is RUNNING, pending validation, or waiting to retry.
      if (a.status !== "RUNNING" && a.status !== "RESULT_PENDING_VALIDATION" && a.status !== "RETRY_WAIT") return bad(`conflict from ${a.status}`);
      return ok({ status: "FAILED", failureClass: "permanent", ...(event.note !== undefined ? { note: event.note } : {}) });

    case "revoke":
      // Abandon a RUNNING attempt that never started executing: F1 (intent committed, startTask IO never happened —
      // recovery abandons) and supersede-cascade #2 (an un-dispatched attempt → ABANDONED(stale-input)). Legal ONLY
      // while every binding is still un-activated; an attempt with live execution must go the closing route, not here.
      // CALLER PRECONDITION (P3-1): "no activated binding" is NOT proof "nothing ran" — a box may be executing with its
      // activation ACK still in flight. The caller must hold positive evidence of not-sent / reliable alloc failure, or
      // an authorized logical-revocation basis, and must independently keep the physical-occupancy / closing / owner-
      // generation obligations; this structural guard alone does not establish non-execution.
      if (a.status !== "RUNNING") return bad(`revoke from ${a.status}`);
      if (a.executionBindings.some((b) => b.activatedAtSeq !== undefined)) return bad("revoke of an attempt with an activated binding");
      // retriesUsed UNCHANGED — nothing ran.
      return ok({ status: "ABANDONED", abandonReason: event.reason });

    case "add_binding":
      if (a.status !== "RUNNING" && a.status !== "RESULT_PENDING_VALIDATION") return bad(`add_binding from ${a.status}`);
      // attemptId / status / retriesUsed UNCHANGED (§3.2 X2) — a handoff is not a business failure.
      return ok({ executionBindings: [...a.executionBindings, event.binding] });
  }
}

export type SuccessionInput = {
  n: number;
  specDigest: string;
  inputBindings: InputBinding[];
  baseSourceCommit?: string;
  firstBinding: ExecutionBinding;
  createdAtSeq: number;
  planRevision?: number; // defaults to the old attempt's
};

export type Succession = { next: TaskAttempt; abandonedOld: TaskAttempt } | { error: string };

/** RETRY_WAIT -> a fresh RUNNING attempt that INHERITS retriesUsed (no +1), plus the old attempt turned
 *  ABANDONED(retry-succession). Caller commits both in ONE batch (§3.1). */
export function makeSuccessionAttempt(old: TaskAttempt, input: SuccessionInput): Succession {
  if (old.status !== "RETRY_WAIT") return { error: `succession from ${old.status}` };
  const next = createAttempt({
    jobId: old.jobId,
    nodeId: old.nodeId,
    planRevision: input.planRevision ?? old.planRevision,
    n: input.n,
    specDigest: input.specDigest,
    inputBindings: input.inputBindings,
    ...(input.baseSourceCommit !== undefined ? { baseSourceCommit: input.baseSourceCommit } : {}),
    firstBinding: input.firstBinding,
    createdAtSeq: input.createdAtSeq,
    retriesUsed: old.retriesUsed, // inherited, NOT +1
  });
  const abandonedOld: TaskAttempt = { ...old, status: "ABANDONED", abandonReason: "retry-succession" };
  return { next, abandonedOld };
}
