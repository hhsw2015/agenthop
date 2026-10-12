/**
 * model-staffing — PURE core (model-staffing piece ②③a, brief §2②/§5). `pickModel` is a pure function that, given a task shape
 * + cost tier + the cached capability snapshot (piece ①) + the CPA-available catalog + the model-market↔CPA map (Q1), SUGGESTS
 * which model to staff the task with, carrying the board evidence and the price delta. It NEVER calls a model, NEVER spawns,
 * NEVER spends — it is advice only (brief §0/§4, the runPlacementSuggest precedent). The projection builder (buildStaffing
 * projection) turns a list of task inputs into the frozen `console-model-staffing/v1` shape; the IO (read snapshot/map, atomic
 * write) lives in `model-staffing-store.ts`.
 *
 * Invariants baked in here (brief §3):
 *  - FAIL-CLOSED (resolveRoleModel precedent): no catalog model clears the tier's capability floor ⇒ a NO-STAFFABLE result,
 *    never a weak default. A deprecated model is never a candidate.
 *  - Q1 id-space mapping: a model-market id maps to a CPA id ONLY through the map table (keyed on the base id, marketBaseId);
 *    a model with NO map entry is SKIPPED and COUNTED (unmappableCount) — the count is carried on every suggestion so it is
 *    VISIBLE (never silently dropped).
 *  - Q5 cost tier is PRIMARY (the model-tiering floor): heavy ⇒ top capability (宁贵勿返); standard ⇒ the 0.95-band, cheapest;
 *    light ⇒ the 0.85-band, Pareto-frontier-preferred then cheapest (够用且性价比). An OPTIONAL budgetUsdCeiling refines within
 *    the band (and flags overBudget rather than returning a weaker default).
 *  - Q6 review heterogeneity is HARD: the suggested reviewer model id MUST differ from the author's; a CROSS-provider same-tier
 *    option MUST be preferred, and a same-provider-different-id pick is allowed ONLY when no cross-provider option exists (the
 *    reason is recorded in `why`).
 *  - CPA availability degrade: when the ideal (highest-capability) pick is not in the catalog, degrade to the nearest available
 *    model and record `degradedFrom` (resolveToCatalogId nearest-available precedent).
 *
 * Pure: no fs, no clock beyond the injected `nowSec`. Reuses `stripDateSuffix` from model-tier.ts for catalog/author id
 * tolerance (a catalog that serves only a dated snapshot still matches the mapped base id).
 */
import { stripDateSuffix } from "./model-tier.js";
import { flagDefaultOn } from "./flag-default.js";
import { marketBaseId, staleSec, type BoardDimension, type CheapestOffer, type MarketModel, type ModelMarketSnapshot } from "./model-market.js";
import type { TaskKind } from "./task-plan.js";

/** SWARM_MODEL_STAFFING gates the staffing suggestion producer — LIVE BY DEFAULT (opt-out via [[flagDefaultOn]], freeze Q2:
 *  pure read-only projection + S19, zero risk). Kill-switch: `SWARM_MODEL_STAFFING=0`. Pure. */
export function modelStaffingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_MODEL_STAFFING);
}

// ---------------------------------------------------------------------------------------------------------------------
// taskShape + costTier derivation from the EXISTING plan node (Q3: kind + difficulty, ZERO plan-schema change)
// ---------------------------------------------------------------------------------------------------------------------

/** The capability SHAPE of a task (brief §2②). Maps onto a board dimension; `review` adds the Q6 heterogeneity constraint. */
export type TaskShape = "coding" | "agentic" | "science" | "long_context" | "review" | "general";

/** The cost tier = the model-tiering floor (Q5 PRIMARY). Identical to task-plan's `ModelTier`. */
export type CostTier = "light" | "standard" | "heavy";

/** Map an EXISTING plan node kind to a task shape (Q3 — no new node field). work/repair ⇒ coding; review ⇒ review; integration
 *  ⇒ agentic (tool-use wiring); synthesis ⇒ long_context (holds much material); design ⇒ science (deepest reasoning). Pure. */
export function taskShapeOfKind(kind: TaskKind): TaskShape {
  switch (kind) {
    case "work": case "repair": return "coding";
    case "review": return "review";
    case "integration": return "agentic";
    case "synthesis": return "long_context";
    case "design": return "science";
    default: return "general";
  }
}

