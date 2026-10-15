# Tern+OMP 全面采用总图(user 裁定「全部利用起来」)

- 日期: 2026-10-14;协调者 fe0376cd 汇总;user 已裁方向,分件实施各走审查门
- 事实基座: 镜24 @08351a3 + user QA @2a5ca5f + spike r1-r4(ab538c0,候 r5 终收)+ Carly 四实验+V 批(PROGRESS #836-#855)
- 原则: 蜂群 durable=唯一真理源;Tern 全家=手脚/缓存/人机面;每件独立送审,herdr 全程在位回退

## A. 立即可用(实证已齐,实施单可开)

| # | 件 | 用的 Tern 能力 | 蜂群收益 | 实证 |
|---|---|---|---|---|
| A1 | agents-bridge 插件 v1 | cx.agents+tern.fs 文件控制面 | 蜂群 bash 读 agent 态 | spike 原型+r4 修法 |
| A2 | 免模型巡检哨兵 | carly.schedule promptless check+session:read | 1 分钟级全席读屏,零模型钱 | V1+实验② 8.65ms |
| A3 | OSC 9;4 alert 通道 | 席位 wrapper 发 OSC→pane.alert | 非 ACP 席「需要关注」信号 | V6 对照实验 |
| A4 | 审查队列 board | cx.board 四泳道 | Needs-human=静默停滞显形 | 实验③ |
| A5 | 发布 runbook 卡 | board subtasks+check 验 artifact | 批-五步机械化(三次漏步的解) | 实验④ |
| A6 | 协调者冷启动画布+快照 | canvas+Markdown 双写 | 继任单屏热记忆 | 问⑥ P4(画布跨重启待 V3) |
| A7 | Carly 对话官接线 | HEARTBEAT 慢道+swarm-carly-send 快道+MEMORY 投影 | user 自然语言入口+SLA 提醒 | 通道已实证(#836) |
| A8 | 蜂群导出四组 | tern.carly.export(观测/账本/信使/呈批) | 她人话调蜂群,R16 编进函数签名 | #853 清单 |

## B. 验证后可用(单项待验,不阻 A)

| # | 件 | 待验门 |
|---|---|---|
| B1 | ACP 块席位(迁移主路) | Codex ACP 未证;wait() 实调;会话恢复/hook 在 ACP 形态的行为 |
| B2 | chrome 标签状态(席位状态进 tab 标题) | V2:格式化器 kv 缓存过期行为(需插件上下文实测) |
| B3 | SQLite 账本投影(verification-ledger→cx.db) | 并发写(WAL/锁)语义 |
| B4 | notebook 晨报(每日重跑可重现) | 基本可用性(文档面成立) |
| B5 | tern web serve 随处批准 | 认证/安全;与 TG bot 并行评估 |
| B6 | 多机(remote host 读远程 pane) | V4 不可测;待有远端 VM 实验 |
| B7 | omp 观测富集席(dialog-officer peer-seat 载体) | 纪律兼容性首单试 |

## C. 设计定稿(已裁,随 A/B 落地)

- 三层分工: 插件=手脚(零模型)/蜂群=脑子/Carly=嘴+记忆(#852)
- 职责表: 对话官=秘书(答传提醒递签),协调者=车间主任(派审并账);秘书不进车间(#854 前问)
- 重叠区分配律: 确定性活归插件;语义活按触发方分(#854)
- 五记组合拳: 三层哨兵塔/双声观测/晨报制作播报分离/呈批闭环/继任热记忆(#854)
- 六纪律: 投影主权/双写隔离(swarm 标记区块)/R16 同文/位次表/角色地址(~/.agenthop/carly/)/四链路
- 席位信号三路: ACP(waiting_input+surface)>OSC 9;4 alert>process+读屏合成;全进 seat-driver tern 驱动
- 风险对冲: Tern closed beta⇒herdr 代码路径保留;seat-driver host:"herdr"|"tern" 按席选

## D. 实施序(协调者建议,候 user 核)

1. **第一批(本周)**: A1+A2+A3(信号三路齐)→A4+A5(board 两卡)——全零模型成本件
2. **第二批**: A6+A7+A8(Carly 对话官全链)+B7(omp 席试点=dialog-officer 激活)
3. **第三批**: B1 验证(ACP 席位试点一席)→过门则 seat-driver 切换试运行
4. **随时**: B3/B4 顺手件;B5/B6 候条件

每件走正常审查门(S11/双声按级),不因「工具件」降标。

## E. 验收北极星(user 定纲 2026-10-14)

「像统一整体,仿佛蜂群是 Tern 的原生能力」。接缝不可见四标尺:
1. 在 Tern 里看蜂群(board/canvas/db/notebook)零命令行;
2. Carly 答蜂群问题如答 Tern 自身问题(导出四组+投影记忆);
3. 席位状态走 Tern 语义层(cx.agents/alert/OSC),读屏仅兜底;
4. 蜂群动作可从 Tern 侧发起且全部走正门(swarm_send/呈批,R16 编进函数签名)。
每批交付以此四条自检;全四条达成=tern 线完工。

## F. 四层架构(user 定形 2026-10-14)

```
第四层  user(唯一授权源)
第三层  Carly = 对话官(答/传/提醒/递签 + 项目总机)
第二层  Tern 原语层 = 共享手脚(board/canvas/db/agents/alert/schedule),无自有状态
第一层  蜂群 = 脑子+账本(durable 真理源)
```
底线标尺: 每层可独立死掉(Tern 挂→herdr 续;Carly 挂→user 直说;蜂群挂→fleet-recovery)。接缝全部单向、可断、可替。

## G. 对话官项目总机(user 新增职责 2026-10-14)

对话官第五职责=**项目总机(switchboard)**: user 说「继续做 X 项目」→她查项目注册表→发现该项目协调者不在→**唤起协调者**(仅此一个动作)→协调者自己跑 fleet-recovery 带回全体成员→持续推进。
- 注册表: ~/.agenthop/projects.json(项目名→{repo,coordinator-sid,resumeCmd,fleet-snapshot 路径});蜂群维护,她只读。
- 她的动作边界: **只唤协调者,绝不直接唤成员/派活**——恢复编制是协调者职权(fleet-recovery 双声件),她碰成员=越层。
- 唤起方式: herdr/tern 开一个 pane 跑注册表里的 resumeCmd(她有 process/run 能力),或经 swarm-carly-send 给已活协调者投「user 令继续 X」。
- 多项目并行: 每项目一个协调者 sid+独立 durable 根;她的注册表是唯一跨项目视图——对话官是跨项目的,协调者是单项目的。

## H. 迁移门清单(Carly 作为 Tern 侧验收权威,2026-10-14 五门判定)

| 门 | 判定 | 放行条件 |
|---|---|---|
| G1 席位可观测 | READY-COND | 每次 Tern 更新后跑冒烟套件(ACP 块→权限→surface→deny)再放席位;盯 release_notes+help() 类型 diff |
| G2 程序化批拒 | READY-COND | 首选 cx.session:event 对 layer.permission 节点发 action-click(Carly 指路,M3 在验);send_input 兜底 |
| G3 插件跨更新 | NOT-READY | 关 auto_update 改受控 restart_to_update;更新后验插件再放行 |
| G4 重启恢复 | READY-COND | 幂等复活脚本(席位清单=我方文件为事实源,不靠 Tern 布局);=swarm-recover tern 驱动版 |
| G5 Carly 可用性 | NOT-READY(作唯一 SLA) | 关键截止 Tern 外后备(协调者 cron/TG);她=有人值守第一道提醒 |
横切: 发信人无身份(呈批一次性码)/check 悄停用需监控/迁移期自动化与她的窗口分离。
验收三方: Tern 侧=Carly;蜂群侧=审查链;整体放行=user。

## I. 两壳合一的目标形态(user 定向 2026-10-15:「在 Tern 中集成 ACP、TUI、herdr 的优势」)

**原则(#1043)**:ACP/TUI、Tern/herdr 取长不选边。每家强项补一格,不做「替代」讨论。

| 强项 | 来源 | 补哪一格 | 落地件 |
|---|---|---|---|
| 控制面:cx.agents ask/wait/start/stop、结构化权限、Lua API、session/tab 组织、remote | Tern | 常驻席位的驱动与审批 | #1034 agenthop_tern 原生工具(真机验过) |
| 结构化状态(idle/working/waiting_input) | ACP | 状态板、哨兵、sweep 的输入 | 八席位现状 |
| 子 agent 原生画面、一进程多子省资源 | TUI | 席位扇出 worker 时的观测与成本 | #1040 TUI worker 形态(kind=tui start) |
| 读屏分类器(17 agent manifest)、PTY 级观测、agent list/wait/prompt socket API | herdr | TUI 块的 idle/working/blocked;herdr 壳内 worker 的控制面 | #1041 分类器翻译进 A2 sentinel;herdr.ts 后端(已有) |
| 子 agent 起止事件 | Claude hooks | 补 TUI/ACP 都看不见的子 agent 生命周期 | #1042 钩子 → writeInbox 到父席位([tested]) |

**拓扑(实测 2026-10-15 12:50)**:herdr TUI 客户端可作为 Tern 的一个块运行(`tern new tab work -- herdr`),Tern 读屏可见其 agents 面板与 pane 内容;herdr server 常驻,socket API 从任意进程可调。因此:
- **ACP 席位住 Tern**(控制面走 cx.agents / agenthop_tern)。
- **TUI worker 可住 herdr**(控制面走 `herdr agent prompt/wait/read`,观测走 herdr 自带分类器),herdr 客户端嵌在 Tern 的一个 tab 里给人看;或住 Tern 裸块(观测走 #1041 移植的分类器)。
- **两边的真理源都是耐久箱**:派单、回执、子 agent 起止全部 writeInbox;壳只负责「跑」和「看」。
- seat-shell/<sid>.json 记每席位所在壳,inbox-wake 按壳路由(feat/inbox-wake-tern)。

**Tern 原生没有的(已核 docs + Carly,~/.agenthop/carly/tern-native-capabilities-answer.md)**:TUI 状态检测器;子 agent/父 id 任何字段或事件;pane 状态写入口;窗口后台定时器 opt-out。**Tern 有而需用对的**:`tern.carly.tasks()/cancel()`(Lua 有 CLI 无);`tern.kv` 跨半/跨窗口共享;host half 常驻 2s 预算(但 cx.agents 为 window-only);ACP 块状态由程序自发 OSC 9;4 驱动(文档原话)。

**放置模型(#1039)**:session=集群/项目;tab=长期席位(英文角色名);block=worker。默认 split 到调用席位 tab;扇出 >4 才同 session 新 tab;独立子项目才新 session;绝不按席位开 session。
