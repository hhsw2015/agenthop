/**
 * Model-tier binding (heavy-tier-binding single scope; coordinator dispatch 2026-10-05 off the user's model-tier ruling).
 * Resolves a ROLE's heavy tier to a concrete CPA-catalog model, FAIL-CLOSED: if no recommended (or same-or-stronger
 * self-selected) model is actually in the catalog, it refuses rather than silently dropping to a weak default.
 *
 * The recommendation table is DATA (roles/model-tiers.json), not hardcoded — updating it is a user ruling. "Recommended"
 * is a baseline, not a closed whitelist: a caller may self-select any catalog model that is same-or-stronger by the AA Intel
 * benchmark (aaIntel >= the role's floor) and MUST leave a {chosen, why, benchmark} selection record (the worklog triple).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Role = "planning" | "coding" | "review";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type RecommendedModel = { name: string; match: string; aaIntel: number };
export type RoleSpec = { semantics: string; floorAaIntel: number; reasoningEffort?: ReasoningEffort; recommended: RecommendedModel[] };
export type ModelTierTable = {
  version: string;
  source: string;
  benchmark: string;
  reasoningEfforts?: ReasoningEffort[];
  roles: Record<Role, RoleSpec>;
  benchmarkScores: Array<{ name: string; aaIntel: number }>;
};

/** The worklog record for every model choice: {chosen, why, benchmark} + reasoning_effort, and (filled at call time) the
 *  `served` model the backend actually answered with (runtime fail-closed; coordinator 2026-10-05: a flagged model can
 *  silently downgrade, so claimed must equal served). */
export type ModelSelection = { chosen: string; model: string; why: string; benchmark: string; reasoningEffort?: ReasoningEffort; served?: string };

/** Runtime fail-closed check: does the model the backend actually SERVED match the one we chose? Tolerates a version
 *  suffix (served "claude-opus-5.5-20261001" for chosen "claude-opus-5.5") but rejects a different model (a flagged
 *  silent downgrade, e.g. opus-4.5 served for opus-5.5) — "claimed != served" (same principle as cpa:fingerprint). */
export function servedMatchesChosen(chosen: string, served: string): boolean {
  const c = normalizeModelName(chosen), s = normalizeModelName(served);
  if (c.length === 0 || s.length === 0) return false;
  return s.includes(c) || c.includes(s);
}
export type ResolveResult = { ok: true; model: string; selection: ModelSelection } | { ok: false; reason: string };

export function defaultTablePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "roles", "model-tiers.json");
}
export function loadModelTierTable(file = defaultTablePath()): ModelTierTable {
  return JSON.parse(readFileSync(file, "utf8")) as ModelTierTable;
}

/** Lowercase, alphanumeric-only — so "opus 5.5", "claude-opus-5-5", "claude opus 5.5" all compare equal-ish. */
export const normalizeModelName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Find the catalog id that best matches a display name / hint: an exact normalized match wins; otherwise the SHORTEST
 *  catalog id whose normalized form contains (or is contained by) the normalized name. null if nothing matches. */
export function resolveToCatalogId(nameOrHint: string, catalog: string[]): string | null {
  const want = normalizeModelName(nameOrHint);
  if (want.length === 0) return null;
  let best: { id: string; norm: string } | null = null;
  for (const id of catalog) {
    const norm = normalizeModelName(id);
    if (norm === want) return id; // exact normalized match wins outright
    if (norm.includes(want) || want.includes(norm)) {
      if (best === null || norm.length < best.norm.length) best = { id, norm };
    }
  }
  return best ? best.id : null;
}

/** AA Intel score for a model (by display name or catalog id), from the benchmark snapshot. undefined if not benchmarked. */
export function aaIntelOf(nameOrId: string, table: ModelTierTable): number | undefined {
  const want = normalizeModelName(nameOrId);
  let best: { score: number; norm: string } | undefined;
  for (const e of table.benchmarkScores) {
    const norm = normalizeModelName(e.name);
    if (norm === want) return e.aaIntel;
    if (norm.includes(want) || want.includes(norm)) {
      if (best === undefined || norm.length < best.norm.length) best = { score: e.aaIntel, norm };
    }
  }
  return best?.score;
}

export type ResolveOpts = { catalog: string[]; chosen?: string; why?: string; table?: ModelTierTable };

/** Resolve a role's model against the live CPA catalog, FAIL-CLOSED. No `chosen` => the strongest available recommended
 *  baseline (by AA Intel). A `chosen` must be in the catalog AND same-or-stronger than the role floor; a non-baseline
 *  self-select also requires a `why` (the worklog triple). Returns the resolved catalog id + the selection record. */
export function resolveRoleModel(role: Role, opts: ResolveOpts): ResolveResult {
  const table = opts.table ?? loadModelTierTable();
  const spec = table.roles[role];
  if (!spec) return { ok: false, reason: `unknown role "${role}"` };

  if (opts.chosen !== undefined && opts.chosen.length > 0) {
    const id = resolveToCatalogId(opts.chosen, opts.catalog);
    if (id === null) return { ok: false, reason: `chosen model "${opts.chosen}" is not in the CPA catalog — fail-closed` };
    const eff = spec.reasoningEffort !== undefined ? { reasoningEffort: spec.reasoningEffort } : {};
    const asBaseline = spec.recommended.find((r) => resolveToCatalogId(r.match, opts.catalog) === id);
    if (asBaseline) return { ok: true, model: id, selection: { chosen: opts.chosen, model: id, why: opts.why ?? "recommended baseline (explicit)", benchmark: `recommended ${role}; AA Intel ${asBaseline.aaIntel} >= floor ${spec.floorAaIntel} (${table.version})`, ...eff } };
    // self-select: must be verifiably same-or-stronger, and carry a reason.
    const score = aaIntelOf(opts.chosen, table) ?? aaIntelOf(id, table);
    if (score === undefined) return { ok: false, reason: `cannot verify "${opts.chosen}" is same-or-stronger: no AA Intel benchmark for it — add it via a user ruling before self-selecting` };
    if (score < spec.floorAaIntel) return { ok: false, reason: `"${opts.chosen}" AA Intel ${score} < ${role} floor ${spec.floorAaIntel} (weaker than recommended) — fail-closed` };
    if (opts.why === undefined || opts.why.length === 0) return { ok: false, reason: `self-selected model "${opts.chosen}" requires a selection reason (why) for the worklog triple` };
    return { ok: true, model: id, selection: { chosen: opts.chosen, model: id, why: opts.why, benchmark: `self-select ${role}; AA Intel ${score} >= floor ${spec.floorAaIntel} (${table.version})`, ...eff } };
  }

  // No chosen: the strongest available recommended baseline (reasoning strength first).
  const ranked = [...spec.recommended].sort((a, b) => b.aaIntel - a.aaIntel);
  for (const r of ranked) {
    const id = resolveToCatalogId(r.match, opts.catalog);
    if (id !== null) return { ok: true, model: id, selection: { chosen: r.name, model: id, why: "recommended baseline (strongest available in catalog)", benchmark: `AA Intel ${r.aaIntel} >= floor ${spec.floorAaIntel} (${table.version})`, ...(spec.reasoningEffort !== undefined ? { reasoningEffort: spec.reasoningEffort } : {}) } };
  }
  return { ok: false, reason: `fail-closed: none of the ${role} recommended models are in the CPA catalog (${spec.recommended.map((r) => r.name).join(", ")})` };
}

/** Convenience for the PLANNER heavy binding (draftPlan/expand). */
export function resolvePlannerModel(opts: ResolveOpts): ResolveResult {
  return resolveRoleModel("planning", opts);
}
