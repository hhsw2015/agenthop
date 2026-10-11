# Maestri 概念辞典（第十面镜 续：全文档通读）

owner f32a0507 · 2026-10-09 · 协调者派单（user 亲令：「把他的文档全部过一遍，了解学习他那些概念，再来动手」，画布实现前置）· 续 maestri-wire-eval.md（协议层）· 本篇=概念层 · 来源 themaestri.app/en/docs 全站（intro/workspaces/canvas/terminals/connections/notes/ficharios/partituras/floors/chat/prompt-composer/maestro/file-tree/portals/routines/environments/ombro/batuta-search，2026-10-09 通读）· 零安装纯研读

## 0. 范式与读法

Maestri 自述：「agentic AI 时代的新生产力应用」「它是环绕你 agent 的画布与编排层」「Maestri 本身不是 agent」。心智模型=无限 2D 空间画布，终端/agent/笔记/文件/草图都是画布节点，人手摆布+连线，解决「多 agent 散在一堆标签页/窗口里看不过来」。与我方正交点：它赌**空间**作组织隐喻，我方赌**任务图+单线问责**（R21-b/S21）。四象限（见 wire-eval ⑦）：herdr=空间无语义、console=皆无、swarm-viz=语义无空间、Maestri=空间+**人工**语义；无人占=空间×**系统派生**语义=我方机会。本辞典每概念给：定义／解决什么／我方对应物／判（借｜不借｜改良）；末节=画布实现概念地图（aad02248 设计输入）。

## 空间容器层

**Workspace（工作区）** 定义：项目容器=工作目录+图标+保存的画布布局+终端位置+agent 指派+CLAUDE.md/AGENTS.md。解决：秒级续上+快速切项目。我方对应：无直接等价；最近=一台机器的 herdr workspace（S14）+repo 根；「布局记忆」我方无（无空间）。判：**改良**——我方 workspace 概念可补「每项目一份只读视图状态」，但不引入可写布局。

**Canvas（画布）** 定义：无限 2D 空间，终端/笔记/文件树/节点随意摆；「没有对错布局，画布迁就你的思维」；位置主要是**装饰/组织**，唯一语义层=连线（可确定性遍历）。我方对应：swarm-viz（拓扑无空间）/console（列表）/herdr（网格无语义）。判：**借只读投影，不借可写画布**（冲突 S21 单线+R22 看板）。头号借项，详见末节。

**Node（节点）** 定义：画布上一切可插入物（Terminal/Note/Text/Drawing/File Tree/Portal/Partitura），统一的移动/缩放/复制/删除/锁/组。我方对应：无统一「节点」抽象；最近=board 任务项/roster 席位/swarm-viz 图节点。判：**借抽象**——canvas 视图需要一个统一节点模型（agent 节点/任务节点/楼层节点），映射我方既有实体。

**Floor（楼层）/ Ground** 定义：平行工作区=各自 repo 检出+各自分支（默认 git worktree，或 independent copy 克隆含 .git）；copy-on-write 秒开；Ground=主工作区不动，楼层把活 land 回（merge 或 PR）；land/delete 永远从 Ground 的终端跑。解决：并行开发/审 PR/试险招而主线不脏。我方对应：**worktree（我方 EnterWorktree）+placement floor**；Ground=main。判：**概念已有**（我方 worktree=floor，placement 管楼层）；借 UI 呈现（3D 楼层总览→我方多 worktree 可视）。

**Floor Status（楼层状态）** 定义：agent 贴 {working｜blocked｜review｜done}+短句+进度，显示在楼层 pill/侧栏，需人时通知。我方对应：**board 任务状态+roster presence+review-queue**；floorStatus 枚举≈我方任务态。判：**借枚举对齐**——我方状态词对齐 {working/blocked/review/done} 便于画布着色。

