# agent-console 参考选型评估(2026-10-05)

对象:① **agent-orchestrator**(OrchestratorInc,12.8k★,Apache-2.0)② **paseo**(getpaseo,19.6k★,Apache-2.0,user 点名)③ **OpenDots**(CopilotKit,3.4k★,**MIT**,user 补点名——最正对口)④ 自选 **Open WebUI**(154k★,本地 serve 参照,非标准 license)。
基线:docs/swarm/coordinator-console-brief.md(**S21**):单线拓扑宪法(user↔协调者一条线,界面=那条线的视觉身)/ 富媒体卡嵌 S16 产物 / 呈批交互卡回写 / 本地单页零云 / 语音走 CPA 实时。
重点:前端形制(对话流+卡片+看板+交互卡回写)与本地 serve 栈,对 v1 有多少直接可抄;违反单线宪法的记不借+理由。

## 零、三者前端形制/栈逐项拆解

- **agent-orchestrator(AO)**:Electron 桌面(`src/renderer`)+ Go daemon。**看板**是中心视图(Working/Needs you/In review/Ready to merge),**卡片位置由事实派生**(session/PR/CI/review facts,非手摆)。卡片聚合 task+agent+branch+activity+PR+status,点开露出对话+终端(内嵌 TUI)+改动文件+PR+可控浏览器预览。daemon 做 CDC/状态派生,UI 反应式刷新。协调层:Orchestrator(规划/派发)+ Workers(执行)。30+ harness。
- **paseo**:本地 daemon(`packages/server`:WebSocket API + MCP)+ 多客户端(Expo iOS/Android/web、Electron 桌面、CLI)全连它(`ws://127.0.0.1:6767/ws`)。自托管隐私优先(无遥测/追踪/登录)。`paseo attach`(流式)/`send`(追加任务)对**具体 agent**。语音模式。E2E 加密 relay 跨机。Skills 让 agent 编排 agent(handoff/advisor/committee)。插件加 panel/theme。Docker。
- **OpenDots**(最正对口):开源 **Dot 式助手模板**(MIT,alpha)——"always-on AI coworkers",每个 agent 叫 **Dot**(名/角色/指令/工具/可选自带电脑)。对话流(头像+状态)+ **人在环交互卡:「Approve & save」/「Decline」服务端暂停工具调用等人裁,裁完 agent 续跑** + call 回执/来源链进时间线。**CopilotKit tool renderers = 生成式 UI**:实时浏览器/保存的文件/终端输出内联。Spaces 文档编辑器。React + Vite(localhost:5173 SPA)+ CopilotKit runtime/SDK + **AG-UI 协议**(流式传 消息/工具调用/agent 状态,backend↔组件)+ TanStack AI + Channels(Slack)。WebRTC 实时语音。Docker。架构:UI → CopilotKit runtime → **多个专家 agent**(runtime 路由,非逐 agent 直 socket)。**非看板**——文档工作区 + chat + 每 Dot 电脑面板。
- **Open WebUI**:SvelteKit 前端 + Python 后端,`open-webui serve` → localhost:8080 单应用(PWA,离线)。对话流 + Markdown/LaTeX + Artifact 存储 + 富编辑。自托管零云。

## 一、独立趋同(印证我们的设计)

| 参考 | 我们 | 判定 |
|---|---|---|
| AO:卡片位置由 session/PR/CI 事实**派生**,非手摆 | projection 单写者 + kanban 判定下沉(位置是算出来的) | 同构 |
| AO:**"Needs you"** 列聚合待人项(blocked/缺输入/failed/改) | S19 呈批 + user 门聚合(且 todos.dev/humanlayer 也同列=四方趋同) | 同构 |
| paseo:本地 daemon,所有客户端连它,单一 API 面 | swarm-viz exporter(本地 http serve 单源)+ 投影单写者 | 近构 |
| paseo:自托管、无遥测、数据在本机 | 零云 / 数据不出机(S21 本地单页) | 同构 |
| Open WebUI:localhost serve、离线 PWA、单应用 | swarm-viz 本地单页(exporter serve localhost) | 同构 |
| **OpenDots:agent 叫「Dot」,always-on coworker** | 节点=Dot 数字员工(CORE 定调) | **同构,连命名都一致** |
| **OpenDots:HITL 卡 Approve/Decline 服务端暂停工具调用等人裁** | **S19 审批代理(弹窗→呈批卡 批/驳/改)** | **同构——这就是 S21 要的呈批交互卡本体** |
| OpenDots:tool renderers 把浏览器/文件/终端内联进 chat | S16 产物(HTML/MP4/图)嵌聊天流富媒体卡 | 同构 |
| OpenDots:AG-UI 流式传 消息/工具调用/状态(backend↔组件) | 投影/control-log 事实流 → viz | 近构(传输不同,语义同) |
| 四者都靠 daemon/runtime/协调层中介(数据层非 UI↔agent 直连网) | 协调者 + 投影单写者 | 近构(但它们 UI 仍暴露逐 agent/Dot 直控,我们不) |

