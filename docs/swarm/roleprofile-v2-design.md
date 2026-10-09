# roleProfile v2 — reusable fragments + flavor overrides (DA1 design, one page, for coordinator approval before implement)

owner f32a0507 · 2026-10-09 · 协调者派单(docker-agent 吸收批 DA1,杠杆最高)· 借 docker-agent schema v16 两概念自建(Apache-2.0 借思路,零代码依赖,参考 docs/research/docker-agent-eval.md Q1)· branch `feat/roleprofile-v2` off main `bdd93d7` · design-first, 批后实现

## Problem

Each roleProfile (`~/.agenthop/swarm/roles/<roleId>.json`) carries a ~3 KB `promptTemplate` that REPEATS the same discipline
blocks verbatim across every role — S11 消息纪律, F30 报到, S14 产物报告, S15 受控写作, F33 盘点, S18 交错, S23 花钱线, S24 禁弹框.
Adding a role variant (e.g. a `reviewer` strict vs lenient) means copying the whole file. Two borrowed concepts fix both.

## ① Named fragment library + `use_*` refs (cut duplication)

A shared `~/.agenthop/swarm/roles/_fragments.json` defines reusable, named pieces ONCE:
```
{ "schemaNote": "roleProfile-fragments/v2",
  "instructionBlocks": { "s11-msg": "…", "f30-rollcall": "…", "s24-no-dialog": "… " },
  "skillGroups":       { "impl-core": ["pure-reducer","selftest-tdd", …] },
  "boundaryGroups":    { "single-editor": ["不碰他人单编辑者文件…", …] } }
```
A v2 role becomes a THIN head + references:
```
{ "roleId":"pure-layer-impl", "schemaNote":"roleProfile/v2", …floor/fileDomain/expectedParallelism unchanged…,
  "promptHead": "你是纯层实现者。任务:{{task}}\n信封:{{envelope}}\n纪律:(1)…(5)…",
  "useInstructions": ["s11-msg","f30-rollcall","s14-report","s15-writing","f33-inventory","s18-interleave","s23-spend","s24-no-dialog"],
  "useSkills": ["impl-core"], "skills": ["schema-validation"],      // group refs + inline extras (union, deduped)
  "useBoundaries": ["single-editor"], "boundaries": [] }
```
The resolver assembles the v1-shaped `promptTemplate` = `promptHead` + the referenced blocks (in list order), and the final
`skills`/`boundaries` = the referenced groups ∪ inline extras (order-preserving, de-duped). A dangling `use_*` name REJECTS the
whole resolve with a reason (mirror task-plan loadPlan — never silently drop a missing block).

## ② Named flavor overrides (variants without copying)

A base role declares named patches; each is a JSON Merge Patch (RFC 7386) with two sigil extensions on array fields:
```
"flavors": {
  "strict":  { "modelTier": {"floor":"heavy"}, "boundaries+": ["每条反例必附行号+门槛"] },     // scalar/object merge + array append
  "lenient": { "useInstructions-": ["s24-no-dialog"], "expectedParallelism": 2 }               // array remove-by-value
}
```
Resolve `(role, "strict")` applies the patch to the base: plain key = RFC-7386 (null deletes, object recurses, scalar/array
replaces); `key+` = append to the array (base absent ⇒ `[]`; non-array base ⇒ REJECT); `key-` = remove-by-value from the array
(non-array base ⇒ REJECT). Both `key` and `key+`/`key-` for one field in one patch ⇒ REJECT (ambiguous). We do NOT auto-coerce a
scalar to a single-element array on `+` (docker-agent does; our fields are typed — appending to a scalar is a bug, reject). The
patch applies to the RAW role (before `use_*` expansion), so a flavor may edit the `use_*` lists themselves; expansion runs after.

## Resolver (pure) + compat migration

New pure module `packages/bus/src/swarm/role-profile.ts`: `loadFragments`, `loadRoleProfile` (whole-reject on a malformed role),
`applyFlavor(role, name)`, `resolveRoleProfile(library, role, flavor?) → ResolvedRoleProfile` (the v1 shape). IO (reading the two
files) is a thin shell, injected. **Backward-compatible:** a v1 file (no `schemaNote: roleProfile/v2`, inline `promptTemplate`, no
`use_*`/`flavors`) passes through unchanged — the resolver returns it as-is. The t3 `RoleCatalog` projection (`{floor, fileDomain}`
per role) is UNCHANGED: v2 resolves to the same floor/fileDomain, so `task-translate` and every digest are untouched. Migration of
the 3 existing roles (pure-layer-impl / io-impl / adversarial-review) is a pure refactor: lift the 8 identical discipline blocks
into `_fragments.json`, replace each `promptTemplate` with `promptHead` + `useInstructions`, and the resolved output is byte-identical
to today (a golden test pins this). adversarial-review then gains `flavors: {strict, lenient}` as the first variant.

## Dormant + scope

`SWARM_ROLEPROFILE_V2` (default OFF, dormant-ahead-of-use like SWARM_BOARD_ADMIT) gates the eventual spawn/launcher wiring that
reads a resolved profile; the resolver ships pure + selftested but UNWIRED (the live spawn path still reads v1 today). Scope:
schema + resolver + validators + the 3 migrated role fixtures + a golden byte-identity test + heavy selftests. NON-goals: changing
`RoleCatalog`/t3, a budget-pool fragment (that is立项② 共享预算池, separate), force_handoff (立项④), any live spawn change.

## OPEN QUESTIONS for the coordinator (R3-b, recommended defaults)

1. Fragment library location: one shared `_fragments.json` (recommended) vs per-category files? → default: one file.
2. Flavors inline in the base role (recommended, keeps a variant next to its base) vs separate `<roleId>.<flavor>.json`? → default: inline.
3. `key-` semantics: remove-by-value (recommended, matches docker-agent) vs remove-by-index? → default: by-value; delete a whole key via RFC-7386 `key: null`.
