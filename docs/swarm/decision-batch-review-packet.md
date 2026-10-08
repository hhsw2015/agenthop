# decision-batch 后端 round-7 (R25) 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：两项 P1 已修。**DB-R3-P1-1（R25 孤儿信号）已实测到达协调者**；**DB-R7-P1-1 的关键安全项（终态 EEXIST 不双执行）已修**，锁改为实例绑定原子回收。保留并发写（R25），不加写锁。

代码：`ca0d7ba416e91877277a3a39db6c215e41cea09d`（范围 `d18fb9f..ca0d7ba`）。源 `~/Dev/agenthop-wt/decision-batch`，未推未并。
验证 @ca0d7ba：全量 bus **1024/1024**；tsc 0；decision-batch **33** 测（含 R25/R7 等效验证）。
你的 semantic-lock 探针：**4/5 通过**——R25-ACCEPTED-LATE-WRITE（孤儿信号到达）✓、CTRL-LIVE-HOLDER-CONTENDED ✓、CTRL-FAILED-RELEASE-RETRY ✓、CTRL-DEAD-HOLDER-RECOVERS ✓；STALE-DEAD-RECLAIMER 见下（与原子回收原语不兼容）。

## DB-R3-P1-1（R25 孤儿恢复）→ 修法
消费后到达、绑定本批、且**比已消费裁决更新**（decidedAtSec >）的有效决策＝孤儿。`consumeDecisions`（终态快路径 + 成功提交后）`emitOrphanSignal`：向**批 owner（协调者）**写**一条**耐久 inbox 件（composeInboxMsg/writeInbox，via=decision-batch，title「orphan decision — re-batch」）——信号**在本单实现并实测到达 owner 箱**，非口头缝；owner 按新 batchId 重批（执行属其缝）。陈旧写（decidedAtSec ≤ 已消费）**不重批**（不复活过时裁决）。`orphan.signaled` 保证一次。契约已冻「Orphan recovery (R25)」正式边界。
- 实测：R25-ACCEPTED-LATE-WRITE 探针 ✓（信号到达）；我新增单测：更新件→信号到 owner 箱（taskRef/via 校验）+ 一次性；陈旧件→无信号。

## DB-R7-P1-1（消费锁）→ 修法
- **终态 EEXIST 不返回可执行裁决（关键）**：提交现检查 `createExclusiveAtomic` 结果；竞败（"exists"）返回 consumed:false——绝不为竞败的提交返回可执行裁决（此前忽略返回值 ⇒ 两消费者同 approve 双 consumed=true）。这是双执行的根本防线。
- **实例绑定锁**：每次获取写唯一 `{pid, token}`；释放**仅当锁仍是本 token** 才 unlink（绝不删后继）；死/自身 pid 锁用**原子 rename-aside + 校验 + 若是活后继则还原**回收（非「独立检查后 unlink」——那正是你指出的删活后继的根因）。
- 实测：CTRL-LIVE-HOLDER-CONTENDED ✓、CTRL-FAILED-RELEASE-RETRY ✓、CTRL-DEAD-HOLDER-RECOVERS ✓；新增单测：活 holder 的锁**原样不动**（既不偷也不删）。

## STALE-DEAD-RECLAIMER：与原子回收原语不兼容（请裁/更新探针）
该探针用 `hooks.beforeUnlink(p===lock())` 注入竞争者，即**预设回收走 `unlinkSync(lock)`**。但你的门槛「独立 PID/inode 检查不等于原子删除」要求**原子**回收——我用 `renameSync(lock→aside)`（原子领取）+ 校验 + 还原，**绝不 unlink 活锁**。故该探针的 beforeUnlink 注入点在正确实现里不存在：探针 `waitFor(ready.json)` 等不到被注入的 peer（本轮实测**超时 10s**）→ 非干净失败，而是注入无法发生。
- 正确性论证：死锁→原子 rename-aside；若竞争者在 rename 后新建锁，我 createExclusiveAtomic 得 "exists"→contended（不偷）；若竞争者在 rename 前替换，我 rename 走的是其活锁→校验为活后继→renameSync 还原→contended（不偷）。三序皆不偷活后继。加之终态 EEXIST 兜底：即便两者都入临界区，也只一个提交成功。
- 请裁：更新探针改 hook `renameSync`（dst=aside）或接受等效验证（CTRL-LIVE-HOLDER + 新增「活锁原样不动」单测 + 上述三序论证）。不限定原语（你 R25 原则）。

## DEFERRED（非本层）
孤儿重批的执行（协调者 seam）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
