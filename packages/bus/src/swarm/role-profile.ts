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
 * Trust-boundary discipline (mirrors task-plan loadPlan / grill-gate / submit-tag): untrusted JSON (and a hand-crafted object)
 * is validated WHOLE or rejected. Every field is read as an OWN DATA property (`Object.getOwnPropertyDescriptor(...).value`) —
 * never the prototype chain, never an accessor — and each value is CAPTURED ONCE and used for both validation and output (no
 * getter TOCTOU, RP-P2-2). Arrays are validated + copied + removed-from BY INDEX, never via an input-supplied method or iterator
 * (no `.every`/`.includes`/`.filter`/spread of untrusted data, RP-P2-3). An object patch ALWAYS recurses, treating a missing or
 * non-object target as `{}`, so nested null-delete / sigils / forbidden-key checks apply at every level (RP-P2-1). A patch field
 * named `__proto__`/`constructor`/`prototype` is rejected, and we do NOT auto-promote a scalar to a one-element array on `+`.
 *
 * DORMANT: `roleProfileV2Enabled` (SWARM_ROLEPROFILE_V2, default OFF); the module ships pure + selftested but UNWIRED (the live
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
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** Read an OWN DATA property's value (RP-P2-2): the prototype chain is never consulted and an accessor is never invoked
 *  (descriptor.value is the stored datum; an accessor-only own prop ⇒ undefined ⇒ treated as absent). */
function ownVal(o: object, k: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d && "value" in d ? d.value : undefined;
}

/** Validate an untrusted value as an array of non-empty strings AND return a CLEAN index-built copy, or null (RP-P2-3): no
 *  `.every`, no spread, no iterator — a genuine array walked by index, so a sparse hole (undefined) or a non-string rejects and
 *  a hijacked `every`/`Symbol.iterator` is never run. */
function strArrayCopy(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i];
    if (!isNonEmptyStr(x)) return null;
    out.push(x);
  }
  return out;
}

/** Copy an array by index (no spread/iterator). Elements are copied as-is (generic; callers re-validate content). */
function copyByIndex<T>(v: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < v.length; i += 1) out.push(v[i] as T);
  return out;
}

function validModelTier(v: unknown): ModelTierSpec | null {
  if (!isObj(v)) return null;
  const floor = ownVal(v, "floor");
  if (floor !== "light" && floor !== "standard" && floor !== "heavy") return null;
  const upgradeOnRaw = ownVal(v, "upgradeOn");
  const note = ownVal(v, "note");
  let upgradeOn: string[] | undefined;
  if (upgradeOnRaw !== undefined) { const c = strArrayCopy(upgradeOnRaw); if (!c) return null; upgradeOn = c; }
  if (note !== undefined && !isStr(note)) return null;
  return { floor, ...(upgradeOn ? { upgradeOn } : {}), ...(isStr(note) ? { note } : {}) };
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
      const val = ownVal(v, k);
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
      const copy = strArrayCopy(ownVal(v, k));
      if (!copy) return { ok: false, reason: `${what}."${k}" must be an array of non-empty strings` };
      out[k] = copy;
    }
    return { ok: true, value: out };
  };
  const ib = strMap(ownVal(input, "instructionBlocks"), "instructionBlocks");
  if (!ib.ok) return ib;
  const sg = strArrMap(ownVal(input, "skillGroups"), "skillGroups");
  if (!sg.ok) return sg;
  const bg = strArrMap(ownVal(input, "boundaryGroups"), "boundaryGroups");
  if (!bg.ok) return bg;
  return { ok: true, value: { instructionBlocks: ib.value, skillGroups: sg.value, boundaryGroups: bg.value } };
}

