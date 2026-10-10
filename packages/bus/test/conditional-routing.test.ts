import { describe, expect, test } from "vitest";
import {
  validateConditionalPipeline, evalEdgeCondition, planFanout, fanoutSubtaskId, fanoutMax, conditionalRoutingEnabled,
  DEFAULT_FANOUT_MAX, type ConditionalPipeline, type ConditionalEdge, type UpstreamView,
} from "../src/swarm/conditional-routing.js";
import { validateForcePipeline } from "../src/swarm/force-pipeline.js";

const okv = (r: { ok: true; value: ConditionalPipeline } | { ok: false; reason: string }): ConditionalPipeline => { if (!r.ok) throw new Error(r.reason); return r.value; };
const P = (stages: unknown[]): unknown => ({ schema: "force-pipeline/v1", stages });
const edge = (over: Partial<ConditionalEdge> = {}): ConditionalEdge => ({ from: "a", to: "b", ...over });

describe("conditional-routing — validateConditionalPipeline (layers `when` on force-pipeline, whole-reject)", () => {
  test("FC-7: a when-less pipeline validates and its {from,to} stages match force-pipeline byte-for-byte", () => {
    const raw = P([{ from: "extract", to: "summarize" }, { from: "summarize", to: "write" }]);
    const cr = okv(validateConditionalPipeline(raw));
    const fp = validateForcePipeline(raw);
    expect(cr.schema).toBe("conditional-routing/v1");
    expect(fp.ok && cr.stages.map((s) => ({ from: s.from, to: s.to }))).toEqual(fp.ok ? fp.value.stages : null);
    expect(cr.stages.every((s) => s.when === undefined)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cr.stages[0]!, "when")).toBe(false); // no `when` key on a when-less edge
  });
  test("accepts each predicate kind", () => {
    expect(okv(validateConditionalPipeline(P([{ from: "a", to: "b", when: { kind: "status-ok" } }]))).stages[0]!.when).toEqual({ kind: "status-ok" });
    expect(okv(validateConditionalPipeline(P([{ from: "a", to: "b", when: { kind: "result-exists" } }]))).stages[0]!.when).toEqual({ kind: "result-exists" });
    expect(okv(validateConditionalPipeline(P([{ from: "a", to: "b", when: { kind: "field-eq", field: "category", value: "bug" } }]))).stages[0]!.when).toEqual({ kind: "field-eq", field: "category", value: "bug" });
  });
  test("rejects an illegal `when` (unknown kind / bad field-eq) WHOLE", () => {
    expect(validateConditionalPipeline(P([{ from: "a", to: "b", when: { kind: "eval", expr: "1" } }])).ok).toBe(false); // no free expressions
    expect(validateConditionalPipeline(P([{ from: "a", to: "b", when: { kind: "field-eq", field: "", value: "x" } }])).ok).toBe(false);
    expect(validateConditionalPipeline(P([{ from: "a", to: "b", when: { kind: "field-eq", field: "c", value: 1 } }])).ok).toBe(false);
    expect(validateConditionalPipeline(P([{ from: "a", to: "b", when: "status-ok" }])).ok).toBe(false);
  });
  test("still inherits force-pipeline rejections (cycle / dup / dangling) through the wrapper", () => {
    expect(validateConditionalPipeline(P([{ from: "a", to: "b", when: { kind: "status-ok" } }, { from: "b", to: "a" }])).ok).toBe(false); // cycle
    expect(validateConditionalPipeline(P([{ from: "a", to: "b" }, { from: "a", to: "b", when: { kind: "status-ok" } }])).ok).toBe(false); // dup edge
    expect(validateConditionalPipeline(P([{ from: "a", to: "ghost", when: { kind: "status-ok" } }]), ["a", "b"]).ok).toBe(false); // dangling
  });
  test("proto-safety: a getter `when` is read as own-data (never invoked)", () => {
    let calls = 0;
    const stage: Record<string, unknown> = { from: "a", to: "b" };
    Object.defineProperty(stage, "when", { enumerable: true, get() { calls += 1; return { kind: "status-ok" }; } });
    const r = validateConditionalPipeline(P([stage]));
    expect(calls).toBe(0);
    expect(r.ok && r.value.stages[0]!.when).toBeUndefined(); // getter value not captured ⇒ treated as when-less
  });
});