/** Difficulty signals carried on the EXISTING node (Q3). Both ONLY raise the tier (model-tiering: 难度只上调). */
export type Difficulty = { criticalPath?: boolean; resolvedRisk?: boolean };

const RAISE: Record<CostTier, CostTier> = { light: "standard", standard: "heavy", heavy: "heavy" };

/** Derive the cost tier from an EXISTING node's kind + difficulty (Q3). Base floor per kind (design ⇒ heavy, work ⇒ light, the
 *  rest ⇒ standard); then difficulty UP-ONLY: a resolved/flagged risk bumps one level, a critical-path node goes straight to
 *  heavy (宁贵勿返). Pure. (The planner's own `modelTier`, when present, is PRIMARY — the wiring passes it directly and this is
 *  only the fallback.) */
export function costTierOfNode(kind: TaskKind, diff: Difficulty = {}): CostTier {
  let tier: CostTier = kind === "design" ? "heavy" : kind === "work" ? "light" : "standard";
  if (diff.resolvedRisk) tier = RAISE[tier];
  if (diff.criticalPath) tier = "heavy";
  return tier;
}

/** A minimal structural view of a plan node — enough to derive a staffing task without coupling to the full TaskSpec. */
export type NodeLike = { nodeId: string; kind: TaskKind; modelTier?: CostTier; criticalPath?: boolean; resolvedRisk?: unknown };

/** Derive a staffing task (taskId + shape + tier) from an EXISTING node (Q3). The planner's `modelTier` is PRIMARY (Q5: the
 *  model-tiering floor); absent ⇒ derive from kind + difficulty. `resolvedRisk` is treated as a boolean presence signal. Pure. */
export function taskFromNode(n: NodeLike): { taskId: string; shape: TaskShape; tier: CostTier } {
  const tier = n.modelTier ?? costTierOfNode(n.kind, { criticalPath: !!n.criticalPath, resolvedRisk: n.resolvedRisk != null });
  return { taskId: n.nodeId, shape: taskShapeOfKind(n.kind), tier };
}

// ---------------------------------------------------------------------------------------------------------------------
// pickModel — the staffing suggestion
// ---------------------------------------------------------------------------------------------------------------------

/** The board a shape scores on: the four category dimensions, or `composite` (the 0..100 overall score) for review / general. */
export type Board = BoardDimension | "composite";

/** Why a suggestion fell short of the ideal pick (CPA availability or tier floor). `marketId` is the ideal upstream model. */
export type DegradedFrom = { marketId: string; score: number; reason: string };

/** The board evidence a reviewer / the coordinator eyeballs: which board, the chosen model's score on it, its price, and the
 *  price delta vs the cheapest acceptable model in-band (0 ⇒ already the cheapest acceptable). `overBudget` flags that a given
 *  budget ceiling could not be met without dropping below the tier floor (Q5 — flagged, never silently weakened). */
export type StaffingEvidence = {
  board: Board;
  score: number;
  blendedUsdPer1M: number;
  priceDeltaVsFloor: number;
  /** The pick's 1-based rank by board score among the whole (mapped+scored) universe — brief:41 榜据. */
  rank?: number;
  /** The upstream single cheapest cross-provider offer for the picked model (brief:41), when the snapshot carried one. */
  cheapestOffer?: CheapestOffer;
};

/** A staffing suggestion, OR a fail-closed no-staffable result. `unmappableCount` (Q1) rides on BOTH so it is always visible. */
export type StaffingSuggestion =
  | {
      ok: true;
      suggestedModel: string; // the CPA catalog id to staff (always in the catalog)
      tier: CostTier;
      shape: TaskShape;
      why: string;
      evidence: StaffingEvidence;
      degradedFrom?: DegradedFrom;
      unmappableCount: number;
    }
  | { ok: false; reason: string; unmappableCount: number };

/** The pickModel input (brief §2②). `catalog` = CPA-available ids (the §③ hard constraint); `mapTable` = market-base-id → CPA
 *  id (Q1); `authorModel` = the author's CPA id (review heterogeneity, Q6); `budgetUsdCeiling` = the optional $ refinement (Q5). */
export type PickInput = {
  taskShape: TaskShape;
  costTier: CostTier;
  catalog: readonly string[];
  snapshot: ModelMarketSnapshot;
  mapTable: Readonly<Record<string, string>>;
  budgetUsdCeiling?: number;
  authorModel?: string;
};

