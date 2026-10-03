import { describe, expect, test } from "vitest";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import { createAttempt, type TaskAttempt, type InputBinding, type ExecutionBinding, type AttemptStatus } from "../src/swarm/task-state.js";
import type { AcceptedResult } from "../src/swarm/task-result.js";
import { currentAccepted, readyTasks, jobStatus, type JobUsage } from "../src/swarm/task-ready.js";

const ZERO: JobUsage = { totalAttempts: 0, wallClockSec: 0 };

function node(id: string, deps: string[] = [], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { nodeId: id, kind: "work", goal: `g-${id}`, dependsOn: deps, outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 60, retryBudget: 2, ...over };
}
function buildPlan(nodes: Record<string, unknown>[], jobBudget = { maxTotalAttempts: 100, maxWallClockSec: 1_000_000 }): TaskPlan {
  const res = loadPlan({ jobId: "job", planRevision: 1, nodes, jobBudget });
  if (!res.ok) throw new Error(res.reason);
  return res.plan;
}
function specDigest(plan: TaskPlan, nodeId: string): string {
  return plan.nodes.find((n) => n.nodeId === nodeId)!.specDigest;
}
function bind(nodeId: string, n: number): ExecutionBinding {
  return { bindingId: `job/${nodeId}/a${n}/b0`, assignmentId: "as", launchId: `rw-${nodeId}${n}`, publishGeneration: 0, openedAtSeq: 1 };
}
function att(plan: TaskPlan, nodeId: string, n: number, inputs: InputBinding[], status: AttemptStatus = "SUCCEEDED", over: Partial<TaskAttempt> = {}): TaskAttempt {
  const a = createAttempt({ jobId: "job", nodeId, n, planRevision: 1, specDigest: specDigest(plan, nodeId), inputBindings: inputs, firstBinding: bind(nodeId, n), createdAtSeq: 1 });
  return { ...a, status, ...over };
}
function acc(nodeId: string, n: number, decidedAtSeq: number, over: Partial<AcceptedResult> = {}): AcceptedResult {
  const attemptId = `job/${nodeId}/a${n}`;
  return {
    acceptedResultId: `${attemptId}/r1`, attemptId, nodeId, jobId: "job", planRevision: 1,
    observedWorkCommit: `wc-${nodeId}${n}`, resultPath: `out/results/${attemptId}/result.json`,
    resultBlobOid: "b", resultClosureDigest: "c", inputBindingDigest: "d", validatorVersion: "brain-v1",
    decision: "accepted", decidedAtSeq, ...over,
  };
}
function boundTo(a: AcceptedResult): InputBinding {
  return { depNodeId: a.nodeId, acceptedResultId: a.acceptedResultId, workCommit: a.observedWorkCommit, resultPath: a.resultPath };
}
const ids = (rts: { nodeId: string }[]): string[] => rts.map((r) => r.nodeId);

function diamond(): TaskPlan {
  return buildPlan([node("C"), node("P", ["C"]), node("Q", ["C"]), node("I", ["P", "Q"], { kind: "integration" })]);
}

describe("diamond progression (§4.1)", () => {
  const plan = diamond();
  test("nothing done: only C is ready; P/Q/I blocked", () => {
    expect(ids(readyTasks({ plan, attempts: [], acceptedResults: [], now: 0, jobUsage: ZERO }))).toEqual(["C"]);
  });
  test("C accepted: P and Q ready in parallel; I still blocked", () => {
    const cA = att(plan, "C", 1, []);
    const cR = acc("C", 1, 10);
    expect(ids(readyTasks({ plan, attempts: [cA], acceptedResults: [cR], now: 0, jobUsage: ZERO }))).toEqual(["P", "Q"]);
  });
  test("Q done but not P: I does NOT start (join needs both)", () => {
    const cA = att(plan, "C", 1, []);
    const cR = acc("C", 1, 10);
    const qA = att(plan, "Q", 1, [boundTo(cR)]);
    const qR = acc("Q", 1, 20);
    expect(ids(readyTasks({ plan, attempts: [cA, qA], acceptedResults: [cR, qR], now: 0, jobUsage: ZERO }))).toEqual(["P"]);
  });
  test("all accepted: nothing ready, job succeeded", () => {
    const cA = att(plan, "C", 1, []); const cR = acc("C", 1, 10);
    const pA = att(plan, "P", 1, [boundTo(cR)]); const pR = acc("P", 1, 20);
    const qA = att(plan, "Q", 1, [boundTo(cR)]); const qR = acc("Q", 1, 30);
    const iA = att(plan, "I", 1, [boundTo(pR), boundTo(qR)]); const iR = acc("I", 1, 40);
    const input = { plan, attempts: [cA, pA, qA, iA], acceptedResults: [cR, pR, qR, iR], now: 0, jobUsage: ZERO };
    expect(readyTasks(input)).toEqual([]);
    expect(jobStatus(input).status).toBe("succeeded");
  });
});

