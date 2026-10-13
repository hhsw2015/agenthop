# Architecture-integrity review sheet — rehearse-batch-19

- **Branch** `rehearse-batch-19`  **HEAD** `dec7dba87338518ca0dac57c3af840cfb19e4a60`  **Base** `55161bf4f013e81f9703e0a335e8bc266cfe8743`
- **Reviewer** codex:Work-01a1208e (cross-family, independent; primary seat)  **Author/tooling** coordinator fe0376cd / bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
25 commit(s), 26 changed file(s), `55161bf..dec7dba`.

```
dec7dba Merge branch 'fix/disp1-control-load-failsoft' into rehearse-batch-19
a751e97 Merge branch 'feat/gstack-role-fragments' into rehearse-batch-19
1ba5aee Merge branch 'feat/infra-p2-proj-tg' into rehearse-batch-19
b7d5850 Merge branch 'feat/model-staffing' into rehearse-batch-19
b649246 Merge branch 'feat/selftest-ci' into rehearse-batch-19
8f4d996 docs(swarm): DISP-1 DISP1-XN1 — runRenewThenSweep comment covers commit-fail/reject path
3385da6 fix: gstack roleFragments batch-2 r2 — staff-reviewer boundary + HAVE/in-flight honesty (happycapy GRF-B2-P2-1/P2-2/N1)
35906ed fix(swarm): DISP-1 r4 — codex:Work r3 (renewal pass is INCOMPLETE when an eligible wait's commit does not persist)
8776e7b fix: gstack roleFragments batch-1 r2 — release/doc boundary + source pins (happycapy GRF-P2-1/P2-2/N1/N2)
fe449ee fix(swarm): infra P2 r3 — IP2-5 comment correction (unknown HOLDS, not regenerate/re-notify)
8a284d6 fix(selftest-ci): run-selftests r4 — happycapy r3 (STCI-R2-P3-1: arrival-order failure tail)
b5876ca fix(swarm): model-staffing r3 — MS-P2-6 config-form validation + MS-R2-N1 comments
5c59c74 fix(swarm): DISP-1 r3 — codex:Work r2 (atomic renew gate + observer call split + real-store tests + test tsc)
1acdf64 feat: roleProfile v2 roleFragments — gstack absorption① candidate batch (#6-23)
5909a7a fix(swarm): infra P2 r2 — all 4 codex:Work findings (IP2-1..IP2-4)
0b3051a feat: roleProfile v2 roleFragments — gstack absorption① prime batch (5 roles)
236e3f2 fix(selftest-ci): run-selftests r3 — happycapy r2 (P2-2 close-time group-kill + R2-P2-1 shard-leak + R2-P3-1 real tail)
52a15e6 fix(swarm): model-staffing r2 — all 8 happycapy findings (MS-P2-1..7 + P3-1)
8c70e99 fix(swarm): DISP-1 r2 — group sweep by real control-dependency + renew fail-soft + tick orchestration test (codex:Work)
4945fac fix(swarm): infra audit P2 batch — projection + TG symlink/FC-2 hardening
6bba1a6 fix(ci): selftest runner — fail loud on discovery faults + force-kill on timeout (happycapy review)
2014be5 fix(swarm): DISP-1 — dispatcher control-load is fail-soft + escalates (P1, infra audit)
e00ec6a feat(swarm): model-staffing (模型人才市场) — §5 three pieces live (FROZEN brief @85ce081, 6 rulings)
53194e1 ci(swarm): gate the 47 *.selftest.mts in CI (zero-bug project #0)
85ce081 docs(swarm): model-staffing (模型人才市场) design brief — freeze candidate
```

## Contract surface (hashed — compare against the prior verdict to see drift)
| path | category | sha256 |
| --- | --- | --- |
| `docs/swarm/cluster-liveness-design.md` | spec-doc | `74c9f776cf4a0615…` |
| `docs/swarm/projection-schema.md` | spec-doc | `4fa065224caf51be…` |
| `docs/swarm/team-collab-design.md` | spec-doc | `cb7cb40a481eae17…` |
| `packages/bus/src/inbox.ts` | shared-type | `b20188312febf69a…` |
| `packages/bus/src/swarm/task-plan.ts` | shared-type | `7624dfb8346bcaf5…` |
| `packages/bus/src/swarm/control-log.ts` | shared-type | `e397d051f06f968d…` |
| `CLAUDE.md` | invariant-doc | `3d255bb7724bb892…` |

