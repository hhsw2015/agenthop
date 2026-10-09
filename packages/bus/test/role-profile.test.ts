import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  loadFragmentLibrary, loadRoleProfile, mergeRolePatch, applyFlavor, resolveRoleProfile, roleProfileV2Enabled,
  type FragmentLibrary, type RoleProfileV2,
} from "../src/swarm/role-profile.js";

const fixDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "roleprofile");
const fix = (f: string): unknown => JSON.parse(readFileSync(path.join(fixDir, f), "utf8"));

const okv = <T>(r: { ok: true; value: T } | { ok: false; reason: string }): T => { if (!r.ok) throw new Error(r.reason); return r.value; };
const LIB_INPUT = {
  instructionBlocks: { s11: "[S11] one message one anchor", f30: "[F30] roll-call on boot", s24: "[S24] no dialogs" },
  skillGroups: { "impl-core": ["pure-reducer", "selftest-tdd"] },
  boundaryGroups: { "single-editor": ["no cross-domain edits", "diff hand-off"] },
};
const lib = (): FragmentLibrary => okv(loadFragmentLibrary(LIB_INPUT));

const V2_ROLE = {
  schemaNote: "roleProfile/v2", roleId: "pure-layer-impl", title: "纯层实现者", summary: "pure reducers + selftest",
  modelTier: { floor: "standard", upgradeOn: ["invariant-dense"] }, expectedParallelism: 1,
  fileDomain: ["packages/*/src/<new>.ts"], claimDiscipline: "rename+wait+PROGRESS",
  promptHead: "你是纯层实现者。任务:{{task}}", useInstructions: ["s11", "f30"],
  useSkills: ["impl-core"], skills: ["schema-validation", "pure-reducer"], // "pure-reducer" dup with group ⇒ deduped
  useBoundaries: ["single-editor"],
  flavors: { strict: { modelTier: { floor: "heavy" }, "boundaries+": ["每条反例附行号"] }, lenient: { "useInstructions-": ["s24"], expectedParallelism: 2 } },
};

describe("role-profile — loadFragmentLibrary (whole-reject, forbidden names)", () => {
  test("valid library loads; absent maps default to {}", () => {
    const l = okv(loadFragmentLibrary(LIB_INPUT));
    expect(l.instructionBlocks.s11).toContain("S11");
    expect(l.skillGroups["impl-core"]).toEqual(["pure-reducer", "selftest-tdd"]);
    expect(okv(loadFragmentLibrary({})).instructionBlocks).toEqual({});
  });
  test("rejects a non-object, a non-string block, a non-string-array group, a forbidden name", () => {
    expect(loadFragmentLibrary(null).ok).toBe(false);
    expect(loadFragmentLibrary({ instructionBlocks: { x: 1 } }).ok).toBe(false);
    expect(loadFragmentLibrary({ skillGroups: { g: ["ok", 2] } }).ok).toBe(false);
    expect(loadFragmentLibrary({ instructionBlocks: { x: "" } }).ok).toBe(false);
    expect(loadFragmentLibrary(JSON.parse('{"instructionBlocks":{"__proto__":"x"}}')).ok).toBe(false);
  });
});

describe("role-profile — loadRoleProfile (v1 passthrough detect / v2 detect)", () => {
  test("a role without schemaNote=v2 loads as v1; a v2 schemaNote loads as v2", () => {
    const v1 = { roleId: "r", title: "t", summary: "s", skills: ["a"], modelTier: { floor: "light" }, expectedParallelism: 1, fileDomain: ["x"], promptTemplate: "P", claimDiscipline: "c", boundaries: ["b"] };
    expect(okv(loadRoleProfile(v1)).kind).toBe("v1");
    expect(okv(loadRoleProfile(V2_ROLE)).kind).toBe("v2");
  });
  test("malformed role ⇒ reject", () => {
    expect(loadRoleProfile({ schemaNote: "roleProfile/v2", roleId: "r" }).ok).toBe(false);
    expect(loadRoleProfile({ roleId: "r", title: "t", summary: "s", skills: "notarray", modelTier: { floor: "light" }, expectedParallelism: 1, fileDomain: [], promptTemplate: "", claimDiscipline: "c", boundaries: [] }).ok).toBe(false);
    expect(loadRoleProfile({ ...V2_ROLE, modelTier: { floor: "turbo" } }).ok).toBe(false);
  });
});