/** Tunable capability floors as a FRACTION of the ideal (whole-universe) top score on the board. heavy = only the top (宁贵勿返
 *  榜顶); standard = within 5%; light = within 15% (够用). Named constants so the bands are explicit + testable. */
const HEAVY_FLOOR_FRACTION = 1.0;
const STANDARD_FLOOR_FRACTION = 0.95;
const LIGHT_FLOOR_FRACTION = 0.85;

/** A resolved candidate. `catalogId` = the ACTUAL callable CPA id this endpoint serves (MS-P2-3), or null when NOT in the catalog
 *  (a universe-only ideal). `mappedId` = the map's CPA value (the Q1 alias, used as the stable tiebreak key). */
type Candidate = { catalogId: string | null; mappedId: string; marketId: string; provider: string; board: number; price: number; pareto: boolean; cheapestOffer?: CheapestOffer };

/** The board dimension a task shape scores on (review / general ⇒ the composite). Pure. */
export function boardOf(shape: TaskShape): Board {
  switch (shape) {
    case "coding": return "coding";
    case "agentic": return "agentic";
    case "science": return "science";
    case "long_context": return "long_context";
    case "review": case "general": return "composite";
  }
}

/** The model's score on a board; undefined when absent OR non-finite (MS-P2-5: a string / NaN score from a corrupt disk snapshot
 *  is treated as "no value", never trusted). Pure. */
