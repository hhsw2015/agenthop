# Architecture-integrity review sheet — feat/arch-integrity-review

- **Branch** `feat/arch-integrity-review`  **HEAD** `HEAD`  **Base** `c46ac1a`
- **Reviewer** codex 01a0ead5 (cross-family, independent)  **Author/tooling** bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
50 commit(s), 33 changed file(s), `c46ac1a..HEAD`.

```
44927e5 Merge branch 'feat/flag-wiring' (batch-8, adversarially signed 0 REMAIN)
f324a33 Merge branch 'feat/gauge-sampling' (batch-8, adversarially signed 0 REMAIN)
aec2dcb Merge branch 'feat/console-canvas' (batch-8, adversarially signed 0 REMAIN)
ba97b53 Merge branch 'feat/f44-content-filter' (batch-8, adversarially signed 0 REMAIN)
1e72911 Merge branch 'feat/tg-bridge' (batch-8, adversarially signed 0 REMAIN)
0b6138f Merge branch 'feat/spend-breaker' (batch-8, adversarially signed 0 REMAIN)
7e9c0ae Merge branch 'feat/shared-budget' (batch-8, adversarially signed 0 REMAIN)
d575342 fix(swarm): flag-wiring review r5 — close SU1 at the candidate-probe layer (last REMAIN)
a2f0110 fix(swarm): flag-wiring review r4 — close SU1/SU3/SP3 (SU2 signed); tri-state probe, gen-guarded binding, exact /proc argv
6918003 fix(swarm): FC-4 r2 — selftest reads card by taskRef not timestamp (SBK-R2-P2-1) + fallback comment (SBK-R2-N1)
c5c60be fix(swarm): FC-4 review fixes — S19 token-dimension card (SBK-P2-1) + soft-cap comments (SBK-N1)
17dea79 feat(swarm): FC-4 spend circuit-breaker (dormant) — per-task-ticket spend cap on shared-budget
078f661 fix(swarm): flag-wiring review r3 — SU1/SU2/SU3/SP3 via the verified holder-lock + gate/boundary fixes
49901da fix(swarm): flag-wiring review r2 — SU1/SU2/SU3/SP3 (the 4 REMAIN)
cabbe60 feat(swarm): T5-2 gauge timed sampling wiring (dormant)
9ea7b2c docs(tg-entry): user bring-up guide for the Telegram bridge (v1)
15a5414 fix(swarm): flag-wiring review r1 part 2/2 — SU2 single-winner occupancy + CE1-4 notify
2cacfbb fix(swarm-viz): console-canvas v1 review fixes — 5 P2 (happycapy c259f5f)
8769476 feat(swarm-viz): console canvas view v1 — unified system-derived task graph
d203f9b docs(tg-entry): mark review CLEARED (r8, 0 REMAIN)
c2b93bf fix(swarm): F44-⑩ r2 — content-filter hint annotates, never replaces approval
8e51cd3 docs(tg-entry): review packet round-8 (legacy-import lifecycle closed)
6ba107c fix(tg-entry): r8 — legacy import is unconditional (no false orphan post-seal; rejected-claim imported)
5badac4 feat(swarm): F44-⑩ content-filter blocked classification
a1eb25e docs(tg-entry): review packet round-7 (publish-type slots + legacy import)
bd0656e fix(tg-entry): r7 — slots carry publish TYPE (snapshot replaces / tap merges) + legacy baseline import
8898b36 docs(tg-entry): review packet round-6 (slot ledger; ctime withdrawn)
96a1adb fix(tg-entry): r6 — append-only immutable slot ledger for a durable, version-bound publish order
bf54003 fix(swarm): flag-wiring review r1 part 1/2 — SP1/SP2/SP3 + SU1 + SU3 + single-completion pivot
ddb8cda fix(swarm): DA2-R6b — reclaim external holder only on definite ESRCH (SB1 boundary)
0cc6ca7 docs(tg-entry): review packet round-5 (2 REMAIN resolved; ctime vs in-content-seq rationale)
6f80b89 fix(tg-entry): r5 — order by PUBLISH ctime (not temp mtime), same-version binding, propagate order-read errors
1aedd1b fix(swarm): DA2-R6 — extract decision-batch lock to shared holder-lock; SB1 release-path fixed
d180dd3 feat(swarm): SWARM_SUCCESSION (a) — credential from the AGENT's own argv via ps on the host pid
2a0a707 feat(swarm): wire the two "signed but not powered" flags (SWARM_SUCCESSION + SWARM_COORD_ESCALATE)
2206e02 docs(tg-entry): review packet round-4 (3 REMAIN resolved)
2a56429 fix(tg-entry): r4 — write-order fold, lossless tap key, canonical consumed record
93eb946 docs(tg-entry): review packet round-3 (4 REMAIN resolved)
ccabe66 fix(tg-entry): r3 — per-item taps (no lost sibling), unique callback ref, read-fail retains retry, write-boundary scope
439068f fix(swarm): DA2-R4 — SB1 publish-failure credential registration
74511bc fix(swarm): DA2-R3 rework — SB3 (settled-flag model) + SB1 + N2
4a4eb9c docs(swarm): TG user-entry review packet round-2 (TG-P1-1..P2-4 resolved; P2-5 phasing asked)
f34ca77 fix(swarm): TG user-entry round-2 — scope enforcement, atomic merge, compact callback, safe parse, honest offset/notify (TG-P1-1..P2-4)
a380707 fix(swarm): DA2-R2 rework — SB3 remains-P1 + SB1/SB2/SB4 P2 (shared-budget)
46d9817 docs(swarm): TG user-entry v1 review packet (round 1)
7c6dff0 feat(swarm): TG user-entry v1 — pure render/parse + scope ladder & digest in CORE + thin driver
d25b56f fix(swarm): DA2-R1 rework — SB1-SB5 + N1 (shared-budget)
dc76d57 docs(swarm): TG entry design — add multimodal delivery surface (entry-side rendering)
6dc0fac docs(swarm): TG entry design — user-entry layer (peer to console), read-projection + write-receipt
3b6d828 feat(swarm): shared-budget pool (DA2) — named ceiling, many consumers
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
| `packages/bus/src/core.ts` | bus | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `packages/bus/src/mcp.ts` | bus | `packages/bus/src/core.ts` | bus |
| `packages/bus/src/presence.ts` | bus | `packages/bus/src/core.ts` | bus |
| `packages/bus/src/presence.ts` | bus | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `packages/bus/src/presence.ts` | bus | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `packages/bus/src/swarm/decision-batch-store.ts` | bus | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `packages/bus/src/swarm/decision-batch-store.ts` | bus | `packages/bus/src/swarm/decision-batch.ts` | bus |
| `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus | `packages/bus/src/swarm/decision-batch-store.ts` | bus |
| `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus | `packages/bus/src/swarm/decision-batch.ts` | bus |
| `packages/bus/src/swarm/shared-budget-store.ts` | bus | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `packages/bus/src/swarm/shared-budget-store.ts` | bus | `packages/bus/src/swarm/shared-budget.ts` | bus |
| `packages/bus/src/swarm/shared-budget.selftest.mts` | test | `packages/bus/src/swarm/shared-budget.ts` | bus |
| `packages/bus/src/swarm/shared-budget.selftest.mts` | test | `packages/bus/src/swarm/shared-budget-store.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `packages/bus/src/swarm/shell-succession.ts` | bus | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `packages/bus/src/swarm/shell-succession.ts` | bus | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `packages/bus/src/swarm/spend-breaker-store.ts` | bus | `packages/bus/src/swarm/shared-budget-store.ts` | bus |
| `packages/bus/src/swarm/spend-breaker-store.ts` | bus | `packages/bus/src/swarm/spend-breaker.ts` | bus |
| `packages/bus/src/swarm/spend-breaker-store.ts` | bus | `packages/bus/src/swarm/shared-budget.ts` | bus |
| `packages/bus/src/swarm/spend-breaker.selftest.mts` | test | `packages/bus/src/swarm/spend-breaker.ts` | bus |
| `packages/bus/src/swarm/spend-breaker.selftest.mts` | test | `packages/bus/src/swarm/spend-breaker-store.ts` | bus |
| `packages/bus/src/swarm/spend-breaker.selftest.mts` | test | `packages/bus/src/swarm/shared-budget.ts` | bus |
| `packages/bus/src/swarm/spend-breaker.ts` | bus | `packages/bus/src/swarm/shared-budget.ts` | bus |
| `packages/bus/src/swarm/tg-entry.selftest.mts` | test | `packages/bus/src/swarm/tg-entry.ts` | bus |
| `packages/bus/src/swarm/tg-entry.selftest.mts` | test | `packages/bus/src/swarm/decision-batch.ts` | bus |
| `packages/bus/src/swarm/tg-entry.selftest.mts` | test | `packages/bus/src/swarm/morning-digest.ts` | bus |
| `packages/bus/src/swarm/tg-entry.ts` | bus | `packages/bus/src/swarm/decision-batch.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/task-liveness.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/sentinel-denoise.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus |
| `scripts/swarm-tg-entry.ts` | script | `packages/bus/src/swarm/tg-entry.ts` | bus |
| `scripts/swarm-tg-entry.ts` | script | `packages/bus/src/swarm/decision-batch-store.ts` | bus |
| `scripts/swarm-tg-entry.ts` | script | `packages/bus/src/swarm/decision-batch.ts` | bus |
| `scripts/swarm-viz-export.ts` | script | `packages/bus/src/core.ts` | bus |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
- **pure-imports-io** — packages/bus/src/core.ts (pure) imports packages/bus/src/swarm/task-liveness.ts (IO-tainted)
- **pure-imports-io** — packages/bus/src/swarm/spend-breaker-store.ts (pure) imports packages/bus/src/swarm/shared-budget-store.ts (IO-tainted)

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
