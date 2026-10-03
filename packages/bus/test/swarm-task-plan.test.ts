import { describe, expect, test } from "vitest";
import { loadPlan, computeSpecDigest, computePlanDigest, type TaskSpec, type TaskPlan } from "../src/swarm/task-plan.js";

// Returns raw JSON-shaped input (not a typed TaskSpec) so tests can omit `required` / inject bad fields — it all
// goes through loadPlan(unknown) anyway.
function spec(p: Partial<TaskSpec> = {}): Record<string, unknown> {
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
    // `required` deliberately omitted — defaulting is under test.
    specDigest: "", // recomputed by loadPlan
    ...p,
  };
}
function plan(nodes: Record<string, unknown>[], p: Partial<TaskPlan> = {}): unknown {
  return {
    jobId: "job1",
    planRevision: 1,
    nodes,
    jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
    planDigest: "",
    ...p,
  };
}

describe("loadPlan — valid", () => {
  test("single node, no deps", () => {
    const r = loadPlan(plan([spec()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.nodes[0]!.specDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
  test("diamond DAG C -> P,Q -> I", () => {
    const r = loadPlan(plan([
      spec({ nodeId: "C" }),
      spec({ nodeId: "P", dependsOn: ["C"] }),
      spec({ nodeId: "Q", dependsOn: ["C"] }),
      spec({ nodeId: "I", kind: "integration", dependsOn: ["P", "Q"] }),
    ]));
    expect(r.ok).toBe(true);
  });
});

describe("loadPlan — illegal graph is rejected WHOLE (no silent edge deletion)", () => {
  test("duplicate nodeId", () => {
    const r = loadPlan(plan([spec({ nodeId: "x" }), spec({ nodeId: "x" })]));
    expect(r.ok).toBe(false);
    expect(r.ok === false && /duplicate/i.test(r.reason)).toBe(true);
  });
  test("missing dependency: rejected, not silently dropped", () => {
    const r = loadPlan(plan([spec({ nodeId: "P", dependsOn: ["ghost"] })]));
    expect(r.ok).toBe(false);
    expect(r.ok === false && /ghost|missing|depend/i.test(r.reason)).toBe(true);
    // no partially-loaded plan handed back
    expect("plan" in r).toBe(false);
  });
  test("self-loop", () => {
    const r = loadPlan(plan([spec({ nodeId: "A", dependsOn: ["A"] })]));
    expect(r.ok).toBe(false);
    expect(r.ok === false && /self|cycle/i.test(r.reason)).toBe(true);
  });
  test("cycle A -> B -> A", () => {
    const r = loadPlan(plan([
      spec({ nodeId: "A", dependsOn: ["B"] }),
      spec({ nodeId: "B", dependsOn: ["A"] }),
    ]));
    expect(r.ok).toBe(false);
    expect(r.ok === false && /cycle/i.test(r.reason)).toBe(true);
  });
  test("3-cycle A -> B -> C -> A", () => {
    const r = loadPlan(plan([
      spec({ nodeId: "A", dependsOn: ["C"] }),
      spec({ nodeId: "B", dependsOn: ["A"] }),
      spec({ nodeId: "C", dependsOn: ["B"] }),
    ]));
    expect(r.ok).toBe(false);
  });
});

describe("loadPlan — shape validation at the boundary", () => {
  test("empty nodes rejected", () => {
    expect(loadPlan(plan([])).ok).toBe(false);
  });
  test("unknown node kind rejected", () => {
    expect(loadPlan(plan([spec({ kind: "magic" as unknown as TaskSpec["kind"] })])).ok).toBe(false);
  });
  test("unknown requiredOutput kind rejected", () => {
    const r = loadPlan(plan([spec({ outputContract: { requiredOutputs: [{ logicalName: "o", kind: "binary" as unknown as "patch" }] } })]));
    expect(r.ok).toBe(false);
  });
  test("patch output without baseSourceCommit rejected (V7 would be unrunnable)", () => {
    const r = loadPlan(plan([spec({ outputContract: { requiredOutputs: [{ logicalName: "p", kind: "patch" }] } })]));
    expect(r.ok).toBe(false);
    expect(r.ok === false && /base/i.test(r.reason)).toBe(true);
  });
  test("patch output WITH baseSourceCommit accepted", () => {
    const r = loadPlan(plan([spec({ outputContract: { requiredOutputs: [{ logicalName: "p", kind: "patch" }], baseSourceCommit: "deadbeef" } })]));
    expect(r.ok).toBe(true);
  });
  test("negative retryBudget rejected", () => {
    expect(loadPlan(plan([spec({ retryBudget: -1 })])).ok).toBe(false);
  });
  test("dependsOn not an array rejected", () => {
    expect(loadPlan(plan([spec({ dependsOn: "C" as unknown as string[] })])).ok).toBe(false);
  });
  test("bad jobBudget rejected", () => {
    expect(loadPlan(plan([spec()], { jobBudget: { maxTotalAttempts: 0, maxWallClockSec: 1 } as TaskPlan["jobBudget"] })).ok).toBe(false);
  });
  test("non-object input rejected (not thrown)", () => {
    expect(loadPlan(null).ok).toBe(false);
    expect(loadPlan("nope").ok).toBe(false);
  });
});

describe("digests — canonical, deterministic, content-addressed", () => {
  const asSpec = (o: Record<string, unknown>): TaskSpec => ({ required: true, ...o } as unknown as TaskSpec);
  test("specDigest ignores key order and any provided specDigest field", () => {
    const a = computeSpecDigest(asSpec(spec({ specDigest: "bogus" })));
    const b = computeSpecDigest(asSpec(spec({ specDigest: "different-bogus" })));
    expect(a).toBe(b);
  });
  test("changing goal changes specDigest", () => {
    expect(computeSpecDigest(asSpec(spec({ goal: "x" })))).not.toBe(computeSpecDigest(asSpec(spec({ goal: "y" }))));
  });
  test("required defaults to true and is stored explicitly", () => {
    const r = loadPlan(plan([spec()]));
    expect(r.ok && r.plan.nodes[0]!.required === true).toBe(true);
  });
  test("required:false is respected and changes specDigest vs default-true (it IS a hashed spec field)", () => {
    const def = loadPlan(plan([spec()]));
    const explicitTrue = loadPlan(plan([spec({ required: true })]));
    const falsy = loadPlan(plan([spec({ required: false })]));
    expect(def.ok && explicitTrue.ok && def.plan.nodes[0]!.specDigest === explicitTrue.plan.nodes[0]!.specDigest).toBe(true);
    expect(def.ok && falsy.ok && def.plan.nodes[0]!.specDigest !== falsy.plan.nodes[0]!.specDigest).toBe(true);
    expect(falsy.ok && falsy.plan.nodes[0]!.required === false).toBe(true);
  });
  test("non-boolean required rejected", () => {
    expect(loadPlan(plan([spec({ required: "yes" as unknown as boolean })])).ok).toBe(false);
  });
  test("planDigest stable across node array identity, changes when a node changes", () => {
    const p1 = loadPlan(plan([spec({ nodeId: "A" }), spec({ nodeId: "B", dependsOn: ["A"] })]));
    const p2 = loadPlan(plan([spec({ nodeId: "A" }), spec({ nodeId: "B", dependsOn: ["A"] })]));
    expect(p1.ok && p2.ok && p1.plan.planDigest === p2.plan.planDigest).toBe(true);
    const p3 = loadPlan(plan([spec({ nodeId: "A", goal: "changed" }), spec({ nodeId: "B", dependsOn: ["A"] })]));
    expect(p1.ok && p3.ok && p1.plan.planDigest !== p3.plan.planDigest).toBe(true);
  });
  test("loadPlan recomputes digests authoritatively (ignores provided planDigest)", () => {
    const r = loadPlan(plan([spec()], { planDigest: "tampered" }));
    expect(r.ok && r.plan.planDigest !== "tampered").toBe(true);
    if (r.ok) expect(r.plan.planDigest).toBe(computePlanDigest(r.plan));
  });
});
