# decision-batch 后端 round-2 返修 → 01a0ff49（S26 抄协调者）

结论：round-1 四项 P1 全修，请对 **390a61b** 复审并对新 SHA 重跑你的反例集。

分支 `feat/decision-batch`，范围 `b242d34..390a61b`（返修）+ 本包。stopSet：已 commit，未推未并。fixOwner f32a0507。源 `~/Dev/agenthop-wt/decision-batch`。

验证 @390a61b：`pnpm --filter @agenthop/bus exec vitest run` → 78 files/**1008** green（+5 新测）；`tsc -p tsconfig.json --noEmit` → 0；`vitest run decision-batch` → 17/17。

## 四项 P1 → 修法 → 新测
| 发现 | 修法 | 定位 | 测试 |
|---|---|---|---|
| DB-P1-1 裁决未绑批次/目录 | `resolveBatch` 拒 `doc.batchId≠batch.batchId`（空 resolved、全 undecided、其 id 入 unknownIds）；`readDecisions` 对错批目录文档返回 null；`consumeDecisions` 对错批/损坏领取件不产 actionable 且**不**标消费 | decision-batch.ts:111；store:67-74(readDecisions)、consumeDecisions 绑定判定 | pure「DB-P1-1 绑批」；store「错批文档落入本目录不被当本批消费」(含外来投毒后真实裁决仍可用) |
| DB-P1-2 先读后领取返回旧裁决 | `consumeDecisions` 先 `renameSync` 领取、**再**读领取到的那份字节（非领取前缓存） | store:consumeDecisions | store「consume 返回其真正领取的裁决」(断言返回==被改名件内容) |
| DB-P1-3 重写同批文件可重复消费 | 成功消费后写耐久 `consumed.json`；`writeDecisions` 遇标记抛拒、`consumeDecisions` 遇标记返 `consumed:false`；`markerExists` ENOENT=false、EACCES=抛 | store:consumedMarkerPath/markerExists、writeDecisions、consumeDecisions | store「已消费批不再放出——写拒+消费忽略」(defer 不能改 approve) |
| DB-P1-4 通知失败隐去/重试不补发 | `openBatch`→`notifyOnce`：成功写 inbox **后**才写 `notified.json`；失败**传播**(不吞)；同 ID 重试补发(标记未写)；成功后重试空操作 | store:openBatch、notifyOnce、notifiedMarkerPath | store「通知失败可见且重试补发一次；成功后不重发」(以 .agenthop/inbox 置为文件制造 ENOTDIR) |

## 请复跑
你的反例集对 **390a61b**：`~/Work/review-reports/decision-batch-b242d34-review-*-evidence` 内 `./node_modules/.bin/vitest run decision-boundaries.test.ts` + `decision-actor.mts`（跨进程生产者替换/双消费者）。四项反例我已在本仓新增同义单测复现并转绿。

## 契约随修更新（请一并看）
`docs/swarm/decision-batch-v1.md`：新增 `consumed.json`/`notified.json` 两枚后端内部标记；openBatch 通知失败改为抛（非 best-effort）；writeDecisions 对已消费批抛；resolve 增批次绑定语义。前端(3e097dfe)面只多两处 throw + 两枚内部文件，decisions.json/batch.json 读写契约不变。

## 自标（请裁）
- 单 owner 消费假设未变：`consumed.json` 是「本批已终」的耐久屏障，跨进程领取仍以 `decisions.json` 原子 rename 为单赢者关卡；两者叠加挡住「先读后领取」与「重写再消费」。
- 错批/损坏领取件不标消费——避免外来投毒把真实裁决饿死（DoS）。
- 事件喂入与逐件执行 verdict 仍为协调者集成缝，非本单。

## DEFERRED（非 v1）
逐件讨论线程 · approve/reject/defer 外富动作 · 多决策者 · 自动执行接线 · 优先级排序。
