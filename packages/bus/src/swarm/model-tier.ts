/**
 * Model-tier binding (heavy-tier-binding; coordinator dispatch 2026-10-05 off the user's model-tier ruling). Resolves a
 * ROLE's heavy tier to a concrete CPA-catalog model, FAIL-CLOSED: no recommended (or same-or-stronger self-selected) model
 * in the catalog => refuse, never a weak default.
 *
 * Identity is EXACT (reviewer heavy-tier-c6b5968 root cause): an explicit alias table maps each model to its exact catalog
 * id spellings; matching is equality against an alias (a trailing -<date> suffix tolerated), NEVER a substring — so
 * claude-opus-5 (AA 51) can never pass as opus 5.5 (AA 58), served "claude-opus-5"/bare "claude" never passes as the chosen
 * model (the silent downgrade this batch kills), and "sonnet-5.5-mini" never inherits sonnet 5.5's score.
 *
 * Recommended = baseline, not a closed whitelist: a self-selected model must be a BENCHMARKED, same-or-stronger model
 * (aaIntel >= the role floor) and carry a {chosen, why, benchmark} record. The table (roles/model-tiers.json) is data; a
 * change is a user ruling, not a code edit.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Role = "planning" | "coding" | "review";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelEntry = { id: string; aliases: string[]; aaIntel: number };
export type RoleSpec = { semantics: string; floorAaIntel: number; reasoningEffort?: ReasoningEffort; recommended: string[] };
export type ModelTierTable = {
  version: string;
  source: string;
  benchmark: string;
  reasoningEfforts?: ReasoningEffort[];
  models: ModelEntry[];
  roles: Record<Role, RoleSpec>;
};

/** The worklog record for every model choice, plus the role reasoning_effort and (filled at call time) the SERVED model. */
export type ModelSelection = { chosen: string; model: string; why: string; benchmark: string; reasoningEffort?: ReasoningEffort; served?: string };

export function defaultTablePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "roles", "model-tiers.json");
}
export function loadModelTierTable(file = defaultTablePath()): ModelTierTable {
  return JSON.parse(readFileSync(file, "utf8")) as ModelTierTable;
}

/** Lowercase, alphanumeric-only. Kept as a display/debug utility — NOT used for identity (identity is exact alias match). */
export const normalizeModelName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Strip a trailing date/version-stamp suffix (e.g. "...-20261001") so a dated served id maps to its base alias. Only a
 *  6-8 digit trailing group is stripped — a short id like "claude-opus-5-5" (trailing "-5") is left intact. */
export function stripDateSuffix(id: string): string {
  return id.replace(/[-_.]\d{6,8}$/, "");
}

type Index = { byId: Map<string, ModelEntry>; aliasToId: Map<string, string> };
function indexOf(table: ModelTierTable): Index {
  const byId = new Map<string, ModelEntry>();
  const aliasToId = new Map<string, string>();
  for (const m of table.models) {
    byId.set(m.id, m);
    for (const a of m.aliases) aliasToId.set(a, m.id);
  }
  return { byId, aliasToId };
}

/** The ModelEntry a reference denotes: a canonical id ("opus 5.5"), an exact catalog alias ("claude-opus-5-5"), or a dated
 *  alias ("claude-opus-5-5-20261001"). undefined if the reference is not a known (benchmarked) model. EXACT only. */
export function modelEntryOf(ref: string, table: ModelTierTable, idx: Index = indexOf(table)): ModelEntry | undefined {
  if (idx.byId.has(ref)) return idx.byId.get(ref);
  const canon = idx.aliasToId.get(ref) ?? idx.aliasToId.get(stripDateSuffix(ref));
  return canon ? idx.byId.get(canon) : undefined;
}

/** AA Intel for a model (by canonical id or exact catalog alias); undefined if not a benchmarked model. */
export function aaIntelOf(ref: string, table: ModelTierTable): number | undefined {
  return modelEntryOf(ref, table)?.aaIntel;
}

/** The catalog id to use for a model reference: its first alias that is EXACTLY in the catalog. null if the reference is not
 *  a known model, or none of its aliases are in the catalog. */
export function resolveToCatalogId(ref: string, catalog: string[], table: ModelTierTable = loadModelTierTable()): string | null {
  const entry = modelEntryOf(ref, table);
  return entry ? availableCatalogId(entry, catalog) : null;
}