结论:v1 控制台的**数据面形制**我们已走在正确结构上(事实派生卡片 + 本地单源 serve + 待人聚合列),三者独立趋同印证。

## 二、可借(前端形制 + 栈;列建议,裁定归协调者/user)

1. **"Needs you" 聚合列 + 卡片事实派生位置**(AO):我们 kanban 已有判定下沉,直接补一个「待你」门列(= S19 呈批入口),位置继续由事实算。零新状态。
2. **卡片聚合即展开**(AO):一张卡聚合一件工作的全部,点开嵌对话/产物/状态——正好嵌 S16 的 HTML 页/MP4(产物本就是网页态,iframe 即显)。落点:board 卡 → 点开嵌 explainer-video 产物。
3. **本地 daemon serve 单页 + 多客户端同一 API**(paseo/Open WebUI):验证我们 exporter 的方向。v1 不换栈——**扩 swarm-viz exporter**(已是本地 http + 单 HTML)即可,比 Electron/Expo 轻一个量级。
4. **对话流富媒体渲染**(Open WebUI:Markdown/artifact 内联):聊天流里把协调者回复 + 产物卡混排。落点:console 的 chat 面。
5. **语音入口**(paseo 有语音模式):印证语音可行;我们走 CPA 实时(S21),不接 paseo 自带。
6. **OpenDots 的 HITL 交互卡 + 生成式 tool renderers(MIT,CopilotKit)**:Approve/Decline 卡服务端暂停工具调用等人裁=S19 呈批卡的现成实现;tool renderers 内联浏览器/文件/终端=嵌 S16 产物的现成组件。**这是四个对象里对 S21「呈批交互卡 + 富媒体卡」最直接的现成件**。落点见第五节主次排序。

## 三、不借

- **多 agent 直控的交互模型**(AO 点开 worker 卡进其终端;paseo `attach/send` 对具体 agent、"one interface for many agents"):**违反单线拓扑宪法**——user 应只对**一个协调者**说话,不逐个驱动 worker。我们的 console:蜂群**可观测**(board/卡/成员泳道全看得见),但**输入单线**(chat→协调者;呈批→协调者耐久箱),user 永不对 worker 打字。记不借 + 理由。
- **Electron 桌面壳(AO)/ Expo 移动栈(paseo)**:重。我们零云单页(扩 exporter)更轻且已存在。不借栈,只借形制。
- **Open WebUI 代码本体**:license 带非标准品牌保留条款。形制/思路可借(思路不受 license),代码不整合。
- **daemon 的 WS 双向控制面做输入回写**(paseo):对我们是过度设计——我们的回写基底是**协调者耐久收件箱**(F25),交互卡点击 → POST 本地小端点 → 写 inbox JSON,比常驻 WS 控制面轻,且天然守单线(输入恒流向协调者)。借「交互卡回写」思想,不借 WS 控制面。
- **OpenDots 的多 Dot 直聊 + 云件**:它让 user 分别与多个 Dot 对话(每 Dot 一个会话),仍是多线;且默认接 Parallel Search MCP(search.parallel.ai)等云服务。借它时**必须改造**:user 输入只流向协调者 Dot 一条线(其余 Dot 可观测不可直聊),剥掉云 MCP,存储换成我们 control-log/inbox。多 Dot 直聊 as-is 不借(违宪)。

## 四、顺带观察

- 四方趋同的「待你/Needs you」列(AO + todos.dev + humanlayer + 我们 S19)——这是 agent-console 的收敛原语,v1 必做。
- AO 的「卡片位置纯由事实派生」与我们「判定下沉、viz 只画」是同一条铁律的两次独立发现(状态是证据 F13)。
- paseo 一个人做到 19.6k★ 且自托管零遥测——印证「本地零云 + 单一 daemon」对隐私敏感用户是强卖点,与我们数据不出机同向。

## 五、v1 控制台选型建议 + OpenDots fork 三判据(裁定归协调者/user)

user 候选决策=直接 fork OpenDots。先答三个 fork 判据(基于 shallow clone 只读审:103 TS 文件,src 67/tests 36,后端 Hono,UI↔runtime=AG-UI 标准协议,MIT):

