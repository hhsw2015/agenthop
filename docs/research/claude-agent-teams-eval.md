# Claude Code 官方 Agent Teams 对表 — 吸收评估（S14，owner 90b58f9c，2026-10-08）

源：https://code.claude.com/docs/en/agent-teams（逐节精读）。对照我方蜂群：协调者、成员、板+耐久箱、roster、继任、S14 派单、herdr 观测。官方特性=实验、默认关（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）。

## 结论先行
结构上我方几乎全面领先（角色抽象／DAG 任务模型／F40 寻址／对抗审查／会话恢复／文件域所有权／herdr+viz 观测），且在**反授权洗白**上与官方**独立收敛**（他们分类器判「转述批准=不可信」，我们 R16+C8 HMAC cap 更进=结构强制）。他们**实践**领先三处：①已接线上线（我方板准入等件 dormant）；②任务生命周期钩子；③停机 teammate 同会话唤回。最大**有意分歧**：官方允许 user 直接对任意 teammate 说话，我方单线拓扑宪法禁止（是立场，非缺口）。

## ① 逐特性三判
| 特性 | 官方 | 我方 | 判 |
|---|---|---|---|
| 身份／角色 | lead+teammate，角色=活 session | 协调者+成员，角色=抽象（本体+笔记本+任期） | 我强 |
| 任务表 | 扁平 list+deps+文件锁领取 | brain DAG（readyTasks+accepted 递归）+板+单飞锁 | 模型我强；**他强=已接线，我板准入 dormant** |
| 消息 | mailbox JSON／校验丢坏条／写成功=已发 | 耐久箱+总线+F40 稳定寻址+隔离检疫 | 我强（他「写成功=已发」=我 I3 欠口最小形） |
| 反授权洗白 | 转述批准=不可信+被拒不可转他人 | R16+C8 HMAC cap（转述不带=验不过） | **独立收敛，我更进（结构强制）** |
| 任务依赖解阻 | 完成即自动解阻 | readyTasks currentAccepted 递归 | 我强 |
| 会话恢复 | **不恢复 in-process teammate（限制）** | roster+swarm-resume(F36)+继任+F42 保旗 | **我强（大）** |
| teammate 唤回 | 发消息唤回停机者+复原对话（同会话） | swarm-resume 从 roster 重启 | 他强（同会话顺滑），但不跨 /resume |
| 生命周期钩子 | TaskCreated/Completed/TeammateIdle（exit2 拦+反馈） | 对抗审查+免疫（F→回归→CI 红） | 他强（轻量机械门），我强（重正确性门） |
| teammate 计划审批 | **lead 自动批、不审（弱）** | 对抗审查 0/0 签收 | **我强** |
| 空闲通知 | idle 即通知 lead+内联终答 | 完成=耐久产物，observer 自发现 | 互补（他内联终答=我「完成槽待 L2」印证） |
| 模型选择 | prompt>def>env>lead+allowlist 替换 | model-tier（aa-intel 分档）+T3 绑定+served 校验 | 我强 |
| 文件冲突 | 「各占不同文件」（人工建议） | fileDomain／单编辑者／越界撤回（机制） | 我强 |
| 观测 | agent panel+split-pane(tmux/iTerm2) | herdr（工作台/pane/agent）+swarm-viz | 我强 |
| 缓存／成本 | `subagentPromptCacheTtl` 1h 可配 | CPA 账本（modelUsd 欠） | 他强（小） |

## ② 「他强」最小吸收方案
1. **接线上线（非借，翻转）**：板准入 `SWARM_BOARD_ADMIT`＋C8 `SWARM_SEAT_CAPS`＋T5-5 `SWARM_REVIEW_AUTOSCALE` 实现已齐、欠真机接线——这是落后真因（件齐未上线）。归合并门+接线单，0 新码。
2. **轻量完成门钩子（借）**：dispatcher/observer 加 task-completed 机械门（exit2 式：lint/test 未过则拦完成+反馈），置于对抗审查之前作廉价筛。~30-50 行 `scripts/swarm-dispatch.ts`+一个 hook 契约；对抗审查仍管正确性。
3. **完成槽内联终答（印证既有）**：成员 idle/完成时把终答写入完成槽（CORE「完成槽待 L2」）——官方「idle 通知带终答」印证该设计，照建。量=完成槽本体（L2）。
4. **I3 送达三段（印证既有）**：官方「写成功=已发」是 I3 最小形；bus-identity §7 已列 I3 后续，按最小形先落 sent/delivered。量=中（既有设计）。
5. **缓存 TTL 可配（借，小）**：长命成员的 subagent 缓存 TTL 可配（省钱），随 CPA 账本一并落。量=小。

## ③ 与 fanout-native 边界
官方划线：**subagent（fanout，短命）=主体派、各自上下文、结果回主、主管全活、「只要结果」、低 token**；**team（长命协作）=完全独立、共享任务表、自领、互相挑战、「需讨论协作」、高 token**。分界问句=「活儿要不要讨论／挑战，还是只要一个结果」。我方照画且同根：task-plan 的 `runtime: ephemeral|durable` 就是这条线——ephemeral worker=fanout（DAG 拉式、结果回收）、durable 成员=team（板+耐久箱+对抗审查）。我方**另有更强处**：协调者=**压缩层**（DHH：压 user 决策，非延迟跳板），强于官方 lead 的「协调+综合」；单线拓扑（user 只对协调者）替官方「user 对任意 teammate」。

## ④ 跨家约束（吸收项不得绑死 claude 一家）
官方 team 全 claude（Claude Code 实例）。我方跨家（claude+codex,R21），吸收项须家无关：②完成门钩子定义在传输/产物面，不绑 claude 的 `TeammateIdle`（codex hooks 另见 codex-opencode-hooks.md）；③完成槽／④I3 走耐久箱／总线（本就家无关）;C8 cap=HMAC 本就家无关；herdr 观测+swarm-resume 已跨家验证。原则：**凡借的钩子／门／槽一律落在传输或产物面，不绑单厂商生命周期事件**。

## 不借（官方的弱点，勿复制）
lead 自动批 teammate 计划不审（我对抗审查）；无会话恢复（我 swarm-resume）；任务状态滞后漏标完成（我 accepted 递归+两证据面）;user 对任意 teammate 直说（我单线拓扑）。
