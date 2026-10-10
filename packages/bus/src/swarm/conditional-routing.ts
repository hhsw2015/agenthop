/**
 * conditional-routing v1 (docs/swarm/conditional-routing-brief.md). Absorption case ② from the AgentGate eval
 * (docs/research/agent-gate-eval.md §2 / §4, engine-mirror top borrow): runtime CONDITIONAL edges + dynamic FAN-OUT, layered on
 * top of force-pipeline (DA4) and task-plan. It makes a forced hand-off run at RUNTIME conditional on the upstream result, and
 * lets one template task expand into N subtasks by an upstream-produced items array (LangGraph-style Send), WITHOUT free
 * expressions and WITHOUT the LLM — pure, deterministic (FC-6), fail-closed, dormant-ahead-of-use.
 *
 * This module does NOT modify force-pipeline.ts (byte-stable, landed): it reuses `validateForcePipeline` for the DAG / dedup /
 * dangling / cycle checks on the {from,to} projection, then attaches an optional `when` predicate per edge. The predicate is an
 * ENUMERATED table (status-ok / result-exists / field-eq) — never a free expression — so `evalEdgeCondition` is a deterministic,
 * side-effect-free three-state decision (take / skip / unknown). `unknown` (the upstream result or the field it needs is not
 * readable) means "do not take the edge, do not error, preserve retry" — it is NEVER collapsed to `skip` (which would silently
 * drop the successor). Fan-out is positional and capped (SWARM_FANOUT_MAX, default 8) with VISIBLE overflow (capped / dropped),
 * never a silent truncation. Trust-boundary discipline mirrors force-pipeline / task-plan / grill-gate: untrusted input validates
 * WHOLE or is rejected; own-data properties are read once via ownVal; arrays are walked BY INDEX (never the input's iterator).
 *
 * The SEAM (dispatcher / T3: eval each edge before force-dispatch — take⇒dispatch, skip⇒prune, unknown⇒leave pending; and
 * materialize a TaskSpec per fan-out subtask) is documented in the brief; this module wires into nothing (behind
 * SWARM_CONDITIONAL_ROUTING, default OFF).
 */

import { createHash } from "node:crypto";
import { validateForcePipeline, type ForceStage } from "./force-pipeline.js";

type Res<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function ownVal(o: object, k: string): unknown { const d = Object.getOwnPropertyDescriptor(o, k); return d && "value" in d ? d.value : undefined; }

// ── ① conditional edges ────────────────────────────────────────────────────────────────────────────────────────────────

/** The ENUMERATED edge predicate (no free expressions — FC-6 determinism). A pure predicate over the upstream node's result. */
export type EdgeCondition =
  | { kind: "status-ok" }                                   // upstream status is "ok"
  | { kind: "result-exists" }                               // upstream produced a resultRef
  | { kind: "field-eq"; field: string; value: string };     // an upstream enum field === value (exact string)

/** A force-pipeline edge with an optional runtime condition. No `when` = an unconditional forced edge (back-compat / FC-7). */
export type ConditionalEdge = ForceStage & { when?: EdgeCondition };
export type ConditionalPipeline = { schema: "conditional-routing/v1"; stages: ConditionalEdge[] };

/** The PURE view `evalEdgeCondition` reads of an upstream node (the dispatcher IO layer maps a real AcceptedResult/TaskResult
 *  into this; the pure core never touches task-state). All fields optional: an absent field is treated as "not readable". */
export type UpstreamView = { status?: "ok" | "failed"; resultRef?: string | null; fields?: Readonly<Record<string, string>> };

export type EdgeDecision = "take" | "skip" | "unknown";

/** Validate one untrusted `when` predicate WHOLE or reject it. Enumerated kinds only. */
function validateCondition(w: unknown, where: string): Res<EdgeCondition> {
  if (!isObj(w)) return { ok: false, reason: `${where}.when must be an object` };
  const kind = ownVal(w, "kind");
  if (kind === "status-ok") return { ok: true, value: { kind: "status-ok" } };
  if (kind === "result-exists") return { ok: true, value: { kind: "result-exists" } };
  if (kind === "field-eq") {
    const field = ownVal(w, "field"), value = ownVal(w, "value");
    if (!isNonEmptyStr(field)) return { ok: false, reason: `${where}.when.field must be a non-empty string` };
    if (typeof value !== "string") return { ok: false, reason: `${where}.when.value must be a string` };
    return { ok: true, value: { kind: "field-eq", field, value } };
  }
  return { ok: false, reason: `${where}.when.kind must be one of status-ok|result-exists|field-eq` };
}

