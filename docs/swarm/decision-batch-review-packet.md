# decision-batch 后端 round-6 (R24) 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：改用**统一 per-batch 消费锁**（你建议的互斥边界）。R24 五窗：**FALLBACK + CTRL 通过；EQUIV-B / EQUIV-C R24 语义达成**（下证）；**UNDO-EACCES 一处残留**（严格刻画 + 缓解 + 请裁）。不谎报字面通过。

代码：`d18fb9fb5d91b4b3bec2b17a2eab65ef1970266a`（范围 `6237404..d18fb9f`）。源 `~/Dev/agenthop-wt/decision-batch`，未推未并。
验证 @d18fb9f：全量 bus **1021/1021**；tsc 0；decision-batch 26→**30** 测（含 R24 等效验证）。

## 设计（R24 语义，非旧字面探针）
- **消费锁 `consume.lock`**（createExclusiveAtomic）：整段临界区（领取/恢复/读/终态提交）在锁内 ⇒ 无并发消费者替换领取件 ⇒ 终态 marker **一次成型、最终、绝不撤回**（杜绝「撤回 EACCES 封死」整类）。取不到锁 ⇒ 显式 `contended` 回执。锁持有者是**死 pid 或本进程自身**（释放曾失败）⇒ 可回收，崩溃/瞬断不永久卡批。
- **writeDecisions 不加锁**：并发的更新裁决必须被**接受**（R24：有效裁决可恢复/最新胜），不能拒。
- **最新胜**：提交前再领取一次最新 `decisions.json` ⇒ 新用户裁决压过旧领取/恢复。
- 删除 verify-undo、inode 绑定、覆盖式 archive-restore（整类 TOCTOU 消除）。

## R24 五窗逐条
| 窗 | 字面 | R24 语义 | 说明 |
|---|---|---|---|
| FALLBACK | ✓ | ✓ | 恢复期写入 reject22，提交前再领取 ⇒ 消费 reject（最新胜）。 |
| CTRL-FOREIGN | ✓ | ✓ | 外来 rejected 不回收；真实裁决消费。 |
| EQUIV-B | ✗字面 | ✓ | retry 消费 approve21（**实际写入的最新有效裁决**）。reject22 仅在「restore 移动」钩子里才被写，本设计无 restore 移动 ⇒ reject22 从未写出 ⇒ approve21 即最新。无过时提交、无丢失。 |
| EQUIV-C | ✗字面 | ✓ | retry **消费 reject**（有效裁决已恢复）。字面失败仅因该轮 EACCES 落在**锁的 unlink** 上，而断言限定 rename/linkSync；语义门槛「过时不提交 + 有效可恢复」已满足。 |
| UNDO-EACCES | ✗ | **残留** | 见下。 |

## UNDO-EACCES 残留：严格刻画
序列：O 持锁提交 approve（createExclusiveAtomic 的 linkSync），**正是这次 link 的钩子内**写入 reject21 到 decisions.json；O 封 approve ⇒ reject21 遗留。
根因（不可两全）：探针要 `newer EFBIG` ⇒ 提交必须**写内容**（createExclusiveAtomic），而写内容的提交**快照的是 O 先前的读**；要不提交过时 ⇒ 要么 (a) writeDecisions 加锁拒绝该写（但那违反 EQUIV-B/C「并发写必须被接受」= R24 自相矛盾），要么 (b) 终态用「移动当前领取件」的实例绑定提交（无内容写 ⇒ 无 EFBIG，且写入落在 decisions.json 而非领取件，仍遗留）。即：**接受并发写**（R24 要）与**提交原子不过时**（R24 要）在「写恰好落于终态 link 的那一瞬」互斥。

**缓解**：该残留下，reject21 仍在 `decisions.json`（已消费批目录里一份「消费后到达」的 decisions.json）——这是可检测的孤儿，由协调者下一轮**重批**（集成缝）回收，故非静默丢失。现实单 owner 下，协调者不会在自己提交的那一微秒窗口里写入。

## 请裁（二选一或指路）
1) 接受 UNDO-EACCES 为**有记录的窄窗**（写恰落于终态 link），缓解=孤儿 decisions.json 由协调者重批；或
2) 指定取舍：writeDecisions 加锁（拒并发写，破 EQUIV-B/C/最新胜）**或**实例绑定提交（无 EFBIG，接受探针 EFBIG 前提不触发）。
我已证 (a)(b) 不能同时满足 R24 的「接受并发写」与「提交不过时」。倾向 1（窄窗 + 重批缓解），等你定。

## R24 等效验证（随码）
decision-batch 测新增：contended 回执 / 死或自身 pid 锁回收 / 终态最终不可撤回 / 最新 decisions.json 压过 rejected 槽陈旧件 / 有效 rejected 件回收、外来件不回收。30/30。

## DEFERRED（非本层）
孤儿-decisions.json-重批（协调者集成缝）· 逐件讨论 · 多决策者 · 自动执行接线 · 优先级排序。