// ---- role (v1 passthrough OR v2) ---------------------------------------------------------------------------------------
function validV1(input: Record<string, unknown>): Res<ResolvedRoleProfile> {
  const roleId = ownVal(input, "roleId"), title = ownVal(input, "title"), summary = ownVal(input, "summary");
  if (!isNonEmptyStr(roleId) || !isNonEmptyStr(title) || !isNonEmptyStr(summary)) return { ok: false, reason: "v1 role: roleId/title/summary must be non-empty strings" };
  const skills = strArrayCopy(ownVal(input, "skills"));
  if (!skills) return { ok: false, reason: "v1 role: skills must be an array of non-empty strings" };
  const modelTier = validModelTier(ownVal(input, "modelTier"));
  if (!modelTier) return { ok: false, reason: "v1 role: modelTier invalid" };
  const expectedParallelism = ownVal(input, "expectedParallelism");
  if (typeof expectedParallelism !== "number" || !Number.isFinite(expectedParallelism)) return { ok: false, reason: "v1 role: expectedParallelism must be a finite number" };
  const fileDomain = strArrayCopy(ownVal(input, "fileDomain"));
  if (!fileDomain) return { ok: false, reason: "v1 role: fileDomain must be an array of non-empty strings" };
  const promptTemplate = ownVal(input, "promptTemplate");
  if (!isStr(promptTemplate)) return { ok: false, reason: "v1 role: promptTemplate must be a string" };
  const claimDiscipline = ownVal(input, "claimDiscipline");
  if (!isNonEmptyStr(claimDiscipline)) return { ok: false, reason: "v1 role: claimDiscipline must be a non-empty string" };
  const boundaries = strArrayCopy(ownVal(input, "boundaries"));
  if (!boundaries) return { ok: false, reason: "v1 role: boundaries must be an array of non-empty strings" };
  return { ok: true, value: { roleId, title, summary, skills, modelTier, expectedParallelism, fileDomain, promptTemplate, claimDiscipline, boundaries } };
}

function validV2(input: Record<string, unknown>): Res<RoleProfileV2> {
  const roleId = ownVal(input, "roleId"), title = ownVal(input, "title"), summary = ownVal(input, "summary");
  if (!isNonEmptyStr(roleId) || !isNonEmptyStr(title) || !isNonEmptyStr(summary)) return { ok: false, reason: "v2 role: roleId/title/summary must be non-empty strings" };
  const modelTier = validModelTier(ownVal(input, "modelTier"));
  if (!modelTier) return { ok: false, reason: "v2 role: modelTier invalid" };
  const expectedParallelism = ownVal(input, "expectedParallelism");
  if (typeof expectedParallelism !== "number" || !Number.isFinite(expectedParallelism)) return { ok: false, reason: "v2 role: expectedParallelism must be a finite number" };
  const fileDomain = strArrayCopy(ownVal(input, "fileDomain"));
  if (!fileDomain) return { ok: false, reason: "v2 role: fileDomain must be an array of non-empty strings" };
  const claimDiscipline = ownVal(input, "claimDiscipline");
  if (!isNonEmptyStr(claimDiscipline)) return { ok: false, reason: "v2 role: claimDiscipline must be a non-empty string" };
  const promptHead = ownVal(input, "promptHead");
  if (!isStr(promptHead)) return { ok: false, reason: "v2 role: promptHead must be a string" };
  // optional string arrays — each captured once as a clean copy or rejected
  const opt: Record<string, string[] | undefined> = {};
  for (const k of ["useInstructions", "useSkills", "skills", "useBoundaries", "boundaries"]) {
    const raw = ownVal(input, k);
    if (raw === undefined) continue;
    const copy = strArrayCopy(raw);
    if (!copy) return { ok: false, reason: `v2 role: ${k} must be an array of non-empty strings` };
    opt[k] = copy;
  }
  let flavors: Record<string, Record<string, unknown>> | undefined;
  const flavorsRaw = ownVal(input, "flavors");
  if (flavorsRaw !== undefined) {
    if (!isObj(flavorsRaw)) return { ok: false, reason: "v2 role: flavors must be an object" };
    flavors = {};
    for (const name of Object.getOwnPropertyNames(flavorsRaw)) {
      if (FORBIDDEN.has(name)) return { ok: false, reason: `v2 role: flavor has a forbidden name "${name}"` };
      const patch = ownVal(flavorsRaw, name);
      if (!isObj(patch)) return { ok: false, reason: `v2 role: flavor "${name}" must be an object (a merge patch)` };
      flavors[name] = patch;
    }
  }
  return { ok: true, value: {
    schemaNote: "roleProfile/v2", roleId, title, summary, modelTier, expectedParallelism, fileDomain, claimDiscipline, promptHead,
    ...(opt.useInstructions ? { useInstructions: opt.useInstructions } : {}),
    ...(opt.useSkills ? { useSkills: opt.useSkills } : {}),
    ...(opt.skills ? { skills: opt.skills } : {}),
    ...(opt.useBoundaries ? { useBoundaries: opt.useBoundaries } : {}),
    ...(opt.boundaries ? { boundaries: opt.boundaries } : {}),
    ...(flavors ? { flavors } : {}),
  } };
}