describe("currentAccepted is recursive (Codex v2-P1-1)", () => {
  test("changing an upstream node's spec invalidates downstream current WITHOUT explicit supersede", () => {
    const plan1 = diamond();
    const plan2 = buildPlan([node("C", [], { goal: "g-C-v2" }), node("P", ["C"]), node("Q", ["C"]), node("I", ["P", "Q"], { kind: "integration" })]);
    const cA = att(plan1, "C", 1, []); const cR = acc("C", 1, 10); // attempt carries plan1's C specDigest
    const pA = att(plan1, "P", 1, [boundTo(cR)]); const pR = acc("P", 1, 20);
    const state = { attempts: [cA, pA], acceptedResults: [cR, pR] };
    // Under the ORIGINAL plan, P is current.
    expect(currentAccepted("P", { plan: plan1, ...state })?.acceptedResultId).toBe(pR.acceptedResultId);
    // Under the plan where C's spec changed, C's current goes null => P recursively goes null.
    expect(currentAccepted("C", { plan: plan2, ...state })).toBeNull();
    expect(currentAccepted("P", { plan: plan2, ...state })).toBeNull();
  });
});

describe("new+old non-superseded accepted coexist: current = max decidedAtSeq (§3.1)", () => {
  const plan = diamond();
  const cA1 = att(plan, "C", 1, []); const cR1 = acc("C", 1, 10);
  const cA2 = att(plan, "C", 2, []); const cR2 = acc("C", 2, 20);
  test("the newer accepted wins", () => {
    expect(currentAccepted("C", { plan, attempts: [cA1, cA2], acceptedResults: [cR1, cR2] })?.acceptedResultId).toBe(cR2.acceptedResultId);
  });
  test("a downstream bound to the OLD accepted is not current (would re-bind to the new one)", () => {
    const pOld = att(plan, "P", 1, [boundTo(cR1)]); const pOldR = acc("P", 1, 15);
    expect(currentAccepted("P", { plan, attempts: [cA1, cA2, pOld], acceptedResults: [cR1, cR2, pOldR] })).toBeNull();
    const pNew = att(plan, "P", 2, [boundTo(cR2)]); const pNewR = acc("P", 2, 25);
    expect(currentAccepted("P", { plan, attempts: [cA1, cA2, pNew], acceptedResults: [cR1, cR2, pNewR] })?.acceptedResultId).toBe(pNewR.acceptedResultId);
  });
});

describe("readyTasks step 2: an un-expired RETRY_WAIT counts as active (prior-art §3.4 fix)", () => {
  const plan = diamond();
  const cA = att(plan, "C", 1, []); const cR = acc("C", 1, 10);
  const pRetry = att(plan, "P", 1, [boundTo(cR)], "RETRY_WAIT", { retryAt: 1000, retriesUsed: 1 });
  test("before retryAt: P is NOT ready", () => {
    const r = ids(readyTasks({ plan, attempts: [cA, pRetry], acceptedResults: [cR], now: 500, jobUsage: ZERO }));
    expect(r).not.toContain("P");
    expect(r).toContain("Q"); // Q is unaffected
  });
  test("after retryAt: P becomes ready (succession)", () => {
    const r = ids(readyTasks({ plan, attempts: [cA, pRetry], acceptedResults: [cR], now: 1500, jobUsage: ZERO }));
    expect(r).toContain("P");
  });
  test("an ill-formed RETRY_WAIT with undefined retryAt counts ACTIVE, never re-dispatched (invariant hole closed)", () => {
    const pNoAt = att(plan, "P", 1, [boundTo(cR)], "RETRY_WAIT", { retriesUsed: 1 }); // retryAt deliberately omitted
    const r = ids(readyTasks({ plan, attempts: [cA, pNoAt], acceptedResults: [cR], now: 9_999_999, jobUsage: ZERO }));
    expect(r).not.toContain("P"); // active (conservative) => no second attempt while the old one is still RETRY_WAIT
  });
});

describe("jobStatus", () => {
  test("running: work remains", () => {
    const plan = diamond();
    expect(jobStatus({ plan, attempts: [], acceptedResults: [], now: 0, jobUsage: ZERO }).status).toBe("running");
  });
  test("failed: a required node is terminally failed", () => {
    const plan = buildPlan([node("C"), node("P", ["C"])]);
    const cFail = att(plan, "C", 1, [], "FAILED");
    expect(jobStatus({ plan, attempts: [cFail], acceptedResults: [], now: 0, jobUsage: ZERO }).status).toBe("failed");
  });
  test("failed: job budget exhausted", () => {
    const plan = buildPlan([node("C"), node("P", ["C"])], { maxTotalAttempts: 1, maxWallClockSec: 1_000_000 });
    expect(jobStatus({ plan, attempts: [], acceptedResults: [], now: 0, jobUsage: { totalAttempts: 1, wallClockSec: 0 } }).status).toBe("failed");
  });
  test("blocked: a non-required dep terminally failed, stalling a required node — nothing ready, nothing active, not failed", () => {
    // X required (complete), Z NOT required (terminally failed), Y required (depends on Z => stuck).
    const plan = buildPlan([node("X"), node("Z", [], { required: false }), node("Y", ["Z"])]);
    const xA = att(plan, "X", 1, []); const xR = acc("X", 1, 10);
    const zFail = att(plan, "Z", 1, [], "FAILED"); // inputBindingDigest == resolveInputs(Z) (no deps)
    const s = jobStatus({ plan, attempts: [xA, zFail], acceptedResults: [xR], now: 0, jobUsage: ZERO });
    expect(s.status).toBe("blocked");
    expect(s.note).toContain("Y"); // names the stuck required node for ops
  });
});
