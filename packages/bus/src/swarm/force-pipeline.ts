/**
 * force-pipeline (DA4 — docker-agent eval Q2 / 立项④, docs/research/docker-agent-eval.md). Borrows the CONCEPT of
 * docker-agent's `force_handoff`: a DETERMINISTIC hand-off that bypasses LLM judgment — "A outputs ⇒ B unconditionally
 * receives" — for a strict pipeline (extractor → summarizer → …). Our dispatch is LLM-judgment + pull-based, so it lacks a
 * declarative "strict deterministic pipeline" expression; this adds one. A stage is a forced edge A→B; the whole thing must be
 * a DAG (a cycle = an infinite forced hand-off), with no self-reference and no dangling node.
 *
 * PURE core (no IO/clock): the pipeline schema, whole-reject validation (self-ref / dangling / duplicate edge / cycle via a
 * BFS/Kahn topological sweep), the deterministic successor query, and a deterministic topological order. The SEAM — where the
 * T3 planner / dispatcher would, after node A is accepted, force-dispatch each `forcedSuccessors(A)` WITHOUT asking the LLM — is
 * documented here and in the design; this module does NOT wire into T3 (dormant-ahead-of-use behind SWARM_FORCE_PIPELINE).
 *
 * Trust-boundary discipline (mirrors task-plan loadPlan / grill-gate / roleProfile v2): untrusted input validates WHOLE or
 * rejects. Fields are read as OWN DATA properties and captured ONCE; the stages array is walked BY INDEX (never the input's
 * iterator); cycle detection is iterative Kahn (no recursion). Distinct from task-plan's `dependsOn` (a data-flow DAG the
 * scheduler reasons over) — a force-pipeline is a DISPATCH directive: the LLM does not decide the hand-off, it is fixed.
 */

export type ForceStage = { from: string; to: string };
export type ForcePipeline = { schema: "force-pipeline/v1"; stages: ForceStage[] };
type Res<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function ownVal(o: object, k: string): unknown { const d = Object.getOwnPropertyDescriptor(o, k); return d && "value" in d ? d.value : undefined; }

/** Iterative Kahn topological sweep. Returns an order (ties broken by first-seen insertion, so it is DETERMINISTIC) when the
 *  graph is a DAG, else null (a cycle — not all nodes drain). Pure; no recursion, no input methods. `nodes` is the full node
 *  set (in first-seen order); `adj` maps a node to its out-targets (in edge order). */
