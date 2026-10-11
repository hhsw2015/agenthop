# MyAgents / AgentNet 评估:与我们蜂群同类产品,找可学处

owner f32a0507 · 2026-10-06 · 协调者 fe0376cd 派单(S14,普通 tier)· 纯静态研究,未装客户端/未注册账号/未接其云
素材:`github.com/hAcKlyc/MyAgents`(浅克隆 `/tmp/myagents-scan`)· Tauri 桌面工作台+任务系统 · **AGPL-3.0-only**(+闭源/托管需商业授权)
注:AgentNet 云端=**独立私仓 `hAcKlyc/MyAgents_AgentNet`**,账号/Space=`MyAgents_space`——**云端不在本仓,无法自建/审计**;本评估=客户端源码+specs 静态审。

## 结论先行

- **它是什么**:local-first 的 Agent 桌面工作台+任务系统+跨设备网络(AgentNet)+云协作(Space)。与我们蜂群同类,但形态是**单用户多设备桌面产品**,我们是**多 agent 蜂群+总线**。
- **可学处(借,概念级,非代码——AGPL copyleft 挡代码借)**:① Task 的"**定时跑用户检查脚本、只在条件满足才唤醒 AI**"省钱守望 ergonomic;② **IM ingress 到协调者**(晚交代早验收场景)。
- **不借**:AgentNet(我们耐久箱+开源自建已赢面)、Space(内容存其云=出境红线)、整件代码(AGPL)。
- **三处独立收敛(✓ 验证我们设计稳)**:终态诚实、投递纪律、身份与路由分层——两边独立到达同样结论,且 AgentNet **自承无离线排队补投**而我们有耐久箱=我们更前。

---

## ① Task 条件唤醒 vs 我们 dispatcher/sweep/monitor + wait

**MyAgents**:Rust `TaskStore` 持久化权威,`TaskSchedulerController` 从 Running Task 重建 timer。调度=one-time / interval / Cron。核心 ergonomic:**"定时跑一个本地检查脚本,只在条件满足时才唤醒 Agent"**(省钱:高频检查不每次烧 AI,只在"有变化/build 完/服务状态变"时唤醒)。另有 Goal Mode(当前 Session 内持续推进,token_budget/continuation/complete/blocked)。隐藏系统 Task 跑长期记忆维护。**硬约束**:设备必须开机+app 运行才执行(poll 模型;app 全关或休眠不跑)。

**我们**:`wait` = **证据/事件驱动 + 声明式策略**(deadlineSec / timeoutPolicy[bypass|escalate] / defaultOnTimeout / renew[新证据推 deadline] / validationRunId / approval);sweep 监督;dispatcher 派单;**耐久**(control-log + 耐久箱,重启存活)。

**对比(条件描述能力)**:
- MyAgents 的"条件"=**命令式用户脚本**(最大灵活:任何能脚本化的检查),调度=cron;本质是 **带用户谓词的定时轮询**。
- 我们的"条件"=**声明式类型化策略**作用于结构化 subject(liveness 证据/validation 通过/approval/subject 完成),**事件驱动非轮询,耐久跨重启**。
- 谁强:MyAgents 对**临时 ad-hoc 检查**更通用("早上看有没有新素材,有才叫我");我们对**蜂群结构化等待**更严谨+耐久+免轮询。二者是"命令式通用轮询" vs "声明式证据驱动"。

**借**:MyAgents 的"**cron + 用户检查脚本 + 条件满足才唤醒 owner**"是个我们没有一等公民化的省钱 ergonomic。我们的 wait 是给蜂群结构化 subject 的;一个面向用户的"定时廉价检查、有变化才唤醒 agent"值得作为 dispatcher 的一个 **watch-task 类型**自建(cron + 谓词脚本 + 非零退出即唤醒 owner)。概念借,非代码。

---

## ② Channel IM vs 控制台 + 晚交代早验收

