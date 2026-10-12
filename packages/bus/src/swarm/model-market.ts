/**
 * model-market capability-profile cache — PURE core (model-staffing piece ①, brief §2①). Owns the FROZEN snapshot schema +
 * the parse/trim of the raw upstream `model-market-full.json` into a bounded local snapshot, a staleness helper, and the
 * SWARM_MODEL_MARKET flag reader. The IO half (fetch + CP-2 three-state atomic write + reader) lives in
 * `model-market-store.ts`, mirroring the console-projection pure-core / -store split.
 *
 * Evidence-honest note on the upstream shape (verified against the live file 2026-10-11): the documented `category_scores`
 * (`cats`) object is EMPTY on every one of the 150 models today; the real per-benchmark numbers live in `bench`
 * (iq / coding / agent / scicode / gpqa / lcr / …). So parseModelMarket DERIVES the four board dimensions pickModel needs
 * (coding / agentic / science / long_context) from `cats` when present, ELSE from the relevant `bench` benchmarks (a documented
 * fallback chain — so a snapshot stays useful even when `cats` is unpopulated). Upstream model ids carry a `::<effort>` suffix
 * (`claude-opus-5.5::max`); the BASE id (before `::`) is what the model-market↔CPA map (Q1) keys on — see marketBaseId.
 *
 * FC-7 ADDITIVE: the schema string `model-market-snapshot/v1` fixes the shape; future fields are additive, never a re-version.
 * Pure: no fs, no clock beyond an injected `nowSec` / `fetchedAtSec`, no top-level side effects.
 */
import { flagDefaultOn } from "./flag-default.js";

export const MODEL_MARKET_SCHEMA = "model-market-snapshot/v1" as const;

/** The four board dimensions pickModel maps a taskShape onto (brief §2②). `composite` (the 0..100 board `score`) is handled
 *  separately as the review / general dimension. */
export type BoardDimension = "coding" | "agentic" | "science" | "long_context";

/** Derived per-dimension capability scores (each present only when a source value existed — see deriveCategoryScores). Mixed
 *  native scales (coding/science/long_context ~0..1 fractions, agentic ~0..1); comparisons are ALWAYS within ONE dimension. */
export type CategoryScores = Partial<Record<BoardDimension, number>>;

/** The single cheapest cross-provider offer, trimmed to the price-delta evidence pickModel needs. */
export type CheapestOffer = { provider: string; blendedUsdPer1M: number };

/** One trimmed model in the local snapshot — ONLY the fields pickModel + the evidence need (the rest of the ~5 KB-per-model
 *  upstream record is dropped to bound the cached snapshot size). */
export type MarketModel = {
  /** Upstream model id, INCLUDING the `::<effort>` suffix (`claude-opus-5.5::max`) — the suggestion identity + the map key base. */
  id: string;
  /** Upstream `org` — the provider, i.e. the heterogeneity axis for review (Q6 cross-provider preference). "" when unknown. */
  provider: string;
  /** Derived board dimensions (coding / agentic / science / long_context); a dimension is absent when no source value existed. */
  categoryScores: CategoryScores;
  /** The board's 0..100 composite `score` (the review / general dimension). ABSENT when no source value existed — MS-P2-5: never
   *  fabricated as 0 (a fabricated 0 would make a scoreless model a valid general/review candidate). */
  composite?: number;
  /** 10:1 blended $/1M (price evidence + the light/standard cost-optimization key). ABSENT when no source value existed — MS-P2-5:
   *  never fabricated as 0 (a fabricated 0 would pass any budget ceiling and win every cheapest tiebreak). */
  blendedUsdPer1M?: number;
  /** Top cross-provider cheapest offer (trimmed), when upstream listed one. */
  cheapestOffer?: CheapestOffer;
  /** On the cost-performance frontier (upstream `pareto`) — the light tier's "够用且性价比最优" preference. */
  pareto?: boolean;
  /** Upstream `deprecated` — a deprecated model is NEVER suggested (dropped from the candidate universe). */
  deprecated?: boolean;
};

