# decision-batch 后端 round-9 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：两项 P1 已修，一窗完成。**DB-R3-P1-1（孤儿发送=已送达混淆）** 与 **DB-R7-P1-1（故障清理留下不可辨认空目录）** 均按审查席重建的目录锁探针根治。保留并发写（R25），未推未并。

代码：`47287fa`（范围 `aa0bea5..47287fa`）。源 `~/Dev/agenthop-wt/decision-batch`。
验证 @47287fa：审查席 **directory-recovery.test.ts 6/6 全绿**；lifecycle 孤儿组 3/3（含 CONCURRENT-ORPHAN-NOTIFIERS）；全量 bus **1025/1025**；tsc 0；decision-batch **34** 测（28 IO + 6 纯）。
lifecycle 的 2 个 lock 探针仍红——它们键于**旧原语**（`consume.lock` 文件 + `.reclaim-` 换名、释放读 token），审查席已在 round-8 判定其无法挂到目录锁、并以 directory-recovery.test.ts 重建；故那 2 红是预期的旧探针淘汰，非回归。

## DB-R3-P1-1（孤儿发送 vs 已送达）→ 投递在先、凭据在后
根因：`orphan-<digest>.signaled` 是**发送前**独占认领；send 失败回滚那次认领本身若也失败（dir/inbox 同时 EACCES），标记留存 ⇒ 永久静默跳过，owner 投递丢失。
改为：
- **删除发送前认领**。emitOrphanSignal 先 `writeInbox`，**成功后**才写 `orphan-<digest>.sent`（proof-of-sent）。
- send 失败 ⇒ 无凭据 + **向上抛**（不吞）⇒ 调用方 consume 以 EACCES 结束，重试**补发恰好一条**。
- 并发去重不再靠标记，而靠**消费锁**：每一次 emit（含终态快路径）都移到锁内串行 ⇒ 并发不双发；`.sent` 跨重试去重（后到的不同 digest 不被旧凭据屏蔽）。
探针 **ORPHAN-SEND-AND-ROLLBACK-FAILURE-MUST-RETRY**：first EACCES、retry 投递、notices=1 ✓。

## DB-R7-P1-1（故障清理须留可辨认凭据，活的空目录不可回收）→ 具名凭据
根因：释放时先删本名文件、再 rmdir；父目录只读 ⇒ 身份已删、空目录残留。空目录与「活的在途获取」无法区分 ⇒ 若回收会偷活锁，若不回收则故障者永困 contended。
改为（身份即凭据）：
- **release**：删本名文件后若 rmdir 失败（父只读），**重建本名文件**——残留目录带可辨认 pid，下次 consume 按 own/dead pid 精确回收；全程 try/catch 永不抛。
- **take()**：赢得 mkdir 后发布身份若失败（锁目录中途变不可写），**丢弃刚建的空目录**，不留无身份残目录。
- **回收判据不变**：单个 dead/own 身份文件按**精确名**回收；**空目录（无身份）= 活在途 ⇒ 永不回收**，返 contended。
探针全绿：FAILED-CONSUME-RECOVERS（父只读→重试 reject ✓）、FAILED-IDENTITY-PUBLISH-RECOVERS（锁目录只读→重试 reject ✓）、UNPUBLISHED-LIVE-DIRECTORY-IS-NOT-RECLAIMED（活空目录 contended ✓）、DEAD-RECLAIMER-LEAVES-LIVE-SUCCESSOR-NAME（具名回收护活后继 ✓）、RELEASE-DIRECTORY-FAULT-DOES-NOT-MASK-COMMIT（清理故障不遮蔽 approve ✓）。

## 验证法（随码可复算）
审查席封存证据 `~/Work/review-reports/decision-batch-aa0bea5-review-evidence/` 只读未动；将我方修订源 overlay 到 `/tmp` 的 snapshot 副本后在副本内运行探针，封存证据保持原样。

## DEFERRED（非本层）
孤儿重批执行（协调者 seam）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
