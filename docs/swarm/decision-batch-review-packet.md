# decision-batch 后端 round-10 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：DB-R7-P1-1（补偿动作自身失败后仍留下不可辨认空锁）已根治；DB-N2（nit：凭据失败后至少一次投递）已写入契约。DB-R3-P1-1 round-9 已核销，保留。并发写（R25）保留，未推未并。

代码：`f0f0697`（范围 `47287fa..f0f0697`）。源 `~/Dev/agenthop-wt/decision-batch` 分支 feat/decision-batch。
验证 @f0f0697：审查席 **compensation-boundaries.test.ts 4/4**（三恢复场景 + R25 投递可见）；**directory-recovery.test.ts 6/6**（无回归）；lifecycle 孤儿组 3/3（含 CONCURRENT-ORPHAN-NOTIFIERS）；全量 bus **1025/1025**；tsc 0；decision-batch **34** 测（28 IO + 6 纯）。
lifecycle 2 个旧原语 lock 探针（RECLAIM-RESTORE / LOCK-RELEASE-READ-FAULT）仍红——键于 `consume.lock` 文件 + `.reclaim-` 换名 / 释放读 token，round-8 已判定无法挂目录锁并以上述两套新探针重建；预期淘汰，非回归。

## DB-R7-P1-1（补偿失败留不可辨认空锁）→ 发 mkdir 前的 HOLD-INTENT 凭据
根因：round-9 的「rmdir 失败则重建本名文件」在**锁目录也同时不可写**（或发布在写任何文件之前就失败）时无法执行，残留**无身份空目录**；而 acquire 对空目录一律 contended，无法区分「故障残留」与「活的在途获取」，故三反例永困：
- A：mkdir 成功后 ld 与父目录同时 EACCES（身份写入与撤销目录皆失败）。
- B：提交失败，身份已删；rmdir 与重建身份相继 EACCES。
- C：回收死者时删名成功、rmdir 遇 EACCES，身份未恢复。

改为（身份在文件名 + 发 mkdir 前的持有意图）：
- 每次 acquire **先在 batch 目录写** `consume.lockd.hold.<pid>.<nonce>`（父目录此刻可写）——它能熬过「清理阶段再也碰不到锁目录」的故障，并以文件名携带故障者 pid。
- 空锁目录的回收判据：**当且仅当不存在「活的、非自身 pid」的 hold-intent** 才回收（故障者意图=死/自身→回收并续原裁决；活持有者意图=存活→contended）。→ 故障空目录可恢复，活的在途空目录绝不被偷。
- 已发布持有者（目录内恰一身份文件）仍按**精确名** dead/own 回收，不动后继。
- release：删身份→rmdir→**最后**删 hold-intent；rmdir 若失败则 hold-intent 留存=可辨认恢复凭据。全程 try/catch 永不抛。
探针：FAILED-PUBLISH-AND-ROLLBACK / FAILED-RELEASE-AND-RESTORE / FAILED-DEAD-RECLAIM-RMDIR 三项 `verdicts(first)+verdicts(retry)==='reject'` 全过；UNPUBLISHED-LIVE（活空目录仍 contended）与 directory-recovery 六项无回归。

## DB-N2（nit：凭据失败后至少一次投递）→ 契约披露
已在契约 Orphan recovery 章与 round-10 说明写明：`.sent` 凭据在**成功投递之后**写入；若凭据写入 EACCES，重试会按同一 digest **重复投递**（宁重复不丢失）。协调者负责按稳定更新 ID（内容 digest，封于 `taskRef`/信号）**幂等重批**。接收端幂等由协调者实现，非本层。
探针 R25-SENT-PROOF-FAILURE-DELIVERY-OBSERVED：`notices>=1`（投递可见），`duplicateDelivery` 记录在案。

## 验证法（随码可复算）
审查席封存证据 `~/Work/review-reports/decision-batch-47287fa-review-evidence/` 只读未动；将修订源 overlay 到 `/tmp` 的 snapshot 副本后在副本内运行探针。

## DEFERRED（非本层）
孤儿重批执行与接收端幂等（协调者 seam）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