/** The frozen local snapshot. `fetchedAtSec` is WHEN WE fetched (our cache age for staleness), not the upstream `updated_at`. */
export type ModelMarketSnapshot = {
  schema: typeof MODEL_MARKET_SCHEMA;
  fetchedAtSec: number;
  models: MarketModel[];
};

/** SWARM_MODEL_MARKET gates the periodic snapshot pull — LIVE BY DEFAULT (opt-out via [[flagDefaultOn]], coordinator freeze
 *  Q2: suggestion mode is a pure read-only projection, zero risk). Read at the call site (never a module-level constant) so a
 *  later env change is seen. Kill-switch: `SWARM_MODEL_MARKET=0`. Pure. */
export function modelMarketEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_MODEL_MARKET);
}

/** The base model id the Q1 map keys on: everything before the `::<effort>` suffix (`claude-opus-5.5::max` ⇒ `claude-opus-5.5`),
 *  so all effort variants of one family resolve through a single map entry. Pure. */
export function marketBaseId(id: string): string {
  const i = id.indexOf("::");
  return i === -1 ? id : id.slice(0, i);
}

/** Cache age in seconds (nowSec - fetchedAtSec, floored at 0). A non-finite input ⇒ Number.POSITIVE_INFINITY (unknown age ⇒
 *  treat as maximally stale) — a COMPARISON scalar only, never serialized directly (the projection clamps it to null). Pure. */
export function staleSec(snapshot: Pick<ModelMarketSnapshot, "fetchedAtSec">, nowSec: number): number {
  if (!Number.isFinite(nowSec) || !Number.isFinite(snapshot.fetchedAtSec)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowSec - snapshot.fetchedAtSec);
}

/** A finite number, else undefined (not 0 — undefined means "no source value", which the board/score logic treats as "absent"). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The first finite value in the fallback chain, else undefined. */
function firstNum(...vs: unknown[]): number | undefined {
  for (const v of vs) { const n = num(v); if (n !== undefined) return n; }
  return undefined;
}

/**
 * Derive the four board dimensions. Prefer the documented `cats.<dim>` when populated (the upstream intends this to carry the
 * category scores); fall back to the raw `bench` benchmarks that most directly represent each dimension (verified live: `cats`
 * is empty today, so WITHOUT this fallback a snapshot would carry no board scores at all). A dimension stays ABSENT when no
 * source has a finite value — never fabricated as 0. Pure.
 */
function deriveCategoryScores(cats: Record<string, unknown>, bench: Record<string, unknown>): CategoryScores {
  const out: CategoryScores = {};
  const coding = firstNum(cats.coding, bench.coding, bench.livecodebench);          // AA coding / livecodebench
  const agentic = firstNum(cats.agentic, bench.agent, bench.terminalbench, bench.tau2); // agentic / terminal-bench / tau2
  const science = firstNum(cats.science, bench.scicode, bench.gpqa);                // scicode / gpqa
  const long_context = firstNum(cats.long_context, bench.lcr);                      // long-context recall
  if (coding !== undefined) out.coding = coding;
  if (agentic !== undefined) out.agentic = agentic;
  if (science !== undefined) out.science = science;
  if (long_context !== undefined) out.long_context = long_context;
  return out;
}

/**
 * Parse + TRIM the raw upstream `model-market-full.json` into the bounded snapshot. `fetchedAtSec` is stamped by the caller (the
 * store, at fetch time). Returns null for an UNRECOGNIZED shape (not an object, or no `models` array) — CP-2: the store then
 * KEEPS the last snapshot rather than overwriting with garbage. A per-model unusable entry (not an object / no id) is SKIPPED
 * (never crashes the whole parse on one bad model). Pure.
 */
