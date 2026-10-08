# decision-batch 后端 round-13 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：按审查席裁定关闭两条误领养路径收口 DB-R7-P1-1。撤下 D 分支（外部死意图领养，R26 另行覆盖外部死目录恢复，外部空目录允许 contended）；进程内 stranded 记录在**每次成功 rmdir 后**即失效（不止重新获取成功时）。DB-R3/DB-N2 保持 CLOSED。并发写（R25）保留，未推未并。

代码：`4d02ca0`（范围 `de469d0..4d02ca0`）。源 `~/Dev/agenthop-wt/decision-batch` 分支 feat/decision-batch。
验证 @4d02ca0（修订源 overlay 到各自封存 snapshot 副本后在副本内跑，封存证据只读未动）：
- **adoption-boundaries.test.ts 2/2**（STALE-DEAD-INTENT-MUST-NOT-AUTHORIZE-NEW-OCCUPANCY + STRANDED-MEMORY-MUST-EXPIRE-AFTER-REMOVAL）
- occupancy-semantics 2/2、directory-recovery 6/6、compensation 4/4、lifecycle 孤儿 3/3、HOLD-SCAN-EACCES ✓
- 共 **18/18**（原 16 + adoption 2）；全量 bus **1025/1025**；tsc 0；decision-batch **34** 测
- 旧 EMPTY-SNAPSHOT/yield + 2 个旧原语 lock 探针为预期淘汰，非回归

## DB-R7-P1-1（领养凭据没随占用失效）→ 撤 D + 记录随删除失效
反例 A（STALE-DEAD-INTENT）：旧进程已删目录、仅清理意图失败后退出，留下过期死凭据；随后正常释放/新建交错，草稿 D 分支按死凭据领养**新**目录并消费，释放时删目录→活后继 ENOENT。
反例 B（STRANDED-MEMORY）：release 失败先记 stranded；随后自有回收**成功 rmdir**（published-reclaim 路径）但重新 mkdir 败给后继，旧集合项未清；下一次交错中旧记录授权领养**新**目录→活后继 ENOENT。

改为：
- **(A) 撤下 D 分支**：空目录不再凭「外部死意图」领养。删除过期凭据不能证明当前目录无人占用；外部空目录（含死进程残留）一律 **contended**，外部死进程恢复由 R26 另行覆盖（方向件第 4 点已改判）。空目录领养**仅限**本进程 stranded 集合内的自有未完成占用。
- **(B) 记录随占用消失即失效**：published-reclaim 路径 `rmdirSync` **成功后立即** `strandedLockDirs.delete(dir)`（非仅重新获取成功时）；release 成功 rmdir 同样 delete。于是成功删除或占用转移后，旧进程内记录绝不再授权领养后来者的目录。
- 保留：(A) 读意图失败→contended；(B) 活的外部 hold-intent→contended（绝不偷到达中持有者）；(C) 本进程 stranded 集合内→领养（直接写身份，无 rmdir 间隙）。

## 验证法（随码可复算）
审查席封存证据只读未动；adoption 在 `decision-batch-de469d0-review-evidence/` 副本、occupancy 在 `...direction-20261008/candidate/` 副本、其余在 `...71ba9b6-review-evidence/` 副本内跑，修订源 overlay 到各自 snapshot。

## DEFERRED（非本层）
孤儿重批执行与接收端幂等（协调者 seam）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