**① 前后端接口宽度 = 中等,但标准且收口于一个类。** UI↔runtime 走 **AG-UI 开放协议**(@ag-ui/core,流式传 消息+工具调用+agent 状态),UI 侧只认**一个** runtime URL(`<CopilotKitProvider runtimeUrl="/api/copilotkit">`)。比「消息流+回执」宽(多了工具调用生命周期+状态流),但:(a) AG-UI 是文档化标准不是专有;(b) agent 侧**收口于单个类** `DotAgent extends AbstractAgent`,发射 `Observable<BaseEvent>`。所以我们要满足的「协议面」= 实现/改一个 AbstractAgent 子类,把蜂群/协调者状态翻成 AG-UI 事件——不是散开的面,是一个漏斗。**fork 友好度:中。**

**② 拓扑 = 已基本单会话,改单线是适配不是手术。** UI→一个 runtime URL→一个 DotAgent;store 的 tasks/runs/events/memories **不按 dot 分键**=实为单助手。「多个专家 agent」是那一个 Dot 背后的工具/电脑,不是 N 个用户直聊。所以「那一个 Dot = 我们的协调者,它背后派给 workers(我们的蜂群)」**天然贴合单线宪法**——user 输入已只流向一个 Dot。改造=小(确保 sub-agent 映射到我们 board/workers 为可观测,不开 N 个直聊)。**非结构手术。**

**③ 替换点清单(换后端为协调者耐久箱)= 集中可控,~8–12 文件、~1.2–1.8k LOC:**
| 层 | 文件(LOC) | 动作 | 量 |
|---|---|---|---|
| 持久化 | `store.ts`(300)+`computer-store.ts`(51) | sqlite 后端→读我们 control-log/board/worklog + 写 user 动作到协调者 inbox;**保类接口换实现** | M |
| agent↔AG-UI 桥 | `dot-agent.ts`(363)+`runtime-scope.ts`(81)+`runner.ts`(91) | 让那个 Dot=我们协调者:思考=读投影+协调者回复,工具调用=派board,状态=蜂群态;TanStack `openaiCompatibleText`→**CPA**(OpenAI 兼容,直接可换) | L(真正的概念活) |
| 语音 | `voice.ts`(287)+`useVoice.ts`(336) | WebRTC 实时→CPA 实时 | M |
| 剥云 | `parallel.ts`(200)+`research.ts`(187)+`slack-channel.ts`(161)+裁 `platform.ts`(198) | 删除+从 dot-agent 解依赖 | S |
| UI | `App.tsx`(899)/`Chat.tsx`(452)/`PageReviewCard.tsx`(200=HITL 卡)/`ComputerToolCard.tsx`(203=tool renderer) | 基本留用;仅确保输入单线 | S |
**贵的 80%(chat + HITL 批/驳卡=S19 + tool renderer 嵌产物=S16 + 语音壳 + 文档编辑器)几乎白得。**

### 结论:三选一(附 T 恤码)

- **A. fork 适配 ★推荐(主)** — **M–L**。继承整套 S21 要的 UI(且 MIT),拓扑已单会话(单线=小适配非手术),后端替换面收口在 store + DotAgent 桥 + voice + 剥云。唯一真成本:接受 React+Hono+CopilotKit+AG-UI 栈(比 exporter 重,但本地 Vite SPA+Hono 仍零云)+ 写「协调者↔AG-UI」桥(那个 L 项)。LLM 走 CPA 是直换(已是 OpenAI 兼容)。
- **B. 借形制自建(扩 swarm-viz exporter + 长对话面)** — **L–XL**。vanilla 自建,最轻最可控、零新栈,但 chat+HITL 卡+tool renderer+语音全手搓(贵的 80% 自己写)。仅当 React/CopilotKit/AG-UI 栈被否时选。
- **C. 仅借组件(CopilotKit 组件库单用)** — **M,但不干净**。@copilotkit/react-core 的 HITL 卡/tool renderer **假设** CopilotKit runtime+AG-UI,拆不干净——取组件仍拖 runtime,却丢了现成壳;实际会塌向 A。只当想在自建 UI 里嵌 1–2 个特定组件时用。

**一句裁定依据**:OpenDots 是四个对象里唯一「Dot 式助手本体 + HITL 呈批卡(=S19)+ 富媒体 tool renderer(嵌 S16)+ 单会话拓扑 + MIT」全中的;它的贵部分正是 S21,且替换面收口(store + 一个 AbstractAgent 桥 + voice + 剥云)。**推荐 A(fork 适配)**;若不接受 React/CopilotKit 栈则退 B;C 不干净不单列推荐。主次:**OpenDots(主,可 fork)> AO(次,借 board/「待你」/事实派生卡形制)> paseo/Open WebUI(栈佐证:本地 serve)**。

(研究口径:只读文档不装不接,不改任何契约;选型仅建议,裁定归协调者/user。基线 S21 + 单线拓扑宪法。)
