import { describe, expect, test } from "vitest";
import { validateForcePipeline, forcedSuccessors, pipelineOrder, forcePipelineEnabled, type ForcePipeline } from "../src/swarm/force-pipeline.js";

const okv = (r: { ok: true; value: ForcePipeline } | { ok: false; reason: string }): ForcePipeline => { if (!r.ok) throw new Error(r.reason); return r.value; };
const P = (stages: unknown[]): unknown => ({ schema: "force-pipeline/v1", stages });

describe("force-pipeline — validate (whole-reject: schema/shape/self-ref/dup/dangling/cycle)", () => {
  test("a valid linear pipeline and a fan-out load; an empty pipeline is trivially valid", () => {
    expect(okv(validateForcePipeline(P([{ from: "extract", to: "summarize" }, { from: "summarize", to: "write" }]))).stages.length).toBe(2);
    expect(validateForcePipeline(P([{ from: "a", to: "b" }, { from: "a", to: "c" }])).ok).toBe(true); // fan-out
    expect(validateForcePipeline(P([])).ok).toBe(true);
  });
  test("rejects bad schema / non-array stages / non-object stage / bad from·to", () => {
    expect(validateForcePipeline({ schema: "x", stages: [] }).ok).toBe(false);
    expect(validateForcePipeline({ schema: "force-pipeline/v1", stages: {} }).ok).toBe(false);
    expect(validateForcePipeline(P(["x"])).ok).toBe(false);
    expect(validateForcePipeline(P([{ from: "", to: "b" }])).ok).toBe(false);
    expect(validateForcePipeline(P([{ from: "a", to: 2 }])).ok).toBe(false);
  });
  test("rejects a self-reference and a duplicate edge", () => {
    expect(validateForcePipeline(P([{ from: "a", to: "a" }])).ok).toBe(false);
    expect(validateForcePipeline(P([{ from: "a", to: "b" }, { from: "a", to: "b" }])).ok).toBe(false);
  });
  test("rejects a dangling endpoint when the known node set is supplied", () => {
    expect(validateForcePipeline(P([{ from: "a", to: "ghost" }]), ["a", "b"]).ok).toBe(false);
    expect(validateForcePipeline(P([{ from: "a", to: "b" }]), ["a", "b"]).ok).toBe(true);
  });
  test("rejects a cycle (2-node and 3-node)", () => {
    expect(validateForcePipeline(P([{ from: "a", to: "b" }, { from: "b", to: "a" }])).ok).toBe(false);
    expect(validateForcePipeline(P([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }])).ok).toBe(false);
    expect(validateForcePipeline(P([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }])).ok).toBe(true); // diamond, no cycle
  });
});

describe("force-pipeline — proto-safety grills (own-data reads, index walk)", () => {
  test("a getter from/to field is treated as absent ⇒ reject (never invoked, no TOCTOU)", () => {
    let calls = 0;
    const stage: Record<string, unknown> = { to: "b" };
    Object.defineProperty(stage, "from", { enumerable: true, get() { calls += 1; return "a"; } });
    expect(validateForcePipeline(P([stage])).ok).toBe(false);
    expect(calls).toBe(0);
  });
  test("an inherited stage field does not satisfy a stage (own-only reads)", () => {
    expect(validateForcePipeline(P([Object.create({ from: "a", to: "b" })])).ok).toBe(false);
  });
  test("a hijacked stages iterator cannot hide a cycle edge (index walk)", () => {
    const stages: unknown[] = [{ from: "a", to: "b" }, { from: "b", to: "a" }];
    (stages as { [Symbol.iterator]: unknown })[Symbol.iterator] = function* () { yield stages[0]; }; // would hide the back-edge
    expect(validateForcePipeline({ schema: "force-pipeline/v1", stages }).ok).toBe(false); // cycle still caught
  });
});

describe("force-pipeline — forcedSuccessors + pipelineOrder (deterministic)", () => {
  const linear = okv(validateForcePipeline(P([{ from: "extract", to: "summarize" }, { from: "summarize", to: "write" }])));
  const fan = okv(validateForcePipeline(P([{ from: "a", to: "b" }, { from: "a", to: "c" }])));
  test("forcedSuccessors returns the deterministic forced targets (edge order); none ⇒ []", () => {
    expect(forcedSuccessors(linear, "extract")).toEqual(["summarize"]);
    expect(forcedSuccessors(fan, "a")).toEqual(["b", "c"]);
    expect(forcedSuccessors(linear, "write")).toEqual([]);
  });
  test("pipelineOrder is a deterministic topological order", () => {
    expect(pipelineOrder(linear)).toEqual(["extract", "summarize", "write"]);
    const order = pipelineOrder(fan);
    expect(order[0]).toBe("a"); // the root comes first; b,c follow in first-seen order
    expect(new Set(order)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("force-pipeline — forcePipelineEnabled (dormant, default OFF)", () => {
  test("default OFF; truthy words ON", () => {
    expect(forcePipelineEnabled({})).toBe(false);
    expect(forcePipelineEnabled({ SWARM_FORCE_PIPELINE: "0" })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "YES"]) expect(forcePipelineEnabled({ SWARM_FORCE_PIPELINE: on })).toBe(true);
  });
});
