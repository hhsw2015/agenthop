# Architecture-integrity review sheet — rehearse-batch-21

- **Branch** `rehearse-batch-21`  **HEAD** `7e61fcaf4564ca5372975d110a914a2b5e985fd0`  **Base** `d0395daf3cf1d79a5e152476c4803cbe2b16ffb9`
- **Reviewer** codex:Work-01a13284 (cross-family, independent)  **Author/tooling** claude:agenthop-c5beaa7c
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
31 commit(s), 22 changed file(s), `d0395daf3cf1d79a5e152476c4803cbe2b16ffb9..7e61fcaf4564ca5372975d110a914a2b5e985fd0`.

```
7e61fca build(swarm): regenerate presence artifacts for batch-21 (B21-1)
5b37e4b Merge feat/verification-ledger into rehearse-batch-21 (dual-cleared @fb65753)
03dbf6a Merge fix/direct-write-sweep into rehearse-batch-21 (dual-cleared @c9f4a7b)
7f6c51f Merge feat/full-fleet-recovery into rehearse-batch-21 (dual-cleared @5227c6a)
76a08f2 Merge feat/submit-precheck into rehearse-batch-21 (dual-cleared @6394004)
fb65753 fix(swarm): verification-ledger r4 — give the collision gate teeth, exact window label (VL-1-GATE/VL-5)
c9f4a7b fix(swarm): direct-write-sweep r6 — DWS-R3-1 drop the unsound sawInvalid exception (top absent ⇒ always HOLD)
13cfa83 fix(swarm): verification-ledger r3 — compound-key collision, partial-stat wording, fractional window (VL-1/VL-4/VL-5)
5227c6a fix(swarm): fleet-recovery r12 FR-8-GATE — link gate pins the caller's episode binding
8f3f5e3 fix(swarm): direct-write-sweep r5 — DWS-R3-1 top-level sub-facet (absent-after-observed ⇒ UNKNOWN/HOLD)
b994418 fix(swarm): verification-ledger r2 — fix 5 cost-attribution bugs (VL-1..VL-5)
ce5d53b fix(swarm): fleet-recovery r11 FR-8 — bind the public status to THIS run's episode
6394004 fix(swarm): submit-precheck r3 — SP-1 close the last 3 path facets (subdir coordinate, literal Unicode, header TAB)
1a4d258 fix(swarm): direct-write-sweep r4 — DWS-R3-1, UNKNOWN must HOLD the dedup obligation (don't fold to republishable)
31d922b fix(swarm): fleet-recovery r10 FR-8 — one public completion criterion (receipt = work snapshot, marker is authority)
e7847a0 feat(swarm): verification-ledger — cost-per-accepted-change projection (econ-mirror-21 candidate 3)
0c2563b fix(swarm): submit-precheck r2 — SP-1 lossless Git paths + repo-root reads; SP-2 append-hint fix; +以名定态 rule
3d4f277 fix(swarm): direct-write-sweep r3 — DWS-1-ADOPT, validate the .claim-* CONTENT (a claim NAME is not proof)
5ff9067 fix(swarm): fleet-recovery r9 FR-8 — durable two-phase receipt + marker-last (close the provisional-masquerade window)
a14aff8 feat(swarm): submit-precheck — a mechanical pre-review checklist (prompter, not a gate)
2600636 fix(swarm): direct-write-sweep r2 — DWS-1-OWN / DWS-1-ADOPT / DWS-3-OWN (wx-ownership + target validation)
d4a7ae2 fix(swarm): fleet-recovery r8 — FR-8 last sub-face: receipt-first re-writes the final-marker obligation into the durable receipt
e0dcea1 fix(swarm): direct-write-sweep — harden/judge 3 bare direct-writes (michael's 4-round audit)
9d208b7 fix(swarm): fleet-recovery r7 — FR-8 (markLaunching gates launch, receipt-first) + rebased onto batch-20; FR-6 auto-closed
5d6ba5f fix(swarm): fleet-recovery r6 — FR-6/8/9 (reuse holder-lock, launching-state, receipt-revert, FIFO-safe claim fd)
b5ee8ba fix(swarm): fleet-recovery r5 — FR-6/8/9 (recover-local lock, unknown≠pending, O_NOFOLLOW fd, receipt after settle)
708a403 fix(swarm): full-fleet-recovery r4 — 6 REMAIN (FR-2,5,6,8,9,10)
584556b fix(swarm): full-fleet-recovery r3 — 8 REMAIN (FR-1,5,6,7,8,9,10,12)
dc32bf7 fix(swarm): full-fleet-recovery r2 — all 12 codex:Work findings (FR-1..FR-12)
4d3cbc2 feat(swarm): full-fleet-recovery §5 code — dispatcher+env+F53-verify+breakpoint over F36 resume
33f2f7e docs(swarm): full-fleet-recovery brief (design-first) — dispatcher+env+verify+breakpoint gaps over F36 resume
```