/**
 * Validate an untrusted conditional-routing pipeline. Accepts either `conditional-routing/v1` (the declared schema) or a legacy
 * `force-pipeline/v1` (FC-7), and ALWAYS outputs `conditional-routing/v1` — so a legal input validates and the output
 * round-trips through this same validator (CR-P2-1). The raw input is captured EXACTLY ONCE into a plain snapshot (stages array
 * and each stage's own-data from/to/when); both the structural check and the `when` come from that single snapshot — the raw is
 * never re-read, so a mutating/getter slot cannot detach a condition from its edge (CR-P2-2). The structural check (self-ref /
 * duplicate / dangling / cycle / from-to) is delegated to the signed `validateForcePipeline` by handing it a CONTROLLED
 * `force-pipeline/v1` projection built from the snapshot (plain objects, no accessors). A when-less edge produces exactly
 * `{from,to}` (stage byte-identical to force-pipeline, FC-7). Any illegal `when`, an uncapturable stages array, or a bad stage
 * ⇒ whole-reject.
 */
export function validateConditionalPipeline(input: unknown, knownNodes?: readonly string[]): Res<ConditionalPipeline> {
  if (!isObj(input)) return { ok: false, reason: "conditional-routing must be an object" };
  const schema = ownVal(input, "schema");
  if (schema !== "conditional-routing/v1" && schema !== "force-pipeline/v1") {
    return { ok: false, reason: "schema must be \"conditional-routing/v1\" or \"force-pipeline/v1\"" };
  }
  const stagesRaw = ownVal(input, "stages");
  if (!Array.isArray(stagesRaw)) return { ok: false, reason: "stages must be an array" };
  // SINGLE capture (CR-P2-2): per edge, read own-data from/to AND fully VALIDATE+COPY the `when` predicate into independent
  // scalar data RIGHT HERE — never keep a raw `when` reference to interpret later. This happens BEFORE the structural check and
  // before any knownNodes read, so a mutation of the raw input triggered by a later stage-read or a knownNodes-read cannot swap a
  // captured edge's endpoints or predicate content. An illegal/uncapturable `when` ⇒ whole-reject.
  const snap: { from: unknown; to: unknown; when?: EdgeCondition }[] = [];
  for (let i = 0; i < stagesRaw.length; i += 1) {           // index walk (never the input's iterator)
    const raw = stagesRaw[i];                               // one read of slot i
    if (!isObj(raw)) return { ok: false, reason: `stage[${i}] must be an object` };
    const from = ownVal(raw, "from"), to = ownVal(raw, "to"), whenRaw = ownVal(raw, "when");
    if (whenRaw === undefined) { snap.push({ from, to }); continue; }
    const vc = validateCondition(whenRaw, `stage[${i}]`);   // reads kind/field/value NOW and returns a FRESH object (copied scalars)
    if (!vc.ok) return { ok: false, reason: vc.reason };
    snap.push({ from, to, when: vc.value });                // independent condition data — not a raw reference
  }
  // CR-P2-1: hand a CONTROLLED force-pipeline/v1 projection (plain objects from the snapshot) to the signed validator — never
  // the raw input (whose schema may be conditional-routing/v1). Order is preserved, so base.value.stages[i] ↔ snap[i].
  const projection = { schema: "force-pipeline/v1" as const, stages: snap.map((s) => ({ from: s.from, to: s.to })) };
  const base = validateForcePipeline(projection, knownNodes);
  if (!base.ok) return base;
  // Assemble: validated {from,to} (from the snapshot projection) + the already-copied `when` — both independent of the raw since
  // the capture loop, so nothing here re-reads the untrusted input.
  const stages: ConditionalEdge[] = [];
  for (let i = 0; i < base.value.stages.length; i += 1) {
    const vs = base.value.stages[i]!;
    const when = snap[i]!.when;
    stages.push(when === undefined ? { from: vs.from, to: vs.to } : { from: vs.from, to: vs.to, when });
  }
  return { ok: true, value: { schema: "conditional-routing/v1", stages } };
}

/**
 * PURE three-state decision for a conditional edge (FC-6 — no clock/IO/random, enumerated table only). take = traverse the edge
 * (force-dispatch the successor); skip = decided NOT to traverse (the branch is not taken — prunable); unknown = cannot decide
 * right now (the upstream result, or the field the predicate needs, is not readable) ⇒ do NOT traverse, do NOT error, PRESERVE
 * retry. `unknown` is never collapsed to `skip` — that would silently drop the successor.
 */
