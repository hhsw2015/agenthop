/**
 * taskPass — the business-task orchestration pass (brain §4.5-6). Runs AFTER the lifecycle handoff pass each dispatcher
 * round: (accept) O1-observe each live attempt's WORK branch, validate a candidate, commit the verdict; (dispatch) take
 * the ready set, prepare each, commit the DispatchIntent + attempt, THEN do the box IO (CAS-then-IO), commit the alloc
 * outcome. All decisions are the pure deciders (task-dispatch / task-result / task-ready); all IO is behind an injected
 * TaskOps, so the ORDERING that matters (commit-before-IO, accept-before-dispatch) is unit-testable offline. The real
 * git/mint/scp/launch IO is wired in scripts/swarm-dispatch.ts.
 */

import type { TaskPlan, TaskSpec } from "./task-plan.js";
import type { TaskAttempt, ExecutionBinding } from "./task-state.js";
import { readyTasks, jobStatus, currentAccepted, type SchedInput, type JobUsage } from "./task-ready.js";
import { computeResultClosureDigest, type ValidationInput, type AcceptedResult } from "./task-result.js";
import { prepareDispatch, judgeObservation, type DispatchParams } from "./task-dispatch.js";
import { resolveAllocOutcome, abandonIntent, confirmIntent } from "./task-intent.js";
import type { Assignment } from "./task-assignment.js";
import { liveEntities, type LogState, type ChangeBody, type CommitResult, type ResultObserved } from "./control-log.js";

/** The git/acceptance facts O1 reads off a candidate's WORK branch tip (everything in ValidationInput that needs IO). */
export type GitFacts = {
  observedWorkCommit: string;
  resultText: string;
  resultBlobOid: string;
  closureFiles: Array<{ path: string; blobOid: string }>;
  cumulativeChangedPaths: string[];
  contract: { requiredOutputsPresent: boolean; patchAppliesClean: boolean };
  acceptancePassed: boolean;
  patchDiffPaths?: string[];
  withinCutoffAncestry: boolean;
};

export type TaskOps = {
  nowSec: () => number;
  cap: number;
  budgetSec: number;
  remainingLifeSec: number;
  checkpointBudgetSec: number;
  handoffMarginSec: number;
  tokenMarginSec: number;
  jitterSec: () => number;
  newLaunchId: () => string;
  /** Read the current control-log projection state. */
  loadState: () => LogState;
  /** Stamp operationId + expectedEntityRevision per body, persist the batch (atomic), return the new state. */
  commit: (state: LogState, bodies: ChangeBody[]) => { state: LogState; result: CommitResult };
  /** O1: observe a binding's WORK branch for a result candidate. null = no candidate / query error (stay put). */
  observeGit: (a: { attempt: TaskAttempt; spec: TaskSpec; binding: ExecutionBinding }) => Promise<GitFacts | null>;
  /** startTask IO: mint token + scp assignment/worker-env + swarm-launch allocate-only + swarm-task --task. */
  startTask: (a: { assignment: Assignment; launchId: string }) => Promise<"created" | "clean-fail" | "unknown">;
  log: (m: string) => void;
};

/** attempts + acceptedResults projected from the control-log for the scheduler (pure). */
export function buildSched(plan: TaskPlan, state: LogState): SchedInput {
  const attempts: TaskAttempt[] = [];
  const acceptedResults: AcceptedResult[] = [];
  for (const body of Object.values(liveEntities(state))) {
    if (body.put === "attempt") attempts.push(body.attempt);
    else if (body.put === "accepted") acceptedResults.push(body.accepted);
  }
  return { plan, attempts, acceptedResults };
}

/** A box-occupying attempt (RUNNING / RESULT_PENDING_VALIDATION) holds a slot. */
function occupied(attempts: TaskAttempt[]): number {
  return attempts.filter((a) => a.status === "RUNNING" || a.status === "RESULT_PENDING_VALIDATION").length;
}

function branchOf(binding: ExecutionBinding): string {
  return `swarm/${binding.launchId}-g${binding.publishGeneration}`;
}

/** The newest OPEN binding of an attempt (the one currently executing / publishing). */
function liveBinding(a: TaskAttempt): ExecutionBinding | undefined {
  for (let i = a.executionBindings.length - 1; i >= 0; i--) {
    const b = a.executionBindings[i]!;
    if (b.closedAtSeq === undefined) return b;
  }
  return undefined;
}