## Contract surface (hashed — compare against the prior verdict to see drift)
| path | category | sha256 |
| --- | --- | --- |
| `docs/swarm/cluster-liveness-design.md` | spec-doc | `74c9f776cf4a0615…` |
| `docs/swarm/projection-schema.md` | spec-doc | `4fa065224caf51be…` |
| `docs/swarm/team-collab-design.md` | spec-doc | `cb7cb40a481eae17…` |
| `packages/bus/src/inbox.ts` | shared-type | `d04989be613d71ee…` |
| `packages/bus/src/swarm/task-plan.ts` | shared-type | `7624dfb8346bcaf5…` |
| `packages/bus/src/swarm/control-log.ts` | shared-type | `e397d051f06f968d…` |
| `CLAUDE.md` | invariant-doc | `3d255bb7724bb892…` |

## Import map (who-imports-whom, batch files only)
| from | zone | to | zone |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/chat-room-store.ts` | bus | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/swarm/fleet-recovery-store.ts` | bus | `packages/bus/src/swarm/fleet-recovery.ts` | bus |
| `packages/bus/src/swarm/fleet-recovery-store.ts` | bus | `packages/bus/src/inbox.ts` | bus |
| `packages/bus/src/swarm/fleet-recovery.selftest.mts` | test | `packages/bus/src/swarm/fleet-recovery.ts` | bus |
| `packages/bus/src/swarm/fleet-recovery.selftest.mts` | test | `packages/bus/src/swarm/fleet-recovery-store.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `packages/bus/src/swarm/submit-precheck.selftest.mts` | test | `packages/bus/src/swarm/submit-precheck.ts` | bus |
| `packages/bus/src/swarm/verification-ledger-store.ts` | bus | `packages/bus/src/swarm/verification-ledger.ts` | bus |
| `packages/bus/src/swarm/verification-ledger.selftest.mts` | test | `packages/bus/src/swarm/verification-ledger.ts` | bus |
| `packages/bus/src/swarm/verification-ledger.selftest.mts` | test | `packages/bus/src/swarm/verification-ledger-store.ts` | bus |
| `scripts/submit-precheck.ts` | script | `packages/bus/src/swarm/submit-precheck.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/fleet-recovery.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/fleet-recovery-store.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/inbox.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `scripts/swarm-recover.ts` | script | `packages/bus/src/inbox.ts` | bus |
| `scripts/swarm-recover.ts` | script | `packages/bus/src/swarm/fleet-recovery.ts` | bus |
| `scripts/swarm-recover.ts` | script | `packages/bus/src/swarm/fleet-recovery-store.ts` | bus |
| `scripts/verification-ledger.ts` | script | `packages/bus/src/inbox.ts` | bus |
| `scripts/verification-ledger.ts` | script | `packages/bus/src/swarm/verification-ledger.ts` | bus |
| `scripts/verification-ledger.ts` | script | `packages/bus/src/swarm/verification-ledger-store.ts` | bus |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
_(none auto-detected; the reviewer still judges the axes below)_