describe("conditional-routing — evalEdgeCondition (three-state take/skip/unknown, FC-6)", () => {
  test("no `when` ⇒ take; null/undefined upstream ⇒ unknown", () => {
    expect(evalEdgeCondition(edge(), { status: "failed" })).toBe("take");
    expect(evalEdgeCondition(edge({ when: { kind: "status-ok" } }), null)).toBe("unknown");
    expect(evalEdgeCondition(edge({ when: { kind: "status-ok" } }), undefined)).toBe("unknown");
  });
  test("status-ok: ok⇒take, failed⇒skip, absent⇒unknown", () => {
    const e = edge({ when: { kind: "status-ok" } });
    expect(evalEdgeCondition(e, { status: "ok" })).toBe("take");
    expect(evalEdgeCondition(e, { status: "failed" })).toBe("skip");
    expect(evalEdgeCondition(e, {})).toBe("unknown");
  });
  test("result-exists: non-empty⇒take, null/\"\"⇒skip, undefined⇒unknown", () => {
    const e = edge({ when: { kind: "result-exists" } });
    expect(evalEdgeCondition(e, { resultRef: "acc-123" })).toBe("take");
    expect(evalEdgeCondition(e, { resultRef: null })).toBe("skip");
    expect(evalEdgeCondition(e, { resultRef: "" })).toBe("skip");
    expect(evalEdgeCondition(e, {})).toBe("unknown");
  });
  test("field-eq: match⇒take, mismatch⇒skip, fields/field absent or non-string⇒unknown", () => {
    const e = edge({ when: { kind: "field-eq", field: "category", value: "bug" } });
    expect(evalEdgeCondition(e, { fields: { category: "bug" } })).toBe("take");
    expect(evalEdgeCondition(e, { fields: { category: "feature" } })).toBe("skip");
    expect(evalEdgeCondition(e, { fields: { other: "bug" } })).toBe("unknown"); // field absent ⇒ retry (not silently skip)
    expect(evalEdgeCondition(e, {})).toBe("unknown"); // no fields view
    expect(evalEdgeCondition(e, { fields: { category: 1 } as unknown as Record<string, string> })).toBe("unknown"); // non-string enum
  });
  test("field-eq is proto-safe (an inherited field does not satisfy)", () => {
    const e = edge({ when: { kind: "field-eq", field: "category", value: "bug" } });
    const up: UpstreamView = { fields: Object.create({ category: "bug" }) as Record<string, string> };
    expect(evalEdgeCondition(e, up)).toBe("unknown"); // inherited, not own ⇒ not readable
  });
});

