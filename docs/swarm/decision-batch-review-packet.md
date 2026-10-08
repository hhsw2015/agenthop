# decision-batch 后端 round-12 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：按审查席裁定的占用保护方向（a）收口 DB-R7-P1-1。空锁恢复**不再删除目录**（remove→recreate 间隙会殃及在途后继），改为**领养**（直接把身份写入空目录，无 rmdir）；自有恢复绑定**本进程的未完成占用**（进程内集合），不再被磁盘上的陈旧同 pid 意图误导。并发写（R25）保留，未推未并。

代码：`de469d0`（范围 `71ba9b6..de469d0`）。源 `~/Dev/agenthop-wt/decision-batch` 分支 feat/decision-batch。
验证 @de469d0（修订源 overlay 到各自封存 snapshot 副本后在副本内跑，封存证据只读未动）：
- **occupancy-semantics.test.ts 2/2**（NO-RMDIR-REQUIRED-LIVE-SUCCESSOR-PROTECTED + STALE-OWN-INTENT-IS-NOT-CURRENT-OCCUPANCY）
- directory-recovery 6/6、compensation 4/4、lifecycle 孤儿 3/3、HOLD-SCAN-EACCES ✓
- 共 **16/16**（原 13 + HOLD-SCAN + 新版 2）；全量 bus **1025/1025**；tsc 0；decision-batch **34** 测
- 旧 EMPTY-SNAPSHOT/yield 与 2 个旧原语 lock 探针（RECLAIM-RESTORE / LOCK-RELEASE-READ-FAULT）为预期淘汰（审查席裁定新版替代其必经钩子），非回归

## DB-R7-P1-1（空锁回收删活/到达后继）→ 领养 + 进程内占用绑定
草稿缺口（审查席 STALE-OWN 反例）：`ownStranded` 仅凭「磁盘上同 pid 旧意图」判定，不能证明当前占用——旧调用已成功删目录、仅最后清理意图 EACCES 留下陈旧凭据；随后外部持有者释放、新后继到达，草稿误认「自有残留」而删掉新锁→后继 ENOENT。上一轮的 remove→recreate 亦有间隙（afterRmdir 在竞争者 real-rmdir 后、重建前同步唤醒后继→ENOENT）。

改为（占用保护，无删除间隙）：
- **领养代替删建**：空目录直接 `writeFileSync(lock/<我的身份>)`，不 rmdir、不重建 ⇒ 根本没有 remove→recreate 间隙。
- 仅在**可证明、绑定到占用**时领养，否则 contended：
  - (A) hold-intent 读失败（EACCES）→ contended（读不到不能断言「无持有者」）。
  - (B) 任一 **活的外部** hold-intent → contended（有在途/到达持有者，绝不偷）。
  - (C) **本进程的未完成占用**（进程内 `strandedLockDirs` 集合：本进程 mkdir 后发布失败、或 release 删不掉的空目录）→ 领养；磁盘上的同 pid 陈旧意图**不**算数。
  - (D) 否则**外部死进程**残留（有死 hold-intent、无活的）→ 先 unlink 该死意图（原子单赢）再领养。
  - 其余（活间隙 / 纯空目录 / 仅陈旧自有意图）→ contended。
- 外部进程从不碰外部空目录 ⇒ 本进程 stranded 的目录是自己独有、稳定、可安全领养（单线程无并发后继）；崩溃者由本进程重启或任意 peer 经 (D) 死意图路径恢复（满足「外部死进程空目录的恢复边界须保留」，非永久 contended）。

## 验证法（随码可复算）
审查席封存证据只读未动；occupancy 在 `decision-batch-empty-lock-direction-20261008/candidate/` 副本内跑，其余在 `decision-batch-71ba9b6-review-evidence/` 副本内跑，修订源 overlay 到各自 snapshot。

## DEFERRED（非本层）
孤儿重批执行与接收端幂等（协调者 seam）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