export async function taskPass(plan: TaskPlan, ops: TaskOps): Promise<void> {
  let state = ops.loadState();
  const specById = new Map(plan.nodes.map((n) => [n.nodeId, n]));

  // ---- ACCEPT: O1-observe each live attempt's branch, validate, commit the verdict -----------------------------------
  const sched0 = buildSched(plan, state);
  for (const attempt of sched0.attempts) {
    if (attempt.status !== "RUNNING" && attempt.status !== "RESULT_PENDING_VALIDATION") continue;
    const spec = specById.get(attempt.nodeId);
    const binding = liveBinding(attempt);
    if (!spec || !binding) continue;
    let facts: GitFacts | null = null;
    try { facts = await ops.observeGit({ attempt, spec, binding }); }
    catch (e) { ops.log(`observeGit ${attempt.attemptId} error: ${e instanceof Error ? e.message : e}`); continue; }
    if (!facts) continue;

    // Pure facts from the current projection (not IO): V4 dep currents, V5 current specDigest, V6 existing accepted.
    const schedNow = buildSched(plan, state);
    const currentSpecDigest = specById.get(attempt.nodeId)?.specDigest ?? null;
    const currentDepResults: Record<string, string | null> = {};
    for (const dep of spec.dependsOn) currentDepResults[dep] = currentAccepted(dep, schedNow)?.acceptedResultId ?? null;
    const existing = currentAccepted(attempt.nodeId, schedNow);
    const existingAccepted = existing ? { acceptedResultId: existing.acceptedResultId, resultClosureDigest: existing.resultClosureDigest } : null;

    const decidedAtSeq = state.seq + 1;
    const candidateClosureDigest = computeResultClosureDigest({ resultBlobOid: facts.resultBlobOid, referencedFiles: facts.closureFiles });
    const validation: ValidationInput = {
      resultText: facts.resultText, source: "milestone", attempt, attemptSpec: spec,
      currentSpecDigest, currentDepResults,
      observed: { launchId: binding.launchId, generation: binding.publishGeneration, workCommit: facts.observedWorkCommit, resultBlobOid: facts.resultBlobOid, resultPath: `out/results/${attempt.attemptId}/result.json` },
      withinCutoffAncestry: facts.withinCutoffAncestry, candidateClosureDigest, existingAccepted,
      contract: facts.contract, acceptancePassed: facts.acceptancePassed,
      ...(facts.patchDiffPaths !== undefined ? { patchDiffPaths: facts.patchDiffPaths } : {}),
      cumulativeChangedPaths: facts.cumulativeChangedPaths, decidedAtSeq,
    };
    const observed: ResultObserved = {
      observedId: `${attempt.attemptId}/g${binding.publishGeneration}/${facts.observedWorkCommit}`,
      attemptId: attempt.attemptId, nodeId: attempt.nodeId, bindingId: binding.bindingId, launchId: binding.launchId,
      generation: binding.publishGeneration, observedWorkCommit: facts.observedWorkCommit, resultPath: validation.observed.resultPath,
      resultBlobOid: facts.resultBlobOid, closureFiles: facts.closureFiles,
    };
    const out = judgeObservation({ validation, observed, nowSec: ops.nowSec(), atSeq: decidedAtSeq, jitterSec: ops.jitterSec() });
    if (out.error) { ops.log(`judge ${attempt.attemptId}: ${out.error}`); continue; }
    if (out.changes.length === 0) continue; // candidate-level discard / idempotent replay
    const r = ops.commit(state, out.changes);
    state = r.state;
    ops.log(`task accept-pass ${attempt.attemptId}: ${out.verdict.decision}`);
  }

  // ---- DISPATCH: ready set -> prepare -> commit intent+attempt (CAS) -> box IO -> commit outcome --------------------
  const sched = buildSched(plan, state);
  const usage: JobUsage = { totalAttempts: sched.attempts.length, wallClockSec: 0 };
  const ready = readyTasks({ ...sched, now: ops.nowSec(), jobUsage: usage });
  let free = Math.max(0, ops.cap - occupied(sched.attempts));
  for (const task of ready) {
    if (free <= 0) { ops.log(`dispatch: cap reached, ${ready.length} ready deferred`); break; }
    const launchId = ops.newLaunchId();
    const assignmentId = `${launchId}@${task.nodeId}`;
    const params: DispatchParams = {
      remainingLifeSec: ops.remainingLifeSec, checkpointBudgetSec: ops.checkpointBudgetSec, handoffMarginSec: ops.handoffMarginSec,
      tokenMarginSec: ops.tokenMarginSec, budgetSec: ops.budgetSec, nowSec: ops.nowSec(), atSeq: state.seq + 1,
    };
    const prep = prepareDispatch(plan, task, buildSched(plan, state).attempts, launchId, assignmentId, params);
    if (!prep.ok) { ops.log(`dispatch ${task.nodeId}: skipped — ${prep.reason}`); continue; }

    // CAS-then-IO: persist the intent (pending) + the attempt BEFORE the allocate IO, so a crash leaves a reconcilable
    // record, never a silent box with no intent. Abandoned-old (retry succession) rides the SAME batch (§3.1).
    const preBodies: ChangeBody[] = [{ put: "intent", intent: prep.intent }, { put: "attempt", attempt: prep.attempt }];
    if (prep.abandonedOld) preBodies.push({ put: "attempt", attempt: prep.abandonedOld });
    state = ops.commit(state, preBodies).state;

    const outcome = await ops.startTask({ assignment: prep.assignment, launchId });
    const resolved = resolveAllocOutcome(prep.intent, outcome, { nowSec: ops.nowSec() });
    // created => confirm the dispatch; clean-fail => abandon the intent AND revoke the never-run attempt (F1); unknown =>
    // leave pending/unknown (conservative occupancy, reconciled by observing the WORK branch).
    const postBodies: ChangeBody[] = [{ put: "intent", intent: outcome === "created" ? confirmIntent(resolved) : outcome === "clean-fail" ? abandonIntent(resolved) : resolved }];
    if (outcome === "clean-fail") {
      postBodies.push({ put: "attempt", attempt: { ...prep.attempt, status: "ABANDONED", abandonReason: "intent-revoked" } });
      free += 1; // the slot was never taken
    }
    state = ops.commit(state, postBodies).state;
    free -= 1;
    ops.log(`dispatch ${task.nodeId}: ${launchId} alloc=${outcome}`);
  }

  const status = jobStatus({ ...buildSched(plan, state), now: ops.nowSec(), jobUsage: { totalAttempts: buildSched(plan, state).attempts.length, wallClockSec: 0 } });
  ops.log(`job ${plan.jobId}: ${status.status}${status.note ? ` (${status.note})` : ""}`);
}
