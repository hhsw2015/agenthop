# Review packet — architecture-integrity review TOOLING (P1③ / R22, S14 T5-3)

- **Branch** `feat/arch-integrity-review`  **HEAD** `8a3acce`  **Base** `c3439cd`
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

## Files + tests
| Module | ~lines | Tests | Purpose |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/arch-review.ts` | ~300 | 48 selftest cases | pure core (zone/import/edge/flag/C11/manifest/render) + thin git/fs/crypto IO |
| `packages/bus/src/swarm/arch-review.selftest.mts` | ~120 | self | the 48 cases; run via `npx tsx` |
| `scripts/swarm-arch-review.ts` | ~45 | live | driver CLI: collect pack, write sheet, print candidate flags |
| `docs/swarm/arch-integrity-review-sheet.md` | generated | n/a | the rendered sheet, dogfooded on THIS batch as the template sample |

## Gates
- bus tsc 0; scripts tsc 0; arch-review selftest 48/48 green; bus vitest 991/991 (unchanged — additive files); the generated sheet is stcn100 deterministic-clean.

## Counterexamples the selftest locks
- A named import `import { a } from "./x.js"` is extracted (the first regex excluded `{}` and missed it — now fixed and pinned).
- A commented-out or block-commented `import` is NOT counted as an edge; a `://` in a line comment is not eaten as code.
- An edge whose target is outside the batch set is ABSENT (never fabricated as a pass).
- `script -> bus` and `test -> bus` raise NO flag (allowed direction); `pure -> IO`, `bus -> script`, and an `a <-> b` cycle each DO flag.
- C11: a missing / blank / non-hex SHA is `ok:false` (REMAIN); a valid 7-40 hex SHA is `ok:true`.

## First real use
The upcoming six-item merge batch: run `scripts/swarm-arch-review.ts --base <pre-batch> --head <batch-head> --done <node:sha,...>`, hand the sheet to the codex seat for the per-axis verdict; any REMAIN blocks that batch.