**Environment（环境）** 定义：终端在哪跑=Local/tmux/WSL/SSH/Docker/Sandbox/Custom；是 workspace+terminal 模型的一部分（技能/CLI/角色/招募/楼层都随环境走），远程类全 attach-only（生命周期归外部工具）；Bridge Port 7433，每远程终端一 ID+一 secret token。我方对应：**vm-ctl/vm-ssh（后端无关机器管理）+herdr backend（HERDR_ENV）**；attach-only≈我方 adopt；per-terminal token≈C8 cap。判：**概念已有且更深**（我方有快照/继任/回收），不借；可印证 vm-ctl 设计。

## 工作单元层

**Terminal（终端）** 定义：完整交互 shell，agent 跑在里面=「活真正发生的地方」；红色 attention dot=停输出（等决策或完成）；每终端独立主题/外观。我方对应：**herdr pane/席位 seat（C8 身份）**。判：**对应已有**；借 attention dot=类型化需注意态（见 wire-eval ④）。

**Agent + Role（角色）** 定义：role 把每终端指令在 agent 启动时自动注入=在带自己 CLAUDE.md/AGENTS.md 的项目子目录起 agent；portable `role.json` sidecar 跨 workspace/机器随行；例 Lead/Coder/Reviewer/Tester。我方对应：**roleProfile（DA1 v2 片段库+flavor）**；`role.json`≈我方 role 定义。判：**对应已有**（roleProfile 更结构化：片段库去重+flavor 覆盖）；`role.json` 的「sidecar 随目录走」可印证。

**Chat（对话）** 定义：终端的「第二张脸」，agent 用话回而非 Maestri 刮屏（「无 tool call/无推理步/无进度条」）；每终端 7 固定色线程槽（色=线程身份，开轮锁定防串台）；线程记录自存=跨重启/换 CLI 存活。我方对应：**chat-room（单线 append-log）+R10 对话官+submit-tag（agent 主动呈 vs 刮屏）**。判：**借「agent 决定说什么」语义**（=submit-tag 方向）；**不借 7 线程槽**（冲突 S21 单线）。

**Prompt Composer（提示构造器）** 定义：浮在终端上的富文本输入；段落=纯文本+@mention（连接的终端/笔记/portal/File…/@Maestro/动作）+#file（工作目录文件，SSH 远程亦可）+粘贴 pill（大段文本内联）；每终端留草稿，仅发送清空；空构造器时方向键/回车透传给终端答审批框。我方对应：**S11 信封+prompt 构造**；@mention 连接体≈taskRef/任务边；#file≈附件。判：**借 @mention/#file 语法**进 console 发问面（Ask），只引用已连接实体=天然权限边界（R21-b 边内可达）。

## 关系层

**Connection（连线）** 定义：物理动画「绳缆」连终端/笔记/portal，**携带功能语义非装饰**——两终端连上 Maestri 装技能给 agent「向任意连接 agent 发/收 prompt」能力，agent「只能够到实际连上的 peer」；跨 workspace/楼层；Rope/Circuit 两样式。我方对应：**bus（R21 原生/总线）+R21-b 通信图=任务图**；「只能够到连上的」=R21-b 默认不可达逐字同构。判：**独立收敛验证我方 R21-b**（Maestri 用连线实现「边内可达」，我方用任务图）；**关键差：Maestri 连线人手画，我方边系统派生**（派单自动建边）——我方更强。

**Cable-tie（线束）** 定义：纯视觉捆扎，「改连线怎么画，绝不改它干什么」。我方对应：无需。判：**不借**（纯视觉）。

**Note（笔记）** 定义：画布上贴纸=磁盘真 .md 文件，agent 经 CLI 读写（含内联图/mermaid）；**锁定**=只读规格，连接 agent「仍读但每次写失败」=「把 spec 交给 agent 又不让它改 spec」；可移到项目路径。我方对应：**roleProfile boundaries/grill-gate 树（只读规格）+docs/角色笔记本**。判：**借「锁定笔记=不可改规格」语义**（=我方 boundaries/契约冻结）；画布只读渲染笔记锚。

**Note-chain（笔记链）** 定义：笔记连笔记成 mind-map，agent 连入口笔记即可遍历整链。我方对应：无；最近=docs 交叉引用/[[链接]]。判：**改良候选**——上下文链可做 roleProfile 片段库的「引用展开」（DA1 已有 use_* 引用），概念印证。

