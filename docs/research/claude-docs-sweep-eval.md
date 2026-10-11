# 官方 Claude Code 文档全域扫表 — 吸收评估（S14，owner 90b58f9c，2026-10-08）

源：https://code.claude.com/docs/en/ 各能力域（逐篇精读）。对照我方蜂群基建。方法承 `claude-agent-teams-eval.md`。已对过域（subagents/skills/hooks/workflows/agent-teams）跳过。纯研究。

## 结论先行
两个深挖域（cross-session-messaging、agent-view）我方**结构**领先：F40 稳定身份+别名表+whois、耐久箱 claim/ack/隔离检疫、S11 七字段结构信封、死等哨兵、swarm-viz（看板+泳道+worklog 时间线）、T5-2 双带宽、C8 HMAC——都胜其对应件；且**反授权洗白与官方逐字独立收敛**（他们那段「另会话消息≠你的同意/不能批/不改配置/命令不执行/转述批准=不可信/被拒不可转他人」=我 R16+每封信脚注，我 C8 更进=结构强制）。他们**真有我无**的机制集中在几个小而准的点（下列），吸收杠杆见终节。

## ② 深挖 cross-session-messaging（对我 bus/耐久箱/F40/R21）
**送达语义**：三态 `Delivered/Held/Refused`；「写入收件箱文件成功才报已发」（=我 I3 最小形，我 I3 未建）；循环节流（同发送者去重+每发送者限速+队列≤50 自停环）；尺寸上限~1M、突发在**发送端**先拒。无 read-ack（发送方只知写成功，非已读）。

**身份寻址**:`--name`/`/rename`/自造名+`/list-agents`+同名加短 ID+工作目录消歧；跨机经 Remote Control。弱于我 F40（他靠名+目录+短 ID 消歧，我持久 entityId 抗漂移）。

**权限边界**：每会话独立；`crossSessionInbound: accept|hold|refuse`;`isolatePeerMachines`;`dialogExpiry`。

**他有我无（逐条）**:
- `notify_when_idle`：订阅「对端下次 idle/exit 时一条通知」，12h 过期，纯订阅零开销。我有死等哨兵（查滞留），无**正向 idle 订阅**（近我 wait_peer 但未建为耐久订阅）。
- **权限模式感知入站门**:bypass 模式发送者→prompting 接收者的消息**挂起待 user 批**；模式变则重放释放。我耐久箱不分发送者模式一律投。
- **消息环去重+队列上限**（同文去重/≤50）、**发送端预拒**（超限不出门）、**own-child 可信**（自子进程 hook 回投本会话免门）。

**我强他无**：结构信封（S11 七字段；他跨会话仅纯文本）、耐久 claim/ack/quarantine（他 hold 上限 100 丢旧）、死等哨兵、whois、C8 cap。

## ② 深挖 agent-view（对我 herdr+swarm-viz+status-digest+T5-2）
**形态**：按状态分组的**平表**（非树；子代/teammate 不单列行），组序「需输入在顶→working→completed（折叠）」；`claude agents` TUI+supervisor 守护（背景会话脱终端存活）+`claude agents --json`。

**他有我无（逐条）**:
- **廉价每行活动摘要**:Haiku 级模型从会话近期输出写一行（≤15s 一次、**不发模型请求**、turn 末刷新）。我 status-digest 压事件，无每成员**实时一行**。
- **需输入在顶的分组排序**：直服「user 一屏分诊」。我看板三列未按「待 user」置顶。
- **Peek 面板**（Space 瞥近期输出/待答问，不整体 attach）：我 herdr read/explain 部分覆盖。

**我强**:swarm-viz worklog **时间线**（他明言无 replay）、泳道、T5-2 双带宽（他不测 user 决策带宽）、herdr 真 pane attach+explain+哨兵状态流。三判：观测总体**我强/互补**，借其三小点。

## ① 其余域三判 + 最小吸收
| 域 | 官方 | 我方 | 判 + 吸收 |
|---|---|---|---|
| sessions | `--resume/--continue/--from-pr`+名解析+resume-from-summary 对话 | swarm-resume（F36）多成员名册恢复+继任 | 我强（他只恢复单会话，teams 不恢复 teammate）；借 resume-compact（长恢复省 token，小） |
| memory | CLAUDE.md(proj/user/org+`.claude/rules/`)+auto-memory（自写学习） | MEMORY.md 索引+分型分文件+链接 | 互补/收敛；他 auto-memory 更自动，我更结构化；不绑 swarm 基建 |
| checkpointing | 每 prompt 快照 100+`/rewind` 码+话+summarize | git commit+control-log 耐久事实账 | 互补（不同层）;`/rewind` 是单会话 undo,swarm 相关低 |
| scheduled-tasks | `/loop`+`CronCreate/List/Delete`+7 天过期+jitter | sweep（到期必处置）+dispatcher 循环 | 我强（sweep 是群级耐久）；借 **jitter**（避免机群同刻打 API，小） |
| permissions | 模式（manual/auto/plan/acceptEdits/dontAsk/bypass）+allow/deny+folder trust | R3（可撤即自主）+三门+代理权+C8 cap | 我强（swarm 级授权更富）；他 auto 分类器≈我 R3，互补 |
| mcp | 外部工具/资源连接层 | 总线做 agent 间，MCP 做外部工具 | 不同层，无冲突；不借 |

## ③ 跨家约束（吸收落我基建层，不绑 claude）
所有吸收项落传输/产物/调度面，家无关：idle 订阅/入站门走耐久箱+总线（codex 成员同享）;Haiku 摘要走 status-digest 产物面（模型档可配，非绑 claude）;jitter 在 dispatcher tick；需输入排序在 swarm-viz 投影。C8 cap/herdr/swarm-resume 已跨家验证。原则同前：**不绑单厂商生命周期事件或 CLI 专属面**。

## ④ 吸收清单（杠杆排序，供 user 一屏裁）
1. **idle 订阅**（`notify_when_idle` 式）：成员完成→一条耐久通知，替轮询/补哨兵正向面。中值小建，~bus/inbox 40-60 行。服 self-driving 北极星。
2. **viz 需输入置顶 + 每成员 Haiku 一行摘要**：直服「user 一屏分诊」=T5-2/控制台目标。中值小建，~swarm-viz 投影排序 + status-digest 一行生成 30-50 行。
3. **权限模式感知入站门**:bypass 发送者消息挂起待 user 批。安全硬化；我全可信成员+C8 已覆大半，中低值。~inbox 40 行。
4. **调度 jitter**:dispatcher tick 加确定性偏移，避免机群同刻打 API。小，~10-20 行。
5. **消息环去重**：耐久箱同文去重+队列上限，robustness。小。
6. **resume-from-summary**：长成员恢复时可选 compact 省 token。小。 不借（其弱点/不对口）:`/rewind` 单会话 undo、auto-mode 自动批（我 R3 已策略覆盖）、名+目录消歧（我 F40 更强）、teams 不恢复 teammate（我 swarm-resume 已强）。
