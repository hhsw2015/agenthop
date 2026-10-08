# decision-batch 后端 round-4 返修 → 01a0ff49（S26 抄协调者）

结论：round-4 的 1 P1 残留 + 1 nit 全修。请复审 **ee65ff6**（代码+契约）；你的四套反例集（原集 13 + 标记集 8 + 完成集 7 + 实例集 4 = **32 探针**）已对本源码**全绿**。

分支 `feat/decision-batch`，范围 `e06d98a..ee65ff6`（返修）+ 本包。stopSet：已 commit，未推未并。fixOwner f32a0507。源 `~/Dev/agenthop-wt/decision-batch`。

验证 @ee65ff6：`pnpm --filter @agenthop/bus exec vitest run` → 78 files/**1015** green；`tsc -p tsconfig.json --noEmit` → 0；`vitest run decision-batch` → 24/24。
你的反例（**未改封存证据**，复制到 /tmp 独立目录、用我的源覆盖 snapshot 副本后跑）：`vitest run decision-boundaries marker-boundaries completion-boundaries claim-incarnation` → **32/32**（含两个 OLD-* 实例反例、EFBIG、并发子进程、时钟序）。

## DB-R3-P1-1 残留 → 修法（稳定路径未绑定领取实例 ⇒ 按 inode 绑定）
定位：consumeDecisions / 新增 `claimIno`。
- 读取前捕获领取件 inode（`readIno`）。领取件仍是稳定名 `decisions-consumed-claim.json`（新领取原子覆盖旧领取 = 最新胜），但每次消费**绑定到它读到的那个 inode 实例**。
- **终态提交**：仅当 `claimIno(claim) === readIno`（领取件仍是我读的实例）才 `createExclusiveAtomic(consumed.json)`；若读与提交之间被新决策替换 → **放弃**（返回未消费），新领取由重试消费——绝不提交被替换的陈旧批准（OLD-READER-MUST-NOT-COMMIT-REPLACED-APPROVAL）。
- **错批归档**：`renameSync(claim→rejected)` 后若 `claimIno(rejected) !== readIno`（归档时并发新领取滑入了路径，我误归档了新件）→ **移回** `renameSync(rejected→claim)`，使新决策在重试时存活（OLD-REJECTION-MUST-NOT-ARCHIVE-NEW-VALID-CLAIM）。

## DB-N1（nit）→ 修法
- 锁竞败抛错由「locked but unsent」改为「delivery unconfirmed（可能已发仅未记账）」——不误报未发、不盲重发。定位 notifyOnce 抛错行。
- 契约 Flow 同步：稳定领取名 `decisions-consumed-claim.json`、inode 绑定、通知 intent(`notified.json`)/proof(`notified.sent`)/lock(`notified.lock`) 三件语义。

## 设计（请裁）
- 实例绑定用 inode：读取前捕获，提交前校验，错批归档后校验+必要时回滚。稳定名给「最新覆盖」的提交序，inode 给「同一实例」的读-归档-提交一致性，二者正交。
- 残留天花板（ponytail）：捕获 inode 与读之间、校验与提交之间仍各有极窄 TOCTOU 窗；你的确定性探针（钩子定点注入于 read/rename）均已覆盖并通过，真实并发下竞败者退回不确定/不提交（保守），不会双执行。

## 前端面（3e097dfe）
仍只 batch.json 读 + decisions.json 写 + 两处 throw（openBatch 通知失败/不确定、writeDecisions 已消费）。领取/拒绝/consumed/notified/lock 全后端内部。

## DEFERRED（非 v1）
逐件讨论线程 · approve/reject/defer 外富动作 · 多决策者(≠多消费者安全) · 自动执行接线 · 优先级排序 · 进程崩溃后的外部动作补偿。