function kahnOrder(nodes: readonly string[], adj: Map<string, string[]>): string[] | null {
  const indeg = new Map<string, number>();
  for (let i = 0; i < nodes.length; i += 1) indeg.set(nodes[i]!, 0);
  for (const [, outs] of adj) for (let i = 0; i < outs.length; i += 1) indeg.set(outs[i]!, (indeg.get(outs[i]!) ?? 0) + 1);
  const queue: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) if ((indeg.get(nodes[i]!) ?? 0) === 0) queue.push(nodes[i]!); // first-seen order ⇒ deterministic
  const order: string[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const n = queue[head]!;
    order.push(n);
    const outs = adj.get(n) ?? [];
    for (let i = 0; i < outs.length; i += 1) {
      const m = outs[i]!;
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  return order.length === nodes.length ? order : null; // not all drained ⇒ a cycle remains
}

/**
 * Validate an untrusted force-pipeline. Whole-reject on: bad schema; non-array stages; a stage that is not an object; a
 * from/to that is not a non-empty string; a SELF-reference (from === to); a DUPLICATE edge (same from→to twice); a DANGLING
 * node (an endpoint not in `knownNodes`, when the plan's node set is supplied); or a CYCLE (the forced graph must be a DAG).
 * When `knownNodes` is omitted the dangling check is skipped (standalone validation); self-ref/dup/cycle always run.
 */
export function validateForcePipeline(input: unknown, knownNodes?: readonly string[]): Res<ForcePipeline> {
  if (!isObj(input)) return { ok: false, reason: "force-pipeline must be an object" };
  if (ownVal(input, "schema") !== "force-pipeline/v1") return { ok: false, reason: "schema must be \"force-pipeline/v1\"" };
  const stagesRaw = ownVal(input, "stages");
  if (!Array.isArray(stagesRaw)) return { ok: false, reason: "stages must be an array" };
  // FP-P2-2: build the known-node set from the ACTUAL array slots by index — never `new Set(knownNodes)`, which would run the
  // input's (hijackable) iterator and could admit/deny nodes the real array does not contain.
  let known: Set<string> | null = null;
  if (knownNodes !== undefined) {
    if (!Array.isArray(knownNodes)) return { ok: false, reason: "knownNodes must be an array" };
    known = new Set<string>();
    for (let i = 0; i < knownNodes.length; i += 1) known.add(knownNodes[i]!);
  }
  // FP-P2-1: de-dup edges with a NESTED map (from → set of to), NOT a `from + NUL + to` string key — a NUL inside an endpoint
  // would collide two legitimately-different edges. A structural key cannot collide.
  const seenEdge = new Map<string, Set<string>>();
  const stages: ForceStage[] = [];
  const nodeOrder: string[] = [];
  const nodeSet = new Set<string>();
  const adj = new Map<string, string[]>();
  const note = (n: string): void => { if (!nodeSet.has(n)) { nodeSet.add(n); nodeOrder.push(n); } };
  for (let i = 0; i < stagesRaw.length; i += 1) { // index walk (never the input's iterator)
    const raw = stagesRaw[i];
    if (!isObj(raw)) return { ok: false, reason: `stage[${i}] must be an object` };
    const from = ownVal(raw, "from"), to = ownVal(raw, "to"); // capture once
    if (!isNonEmptyStr(from)) return { ok: false, reason: `stage[${i}].from must be a non-empty string` };
    if (!isNonEmptyStr(to)) return { ok: false, reason: `stage[${i}].to must be a non-empty string` };
    if (from === to) return { ok: false, reason: `stage[${i}] is a self-reference ("${from}" → itself)` };
    if (known && !known.has(from)) return { ok: false, reason: `stage[${i}].from "${from}" is not a known node (dangling)` };
    if (known && !known.has(to)) return { ok: false, reason: `stage[${i}].to "${to}" is not a known node (dangling)` };
    let tos = seenEdge.get(from);
    if (!tos) { tos = new Set<string>(); seenEdge.set(from, tos); }
    if (tos.has(to)) return { ok: false, reason: `duplicate stage "${from}" → "${to}"` };
    tos.add(to);
    stages.push({ from, to });
    note(from); note(to);
    const outs = adj.get(from) ?? [];
    outs.push(to);
    adj.set(from, outs);
  }
  if (kahnOrder(nodeOrder, adj) === null) return { ok: false, reason: "force-pipeline has a cycle (the forced hand-off graph must be a DAG)" };
  return { ok: true, value: { schema: "force-pipeline/v1", stages } };
}

/** The deterministic forced targets of `from` (every B that must receive A's output), in declared edge order. A node with no
 *  forced successor returns []. Operates on a VALIDATED pipeline. */
export function forcedSuccessors(pipeline: ForcePipeline, from: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < pipeline.stages.length; i += 1) if (pipeline.stages[i]!.from === from) out.push(pipeline.stages[i]!.to);
  return out;
}

/** A deterministic topological order of a VALIDATED pipeline's nodes (the strict execution sequence; ties broken by first-seen
 *  edge order). Never null for a validated pipeline (validation already rejected cycles). */
export function pipelineOrder(pipeline: ForcePipeline): string[] {
  const nodeOrder: string[] = [];
  const nodeSet = new Set<string>();
  const adj = new Map<string, string[]>();
  const note = (n: string): void => { if (!nodeSet.has(n)) { nodeSet.add(n); nodeOrder.push(n); } };
  for (let i = 0; i < pipeline.stages.length; i += 1) {
    const s = pipeline.stages[i]!;
    note(s.from); note(s.to);
    const outs = adj.get(s.from) ?? [];
    outs.push(s.to);
    adj.set(s.from, outs);
  }
  return kahnOrder(nodeOrder, adj) ?? []; // validated ⇒ never a cycle; [] only for an empty pipeline
}

/** Dormant wiring flip, default OFF (dormant-ahead-of-use, like SWARM_BOARD_ADMIT). T3/dispatch force-dispatches successors only when on. */
export function forcePipelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_FORCE_PIPELINE ?? "");
}
