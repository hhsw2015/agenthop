/**
 * roleProfile v2 (DA1 — docker-agent schema v16 borrow, Apache-2.0 ideas, zero code dependency; docs/swarm/roleprofile-v2-design.md).
 * Two concepts that cut roleProfile authoring cost, built PURE here (no IO, no clock):
 *   ① a named FRAGMENT LIBRARY (`_fragments.json`: instructionBlocks / skillGroups / boundaryGroups defined once) + a v2 role's
 *      `use_*` references — so the 8 discipline blocks (S11/F30/S14/S15/F33/S18/S23/S24) that are byte-identical across every
 *      role live ONCE instead of being copied into each ~3 KB promptTemplate.
 *   ② named FLAVOR overrides — a JSON Merge Patch (RFC 7386) with two array sigils (`key+` append, `key-` remove-by-value), so a
 *      role variant (e.g. reviewer strict / lenient) is a small patch, not a whole-file copy.
 *
 * `resolveRoleProfile` turns (library, role, flavor?) into a ResolvedRoleProfile = the EXACT v1 shape the spawn/launcher already
 * consumes, so downstream is untouched. A v1 role (no `schemaNote: "roleProfile/v2"`) PASSES THROUGH unchanged. The t3
 * RoleCatalog {floor, fileDomain} projection is identical for a v2 role, so task-translate and every digest are unaffected.
 *
 * Trust-boundary discipline (mirrors task-plan loadPlan / grill-gate / decision-batch): untrusted JSON is validated WHOLE or
 * rejected with a reason — a dangling `use_*` ref, a malformed patch, a forbidden (`__proto__`/`constructor`/`prototype`) patch
 * field, a sigil on a non-array, or a field a patch touches twice all REJECT; nothing is silently dropped or coerced (we do NOT
 * auto-promote a scalar to a one-element array on `+`, unlike docker-agent — our fields are typed, so that is a bug). All reads
 * are own-property only; patches never run an input-supplied method.
 *
 * DORMANT: `roleProfileV2Enabled` (SWARM_ROLEPROFILE_V2, default OFF, dormant-ahead-of-use like SWARM_BOARD_ADMIT) gates the
 * future spawn/launcher wiring that would read a resolved profile; this module ships pure + selftested but UNWIRED (the live
 * spawn path still reads v1 today).
 */

// ---- the resolved (v1) shape -------------------------------------------------------------------------------------------
export type ModelTierSpec = { floor: "light" | "standard" | "heavy"; upgradeOn?: string[]; note?: string };
export type ResolvedRoleProfile = {
  roleId: string;
  title: string;
  summary: string;
  skills: string[];
  modelTier: ModelTierSpec;
  expectedParallelism: number;
  fileDomain: string[];
  promptTemplate: string;
  claimDiscipline: string;
  boundaries: string[];
};

export type FragmentLibrary = {
  instructionBlocks: Record<string, string>;
  skillGroups: Record<string, string[]>;
  boundaryGroups: Record<string, string[]>;
};

/** A v2 role: the v1 metadata, but `promptTemplate` is assembled from `promptHead` + `useInstructions`, and skills/boundaries
 *  are group refs ∪ inline extras. `flavors` are named patches resolved by name. */
export type RoleProfileV2 = {
  schemaNote: "roleProfile/v2";
  roleId: string;
  title: string;
  summary: string;
  modelTier: ModelTierSpec;
  expectedParallelism: number;
  fileDomain: string[];
  claimDiscipline: string;
  promptHead: string;
  useInstructions?: string[];
  useSkills?: string[];
  skills?: string[];
  useBoundaries?: string[];
  boundaries?: string[];
  flavors?: Record<string, Record<string, unknown>>;
};

export type LoadedRole = { kind: "v1"; profile: ResolvedRoleProfile } | { kind: "v2"; role: RoleProfileV2 };
type Res<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => isNonEmptyStr(x));
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function validModelTier(v: unknown): ModelTierSpec | null {
  if (!isObj(v)) return null;
  if (v.floor !== "light" && v.floor !== "standard" && v.floor !== "heavy") return null;
  if (v.upgradeOn !== undefined && !isStrArray(v.upgradeOn)) return null;
  if (v.note !== undefined && !isStr(v.note)) return null;
  return { floor: v.floor, ...(isStrArray(v.upgradeOn) ? { upgradeOn: v.upgradeOn } : {}), ...(isStr(v.note) ? { note: v.note } : {}) };
}

