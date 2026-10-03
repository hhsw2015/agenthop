import { describe, expect, test } from "vitest";
import { loadPlan, type TaskSpec } from "../src/swarm/task-plan.js";
import { createAttempt, type InputBinding, type ExecutionBinding, type TaskAttempt } from "../src/swarm/task-state.js";
import { validateResult, parseTaskResult, computeResultClosureDigest, type ValidationInput, VALIDATOR_VERSION } from "../src/swarm/task-result.js";

function buildSpec(pOverride: Record<string, unknown> = {}): TaskSpec {
  const res = loadPlan({
    jobId: "job",
    planRevision: 1,
    nodes: [
      { nodeId: "C", kind: "work", goal: "c", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 60, retryBudget: 2 },
      { nodeId: "P", kind: "work", goal: "p", dependsOn: ["C"], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, ...pOverride },
    ],
    jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
  });
  if (!res.ok) throw new Error(res.reason);
  return res.plan.nodes.find((n) => n.nodeId === "P")!;
}

const ibC: InputBinding = { depNodeId: "C", acceptedResultId: "job/C/a1/r1", workCommit: "cc0", resultPath: "out/results/job/C/a1/result.json" };
function bind(p: Partial<ExecutionBinding> = {}): ExecutionBinding {
  return { bindingId: "job/P/a1/b0", assignmentId: "as0", launchId: "rw-1", publishGeneration: 0, openedAtSeq: 100, ...p };
}
function mkAttempt(spec: TaskSpec, firstBinding: ExecutionBinding = bind()): TaskAttempt {
  return createAttempt({ jobId: "job", nodeId: "P", n: 1, planRevision: 1, specDigest: spec.specDigest, inputBindings: [ibC], firstBinding, createdAtSeq: 100 });
}

const SPEC = buildSpec();
const ATTEMPT = mkAttempt(SPEC);

function resultJson(p: Record<string, unknown> = {}, attempt: TaskAttempt = ATTEMPT): string {
  return JSON.stringify({
    schemaVersion: 1,
    jobId: "job",
    planRevision: 1,
    nodeId: "P",
    attemptId: attempt.attemptId,
    assignmentId: "as0",
    inputBindingDigest: attempt.inputBindingDigest,
    outcome: "success",
    outputs: [{ logicalName: "o", kind: "report", path: "out/report.md" }],
    validationEvidence: [],
    ...p,
  });
}

function vin(over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    resultText: resultJson(),
    source: "milestone",
    attempt: ATTEMPT,
    attemptSpec: SPEC,
    currentSpecDigest: SPEC.specDigest,
    currentDepResults: { C: "job/C/a1/r1" },
    observed: { launchId: "rw-1", generation: 0, workCommit: "wc9", resultBlobOid: "blob1", resultPath: "out/results/job/P/a1/result.json" },
    withinCutoffAncestry: true,
    candidateClosureDigest: "cd1",
    existingAccepted: null,
    contract: { requiredOutputsPresent: true, patchAppliesClean: true },
    acceptancePassed: true,
    cumulativeChangedPaths: ["out/results/job/P/a1/result.json", "out/report.md"],
    decidedAtSeq: 200,
    ...over,
  };
}

describe("accept (happy path, milestone success)", () => {
  test("builds the AcceptedResult", () => {
    const v = validateResult(vin());
    expect(v.decision).toBe("accept");
    if (v.decision === "accept") {
      expect(v.accepted.acceptedResultId).toBe("job/P/a1/r1");
      expect(v.accepted.decidedAtSeq).toBe(200);
      expect(v.accepted.validatorVersion).toBe(VALIDATOR_VERSION);
      expect(v.accepted.resultClosureDigest).toBe("cd1");
      expect(v.accepted.inputBindingDigest).toBe(ATTEMPT.inputBindingDigest);
    }
  });
});

describe("V3 binding (candidate-level discard, attempt untouched)", () => {
  test("no binding for the observed launch/generation", () => {
    const v = validateResult(vin({ observed: { launchId: "rw-x", generation: 0, workCommit: "w", resultBlobOid: "b", resultPath: "out/results/job/P/a1/result.json" } }));
    expect(v.decision === "discard" && v.rule === "V3").toBe(true);
  });
  test("closing binding: candidate beyond cutoffTip ancestry is peer-late", () => {
    const att = mkAttempt(SPEC, bind({ closing: { cutoffTip: "cut1" } }));
    const v = validateResult(vin({ attempt: att, withinCutoffAncestry: false }));
    expect(v.decision === "discard" && v.rule === "V3" && /peer-late/.test(v.reason)).toBe(true);
  });
  test("closed-empty binding: nothing eligible", () => {
    const att = mkAttempt(SPEC, bind({ closing: { cutoffTip: "empty" } }));
    const v = validateResult(vin({ attempt: att, withinCutoffAncestry: true }));
    expect(v.decision === "discard" && v.rule === "V3").toBe(true);
  });
});

