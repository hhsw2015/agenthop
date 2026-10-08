# Architecture-integrity review sheet — feat/arch-integrity-review

- **Branch** `feat/arch-integrity-review`  **HEAD** `HEAD`  **Base** `5da42b5`
- **Reviewer** codex 01a0ead5 (cross-family, independent)  **Author/tooling** bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
23 commit(s), 32 changed file(s), `5da42b5..HEAD`.

```
8f961a5 Merge branch 'feat/sentinel-denoise' (batch-4, adversarially signed 0 REMAIN)
b54b79e Merge branch 'feat/herdr-args-fix' (batch-4, adversarially signed 0 REMAIN)
e7040d8 Merge branch 'feat/dual-bandwidth' (batch-4, adversarially signed 0 REMAIN)
aeb1792 Merge branch 'feat/vm-ctl' (batch-4, adversarially signed 0 REMAIN)
0e2eb47 fix(sentinel): F44-P1-1 round-3 — two false-refuse parser paths in isDispatcherLoopCommand
553d273 fix(sentinel): F44-P1-1 round-3 — parse the dispatcher entry as a runtime CLI, not a string search
0de55f8 fix(sentinel): address F44 review bounce (1 P1 + 3 P2 + 1 nit)
728b438 fix(swarm): F44 sentinel denoise — 6 fixes (dedup, legit-box scan, roster/in-flight split, ghost daemon, startup self-check, PROGRESS watch opt-in)
52a5feb docs(vm-ctl): record phase-1 sign-off (605712e, 0 REMAIN, codex:happycapy, 5 rounds)
605712e fix(vm-ctl): VMC-P1-1 round-5 — ready text requires an exact anchored success format
51ac192 fix(vm-ctl): VMC-P1-1 round-4 — valid JSON judged structurally only, no text fall-through
b0e9530 fix(vm-ctl): VMC-P1-1 + P2-2 round-3 (generic negation guard + structured flag; sparse-table rejection)
0d54e3f fix(vm-ctl): VMC-P1-1..P2-2 round-2 (ready negation, cred 0600-before-write, url quoting, backoff validation)
469b939 feat(vm-ctl): phase-1 backend-agnostic machine-management command family (pure core)
41ef927 fix(swarm): T5-2 round-3 — close T52-P2-5 (required thresholds in reader; overflow-safe derived values)
fc44e94 fix(swarm): T5-2 round-2 — close 5 P2 (collect read-faults, consume binding, in-flight backlog, future skew, projection guards)
694caf8 feat(swarm): T5-2 dual-bandwidth gauge — pure core + IO + frozen projection contract
0d11607 docs(herdr): ③ follow-up rollout roster ledger (read-only tracking)
e10d84d docs(herdr): close HARGS-P2-3 residual — drop unsupported explain-by-name attribution + fix LIVE labels
6d52b21 docs(herdr): close HARGS-P2-1 + P2-3 — narrow ① attribution, fix artifact citations, add live acceptance
56df578 docs(herdr): evidence-boundary correction (reviewer) — raw vs observed vs not-captured
baf0159 fix(herdr): ① argv regression guard + ③ status update (user-applied launcher fix)
be02cc7 docs(herdr): ③ root cause + confirmed fix (process identification via argv0) + ①② assessment
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
| `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus | `packages/bus/src/swarm/dual-bandwidth.ts` | bus |
| `packages/bus/src/swarm/inbox-sentinel.ts` | bus | `packages/bus/src/swarm/sentinel-denoise.ts` | bus |
| `packages/bus/src/swarm/vm-ctl.selftest.mts` | test | `packages/bus/src/swarm/vm-ctl.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/inbox-sentinel.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/live-sentinel.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/sentinel-denoise.ts` | bus |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
_(none auto-detected; the reviewer still judges the axes below)_

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
