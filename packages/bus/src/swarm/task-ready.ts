/**
 * Scheduling judgments (§3.1, §4.1, §4.4) — PURE, no IO. T2. Built on the T1 modules (task-plan/state/result). The
 * whole point of this layer is that node completion / readiness / job status are DERIVED every pass from the current
 * accepted set, never stored (BLOCKED/READY are not attempt statuses — §3.1).
 *
 * The one hard rule Codex v2-P1-1 turned into a counterexample: `currentAccepted` is RECURSIVE. A node's accepted
 * result is "current" only if (a) its attempt's specDigest matches the node's CURRENT specDigest AND (b) every input
 * it was bound to is STILL the dependency's current accepted. So changing an upstream node's spec makes the upstream
 * current go null, which makes every downstream current recursively go null — no explicit cascade needed. A
 * non-recursive check (only this node's spec) lets a downstream keep consuming an upstream result whose spec changed.
 *
 * Other pinned rules:
 *  - new+old non-superseded accepted coexist ⇒ current = max decidedAtSeq (§3.1).
 *  - readyTasks step 2: an UN-expired RETRY_WAIT counts as an ACTIVE attempt (node not ready until retryAt) — this is
 *    the happycapy retrying-gate fix (prior-art §3.4).
 *  - jobStatus blocked = no ready task AND no active attempt AND not failed AND not succeeded.
 */

import type { TaskPlan, TaskSpec } from "./task-plan.js";
import { type TaskAttempt, type InputBinding, computeInputBindingDigest } from "./task-state.js";
import type { AcceptedResult } from "./task-result.js";

export type JobUsage = { totalAttempts: number; wallClockSec: number };

export type SchedInput = {
  plan: TaskPlan;
  attempts: TaskAttempt[];
  acceptedResults: AcceptedResult[];
};

export type ReadyTask = { nodeId: string; proposedBindings: InputBinding[]; inputBindingDigest: string };

export type JobStatus = { status: "running" | "succeeded" | "failed" | "blocked"; note?: string };

type Ctx = {
  plan: TaskPlan;
  nodeById: Map<string, TaskSpec>;
  attempts: TaskAttempt[];
  attemptById: Map<string, TaskAttempt>;
  acceptedByNode: Map<string, AcceptedResult[]>;
};

function buildCtx(input: SchedInput): Ctx {
  const nodeById = new Map(input.plan.nodes.map((n) => [n.nodeId, n]));
  const attemptById = new Map(input.attempts.map((a) => [a.attemptId, a]));
  const acceptedByNode = new Map<string, AcceptedResult[]>();
  for (const r of input.acceptedResults) {
    const list = acceptedByNode.get(r.nodeId) ?? [];
    list.push(r);
    acceptedByNode.set(r.nodeId, list);
  }
  return { plan: input.plan, nodeById, attempts: input.attempts, attemptById, acceptedByNode };
}

/** §3.1 recursive validity. Memoized; the plan DAG is acyclic (loadPlan guaranteed), so no cycle guard is needed. */
function currentAcceptedCtx(nodeId: string, ctx: Ctx, memo: Map<string, AcceptedResult | null>): AcceptedResult | null {
  const cached = memo.get(nodeId);
  if (cached !== undefined) return cached;

  const node = ctx.nodeById.get(nodeId);
  if (!node) return remember(memo, nodeId, null);

  // (a) non-superseded AND attempt.specDigest == the node's CURRENT specDigest.
  const candidates = (ctx.acceptedByNode.get(nodeId) ?? []).filter(
    (r) => !r.superseded && ctx.attemptById.get(r.attemptId)?.specDigest === node.specDigest,
  );
  if (candidates.length === 0) return remember(memo, nodeId, null);

  // new+old coexist ⇒ take the max decidedAtSeq.
  const r = candidates.reduce((best, c) => (c.decidedAtSeq > best.decidedAtSeq ? c : best));

  // (b) every input it was bound to must STILL be the dependency's current accepted.
  const att = ctx.attemptById.get(r.attemptId)!;
  for (const ib of att.inputBindings) {
    const depCurrent = currentAcceptedCtx(ib.depNodeId, ctx, memo);
    if (depCurrent === null || depCurrent.acceptedResultId !== ib.acceptedResultId) return remember(memo, nodeId, null);
  }
  return remember(memo, nodeId, r);
}

function remember(memo: Map<string, AcceptedResult | null>, nodeId: string, v: AcceptedResult | null): AcceptedResult | null {
  memo.set(nodeId, v);
  return v;
}

/** Resolve a node's inputBindings from its dependencies' CURRENT accepted results. Returns null if any dep has no
 *  current (node is blocked). */
function resolveInputs(node: TaskSpec, ctx: Ctx, memo: Map<string, AcceptedResult | null>): { bindings: InputBinding[]; digest: string } | null {
  const bindings: InputBinding[] = [];
  for (const dep of node.dependsOn) {
    const r = currentAcceptedCtx(dep, ctx, memo);
    if (r === null) return null;
    bindings.push({ depNodeId: dep, acceptedResultId: r.acceptedResultId, workCommit: r.observedWorkCommit, resultPath: r.resultPath });
  }
  return { bindings, digest: computeInputBindingDigest(bindings) };
}

