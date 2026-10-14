# Architecture-integrity review sheet — rehearse-batch-22

- **Branch** `rehearse-batch-22`  **HEAD** `dceaa98f38a21cd8905f0ee05a66e761fb106c45`  **Base** `57c13eab9ce7ea04c2dc2f247a7e29e8c8ac6138`
- **Reviewer** codex:Work-01a13284 (cross-family, independent)  **Author/tooling** claude:agenthop-c5beaa7c
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
3 commit(s), 5 changed file(s), `57c13eab9ce7ea04c2dc2f247a7e29e8c8ac6138..dceaa98f38a21cd8905f0ee05a66e761fb106c45`.

```
dceaa98 build(swarm): regenerate presence artifacts for batch-22 (B22-1)
d74c93c Merge fix/flake-fix into rehearse-batch-22 (dual-cleared @450f9bb)
450f9bb fix(bus): flake-fix — FH-MD-1 (digest test accepts legal unknown) + FH-RELAY-1 (retry a failed directory announce)
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
_(no internal edges among the batch's changed source files)_

### Candidate boundary flags (reviewer confirms — evidence, not findings)
_(none auto-detected; the reviewer still judges the axes below)_

## C11 — done bound to SHA evidence
| node | ok | reason |
| --- | --- | --- |
| flake-fix | yes | bound to 450f9bb7df0b4badb1535624f2cd440c5a9ae542 |
| B22-1 presence artifacts | yes | bound to dceaa98f38a21cd8905f0ee05a66e761fb106c45 |

## Axis verdicts (reviewer fills; REMAIN blocks the batch)
### Module boundary drift
- _Probe:_ IO in a pure module; a script reaching into bus internals; a pure->IO import
- **Verdict: PASS.** 目录模块保持原 IO 边界，无新增导入；七个纯核闭包未引入文件、网络或执行 IO。

### Duplicate implementation
- _Probe:_ one concern solved twice (two board parsers; two liveness paths) — name convergence candidates
- **Verdict: PASS.** 失败重试留在已签目录实现内；无第二套目录、锁或状态权威。

### Contract conflict
- _Probe:_ two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec)
- **Verdict: PASS.** 七个指定共享契约逐字不变；三文件为已签尖字节，生成物同步同一目录实现。

### Dependency direction
- _Probe:_ import cycles or wrong-direction edges (bus->scripts, pure->IO) — the key graph invariant
- **Verdict: PASS.** 全树253生产节点/467唯一本地运行时边，与基线及批21集合一致；零环、bus→scripts、未解析本地边。pack0边仅是批内口径。

### Gate / invariant consistency
- _Probe:_ each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments
- **Verdict: PASS.** 无新旗标/接线；单件并发、重试和unknown义务沿用签收，B22-1一致；三tsc0、自测62/62；本席长TMPDIR装配失败已用原生对照定位，短路径定向及全量1618/1618通过。

### Done bound to SHA evidence (32-eval C11)
- _Probe:_ every `done` declaration in the batch is bound to a commit SHA; a self-reported done with no SHA is REMAIN
- **Verdict: PASS.** flake-fix450f9bb双声及祖先绑定核验；B22-1绑定dceaa98。固定pack3提交/5文件，两项done均绑定SHA。

## REMAIN (open, blocking)
0 P1/P2/P3; 0 CONFIRMED/REMAIN/nit. **DUAL-VOICE-CLEARED / six axes PASS**. Whole-batch external second voice at this fixed SHA explicitly agrees; 0 objections / 0 reopened.

## Validation and report

Direct package TypeScript bus/CLI/scripts: exit 0. Selftests 62/62. Final full bus 105 files, 1618/1618, zero skip. Initial 1613/1618 used an overlong private TMPDIR; native socket long/short controls proved truncation/EADDRINUSE, and unchanged targeted/full tests pass with short TMPDIR. Initial logs retained. Standard private build and actual private writePresenceBundle pass. Single-ticket closure limits remain; no live installation/recovery/merge/push/enable.

Report: `/Users/wowdd1/Work/review-reports/batch22-architecture-review-dceaa98-01a13284.md`.

## Whole-batch dual signoff

Primary codex:Work-01a13284 and external codex:happycapy-01a13274 agree on dceaa98f38a21cd8905f0ee05a66e761fb106c45, base57c13eab9ce7ea04c2dc2f247a7e29e8c8ac6138. Six axes/B22-1 PASS; 0 P1/P2/P3/CONFIRMED/REMAIN/nit, 0 objections/reopened. Peer2393 manifest entries/report, primary862 core entries/report and22 packet entries verified. Original first-run TMPDIR failure and correction evidence retained.

Dual addendum: `/Users/wowdd1/Work/review-reports/batch22-dual-signoff-dceaa98-01a13284.md`. Peer report SHA256: `dcbd2d8cba0c71922bea5106929d4b0f91a10c89381ab3b12dca72972bba6895`. No merge/push/install/enable executed; coordinator and user gates remain.
