# Architecture-integrity review sheet — rehearse-tern-batch

- **Branch** `rehearse-tern-batch`  **HEAD** `758bf30fa6d7c808177938d838b6c49e53a0e49b`  **Base** `ae5d7514655ed7c89c226e07299e63783d657120`
- **Reviewer** codex:Work-01a13284 (cross-family, independent)  **Author/tooling** bus-pen
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
32 commit(s), 49 changed file(s), `ae5d7514655ed7c89c226e07299e63783d657120..758bf30fa6d7c808177938d838b6c49e53a0e49b`.

```
758bf30 Merge feat/tern-ledger-proj into rehearse-tern-batch (line-3 cleared @05935bb)
d7bca83 Merge feat/tern-a6-a8-line2 into rehearse-tern-batch (line-2 cleared @260f2c6)
799c449 Merge feat/tern-adoption-board into rehearse-tern-batch (line-1 cleared @0013e8a)
0d3bde1 Merge spike/tern-migration into rehearse-tern-batch (A1-A3 dual-cleared @ae2dad8)
ae2dad8 test(tern): adoption r4 — close TA-A1-PUBLISH-GATE (kill the write-failure-ignoring publisher mutant)
06e2e6d fix(tern): adoption r3 — close TA-A1-PUBLISH + TA-A2-STALL combination boundaries
260f2c6 fix(swarm-observatory): r5 backup-loop leaf validation independent of item presence (TE-SOURCE-UNKNOWN)
4cad848 fix(swarm-observatory): r4 record/leaf-type validation in review queues (TE-SOURCE-UNKNOWN)
0013e8a test(tern): board r7 — TB-FC2-GATE kills the two sealed production mutants (commit gate)
9763cc1 fix(tern): board r6 — real open() errno is the sole fs classifier; resolver faults abort (TB-FC2)
43ea062 fix(tern): line② r3 — seal TE-SOURCE-UNKNOWN's two remaining faces (codex r2 @5e17e54)
b733271 fix(tern): board r5 — errno from the filesystem, status through every query, legit-absent not blocked by recency, arch SHA resolved to a unique commit
5e17e54 fix(tern): line② r2 — FC-2 three-state + honesty fixes (codex review @1170161: 6 P2 + 1 P3)
5a3397a fix(tern): board r4 — propagate exit/errno through the whole gather chain + structural arch match (TB-FC2, TB-ARCH)
05935bb fix(tern): line ③ r3 — B3 runtime record-shape validation (codex:Work r2: 0 P1/1 P2, last face)
7792bb7 fix(tern): board r3 — close the 8 r1 review findings (TB-OWN/WRITE/FC2/QUOTE/ID/ROUND/ARCH/BRANCH)
b59f411 fix(tern): line ③ r2 — 5 FC-2/honesty fixes (codex:Work review 8c26550: 0 P1/5 P2)
1170161 fix(tern): 候裁M = unresolved DecisionBatch cards (coordinator ruling, real source)
1efd91f feat(tern): line② A6 cold-start canvas+snapshot + A8 v1 observation exports (+§2 amendment)
73ea1e0 feat(tern): board v2 — Reviewing recency filter (<7d), coordinator v2 ruling
8c26550 feat(tern): B4 notebook digest — read-only SQL + deterministic render (line ③, §3 Option-2)
85835c1 fix(tern): adoption r2 — address A1-A3 main-review (TA-A1-PUBLISH/GATE, TA-A2-READ/STALL/ARM, TA-A3-SCOPE)
4e6efc2 feat(tern): board projection A4/A5 — review + runbook Carly boards from durable swarm facts
3af0ce1 feat(tern): B3 verification-ledger SQLite projection (line ③, contract §3 @1e0f860)
ea57c4a feat(tern): A3 OSC 9;4 alert channel — needs-human signal for bare TUI seats
b840d18 feat(tern): A2 promptless patrol sentinel — model-free fleet watch via tern.carly.schedule
5be85ea feat(tern): agents-bridge v1 (A1) — production cx.agents file-JSON control plane
3c75638 docs(spike): tern-migration r5 — final scope narrowing (observation != validation)
ab538c0 docs(spike): tern-migration r4 — close-out TERN-3-DOC text consistency + fold in Carly ACP experiments
38b8af8 docs(spike): tern-migration r3 — close-out main-review residual 4 (TERN-1-R2/2-R2/3/4-DOC)
1978c39 docs(spike): tern-migration r2 — address main-review 4 findings (TERN-1..4) + fold in user-tested QA
3d62c69 docs(spike): tern-migration — cx.agents bridge prototype + OSC state test + 5-deliverable report
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
完整TS/JS生产图259节点/476边；新增9条，其中4条是本件内部引用、5条到既有bus读取器/纯核。Lua/SH另有6 require、5加载入口及1定时动作。见本票graph/固定集合。

### Candidate boundary flags (reviewer confirms — evidence, not findings)
_(none auto-detected; the reviewer still judges the axes below)_

## C11 — done bound to SHA evidence
| node | ok | reason |
| --- | --- | --- |
| bridge | yes | fixed signed tip `ae2dad8ffbbaef48e49267181ab135831165f638` is an ancestor; owned paths are byte-identical |
| board | yes | fixed signed tip `0013e8a331570882093ff7c6a8eb27c15748e520` is an ancestor; owned paths are byte-identical |
| observatory | yes | fixed signed tip `260f2c6b88170f4794efbf45c121584c30b8a608` is an ancestor; owned paths are byte-identical |
| ledger | yes | fixed signed tip `05935bb83e9aabe1faa2ef52e24160055d41ef4b` is an ancestor; owned paths are byte-identical |
| inherited spike evaluation | yes | `3c7563821bfdd681f04b6c13745344ebf2cda104`; 7 docs/prototype files unchanged |
| presence zero delta | yes | rebuild bound to `758bf30fa6d7c808177938d838b6c49e53a0e49b`, payload equals base; no new artifact commit needed |

## Axis verdicts (reviewer fills; REMAIN blocks the batch)
### Module boundary drift
- _Probe:_ IO in a pure module; a script reaching into bus internals; a pure->IO import
- **Verdict: PASS — 既有七纯核闭包/字节保持；ledger-core新纯核无外部模块，render-core仍按已签只读IO分类。**

### Duplicate implementation
- _Probe:_ one concern solved twice (two board parsers; two liveness paths) — name convergence candidates
- **Verdict: PASS — 四组件沿用各自已签职责及canonical readers，没有合流新增状态权威或重复写者。**

### Contract conflict
- _Probe:_ two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec)
- **Verdict: PASS — 八项共享契约逐字不变；各票关闭范围保持，A1双声不扩签A2/A3。**

### Dependency direction
- _Probe:_ import cycles or wrong-direction edges (bus->scripts, pure->IO) — the key graph invariant
- **Verdict: PASS — 全TS/JS259节点/476边（+6/+9），无删除/环/bus→scripts/production→test/未解析本地边；Lua/SH加载关系另验。**

### Gate / invariant consistency
- _Probe:_ each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments
- **Verdict: PASS — 默认文件写域及正式插件namespace互斥；维持opt-in、只读投影及后续安装边界；presence重建同基线。**

### Done bound to SHA evidence (32-eval C11)
- _Probe:_ every `done` declaration in the batch is bound to a commit SHA; a self-reported done with no SHA is REMAIN
- **Verdict: PASS — 四签收尖、继承spike及本批产物核验均绑定固定SHA；32提交、49新增、四次no-ff父链与各尖字节一致。**

## REMAIN (open, blocking)
0 P1/P2/P3/CONFIRMED/REMAIN/nit. **PRIMARY-CLEARED / six axes PASS / PENDING whole-batch peer.**


## Validation and report

三套包内TypeScript 5.9.3均exit0；selftests64/64。主审首轮1616/1618的两handoff失败因私有archive无Git；补绑定本SHA的私有Git元数据后定向6/6、全量105文件1618/1618、零skip。首日志与清理记录保留，不改称首跑成功。

标准build一次成功；presence raw=embedded=规范化重建期望，payload `238b39fa79c7dfdada62a89ed9fed0775e29ea467549b0e48164dd01de58884f`，与base相同。49路径分别来自已签spike(7)、bridge(14)、board(7)、observatory(11)、ledger/notebook(10)。无单票内部重开。

主审报告：`/Users/wowdd1/Work/review-reports/tern-batch-architecture-review-758bf30-01a13284.md`。单件A1仅A1双声；A2/A3及三投影件按既定单声范围继承。prototype未安装评估源码；不扩签递归插件安装。未合并、推送、安装或启用。