export function evalEdgeCondition(edge: ConditionalEdge, upstream: UpstreamView | null | undefined): EdgeDecision {
  const w = edge.when;
  if (w === undefined) return "take";                       // unconditional edge (back-compat)
  if (upstream === null || upstream === undefined) return "unknown"; // whole result unreadable
  // CR-P2-3: read EVERY upstream datum as OWN DATA via ownVal (a getter has no descriptor `value` ⇒ returns undefined ⇒ treated
  // as not-readable; the untrusted getter is never invoked), and wrap the whole decision so a hostile Proxy trap on
  // getOwnPropertyDescriptor cannot escape the three states. Any unreadable datum ⇒ unknown (preserve retry), never skip, never throw.
  try {
    switch (w.kind) {
      case "status-ok": {
        const status = ownVal(upstream, "status");
        if (status === undefined) return "unknown";         // absent / getter / explicit-undefined ⇒ not readable
        return status === "ok" ? "take" : "skip";
      }
      case "result-exists": {
        const ref = ownVal(upstream, "resultRef");
        if (ref === undefined) return "unknown";            // absent / getter ⇒ don't know whether a result exists
        return isNonEmptyStr(ref) ? "take" : "skip";        // own-data null / "" ⇒ explicitly no result ⇒ skip
      }
      case "field-eq": {
        const fields = ownVal(upstream, "fields");
        if (!isObj(fields)) return "unknown";               // fields absent / getter / not an object ⇒ enum not readable
        const v = ownVal(fields, w.field);                  // own-data leaf read (proto-safe; getter ⇒ undefined)
        if (typeof v !== "string") return "unknown";        // field absent / getter / malformed ⇒ cannot compare ⇒ retry
        return v === w.value ? "take" : "skip";
      }
    }
  } catch { return "unknown"; }                             // a Proxy descriptor trap threw ⇒ unreadable ⇒ unknown
  return "unknown";                                         // unreachable (exhaustive switch); defensive
}

// ── ② dynamic fan-out (Send semantics) ─────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_FANOUT_MAX = 8;

/** Read SWARM_FANOUT_MAX: an integer in [1,1000] is honored, any bad/absent value falls back to the default 8 (never 0, never huge). */
export function fanoutMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWARM_FANOUT_MAX;
  if (raw === undefined || raw === "") return DEFAULT_FANOUT_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_FANOUT_MAX;
}

export type FanoutSubtask = { subtaskId: string; index: number; item: string };
export type FanoutPlan = { subtasks: FanoutSubtask[]; total: number; capped: boolean; dropped: number };

/** Deterministic, positional subtask id = `fan-` + sha256(templateId \u0000 index)[:16]. Same (templateId, index) ⇒ same id
 *  (idempotent dispatch); the item CONTENT is NOT in the id (it goes into the subtask input, captured by inputBindingDigest). */
export function fanoutSubtaskId(templateId: string, index: number): string {
  return `fan-${createHash("sha256").update(`${templateId}\u0000${index}`).digest("hex").slice(0, 16)}`;
}

/**
 * Expand one template task into N subtasks by the upstream-produced `items` (Send semantics). N = min(items.length, cap); the
 * cap (default SWARM_FANOUT_MAX=8) is an anti-explosion guard. Overflow is NEVER silent: `capped` / `dropped` report it so the
 * dispatcher can escalate or raise the cap. Deterministic (FC-6): same (template, items, cap) ⇒ same plan. Items are positional
 * and must be strings (typed field — no free objects); a non-string among the EXPANDED items ⇒ whole-reject.
 */
export function planFanout(template: { templateId: string }, items: readonly string[], cap: number = DEFAULT_FANOUT_MAX): Res<FanoutPlan> {
  if (!isObj(template)) return { ok: false, reason: "template must be an object" };
  const templateId = ownVal(template, "templateId");
  if (!isNonEmptyStr(templateId)) return { ok: false, reason: "template.templateId must be a non-empty string" };
  if (!Array.isArray(items)) return { ok: false, reason: "items must be an array" };
  if (!(Number.isInteger(cap) && cap >= 1)) return { ok: false, reason: "cap must be a positive integer" };
  const total = items.length;
  const n = total < cap ? total : cap;                      // min(total, cap) without trusting any hijacked comparison
  const subtasks: FanoutSubtask[] = [];
  for (let i = 0; i < n; i += 1) {                          // index walk (never the input's iterator)
    const item = items[i];
    if (typeof item !== "string") return { ok: false, reason: `items[${i}] must be a string` };
    subtasks.push({ subtaskId: fanoutSubtaskId(templateId, i), index: i, item });
  }
  return { ok: true, value: { subtasks, total, capped: total > cap, dropped: total > n ? total - n : 0 } };
}

// ── ③ dormant flag ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dormant wiring flip, default OFF (dormant-ahead-of-use, like SWARM_FORCE_PIPELINE). The dispatcher consults conditional
 *  edges / fan-out only when on; off ⇒ zero runtime change. */
export function conditionalRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_CONDITIONAL_ROUTING ?? "");
}
