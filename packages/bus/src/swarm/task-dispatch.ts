/**
 * task-dispatch — the PURE dispatch-side decider for the swarm-dispatch taskPass (brain §4.5-6). Mirrors
 * dispatch-step.ts: all decisions are pure over injected/parameter inputs; scripts/swarm-dispatch.ts does the git O1
 * scan, commitControl, token mint and box IO around it.
 *
 * This file is the DISPATCH half (ready task -> what to send). The ACCEPT half (observation -> verdict -> state
 * changes) is judgeObservation, added alongside once the commit seq/event conventions are pinned. Seqs are PARAMETERS
 * (the state modules never invent seqs — the caller passes the commit seq), so this stays unit-testable offline.
 */

import type { TaskPlan } from "./task-plan.js";
import {
  type TaskAttempt, type ExecutionBinding, type AttemptEvent, type AbandonReason, attemptIdOf, bindingIdOf, createAttempt, makeSuccessionAttempt, advanceAttempt,
} from "./task-state.js";
import type { ReadyTask } from "./task-ready.js";
import { buildAssignment, tokenFits, type Assignment } from "./task-assignment.js";
import { buildDispatchIntent, type IntentTiming } from "./task-intent.js";
import { validateResult, type ValidationInput, type Verdict } from "./task-result.js";
import type { DispatchIntent, ResultObserved, ChangeBody } from "./control-log.js";

export type DispatchParams = {
  /** The fresh box's remaining life (for the token gate + the assignment soft deadline). */
  remainingLifeSec: number;
  checkpointBudgetSec: number;
  handoffMarginSec: number;
  /** Token-margin headroom (§4.5-3). */
  tokenMarginSec: number;
  /** Work budget: workDeadline = nowSec + budgetSec. */
  budgetSec: number;
  nowSec: number;
  /** The commit seq the new attempt/binding reference (caller's convention — see control-log). */
  atSeq: number;
};

export type PreparedDispatch =
  | {
      ok: true;
      attempt: TaskAttempt;
      /** Every OTHER non-terminal attempt of this node, turned ABANDONED, to commit in the SAME batch as the new attempt
       *  (§3.1 single-active per node — Codex P2 round-3): the same-identity retry source as retry-succession, a
       *  different-identity live-state as stale-plan/stale-input. Usually empty in T1 (no mid-flight identity change). */
      retired: TaskAttempt[];
      binding: ExecutionBinding;
      assignment: Assignment;
      intent: DispatchIntent;
    }
  | { ok: false; reason: string };

/**
 * Prepare ONE ready node for dispatch: pick the attempt (fresh, or a succession inheriting retriesUsed from an expired
 * RETRY_WAIT predecessor), open its first ExecutionBinding, build the assignment + the pre-IO DispatchIntent. Refuses
 * (ok:false) when the node is absent from the plan or the token would not outlive the estimated runtime + margin.
 */