function boardScoreOf(m: MarketModel, board: Board): number | undefined {
  const v = board === "composite" ? m.composite : m.categoryScores[board];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Resolve a mapped CPA id to the ACTUAL catalog entry that serves it (exact first, else a date-suffixed variant), with date-suffix
 *  tolerance (reuses model-tier.stripDateSuffix): a catalog serving only `claude-opus-5-5-20261001` resolves the mapped base id
 *  `claude-opus-5-5` to that REAL, callable id. Returns null when the catalog does not serve it. MS-P2-3: the suggestion returns
 *  the resolved actual id, never the mapped alias that may not itself be invocable. Pure. */
function catalogResolve(catalog: readonly string[], cpaId: string): string | null {
  if (catalog.includes(cpaId)) return cpaId;
  const dated = catalog.find((c) => stripDateSuffix(c) === cpaId);
  return dated ?? null;
}

/** Count the non-deprecated snapshot models with NO map entry (Q1). Dimension-INDEPENDENT (it is about map coverage, not a
 *  particular task's board) so the count is stable across task shapes. Pure. */
export function countUnmappable(snapshot: ModelMarketSnapshot, map: Readonly<Record<string, string>>): number {
  let n = 0;
  for (const m of snapshot.models) {
    if (m.deprecated) continue;
    const cpa = map[marketBaseId(m.id)];
    if (cpa === undefined || cpa === "") n += 1;
  }
  return n;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const cmpId = (a: Candidate, b: Candidate): number => (a.mappedId < b.mappedId ? -1 : a.mappedId > b.mappedId ? 1 : 0);

/** Select ONE candidate by the cost-tier rule. heavy ⇒ highest board, cheaper breaks ties. light ⇒ prefer the Pareto frontier,
 *  then cheapest, best-board breaks ties. standard ⇒ cheapest in the band (the band already clears the 0.95 floor), best-board
 *  breaks ties. A stable cpaId tiebreak makes the pick deterministic (FC-6). Pure; `pool` is non-empty by the call sites. */
function selectByTier(pool: Candidate[], tier: CostTier): Candidate {
  const arr = pool.slice();
  if (tier === "heavy") {
    arr.sort((a, b) => b.board - a.board || a.price - b.price || cmpId(a, b));
    return arr[0];
  }
  if (tier === "light") {
    const pareto = arr.filter((c) => c.pareto);
    const chosen = pareto.length > 0 ? pareto : arr; // prefer the cost-performance frontier when any candidate is on it
    chosen.sort((a, b) => a.price - b.price || b.board - a.board || cmpId(a, b));
    return chosen[0];
  }
  // standard: cheapest within the (already floor-clearing) band
  arr.sort((a, b) => a.price - b.price || b.board - a.board || cmpId(a, b));
  return arr[0];
}

/** The provider of the author's model, reverse-resolved through the snapshot + map (date-tolerant). undefined when the author
 *  model is not in the snapshot — then Q6 heterogeneity enforces only the id difference (cross-provider cannot be judged). */
function providerOfAuthor(snapshot: ModelMarketSnapshot, map: Readonly<Record<string, string>>, authorCpa: string): string | undefined {
  const target = stripDateSuffix(authorCpa);
  for (const m of snapshot.models) {
    const cpa = map[marketBaseId(m.id)];
    if (cpa && stripDateSuffix(cpa) === target && m.provider) return m.provider;
  }
  return undefined;
}

/**
 * Suggest the model to staff a task with (brief §2②). Pure. The algorithm:
 *  1. Walk the snapshot once: a deprecated model is skipped; a model with NO map entry is skipped + COUNTED (Q1); the rest form
 *     the ideal `universe` (incl. catalog-unavailable models — the true capability ceiling) and, when in the catalog, the
 *     `available` set. For review, the author's own id is excluded from `available` (Q6 HARD) up-front.
 *  2. Fail-closed: no `available` candidate ⇒ a no-staffable result (never a weak default).
 *  3. The capability floor is a FRACTION of the ideal top score (so the band is measured against true top capability). The
 *     AVAILABLE band = available models clearing that floor; empty ⇒ DEGRADE to the best available (recorded).
 *  4. Q6 review: within the band, PREFER cross-provider models; keep same-provider (different-id) only when none exist (recorded).
 *  5. Q5 budget: prefer the sub-band within the ceiling; none fit ⇒ keep the band + flag overBudget (never weaken below floor).
 *  6. Pick by the tier rule; compute degradedFrom vs the ideal pick over the whole universe; assemble the evidence + why.
 */
export function pickModel(input: PickInput): StaffingSuggestion {
  const board = boardOf(input.taskShape);
  const isReview = input.taskShape === "review";
  const unmappableCount = countUnmappable(input.snapshot, input.mapTable);

  // MS-P2-4: a review task REQUIRES the author model to prove the HARD Q6 heterogeneity. Without it we cannot guarantee a different
  // model ⇒ fail-closed no-staffable (NEVER claim heterogeneity satisfied while deferring it; wiring author identity is the enabler).
  if (isReview && !input.authorModel) {
    return { ok: false, reason: "review heterogeneity is HARD (Q6) but no author model was provided — cannot guarantee a different model (wire author identity to staff reviews)", unmappableCount };
  }
  const author = input.authorModel ? stripDateSuffix(input.authorModel) : undefined;
  const authorProvider = input.authorModel ? providerOfAuthor(input.snapshot, input.mapTable, input.authorModel) : undefined;

  const universe: Candidate[] = []; // ideal: all mapped + scored + PRICED non-deprecated models (may be catalog-unavailable)
  const available: Candidate[] = []; // the above restricted to the catalog (actual callable id resolved; review: author id excluded)
  for (const m of input.snapshot.models) {
    if (m.deprecated) continue; // never suggest a deprecated model
    const mappedId = input.mapTable[marketBaseId(m.id)];
    if (mappedId === undefined || mappedId === "") continue; // Q1 unmappable — counted by countUnmappable (visible)
    const score = boardScoreOf(m, board);
    if (score === undefined) continue; // MS-P2-5: no finite score on THIS board ⇒ not a candidate
    const price = typeof m.blendedUsdPer1M === "number" && Number.isFinite(m.blendedUsdPer1M) ? m.blendedUsdPer1M : undefined;
    if (price === undefined) continue; // MS-P2-5: no finite price ⇒ cannot rank/budget honestly ⇒ not a candidate (never fabricate 0)
    const catalogId = catalogResolve(input.catalog, mappedId); // MS-P2-3: the REAL callable id, or null (not served here)
    const cand: Candidate = { catalogId, mappedId, marketId: m.id, provider: m.provider, board: score, price, pareto: m.pareto === true, ...(m.cheapestOffer ? { cheapestOffer: m.cheapestOffer } : {}) };
    universe.push(cand);
    if (catalogId === null) continue; // mapped but this CPA endpoint does not serve it ⇒ not available (NOT unmappable)
    if (isReview && author && stripDateSuffix(mappedId) === author) continue; // Q6 HARD: the reviewer model must differ from the author
    available.push(cand);
  }

  if (available.length === 0) {
    return { ok: false, reason: isReview
      ? "no catalog model (other than the author's) has a finite board score + price for this review — fail-closed"
      : "no same-shape catalog model has a finite board score + price — fail-closed", unmappableCount };
  }

  const topScore = Math.max(...universe.map((c) => c.board)); // the IDEAL ceiling (incl. catalog-unavailable models)
  const frac = input.costTier === "heavy" ? HEAVY_FLOOR_FRACTION : input.costTier === "standard" ? STANDARD_FLOOR_FRACTION : LIGHT_FLOOR_FRACTION;
  const floorScore = topScore * frac;

  // MS-P2-2: the AVAILABLE band must CLEAR the capability floor. Empty ⇒ NO-STAFFABLE (无同档, brief:42) — NEVER widen to all available.
  let band = available.filter((c) => c.board >= floorScore);
  if (band.length === 0) {
    return { ok: false, reason: `no catalog model clears the ${input.costTier}-tier capability floor (~${round2(floorScore)} on ${board}) — fail-closed (no weak default)`, unmappableCount };
  }

  // Q6 review heterogeneity: PREFER cross-provider within the band — MS-P3-1: a cross-provider option must have a KNOWN provider that
  // differs (an unknown "" provider is NOT evidence of cross-provider). Same-provider (author-id-excluded) kept only when none cross.
  let sameProviderFallback = false;
  if (isReview && authorProvider) {
    const cross = band.filter((c) => c.provider !== "" && c.provider !== authorProvider);
    if (cross.length > 0) band = cross;
    else sameProviderFallback = true;
  }

  // MS-P2-2: a given $ ceiling is HARD when present — no in-band model within it ⇒ NO-STAFFABLE (never return an over-budget "ok").
  if (typeof input.budgetUsdCeiling === "number" && Number.isFinite(input.budgetUsdCeiling)) {
    const underBudget = band.filter((c) => c.price <= input.budgetUsdCeiling!);
    if (underBudget.length === 0) {
      return { ok: false, reason: `no ${input.costTier}-tier model is within the $${input.budgetUsdCeiling}/1M ceiling — fail-closed (raise the budget or lower the tier)`, unmappableCount };
    }
    band = underBudget;
  }

  const pick = selectByTier(band, input.costTier);

  // degradedFrom (MS-P3-1 honest): recorded ONLY when the ideal in-band pick is a DIFFERENT MODEL this endpoint does NOT serve —
  // i.e. a genuine CPA-availability degrade. Never for a heterogeneity/budget choice (those are not "unavailable").
  const idealBand = universe.filter((c) => c.board >= floorScore);
  const ideal = selectByTier(idealBand, input.costTier);
  let degradedFrom: DegradedFrom | undefined;
  if (ideal.marketId !== pick.marketId && ideal.catalogId === null) {
    degradedFrom = { marketId: ideal.marketId, score: round2(ideal.board), reason: "preferred model not served by this CPA endpoint; nearest available in-band" };
  }

  const cheapestInBand = Math.min(...band.map((c) => c.price));
  const rank = universe.filter((c) => c.board > pick.board).length + 1; // 1-based board rank over the universe (brief:41)
  const evidence: StaffingEvidence = {
    board,
    score: round2(pick.board),
    blendedUsdPer1M: round2(pick.price),
    priceDeltaVsFloor: round2(pick.price - cheapestInBand),
    rank,
    ...(pick.cheapestOffer ? { cheapestOffer: pick.cheapestOffer } : {}),
  };

  const why = buildWhy({ input, pick, board, sameProviderFallback, authorProvider, degradedFrom });
  // pick is from `available` (catalogId resolved non-null); the actual callable id is always present here.
  const out: StaffingSuggestion = { ok: true, suggestedModel: pick.catalogId!, tier: input.costTier, shape: input.taskShape, why, evidence, unmappableCount };
  if (degradedFrom) out.degradedFrom = degradedFrom;
  return out;
}

/** Compose the human-readable `why` (協調者/user 一眼可核). Concise, one line. MS-P3-1: distinguishes catalog-availability degrade,
 *  heterogeneity exclusion, and an UNVERIFIED cross-provider (unknown author provider) — never an unknown fact asserted as true. */
function buildWhy(a: {
  input: PickInput;
  pick: Candidate;
  board: Board;
  sameProviderFallback: boolean;
  authorProvider: string | undefined;
  degradedFrom: DegradedFrom | undefined;
}): string {
  const parts: string[] = [`${a.input.taskShape} via ${a.board} board`, `${a.input.costTier} tier`, `${a.pick.provider || "provider?"} ${a.pick.marketId}`, `catalog:${a.pick.catalogId}`, `$${round2(a.pick.price)}/1M`];
  if (a.input.taskShape === "review") {
    // MS-P3-1: never assert an unknown fact. cross-provider is claimed ONLY with a known author provider AND a known-different pick;
    // an unknown ("") author OR pick provider is reported as id-differs-but-cross-provider-UNVERIFIED, not as same/cross-provider.
    if (a.authorProvider === undefined) parts.push("heterogeneous: id differs; cross-provider UNVERIFIED (author provider unknown)");
    else if (!a.sameProviderFallback) parts.push(`heterogeneous: cross-provider vs author (${a.authorProvider})`);
    else if (a.pick.provider === "") parts.push("heterogeneous: id differs; cross-provider UNVERIFIED (pick provider unknown)");
    else parts.push(`heterogeneous: id differs; same-provider (${a.pick.provider}), no cross-provider option`);
  }
  if (a.degradedFrom) parts.push(`degraded: ${a.degradedFrom.reason} (ideal ${a.degradedFrom.marketId})`);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------------------------------------------------
// Projection builder (piece ③a) — pure shape; the IO write lives in model-staffing-store.ts
// ---------------------------------------------------------------------------------------------------------------------

export const STAFFING_SCHEMA = "console-model-staffing/v1" as const;

/** One task to staff: its id, derived shape + tier, and the optional per-task budget / author (review) refinements. */
export type StaffingTaskInput = { taskId: string; shape: TaskShape; tier: CostTier; budgetUsdCeiling?: number; authorModel?: string };

/** One projected task: its inputs + the suggestion (ok or no-staffable). */
export type StaffingProjectionTask = { taskId: string; shape: TaskShape; tier: CostTier; suggestion: StaffingSuggestion };

/** The frozen projection the console reads. `unmappableCount` is top-level + VISIBLE (Q1). `snapshot*` are null when no cache
 *  exists (brief §3: no snapshot ⇒ staffing "unknown", per-task no-staffable). */
export type StaffingProjection = {
  schema: typeof STAFFING_SCHEMA;
  generatedAtSec: number;
  snapshotFetchedAtSec: number | null;
  snapshotStaleSec: number | null;
  unmappableCount: number;
  tasks: StaffingProjectionTask[];
};

/** Build the staffing projection for a set of tasks. A null snapshot ⇒ each task is a no-staffable "unknown" (never a fabricated
 *  suggestion) and the snapshot fields are null. Deterministic in its inputs (FC-6: task order preserved). Pure. */
export function buildStaffingProjection(args: {
  tasks: readonly StaffingTaskInput[];
  snapshot: ModelMarketSnapshot | null;
  mapTable: Readonly<Record<string, string>>;
  catalog: readonly string[];
  nowSec: number;
}): StaffingProjection {
  const { tasks, snapshot, mapTable, catalog, nowSec } = args;
  const unmappableCount = snapshot ? countUnmappable(snapshot, mapTable) : 0;
  const projected: StaffingProjectionTask[] = tasks.map((t) => {
    const suggestion: StaffingSuggestion = snapshot
      ? pickModel({
          taskShape: t.shape,
          costTier: t.tier,
          catalog,
          snapshot,
          mapTable,
          ...(t.budgetUsdCeiling !== undefined ? { budgetUsdCeiling: t.budgetUsdCeiling } : {}),
          ...(t.authorModel ? { authorModel: t.authorModel } : {}),
        })
      : { ok: false, reason: "no capability snapshot cached (unknown — not a suggestion)", unmappableCount: 0 };
    return { taskId: t.taskId, shape: t.shape, tier: t.tier, suggestion };
  });
  const st = snapshot ? staleSec(snapshot, nowSec) : null;
  return {
    schema: STAFFING_SCHEMA,
    generatedAtSec: nowSec,
    snapshotFetchedAtSec: snapshot ? snapshot.fetchedAtSec : null,
    snapshotStaleSec: st !== null && Number.isFinite(st) ? st : null, // never serialize a non-finite age
    unmappableCount,
    tasks: projected,
  };
}