export function loadRoleProfile(input: unknown): Res<LoadedRole> {
  if (!isObj(input)) return { ok: false, reason: "role profile must be an object" };
  if (ownVal(input, "schemaNote") === "roleProfile/v2") {
    const r = validV2(input);
    return r.ok ? { ok: true, value: { kind: "v2", role: r.value } } : r;
  }
  const r = validV1(input);
  return r.ok ? { ok: true, value: { kind: "v1", profile: r.value } } : r;
}

// ---- flavor merge patch (RFC 7386 + key+/key- array sigils; pure, proto-safe, no input methods) -------------------------
export function mergeRolePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Res<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(base)) if (!FORBIDDEN.has(k)) result[k] = ownVal(base, k); // fresh object, own data only
  const touched = new Set<string>();
  for (const key of Object.getOwnPropertyNames(patch)) {
    const op = key.endsWith("+") ? "append" : key.endsWith("-") ? "remove" : "set";
    const field = op === "set" ? key : key.slice(0, -1);
    if (field.length === 0 || FORBIDDEN.has(field)) return { ok: false, reason: `patch key "${key}" targets a forbidden/empty field` };
    if (touched.has(field)) return { ok: false, reason: `patch touches field "${field}" more than once (ambiguous)` };
    touched.add(field);
    // RP-P2-2 (round-2): the patch key MUST be an own DATA property. An accessor/getter patch key has no `value`, which ownVal
    // would turn into `undefined` and then silently write — clearing an existing field. Reject it outright.
    const pd = Object.getOwnPropertyDescriptor(patch, key);
    if (!pd || !("value" in pd)) return { ok: false, reason: `patch key "${key}" must be a data property (an accessor/getter patch is rejected)` };
    const val = pd.value;
    if (op === "append") {
      if (!Array.isArray(val)) return { ok: false, reason: `patch "${key}" value must be an array` };
      const cur = Object.prototype.hasOwnProperty.call(result, field) ? result[field] : undefined;
      if (cur !== undefined && !Array.isArray(cur)) return { ok: false, reason: `patch "${key}" on a non-array field "${field}"` };
      result[field] = [...copyByIndex((cur as unknown[]) ?? []), ...copyByIndex(val)]; // index copies, no untrusted iterator
    } else if (op === "remove") {
      if (!Array.isArray(val)) return { ok: false, reason: `patch "${key}" value must be an array` };
      const cur = Object.prototype.hasOwnProperty.call(result, field) ? result[field] : undefined;
      if (!Array.isArray(cur)) return { ok: false, reason: `patch "${key}" removes from a non-array field "${field}"` };
      const removeSet = new Set<unknown>();
      for (let i = 0; i < val.length; i += 1) removeSet.add(val[i]); // membership by index, never val.includes
      const out: unknown[] = [];
      for (let i = 0; i < cur.length; i += 1) { const e = cur[i]; if (!removeSet.has(e)) out.push(e); } // RP-P2-3 (round-2): capture ONCE — membership test + output use the same value (a getter element can't write back a removed value)
      result[field] = out;
    } else {
      if (val === null) { delete result[field]; continue; }
      if (isObj(val)) {
        const cur = Object.prototype.hasOwnProperty.call(result, field) ? result[field] : undefined;
        const r = mergeRolePatch(isObj(cur) ? cur : {}, val); // RP-P2-1: an object patch ALWAYS recurses (absent/non-object ⇒ {})
        if (!r.ok) return r;
        result[field] = r.value;
      } else {
        result[field] = val; // scalar/array replace (RFC 7386 for a non-object patch value)
      }
    }
  }
  return { ok: true, value: result };
}