**Fichário（便签栈/卡册）** 定义：把散笔记收进一个带标签页的容器（笔记仍是真笔记=页）；命名的空册**占位不消失**（Backlog/Building/Review/Shipped 当 kanban 道）；连 agent 可读全部页。我方对应：**board 的列（R22 console=任务队列/看板）+chat-room 议题线程**。判：**借 kanban 空道占位**语义进 console 看板列（我方 board 已是看板，补「空列占位」）。

## 编排层

**Maestro Mode（指挥模式）** 定义：把一终端升为**经理**——招募（在自己下方 spawn 连好的新终端+派角色）/接线（把招募连到既有笔记共享真相源）/改派角色改 prompt（位置名字连接留存，仅 agent 进程重启）/解散；@Maestro=「编排这个」；可自建 workspace/floor（权限门：只有 Maestro 或你能建，防野环境）；招募默认建自己副本，自动布局在下方。我方对应：**协调者+T3 planner+placement+autoscale**；recruit=spawn seat/connect=建任务边/reassign=改 roleProfile/dismiss=回收。判：**我方协调者更强**（裁定权/压缩层/分层 R18）；**借 recruit-below 自动空间布局**进画布（招募链的空间呈现）；印证我方 Maestro=协调者单点。

**Partitura（总谱/模板）** 定义：画布布局的**可复用蓝图非备份**——终端+agent+角色+笔记+portal+连线全存一个 JSON（~/.maestri/partituras/）；盖章（drag/双击）即在目标 workspace 重建并**按目标刷路径**；角色内嵌（到达即带可用角色非悬空引用）；盖章会**在你机器上起终端跑命令**；角色按 ID/name 调和。我方对应：**roleProfile 实例化（DA1 片段库+flavor）+T3 plan 模板**。判：**头号借/印证**——partitura=「从命名模板盖出配好的 agent 集」正是 roleProfile v2 的空间表亲+T3 plan 的实例化；借 UX 概念进 roleProfile 实例化面。

**Routines（例程）** 定义：按固定间隔（每 5 分钟/每小时）给指定 agent 终端发 prompt 自动化；`&&` 独行链式（前一完成才发下一）；暂停/恢复/编辑/删除，活跃有实时指示。我方对应：**cron（CronCreate 全 5 字段表达式）+ScheduleWakeup+自唤醒环**。判：**我方已有且更强**（cron 表达式 vs 间隔预设；我方自唤醒环=routine 的通用化），不借；可印证自唤醒环方向。

## 观测与工具层

**File Tree（文件树）** 定义：画布上嵌入文件管理器（List/Icon/Diff/Graph 四视图）；git 操作内置（commit/pull/push/checkout/…）；**diff 视图未选中时跟随 agent**——「agent 每改一个文件就展开滚入视野」=停在终端旁的树变成改动实时视图；内置编辑器。我方对应：无画布文件树；最近=IDE/git CLI。判：**借「diff 跟随 agent 编辑」观测语义**（可投进 console 的 agent 活动面）；文件树本体范围外。

**Portal（传送门）** 定义：画布嵌入窗口=浏览器 portal（隔离 WebKit，agent 经 maestri CLI 点击/输入/导航/截图/跑 JS/读 DOM/读 console）或设备 portal（真 iOS/Android）；design mode=刷选区域发连接 agent「问这个选区」。我方对应：无；最近=maestri-portal 技能本身。判：**不借**（独立浏览器能力，范围外）；记为 Maestri 的 agent-computer-use 面。

**Ombro** 定义：on-device AI 伴随（macOS/Apple Foundation Models，浮窗在 app 外）盯 agent——完成/暂停时给摘要+终端快照预览+建议下一步；读实时终端态答问；可建/追加 Ombro-note 到画布；全本地零云。我方对应：**哨兵 sentinel（降噪后）+dual-bandwidth 仪表+报备**。判：**对应已有**（我方哨兵是服务端巡检，ombro 是本地 LLM 伴随）；借「完成即摘要+建议下一步」进哨兵呈报形态。

