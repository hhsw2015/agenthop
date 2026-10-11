# Architecture-integrity review sheet — rehearse-batch-11

- **Branch** `rehearse-batch-11`  **HEAD** `HEAD`  **Base** `8b1892c`
- **Reviewer** fe0376cd (cross-family, independent)  **Author/tooling** bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
22 commit(s), 21 changed file(s), `8b1892c..HEAD`.

```
7b8e87c Merge branch 'feat/inbox-wake' into rehearse-batch-11
e00498f Merge branch 'feat/failure-taxonomy' into rehearse-batch-11
32f959d Merge branch 'feat/placement-ledger' into rehearse-batch-11
20353df Merge branch 'feat/attribution-chain' into rehearse-batch-11
0acaa0b Merge branch 'feat/redact-secrets' into rehearse-batch-11
713d7be fix(inbox-wake): r10 — genesis sentinel gates the epoch, closing the bootstrap ABA (IW-P2-1)
57215cb fix(inbox-wake): r9 — single head advanced by rename-CAS closes the ABA (IW-P2-1)
04783ed fix(inbox-wake): r8 — replace stealable gate with a generation chain (IW-P2-1)
f4ee1e9 fix(inbox-wake): r7 — unify admit+occupy on one global gate; effTs fail-closed
02beeca fix(swarm): inbox-wake r6 — global-timestamp authority + fail-closed recognition/GC (close IW-P2-1 regression + IW-R5-P2-1)
a881b87 fix(swarm): inbox-wake r5 — interval-family-scoped window markers (close IW-R4-P2-1 cooldown-param drift)
9c38d2e fix(bus): keep checkin note in JSON field + title, text stays one parseable line (FT-1)
77ff4bb fix(swarm): inbox-wake r4 — high-water IS the O_EXCL marker set, no mutable hw file (close IW-P2-1 three holes)
0ce4800 fix(swarm): inbox-wake r3 — monotonic high-water stale-window gate (close IW-P2-1 cleanup-reopen)
1dc52df feat(swarm): failure taxonomy hint for the sentinel + optional checkin note (D-multica ①③)
b7a4e6a fix(swarm): inbox-wake r2 — install in library-init path + cross-process claim-before-send + backstop resolveSession (close IW-P1-1/P2-1/P2-2)
b9a4ec9 feat(swarm): placement ledger seam → real read (vm-ssh meta store, full phase+legacy+lifetime mirror, async)
6eeefbf fix(swarm): attribution-chain r2 — validate the ledger attribution pair on read (AC-1)
0327cb5 fix(bus): redact full text before clipping + widen AWS/Slack rule forms (RS-1, RS-2)
2c5f904 feat(swarm): inbox real-time wake baked into the delivery primitive (SWARM_INBOX_WAKE)
cf8b6d1 feat(swarm): attribution-chain (dormant) — explainable accountable-human waterfall
cfefb30 feat(bus): secret-redaction pure leaf + wire into transport sanitize (D-multica ②)
```

## Contract surface (hashed — compare against the prior verdict to see drift)
| path | category | sha256 |
| --- | --- | --- |
| `docs/swarm/cluster-liveness-design.md` | spec-doc | `74c9f776cf4a0615…` |
| `docs/swarm/projection-schema.md` | spec-doc | `4fa065224caf51be…` |
| `docs/swarm/team-collab-design.md` | spec-doc | `cb7cb40a481eae17…` |
| `packages/bus/src/inbox.ts` | shared-type | `6fc0041963ef8e5f…` |
| `packages/bus/src/swarm/task-plan.ts` | shared-type | `1001a6b421f1a332…` |
| `packages/bus/src/swarm/control-log.ts` | shared-type | `bd89bdf0a05767e3…` |
| `CLAUDE.md` | invariant-doc | `3d255bb7724bb892…` |

## Import map (who-imports-whom, batch files only)
| from | zone | to | zone |
| --- | --- | --- | --- |
| `packages/bus/src/checkin.ts` | bus | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/core.ts` | bus | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/core.ts` | bus | `packages/bus/src/swarm/inbox-wake.ts` | bus |
| `packages/bus/src/core.ts` | bus | `packages/bus/src/checkin.ts` | bus |
| `packages/bus/src/inbox.ts` | bus | `packages/bus/src/redact.ts` | bus |
| `packages/bus/src/swarm/attribution.selftest.mts` | test | `packages/bus/src/swarm/attribution.ts` | bus |
| `packages/bus/src/swarm/attribution.selftest.mts` | test | `packages/bus/src/tasklog.ts` | bus |
| `packages/bus/src/swarm/inbox-wake.selftest.mts` | test | `packages/bus/src/swarm/inbox-wake.ts` | bus |
| `packages/bus/src/swarm/inbox-wake.selftest.mts` | test | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/swarm/inbox-wake.ts` | bus | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/swarm/inbox-wake.ts` | bus | `packages/bus/src/swarm/herdr.ts` | bus |
| `packages/bus/src/swarm/placement-engine.selftest.mts` | test | `packages/bus/src/swarm/placement-engine.ts` | bus |
| `packages/bus/src/tasklog.ts` | bus | `packages/bus/src/swarm/attribution.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/inbox.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/herdr.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/sentinel-denoise.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/placement-engine.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/inbox-wake.ts` | bus |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
- **pure-imports-io** — packages/bus/src/checkin.ts (pure) imports packages/bus/src/inbox.ts (IO-tainted)
- **pure-imports-io** — packages/bus/src/core.ts (pure) imports packages/bus/src/inbox.ts (IO-tainted)
- **pure-imports-io** — packages/bus/src/core.ts (pure) imports packages/bus/src/swarm/inbox-wake.ts (IO-tainted)

## C11 — done bound to SHA evidence
_(no done claims supplied; reviewer lists the batch's done declarations and confirms each binds a SHA)_

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