describe("V1 schema (classified by source)", () => {
  test("unparseable: milestone => permanent, rescue => inconsistent-snapshot", () => {
    const m = validateResult(vin({ resultText: "not json" }));
    expect(m.decision === "reject" && m.rule === "V1" && m.failureClass === "permanent").toBe(true);
    const r = validateResult(vin({ resultText: "not json", source: "rescue" }));
    expect(r.decision === "reject" && r.rule === "V1" && r.failureClass === "inconsistent-snapshot").toBe(true);
  });
  test("oversize (>64 KiB) rejected", () => {
    const big = resultJson({ validationEvidence: [{ check: "c", summaryPath: "x".repeat(70 * 1024) }] });
    const v = validateResult(vin({ resultText: big }));
    expect(v.decision === "reject" && v.rule === "V1").toBe(true);
  });
  test("declared output outside artifactScope rejected", () => {
    const v = validateResult(vin({ resultText: resultJson({ outputs: [{ logicalName: "o", kind: "report", path: "src/x.ts" }] }) }));
    expect(v.decision === "reject" && v.rule === "V1" && /artifactScope/.test(v.reason)).toBe(true);
  });
});

describe("V2 identity (candidate-level discard)", () => {
  test("wrong attemptId", () => {
    const v = validateResult(vin({ resultText: resultJson({ attemptId: "job/P/a9" }) }));
    expect(v.decision === "discard" && v.rule === "V2").toBe(true);
  });
  test("wrong assignmentId (must match the matched binding)", () => {
    const v = validateResult(vin({ resultText: resultJson({ assignmentId: "asX" }) }));
    expect(v.decision === "discard" && v.rule === "V2").toBe(true);
  });
});

describe("V5 plan (stale -> ABANDONED)", () => {
  test("node removed in current revision", () => {
    const v = validateResult(vin({ currentSpecDigest: null }));
    expect(v.decision === "stale" && v.rule === "V5" && v.which === "plan").toBe(true);
  });
  test("node spec changed", () => {
    const v = validateResult(vin({ currentSpecDigest: "different-digest" }));
    expect(v.decision === "stale" && v.rule === "V5").toBe(true);
  });
});

describe("V4 input (stale -> ABANDONED)", () => {
  test("inputBindingDigest mismatch", () => {
    const v = validateResult(vin({ resultText: resultJson({ inputBindingDigest: "wrong" }) }));
    expect(v.decision === "stale" && v.rule === "V4" && v.which === "input").toBe(true);
  });
  test("dep has a NEWER current accepted while the binding points at the old one (single-value map) => stale-input", () => {
    const v = validateResult(vin({ currentDepResults: { C: "job/C/a2/r1" } })); // attempt bound to a1, current is a2
    expect(v.decision === "stale" && v.rule === "V4" && v.which === "input").toBe(true);
  });
  test("dep has no current accepted => stale-input", () => {
    const v = validateResult(vin({ currentDepResults: { C: null } }));
    expect(v.decision === "stale" && v.rule === "V4").toBe(true);
  });
});

describe("scope-violation (cumulative, permanent)", () => {
  test("a cumulative change outside artifactScope is permanent", () => {
    const v = validateResult(vin({ cumulativeChangedPaths: ["out/report.md", "src/secret.ts"] }));
    expect(v.decision === "reject" && v.rule === "scope" && v.failureClass === "permanent").toBe(true);
  });
  test(".swarm/manifest.json and out/results/<attemptId>/ are always allowed", () => {
    const v = validateResult(vin({ cumulativeChangedPaths: [".swarm/manifest.json", "out/results/job/P/a1/extra.txt", "out/report.md"] }));
    expect(v.decision).toBe("accept");
  });
});

describe("outcome=failure (business-fail, skips V7/V8)", () => {
  test("worker self-reported failure => business-fail even if contract would also fail", () => {
    const v = validateResult(vin({ resultText: resultJson({ outcome: "failure", failureReason: "boom" }), contract: { requiredOutputsPresent: false, patchAppliesClean: false } }));
    expect(v.decision === "reject" && v.rule === "outcome" && v.failureClass === "business-fail").toBe(true);
  });
});

describe("V6 unique (resultClosureDigest)", () => {
  test("same closure already accepted => idempotent replay", () => {
    const v = validateResult(vin({ existingAccepted: { acceptedResultId: "job/P/a1/r1", resultClosureDigest: "cd1" }, candidateClosureDigest: "cd1" }));
    expect(v.decision === "replay" && v.acceptedResultId === "job/P/a1/r1").toBe(true);
  });
  test("different closure while already accepted => duplicate candidate (discard, not replace)", () => {
    const v = validateResult(vin({ existingAccepted: { acceptedResultId: "job/P/a1/r1", resultClosureDigest: "cdOLD" }, candidateClosureDigest: "cd1" }));
    expect(v.decision === "discard" && v.rule === "V6").toBe(true);
  });
});

