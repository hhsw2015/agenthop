# roleProfile v2 — review packet (DA1)

owner f32a0507 · 2026-10-09 · branch `feat/roleprofile-v2` off main `bdd93d7` · reviewer codex:happycapy-01a0ff49

Design APPROVED (docs/swarm/roleprofile-v2-design.md), all 3 defaults taken: single `_fragments.json`, flavors inline, `key-`
remove-by-value (whole-key delete via RFC-7386 null). Borrows docker-agent schema v16 (Apache-2.0 ideas, zero code dependency).

Files (`git diff --stat 1949284..HEAD`):
- `packages/bus/src/swarm/role-profile.ts` — NEW pure module (no IO, no clock).
- `packages/bus/test/role-profile.test.ts` — 17 tests.
- `packages/bus/test/fixtures/roleprofile/{_fragments,pure-layer-impl.v1,pure-layer-impl.v2}.json` — the real-role migration golden.
- design one-pager + this packet.

## What it does

`resolveRoleProfile(library, loadedRole, flavor?) → ResolvedRoleProfile` (the EXACT v1 shape). A v1 role passes through
unchanged; a v2 role (schemaNote `roleProfile/v2`) has its flavor applied (if any), then `use_*` refs expanded against the
library: `promptTemplate = promptHead + "\n\n" + referenced instructionBlocks` (list order); `skills`/`boundaries` = referenced
groups ∪ inline extras (order-preserving, de-duped). `mergeRolePatch` is RFC 7386 + `key+` (append) / `key-` (remove-by-value).

## What to grill

1. **Whole-reject, no silent drop/coerce** — a dangling `use_*` ref, a malformed role/library, a sigil on a non-array, a
   scalar `+` (we do NOT auto-promote to a 1-element array, unlike docker-agent), a field a patch touches twice, all REJECT.
2. **Prototype-pollution safety** — `mergeRolePatch` reads only OWN properties, builds a fresh object, and REJECTS a patch
   field named `__proto__`/`constructor`/`prototype` (and the library/role validators reject those as fragment names). A
   `JSON.parse('{"__proto__":…}')` patch neither pollutes nor passes. Adversary: a patch that mutates a prototype or the input base.
3. **key- / RFC-7386 semantics** — `key-` removes by value from an array (non-array ⇒ reject); `key: null` deletes the whole
   key; a plain object value merges recursively (nested `modelTier.floor` override keeps `upgradeOn`); scalar/array replaces.
4. **v1 passthrough byte-identity + flavor-on-v1 reject** — `resolveRoleProfile` returns a v1 role unchanged; a flavor named
   on a v1 role rejects.
5. **GOLDEN real-role migration (钉迁移)** — the migrated `pure-layer-impl` v2 + `_fragments.json` resolve to the EXACT committed
   v1 (promptTemplate, skills, boundaries, modelTier, fileDomain … deep-equal). This pins that the migration is byte-identical.
6. **Zero t3 impact** — the module is UNWIRED; `RoleCatalog {floor, fileDomain}` is derived the same for a v2 role, so
   `task-translate` and every digest are untouched. `roleProfileV2Enabled` (SWARM_ROLEPROFILE_V2) default OFF.

## Boundaries / non-goals

Resolver is pure + UNWIRED (the live spawn/launcher still reads v1; wiring it is the dormant flip). The runtime-file migration
(swapping the 3 `~/.agenthop/swarm/roles/*.json` to v2 + writing `_fragments.json`) is a separate deployment step gated by the
flag; the committed golden shows the pattern for pure-layer-impl (io-impl / adversarial-review follow identically; adversarial-review
then gains `flavors: {strict, lenient}`). NOT in scope: budget-pool fragment (立项②), force_handoff (立项④), any RoleCatalog/t3 change.

## Round-1 fixes (0P1/3P2/0P3 @0edbcc4 → this SHA) — same family as the ruling-ledger r2 counterexamples, same recipe

- **RP-P2-1** (object patch bypassed recursion): `mergeRolePatch` now ALWAYS recurses into an object patch value, treating a
  missing/non-object target as `{}`, so nested null-delete / `key+`/`key-` sigils / forbidden-key / double-touch checks apply at
  every depth. `{}` + `{branch:{drop:null,"items+":["a"]}}` ⇒ `{branch:{items:["a"]}}`; a nested `__proto__` rejects.
- **RP-P2-2** (inherited reads + getter TOCTOU): every field is read with `ownVal` (`Object.getOwnPropertyDescriptor(...).value`
  — own data only, never the prototype, never invoking an accessor) and CAPTURED ONCE for both validation and output. An
  all-inherited role rejects; a getter field is absent ⇒ reject; an inherited `modelTier.floor` does not satisfy a v2 role.
- **RP-P2-3** (input methods on arrays): `strArrayCopy` validates + copies by index (no `.every`/spread), rejecting a sparse hole
  or a hijacked `every`; `mergeRolePatch` remove builds a `Set` and filters by index (never `val.includes`/`cur.filter`), so a
  hijacked `includes` can't delete a whole array.

## Round-2 residuals (RP-P2-1 CLOSED; 2 residual P2 @8856d88 → this SHA)

- **RP-P2-2 residual** (accessor patch key): an accessor/getter patch key had no `value`, which `ownVal` turned into `undefined`
  and then wrote — silently clearing a field (a flavor declaring only a `boundaries` getter cleared boundaries with the getter
  never invoked). `mergeRolePatch` now reads the patch key's descriptor and REJECTS any key that is not an own DATA property.
- **RP-P2-3 residual** (remove double-read): the remove loop read `cur[i]` twice (membership test, then output), so a getter
  element returning keep-then-remove wrote the removed value back. Each element is now captured ONCE and used for both.

## Verification already run

role-profile.test.ts 28/28 (real-role golden + RP-P2 round-1 + round-2 regressions) · reviewer probes
`profile-boundaries.test.ts` 11/11 + `patch-capture.test.ts` 4/4 (15/15, was 13/15) · bus tsc 0 · scripts tsc 0 · full bus 87
files / 1175 tests pass. Not pushed, not merged (merge/enable gate = coordinator + user).