export function parseModelMarket(raw: unknown, fetchedAtSec: number): ModelMarketSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.models)) return null; // unrecognized shape ⇒ null (CP-2: keep last, never write a fabricated empty)
  const models: MarketModel[] = [];
  for (const mRaw of r.models) {
    if (!mRaw || typeof mRaw !== "object") continue;
    const m = mRaw as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length === 0) continue; // an id is required (the suggestion identity + map key)
    const cats = m.cats && typeof m.cats === "object" ? (m.cats as Record<string, unknown>) : {};
    const bench = m.bench && typeof m.bench === "object" ? (m.bench as Record<string, unknown>) : {};
    const model: MarketModel = {
      id: m.id,
      provider: typeof m.org === "string" ? m.org : "",
      categoryScores: deriveCategoryScores(cats, bench),
    };
    const comp = num(m.score); if (comp !== undefined) model.composite = comp;       // MS-P2-5: set only when a finite source value exists
    const blended = num(m.blended); if (blended !== undefined) model.blendedUsdPer1M = blended; // MS-P2-5: never fabricate 0
    const offer = Array.isArray(m.cheapest) ? m.cheapest[0] : undefined;
    if (offer && typeof offer === "object") {
      const o = offer as Record<string, unknown>;
      const ob = num(o.blended);
      if (ob !== undefined) model.cheapestOffer = { provider: typeof o.provider === "string" ? o.provider : "", blendedUsdPer1M: ob };
    }
    if (m.pareto === true) model.pareto = true;
    if (m.deprecated === true) model.deprecated = true;
    models.push(model);
  }
  return { schema: MODEL_MARKET_SCHEMA, fetchedAtSec: Number.isFinite(fetchedAtSec) ? fetchedAtSec : 0, models };
}

/** Sanitize ONE raw model record read back from disk (MS-P2-5): require a string id; keep ONLY finite numeric evidence (a dimension
 *  score / composite / price that is a string or NaN is DROPPED, never trusted as a value). A record with no usable id ⇒ null (skip).
 *  So a corrupt / foreign on-disk record can never inject a fabricated or string "score" into a suggestion. Pure. */
function sanitizeModel(raw: unknown): MarketModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length === 0) return null;
  const cs = m.categoryScores && typeof m.categoryScores === "object" ? (m.categoryScores as Record<string, unknown>) : {};
  const categoryScores: CategoryScores = {};
  for (const dim of ["coding", "agentic", "science", "long_context"] as const) { const v = num(cs[dim]); if (v !== undefined) categoryScores[dim] = v; }
  const out: MarketModel = { id: m.id, provider: typeof m.provider === "string" ? m.provider : "", categoryScores };
  const comp = num(m.composite); if (comp !== undefined) out.composite = comp;
  const blended = num(m.blendedUsdPer1M); if (blended !== undefined) out.blendedUsdPer1M = blended;
  if (m.cheapestOffer && typeof m.cheapestOffer === "object") { const o = m.cheapestOffer as Record<string, unknown>; const ob = num(o.blendedUsdPer1M); if (ob !== undefined) out.cheapestOffer = { provider: typeof o.provider === "string" ? o.provider : "", blendedUsdPer1M: ob }; }
  if (m.pareto === true) out.pareto = true;
  if (m.deprecated === true) out.deprecated = true;
  return out;
}

/**
 * Validate a snapshot read back from disk (the read side of CP-2): the schema string must match, `fetchedAtSec` must be finite,
 * and `models` must be an array. A structurally-INVALID file ⇒ null (the caller treats it as "no usable cache", never trusts a
 * half-written / foreign file). MS-P2-5: each model record is SANITIZED (string id required, only finite numeric evidence kept) so
 * a corrupt on-disk record can never produce a fabricated/NaN suggestion. Returns a CLEANED snapshot (a new object). Pure.
 */
export function validSnapshot(raw: unknown): ModelMarketSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== MODEL_MARKET_SCHEMA) return null;
  const fetchedAtSec = num(r.fetchedAtSec);
  if (fetchedAtSec === undefined) return null;
  if (!Array.isArray(r.models)) return null;
  const models: MarketModel[] = [];
  for (const mRaw of r.models) { const m = sanitizeModel(mRaw); if (m !== null) models.push(m); }
  return { schema: MODEL_MARKET_SCHEMA, fetchedAtSec, models };
}
