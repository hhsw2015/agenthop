# T5-2 双带宽仪表 (dual-bandwidth gauge) — design one-pager v0

**owner f32a0507 · status: DESIGN APPROVED (协调者已裁 4 问 2026-10-08；实现 gated on decision-batch 终验签收) · grounds in `docs/research/dhh-16thread-eval.md`**

## 一句话
测量「智能体产出需人裁的件」与「user 清掉裁决」两条带宽及其失衡，让协调者据此**压得更狠或少开线程**——仪表是传感器，不是审批/延迟跳板。

## 为什么 (DHH 深洞见)
瓶颈 = human judgment bandwidth，不是智能体产能；"the faster the agents run, the fewer threads I can run"（38:21）。
当「产出需裁件」的速率持续压过「user 清裁」的速率，积压无界增长、user 淹没。现在我们**看不见**这个失衡，只能事后发现。
decision-batch（R22-P1①）压缩了单次裁决成本；R18 两级调度要「以 user 判断带宽为界」——两者都需要一个共同的**失衡读数**来驱动。T5-2 就是那个读数。

## 两条带宽
- **B_prod（产出）**：单位时间新生成的需人裁件速率（decision-batch 开批的 items + chat-room 呈批 + 签收确认 + 并库候选 + 立项请求）。单位 件/小时。另含当前积压深度 D（undecided 队列）。
- **B_cons（消费）**：单位时间 user 清掉的**真决策**速率——decision-batch `consumeDecisions` 的裁决（approve/reject/defer）+ 呈批裁决。**不含 chat-room 签收**（协调者裁④：聊天确认是沟通不是裁决，混入会虚高消化率）。单位 决策/小时。

每条带宽都出**两个数**（协调者裁①，一套窗口逻辑）：主读数 = 滚动 1h 速率（实时失衡）；底数 = 整会话累计（日报用）。

## 派生读数
- 比值 `r = B_prod / B_cons`（持续 r>1 ⇒ 淹没）。
- 积压 `D`（undecided 件数）与其斜率 `dD/dt`。
- 排空时间 `T_drain = D / B_cons`（若此刻停产，清完还要多久）。

## 分区（传感器输出，协调者消费）
- **GREEN**：`r ≤ 0.8` 且 D 低于软顶 → 照常。
- **AMBER**：`r∈(0.8,1.2]` 或 D 上升 → 协调者**压得更狠**（更大的 decision-batch、低优先 defer、合并呈批）。
- **RED**：持续 `r>1.2` 或 D 超硬顶 或 T_drain 超视界 → 协调者**节流开线程**（R18 两级：并发以 B_cons 为界）。节流是少开新线程，**不是**给已有流程加审批跳板。

阈值 0.8/1.2 为**可调常量**起步（协调者裁②），实测一周后校准。

## 数据源（复用现有耐久件，不加热路径写入、不加新传输）
- decision-batch store：`openBatch`(件入／createdAtSec)、`consumeDecisions`(actionable 出／consumed.json consumedAtMs、undecided 重排)。**这是规范的进/出事件**，也是 B_cons 的**唯一**来源。
- chat-room、inbox：**仅** B_prod 的次级产出源（呈批/立项）；chat-room 签收**不**计入 B_cons（裁④）。
- 全在 `~/.agenthop/console` 下已落盘；仪表**只读**事件时间戳做聚合，不改源。

## 架构（蜂群纯层，沿用 decision-batch/chat-room 范式）
- **纯核 `dual-bandwidth.ts`**：给一窗带时间戳的 produce/consume 事件 → `{bProd,bCons,ratio,backlog,dBacklogDt,tDrain,zone}`。滑动窗速率（同 RoomRateLimiter 手法），除注入的 nowSec + 事件表外无 clock/fs。可纯单测。
- **IO `dual-bandwidth-store.ts`**：扫 decision-batch 目录（openBatch/consumed/undecided）+ chat-room/inbox 事件日志 → 喂纯核。只读聚合，不动源。ENOENT≠EACCES 纪律照旧。
- **投影**：一枚控制台可渲染的小 JSON（前端 3e097dfe）——两根指针(prod/cons，各带 1h + 累计两数) + 积压条 + 分区色 + T_drain。落在 `~/.agenthop/console/bandwidth-gauge/`（裁④：与 `decision-batches/` 并列的子目录族），投影文件走 viz **冻结读契约**范式。

## 设计律 (DHH 18:51)
仪表**测量**以让协调者**压缩或节流**；它绝不自己变成审批/延迟跳板。它是喂给 R18 两级调度 + decision-batch 压缩的传感器，闭合 DHH 评估指出的那个环。

## DEFERRED（非 v0）
逐件优先级加权 · 预测式(非当前速率)排空 · 多 user 带宽 · 自动节流接线(协调者集成缝) · 历史曲线。

## 协调者裁决（已定 2026-10-08，已折入上文）
1. **窗长**：主滚动 1h + 整会话累计（日报底数），两数一套窗口逻辑。
2. **阈值**：0.8/1.2 照用起步，常量可调，实测一周再校。
3. **B_cons**：只算真决策（approve/reject/defer + 呈批裁决），**不含** chat-room 签收（沟通≠裁决）。
4. **投影落点**：`~/.agenthop/console/bandwidth-gauge/`，与 `decision-batches/` 并列；文件走 viz 冻结契约。

设计已过。**实现 gated on decision-batch 终验签收**——届时按此一页实现（纯核先行单测，再 IO，再冻结投影契约）。