**MyAgents**:内置 Feishu/DingTalk/Telegram(+插件扩展),分层=**Rust 持连接(im/:平台连/入站/出站/重连/白名单/群激活),Node Plugin Bridge 跑插件 reply,Rust SessionRouter→Product Session,Node Sidecar 跑 AI turn**。Transport ⊥ AI 生命周期(Sidecar crash 时 Rust 保连接+缓冲)。Channel 按 Agent 维度。

**价值(协调者点名的晚交代早验收)**:"从手机 IM 向协调者交代任务"对我们**高价值**——我们控制台目前只是本地终端,**无移动端 ingress**。一个 **IM→协调者耐久箱** 的瘦 ingress 能让 user 在手机上丢任务→协调者派单→早上回来验收。直接服务该场景。

**借(立项,最小法)**:**IM-ingress 到协调者**,**仅入向 + 协调者作用域 + user opt-in**。最小实现=一个独立桥进程,把 IM 消息写进协调者耐久箱(**正好用 F38 的 `composeInboxMsg`** 产出合法信封)。**出境标注**:IM 正文天然经该 IM 平台服务器中转(任何 IM 不可避免)——这是 user **主动选择**往 Telegram/飞书打字的既定代价,范围限 ingress,**默认不把 agent 输出回传出去**。不借 MyAgents 的分层代码(AGPL),借"IM 当 agent 控制面"这个点子。

---

## ③ AgentNet vs agenthop 中继 + 耐久箱

**架构对比**:

| 维度 | MyAgents AgentNet | 我们 agenthop |
|---|---|---|
| 连接模型 | 同账号多设备,relay 路由;远端=源 Node→Rust Mgmt→App connector→**relay**→目标 owner | 配对码房间,中继**只转发字节不解析** |
| 加密 | 业务内容 E2E;私钥/设备 WSS/内层 TLS 在 App 级 | `seal.ts` E2E seal 在 HopMessage.text 内,中继不参与 |
| 账号/云 | **需账号 + 闭源私有云(MyAgents_AgentNet)**,不可自建/审计 | **免账号 + 开源 + 中继可自建** |
| 离线/补投 | **自承"无离线设备消息队列,重连后不补投"**(目标须在线) | **耐久箱**(claim/ack/release 原子,重启存活,自动补投)+ reconnect/recover + outbox |
| 投递语义 | start/send 返真实接纳不等 AI terminal;**明确失败/已接纳/unconfirmed 必区分,不自动重发;ACK 不明不重复注入,不存 outbox**;in-flight 不承诺跨进程原子撤销 | 同纪律(见独立收敛)+ **且有耐久 outbox/backlog/undelivered 留痕** |

**我们赢面(写实)**:AgentNet **明文自承无离线排队与补投**——目标掉线即送不到。我们的**耐久箱**正是补这个洞(F28 毒件防御 + claim/ack/release 不重投 + 重启存活 + 陈旧 claim 回收)。**连接不可靠/目标离线场景我们完胜**;且**免账号 + 开源自建 + 中继不依赖闭源云**。
**它的边**:同账号设备身份 + 打磨过的设备 roster/在线状态 UI + 业务内容默认 E2E。我们 bus 有身份(X25519)但设备 roster UX 弱。

**借**:架构上几乎无可借(我们在**耐久性+开放性**上已更前)。唯一可借=**设备 roster/在线状态 UI** 概念给 swarm-viz(可选,非必须)。主结论=**确认我们设计更稳,AgentNet 不借**。

---

## ④ Space vs 我们板/任务系统

**MyAgents Space**:Issue 制人机协作 + 共享 Goal + 共享 Skill/工具;**内容存 Space 云服务**(闭源)。Agent 在 Space 注册身份、认领 Issue、本地执行;GitHub/在线文档经工具接入。

**我们**:板(vm-ssh-primitive 板/任务系统)+ 蜂群协调(耐久箱 + 裁定簿 + PROGRESS);本地/仓内,无云。

