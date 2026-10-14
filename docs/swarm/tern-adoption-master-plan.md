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