export function prepareDispatch(
  plan: TaskPlan,
  ready: ReadyTask,
  attempts: TaskAttempt[],
  launchId: string,
  assignmentId: string,
  params: DispatchParams,
): PreparedDispatch {
  const spec = plan.nodes.find((n) => n.nodeId === ready.nodeId);
  if (!spec) return { ok: false, reason: `node ${ready.nodeId} not in plan` };

  const fit = tokenFits({ remainingLifeSec: params.remainingLifeSec, estimatedRuntimeSec: spec.estimatedRuntimeSec, marginSec: params.tokenMarginSec });
  if (!fit.fits) {
    return { ok: false, reason: `token margin: effective ttl ${fit.effectiveTtlSec}s < est ${spec.estimatedRuntimeSec}s + margin ${params.tokenMarginSec}s` };
  }
  // T1 cannot execute acceptance checks on the dispatcher yet (V8 command execution is T2), and observeGitFor reports a
  // non-empty acceptance as FAILED — which would burn every retry on a node that might actually pass. Refuse to dispatch
  // a node we cannot validate, rather than dispatch-and-always-fail (Codex P2). A T1 plan uses empty acceptance.
  if (spec.acceptance.length > 0) {
    return { ok: false, reason: `node ${ready.nodeId} has ${spec.acceptance.length} acceptance check(s); dispatcher-side execution is T2 — refusing to dispatch a node that cannot be validated` };
  }

  const nodeAttempts = attempts.filter((a) => a.nodeId === ready.nodeId);
  const n = nodeAttempts.length;
  const attemptId = attemptIdOf(plan.jobId, ready.nodeId, n);
  const binding: ExecutionBinding = {
    bindingId: bindingIdOf(attemptId, 0),
    assignmentId,
    launchId,
    publishGeneration: 0,
    openedAtSeq: params.atSeq,
  };
  const baseSourceCommit = spec.outputContract.baseSourceCommit;

  // retriesUsed is the LINEAGE counter of the SAME task identity — same specDigest AND same frozen inputs
  // (inputBindingDigest). A spec or input change is a NEW identity that must start fresh at 0; a node's whole-history
  // failures are NOT a shared retry pool (Codex P2-1). Cross-identity total consumption is bounded by
  // job.maxTotalAttempts, never by node-lifetime retry carry-over. Within the identity: a clean-fail (infra) retires the
  // old attempt in the SAME batch (§3.1), so the count can't live on a lingering RETRY_WAIT — take it from the durable
  // max over the SAME-IDENTITY attempts (Codex P1-1, infra failures don't consume a business retry).
  const sameIdentity = nodeAttempts.filter((a) => a.specDigest === spec.specDigest && a.inputBindingDigest === ready.inputBindingDigest);
  const lineageRetries = sameIdentity.reduce((m, a) => Math.max(m, a.retriesUsed), 0);
  // The succession source is the HIGHEST-retriesUsed expired RETRY_WAIT of THIS identity (not merely the first found, and
  // never an old-identity one — Codex P1-1/P2-1). undefined ⇒ resurrect a fresh attempt of this identity.
  const retryCandidates = sameIdentity.filter((a) => a.status === "RETRY_WAIT" && a.retryAt !== undefined && params.nowSec >= a.retryAt);
  const retryOld = retryCandidates.length ? retryCandidates.reduce((best, a) => (a.retriesUsed > best.retriesUsed ? a : best)) : undefined;
  let attempt: TaskAttempt;
  const retired: TaskAttempt[] = [];
  if (retryOld) {
    const s = makeSuccessionAttempt(retryOld, {
      n, specDigest: spec.specDigest, inputBindings: ready.proposedBindings,
      ...(baseSourceCommit !== undefined ? { baseSourceCommit } : {}),
      firstBinding: binding, createdAtSeq: params.atSeq,
    });
    if ("error" in s) return { ok: false, reason: `succession: ${s.error}` };
    attempt = s.next;
    retired.push(s.abandonedOld);
  } else {
    attempt = createAttempt({
      jobId: plan.jobId, nodeId: ready.nodeId, n, planRevision: plan.planRevision, specDigest: spec.specDigest,
      inputBindings: ready.proposedBindings,
      ...(baseSourceCommit !== undefined ? { baseSourceCommit } : {}),
      firstBinding: binding, createdAtSeq: params.atSeq,
      // Resurrect the lineage count after a clean-fail retired the prior attempt(s) (no live RETRY_WAIT to inherit from).
      ...(lineageRetries > 0 ? { retriesUsed: lineageRetries } : {}),
    });
  }

  // §3.1 single-active per node (identity-agnostic, fe0376cd): retire EVERY OTHER non-terminal attempt in THIS batch — a
  // different-identity live-state as stale (stale-plan if the spec changed, else stale-input), any same-identity leftover
  // as retry-succession. No count flows from a stale identity (lineageRetries is already identity-scoped). The full
  // supersede cascade (scrubbing the orphan box) is T2; this only keeps the control state single-active.
  for (const a of nodeAttempts) {
    if (retryOld && a.attemptId === retryOld.attemptId) continue; // already retired by the succession above
    if (a.status !== "RUNNING" && a.status !== "RESULT_PENDING_VALIDATION" && a.status !== "RETRY_WAIT") continue; // terminal
    const reason: AbandonReason = a.specDigest !== spec.specDigest ? "stale-plan" : a.inputBindingDigest !== ready.inputBindingDigest ? "stale-input" : "retry-succession";
    retired.push({ ...a, status: "ABANDONED", abandonReason: reason });
  }

  const assignment = buildAssignment({
    attempt, spec, binding,
    remainingLifeSec: params.remainingLifeSec, checkpointBudgetSec: params.checkpointBudgetSec, handoffMarginSec: params.handoffMarginSec,
  });
  const timing: IntentTiming = { allocRequestStartSec: params.nowSec, workDeadlineSec: params.nowSec + params.budgetSec };
  const intent = buildDispatchIntent(assignment, timing);

  return { ok: true, attempt, retired, binding, assignment, intent };
}

