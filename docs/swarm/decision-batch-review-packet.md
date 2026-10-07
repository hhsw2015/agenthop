# decision-batch 后端 v1 审查包 → 01a0ff49（S26 抄协调者）

分支 `feat/decision-batch`，范围 `c3439cd..b242d34`（代码）+ 本包。stopSet：已提交分支，未并未推。fixOwner f32a0507。源 `~/Dev/agenthop-wt/decision-batch`。

验证：`pnpm --filter @agenthop/bus exec vitest run` → 78 files/1003 green；`tsc -p tsconfig.json --noEmit` → 0。

## 是什么
R22-P1① DHH 评估头号借项：事件→决策压缩层。协调者把 N 件需人类裁决的事项（呈批/并库候选/签收/立项）聚合为一个 batch，user 一屏一行一件清（approve/reject/defer）。复用 F38 composeInboxMsg，非新传输。前端渲染属 3e097dfe，契约已冻 `docs/swarm/decision-batch-v1.md`。设计律（DHH 18:51/19:37「bottleneck=human bandwidth；cannot intermediate with another human」）：此层只压缩 user 决策负载，绝不做增加延迟的审批跳板——协调者是压缩层非守门。

## 门槛 → 实现 → 测试
| 门槛 | 实现 | 测试 |
|---|---|---|
| 唯一 item `id`（裁决不歧义） | validDecisionBatch 去重即拒整批 | pure「duplicate item `id` ⇒ null」 |
| verdict 白名单 | validDecision=approve/reject/defer | pure「verdict whitelist」 |
| 决策匹配与漏报 | resolveBatch=matched→resolved、无决策→undecided、外来 `id`→unknownIds、重复 `id` 首个胜 | pure「resolveBatch」 |
| defer≠执行 | actionable 排除 defer | pure「actionable excludes defer」 |
| 一次消费不双执行 | consumeDecisions 原子 rename 领取（同 inbox claim）；赢者得 resolution+consumed，败者/已消费 consumed=false 全 undecided | store「consume-once」 |
| 写入收读端会拒的数据 | writeBatch/writeDecisions 写边界 validate | store「invalid doc rejected」 |
| 不安全 batchId | 拒 `^[A-Za-z0-9_-]{1,64}$` 外输入 | store「unsafe batchId REJECTED」 |
| 读失败≠空 | readJsonOrNull：ENOENT→null，EACCES→抛；openBatch 不盖不可读批 | store「EACCES … refuse」（非 root） |
| 压缩 ping | openBatch notifyTo 写**一条** via=decision-batch 耐久件（N 事件→一提醒） | store「notify writes ONE」 |

## 自标（请裁）
- 单 owner（协调者单活）写批；consumeDecisions 原子 rename 是跨进程安全的领取点。
- 消费后 `decisions.json` 移为 `decisions-consumed-<ts>`；undecided+deferred 由协调者**下一批**重发（非本单自动）。
- 事件喂入（哪些真实事件变 item）与逐件执行 verdict＝协调者集成缝（契约已标），非本单。本单＝纯核+IO+测试+契约。
- createdAtSec/decidedAtSec＝秒；通知件 ts＝nowSec\*1000（ms，对齐 inbox 信封）。

## DEFERRED（非 v1）
逐件讨论线程 · approve/reject/defer 外的富动作 · 多决策者 · 自动执行接线 · 优先级排序。
