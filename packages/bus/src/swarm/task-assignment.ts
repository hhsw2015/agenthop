/**
 * task-assignment — the dispatcher-side PURE projection of a ready attempt into the exact JSON a box receives at
 * /root/.swarm/assignment.json (brain §4.5-1). No IO: the dispatcher mints the token, scps the file and starts the
 * worker; this module only DERIVES the bytes + their digest.
 *
 * Why pure + deterministic: a RESEND (F3 重发 = 同 intentId/同 binding/同 box 的原字节重送) MUST reuse the stored
 * assignment bytes, and the DispatchIntent pins `assignmentDigest` to detect "same vs different" send. So for fixed
 * inputs the digest is byte-stable, it does NOT hash itself, and it DOES hash the softDeadline (a later rebuild with a
 * shorter remaining life yields a different digest — which is exactly why the dispatcher replays the stored assignment
 * on a resend instead of rebuilding it).
 *
 * NON-GOAL: the CPA token (rides a separate 0600 worker-env file, never argv/assignment — §4.5-3, Codex #6) and the
 * DispatchIntent record (control-log.ts). This module stops at "what task, bound to which box, due when".
 */

import { digestOf } from "./digest.js";
import type { InputBinding, ExecutionBinding, TaskAttempt } from "./task-state.js";
import type { TaskSpec, OutputContract } from "./task-plan.js";
import { VALIDATOR_VERSION } from "./task-result.js";
import { MAX_TTL_SEC } from "./mint.js";

export type Assignment = {
  /** = DispatchIntent.intentId = binding.assignmentId. One assignment ⇔ one intent ⇔ one (box, attempt) send. */
  assignmentId: string;
  jobId: string;
  planRevision: number;
  nodeId: string;
  attemptId: string;
  /** The ExecutionBinding this send realizes (§2.3 seam). */
  bindingId: string;
  /** Target box + the generation it must publish under (the dispatcher's ancestry/command gate keys on generation). */
  launchId: string;
  generation: number;
  goal: string;
  /** Frozen dependency inputs: each carries workCommit (a fixed SHA, branch-independent) + resultPath to materialize. */
  inputBindings: InputBinding[];
  inputBindingDigest: string;
  outputContract: OutputContract;
  /** Allowed WORK artifact path prefixes. */
  artifactScope: string[];
  /** kind=patch: SOURCE path prefixes the patch may touch (omitted for non-patch nodes). */
  sourceWriteScope?: string[];
  /** kind=patch: the fixed base commit the patch applies to (V7 `git apply --check`); omitted when none. */
  baseSourceCommit?: string;
  /** Where the worker writes its result (§4.5-4): out/results/<attemptId>/result.json, relative to the WORK repo. */
  resultPath: string;
  /** O2 result-retention contract: once published the worker must NOT mutate result files (X7 / §4.5-4 freeze). */
  o2ResultRetention: "freeze-after-publish";
  /** The result-schema contract version the box/worker must emit (task-result.ts VALIDATOR_VERSION). */
  validatorVersion: string;
  /** Soft work deadline in seconds: 剩余寿命 - checkpoint 预算 - handoff 余量 (§4.5-1). Drives the worker's own
   *  drain/checkpoint pacing; it is NOT a physical-death signal (that is the lifecycle layer's physicalExpiresAtSec). */
  softDeadlineSec: number;
  /** canonical-JSON SHA-256 of every field above (never itself). */
  assignmentDigest: string;
};

export type BuildAssignmentInput = {
  attempt: TaskAttempt;
  spec: TaskSpec;
  binding: ExecutionBinding;
  /** The box's remaining life at dispatch (lifecycle layer's estimate), in seconds. */
  remainingLifeSec: number;
  /** Reserved time for the worker's final checkpoint before the box dies, in seconds. */
  checkpointBudgetSec: number;
  /** Reserved time for a handoff to a successor box, in seconds. */
  handoffMarginSec: number;
};

/** softDeadline = remainingLife - checkpointBudget - handoffMargin, clamped to ≥ 0 (never a negative deadline). */
export function computeSoftDeadlineSec(remainingLifeSec: number, checkpointBudgetSec: number, handoffMarginSec: number): number {
  return Math.max(0, Math.floor(remainingLifeSec - checkpointBudgetSec - handoffMarginSec));
}

export function buildAssignment(i: BuildAssignmentInput): Assignment {
  const { attempt, spec, binding } = i;
  const baseSourceCommit = attempt.baseSourceCommit ?? spec.outputContract.baseSourceCommit;
  // Build the digested CORE first (conditional fields omitted, never set to undefined, so the digest is stable and
  // equals digestOf(returned-assignment-minus-digest) exactly), then stamp the digest.
  const core = {
    assignmentId: binding.assignmentId,
    jobId: attempt.jobId,
    planRevision: attempt.planRevision,
    nodeId: attempt.nodeId,
    attemptId: attempt.attemptId,
    bindingId: binding.bindingId,
    launchId: binding.launchId,
    generation: binding.publishGeneration,
    goal: spec.goal,
    inputBindings: attempt.inputBindings,
    inputBindingDigest: attempt.inputBindingDigest,
    outputContract: spec.outputContract,
    artifactScope: spec.artifactScope,
    ...(spec.sourceWriteScope !== undefined ? { sourceWriteScope: spec.sourceWriteScope } : {}),
    ...(baseSourceCommit !== undefined ? { baseSourceCommit } : {}),
    resultPath: `out/results/${attempt.attemptId}/result.json`,
    o2ResultRetention: "freeze-after-publish" as const,
    validatorVersion: VALIDATOR_VERSION,
    softDeadlineSec: computeSoftDeadlineSec(i.remainingLifeSec, i.checkpointBudgetSec, i.handoffMarginSec),
  };
  return { ...core, assignmentDigest: digestOf(core) };
}

export type TokenFitInput = {
  /** The box's remaining life at dispatch, in seconds (caps the token TTL). */
  remainingLifeSec: number;
  estimatedRuntimeSec: number;
  /** Headroom so a task that overruns its estimate still has a live token (§4.5-3). */
  marginSec: number;
};
export type TokenFit = { fits: boolean; effectiveTtlSec: number };

/**
 * Pre-dispatch token-margin gate (§4.5-3): the ephemeral CPA token lives at most min(remainingLife, MAX_TTL_SEC=3600,
 * the Railway box's own life). Only dispatch if that effective life covers the estimated runtime plus a margin — a
 * token expiring mid-task means 401s, not a crash (F14), so we refuse rather than burn a box on a doomed run.
 */
export function tokenFits(i: TokenFitInput): TokenFit {
  const effectiveTtlSec = Math.min(Math.max(0, Math.floor(i.remainingLifeSec)), MAX_TTL_SEC);
  return { fits: effectiveTtlSec >= i.estimatedRuntimeSec + i.marginSec, effectiveTtlSec };
}