**对比+出境**:Space 的 Issue/goal/评论/附件/Skill/工具**全存其云 = 内容出境**——撞不出境红线,硬 no。"Agent 注册身份+认领 Issue+本地执行"的模型我们**已有**(owner 认领 + roster + 派单)。

**借**:**不借**(云存储非启动项;认领-执行模型我们已覆盖)。

---

## ⑤ 数据出境面(逐条,按不出境纪律)

| 内容 | 去向 | 判定 |
|---|---|---|
| Agent 执行/工作区/对话/本地 Task/Goal | 本机 | ✅ 本地,干净 |
| 模型请求/外部工具调用 | 配置的模型/工具服务(含所选 context) | 任何 agent 不可避免(我们已走 CPA),非 MyAgents 特有 |
| AgentNet task/results | relay(业务 E2E);**路由元数据**(设备发现/在线状态)过其云 | ⚠ 元数据出境 + 闭源云不可审计 |
| Space 协作内容 | **Space 云服务存储** | ❌ 内容出境,红线 |
| IM Channel 正文 | 经 IM 平台(飞书/钉钉/TG)服务器 | ⚠ IM 不可避免的提供商中转(借②时 user 主动选择) |

未见 beacon 式的遥测/分析上报。**干净面**=本地工作台/Task/Goal/对话;**出境面**=AgentNet(元数据+闭源云)、Space(内容)、IM(提供商中转)。

---

## 借 / 不借(汇总)+ 最小借法

**借(概念级,自建,零 AGPL 代码)**:
1. **① watch-task ergonomic**:dispatcher 加一个"cron + 用户谓词脚本 + 条件满足(非零退出/信号)才唤醒 owner"的任务类型。省钱守望,补我们"用户向 ad-hoc 廉价检查"的空档。
2. **② IM-ingress 到协调者**:瘦桥进程,IM 消息 → 协调者耐久箱(用 `composeInboxMsg`);仅入向+协调者作用域+opt-in;标注 IM 正文经提供商中转(user 自选)。直接服务晚交代早验收。

**不借**:AgentNet(耐久性/开放性我们已赢;闭源云)、Space(内容出境)、整件代码(AGPL copyleft 会传染我们仓)。

**✓ 独立收敛(验证我们既有设计,非新借)**:
- **终态诚实**:MyAgents(Goal complete/blocked 须真;idle≠成功;消息封口≠执行成功;terminal 取真实 turn.status)≡ 我们 §0b erratum(resolved 只来自真 close;action_done 不冒充 resolve)+ occurredAtSec/status-gated capture(completed≠live)。**两边独立到达"模型自停/token 上限不得冒充终态"。**
- **投递纪律**:MyAgents(接纳≠terminal;区分 accepted/unconfirmed;不自动重发;ACK 不明不重复注入;无 outbox)≡ 我们 bus/inbox(claim/ack/release 不重投;outbox undelivered/backlog;F28 毒件防御)——**且我们多一层耐久离线队列他们没有**。
- **身份与路由分层**:MyAgents(transport 用稳定 selector,显示名仅 UI)≡ 我们 bus identity(stableId vs display label;地址由密钥派生)。

---

## 建议(供协调者/user 裁)

1. **不采用 MyAgents**(同类但桌面单用户形态;AgentNet/Space 撞出境+闭源云;AGPL 挡代码借)。
2. **立两个借项(概念自建)**:① dispatcher watch-task(cron+谓词脚本+条件唤醒);② IM-ingress→协调者耐久箱(opt-in,经 composeInboxMsg)。②直接解晚交代早验收痛点,价值最高。
3. **记一条信心**:AgentNet 自承无离线补投、我们有耐久箱——跨机可靠性我们已领先,继续走开源自建中继+耐久箱路线,不引入其闭源云。

> 方法学声明:静态代码/specs/README 审;未装客户端、未注册账号、未接 AgentNet/Space 云、未碰其运行时;云端私仓(MyAgents_AgentNet/_space)不在素材内,其实际转发面无法二进制级审计,已按文档+客户端边界逐条列出并标注。