// ---- the ACCEPT half: an observed candidate -> verdict -> state changes (§4.2 / §4.5-6) -------------------------------

export type JudgeInput = {
  /** Everything validateResult needs (the shell gathers the git/acceptance IO facts). */
  validation: ValidationInput;
  /** The full {put:"observed"} payload the shell built from the git observation (recorded on accept/reject/stale). */
  observed: ResultObserved;
  nowSec: number;
  /** Commit seq for the {put:"rejected"} audit entity key (caller convention). */
  atSeq: number;
  /** business_fail backoff jitter — the caller samples it ONCE and persists it so a replay reuses the same value. */
  jitterSec?: number;
};

export type JudgeOutput = {
  verdict: Verdict;
  /** ChangeBodies to commit (the shell stamps operationId + expectedEntityRevision — its commit conventions). Empty for
   *  a candidate-level discard / an idempotent replay. */
  changes: ChangeBody[];
  /** The transitioned attempt (accept/reject/stale/inconsistent-snapshot); absent for discard/replay. */
  nextAttempt?: TaskAttempt;
  /** Set when a required state transition was illegal (e.g. a candidate validated against an already-terminal attempt);
   *  the shell logs it and makes no change. */
  error?: string;
};

/** Map a Verdict to the attempt event that realizes it (null = candidate-level, attempt untouched). validateResult
 *  never emits a reject with failureClass "transient-infra" (that is the no-result/all-dead path, not a validation),
 *  so only business-fail / permanent / inconsistent-snapshot appear here. */
function verdictEvent(v: Verdict, retryBudget: number, jitterSec?: number): AttemptEvent | null {
  switch (v.decision) {
    case "accept": return { type: "accepted" };
    case "stale": return { type: "stale", which: v.which };
    case "reject":
      if (v.failureClass === "permanent") return { type: "permanent" };
      if (v.failureClass === "inconsistent-snapshot") return { type: "inconsistent_snapshot" };
      return { type: "business_fail", retryBudget, ...(jitterSec !== undefined ? { jitterSec } : {}) };
    case "discard":
    case "replay":
      return null;
  }
}

/**
 * Judge one observed candidate: validate it, then (for accept/reject/stale) move the attempt RUNNING -> RPV (the
 * `observed` transition advanceAttempt requires) and apply the verdict in the SAME pass, emitting ONE {put:"attempt"}
 * with the final state (observe + validate are synchronous here, so the intermediate RPV never needs its own commit).
 * A candidate-level discard or an idempotent replay touches nothing.
 */
export function judgeObservation(i: JudgeInput): JudgeOutput {
  const verdict = validateResult(i.validation);
  const attempt = i.validation.attempt;
  const event = verdictEvent(verdict, i.validation.attemptSpec.retryBudget, i.jitterSec);
  if (event === null) return { verdict, changes: [] }; // discard / replay — attempt untouched

  // RUNNING -> RPV (no-op if already RPV), then the verdict transition.
  const toRpv = advanceAttempt(attempt, { type: "observed" }, i.nowSec);
  if (!toRpv.ok) return { verdict, changes: [], error: `pre-validation transition: ${toRpv.error}` };
  const final = advanceAttempt(toRpv.attempt, event, i.nowSec);
  if (!final.ok) return { verdict, changes: [], error: `verdict transition: ${final.error}` };

  const changes: ChangeBody[] = [{ put: "observed", observed: i.observed }];
  if (verdict.decision === "accept") changes.push({ put: "accepted", accepted: verdict.accepted });
  changes.push({ put: "attempt", attempt: final.attempt });
  if (verdict.decision === "reject" || verdict.decision === "stale") {
    changes.push({ put: "rejected", rejected: { attemptId: attempt.attemptId, nodeId: attempt.nodeId, reason: verdict.reason, atSeq: i.atSeq } });
  }
  return { verdict, changes, nextAttempt: final.attempt };
}
