// Standalone FC-6 (deterministic, no clock/IO/random, enumerated table only) / FC-7 (a when-less edge is byte-identical to a
// force-pipeline unconditional edge and always "take") selftest for conditional-routing. Run: tsx packages/bus/src/swarm/conditional-routing.selftest.mts
import {
  validateConditionalPipeline, evalEdgeCondition, planFanout, fanoutSubtaskId, fanoutMax, conditionalRoutingEnabled,
  DEFAULT_FANOUT_MAX, type ConditionalEdge, type UpstreamView,
} from "./conditional-routing.js";
import { validateForcePipeline } from "./force-pipeline.js";

let pass = 0;
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); } pass++; console.log(`ok  ${msg}`); };
const P = (stages: unknown[]): unknown => ({ schema: "force-pipeline/v1", stages });
const edge = (over: Partial<ConditionalEdge> = {}): ConditionalEdge => ({ from: "a", to: "b", ...over });

// ── FC-7: a when-less pipeline is byte-identical to force-pipeline on {from,to}, and when-less edges always take ──
{
  const raw = P([{ from: "extract", to: "summarize" }, { from: "summarize", to: "write" }]);
  const cr = validateConditionalPipeline(raw), fp = validateForcePipeline(raw);
  ok(cr.ok && fp.ok, "FC-7: a when-less pipeline validates (both validators)");
  if (cr.ok && fp.ok) {
    ok(JSON.stringify(cr.value.stages.map((s) => ({ from: s.from, to: s.to }))) === JSON.stringify(fp.value.stages), "FC-7: when-less {from,to} matches force-pipeline byte-for-byte");
    ok(cr.value.stages.every((s) => !Object.prototype.hasOwnProperty.call(s, "when")), "FC-7: no `when` key on a when-less edge");
  }
  ok(evalEdgeCondition(edge(), { status: "failed" }) === "take", "FC-7: a when-less edge is always take (= unconditional forced edge)");
}

// ── FC-6: evalEdgeCondition is a deterministic three-state table ──
{
  const sok = edge({ when: { kind: "status-ok" } });
  ok(evalEdgeCondition(sok, { status: "ok" }) === "take", "status-ok ok ⇒ take");
  ok(evalEdgeCondition(sok, { status: "failed" }) === "skip", "status-ok failed ⇒ skip");
  ok(evalEdgeCondition(sok, {}) === "unknown", "status-ok absent ⇒ unknown");
  ok(evalEdgeCondition(sok, null) === "unknown", "null upstream ⇒ unknown");
  const rex = edge({ when: { kind: "result-exists" } });
  ok(evalEdgeCondition(rex, { resultRef: "acc-1" }) === "take", "result-exists non-empty ⇒ take");
  ok(evalEdgeCondition(rex, { resultRef: null }) === "skip", "result-exists null ⇒ skip");
  ok(evalEdgeCondition(rex, { resultRef: "" }) === "skip", "result-exists empty ⇒ skip");
  ok(evalEdgeCondition(rex, {}) === "unknown", "result-exists undefined ⇒ unknown");
  const feq = edge({ when: { kind: "field-eq", field: "category", value: "bug" } });
  ok(evalEdgeCondition(feq, { fields: { category: "bug" } }) === "take", "field-eq match ⇒ take");
  ok(evalEdgeCondition(feq, { fields: { category: "feature" } }) === "skip", "field-eq mismatch ⇒ skip");
  ok(evalEdgeCondition(feq, { fields: { other: "bug" } }) === "unknown", "field-eq field absent ⇒ unknown (retry, never silent skip)");
  ok(evalEdgeCondition(feq, {}) === "unknown", "field-eq no fields ⇒ unknown");
  ok(evalEdgeCondition(feq, { fields: { category: 1 } as unknown as Record<string, string> }) === "unknown", "field-eq non-string enum ⇒ unknown");
  ok(evalEdgeCondition(feq, { fields: Object.create({ category: "bug" }) as Record<string, string> }) === "unknown", "field-eq inherited field ⇒ unknown (own-data only)");
  // determinism: 1000x identical inputs ⇒ identical outputs (no clock/IO/random inside).
  let same = true;
  for (let i = 0; i < 1000; i += 1) {
    if (evalEdgeCondition(sok, { status: "ok" }) !== "take") same = false;
    if (evalEdgeCondition(feq, { fields: { category: "feature" } }) !== "skip") same = false;
    if (evalEdgeCondition(rex, {}) !== "unknown") same = false;
  }
  ok(same, "FC-6: 1000x same inputs ⇒ identical evalEdgeCondition output");
}

