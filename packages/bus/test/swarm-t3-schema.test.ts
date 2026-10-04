import { describe, expect, test } from "vitest";
import { loadPlan, computeSpecDigest, type TaskSpec, type TaskPlan } from "../src/swarm/task-plan.js";
import { openQueryWait, advanceWait } from "../src/swarm/task-wait.js";

// T3a schema extensions (frozen design 60c9ffa7): TaskKind+"design", TaskSpec.modelTier/roleProfile (role annotations,
// EXCLUDED from specDigest) and coveredSpecDigests (design-node identity, IN specDigest); plus WaitRecord/NewQueryWait
// payloadRef carrier. Fixtures: LOAD-ROUNDTRIP + the F-T3-2 identity classification.

function fullSpec(p: Partial<TaskSpec> = {}): TaskSpec {
  return {
    nodeId: "n1",
    kind: "work",
    goal: "do a thing",
    dependsOn: [],
    outputContract: { requiredOutputs: [{ logicalName: "out", kind: "report" }] },
    acceptance: [],
    artifactScope: ["out/"],
    estimatedRuntimeSec: 600,
    retryBudget: 2,
    required: true,
    runtime: "ephemeral",
    specDigest: "",
    ...p,
  };
}
function raw(p: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fullSpec(), ...p };
}
function plan(nodes: Record<string, unknown>[], p: Record<string, unknown> = {}): unknown {
  return { jobId: "job1", planRevision: 1, nodes, jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 }, planDigest: "", ...p };
}

describe("T3a schema: kind=design accepted, new optional fields validated", () => {
  test("a kind=design node with coveredSpecDigests loads", () => {
    const r = loadPlan(plan([raw({ nodeId: "D", kind: "design", coveredSpecDigests: ["aa", "bb"] })]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.nodes[0]!.kind).toBe("design");
  });
  test("modelTier/roleProfile accepted on a normal node", () => {
    const r = loadPlan(plan([raw({ modelTier: "heavy", roleProfile: "pure-layer-impl" })]));
    expect(r.ok && r.plan.nodes[0]!.modelTier === "heavy" && r.plan.nodes[0]!.roleProfile === "pure-layer-impl").toBe(true);
  });
  test("bad modelTier / empty roleProfile / non-string coveredSpecDigests are rejected whole", () => {
    expect(loadPlan(plan([raw({ modelTier: "xl" })])).ok).toBe(false);
    expect(loadPlan(plan([raw({ roleProfile: "" })])).ok).toBe(false);
    expect(loadPlan(plan([raw({ coveredSpecDigests: [1, 2] })])).ok).toBe(false);
  });
});

describe("LOAD-ROUNDTRIP (P2-4): translated plan keeps design/coverage/role/modelTier, exact loaded == committed", () => {
  test("every new field survives the loader and the loaded plan is the authoritative one", () => {
    const r = loadPlan(plan([
      raw({ nodeId: "M", modelTier: "standard", roleProfile: "pure-layer-impl" }),
      raw({ nodeId: "D", kind: "design", dependsOn: ["M"], coveredSpecDigests: ["placeholder"] }),
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.plan.nodes.find((n) => n.nodeId === "M")!;
    const d = r.plan.nodes.find((n) => n.nodeId === "D")!;
    expect(m.modelTier).toBe("standard");
    expect(m.roleProfile).toBe("pure-layer-impl");
    expect(d.kind).toBe("design");
    expect(d.coveredSpecDigests).toEqual(["placeholder"]);
    // digests recomputed, not dropped
    expect(m.specDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(d.specDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("F-T3-2 identity classification: role annotations OUT of specDigest, coverage/kind IN", () => {
  test("modelTier does NOT change specDigest (re-tiering ≠ task changed)", () => {
    expect(computeSpecDigest(fullSpec({ modelTier: "light" }))).toBe(computeSpecDigest(fullSpec({ modelTier: "heavy" })));
    expect(computeSpecDigest(fullSpec({ modelTier: "light" }))).toBe(computeSpecDigest(fullSpec())); // absent == any tier
  });
  test("roleProfile does NOT change specDigest (re-staffing ≠ task changed)", () => {
    expect(computeSpecDigest(fullSpec({ roleProfile: "a" }))).toBe(computeSpecDigest(fullSpec({ roleProfile: "b" })));
  });
  test("kind DOES change specDigest (identity)", () => {
    expect(computeSpecDigest(fullSpec({ kind: "design" }))).not.toBe(computeSpecDigest(fullSpec({ kind: "work" })));
  });
  test("coveredSpecDigests DOES change specDigest (a design node's coverage is its identity; COVERAGE-FINAL)", () => {
    const base = fullSpec({ kind: "design", coveredSpecDigests: ["x"] });
    expect(computeSpecDigest(base)).not.toBe(computeSpecDigest({ ...base, coveredSpecDigests: ["x", "y"] }));
    expect(computeSpecDigest(base)).not.toBe(computeSpecDigest({ ...base, coveredSpecDigests: [] }));
  });
});

describe("payloadRef carrier on query-wait (field only; bundle store/resume = T3b)", () => {
  const q = (payloadRef?: string) => openQueryWait({
    waitId: "q1", subject: { jobId: "job", attemptId: "job/P/a1" }, deadlineSec: 100, owner: "disp",
    defaultOnTimeout: { outcome: "proceed", reason: "no reply", sourceOperationId: "op" },
    ...(payloadRef !== undefined ? { payloadRef } : {}),
  });
  test("openQueryWait carries payloadRef when given, omits it otherwise", () => {
    expect(q("sha256:bundle-abc").payloadRef).toBe("sha256:bundle-abc");
    expect(q().payloadRef).toBeUndefined();
  });
  test("payloadRef survives a transition (begin_action re-arm keeps the resume ref)", () => {
    const w = q("sha256:bundle-abc");
    const p = advanceWait(w, { type: "begin_action", pendingAction: { actionId: "n1", actionKind: "reminder", target: "t", expectedSubjectVersion: 1 } });
    expect(p.ok && p.wait.payloadRef === "sha256:bundle-abc").toBe(true);
  });
});
