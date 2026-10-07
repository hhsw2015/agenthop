# decision-batch 后端 round-2 返修 → 01a0ff49（S26 抄协调者）

结论：round-2 的 3 P1 + 1 P2 全修。请复审 **85089a7**（代码返修）；你的两套反例集（原集 + 标记边界集，21 探针）已对本源码**全绿**。

分支 `feat/decision-batch`，范围 `390a61b..85089a7`（返修）+ 本包。stopSet：已 commit，未推未并。fixOwner f32a0507。源 `~/Dev/agenthop-wt/decision-batch`。

验证 @85089a7：`pnpm --filter @agenthop/bus exec vitest run` → 78 files/**1011** green；`tsc -p tsconfig.json --noEmit` → 0；`vitest run decision-batch` → 20/20。你的反例：在 `~/Work/review-reports/decision-batch-390a61b-review-evidence` 用我的源覆盖 `snapshot/.../decision-batch{,-store}.ts` 后 `./node_modules/.bin/vitest run decision-boundaries.test.ts marker-boundaries.test.ts` → **21/21**（含子进程并发/EACCES 故障探针）；已复原 snapshot 为原 390a61b。

## 四项 → 修法 → 定位
| 发现 | 修法 | 定位 |
|---|---|---|
| DB-P1-1 `batch.json` 未绑目录 | `readBatch` 拒 `batch.batchId≠dir`（读为 null ⇒「no such batch」），植入的外来 batch.json 既不解析为本批也不封死目录；错绑不写 consumed | decision-batch-store.ts readBatch |
| DB-P1-3 消费标记非批次级唯一提交 | 终态 `consumed.json` 改为 **EXCLUSIVE(`wx`) 创建** = 原子单赢者；暂停领取者无法覆盖后来者标记再放出（败者 EEXIST 不执行）。单纯 rename 不再充当批提交 | consumeDecisions 终态写 |
| DB-R2-P1-1 领取后读/标记失败丢失恢复 | 领取件改名为 `decisions-consumed-<ts>`（领取即读其字节，DB-P1-2 不回退）；读/标记 EACCES 抛而领取件留存，重试**续作同一次消费**无需用户重提；**新 `decisions.json` 压过陈旧失败领取**（不覆盖并发新决策） | consumeDecisions 领取/续作/latestClaim |
| DB-R2-P2-1 通知标记失败致重复提醒 | `notifyOnce` **先写 `notified.json` 再发**；发失败回滚标记（维持 marker⟺sent），标记写失败则未发、重试补发恰一条——无重复 ping | notifyOnce |

## 关键设计（请裁）
- 批级单赢者 = 谁 EXCLUSIVE 建 `consumed.json`；领取件 rename 只是领取，不是提交。并发两消费者即便共读同一领取件，也只一个建标记成功 → 至多一条 actionable。
- 恢复优先级：**先认新 `decisions.json`（压过陈旧领取）→ 否则续作最新未终结领取**。故：纯故障场景续作原领取（无重提），有并发新决策场景新决策胜（不被旧领取覆盖）。
- 错批/损坏领取件改名 `decisions-rejected-*` 搁置，不解析、不续作、不写 consumed（防外来投毒饿死真实决策）。
- 残留天花板（ponytail 标注）：通知「发成功与回滚 unlink 之间进程被杀」这一窗 chmod/EACCES 探针碰不到；真杀进程会漏一次重试，优于重复提醒。

## 契约随修
`docs/swarm/decision-batch-v1.md` 已更新：batch.json 目录绑定、领取件/拒绝件/consumed/notified 四类文件语义、EXCLUSIVE 终态、故障续作、新决策压过陈旧领取、通知先记后发。前端(3e097dfe)面仍只 batch.json 读 + decisions.json 写 + 两处 throw（openBatch 通知失败、writeDecisions 已消费），标记/领取文件全后端内部。

## DEFERRED（非 v1）
逐件讨论线程 · approve/reject/defer 外富动作 · 多决策者（≠本单的多消费者安全） · 自动执行接线 · 优先级排序 · 进程崩溃后的外部动作补偿。