describe("conditional-routing — planFanout (positional, capped, visible overflow, FC-6)", () => {
  test("expands one subtask per item (positional id, index, item)", () => {
    const r = planFanout({ templateId: "review" }, ["f1.ts", "f2.ts", "f3.ts"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.subtasks.length).toBe(3);
    expect(r.value.subtasks.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(r.value.subtasks.map((s) => s.item)).toEqual(["f1.ts", "f2.ts", "f3.ts"]);
    expect(r.value.subtasks[0]!.subtaskId).toBe(fanoutSubtaskId("review", 0));
    expect(r.value).toMatchObject({ total: 3, capped: false, dropped: 0 });
  });
  test("caps at the limit and reports overflow (never silent)", () => {
    const items = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const r = planFanout({ templateId: "t" }, items, 8);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.subtasks.length).toBe(8);
    expect(r.value).toMatchObject({ total: 20, capped: true, dropped: 12 });
  });
  test("positional id is independent of item content (idempotent dispatch)", () => {
    const a = planFanout({ templateId: "t" }, ["x", "y"]);
    const b = planFanout({ templateId: "t" }, ["CHANGED", "y"]);
    expect(a.ok && b.ok && a.value.subtasks[0]!.subtaskId).toBe(b.ok ? b.value.subtasks[0]!.subtaskId : "");
    expect(a.ok && b.ok && a.value.subtasks[0]!.item !== b.value.subtasks[0]!.item).toBe(true); // content differs, id same
  });
  test("rejects bad template / non-array items / non-string expanded item / bad cap", () => {
    expect(planFanout({ templateId: "" }, ["a"]).ok).toBe(false);
    expect(planFanout({} as { templateId: string }, ["a"]).ok).toBe(false);
    expect(planFanout({ templateId: "t" }, "nope" as unknown as string[]).ok).toBe(false);
    expect(planFanout({ templateId: "t" }, ["a", 2 as unknown as string]).ok).toBe(false);
    expect(planFanout({ templateId: "t" }, ["a"], 0).ok).toBe(false);
  });
  test("a non-string item BEYOND the cap does not reject (only expanded items are validated)", () => {
    const items = [...Array.from({ length: 8 }, (_, i) => `f${i}`), 999 as unknown as string];
    const r = planFanout({ templateId: "t" }, items, 8);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ total: 9, capped: true, dropped: 1 });
  });
});

