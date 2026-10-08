# Architecture-integrity review sheet — feat/arch-integrity-review

- **Branch** `feat/arch-integrity-review`  **HEAD** `HEAD`  **Base** `3732f4b`
- **Reviewer** codex 01a0ead5 (cross-family, independent)  **Author/tooling** bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
23 commit(s), 20 changed file(s), `3732f4b..HEAD`.

```
5558a85 Merge branch 'feat/absorb-resume-compact' (batch-5, adversarially signed 0 REMAIN)
3c7a3d8 Merge branch 'feat/absorb-msg-dedup' (batch-5, adversarially signed 0 REMAIN)
065a845 Merge branch 'feat/absorb-schedule-jitter' (batch-5, adversarially signed 0 REMAIN)
19e9cb9 Merge branch 'feat/absorb-perm-inbound-gate' (batch-5, adversarially signed 0 REMAIN)
d9f71d4 Merge branch 'feat/absorb-viz-triage' (batch-5, adversarially signed 0 REMAIN)
414a090 Merge branch 'feat/absorb-idle-subscription' (batch-5, adversarially signed 0 REMAIN)
7c6f6cd Merge branch 'feat/grill-gate' (batch-5, adversarially signed 0 REMAIN)
6c64118 Merge branch 'feat/placement-engine' (batch-5, adversarially signed 0 REMAIN)
0475868 docs(swarm): resume-compact RC-N1 — doc distinguishes bad measurement (refuse) from bad threshold (fallback)
5cce333 fix(swarm): msg-dedup MD-P2-1/MD-P2-2 — unambiguous collision-free key; future stamp is not duplicate evidence (round-2)
4753077 fix(swarm): viz-triage VT-P2-1 — a zero/fractional summary cap no longer bypasses the limit via slice(-0) (round-2)
1116a1e fix(swarm): idle-subscription IS-P2-1 — positive TTL never floors to 0; reject a bad creation clock (round-2)
db34af0 fix(swarm): grill-gate round-1 — GG-P2-1 own-key answers, GG-P2-2 iterative depth, GG-N1 wording
90cdda2 fix(placement-engine): PE2+PE4 round-3 (dead-capacity urgent replacement, overflow + non-integer-count fail-closed)
17a6929 feat(swarm): resume-compact — gate compacting a member's history on resume (absorb #6, dormant)
a63247a feat(swarm): msg-dedup — ring dedup + queue-cap self-stop (absorb #5, dormant)
c22a934 feat(swarm): schedule-jitter — deterministic per-id fire-time offset (absorb #4, dormant)
c32f8a4 feat(swarm): grill-gate (烤问门) — pure pre-dispatch decision tree + dormant T3 seam
3fd6e15 feat(absorb): perm-inbound-gate — permission-mode-aware inbound gating (docs-sweep #3)
5c78c67 feat(absorb): viz-triage — needs-input-first ordering + cheap per-member summary (docs-sweep #2)
ab843db feat(absorb): idle-subscription — one-shot notify-when-peer-idle (docs-sweep #1)
62b1f20 fix(placement-engine): PE1-PE4 round-2 (one-action-per-machine, urgent respawn, dedup, input validation)
a1f6c83 feat(placement-engine): phase-2a K8s-controller reconcile (pure core)
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
| `packages/bus/src/swarm/idle-subscription.selftest.mts` | test | `packages/bus/src/swarm/idle-subscription.ts` | bus |
| `packages/bus/src/swarm/msg-dedup.selftest.mts` | test | `packages/bus/src/swarm/msg-dedup.ts` | bus |
| `packages/bus/src/swarm/perm-inbound-gate.selftest.mts` | test | `packages/bus/src/swarm/perm-inbound-gate.ts` | bus |
| `packages/bus/src/swarm/placement-engine.selftest.mts` | test | `packages/bus/src/swarm/placement-engine.ts` | bus |
| `packages/bus/src/swarm/resume-compact.selftest.mts` | test | `packages/bus/src/swarm/resume-compact.ts` | bus |
| `packages/bus/src/swarm/schedule-jitter.selftest.mts` | test | `packages/bus/src/swarm/schedule-jitter.ts` | bus |
| `packages/bus/src/swarm/viz-triage.selftest.mts` | test | `packages/bus/src/swarm/viz-triage.ts` | bus |

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
