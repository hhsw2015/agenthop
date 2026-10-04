import { describe, expect, test } from "vitest";
import { loadPlan, computeSpecDigest, type TaskSpec } from "../src/swarm/task-plan.js";
import { openQueryWait, advanceWait } from "../src/swarm/task-wait.js";

// T3a schema extensions (frozen design 60c9ffa7): TaskKind+"design", TaskSpec.modelTier/roleProfile (role annotations,
// EXCLUDED from specDigest), coveredSpecDigests (design-node identity, IN specDigest), TaskPlan.frozenRefs; plus
// WaitRecord/NewQueryWait payloadRef; plus loadPlan R4 structural coverage validation (P1-2).

function fullSpec(p: Partial<TaskSpec> = {}): TaskSpec {
  return {
    nodeId: "n1", kind: "work", goal: "do a thing", dependsOn: [],
    outputContract: { requiredOutputs: [{ logicalName: "out", kind: "report" }] },
    acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2,
    required: true, runtime: "ephemeral", specDigest: "", ...p,
  };
}
const raw = (p: Record<string, unknown> = {}): Record<string, unknown> => ({ ...fullSpec(), ...p });
function plan(nodes: Record<string, unknown>[], p: Record<string, unknown> = {}): unknown {
  return { jobId: "job1", planRevision: 1, nodes, jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 }, planDigest: "", ...p };
}
// a valid design gate covering work node M: M depends on D (gate is ancestor), D.coveredSpecDigests = M's recomputed digest
const mDigest = (over: Partial<TaskSpec> = {}) => computeSpecDigest(fullSpec({ nodeId: "M", dependsOn: ["D"], ...over }));

