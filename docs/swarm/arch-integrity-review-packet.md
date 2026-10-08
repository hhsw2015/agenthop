# Review packet — architecture-integrity review TOOLING (P1③ / R22, S14 T5-3)

- **Branch** `feat/arch-integrity-review`  **HEAD** `009a0a9`  **Base** `c3439cd`  (round-1 `e80c046`, round-2 `bb06060`)
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + `docs/research/orchestrators-32-eval.md` C11

## What this is
The TOOLING for the cross-cutting architecture-integrity review the design approved: it packages a batch's review INPUTS for an independent cross-family reviewer and renders the S19-style sheet that reviewer fills. It does NOT perform the review and it NEVER pronounces a verdict. A candidate flag is evidence; the reviewer judges.

The inputs it collects: the diff set (commits + changed files, `base..head`); the contract surface, hashed (so a shared-entity shape change is visible against a prior verdict); a who-imports-whom import map over the batch's changed source files, with candidate boundary flags; and the 32-eval C11 check that every `done` declaration binds a commit SHA.

## Boundaries (what this batch does NOT do)
1. No behavior change to anything existing. It ADDS three files; it modifies no module, no gate, no dispatch path. Nothing imports the new code yet except its own selftest and driver.
2. The tool never pronounces a verdict. `flagBoundaries` emits CANDIDATES only; `renderReviewSheet` leaves every axis verdict empty for the reviewer; REMAIN is the reviewer's word.
3. No merge/push/deploy. doneLine = tooling + template + selftest + send-to-review + S26. Merge is the coordinator's per the existing gates.
4. The import map is built from the batch's changed files ALONE. An edge to a file outside the batch is ABSENT, never a pass — the reviewer still holds the full tree.

## Design decisions
- Pure core + thin IO, the `herdr.ts` idiom: classification/extraction/rendering is pure and selftested; the git/fs/crypto wrappers are exercised by live runs. The pure half imports no node builtin — the same boundary the tool itself checks for.
- Flags, not findings: `pure-imports-io` (a bus module that imports no IO builtin importing one that does), `bus-imports-script` (wrong-direction edge), `import-cycle` (DFS back-edge). Each is a candidate the reviewer confirms.
- Contract surface is HASHED (sha256), not inlined, so the sheet is small and drift is a one-line diff of the manifest against the prior verdict.
- The sheet is deterministic (no clock, no randomness) so a re-run on the same SHAs is byte-identical.

## Round 2 — round-1 REMAIN (1P1 + 4P2) all resolved
- **AR1 (P1) — read a FIXED SHA, not the working tree.** `collectArchReviewPack` now reads every file's content via `gitShow` = `git show <head>:<path>`. The pack is a function of the SHA: a dirty tree or a different checkout cannot change it. Locked by the integration selftest (a working-tree `node:fs` import added after head does NOT surface).
- **AR2 (P2) — missing/unreadable != empty.** `gitShow` returns `null` on absence; the manifest row carries `sha256: null` rendered `(unavailable)`, and `unavailableContracts` lists it. A committed empty file still hashes to `e3b0c442…`. Both pinned.
- **AR3 (P2) — lexical import extraction.** The regex is gone; `extractImports` delegates to `ts.preProcessFile`. A string-literal/commented `import` is ignored; bare/no-semicolon, dynamic-with-options, and `require` are kept; `preimport()` is not matched.
- **AR4 (P2) — IO builtin roots.** Taint matches the builtin ROOT (`ioRootOf`), covering `dns/promises`, `readline/promises`, `http2`, and every `/promises` submodule; `path` stays pure.
- **AR5 (P2) — real batch files.** Git paths come from `-z` + `core.quotepath=false` (non-ASCII safe); `.mjs/.cjs/.js` are collected; `resolveInSet` matches the REAL file, so a `.mjs` resolves to itself (swaps are added, never forced) and a `scripts/hook.mjs` bus-import flags.

## Round 3 — round-2 REMAIN (3P2) all resolved (AR1, AR4 already CLOSED)
- **AR2 (P2) — a git tree object no longer impersonates a file.** `gitShow` now runs `git cat-file -t <rev>:<path>` and returns `null` unless the object is a `blob`. A directory yields `(unavailable)` + `unavailableContracts`; a committed empty file still hashes. New integration case: a directory contract path.
- **AR3 (P2) — regex literals no longer fabricate imports.** `extractImports` PARSES (`ts.createSourceFile` + AST walk) instead of the preprocessor. `/import "node:fs"/` yields no dep; divide-vs-regex is handled. Static / export-from / `import x = require()` / `require()` / literal dynamic `import()` are kept; a template dynamic import is omitted.
- **AR5 (P2) — candidates no longer fabricate in-batch deps.** `candidatePaths` maps an EXPLICIT extension only to compatible sources (`.mjs`->`.mjs`/`.mts`, never `.ts` or an index); index candidates are only for extensionless specifiers. `normalizeSpecifier` returns `null` when a `..` climbs above the repo root, so an out-of-repo path never folds back inside.

## Files + tests
| Module | ~lines | Tests | Purpose |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/arch-review.ts` | ~350 | 71 + 7 | pure core (zone/import/edge/flag/C11/manifest/render) + thin git/crypto IO |
| `packages/bus/src/swarm/arch-review.selftest.mts` | ~200 | 71 | pure cases; run via `npx tsx` |
| `packages/bus/src/swarm/arch-review.integration.selftest.mts` | ~75 | 7 | AR1/AR2 against a throwaway git repo (git-object vs working-tree, blob vs tree) |
| `scripts/swarm-arch-review.ts` | ~45 | live | driver CLI: collect pack, write sheet, print candidate flags |
| `docs/swarm/arch-integrity-review-sheet.md` | generated | n/a | the rendered sheet, dogfooded on THIS batch as the template sample |

## Gates
- bus tsc 0; scripts tsc 0; pure selftest 71/71; integration selftest 7/7; bus vitest 991/991 (unchanged — additive files); the generated sheet is stcn100 deterministic-clean.

## Counterexamples the selftests lock
- Import extraction is AST-parsed: a regex literal `/import "x"/`, a string-literal import, or a commented `import` is NOT an edge; `preimport()` is not matched; bare/no-semicolon, dynamic-with-options, `import x = require()`, and `require` ARE captured; a template dynamic import is omitted.
- Content is read from the HEAD git object, never the working tree (AR1); a path absent at head is `(unavailable)`, not an empty-file hash (AR2); a directory/tree object is `(unavailable)`, not a hashed listing (AR2); a real empty file hashes normally.
- An edge whose target is outside the batch set is ABSENT; a `.mjs` resolves to itself not a forced `.mts`; an out-of-batch `.mjs` does NOT mis-map to an in-batch `.ts`/index; a `..` above the repo root resolves to null, never folded back (AR5).
- `script -> bus` and `test -> bus` raise NO flag (allowed direction); `pure -> IO`, `bus -> script` (incl. a `.mjs` script), and an `a <-> b` cycle each DO flag.
- IO taint covers `dns/promises`, `readline/promises`, `http2` (AR4); `path` stays pure.
- C11: a missing / blank / non-hex SHA is `ok:false` (REMAIN); a valid 7-40 hex SHA is `ok:true`.

## First real use
The upcoming six-item merge batch: run `scripts/swarm-arch-review.ts --base <pre-batch> --head <batch-head> --done <node:sha,...>`, hand the sheet to the codex seat for the per-axis verdict; any REMAIN blocks that batch.