/** Apply a named flavor to a v2 role, returning a new v2 role. Rejects an unknown name or a patch that re-validates invalid. */
export function applyFlavor(role: RoleProfileV2, flavorName: string): Res<RoleProfileV2> {
  if (!role.flavors || !Object.prototype.hasOwnProperty.call(role.flavors, flavorName)) return { ok: false, reason: `unknown flavor "${flavorName}"` };
  const { flavors, ...bare } = role; // the patch applies to the role WITHOUT its flavors map
  const merged = mergeRolePatch(bare as Record<string, unknown>, role.flavors[flavorName]!);
  if (!merged.ok) return merged;
  const reval = validV2({ ...merged.value, schemaNote: "roleProfile/v2" });
  return reval.ok ? { ok: true, value: reval.value } : { ok: false, reason: `flavor "${flavorName}" produced an invalid role: ${reval.reason}` };
}

const dedupe = (xs: string[]): string[] => { const seen = new Set<string>(); const out: string[] = []; for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); } return out; };

/** Resolve a loaded role into the v1 ResolvedRoleProfile. A v1 role passes through (a flavor on a v1 role is rejected). A v2
 *  role: apply the flavor (if any), expand `use_*` against the library (dangling ref ⇒ whole-reject), assemble promptTemplate =
 *  promptHead + referenced blocks (list order), skills/boundaries = referenced groups ∪ inline extras (order-preserving, deduped).
 *  Operates only on validated clean copies (from loadFragmentLibrary / loadRoleProfile). */
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
    if (!Object.prototype.hasOwnProperty.call(library.instructionBlocks, name)) return { ok: false, reason: `role "${role.roleId}": instruction block "${name}" not in the fragment library` };
    blocks.push(library.instructionBlocks[name]!);
  }
  const skills: string[] = [];
  for (const g of role.useSkills ?? []) {
    if (!Object.prototype.hasOwnProperty.call(library.skillGroups, g)) return { ok: false, reason: `role "${role.roleId}": skill group "${g}" not in the fragment library` };
    for (const s of library.skillGroups[g]!) skills.push(s);
  }
  for (const s of role.skills ?? []) skills.push(s);
  const boundaries: string[] = [];
  for (const g of role.useBoundaries ?? []) {
    if (!Object.prototype.hasOwnProperty.call(library.boundaryGroups, g)) return { ok: false, reason: `role "${role.roleId}": boundary group "${g}" not in the fragment library` };
    for (const b of library.boundaryGroups[g]!) boundaries.push(b);
  }
  for (const b of role.boundaries ?? []) boundaries.push(b);
  const promptTemplate = blocks.length > 0 ? `${role.promptHead}\n\n${blocks.join("\n\n")}` : role.promptHead;
  return { ok: true, value: {
    roleId: role.roleId, title: role.title, summary: role.summary, skills: dedupe(skills), modelTier: role.modelTier,
    expectedParallelism: role.expectedParallelism, fileDomain: copyByIndex(role.fileDomain), promptTemplate,
    claimDiscipline: role.claimDiscipline, boundaries: dedupe(boundaries),
  } };
}

/** Dormant wiring flip, default OFF (dormant-ahead-of-use, like SWARM_BOARD_ADMIT). The live spawn/launcher resolves v2 only when on. */
export function roleProfileV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_ROLEPROFILE_V2 ?? "");
}
