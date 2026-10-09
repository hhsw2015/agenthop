# Architecture-integrity review sheet — feat/arch-integrity-review

- **Branch** `feat/arch-integrity-review`  **HEAD** `HEAD`  **Base** `bdd93d7`
- **Reviewer** codex 01a0ead5 (cross-family, independent)  **Author/tooling** bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
75 commit(s), 52 changed file(s), `bdd93d7..HEAD`.

```
269ca9d Merge branch 'feat/force-pipeline' (batch-6, adversarially signed 0 REMAIN)
f9b5bad Merge branch 'feat/boot-digest-pin' (batch-6, adversarially signed 0 REMAIN)
bc4cf11 Merge branch 'feat/roleprofile-v2' (batch-6, adversarially signed 0 REMAIN)
a5f29f6 Merge branch 'feat/submit-tag' (batch-6, adversarially signed 0 REMAIN)
c69cfd1 Merge branch 'feat/fanout-native' (batch-6, adversarially signed 0 REMAIN)
fbe5eb5 Merge branch 'feat/d4-1-boot-dedup' (batch-6, adversarially signed 0 REMAIN)
9b17c50 Merge branch 'feat/ruling-ledger' (batch-6, adversarially signed 0 REMAIN)
de4a020 Merge branch 'feat/autoscale-suggest-wiring' (batch-6, adversarially signed 0 REMAIN)
0b4f6d4 Merge branch 'feat/envelope-open' (batch-6, adversarially signed 0 REMAIN)
bd4ce45 Merge branch 'feat/board-post-supervision' (batch-6, adversarially signed 0 REMAIN)
4085d3b fix(swarm): force-pipeline round-1 — FP-P2-1 structural dedup key, FP-P2-2 index-built knownNodes
89b3116 feat(swarm): force-pipeline — declarative deterministic hand-off (DA4, design+impl)
110efc3 fix(swarm): roleProfile v2 round-2 — RP-P2-2/P2-3 residual accessor & double-read
6cfc181 fix(swarm): boot-digest-pin round-1 — BDP-P2-1 builder parity, BDP-P2-2 index walk, BDP-P2-3 own-reads
8856d88 fix(swarm): roleProfile v2 round-1 — RP-P2-1 recurse, RP-P2-2 own-reads, RP-P2-3 index arrays
61d93a8 feat(swarm): boot-digest-pin — content-addressed boot artifacts (DA3, design+impl)
0edbcc4 feat(swarm): roleProfile v2 — reusable fragments + flavor overrides (DA1 impl)
1949284 docs(swarm): roleProfile v2 design one-pager (DA1 — fragments + flavor overrides)
aeb7495 docs(swarm): fanout review packet round-12 (FN9 resolved)
11d7f17 fix(fanout): round-12 — durable `launched` marker so a started HOLD survives driver exit (FN9)
8c62f89 fix(swarm): submit-tag round-1 — ST-P2-1 fan-out intent, ST-P2-2 foldedFrom slots, ST-P2-3 fractional seconds
b2f9a9b docs(swarm): fanout review packet round-11 (FN9 resolved)
54ea582 feat(swarm): submit-tag — chat-room/inbox 呈批 as a de-duped gauge produce source
e9c2bbf fix(fanout): round-11 — isolate HELD from every lease-delete path via one shared rule (FN9)
e107aed fix(swarm): ruling-ledger round-2 — positional array validation, capture-once, lossless BigInt ordering (RL-P2-1/2/3)
17cad16 docs(swarm): submit-tag design one-pager (T5-2 secondary-source seam)
4979f53 docs(swarm): fanout review packet round-10 (FN9 resolved)
9dde6ef fix(fanout): round-10 — headless rollback releases only after confirming the child is gone (FN9)
8f5bf93 docs(swarm): envelope-open review packet round-4 (EO2 freeze branch resolved)
0284f6f fix(swarm): envelope-open round-4 — fold the op-conflict freeze into envelope recovery (EO2)
37adddb fix(swarm): autoscale suggestion-mode round-1 — AS-P2-1..4 + AS-N1
88ca85f refactor(swarm): D4-1 — converge the duplicated boot-template construction to one point in vm-ctl's boot family
71465ee docs(swarm): fanout review packet round-9 (FN9 resolved)
8401017 fix(fanout): round-9 — a failed lease-identity write STOPS the launch (FN9)
986efae docs(swarm): envelope-open review packet round-3 (EO2/EO3 resolved)
df83be7 fix(swarm): envelope-open round-3 — recover by wait lifecycle + bind receipt to the registered envelope (EO2/EO3)
44b1fe5 docs(swarm): BA9 round-6 review packet (BP3 resolved)
6c9f3ab fix(swarm): BA9 round-6 — reuse the well-formed-id check before hashing identity (BP3)
7f3e546 docs(swarm): fanout review packet round-8 (FN9 resolved)
0111607 fix(fanout): round-8 — visible lease held by POSITIVE terminal evidence, not todo-absence (FN9)
3f3a421 docs(swarm): envelope-open review packet round-2 (EO1/EO2/EO3 resolved)
db43600 fix(swarm): envelope-open round-2 — retry-until-open, wait adoption, receipt payload source (EO1/EO2/EO3)
aaea0db feat(swarm): review-seat autoscale suggestion-mode wiring (half-flip)
bb06dc1 docs(swarm): BA9 round-5 review packet (BP3 resolved)
311254b fix(swarm): BA9 round-5 — body-verified tmp eviction + obligation retained under a live writer pid (BP3)
dd7ed29 docs(swarm): fanout review packet round-7 (FN2/FN9 resolved)
6a2380b fix(fanout): round-7 — settle-path launch identity + visible lease survives driver exit (FN2/FN9)
22e2d0b feat(swarm): ruling-ledger — structured schema + validation for the R/S/F ruling codes (R22 Top-5, dormant)
29e8964 docs(swarm): envelope-open review packet round-1
a39d129 feat(swarm): envelope-open side — open a production delegation envelope at board grant (§2b, R14 pre-flight)
8927a9b docs(swarm): BA9 round-4 review packet (BP3 resolved)
23e6c2e fix(swarm): BA9 round-4 — repost-tmp recovery checks full identity + retains obligation (BP3)
3bdd434 docs(swarm): fanout review packet round-6 (FN2/FN9 resolved)
9c15c20 fix(fanout): round-6 — launchId-only exit identity, strict spent, visible lease on confirmed close (FN2/FN9)
41c48e4 docs(swarm): envelope-open side design (one page, R14 pre-flight, dual to BA9)
6b1ad17 docs(swarm): BA9 round-3 review packet (BP1/BP3 resolved)
37afbbd fix(swarm): BA9 round-3 — report-before-stamp + repost rollback/adoption (BP1/BP3)
605dfe7 docs(swarm): fanout review packet round-5 (FN2/FN8/FN9 resolved)
5e58b48 fix(fanout): round-5 — resume reconcile, attempt-bound evidence, child-terminal lease release (FN2/FN8/FN9)
8cc8905 docs(swarm): BA9 round-2 review packet (BP1-BP6 resolution)
68e41e0 fix(swarm): BA9 round-2 — BP1-BP6
29a39d7 docs(swarm): fanout round-4 review packet (cross-attempt seam resolution)
b7b5fd9 fix(swarm): fanout round-4 — FN1-5,7-9 cross-attempt seams
99dc9fe docs(swarm): BA9 board-post supervision review packet
52533f3 feat(swarm): BA9 board-post supervision (§2d-a, R14 pre-flight)
93023c6 docs(swarm): BA9 board-post supervision design (one page, R14 pre-flight)
7f73bba docs(swarm): fanout round-3 review packet (FN1-9 precise-threshold resolution)
64bfb17 fix(swarm): fanout round-3 — FN1-9 precise thresholds
9e9a33e docs(swarm): fanout round-2 review packet (FN1-9 + FN4-B resolution, N1 pointers)
c55f9e5 fix(swarm): fanout round-2 driver rewrite — FN1-9 + FN4-B visible chain
0ed7518 feat(swarm): fanout round-2 — FN1/2/7/8 pure decision layer
5218e12 feat(swarm): fanout round-2 WIP — FN5 runKey slug + FN4-B herdr visible-chain pure layer
ff16594 docs(swarm): fanout-native phase-1 review packet
e9a51f2 feat(swarm): fanout phase-1 self-built backend driver (dormant behind SWARM_FANOUT)
3e19e39 feat(swarm): fanout phase-1 pure core + selftest (sovereign governance)
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
| `packages/bus/src/inbox.ts` | bus | `packages/bus/src/submit-intent.ts` | bus |
| `packages/bus/src/swarm/chat-room-store.ts` | bus | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/swarm/chat-room-store.ts` | bus | `packages/bus/src/swarm/chat-room.ts` | bus |
| `packages/bus/src/swarm/chat-room.ts` | bus | `packages/bus/src/submit-intent.ts` | bus |
| `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus | `packages/bus/src/swarm/decision-batch.ts` | bus |
| `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus | `packages/bus/src/swarm/dual-bandwidth.ts` | bus |
| `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus | `packages/bus/src/swarm/chat-room-store.ts` | bus |
| `packages/bus/src/swarm/dual-bandwidth-store.ts` | bus | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/swarm/fanout-herdr.selftest.mts` | test | `packages/bus/src/swarm/fanout-herdr.ts` | bus |
| `packages/bus/src/swarm/fanout.selftest.mts` | test | `packages/bus/src/swarm/fanout.ts` | bus |
| `packages/bus/src/swarm/remote-bootstrap.selftest.mts` | test | `packages/bus/src/swarm/remote-bootstrap.ts` | bus |
| `packages/bus/src/swarm/remote-bootstrap.selftest.mts` | test | `packages/bus/src/swarm/vm-ctl.ts` | bus |
| `packages/bus/src/swarm/remote-bootstrap.ts` | bus | `packages/bus/src/swarm/vm-ctl.ts` | bus |
| `packages/bus/src/swarm/review-seat-autoscale.selftest.mts` | test | `packages/bus/src/swarm/review-seat-autoscale.ts` | bus |
| `packages/bus/src/swarm/ruling-ledger.selftest.mts` | test | `packages/bus/src/swarm/ruling-ledger.ts` | bus |
| `packages/bus/src/swarm/vm-ctl.selftest.mts` | test | `packages/bus/src/swarm/vm-ctl.ts` | bus |
| `scripts/review-ledger.ts` | script | `packages/bus/src/swarm/review-seat-autoscale.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/task-board.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/board-envelope.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/inbox.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/review-seat-autoscale.ts` | bus |
| `scripts/swarm-fanout.ts` | script | `packages/bus/src/swarm/fanout-herdr.ts` | bus |
| `scripts/swarm-fanout.ts` | script | `packages/bus/src/swarm/fanout.ts` | bus |

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