/** The ACTUAL catalog id to call for a model: a bare alias exactly present (preferred, rolling id), else a catalog id whose
 *  date-suffix-stripped form is an alias (so a catalog that serves ONLY a dated snapshot is still usable — symmetric with
 *  servedMatchesChosen's date tolerance). null if the model is not in the catalog in any form. */
function availableCatalogId(entry: ModelEntry, catalog: string[]): string | null {
  const bare = entry.aliases.find((a) => catalog.includes(a));
  if (bare !== undefined) return bare;
  return catalog.find((cid) => entry.aliases.includes(stripDateSuffix(cid))) ?? null;
}

export type ResolveOpts = { catalog: string[]; chosen?: string; why?: string; table?: ModelTierTable };
export type ResolveResult = { ok: true; model: string; selection: ModelSelection } | { ok: false; reason: string };

export function resolveRoleModel(role: Role, opts: ResolveOpts): ResolveResult {
  const table = opts.table ?? loadModelTierTable();
  const spec = table.roles[role];
  if (!spec) return { ok: false, reason: `unknown role "${role}"` };
  const idx = indexOf(table);
  const eff = spec.reasoningEffort !== undefined ? { reasoningEffort: spec.reasoningEffort } : {};
  const availableAlias = (entry: ModelEntry): string | null => availableCatalogId(entry, opts.catalog);

  if (opts.chosen !== undefined && opts.chosen.length > 0) {
    const entry = modelEntryOf(opts.chosen, table, idx);
    if (!entry) return { ok: false, reason: `"${opts.chosen}" is not a benchmarked model (exact alias match) — add it to the model-tier table (a user ruling) before selecting it` };
    const id = availableAlias(entry);
    if (id === null) return { ok: false, reason: `chosen model "${opts.chosen}" (${entry.id}) has no alias in the CPA catalog — fail-closed` };
    if (entry.aaIntel < spec.floorAaIntel) return { ok: false, reason: `"${entry.id}" AA Intel ${entry.aaIntel} < ${role} floor ${spec.floorAaIntel} (weaker than recommended) — fail-closed` };
    const isRecommended = spec.recommended.includes(entry.id);
    if (!isRecommended && (opts.why === undefined || opts.why.length === 0)) return { ok: false, reason: `self-selected model "${entry.id}" requires a selection reason (why) for the worklog triple` };
    return { ok: true, model: id, selection: { chosen: opts.chosen, model: id, why: opts.why ?? "recommended baseline (explicit)", benchmark: `${isRecommended ? "recommended" : "self-select"} ${role}; AA Intel ${entry.aaIntel} >= floor ${spec.floorAaIntel} (${table.version})`, ...eff } };
  }

  // No chosen: the strongest recommended that is AT/ABOVE the current floor AND available (reasoning strength first).
  const qualified = spec.recommended
    .map((rid) => idx.byId.get(rid))
    .filter((e): e is ModelEntry => e !== undefined && e.aaIntel >= spec.floorAaIntel)
    .sort((a, b) => b.aaIntel - a.aaIntel);
  for (const e of qualified) {
    const id = availableAlias(e);
    if (id !== null) return { ok: true, model: id, selection: { chosen: e.id, model: id, why: "recommended baseline (strongest available in catalog)", benchmark: `AA Intel ${e.aaIntel} >= floor ${spec.floorAaIntel} (${table.version})`, ...eff } };
  }
  return { ok: false, reason: `fail-closed: no ${role} recommended model at/above floor ${spec.floorAaIntel} is in the CPA catalog (${spec.recommended.join(", ")})` };
}

export function resolvePlannerModel(opts: ResolveOpts): ResolveResult {
  return resolveRoleModel("planning", opts);
}

/** Runtime fail-closed: did the backend serve the SAME model we chose? True iff both resolve to the SAME benchmarked model
 *  by EXACT alias identity (a trailing -<date> suffix tolerated). A different model (a flagged silent downgrade like
 *  opus-5 for opus-5-5, or a bare "claude") resolves to a different/unknown canonical => false. */
export function servedMatchesChosen(chosen: string, served: string, table: ModelTierTable = loadModelTierTable()): boolean {
  const idx = indexOf(table);
  const cc = modelEntryOf(chosen, table, idx)?.id;
  const sc = modelEntryOf(served, table, idx)?.id;
  return cc !== undefined && cc === sc;
}
