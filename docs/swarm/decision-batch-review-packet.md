# decision-batch 后端 round-3 返修 → 01a0ff49（S26 抄协调者）

结论：round-3 的 2 P1 + 2 P2 全修。请复审 **e06d98a**（代码）；你的三套反例集（原集 13 + 标记集 8 + 完成集 7 = **28 探针**）已对本源码**全绿**。

分支 `feat/decision-batch`，范围 `85089a7..e06d98a`（返修）+ 本包。stopSet：已 commit，未推未并。fixOwner f32a0507。源 `~/Dev/agenthop-wt/decision-batch`。

验证 @e06d98a：`pnpm --filter @agenthop/bus exec vitest run` → 78 files/**1014** green；`tsc -p tsconfig.json --noEmit` → 0；`vitest run decision-batch` → 23/23。
你的反例（**未改封存证据**，复制到独立目录跑）：把我的 `decision-batch{,-store}.ts` 覆盖到 `/tmp` 下 snapshot 副本，`./node_modules/.bin/vitest run decision-boundaries marker-boundaries completion-boundaries` → **28/28**（含 EFBIG 部分写、并发子进程、时钟排序）。

## 四项 → 修法 → 定位
| 发现 | 修法 | 定位 |
|---|---|---|
| DB-R2-P1-1 残留：终态写一半仍封死 | `consumed.json` 改**临时文件写满 + link 落位**(`createExclusiveAtomic`)：名字只在内容完整时出现，EFBIG/崩溃半写永不封批；写/link 故障抛而领取件留存 → 重试续作同一次消费 | decision-batch-store.ts createExclusiveAtomic / consume 终态 |
| DB-R3-P1-1：领取排序复活陈旧批准 | 领取件改**单一稳定名** `decisions-consumed-claim.json`：新领取原子覆盖旧领取 → 最新决策胜，**不依赖墙钟/随机名**（同毫秒、时钟回退均后者胜）。删除 ms+rand 的 latestClaim 排序 | consume 领取/续作 |
| DB-R2-P2-1 残留：回滚失败误报成功 | `notifyOnce` 分离**已发证明** `notified.sent`（发后写）与**发前意图** `notified.json`；遗留意图标记**绝不**算已发；发失败释放锁→重试补发恰一条，释放也失败→重试返回**不确定**(抛)，绝非零封静默成功 | notifyOnce |
| DB-R3-P2-1：并发通知仍重复发信 | 独占 **link 锁** `notified.lock` 串行化通知者；迟到者丢锁后复查 `notified.sent`，否则返回不确定——**不覆盖赢家再发**。并发同批 open 至多一封 | notifyOnce / createExclusiveAtomic |

## 关键设计（请裁）
- 终态/领取/锁三类原子性：`createExclusiveAtomic`（写满 temp→link）给出「完整内容 + 单赢者」两性质；领取用稳定名给出「最新覆盖最旧」的提交序（无时钟依赖）。
- 恢复优先级：先认新 `decisions.json`（覆盖旧领取）→ 否则续作稳定领取件。故障续作无需用户重提；并发新决策不被旧领取覆盖。
- 通知恰一次：`notified.sent` 是唯一「确已发」信号；意图标记不算。不确定态显式抛（你 round-2 门槛允许「补发一封，或明确返回不确定」）——我优先补发（锁可释放时），不可释放时返回不确定，二者都不重复发。
- 错批/损坏领取件 → `decisions-rejected-claim.json` 搁置，不解析/不续作/不封批（防外来投毒饿死真实决策）。

## 契约随修
`docs/swarm/decision-batch-v1.md` 已更新：稳定领取名 + 覆盖序、temp+link 终态、`notified.sent`/`.lock`/`.json` 三件通知语义。前端(3e097dfe)面仍只 batch.json 读 + decisions.json 写 + 两处 throw（openBatch 通知失败/不确定、writeDecisions 已消费）。

## DEFERRED（非 v1）
逐件讨论线程 · approve/reject/defer 外富动作 · 多决策者(≠多消费者安全) · 自动执行接线 · 优先级排序 · 进程崩溃后的外部动作补偿。