describe("conditional-routing — round-1 fixes (schema round-trip / single-capture / unreadable-upstream)", () => {
  test("CR-P2-1: a conditional-routing/v1 input validates and the output round-trips; legacy force-pipeline/v1 still accepted (FC-7)", () => {
    const input = { schema: "conditional-routing/v1", stages: [{ from: "a", to: "b", when: { kind: "status-ok" } }] };
    const r1 = validateConditionalPipeline(input);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = validateConditionalPipeline(r1.value); // the output is conditional-routing/v1 — must re-validate
    expect(r2.ok).toBe(true);
    expect(r2.ok && r2.value).toEqual(r1.value);
    const legacy = validateConditionalPipeline({ schema: "force-pipeline/v1", stages: [{ from: "a", to: "b" }] });
    expect(legacy.ok).toBe(true);
    expect(legacy.ok && validateConditionalPipeline(legacy.value).ok).toBe(true);
    expect(validateConditionalPipeline({ schema: "nope/v1", stages: [] }).ok).toBe(false); // an unknown schema still rejects
  });
  test("CR-P2-2: structure and condition come from ONE capture — a mutating stage slot is read once and its `when` is not lost", () => {
    const withWhen = { from: "a", to: "b", when: { kind: "status-ok" } };
    const withoutWhen = { from: "a", to: "b" };
    let reads = 0;
    const stages: unknown[] = [withWhen]; // length 1
    Object.defineProperty(stages, "0", { enumerable: true, configurable: true, get() { reads += 1; return reads === 1 ? withWhen : withoutWhen; } });
    const r = validateConditionalPipeline({ schema: "conditional-routing/v1", stages });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.stages[0]!.when).toEqual({ kind: "status-ok" }); // the first-captured condition survives
    expect(reads).toBe(1); // the slot is read EXACTLY once (no second read to detach the condition)
  });
  test("CR-P2-2: an uncapturable `stages` (a getter) is rejected whole (cannot reliably capture)", () => {
    const input: Record<string, unknown> = { schema: "conditional-routing/v1" };
    Object.defineProperty(input, "stages", { enumerable: true, get() { return [{ from: "a", to: "b", when: { kind: "status-ok" } }]; } });
    expect(validateConditionalPipeline(input).ok).toBe(false);
  });
  test("CR-P2-2 (r2): predicate CONTENT is copied at capture — a later stage-read that mutates an earlier edge's `when` cannot detach it", () => {
    const edge0 = { from: "a", to: "b", when: { kind: "status-ok" } as Record<string, unknown> };
    const stages: unknown[] = [edge0, { from: "c", to: "d" }];
    let mutated = false;
    // reading stage[1] mutates the already-captured edge0.when (hostile late mutation during the capture walk)
    Object.defineProperty(stages, "1", { enumerable: true, configurable: true, get() { if (!mutated) { mutated = true; edge0.when = { kind: "result-exists" }; } return { from: "c", to: "d" }; } });
    const r = validateConditionalPipeline({ schema: "conditional-routing/v1", stages });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.stages[0]!.when).toEqual({ kind: "status-ok" }); // the first-captured predicate CONTENT survives
  });
  test("CR-P2-2 (r2): a knownNodes read that mutates the raw cannot alter a captured edge's endpoints or predicate", () => {
    const edge0 = { from: "a", to: "b", when: { kind: "field-eq", field: "cat", value: "bug" } as Record<string, unknown> };
    const stages = [edge0];
    const known: string[] = ["a", "b"];
    // reading knownNodes[0] (during the structural check, AFTER capture) mutates edge0 — must not affect the output
    Object.defineProperty(known, "0", { enumerable: true, configurable: true, get() { edge0.from = "X"; edge0.when = { kind: "result-exists" }; return "a"; } });
    const r = validateConditionalPipeline({ schema: "conditional-routing/v1", stages }, known);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.stages[0]!.from).toBe("a"); expect(r.value.stages[0]!.when).toEqual({ kind: "field-eq", field: "cat", value: "bug" }); }
  });
  test("CR-P2-3: an unreadable upstream (throwing getter / Proxy descriptor trap) ⇒ unknown, never throws, never skip", () => {
    const getterBoom = {} as UpstreamView;
    for (const k of ["status", "resultRef", "fields"]) Object.defineProperty(getterBoom, k, { enumerable: true, get() { throw new Error("boom"); } });
    expect(evalEdgeCondition(edge({ when: { kind: "status-ok" } }), getterBoom)).toBe("unknown");
    expect(evalEdgeCondition(edge({ when: { kind: "result-exists" } }), getterBoom)).toBe("unknown");
    expect(evalEdgeCondition(edge({ when: { kind: "field-eq", field: "c", value: "x" } }), getterBoom)).toBe("unknown");
    const f = {}; Object.defineProperty(f, "c", { enumerable: true, get() { throw new Error("boom"); } });
    expect(evalEdgeCondition(edge({ when: { kind: "field-eq", field: "c", value: "x" } }), { fields: f } as UpstreamView)).toBe("unknown");
    const proxied = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } }) as UpstreamView;
    expect(evalEdgeCondition(edge({ when: { kind: "status-ok" } }), proxied)).toBe("unknown");
    expect(evalEdgeCondition(edge({ when: { kind: "field-eq", field: "c", value: "x" } }), proxied)).toBe("unknown");
  });
});

describe("conditional-routing — flags", () => {
  test("fanoutMax: default 8; integer in [1,1000] honored; bad value falls back", () => {
    expect(fanoutMax({})).toBe(DEFAULT_FANOUT_MAX);
    expect(fanoutMax({ SWARM_FANOUT_MAX: "16" })).toBe(16);
    expect(fanoutMax({ SWARM_FANOUT_MAX: "0" })).toBe(8);
    expect(fanoutMax({ SWARM_FANOUT_MAX: "99999" })).toBe(8);
    expect(fanoutMax({ SWARM_FANOUT_MAX: "x" })).toBe(8);
    expect(fanoutMax({ SWARM_FANOUT_MAX: "2.5" })).toBe(8);
  });
  test("conditionalRoutingEnabled: dormant, default OFF; truthy words ON", () => {
    expect(conditionalRoutingEnabled({})).toBe(false);
    expect(conditionalRoutingEnabled({ SWARM_CONDITIONAL_ROUTING: "0" })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "ON"]) expect(conditionalRoutingEnabled({ SWARM_CONDITIONAL_ROUTING: on })).toBe(true);
  });
});