describe("role-profile — mergeRolePatch (RFC 7386 + key+/key- sigils, proto-safe)", () => {
  test("scalar/object replace, null delete, nested object merge", () => {
    expect(okv(mergeRolePatch({ a: 1, b: 2 }, { a: 9 }))).toEqual({ a: 9, b: 2 });
    expect(okv(mergeRolePatch({ a: 1, b: 2 }, { b: null }))).toEqual({ a: 1 });
    expect(okv(mergeRolePatch({ mt: { floor: "standard", note: "keep" } }, { mt: { floor: "heavy" } }))).toEqual({ mt: { floor: "heavy", note: "keep" } }); // nested merge keeps note
  });
  test("key+ append (absent ⇒ []), key- remove-by-value", () => {
    expect(okv(mergeRolePatch({ xs: ["a"] }, { "xs+": ["b", "c"] }))).toEqual({ xs: ["a", "b", "c"] });
    expect(okv(mergeRolePatch({}, { "xs+": ["b"] }))).toEqual({ xs: ["b"] });
    expect(okv(mergeRolePatch({ xs: ["a", "b", "c"] }, { "xs-": ["b"] }))).toEqual({ xs: ["a", "c"] });
  });
  test("rejects: a field touched twice, a sigil on a non-array, a forbidden field", () => {
    expect(mergeRolePatch({ xs: [] }, { xs: [1], "xs+": [2] }).ok).toBe(false); // ambiguous: set + append same field
    expect(mergeRolePatch({ s: "scalar" }, { "s+": ["x"] }).ok).toBe(false); // append to a scalar (no auto-coerce)
    expect(mergeRolePatch({ s: "scalar" }, { "s-": ["x"] }).ok).toBe(false); // remove from a scalar
    expect(mergeRolePatch({}, JSON.parse('{"__proto__":{"polluted":1}}')).ok).toBe(false); // forbidden field
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global pollution happened
  });
  test("the result is a fresh object (input base not mutated)", () => {
    const base = { xs: ["a"] };
    okv(mergeRolePatch(base, { "xs+": ["b"] }));
    expect(base.xs).toEqual(["a"]); // base untouched
  });
});

describe("role-profile — applyFlavor", () => {
  const v2 = (): RoleProfileV2 => okv(loadRoleProfile(V2_ROLE)).kind === "v2" ? (okv(loadRoleProfile(V2_ROLE)) as { kind: "v2"; role: RoleProfileV2 }).role : (() => { throw new Error("not v2"); })();
  test("unknown flavor ⇒ reject", () => {
    expect(applyFlavor(v2(), "ghost").ok).toBe(false);
  });
  test("strict: object-merges modelTier.floor, appends a boundary", () => {
    const r = okv(applyFlavor(v2(), "strict"));
    expect(r.modelTier.floor).toBe("heavy");
    expect(r.modelTier.upgradeOn).toEqual(["invariant-dense"]); // nested merge kept upgradeOn
    expect(r.boundaries).toEqual(["每条反例附行号"]); // base had no inline boundaries ⇒ appended onto []
  });
  test("lenient: removes an unused instruction ref, overrides scalar", () => {
    const r = okv(applyFlavor(v2(), "lenient"));
    expect(r.useInstructions).toEqual(["s11", "f30"]); // s24 wasn't in the list ⇒ remove is a no-op, stays valid
    expect(r.expectedParallelism).toBe(2);
  });
});

