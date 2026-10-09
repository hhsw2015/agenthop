# Architecture-integrity review sheet — feat/arch-integrity-review

- **Branch** `feat/arch-integrity-review`  **HEAD** `HEAD`  **Base** `ece25c2`
- **Reviewer** codex 01a0ead5 (cross-family, independent)  **Author/tooling** bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
27 commit(s), 84 changed file(s), `ece25c2..HEAD`.

```
d286fc3 Merge branch 'feat/f45-succession' (batch-7, adversarially signed 0 REMAIN)
fbbf1b8 Merge branch 'feat/ruling-backfill' (batch-7, adversarially signed 0 REMAIN)
2721024 Merge branch 'feat/f44-blocked-path' (batch-7, adversarially signed 0 REMAIN)
57be796 Merge branch 'feat/f47-codex-bus' (batch-7, adversarially signed 0 REMAIN)
916aa91 fix(swarm): F45 round-10 — per-connection error handler on the liveness socket (R9-P2-1)
e17ac6e fix(swarm): F45 round-9 — add socket identity back-verification (coordinator hint ①)
7c8546a fix(swarm): F45 round-9 — hash-prefixed per-instance liveness socket (R7-P1-2 + P2-1)
8d46250 docs(swarm): ruling-backfill nits RB-N1/RB-N2 + self-spot-check
b62c6b1 docs(swarm): backfill ruling-ledger (63 rulings R/S/F) from PROGRESS.md
d508b08 fix(swarm): F45 round-8 — safe SID path (P1-2) + listener lifecycle (R7-P2-1)
f9b716e fix(swarm): F45 round-7 — per-session liveness socket (P1-2, coordinator ruling B)
eedac7b fix(swarm): F44 round-3 — 8B clear once-mark only on DEFINITE working/idle
ec1b8a7 docs(swarm): F47-A review packet round-3 (F47-1 inbound entry + N1 nit)
7ee5ae0 fix(bus): F47-A round-3 — strict ownThread at the INBOUND identity entry too (F47-1)
03865a9 fix(swarm): F44 round-2 — 8A in-flight escalation claim, 8B confirmed-left reconcile, 9 snapshot handle→sid resolve
923b64a docs(swarm): F47-A review packet round-2 (F47-1/F47-2 resolved)
a93b890 fix(bus): F47-A round-2 — strict unique-cwd identity adoption + clear idTimer on close (F47-1/F47-2)
98cc32e fix(swarm): F45 round-6 — pid-file heartbeat freshness closes the P1-2 recycle window
bc72250 feat(swarm): F44-⑦⑧⑨ blocked-alert path fixes (pane-mapped screen read, roster-gated blocked, snapshot roster source)
8994fca fix(swarm): F45 round-5 — exact-codex resume parser (P1-1) + pid-file-writer proof (P1-2)
120ab9c docs(swarm): F47-A review packet (daemon-adopt stableId, round 1)
25f9883 fix(bus): F47-A — codex node adopts its roster stableId from the daemon at startup (restore bus identity)
c165e20 fix(swarm): F45 round-4 — tool/position-aware resume-target parser (P1-1) + env-based presence correlation (P1-2)
6c863a4 fix(swarm): F45 round-3 — structured resume-target credential (P1-1) + instance-ownership proof (P1-2)
6e53c29 docs(swarm): F47 codex bus-presence design (restart invariant + root cause + layered fix)
bf55fea fix(swarm): F45 round-2 — continuity requires an identity-binding credential; same-machine relay requires a LIVE pid (P1-1, P1-2, N1)
eed1755 feat(swarm): F45 succession protocol + coordinator-report escalation + I3 dispatch-stranding fix
```

## Contract surface (hashed — compare against the prior verdict to see drift)
| path | category | sha256 |
| --- | --- | --- |
| `docs/swarm/cluster-liveness-design.md` | spec-doc | `74c9f776cf4a0615…` |
| `docs/swarm/projection-schema.md` | spec-doc | `4fa065224caf51be…` |
| `docs/swarm/team-collab-design.md` | spec-doc | `cb7cb40a481eae17…` |
| `packages/bus/src/inbox.ts` | shared-type | `87731c8e64bdc4d9…` |
| `packages/bus/src/swarm/task-plan.ts` | shared-type | `1001a6b421f1a332…` |
| `packages/bus/src/swarm/control-log.ts` | shared-type | `bd89bdf0a05767e3…` |
| `CLAUDE.md` | invariant-doc | `3d255bb7724bb892…` |

## Import map (who-imports-whom, batch files only)
| from | zone | to | zone |
| --- | --- | --- | --- |
| `packages/bus/src/core.ts` | bus | `packages/bus/src/codex.ts` | bus |
| `packages/bus/src/core.ts` | bus | `packages/bus/src/send-fallback.ts` | bus |
| `packages/bus/src/core.ts` | bus | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `packages/bus/src/presence.ts` | bus | `packages/bus/src/core.ts` | bus |
| `packages/bus/src/presence.ts` | bus | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `packages/bus/src/swarm/coordinator-report.selftest.mts` | test | `packages/bus/src/swarm/coordinator-report.ts` | bus |
| `packages/bus/src/swarm/herdr.selftest.mts` | test | `packages/bus/src/swarm/herdr.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/herdr.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/sentinel-denoise.ts` | bus |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
- **pure-imports-io** — packages/bus/src/core.ts (pure) imports packages/bus/src/codex.ts (IO-tainted)
- **pure-imports-io** — packages/bus/src/core.ts (pure) imports packages/bus/src/swarm/task-liveness.ts (IO-tainted)

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