// ---- fragment library --------------------------------------------------------------------------------------------------
export function loadFragmentLibrary(input: unknown): Res<FragmentLibrary> {
  if (!isObj(input)) return { ok: false, reason: "fragment library must be an object" };
  const strMap = (v: unknown, what: string): Res<Record<string, string>> => {
    if (v === undefined) return { ok: true, value: {} };
    if (!isObj(v)) return { ok: false, reason: `${what} must be an object` };
    const out: Record<string, string> = {};
    for (const k of Object.getOwnPropertyNames(v)) {
      if (FORBIDDEN.has(k)) return { ok: false, reason: `${what} has a forbidden name "${k}"` };
      const val = (v as Record<string, unknown>)[k];
      if (!isNonEmptyStr(val)) return { ok: false, reason: `${what}."${k}" must be a non-empty string` };
      out[k] = val;
    }
    return { ok: true, value: out };
  };
  const strArrMap = (v: unknown, what: string): Res<Record<string, string[]>> => {
    if (v === undefined) return { ok: true, value: {} };
    if (!isObj(v)) return { ok: false, reason: `${what} must be an object` };
    const out: Record<string, string[]> = {};
    for (const k of Object.getOwnPropertyNames(v)) {
      if (FORBIDDEN.has(k)) return { ok: false, reason: `${what} has a forbidden name "${k}"` };
      const val = (v as Record<string, unknown>)[k];
      if (!isStrArray(val)) return { ok: false, reason: `${what}."${k}" must be an array of non-empty strings` };
      out[k] = [...val];
    }
    return { ok: true, value: out };
  };
  const ib = strMap(input.instructionBlocks, "instructionBlocks");
  if (!ib.ok) return ib;
  const sg = strArrMap(input.skillGroups, "skillGroups");
  if (!sg.ok) return sg;
  const bg = strArrMap(input.boundaryGroups, "boundaryGroups");
  if (!bg.ok) return bg;
  return { ok: true, value: { instructionBlocks: ib.value, skillGroups: sg.value, boundaryGroups: bg.value } };
}

// ---- role (v1 passthrough OR v2) ---------------------------------------------------------------------------------------
function validV1(input: Record<string, unknown>): Res<ResolvedRoleProfile> {
  const mt = validModelTier(input.modelTier);
  if (!isNonEmptyStr(input.roleId) || !isNonEmptyStr(input.title) || !isNonEmptyStr(input.summary)) return { ok: false, reason: "v1 role: roleId/title/summary must be non-empty strings" };
  if (!isStrArray(input.skills)) return { ok: false, reason: "v1 role: skills must be an array of non-empty strings" };
  if (!mt) return { ok: false, reason: "v1 role: modelTier invalid" };
  if (typeof input.expectedParallelism !== "number" || !Number.isFinite(input.expectedParallelism)) return { ok: false, reason: "v1 role: expectedParallelism must be a finite number" };
  if (!isStrArray(input.fileDomain)) return { ok: false, reason: "v1 role: fileDomain must be an array of non-empty strings" };
  if (!isStr(input.promptTemplate)) return { ok: false, reason: "v1 role: promptTemplate must be a string" };
  if (!isNonEmptyStr(input.claimDiscipline)) return { ok: false, reason: "v1 role: claimDiscipline must be a non-empty string" };
  if (!isStrArray(input.boundaries)) return { ok: false, reason: "v1 role: boundaries must be an array of non-empty strings" };
  return { ok: true, value: { roleId: input.roleId, title: input.title, summary: input.summary, skills: [...input.skills], modelTier: mt, expectedParallelism: input.expectedParallelism, fileDomain: [...input.fileDomain], promptTemplate: input.promptTemplate, claimDiscipline: input.claimDiscipline, boundaries: [...input.boundaries] } };
}