// ── FC-6: planFanout is deterministic, positional, capped with visible overflow ──
{
  const r1 = planFanout({ templateId: "review" }, ["f1", "f2", "f3"]);
  const r2 = planFanout({ templateId: "review" }, ["f1", "f2", "f3"]);
  ok(r1.ok && r2.ok && JSON.stringify(r1.value) === JSON.stringify(r2.value), "FC-6: planFanout same input ⇒ identical plan");
  ok(r1.ok && r1.value.subtasks.length === 3 && r1.value.subtasks[0]!.subtaskId === fanoutSubtaskId("review", 0), "planFanout expands one subtask per item with positional id");
  ok(r1.ok && !r1.value.capped && r1.value.dropped === 0 && r1.value.total === 3, "planFanout under cap ⇒ not capped");
  const big = planFanout({ templateId: "t" }, Array.from({ length: 20 }, (_, i) => `f${i}`), 8);
  ok(big.ok && big.value.subtasks.length === 8 && big.value.capped && big.value.dropped === 12 && big.value.total === 20, "planFanout caps at 8 and reports overflow (never silent)");
  const a = planFanout({ templateId: "t" }, ["x", "y"]), b = planFanout({ templateId: "t" }, ["CHANGED", "y"]);
  ok(a.ok && b.ok && a.value.subtasks[0]!.subtaskId === b.value.subtasks[0]!.subtaskId && a.value.subtasks[0]!.item !== b.value.subtasks[0]!.item, "positional id is independent of item content (idempotent dispatch)");
  ok(!planFanout({ templateId: "" }, ["a"]).ok, "planFanout rejects an empty templateId");
  ok(!planFanout({ templateId: "t" }, "nope" as unknown as string[]).ok, "planFanout rejects non-array items");
  ok(!planFanout({ templateId: "t" }, ["a", 2 as unknown as string]).ok, "planFanout rejects a non-string expanded item");
  ok(!planFanout({ templateId: "t" }, ["a"], 0).ok, "planFanout rejects a non-positive cap");
  // determinism of the id hash.
  let idSame = true;
  for (let i = 0; i < 1000; i += 1) if (fanoutSubtaskId("t", 3) !== fanoutSubtaskId("t", 3)) idSame = false;
  ok(idSame, "FC-6: 1000x fanoutSubtaskId same (templateId,index) ⇒ identical id");
}

// ── round-1 fixes: CR-P2-1 schema round-trip / CR-P2-2 single capture / CR-P2-3 unreadable ⇒ unknown ──
{
  const input = { schema: "conditional-routing/v1", stages: [{ from: "a", to: "b", when: { kind: "status-ok" } }] };
  const r1 = validateConditionalPipeline(input);
  ok(r1.ok, "CR-P2-1: a conditional-routing/v1 input validates");
  if (r1.ok) {
    const r2 = validateConditionalPipeline(r1.value);
    ok(r2.ok && JSON.stringify(r2.value) === JSON.stringify(r1.value), "CR-P2-1: the output round-trips through the same validator");
  }
  const legacy = validateConditionalPipeline({ schema: "force-pipeline/v1", stages: [{ from: "a", to: "b" }] });
  ok(legacy.ok && validateConditionalPipeline(legacy.value).ok, "CR-P2-1: legacy force-pipeline/v1 accepted (FC-7) and its output round-trips");
  // CR-P2-2: a mutating stage slot is read once; its when is not lost.
  const withWhen = { from: "a", to: "b", when: { kind: "status-ok" } }, withoutWhen = { from: "a", to: "b" };
  let reads = 0;
  const stages: unknown[] = [withWhen];
  Object.defineProperty(stages, "0", { enumerable: true, configurable: true, get() { reads += 1; return reads === 1 ? withWhen : withoutWhen; } });
  const rc = validateConditionalPipeline({ schema: "conditional-routing/v1", stages });
  ok(rc.ok && JSON.stringify((rc.value.stages[0] as { when?: unknown }).when) === JSON.stringify({ kind: "status-ok" }) && reads === 1, "CR-P2-2: single capture — slot read once, condition survives");
  const getterStages: Record<string, unknown> = { schema: "conditional-routing/v1" };
  Object.defineProperty(getterStages, "stages", { enumerable: true, get() { return [{ from: "a", to: "b" }]; } });
  ok(!validateConditionalPipeline(getterStages).ok, "CR-P2-2: an uncapturable `stages` getter is rejected whole");
  // CR-P2-3: throwing getters / Proxy trap ⇒ unknown (never throw, never skip).
  const boom = {} as UpstreamView;
  for (const k of ["status", "resultRef", "fields"]) Object.defineProperty(boom, k, { enumerable: true, get() { throw new Error("boom"); } });
  ok(evalEdgeCondition(edge({ when: { kind: "status-ok" } }), boom) === "unknown" && evalEdgeCondition(edge({ when: { kind: "result-exists" } }), boom) === "unknown" && evalEdgeCondition(edge({ when: { kind: "field-eq", field: "c", value: "x" } }), boom) === "unknown", "CR-P2-3: throwing upstream getters ⇒ unknown");
  const proxied = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } }) as UpstreamView;
  ok(evalEdgeCondition(edge({ when: { kind: "status-ok" } }), proxied) === "unknown", "CR-P2-3: a Proxy descriptor trap that throws ⇒ unknown (never escapes the three states)");
}

// ── flags ──
{
  ok(fanoutMax({}) === DEFAULT_FANOUT_MAX, "fanoutMax default 8");
  ok(fanoutMax({ SWARM_FANOUT_MAX: "16" }) === 16, "fanoutMax honors a valid integer");
  ok(fanoutMax({ SWARM_FANOUT_MAX: "0" }) === 8 && fanoutMax({ SWARM_FANOUT_MAX: "99999" }) === 8 && fanoutMax({ SWARM_FANOUT_MAX: "x" }) === 8, "fanoutMax falls back on a bad value");
  ok(conditionalRoutingEnabled({}) === false && conditionalRoutingEnabled({ SWARM_CONDITIONAL_ROUTING: "0" }) === false, "conditionalRoutingEnabled dormant default OFF");
  ok(["1", "true", "yes", "on", "ON"].every((w) => conditionalRoutingEnabled({ SWARM_CONDITIONAL_ROUTING: w })), "conditionalRoutingEnabled truthy words ON");
}

console.log(`\nall conditional-routing selftests passed (${pass})`);