## C11 — done bound to SHA evidence
| node | ok | reason |
| --- | --- | --- |
| full-fleet-recovery | yes | bound to 5227c6a66f1fa6b1f9aee9d3faf05deffeb5d640 |
| direct-write-sweep | yes | bound to c9f4a7b02f07366bacb6ce6cc4c6e6ff5df9247b |
| submit-precheck | yes | bound to 6394004531650a93da1e55a206eefe071bf00030 |
| verification-ledger | yes | bound to fb65753f801e71f3e2bc2ce7ec1c47b4147b833f |
| B21-1 presence artifacts | yes | bound to 7e61fcaf4564ca5372975d110a914a2b5e985fd0 |

## Axis verdicts (reviewer fills; REMAIN blocks the batch)
### Module boundary drift
- _Probe:_ IO in a pure module; a script reaching into bus internals; a pure->IO import
- **Verdict: PASS.** 七个纯核运行时闭包保持；新三核没有 fs/network/exec 依赖，副作用在 store/脚本。

### Duplicate implementation
- _Probe:_ one concern solved twice (two board parsers; two liveness paths) — name convergence candidates
- **Verdict: PASS.** 复用 canonical control/retro/board/inbox 与 holder-lock；两锁未改，未增加独立状态权威。

### Contract conflict
- _Probe:_ two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec)
- **Verdict: PASS.** 六个共享契约文件未变；inbox 来自已签 DWS，消息 schema/result/public wrapper AST 不变；新消费者保留 pending 义务。

### Dependency direction
- _Probe:_ import cycles or wrong-direction edges (bus->scripts, pure->IO) — the key graph invariant
- **Verdict: PASS.** 全树 253 节点/467 唯一本地运行时边，较 base +8/+29；零环、反向 bus→scripts、未解析本地边。pack 的22行不是全图。

### Gate / invariant consistency
- _Probe:_ each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments
- **Verdict: PASS.** precheck 提示器；ledger 自动 OFF/手动允许；fleet 按已签 Q3/Q4 默认 ON/显式恢复；显示身份与投递义务保持。B21-1 重建及实际私有写出通过。

### Done bound to SHA evidence (32-eval C11)
- _Probe:_ every `done` declaration in the batch is bound to a commit SHA; a self-reported done with no SHA is REMAIN
- **Verdict: PASS.** 四票双声固定尖均为候选祖先；20 文件直接同 blob，另两产物独验；固定 pack 五项 done 均绑定 SHA。

## REMAIN (open, blocking)
0 P1 / 0 P2 / 0 P3; 0 CONFIRMED / 0 REMAIN / 0 nit. **DUAL-VOICE-CLEARED / six axes PASS**. External whole-batch second voice at this fixed SHA explicitly agrees; 0 objections / 0 reopened.

## Validation and report

Primary real compiler: bus/CLI/scripts tsc 0; all selftests 62/62; bus 104 files, 1611/1611, first run, no skips. Standard private build and private writePresenceBundle passed. Coordinator original tsc tee logs were wrong-compiler output despite green summary; these are not accepted as passing evidence. Primary compilation closes the check gap. Initial coordinator relay failure remains recorded with cause unestablished.

Full report: `/Users/wowdd1/Work/review-reports/batch21-architecture-review-7e61fca-01a13284.md`. Core evidence: `/Users/wowdd1/Work/review-reports/batch21-7e61fca-review-01a13284`. No live recovery, actual install, merge, push or enable.

## Whole-batch dual signoff

Primary codex:Work-01a13284 and external codex:happycapy-01a13274 agree at fixed 7e61fcaf4564ca5372975d110a914a2b5e985fd0 (base d0395daf3cf1d79a5e152476c4803cbe2b16ffb9). Six axes PASS; B21-1 PASS; 0 P1/P2/P3/CONFIRMED/REMAIN/nit; 0 objections/reopened. Peer 2381 manifest entries and report, primary 852 core entries and report, 20 packet entries verified. Original primary report is preserved as historical PENDING-PEER evidence.

Dual addendum: `/Users/wowdd1/Work/review-reports/batch21-dual-signoff-7e61fca-01a13284.md`. Peer report SHA256: `e9ef2a0f919ee894a587967bdc71b3e4f947253bd9a5e38063fb001b0f8889cb`. No merge, push, installation or enablement performed; the existing coordinator/user merge gate remains.
