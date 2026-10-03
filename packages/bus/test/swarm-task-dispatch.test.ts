import { describe, expect, test } from "vitest";
import { loadPlan, type TaskPlan, type TaskSpec } from "../src/swarm/task-plan.js";
import { createAttempt, computeInputBindingDigest, type InputBinding, type ExecutionBinding, type TaskAttempt } from "../src/swarm/task-state.js";
import type { ReadyTask } from "../src/swarm/task-ready.js";
import type { ValidationInput } from "../src/swarm/task-result.js";
import type { ResultObserved } from "../src/swarm/control-log.js";
import { prepareDispatch, judgeObservation, type DispatchParams } from "../src/swarm/task-dispatch.js";

function buildPlan(nodeOver: Record<string, unknown> = {}): TaskPlan {
  const res = loadPlan({
    jobId: "job", planRevision: 1,
    nodes: [{
      nodeId: "build", kind: "work", goal: "do it", dependsOn: [],
      outputContract: { requiredOutputs: [{ logicalName: "r", kind: "report" }] },
      acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 1800, retryBudget: 2,
      required: true, runtime: "ephemeral", ...nodeOver,
    }],
    jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 100000 },
  });
  if (!res.ok) throw new Error(res.reason);
  return res.plan;
}

const READY: ReadyTask = { nodeId: "build", proposedBindings: [], inputBindingDigest: computeInputBindingDigest([]) };
const P: DispatchParams = { remainingLifeSec: 3000, checkpointBudgetSec: 300, handoffMarginSec: 180, tokenMarginSec: 600, budgetSec: 3480, nowSec: 1000, atSeq: 5 };

describe("prepareDispatch — fresh attempt", () => {
  const plan = buildPlan();
  const r = prepareDispatch(plan, READY, [], "rw-abc", "asg-1", P);
  test("creates a0 + binding b0 + assignment + pending intent, seqs from the param", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempt.attemptId).toBe("job/build/a0");
    expect(r.attempt.status).toBe("RUNNING");
    expect(r.attempt.createdAtSeq).toBe(5);
    expect(r.abandonedOld).toBeUndefined();
    expect(r.binding.bindingId).toBe("job/build/a0/b0");
    expect(r.binding.launchId).toBe("rw-abc");
    expect(r.binding.publishGeneration).toBe(0);
    expect(r.binding.openedAtSeq).toBe(5);
    expect(r.assignment.assignmentId).toBe("asg-1");
    expect(r.assignment.launchId).toBe("rw-abc");
    expect(r.assignment.softDeadlineSec).toBe(2520);
    expect(r.assignment.planRevision).toBe(1);
    expect(r.intent.intentId).toBe("asg-1");
    expect(r.intent.allocOutcome).toBe("pending");
    expect(r.intent.status).toBe("pending");
    expect(r.intent.workDeadlineSec).toBe(1000 + 3480);
    expect(r.intent.assignmentDigest).toBe(r.assignment.assignmentDigest);
  });
});

