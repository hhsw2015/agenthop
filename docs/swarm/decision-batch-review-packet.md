# decision-batch 后端 round-8 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：两项 P1 已修。**DB-R3-P1-1（孤儿生命周期）你三探针全绿 3/3**；**DB-R7-P1-1 消费锁按你建议移植 vm-ssh 具名身份目录锁**（根治回收竞态 + 释放不遮蔽结果）。保留并发写（R25）。

代码：`aa0bea50f97a93a9dc585c60d25a1cf0c18a63d2`（范围 `ca0d7ba..aa0bea5`）。源 `~/Dev/agenthop-wt/decision-batch`，未推未并。
验证 @aa0bea5：全量 bus **1025/1025**；tsc 0；decision-batch **34** 测。
你的 lifecycle-boundaries：**orphan 组 3/3 过**（SAME-SECOND / LATER-PUBLISH / CONCURRENT-NO-DUPLICATE）；lock 组 2 项见下（旧原语，无法挂到新目录锁）。

## DB-R3-P1-1（孤儿）→ 按内容摘要 + 逐更新
三反例根因=「秒级比较 + 整批一次性标记」。改为：
- **身份=内容摘要**（sha256 of decisions doc），非 decidedAtSec：同秒不同内容 digest 不同 ⇒ 不再静默（A ✓）。
- **逐更新标记** `orphan-<digest>.signaled`（独占创建认领）：后到的不同更新用自己的标记，不被旧信号永久屏蔽（B ✓）；并发同更新独占认领，仅一个发送（C ✓）；发送失败回滚标记（重试补发）。
- consumed.json 现存**consumed doc 的 digest**；「已兑现」=digest 相等（非时钟）。
你三探针：SAME-SECOND-ACCEPTED-UPDATE / LATER-ACCEPTED-PUBLISH-NOT-HIDDEN / CONCURRENT-ORPHAN-NO-DUPLICATE **全绿**。

## DB-R7-P1-1（消费锁）→ 移植 vm-ssh 具名身份目录锁（你所荐）
锁=**目录** `consume.lockd`（原子 mkdir），持有者身份=目录内唯一文件名 `<pid>.<nonce>`。
- **回收只删死者精确命名文件**（readdir 单项 + pid 死/自身）⇒ **绝不删后继**（不同名）；空目录(在途)/活/歧义 ⇒ contended；无「搬移+还原」可被第三者 clobber（根治 reclaim-restore 竞态）。
- **释放只删本名文件且永不抛**（rmSync/rmdir 全 try/catch）⇒ 清理读/删错**不遮蔽已提交结果**（根治 release-read-fault）。
- 终态 EEXIST 竞败仍返回 not-consumed（round-7 已修，保留）。

### lock 组 2 探针与新原语不兼容（请重建）
两探针键于**旧原语**（`consume.lock` 文件 + rename-aside / 释放读 token）：
- RECLAIM-RESTORE-MUST-NOT-ERASE-LIVE-HOLDER：写 `consume.lock`**文件**并 hook `beforeRename(src===lock, dst startsWith lock+'.reclaim-')`。新锁是**目录**、无 rename-aside ⇒ 该 hook 永不触发（cReady 等不到）。
- LOCK-RELEASE-READ-FAULT-MUST-NOT-HIDE：`afterLink` 里 `chmodSync(consume.lock, 0)`，但 `consume.lock` 现是目录名、该文件不存在 ⇒ chmod ENOENT 在钩子内抛，污染结果。
两者皆因新目录锁不碰 `consume.lock` 文件、不做 rename-aside。**请按目录锁原语重建**（hook mkdir/rmSync(dir/<name>) 交错；release 的故障注入改 chmod 目录）。等效验证（随码）：活 holder→contended 且其身份文件**原样不动**；死 holder→回收消费；release 全 try/catch 永不抛（结构可见 + vm-ssh 十轮已证此模式）。

## DEFERRED（非本层）
孤儿重批执行（协调者 seam）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
