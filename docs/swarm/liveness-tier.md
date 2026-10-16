# Liveness tier — 「晚上交付,白天还在跑」的审查与验收级别

user 2026-10-16 原话:「保证这个集群能够长时间稳定运行的这些东西都是非常核心的东西,比如说卡点呢,消息传递啊,还有其他的那些……要经过非常严格的审查……必须达到非常可靠的这种级别。」「长时间稳定的运行才是持续推进的基础,而持续推进就是你这个角色的核心职责之一。」

## 1. 什么算 liveness 件(进这一级)
任何改动触及以下任一面,送审信第一行标 **[liveness]**,审查席与协调者按本文件而非普通门处理:
- 消息传递:inbox 写/认领/唤醒(writeInbox、inbox-wake、tern-wake)、bus 投递、codex 直注路径
- 卡点处理:审查席停滞(L7)、授权链(成员不问 user)、拒绝≠暂停(skill §1b)
- 哨与自愈:dispatcher sweep 各步(L3/L4/L5)、dispatcher 自身存活(L6)、Carly 心跳、桥 mirror
- 席位生命周期:presence 解析、轮换、恢复 runbook、handoff 文件
- 协调者例程本身(coordinator SKILL §1/§5)

## 2. 审查门(在普通双声之上叠加,缺一不清零)
1. **双声 0 REMAIN**(本仓现行)——不变。
2. **故障注入清单逐项有夹具**:每件 liveness 件送审信必须列「它防的故障 → 注入方法 → 期望」,审查席对每一行**跑一次**,不是读一次。最少覆盖:进程死(kill -9)/ 进程活但不推进(kill -STOP)/ 读错(EIO、文件缺、权限)/ 对端不答(超时)/ 双起 / 时钟倒退或 mtime 不变。
   - **夹具安全(机械门,2026-10-16 事故后)**:`scripts/run-selftests.mjs` 在跑任何 selftest 之前做 lint —— 文件里出现按模式杀进程(`pkill -f`,含 `spawnSync("pkill", ["-f", …])`),或出现本机任何活 sid(`~/.agenthop/presence/*.pid` 的文件名 + `roles/coordinator.sid`)⇒ 整轮 RED、一个都不跑。夹具只用虚构 sid;杀进程只杀自己起的 pid。来源:一个 selftest 的清理步骤 `pkill -f <live sid>` 杀掉了在跑的协调者。
3. **FC-2 逐行审**:每个「判恢复 / 判死 / 判空闲」的分支,审查席指出它在 UNKNOWN 输入下的走向;任何「读不到 ⇒ 当作正常」直接 P1。
4. **投递先于记账**:所有「已通知 / 已告警 / 已唤醒」状态,只能在至少一路投递成功**之后**写;审查席用全败夹具验。
5. **预算有上界**:每个 sweep 步整轮总时长有常量上界且写在代码旁,审查席用 N 倍规模夹具验(今日 PW-SWEEP-BUDGET 即此类)。
6. **一次 12 小时无人值守实跑**(soak):并 main 并装机后,协调者在当晚起 soak,次晨对表 §3;**没过 soak 的 liveness 件不算交付**,PROGRESS 里标「并入未验收」。

## 3. 验收(soak 对表,次晨协调者填)
| 项 | 证据 | 过/不过 |
|---|---|---|
| dispatcher 全程同一 pid 或被看护重拉且无断档 >10s | dispatcher.log 行时间连续;dispatcher.launch.log 重拉记录 | |
| 协调者每周期 beat + PROGRESS + handoff 三者 mtime 夜间无 >2h 空洞 | stat 三文件;PROGRESS 周期号连续 | |
| 角色箱夜间最老 unclaimed <1h | inbox-sentinel 零 STALL 行 | |
| 审查席夜间收到的每封送审信 ≤30min 内有 assistant 输出 | transcript 时间 vs 箱 ts | |
| 桥 agents.json tick 每 5s 前进,夜间无 >60s 冻结 | sweep tern-bridge 行;L5 reload 次数 ≤2 | |
| Carly 心跳夜间零 failed | schedule.json runs | |
| 夜间每一次 harness/工具拒绝都有「换路径」后续行 | PROGRESS grep 拒 | |
| 零次需要 user 介入才解开的卡点 | PROGRESS / S19 记录 | |

任一不过 ⇒ 开根因单(同 long-run-liveness-brief 格式),修完再 soak。

## 4. 协调者义务
- 这一级的件由协调者**亲自跑一遍故障注入清单**后才并(不只看票)。
- 每晚睡前检查:dispatcher pid 活、SWARM_TERN_BRIDGE 与装机版本一致、handoff 刷新、角色箱空、Carly 心跳 active;写 PROGRESS 一行「夜班起点」。
- 次晨第一件事填 §3 表,再处理任何新信。