function validV2(input: Record<string, unknown>): Res<RoleProfileV2> {
  const mt = validModelTier(input.modelTier);
  if (!isNonEmptyStr(input.roleId) || !isNonEmptyStr(input.title) || !isNonEmptyStr(input.summary)) return { ok: false, reason: "v2 role: roleId/title/summary must be non-empty strings" };
  if (!mt) return { ok: false, reason: "v2 role: modelTier invalid" };
  if (typeof input.expectedParallelism !== "number" || !Number.isFinite(input.expectedParallelism)) return { ok: false, reason: "v2 role: expectedParallelism must be a finite number" };
  if (!isStrArray(input.fileDomain)) return { ok: false, reason: "v2 role: fileDomain must be an array of non-empty strings" };
  if (!isNonEmptyStr(input.claimDiscipline)) return { ok: false, reason: "v2 role: claimDiscipline must be a non-empty string" };
  if (!isStr(input.promptHead)) return { ok: false, reason: "v2 role: promptHead must be a string" };
  for (const [k, v] of [["useInstructions", input.useInstructions], ["useSkills", input.useSkills], ["skills", input.skills], ["useBoundaries", input.useBoundaries], ["boundaries", input.boundaries]] as const) {
    if (v !== undefined && !isStrArray(v)) return { ok: false, reason: `v2 role: ${k} must be an array of non-empty strings` };
  }
  let flavors: Record<string, Record<string, unknown>> | undefined;
  if (input.flavors !== undefined) {
    if (!isObj(input.flavors)) return { ok: false, reason: "v2 role: flavors must be an object" };
    flavors = {};
    for (const name of Object.getOwnPropertyNames(input.flavors)) {
      if (FORBIDDEN.has(name)) return { ok: false, reason: `v2 role: flavor has a forbidden name "${name}"` };
      const patch = (input.flavors as Record<string, unknown>)[name];
      if (!isObj(patch)) return { ok: false, reason: `v2 role: flavor "${name}" must be an object (a merge patch)` };
      flavors[name] = patch;
    }
  }
  const pick = (k: string): string[] | undefined => (isStrArray(input[k]) ? [...(input[k] as string[])] : undefined);
  return { ok: true, value: {
    schemaNote: "roleProfile/v2", roleId: input.roleId, title: input.title, summary: input.summary, modelTier: mt,
    expectedParallelism: input.expectedParallelism, fileDomain: [...input.fileDomain], claimDiscipline: input.claimDiscipline,
    promptHead: input.promptHead,
    ...(pick("useInstructions") ? { useInstructions: pick("useInstructions") } : {}),
    ...(pick("useSkills") ? { useSkills: pick("useSkills") } : {}),
    ...(pick("skills") ? { skills: pick("skills") } : {}),
    ...(pick("useBoundaries") ? { useBoundaries: pick("useBoundaries") } : {}),
    ...(pick("boundaries") ? { boundaries: pick("boundaries") } : {}),
    ...(flavors ? { flavors } : {}),
  } };
}

export function loadRoleProfile(input: unknown): Res<LoadedRole> {
  if (!isObj(input)) return { ok: false, reason: "role profile must be an object" };
  if (input.schemaNote === "roleProfile/v2") {
    const r = validV2(input);
    return r.ok ? { ok: true, value: { kind: "v2", role: r.value } } : r;
  }
  const r = validV1(input);
  return r.ok ? { ok: true, value: { kind: "v1", profile: r.value } } : r;
}

// ---- flavor merge patch (RFC 7386 + key+/key- array sigils; pure, proto-safe) ------------------------------------------
export function mergeRolePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Res<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(base)) if (!FORBIDDEN.has(k)) result[k] = base[k]; // fresh object, own keys only
  const touched = new Set<string>();
  for (const key of Object.getOwnPropertyNames(patch)) {
    const op = key.endsWith("+") ? "append" : key.endsWith("-") ? "remove" : "set";
    const field = op === "set" ? key : key.slice(0, -1);
    if (field.length === 0 || FORBIDDEN.has(field)) return { ok: false, reason: `patch key "${key}" targets a forbidden/empty field` };
    if (touched.has(field)) return { ok: false, reason: `patch touches field "${field}" more than once (ambiguous)` };
    touched.add(field);
    const val = patch[key];
    if (op === "append") {
      if (!Array.isArray(val)) return { ok: false, reason: `patch "${key}" value must be an array` };
      const cur = own(result, field) ? result[field] : undefined;
      if (cur !== undefined && !Array.isArray(cur)) return { ok: false, reason: `patch "${key}" on a non-array field "${field}"` };
      result[field] = [...((cur as unknown[]) ?? []), ...val];
    } else if (op === "remove") {
      if (!Array.isArray(val)) return { ok: false, reason: `patch "${key}" value must be an array` };
      const cur = own(result, field) ? result[field] : undefined;
      if (!Array.isArray(cur)) return { ok: false, reason: `patch "${key}" removes from a non-array field "${field}"` };
      result[field] = (cur as unknown[]).filter((x) => !val.includes(x));
    } else {
      if (val === null) { delete result[field]; continue; }
      const cur = own(result, field) ? result[field] : undefined;
      if (isObj(val) && isObj(cur)) {
        const r = mergeRolePatch(cur, val);
        if (!r.ok) return r;
        result[field] = r.value;
      } else {
        result[field] = val; // replace scalar/array/object (RFC 7386 for non-object target)
      }
    }
  }
  return { ok: true, value: result };
}