describe("prepareDispatch — refusals", () => {
  test("token margin: a box too short-lived for est + margin is refused", () => {
    const r = prepareDispatch(buildPlan(), READY, [], "rw-abc", "asg-1", { ...P, remainingLifeSec: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("token margin");
  });
  test("a node absent from the plan is refused", () => {
    const r = prepareDispatch(buildPlan(), { nodeId: "ghost", proposedBindings: [], inputBindingDigest: "x" }, [], "rw", "asg", P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not in plan");
  });
  test("a node with non-empty acceptance is refused (T1 can't execute checks — Codex P2)", () => {
    const r = prepareDispatch(buildPlan({ acceptance: [{ check: "tests-pass" }] }), READY, [], "rw", "asg", P);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("acceptance");
  });
});

describe("prepareDispatch — retry succession", () => {
  const plan = buildPlan();
  const a0 = createAttempt({
    jobId: "job", nodeId: "build", n: 0, planRevision: 1, specDigest: plan.nodes[0]!.specDigest, inputBindings: [],
    firstBinding: { bindingId: "job/build/a0/b0", assignmentId: "asg-0", launchId: "rw-old", publishGeneration: 0, openedAtSeq: 1 },
    createdAtSeq: 1,
  });
  const expiredRetry: TaskAttempt = { ...a0, status: "RETRY_WAIT", retryAt: 500, retriesUsed: 1 };

  test("an expired RETRY_WAIT predecessor ⇒ a1 inheriting retriesUsed + the old abandoned", () => {
    const r = prepareDispatch(plan, READY, [expiredRetry], "rw-new", "asg-2", P); // nowSec 1000 > retryAt 500
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempt.attemptId).toBe("job/build/a1");
    expect(r.attempt.status).toBe("RUNNING");
    expect(r.attempt.retriesUsed).toBe(1); // inherited, NOT +1
    expect(r.abandonedOld?.status).toBe("ABANDONED");
    expect(r.abandonedOld?.abandonReason).toBe("retry-succession");
  });
});

// ---- judgeObservation (accept half) ---------------------------------------------------------------------------------

function judgeSpec(): TaskSpec {
  const res = loadPlan({
    jobId: "job", planRevision: 1,
    nodes: [
      { nodeId: "C", kind: "work", goal: "c", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 60, retryBudget: 2 },
      { nodeId: "P", kind: "work", goal: "p", dependsOn: ["C"], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2 },
    ],
    jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
  });
  if (!res.ok) throw new Error(res.reason);
  return res.plan.nodes.find((n) => n.nodeId === "P")!;
}
const JSPEC = judgeSpec();
const ibC: InputBinding = { depNodeId: "C", acceptedResultId: "job/C/a1/r1", workCommit: "cc0", resultPath: "out/results/job/C/a1/result.json" };
const JBIND: ExecutionBinding = { bindingId: "job/P/a1/b0", assignmentId: "as0", launchId: "rw-1", publishGeneration: 0, openedAtSeq: 100 };
const JATT: TaskAttempt = createAttempt({ jobId: "job", nodeId: "P", n: 1, planRevision: 1, specDigest: JSPEC.specDigest, inputBindings: [ibC], firstBinding: JBIND, createdAtSeq: 100 });
const OBSERVED: ResultObserved = {
  observedId: "obs1", attemptId: JATT.attemptId, nodeId: "P", bindingId: "job/P/a1/b0", launchId: "rw-1", generation: 0,
  observedWorkCommit: "wc9", resultPath: "out/results/job/P/a1/result.json", resultBlobOid: "blob1", closureFiles: [{ path: "out/report.md", blobOid: "b2" }],
};
function jResult(p: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, jobId: "job", planRevision: 1, nodeId: "P", attemptId: JATT.attemptId, assignmentId: "as0", inputBindingDigest: JATT.inputBindingDigest, outcome: "success", outputs: [{ logicalName: "o", kind: "report", path: "out/report.md" }], validationEvidence: [], ...p });
}
function jvin(over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    resultText: jResult(), source: "milestone", attempt: JATT, attemptSpec: JSPEC, currentSpecDigest: JSPEC.specDigest,
    currentDepResults: { C: "job/C/a1/r1" },
    observed: { launchId: "rw-1", generation: 0, workCommit: "wc9", resultBlobOid: "blob1", resultPath: "out/results/job/P/a1/result.json" },
    withinCutoffAncestry: true, candidateClosureDigest: "cd1", existingAccepted: null,
    contract: { requiredOutputsPresent: true, patchAppliesClean: true }, acceptancePassed: true,
    cumulativeChangedPaths: ["out/results/job/P/a1/result.json", "out/report.md"], decidedAtSeq: 200, ...over,
  };
}
const puts = (o: { changes: Array<{ put: string }> }): string[] => o.changes.map((c) => c.put);

describe("judgeObservation — accept", () => {
  test("RUNNING -> SUCCEEDED, emits observed + accepted + attempt", () => {
    const o = judgeObservation({ validation: jvin(), observed: OBSERVED, nowSec: 1000, atSeq: 201 });
    expect(o.verdict.decision).toBe("accept");
    expect(puts(o)).toEqual(["observed", "accepted", "attempt"]);
    expect(o.nextAttempt?.status).toBe("SUCCEEDED");
    expect(o.error).toBeUndefined();
  });
});

describe("judgeObservation — reject (outcome=failure ⇒ business-fail ⇒ RETRY_WAIT)", () => {
  test("emits observed + attempt(RETRY_WAIT) + rejected audit", () => {
    const o = judgeObservation({ validation: jvin({ resultText: jResult({ outcome: "failure", failureReason: "boom" }) }), observed: OBSERVED, nowSec: 1000, atSeq: 201, jitterSec: 0 });
    expect(o.verdict.decision).toBe("reject");
    expect(puts(o)).toEqual(["observed", "attempt", "rejected"]);
    expect(o.nextAttempt?.status).toBe("RETRY_WAIT");
    expect(o.nextAttempt?.retriesUsed).toBe(1);
  });
});

describe("judgeObservation — stale (node removed ⇒ V5 plan)", () => {
  test("RUNNING -> ABANDONED(stale-plan), emits rejected audit", () => {
    const o = judgeObservation({ validation: jvin({ currentSpecDigest: null }), observed: OBSERVED, nowSec: 1000, atSeq: 201 });
    expect(o.verdict.decision).toBe("stale");
    expect(o.nextAttempt?.status).toBe("ABANDONED");
    expect(o.nextAttempt?.abandonReason).toBe("stale-plan");
    expect(puts(o)).toContain("rejected");
  });
});

describe("judgeObservation — candidate-level discard touches nothing", () => {
  test("wrong binding (V3) ⇒ no changes, attempt untouched", () => {
    const o = judgeObservation({ validation: jvin({ observed: { launchId: "rw-x", generation: 0, workCommit: "w", resultBlobOid: "b", resultPath: "out/results/job/P/a1/result.json" } }), observed: OBSERVED, nowSec: 1000, atSeq: 201 });
    expect(o.verdict.decision).toBe("discard");
    expect(o.changes).toEqual([]);
    expect(o.nextAttempt).toBeUndefined();
  });
});