**Batuta Search（指挥棒搜索）** 定义：命令面板=键盘优先搜一切（workspace/楼层/终端/笔记/文本/文件/链接/文件树/portal）；fuzzy/不分大小写/去音；选中即跳转；清空显动作（建终端/笔记/…、Ask/Check agent、开 Routines/Ombro）；**Ask…**=给任意终端发消息、**Check…**=只读看任意终端实时输出，皆跨 workspace 不离当前位。我方对应：无；最近=console。判：**借命令面板**进 console（fuzzy 搜 seat/task/worktree+跳转+Ask/Check=发问/只读查）；Ask/Check≈我方 inbox 发问+只读 tail。

**Wire（设备协议）** 定义：见 maestri-wire-eval.md（①远程配对+资质②能力协商③推流④attention 一等态⑤floor/PR⑥安全⑦空间画布）。判：见该篇三栏。

## 画布实现概念地图（aad02248 设计输入）

核心原则：**console 画布视图=我方系统派生任务图的只读空间渲染**（占「空间×派生语义」象限），非可写画布（S21 安全）。位置自动布局（DAG/力导向），不手摆；连线=真任务边非人画；零后端——全读既有投影。

应吸收的概念 → 我方数据面映射源（投影｜字段）→ 画布渲染形态：

| Maestri 概念 | 吸收 | 我方映射源（投影/字段） | 渲染 |
|---|---|---|---|
| Node（节点） | 是 | roster-snapshot（席位 sid/role）+board/task-plan（任务 ID/state）+swarm-viz 投影 | agent 节点/任务节点/楼层节点 |
| Connection（连线=语义边） | 是 | T3 plan dependsOn[]+R21-b 通信图（作者↔审查人边）+force-pipeline stages[]（强制边）+decision-batch | 依赖箭头/派单边/异色强制边（**系统派生自动画**） |
| Node group（节点组） | 是 | decision-batch（合并批聚合）+roster（roleProfile 组） | 批次簇/团队框 |
| Floor（楼层） | 是 | placement floor/git worktree list | 楼层 pill（分支+状态） |
| Floor status 枚举 | 是 | board task-state+roster presence+review-queue | 节点/楼层着色 {working/blocked/review/done} |
| Attention dot（需注意） | 是 | sentinel（blocked）+chat-room pendingPrompt+review attention | 红点+求人态 |
| Note（只读规格锚） | 部分 | roleProfile boundaries+grill-gate 树+docs | 只读笔记锚（锁定=契约冻结） |
| Fichário/kanban 道 | 部分 | board 列（R22 看板）+空列占位 | 看板列（空列占位不消失） |
| Partitura（模板盖章） | 是（入 roleProfile） | roleProfile v2 片段库+flavors | 从命名模板盖出配好 agent 集 |
| Maestro recruit-below 自动布局 | 是 | 协调者派单链+placement spawn | 招募链空间下挂 |
| Presence（只读共视） | 是 | console 只读投影共享 | user 与协调者看同一张图（弃协同光标） |
| Batuta 命令面板 | 是 | roster+board+worktree 索引 | fuzzy 搜+跳转+Ask/Check |
| 双带宽/Ombro 态 | 已有 | `gauge.json`（bandwidth-gauge/v1） | 仪表叠加 |
| Cable-tie/Portal/多线程 Chat/可写画布 | 否 | — | 不吸收（纯视觉/范围外/冲突 S21） |

落地建议：画布视图=console 前端增强（归 aad02248/3e097dfe），读上表投影零后端；首切=节点（席位+任务）+系统派生连线（依赖/派单/强制边）+楼层 pill+attention 红点，即得「直观理解协调」主价值；partitura→roleProfile 盖章、Batuta 面板、只读共视为次切。

## 边界/非目标

纯文档研读，未起 Maestri、未抓包，beta 字段可能变（来源自述）。shortcuts/troubleshooting/maestro-mode 的键位细节略。我方对应据既有实现（herdr/console/swarm-viz/roleProfile/placement/cron/sentinel/chat-room）比对，非上游逐字。本篇只给概念对表+画布概念地图，不改任何代码/契约；实现动手归 aad02248。