function jobBudgetExhausted(usage: JobUsage, plan: TaskPlan): boolean {
  return usage.totalAttempts >= plan.jobBudget.maxTotalAttempts || usage.wallClockSec >= plan.jobBudget.maxWallClockSec;
}

/** A node has an active attempt when a same-task (specDigest-matching) attempt is RUNNING / RESULT_PENDING_VALIDATION
 *  / RETRY_WAIT not-yet-due. A RETRY_WAIT counts ACTIVE unless it is DEFINITELY expired (retryAt set AND now past it);
 *  an attempt with an (ill-formed) undefined retryAt is treated as active — conservative, so readyTasks never
 *  dispatches a second attempt while the old one is still RETRY_WAIT and un-superseded (fe0376cd T2 review #1, the
 *  "at most one active attempt" invariant hole; option i, matching the flat-record runtime-guard style of control.ts).
 *  advanceAttempt always writes retryAt on the RETRY_WAIT transitions, so a defined retryAt is the normal case; an
 *  EXPIRED RETRY_WAIT is the ONLY not-active RETRY_WAIT, and it is exactly the one readyTasks hands to a succession. */
function hasActiveAttempt(node: TaskSpec, ctx: Ctx, now: number): boolean {
  return ctx.attempts.some(
    (a) =>
      a.nodeId === node.nodeId &&
      a.specDigest === node.specDigest &&
      (a.status === "RUNNING" ||
        a.status === "RESULT_PENDING_VALIDATION" ||
        (a.status === "RETRY_WAIT" && !(a.retryAt !== undefined && now >= a.retryAt))),
  );
}

/** Node terminally failed (§3.1): a FAILED attempt with the current specDigest AND the input-binding digest that
 *  resolves from the CURRENT dependencies right now. A spec or input change makes an old FAILED stop blocking. */
function nodeTerminalFailed(node: TaskSpec, ctx: Ctx, memo: Map<string, AcceptedResult | null>): boolean {
  const resolved = resolveInputs(node, ctx, memo);
  if (resolved === null) return false; // blocked by deps, not terminally failed
  return ctx.attempts.some(
    (a) => a.nodeId === node.nodeId && a.status === "FAILED" && a.specDigest === node.specDigest && a.inputBindingDigest === resolved.digest,
  );
}

function nodeComplete(nodeId: string, ctx: Ctx, memo: Map<string, AcceptedResult | null>): boolean {
  return currentAcceptedCtx(nodeId, ctx, memo) !== null;
}

/** §3.1 recursive current-accepted, public single-node entry. */
export function currentAccepted(nodeId: string, input: SchedInput): AcceptedResult | null {
  return currentAcceptedCtx(nodeId, buildCtx(input), new Map());
}

/** §4.1 ready set. Pure, full recompute, plan.nodes stable order (tie-break; never timestamps). */
export function readyTasks(input: SchedInput & { now: number; jobUsage: JobUsage }): ReadyTask[] {
  const ctx = buildCtx(input);
  const memo = new Map<string, AcceptedResult | null>();
  const budgetGone = jobBudgetExhausted(input.jobUsage, input.plan);
  const out: ReadyTask[] = [];
  for (const node of input.plan.nodes) {
    if (nodeComplete(node.nodeId, ctx, memo)) continue; // 1. already complete
    if (hasActiveAttempt(node, ctx, input.now)) continue; // 2. active attempt (incl un-expired RETRY_WAIT)
    if (budgetGone || nodeTerminalFailed(node, ctx, memo)) continue; // 3. terminal / budget
    const resolved = resolveInputs(node, ctx, memo); // 4. deps all current?
    if (resolved === null) continue; // BLOCKED_BY_DEPS
    out.push({ nodeId: node.nodeId, proposedBindings: resolved.bindings, inputBindingDigest: resolved.digest }); // 5.
  }
  return out;
}

/** §4.4 job status. succeeded = all required nodes complete; failed = a required node terminally failed or the job
 *  budget is spent; blocked = nothing ready and nothing active (but not failed/succeeded); else running. */
export function jobStatus(input: SchedInput & { now: number; jobUsage: JobUsage }): JobStatus {
  const ctx = buildCtx(input);
  const memo = new Map<string, AcceptedResult | null>();
  const required = input.plan.nodes.filter((n) => n.required);

  if (required.every((n) => nodeComplete(n.nodeId, ctx, memo))) return { status: "succeeded" };

  if (jobBudgetExhausted(input.jobUsage, input.plan)) return { status: "failed", note: "job budget exhausted" };
  const failedNode = required.find((n) => !nodeComplete(n.nodeId, ctx, memo) && nodeTerminalFailed(n, ctx, memo));
  if (failedNode) return { status: "failed", note: `required node ${failedNode.nodeId} terminally failed` };

  const ready = readyTasks(input);
  const anyActive = input.plan.nodes.some((n) => hasActiveAttempt(n, ctx, input.now));
  if (ready.length === 0 && !anyActive) {
    // Name a stuck required node so ops knows WHERE it is wedged (e.g. a required node depending on a non-required
    // node that terminally failed — §4.4 leaves that to repair / a human; blocked is the signal).
    const stuck = required.find((n) => !nodeComplete(n.nodeId, ctx, memo));
    return { status: "blocked", note: `no ready task and no active attempt${stuck ? `; stuck required node ${stuck.nodeId}` : ""}` };
  }
  return { status: "running" };
}