describe("role-profile — resolveRoleProfile", () => {
  test("v1 passthrough is byte-identical; a flavor on a v1 role is rejected", () => {
    const v1obj = { roleId: "r", title: "t", summary: "s", skills: ["a"], modelTier: { floor: "light" as const }, expectedParallelism: 1, fileDomain: ["x"], promptTemplate: "P", claimDiscipline: "c", boundaries: ["b"] };
    const loaded = okv(loadRoleProfile(v1obj));
    expect(resolveRoleProfile(lib(), loaded)).toEqual({ ok: true, value: v1obj }); // unchanged
    expect(resolveRoleProfile(lib(), loaded, "strict").ok).toBe(false); // v1 has no flavors
  });

  test("GOLDEN: a v2 role resolves to the exact v1 shape (promptTemplate assembled, skills/boundaries union+deduped)", () => {
    const resolved = okv(resolveRoleProfile(lib(), okv(loadRoleProfile(V2_ROLE))));
    expect(resolved).toEqual({
      roleId: "pure-layer-impl", title: "纯层实现者", summary: "pure reducers + selftest",
      skills: ["pure-reducer", "selftest-tdd", "schema-validation"], // impl-core group ∪ inline, "pure-reducer" dup dropped
      modelTier: { floor: "standard", upgradeOn: ["invariant-dense"] }, expectedParallelism: 1,
      fileDomain: ["packages/*/src/<new>.ts"],
      promptTemplate: "你是纯层实现者。任务:{{task}}\n\n[S11] one message one anchor\n\n[F30] roll-call on boot",
      claimDiscipline: "rename+wait+PROGRESS",
      boundaries: ["no cross-domain edits", "diff hand-off"],
    });
  });

  test("a dangling use_* ref whole-rejects (no silent drop)", () => {
    const bad = { ...V2_ROLE, useInstructions: ["s11", "ghost-block"] };
    expect(resolveRoleProfile(lib(), okv(loadRoleProfile(bad))).ok).toBe(false);
    const badSkill = { ...V2_ROLE, useSkills: ["no-such-group"] };
    expect(resolveRoleProfile(lib(), okv(loadRoleProfile(badSkill))).ok).toBe(false);
  });

  test("flavor applied THEN expanded: strict ⇒ heavy floor + extra boundary in the resolved v1", () => {
    const r = okv(resolveRoleProfile(lib(), okv(loadRoleProfile(V2_ROLE)), "strict"));
    expect(r.modelTier.floor).toBe("heavy");
    expect(r.boundaries).toEqual(["no cross-domain edits", "diff hand-off", "每条反例附行号"]); // group ∪ appended
  });
});

describe("role-profile — GOLDEN real-role migration byte-identity (钉迁移)", () => {
  test("the migrated pure-layer-impl v2 + _fragments resolve to the EXACT committed v1 (zero drift)", () => {
    const library = okv(loadFragmentLibrary(fix("_fragments.json")));
    const v2loaded = okv(loadRoleProfile(fix("pure-layer-impl.v2.json")));
    const v1loaded = okv(loadRoleProfile(fix("pure-layer-impl.v1.json")));
    expect(v1loaded.kind).toBe("v1");
    const v1 = v1loaded.kind === "v1" ? v1loaded.profile : null;
    const resolved = okv(resolveRoleProfile(library, v2loaded));
    expect(resolved).toEqual(v1); // promptTemplate, skills, boundaries, modelTier, fileDomain … all byte-identical to v1
  });
});

describe("role-profile — RP-P2-1 object patch always recurses (absent/non-object target ⇒ {})", () => {
  test("recurses into an object patch on a missing target, applying null-delete + sigil inside", () => {
    expect(okv(mergeRolePatch({}, { branch: { drop: null, "items+": ["a"] } }))).toEqual({ branch: { items: ["a"] } });
  });
  test("a non-object target is treated as {} and merged, not overwritten verbatim", () => {
    expect(okv(mergeRolePatch({ b: "scalar" }, { b: { k: 1 } }))).toEqual({ b: { k: 1 } });
  });
  test("a nested forbidden key is caught inside the recursion", () => {
    expect(mergeRolePatch({}, { branch: JSON.parse('{"__proto__":{"x":1}}') }).ok).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined(); // no global pollution
  });
});

describe("role-profile — RP-P2-2 own-property + capture-once (no inherited reads, no getter TOCTOU)", () => {
  test("a role whose fields are all INHERITED is rejected (own-only reads)", () => {
    const proto = { roleId: "r", title: "t", summary: "s", skills: ["a"], modelTier: { floor: "light" }, expectedParallelism: 1, fileDomain: ["x"], promptTemplate: "P", claimDiscipline: "c", boundaries: ["b"] };
    expect(loadRoleProfile(Object.create(proto)).ok).toBe(false);
  });
  test("a getter field is treated as absent (never invoked), so a TOCTOU cannot slip a number through", () => {
    let n = 0;
    const v2: Record<string, unknown> = { schemaNote: "roleProfile/v2", roleId: "r", title: "t", summary: "s", modelTier: { floor: "standard" }, expectedParallelism: 1, fileDomain: ["x"], claimDiscipline: "c" };
    Object.defineProperty(v2, "promptHead", { enumerable: true, configurable: true, get() { return n++ === 0 ? "head" : 42; } });
    expect(loadRoleProfile(v2).ok).toBe(false); // ownVal reads descriptor.value (none for an accessor) ⇒ promptHead absent ⇒ reject
  });
  test("an inherited modelTier.floor does not satisfy a v2 role", () => {
    const mt = Object.create({ floor: "heavy" }); // floor is inherited
    const v2 = { schemaNote: "roleProfile/v2", roleId: "r", title: "t", summary: "s", modelTier: mt, expectedParallelism: 1, fileDomain: ["x"], claimDiscipline: "c", promptHead: "h" };
    expect(loadRoleProfile(v2).ok).toBe(false);
  });
});