describe("T3a schema: kind=design + new optional fields validated", () => {
  test("a valid design gate (M depends on D, D covers M's final digest) loads", () => {
    const r = loadPlan(plan([raw({ nodeId: "M", dependsOn: ["D"] }), raw({ nodeId: "D", kind: "design", dependsOn: [], coveredSpecDigests: [mDigest()] })]));
    expect(r.ok && r.plan.nodes.find((n) => n.nodeId === "D")!.kind === "design").toBe(true);
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

describe("loadPlan R4 structural coverage (P1-2): catches the bypass counterexamples", () => {
  test("change M, keep old D coverage -> dangling coverage rejected", () => {
    const r = loadPlan(plan([raw({ nodeId: "M", dependsOn: ["D"], goal: "CHANGED" }), raw({ nodeId: "D", kind: "design", dependsOn: [], coveredSpecDigests: [mDigest(/* old goal */)] })]));
    expect(r.ok === false && /stale|dangling|matching no node/.test(r.reason)).toBe(true);
  });
  test("design gate not an ancestor of the node it covers -> rejected", () => {
    // D depends on M (descendant) yet covers M — gate does not precede the work
    const r = loadPlan(plan([raw({ nodeId: "M", dependsOn: [] }), raw({ nodeId: "D", kind: "design", dependsOn: ["M"], coveredSpecDigests: [computeSpecDigest(fullSpec({ nodeId: "M", dependsOn: [] }))] })]));
    expect(r.ok === false && /ancestor/.test(r.reason)).toBe(true);
  });
  test("design gate with empty/absent coverage -> rejected (delete-coverage bypass)", () => {
    expect(loadPlan(plan([raw({ nodeId: "M", dependsOn: ["D"] }), raw({ nodeId: "D", kind: "design", dependsOn: [], coveredSpecDigests: [] })])).ok).toBe(false);
    expect(loadPlan(plan([raw({ nodeId: "M", dependsOn: ["D"] }), raw({ nodeId: "D", kind: "design", dependsOn: [] })])).ok).toBe(false);
  });
});

describe("LOAD-ROUNDTRIP (P2-4): design/coverage/role/modelTier/frozenRefs survive; loaded == committed", () => {
  test("every new field survives the loader; digests recomputed", () => {
    const r = loadPlan(plan([
      raw({ nodeId: "M", dependsOn: ["D"], modelTier: "standard", roleProfile: "pure-layer-impl" }),
      raw({ nodeId: "D", kind: "design", dependsOn: [], coveredSpecDigests: [mDigest()] }),
    ], { frozenRefs: { checkRegistry: "cr1", ownerDomainPolicy: "op1", riskPolicy: "rp1", roleCatalog: "rc1", budgetPolicy: "bp1", r4ThresholdPolicy: "tp1", sourceBaselineDigest: "base", planningRequestId: "req-1" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.plan.nodes.find((n) => n.nodeId === "M")!;
    expect(m.modelTier).toBe("standard");
    expect(m.roleProfile).toBe("pure-layer-impl");
    expect(r.plan.nodes.find((n) => n.nodeId === "D")!.coveredSpecDigests).toEqual([mDigest()]);
    expect(r.plan.frozenRefs?.planningRequestId).toBe("req-1");
    expect(m.specDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  test("malformed frozenRefs is rejected whole", () => {
    expect(loadPlan(plan([raw()], { frozenRefs: { checkRegistry: "cr1" } })).ok).toBe(false); // missing required refs
  });
});

describe("F-T3-2 identity classification: role annotations OUT of specDigest, coverage/kind IN", () => {
  test("modelTier / roleProfile do NOT change specDigest", () => {
    expect(computeSpecDigest(fullSpec({ modelTier: "light" }))).toBe(computeSpecDigest(fullSpec({ modelTier: "heavy" })));
    expect(computeSpecDigest(fullSpec({ roleProfile: "a" }))).toBe(computeSpecDigest(fullSpec({ roleProfile: "b" })));
    expect(computeSpecDigest(fullSpec({ modelTier: "light" }))).toBe(computeSpecDigest(fullSpec()));
  });
  test("kind DOES change specDigest (identity)", () => {
    expect(computeSpecDigest(fullSpec({ kind: "design" }))).not.toBe(computeSpecDigest(fullSpec({ kind: "work" })));
  });
  test("coveredSpecDigests DOES change specDigest (design coverage is identity; COVERAGE-FINAL)", () => {
    const base = fullSpec({ kind: "design", coveredSpecDigests: ["x"] });
    expect(computeSpecDigest(base)).not.toBe(computeSpecDigest({ ...base, coveredSpecDigests: ["x", "y"] }));
  });
  test("criticalPath does NOT change specDigest (annotation, like modelTier/roleProfile)", () => {
    expect(computeSpecDigest(fullSpec({ criticalPath: true }))).toBe(computeSpecDigest(fullSpec({ criticalPath: false })));
    expect(computeSpecDigest(fullSpec({ criticalPath: true }))).toBe(computeSpecDigest(fullSpec()));
  });
  test("① criticalPath bool round-trips through loadPlan (preserved, non-bool rejected)", () => {
    const r = loadPlan(plan([raw({ criticalPath: true })]));
    expect(r.ok && r.plan.nodes[0]!.criticalPath === true).toBe(true);
    expect(loadPlan(plan([raw({ criticalPath: "yes" })])).ok).toBe(false);
  });
  test("③ flipping criticalPath on a known-risk node: specDigest unchanged, planDigest changed", () => {
    const a = loadPlan(plan([raw({ nodeId: "M", criticalPath: false })]));
    const b = loadPlan(plan([raw({ nodeId: "M", criticalPath: true })]));
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.plan.nodes[0]!.specDigest).toBe(b.plan.nodes[0]!.specDigest);
    expect(a.plan.planDigest).not.toBe(b.plan.planDigest);
  });
});

describe("managed-t3 critical∧unknown rejection (errata 0b966a11): loader re-verifies the clarify branch", () => {
  const refs = { checkRegistry: "cr1", ownerDomainPolicy: "op1", riskPolicy: "rp1", roleCatalog: "rc1", budgetPolicy: "bp1", r4ThresholdPolicy: "tp1", sourceBaselineDigest: "base" };
  test("a criticalPath node with an unknown-risk path is rejected (should have been needsClarification, not loadable)", () => {
    const mD = computeSpecDigest(fullSpec({ nodeId: "M", dependsOn: ["design-gate"], sourceWriteScope: ["experimental/x.ts"], criticalPath: true }));
    const p = plan([
      raw({ nodeId: "design-gate", kind: "design", dependsOn: [], coveredSpecDigests: [mD] }),
      raw({ nodeId: "M", dependsOn: ["design-gate"], sourceWriteScope: ["experimental/x.ts"], criticalPath: true }),
    ], { frozenRefs: refs });
    const opts = { mode: "managed-t3" as const, ownerDomainPolicy: { version: "op1", ownerByPrefix: [], frozenScopePrefixes: [] }, riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: ["experimental/"] }, expectedFrozenRefs: refs };
    const r = loadPlan(p, opts);
    expect(r.ok === false && /criticalPath|needsClarification/.test(r.reason)).toBe(true);
  });
  test("② same unknown-risk node: criticalPath false -> loadable, true -> rejected; field preserved either way", () => {
    const opts = { mode: "managed-t3" as const, ownerDomainPolicy: { version: "op1", ownerByPrefix: [], frozenScopePrefixes: [] }, riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: ["experimental/"] }, expectedFrozenRefs: refs };
    const mD = computeSpecDigest(fullSpec({ nodeId: "M", dependsOn: ["design-gate"], sourceWriteScope: ["experimental/x.ts"] })); // criticalPath excluded -> same digest for false/true
    const mk = (critical: boolean) => loadPlan(plan([
      raw({ nodeId: "design-gate", kind: "design", dependsOn: [], coveredSpecDigests: [mD] }),
      raw({ nodeId: "M", dependsOn: ["design-gate"], sourceWriteScope: ["experimental/x.ts"], criticalPath: critical }),
    ], { frozenRefs: refs }), opts);
    const falsey = mk(false);
    expect(falsey.ok && falsey.plan.nodes.find((n) => n.nodeId === "M")!.criticalPath === false).toBe(true); // loadable + field preserved
    expect(mk(true).ok).toBe(false); // flipping to true -> loader rejects (should be needsClarification)
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
  test("payloadRef survives a transition (begin_action keeps the resume ref)", () => {
    const p = advanceWait(q("sha256:bundle-abc"), { type: "begin_action", pendingAction: { actionId: "n1", actionKind: "reminder", target: "t", expectedSubjectVersion: 1 } });
    expect(p.ok && p.wait.payloadRef === "sha256:bundle-abc").toBe(true);
  });
});
