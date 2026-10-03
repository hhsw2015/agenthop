import { describe, expect, test } from "vitest";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import { createAttempt, computeInputBindingDigest, type TaskAttempt } from "../src/swarm/task-state.js";
import type { ReadyTask } from "../src/swarm/task-ready.js";
import { prepareDispatch, type DispatchParams } from "../src/swarm/task-dispatch.js";

function buildPlan(nodeOver: Record<string, unknown> = {}): TaskPlan {
  const res = loadPlan({
    jobId: "job", planRevision: 1,
    nodes: [{
      nodeId: "build", kind: "work", goal: "do it", dependsOn: [],
      outputContract: { requiredOutputs: [{ logicalName: "r", kind: "report" }] },
      acceptance: [{ check: "c" }], artifactScope: ["out/"], estimatedRuntimeSec: 1800, retryBudget: 2,
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
