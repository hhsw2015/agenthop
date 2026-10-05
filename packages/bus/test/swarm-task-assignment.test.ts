import { describe, expect, test } from "vitest";
import { createAttempt, type InputBinding, type ExecutionBinding, type TaskAttempt } from "../src/swarm/task-state.js";
import type { TaskSpec } from "../src/swarm/task-plan.js";
import { VALIDATOR_VERSION } from "../src/swarm/task-result.js";
import { digestOf } from "../src/swarm/digest.js";
import { buildAssignment, computeSoftDeadlineSec, tokenFits, type Assignment } from "../src/swarm/task-assignment.js";

/**
 * task-assignment contract (brain §4.5-1 / §4.5-3 / §4.5-4). buildAssignment is the dispatcher-side PURE projection
 * of (attempt, spec, binding, deadline budget) into the exact JSON a box receives at /root/.swarm/assignment.json.
 * It is deterministic: a RESEND reuses the SAME bytes (F3 重发≠改派 — same intentId ⇒ same assignmentDigest), so the
 * digest must be stable for fixed inputs and must NOT include itself.
 */

const SPEC: TaskSpec = {
  nodeId: "build",
  kind: "work",
  goal: "implement the widget",
  dependsOn: ["design"],
  outputContract: { requiredOutputs: [{ logicalName: "patch", kind: "patch" }], baseSourceCommit: "base123" },
  acceptance: [{ check: "tests-pass" }],
  artifactScope: ["out/"],
  sourceWriteScope: ["src/widget/"],
  estimatedRuntimeSec: 1800,
  retryBudget: 2,
  required: true,
  runtime: "ephemeral",
  specDigest: "spec-digest-x",
};

const INPUTS: InputBinding[] = [
  { depNodeId: "design", acceptedResultId: "job/design/a0/r1", workCommit: "deadbeef", resultPath: "out/results/job/design/a0/result.json" },
];

const BINDING: ExecutionBinding = {
  bindingId: "job/build/a0/b0",
  assignmentId: "job/build/a0/b0@asg1",
  launchId: "rw-abcd1234",
  publishGeneration: 0,
  openedAtSeq: 1,
};

const ATTEMPT: TaskAttempt = createAttempt({
  jobId: "job", nodeId: "build", n: 0, planRevision: 1, specDigest: SPEC.specDigest,
  inputBindings: INPUTS, baseSourceCommit: "base123", firstBinding: BINDING, createdAtSeq: 1,
});

const BUDGET = { remainingLifeSec: 3000, checkpointBudgetSec: 300, handoffMarginSec: 180 };
const mk = (over: Partial<typeof BUDGET> = {}): Assignment =>
  buildAssignment({ attempt: ATTEMPT, spec: SPEC, binding: BINDING, ...BUDGET, ...over });

describe("buildAssignment — field projection (§4.5-1)", () => {
  test("maps identity, binding coordinates and task fields", () => {
    const a = mk();
    expect(a.assignmentId).toBe(BINDING.assignmentId); // intentId = assignmentId = binding.assignmentId
    expect(a.jobId).toBe("job");
    expect(a.planRevision).toBe(1);
    expect(a.nodeId).toBe("build");
    expect(a.attemptId).toBe(ATTEMPT.attemptId); // "job/build/a0"
    expect(a.bindingId).toBe(BINDING.bindingId);
    expect(a.launchId).toBe(BINDING.launchId); // target box
    expect(a.generation).toBe(BINDING.publishGeneration);
    expect(a.goal).toBe(SPEC.goal);
    expect(a.inputBindings).toEqual(INPUTS); // each carries workCommit + resultPath (frozen SHAs)
    expect(a.inputBindingDigest).toBe(ATTEMPT.inputBindingDigest);
    expect(a.outputContract).toEqual(SPEC.outputContract);
    expect(a.artifactScope).toEqual(SPEC.artifactScope);
    expect(a.sourceWriteScope).toEqual(SPEC.sourceWriteScope);
    expect(a.baseSourceCommit).toBe("base123");
    expect(a.validatorVersion).toBe(VALIDATOR_VERSION);
  });

  test("resultPath is out/results/<attemptId>/result.json (§4.5-4), O2 = freeze-after-publish", () => {
    const a = mk();
    expect(a.resultPath).toBe(`out/results/${ATTEMPT.attemptId}/result.json`);
    expect(a.o2ResultRetention).toBe("freeze-after-publish");
  });

  test("sourceWriteScope is omitted when the spec has none (non-patch node)", () => {
    const { sourceWriteScope: _drop, ...specNoScope } = SPEC;
    const a = buildAssignment({ attempt: ATTEMPT, spec: specNoScope as TaskSpec, binding: BINDING, ...BUDGET });
    expect("sourceWriteScope" in a).toBe(false);
  });
});

describe("softDeadline (§4.5-1: 剩余寿命 - checkpoint 预算 - handoff 余量)", () => {
  test("subtracts both budgets", () => {
    expect(computeSoftDeadlineSec(3000, 300, 180)).toBe(2520);
    expect(mk().softDeadlineSec).toBe(2520);
  });
  test("clamps to 0, never negative", () => {
    expect(computeSoftDeadlineSec(100, 300, 180)).toBe(0);
    expect(mk({ remainingLifeSec: 100 }).softDeadlineSec).toBe(0);
  });
});

describe("assignmentDigest — deterministic, self-excluding (F3)", () => {
  test("same inputs ⇒ byte-identical digest", () => {
    expect(mk().assignmentDigest).toBe(mk().assignmentDigest);
  });
  test("digest = digestOf(assignment without assignmentDigest)", () => {
    const a = mk();
    const { assignmentDigest, ...rest } = a;
    expect(assignmentDigest).toBe(digestOf(rest));
  });
  test("a changed field changes the digest", () => {
    const a = mk();
    const b = buildAssignment({ attempt: ATTEMPT, spec: { ...SPEC, goal: "do something else" }, binding: BINDING, ...BUDGET });
    expect(b.assignmentDigest).not.toBe(a.assignmentDigest);
  });
  test("a changed softDeadline changes the digest (so a resend must reuse stored bytes, not rebuild)", () => {
    expect(mk().assignmentDigest).not.toBe(mk({ remainingLifeSec: 2999 }).assignmentDigest);
  });
});

describe("tokenFits — pre-dispatch token-margin gate (§4.5-3)", () => {
  test("fits when min(remainingLife, 3600) >= est + margin", () => {
    expect(tokenFits({ remainingLifeSec: 3000, estimatedRuntimeSec: 1800, marginSec: 600 }).fits).toBe(true);
  });
  test("does not fit when remaining life is too short for est + margin", () => {
    expect(tokenFits({ remainingLifeSec: 2000, estimatedRuntimeSec: 1800, marginSec: 600 }).fits).toBe(false);
  });
  test("the 3600 token cap bites: remainingLife above the cap cannot buy more than 3600", () => {
    const r = tokenFits({ remainingLifeSec: 5000, estimatedRuntimeSec: 3500, marginSec: 200 });
    expect(r.effectiveTtlSec).toBe(3600);
    expect(r.fits).toBe(false); // 3600 < 3700
  });
});