describe("V7 contract", () => {
  test("required outputs missing: milestone business-fail, rescue inconsistent-snapshot", () => {
    const m = validateResult(vin({ contract: { requiredOutputsPresent: false, patchAppliesClean: true } }));
    expect(m.decision === "reject" && m.rule === "V7" && m.failureClass === "business-fail").toBe(true);
    const r = validateResult(vin({ source: "rescue", contract: { requiredOutputsPresent: false, patchAppliesClean: true } }));
    expect(r.decision === "reject" && r.rule === "V7" && r.failureClass === "inconsistent-snapshot").toBe(true);
  });
  test("patch-with-base ENTERS V7: applies clean => accept; does not apply => business-fail", () => {
    const pspec = buildSpec({ outputContract: { requiredOutputs: [{ logicalName: "patch", kind: "patch" }], baseSourceCommit: "base1" }, sourceWriteScope: ["src/"] });
    const patt = mkAttempt(pspec);
    const presult = resultJson({ outputs: [{ logicalName: "patch", kind: "patch", path: "out/patch.diff", baseSourceCommit: "base1" }] }, patt);
    const ok = validateResult(vin({ attempt: patt, attemptSpec: pspec, currentSpecDigest: pspec.specDigest, resultText: presult, patchDiffPaths: ["src/a.ts"] }));
    expect(ok.decision).toBe("accept");
    const bad = validateResult(vin({ attempt: patt, attemptSpec: pspec, currentSpecDigest: pspec.specDigest, resultText: presult, contract: { requiredOutputsPresent: true, patchAppliesClean: false } }));
    expect(bad.decision === "reject" && bad.rule === "V7" && bad.failureClass === "business-fail").toBe(true);
  });
});

describe("V8 validation + patch sourceWriteScope", () => {
  test("acceptance checks failed: milestone business-fail, rescue inconsistent-snapshot", () => {
    const m = validateResult(vin({ acceptancePassed: false }));
    expect(m.decision === "reject" && m.rule === "V8" && m.failureClass === "business-fail").toBe(true);
    const r = validateResult(vin({ source: "rescue", acceptancePassed: false }));
    expect(r.decision === "reject" && r.rule === "V8" && r.failureClass === "inconsistent-snapshot").toBe(true);
  });
  test("patch editing outside sourceWriteScope is rejected (permanent); inside passes", () => {
    const pspec = buildSpec({ outputContract: { requiredOutputs: [{ logicalName: "patch", kind: "patch" }], baseSourceCommit: "base1" }, sourceWriteScope: ["src/"] });
    const patt = mkAttempt(pspec);
    const presult = resultJson({ outputs: [{ logicalName: "patch", kind: "patch", path: "out/patch.diff", baseSourceCommit: "base1" }] }, patt);
    const base = { attempt: patt, attemptSpec: pspec, currentSpecDigest: pspec.specDigest, resultText: presult };
    expect(validateResult(vin({ ...base, patchDiffPaths: ["src/a.ts"] })).decision).toBe("accept");
    const out = validateResult(vin({ ...base, patchDiffPaths: ["docs/x.md"] }));
    expect(out.decision === "reject" && out.rule === "scope" && out.failureClass === "permanent").toBe(true);
  });
});

describe("computeResultClosureDigest (Codex P2-2)", () => {
  test("order-independent over referenced files", () => {
    const a = computeResultClosureDigest({ resultBlobOid: "r", referencedFiles: [{ path: "a", blobOid: "1" }, { path: "b", blobOid: "2" }] });
    const b = computeResultClosureDigest({ resultBlobOid: "r", referencedFiles: [{ path: "b", blobOid: "2" }, { path: "a", blobOid: "1" }] });
    expect(a).toBe(b);
  });
  test("changing a referenced blob changes the closure even if result.json blob is identical", () => {
    const a = computeResultClosureDigest({ resultBlobOid: "r", referencedFiles: [{ path: "patch.diff", blobOid: "old" }] });
    const b = computeResultClosureDigest({ resultBlobOid: "r", referencedFiles: [{ path: "patch.diff", blobOid: "new" }] });
    expect(a).not.toBe(b);
  });
});

describe("parseTaskResult", () => {
  test("round-trips a valid result and rejects bad schema", () => {
    expect(parseTaskResult(resultJson())?.nodeId).toBe("P");
    expect(parseTaskResult(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
    expect(parseTaskResult("{")).toBeNull();
  });
});