## Import map (who-imports-whom, batch files only)
| from | zone | to | zone |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/dual-bandwidth-store.selftest.mts` | test | `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus |
| `packages/bus/src/swarm/model-catalog-store.ts` | bus | `packages/bus/src/swarm/model-market.ts` | bus |
| `packages/bus/src/swarm/model-market-store.ts` | bus | `packages/bus/src/swarm/model-market.ts` | bus |
| `packages/bus/src/swarm/model-staffing-store.ts` | bus | `packages/bus/src/swarm/model-market-store.ts` | bus |
| `packages/bus/src/swarm/model-staffing-store.ts` | bus | `packages/bus/src/swarm/model-staffing.ts` | bus |
| `packages/bus/src/swarm/model-staffing.selftest.mts` | test | `packages/bus/src/swarm/model-market.ts` | bus |
| `packages/bus/src/swarm/model-staffing.selftest.mts` | test | `packages/bus/src/swarm/model-market-store.ts` | bus |
| `packages/bus/src/swarm/model-staffing.selftest.mts` | test | `packages/bus/src/swarm/model-staffing.ts` | bus |
| `packages/bus/src/swarm/model-staffing.selftest.mts` | test | `packages/bus/src/swarm/model-staffing-store.ts` | bus |
| `packages/bus/src/swarm/model-staffing.selftest.mts` | test | `packages/bus/src/swarm/model-catalog-store.ts` | bus |
| `packages/bus/src/swarm/model-staffing.ts` | bus | `packages/bus/src/swarm/model-market.ts` | bus |
| `packages/bus/src/swarm/morning-digest-store.selftest.mts` | test | `packages/bus/src/swarm/morning-digest-store.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/dispatch-loops.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/evidence-renewal.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/model-market.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/model-market-store.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/model-staffing.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/model-staffing-store.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/model-catalog-store.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/morning-digest-store.ts` | bus |
| `scripts/swarm-tg-entry.selftest.mts` | test | `scripts/swarm-tg-entry.ts` | script |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
_(none auto-detected; the reviewer still judges the axes below)_

## C11 — done bound to SHA evidence
Five signed heads: selftest-ci `8a284d6`, staffing `b5876ca`, infra P2 `fe449ee`, role library `3385da6`, DISP-1 `35906ed`. Actual DISP merge parent `8f4d996` is the independently verified comment-only child of `35906ed`. All signed heads are ancestors. 23/26 files exactly match signed owners; dispatcher union, morning-digest three-way combination, and DISP comment correction are individually verified. See `provenance-review.md` and `dispatch-review.md` in the fixed evidence packet.

## Axis verdicts (reviewer fills; REMAIN blocks the batch)
### Module boundary drift
- _Probe:_ IO in a pure module; a script reaching into bus internals; a pure->IO import
- **Verdict:** PASS — pure cores/store IO/script orchestration retained; role fragments and selftest runner do not add production imports.

### Duplicate implementation
- _Probe:_ one concern solved twice (two board parsers; two liveness paths) — name convergence candidates
- **Verdict:** PASS — one renewal implementation and gate retained; idle diagnostics have a separate unknown-state duty, not a second control authority.

### Contract conflict
- _Probe:_ two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec)
- **Verdict:** PASS — seven declared contract files byte-identical to base; digest r7 and infra CP-3 changes both survive the exact three-way composition.

### Dependency direction
- _Probe:_ import cycles or wrong-direction edges (bus->scripts, pure->IO) — the key graph invariant
- **Verdict:** PASS — all 22 sheet edges match; full runtime graph has 15 added edges, no new cycle, no bus-to-script edge, no unresolved local import.

### Gate / invariant consistency
- _Probe:_ each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments
- **Verdict:** PASS — actual corrupt/gap/EACCES ticks keep idle unknown with no false S19; detached market/staffing do not starve digest/wake. CI54/54, full bus1540/1540, three tsc0, standard artifacts verified. B19-N1 below is non-blocking content convergence.

### Done bound to SHA evidence (32-eval C11)
- _Probe:_ every `done` declaration in the batch is bound to a commit SHA; a self-reported done with no SHA is REMAIN
- **Verdict:** PASS — five signoff heads plus8f4d996 nit bound; 2477 seal entries and3606 signed-source blobs verified; current745/base730 blobs match. No expanded done claims beyond this batch.

## REMAIN (open, blocking)
None — 0 CONFIRMED / 0 REMAIN. Primary architecture axes PASS. Mandatory external peer gate is **PENDING-PEER**; not yet final batch CLEARED.

## B19-N1 — non-blocking convergence note

The inactive role catalog qa-lead/test-auditor rows and fixture `ourEquivalent` fields still describe selftests as outside CI (catalog:41/:48; fixture:140/:210). The batch now runs them in CI. These are inactive descriptive research fields, not current runtime/CI control. Role-library owner should update them to reference8a284d6 before activation. Not counted CONFIRMED/REMAIN; external peer may reopen if warranted.

## Evidence and final gate

- Fixed report: `/Users/wowdd1/Work/review-reports/batch19-architecture-review-dec7dba-01a1208e.md`
- Packet: `/Users/wowdd1/Work/review-reports/batch19-dec7dba-review-01a1208e/`
- Primary: six axes PASS, 0 P1/P2/P3, 0 CONFIRMED/REMAIN; external second voice PENDING. No merge/push/activation performed.