/** Apply a named flavor to a v2 role, returning a new v2 role. Rejects an unknown name or a patch that re-validates invalid. */
export function applyFlavor(role: RoleProfileV2, flavorName: string): Res<RoleProfileV2> {
  if (!role.flavors || !own(role.flavors, flavorName)) return { ok: false, reason: `unknown flavor "${flavorName}"` };
  const { flavors, ...bare } = role; // the patch applies to the role WITHOUT its flavors map
  const merged = mergeRolePatch(bare as Record<string, unknown>, role.flavors[flavorName]!);
  if (!merged.ok) return merged;
  const reval = validV2({ ...merged.value, schemaNote: "roleProfile/v2" });
  return reval.ok ? { ok: true, value: reval.value } : { ok: false, reason: `flavor "${flavorName}" produced an invalid role: ${reval.reason}` };
}

const dedupe = (xs: string[]): string[] => { const seen = new Set<string>(); const out: string[] = []; for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); } return out; };

/** Resolve a loaded role into the v1 ResolvedRoleProfile. A v1 role passes through (a flavor on a v1 role is rejected). A v2
 *  role: apply the flavor (if any), expand `use_*` against the library (dangling ref ⇒ whole-reject), assemble promptTemplate =
 *  promptHead + referenced blocks (list order), skills/boundaries = referenced groups ∪ inline extras (order-preserving, deduped). */
export function resolveRoleProfile(library: FragmentLibrary, loaded: LoadedRole, flavor?: string): Res<ResolvedRoleProfile> {
  if (loaded.kind === "v1") {
    if (flavor !== undefined) return { ok: false, reason: "a v1 role has no flavors" };
    return { ok: true, value: loaded.profile };
  }
  let role = loaded.role;
  if (flavor !== undefined) {
    const f = applyFlavor(role, flavor);
    if (!f.ok) return f;
    role = f.value;
  }
  const blocks: string[] = [];
  for (const name of role.useInstructions ?? []) {
    if (!own(library.instructionBlocks, name)) return { ok: false, reason: `role "${role.roleId}": instruction block "${name}" not in the fragment library` };
    blocks.push(library.instructionBlocks[name]!);
  }
  const skills: string[] = [];
  for (const g of role.useSkills ?? []) {
    if (!own(library.skillGroups, g)) return { ok: false, reason: `role "${role.roleId}": skill group "${g}" not in the fragment library` };
    skills.push(...library.skillGroups[g]!);
  }
  skills.push(...(role.skills ?? []));
  const boundaries: string[] = [];
  for (const g of role.useBoundaries ?? []) {
    if (!own(library.boundaryGroups, g)) return { ok: false, reason: `role "${role.roleId}": boundary group "${g}" not in the fragment library` };
    boundaries.push(...library.boundaryGroups[g]!);
  }
  boundaries.push(...(role.boundaries ?? []));
  const promptTemplate = blocks.length > 0 ? `${role.promptHead}\n\n${blocks.join("\n\n")}` : role.promptHead;
  return { ok: true, value: {
    roleId: role.roleId, title: role.title, summary: role.summary, skills: dedupe(skills), modelTier: role.modelTier,
    expectedParallelism: role.expectedParallelism, fileDomain: [...role.fileDomain], promptTemplate,
    claimDiscipline: role.claimDiscipline, boundaries: dedupe(boundaries),
  } };
}

/** Dormant wiring flip, default OFF (dormant-ahead-of-use, like SWARM_BOARD_ADMIT). The live spawn/launcher resolves v2 only when on. */
export function roleProfileV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_ROLEPROFILE_V2 ?? "");
}
