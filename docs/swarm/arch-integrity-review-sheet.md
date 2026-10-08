# Architecture-integrity review sheet — feat/arch-integrity-review

- **Branch** `feat/arch-integrity-review`  **HEAD** `009a0a9`  **Base** `c3439cd`
- **Reviewer** codex 01a0ead5 (cross-family, independent)  **Author/tooling** bus-pen d7f6c917
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
5 commit(s), 6 changed file(s), `c3439cd..009a0a9`.

```
009a0a9 fix(swarm): arch-review round-3 — AR2/AR3/AR5 residuals
62c3969 docs(swarm): arch-review round-2 — regenerated sheet + packet AR1-AR5 resolution
bb06060 fix(swarm): arch-review round-2 — AR1-AR5 (read git objects, lexical imports, IO roots, real-file resolution)
e80c046 docs(swarm): arch-integrity review sheet (dogfood template) + review packet
8a3acce feat(swarm): architecture-integrity review tooling (P1③/R22, S14 T5-3)
```

## Contract surface (hashed — compare against the prior verdict to see drift)
| path | category | sha256 |
| --- | --- | --- |
| `docs/swarm/cluster-liveness-design.md` | spec-doc | `74c9f776cf4a0615…` |
| `docs/swarm/projection-schema.md` | spec-doc | `4fa065224caf51be…` |
| `docs/swarm/team-collab-design.md` | spec-doc | `cb7cb40a481eae17…` |
| `packages/bus/src/inbox.ts` | shared-type | `b40c16a21cc993f3…` |
| `packages/bus/src/swarm/task-plan.ts` | shared-type | `1001a6b421f1a332…` |
| `packages/bus/src/swarm/control-log.ts` | shared-type | `bd89bdf0a05767e3…` |
| `CLAUDE.md` | invariant-doc | `3d255bb7724bb892…` |

## Import map (who-imports-whom, batch files only)
| from | zone | to | zone |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/arch-review.integration.selftest.mts` | test | `packages/bus/src/swarm/arch-review.ts` | bus |
| `packages/bus/src/swarm/arch-review.selftest.mts` | test | `packages/bus/src/swarm/arch-review.ts` | bus |
| `scripts/swarm-arch-review.ts` | script | `packages/bus/src/swarm/arch-review.ts` | bus |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
_(none auto-detected; the reviewer still judges the axes below)_

## C11 — done bound to SHA evidence
| node | ok | reason |
| --- | --- | --- |
| arch-review-tooling | yes | bound to 009a0a9 |

## Axis verdicts (reviewer fills; REMAIN blocks the batch)
### Module boundary drift
- _Probe:_ IO in a pure module; a script reaching into bus internals; a pure->IO import
- **Verdict:** _(PASS | REMAIN — with the finding and its evidence)_

### Duplicate implementation
- _Probe:_ one concern solved twice (two board parsers; two liveness paths) — name convergence candidates
- **Verdict:** _(PASS | REMAIN — with the finding and its evidence)_

### Contract conflict
- _Probe:_ two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec)
- **Verdict:** _(PASS | REMAIN — with the finding and its evidence)_

### Dependency direction
- _Probe:_ import cycles or wrong-direction edges (bus->scripts, pure->IO) — the key graph invariant
- **Verdict:** _(PASS | REMAIN — with the finding and its evidence)_

### Gate / invariant consistency
- _Probe:_ each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments
- **Verdict:** _(PASS | REMAIN — with the finding and its evidence)_

### Done bound to SHA evidence (32-eval C11)
- _Probe:_ every `done` declaration in the batch is bound to a commit SHA; a self-reported done with no SHA is REMAIN
- **Verdict:** _(PASS | REMAIN — with the finding and its evidence)_

## REMAIN (open, blocking)
_(reviewer: list every REMAIN finding; the batch does not merge while any REMAIN stands)_
