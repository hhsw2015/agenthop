# decision-batch 后端 round-11 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：DB-R7-P1-1（空锁回收会删除活/到达中的后继）已根治。空锁回收现**绑定到观察到的占用**，绝不删除活的或正在到达的持有者。DB-R3/DB-N2 保持已核销。并发写（R25）保留，未推未并。

代码：`71ba9b6`（范围 `f0f0697..71ba9b6`）。源 `~/Dev/agenthop-wt/decision-batch` 分支 feat/decision-batch。
验证 @71ba9b6：审查席 **hold-boundaries.test.ts 2/2**（反例 A/B 均过）；**compensation-boundaries 4/4**、**directory-recovery 6/6**、lifecycle 孤儿组 3/3 全无回归；全量 bus **1025/1025**；tsc 0；decision-batch **34** 测。
lifecycle 2 个旧原语 lock 探针（RECLAIM-RESTORE / LOCK-RELEASE-READ-FAULT）仍红——键于 `consume.lock` 文件 + `.reclaim-` 换名 / 释放读 token，round-8 已判定淘汰并以 directory-recovery + compensation + hold 三套新探针重建；预期，非回归。

## DB-R7-P1-1（空锁回收删活后继）→ 回收绑定观察占用
根因：round-10 的空锁回收（判「无活的外部 hold-intent」后 rmdir）键于**单次陈旧快照**，两处漏洞：
- 反例 A：`listHoldIntents` 把目录读取错误（EACCES）折成空表 ⇒ 读不到意图却据此授权回收，删掉活持有者的锁。
- 反例 B：正常释放与新建交错——旧持有者删身份后暂停→竞争者读到空→旧持有者完成释放→竞争者扫描意图（此刻为空）→新持有者 mkdir 后暂停→竞争者据陈旧快照 rmdir 删掉**新**占用。

改为（回收绑定到观察到的占用）：
- **(A) 读意图必须成功**：`listHoldIntents` 的读失败**向上抛**，不再折成空表；回收路径捕获后 contended。读不到＝不能证明「无持有者」＝不授权回收。
- **(B) 不信任单次快照**：确认无活的外部 hold-intent 后，rmdir 旧目录、**重建一个本进程拥有的新目录**，再**复核**；若回收过程中有活后继到达（其 hold-intent 现为活）⇒ **让渡**这个新空目录给后继（留给它认领），绝不保留一个活持有者正在用的目录。
- 已发布持有者（恰一身份文件）仍按**精确名** dead/own 回收；活的在途/发布中持有者（活 hold-intent）一律 contended。
探针：HOLD-SCAN-EACCES-MUST-PRESERVE-LIVE-PUBLISH（读失败不回收，活持有者保有并消费）、EMPTY-SNAPSHOT-MUST-NOT-DELETE-LIVE-SUCCESSOR（交错释放/新建下让渡给新后继，first contended、后继消费 reject）均过。

## 验证法（随码可复算）
审查席封存证据 `~/Work/review-reports/decision-batch-f0f0697-review-evidence/` 只读未动；将修订源 overlay 到 `/tmp` 的 snapshot 副本后在副本内运行探针。

## DEFERRED（非本层）
孤儿重批执行与接收端幂等（协调者 seam）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