describe("role-profile — RP-P2-3 arrays validated/copied/removed by index (no input methods)", () => {
  test("a sparse array is rejected; a hijacked every cannot smuggle a non-string", () => {
    const sparse = { roleId: "r", title: "t", summary: "s", skills: new Array(1), modelTier: { floor: "light" as const }, expectedParallelism: 1, fileDomain: ["x"], promptTemplate: "P", claimDiscipline: "c", boundaries: ["b"] };
    expect(loadRoleProfile(sparse).ok).toBe(false);
    const skills = ["ok", 2] as unknown[]; (skills as { every: unknown }).every = () => true;
    expect(loadRoleProfile({ roleId: "r", title: "t", summary: "s", skills, modelTier: { floor: "light" }, expectedParallelism: 1, fileDomain: ["x"], promptTemplate: "P", claimDiscipline: "c", boundaries: ["b"] }).ok).toBe(false);
  });
  test("remove matches ACTUAL elements (Set membership), never a hijacked includes/filter", () => {
    const evil = ["zzz"] as string[]; (evil as { includes: unknown }).includes = () => true; // would delete everything if called
    expect(okv(mergeRolePatch({ boundaries: ["a", "b"] }, { "boundaries-": evil }))).toEqual({ boundaries: ["a", "b"] }); // "zzz" absent ⇒ nothing removed
    expect(okv(mergeRolePatch({ boundaries: ["a", "b", "c"] }, { "boundaries-": ["b"] }))).toEqual({ boundaries: ["a", "c"] });
  });
});

describe("role-profile — round-2 residual fixes (accessor patch key / remove capture-once)", () => {
  test("RP-P2-2 residual: an accessor patch key is REJECTED (never silently clears a field; getter not invoked)", () => {
    const patch: Record<string, unknown> = {};
    let calls = 0;
    Object.defineProperty(patch, "boundaries", { enumerable: true, get() { calls += 1; return []; } });
    expect(mergeRolePatch({ boundaries: ["require approval"] }, patch).ok).toBe(false);
    expect(calls).toBe(0);
  });
  test("RP-P2-2 residual: a flavor with an accessor patch key fails applyFlavor (not an empty-boundaries success)", () => {
    const loaded = okv(loadRoleProfile({ ...V2_ROLE, boundaries: ["require approval"] }));
    if (loaded.kind !== "v2") throw new Error("not v2");
    const flavorPatch: Record<string, unknown> = {};
    Object.defineProperty(flavorPatch, "boundaries", { enumerable: true, get() { return []; } });
    const withEvil: RoleProfileV2 = { ...loaded.role, flavors: { evil: flavorPatch } };
    expect(applyFlavor(withEvil, "evil").ok).toBe(false);
  });
  test("RP-P2-3 residual: remove captures each element once — a getter element cannot resurrect a removed value", () => {
    const cur: string[] = [];
    let reads = 0;
    Object.defineProperty(cur, 0, { enumerable: true, configurable: true, get() { return reads++ === 0 ? "keep" : "remove"; } });
    cur.length = 1;
    const r = okv(mergeRolePatch({ boundaries: cur }, { "boundaries-": ["remove"] }));
    expect(r.boundaries).toEqual(["keep"]); // canonical read = "keep" ⇒ kept; the removed value is never written back
    expect(reads).toBe(1);
  });
});

describe("role-profile — roleProfileV2Enabled (dormant, default OFF)", () => {
  test("default OFF; truthy words ON", () => {
    expect(roleProfileV2Enabled({})).toBe(false);
    expect(roleProfileV2Enabled({ SWARM_ROLEPROFILE_V2: "0" })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "YES"]) expect(roleProfileV2Enabled({ SWARM_ROLEPROFILE_V2: on })).toBe(true);
  });
});
