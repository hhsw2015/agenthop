# bus 身份与投递可靠性:根治立项(identity-reliability)

日期:2026-10-03。性质:**立项书 + 需求冻结候选**(user 指示「这些问题都要彻底解决」;按 R4 走:设计 → 对抗审查 → 冻结 → 实现)。owner:bus 轨(Work-20cab0a5 的地盘,单编辑者)。本文档 = design 节点的输入。

## 1. 问题清单(全部有今日实锤,dogfood 编号)

| # | 问题 | 实锤 |
|---|---|---|
| I1(F1) | 身份漂移:同一会话的句柄/run id 随 cwd/重启变,≥6 次实测 | Work→swarm-brain-io 前缀漂移;Codex 三换 run |
| I2(F2/F5) | 裸 run id 不可回复;双通道双身份,发错即失联 | 多次 No session matches;Codex 原话「from 无法匹配 peer」 |
| I3(F11) | 投递成功 ≠ 送达 ≠ 开工,三者无区分信号 | viz 渲染单:两轮通知对一个从未在听的对象 |
| I4(F16) | 发送无预检:发给 unknown 态/错误类型的收件人,静默入队 | a3def7c0 审查单;sign-off 对象误述 |
| I5(F17) | 活性判定无权威:弱谓词假阴性,活的被判死 | happycapy「零进程」误判;坏验证自信地错 |
| I6(新) | **人也定位不到实体**:多套 ID(thread/run/session/句柄/pid)互不翻译,无查询入口 | user 本人拿 01a0ead5/673c6525 无法定位 |
| I7(F14 关联) | presence 条目死后滞留/状态失真,unknown 含义过载(死?没 hook?刚起?) | 名册 unknown 行无法行动 |

## 2. 根治目标(验收形态,全部可失败)

1. **whois 查询**:`agenthop whois <任意 id|句柄|pid>` → 实体全部身份面 + 活性(pid 实测,非字符串谓词)+ 可回复句柄 + 最近产出时刻。人与 agent 同一入口。验收:用 I6 的两个真实 id,user 一条命令定位。
2. **身份别名表**:每实体一条权威记录,所有 ID 面(thread/run/session/handle/pid)互为别名,漂移=追加别名不换实体;roster 行显示别名集。验收:漂移后旧 id whois 仍中。
3. **稳定 reply-to**:信封带保证可回复句柄;resolvePeer 接受任意别名。验收:对历史消息的 from 直接回复 100% 可达(今日失败案例回归)。
4. **send 三段信号**:sent(入队)/delivered(对方 harness 收)/acked(对方回执)——发送方可查;sendPrecheck:目标不可达/类型断言不符即拒发报错。验收:I4 场景重放被预检拦截。
5. **活性权威**:liveness = roster pid + kill -0(或等效),三值 alive/suspected/dead(dead 需双证据面);presence 死条目 TTL 清除或标 stale。验收:I5 场景(活的 Codex)任何查询面都不给出 dead。
6. **unknown 拆义**:no-hooks / starting / stale 三态取代单一 unknown。验收:今日名册的每个 unknown 行能说清自己是哪种。

## 3. 边界

- 不动已冻结的 brain/team-collab 协议(wait.verify/sweep 判死规则引用本文结论,字段形状不变)。
- 不要求跨机(AGENTHOP_TEAM 场景照常工作即可,深度跨机身份归后续)。
- 实现顺序 bus 轨定;但 whois+别名表(I6/I2)是其余一切的地基,必须最先。

## 4. 流程

R4 设计门:bus 轨出设计(本文为需求输入)→ Codex 对抗审查 → 冻结 → 实现 → 今日七个实锤场景全部作为回归验收。期间协调层以 F16/F17 的人肉纪律(双证据判死/发前 wait_peer 预检/近因原则)顶住。
