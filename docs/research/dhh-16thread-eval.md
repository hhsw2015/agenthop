# DHH 16-thread 工作流 深研：八轴验证/借/不借 + 蜂群设计变更清单

owner f32a0507 · 2026-10-07 · 协调者 fe0376cd 派单（S14 深研，user 令「可能极大影响蜂群设计」）· 纯研究，不改码。

## 源与可信度（逐轴标注）
- **已取证（primary）**：Pragmatic Engineer 访谈「DHH's new way of writing code」（Gergely Orosz，2026-04-08）；Lex 播客摘要「DHH on Running 16 Parallel AI Coding Agents」（2026-08）；37signals REWORK 播客「AI challenges in software」（2026-07，有全文转写）；DHH hey.com 三帖（`promoting-ai-agents` / `basecamp-becomes-agent-accessible` / `endless-execution`，高层随感＋发布公告，机制细节少）。
- **2026-10-07 升级：user 供全文转写 `/Users/wowdd1/work/dhh.txt`（Lex×DHH 5h，2307 行）全文复核**。原 △ 转述项大多升 ✓源证（见下「全文转写复核」节）：ban（28 issue/12s 被 GitHub 封）、mise、GL.iNet Comet KVM、Tailscale、Herdr、16 线程「faster→fewer」均逐字证。**仍 △ 未证**：①「Amabot」命名与 100→10 比率（转写里压缩层=**邮件摘要**，非此名/比）；②「plan 作接力棒」此访谈**完全无**（协调者分析框架，非 DHH 原话）；③「四阶段瓶颈」=协调者透镜，DHH 原话是单一「human bandwidth + taste」瓶颈。内置 WebSearch 本会话鉴权故障，primary 经 exa + user 供全文。每轴标「✓源证/△框架」。

## 结论先行
- DHH 2026 从监督式→16 线程并行，与我们蜂群**独立收敛极多**：都用 **herdr**（tmux＋通知）、都走**脑手分离**、协调者≈他的事件压缩层、都要「进主库前有更高权威验证」、都认「判断力是终极瓶颈」。
- **我们已领先三处**：①背压（他报无背压被限，我们总线/chat-room/tunnel 都有限流）；②审查扩展性（他靠资深**人**审=瓶颈，我们审查人是 **agent**＝随规模扩）；③脑手分离/herdr 已成熟。
- **最高杠杆三借项（P1）**：①协调者/控制台**批量决策视图**（一屏 merge/close/defer N 件）；②控制台主形态转**任务队列/看板**，chat-room 做议题线程投影、不鼓励实时干等；③补**跨件「架构整体性」审查维度**（局部合理 PR 合起来架构碎，单件审查人看不到）。

## 全文转写复核（user 供 dhh.txt，2026-10-07，逐字证）

**一条新深水洞见（最重要）**：DHH 的瓶颈论原话是「**the bottleneck is rarely implementation. It's human bandwidth and communication**」（18:51）＋「to get that magical 10X/100X/1000X, you have to interact with the agents directly, and **you cannot intermediate that bandwidth with another human** because it's simply too slow」（19:37）。反模式是**人类中间层**（PM/VP/CTO 三层审批）。对我们的含义：协调者（Amabot）是**agent 压缩层**才合法——它必须**压缩 user 决策负载**，**绝不能变成拖慢 user 的人类速度审批跳板**。这既强化 R22 批量决策视图（压缩=对的方向），也给设计警戒：协调者职责=压缩，非增加延迟的守门。瓶颈终点=「ideas / vision / **taste**」（20:28），非实现。

**逐字证（△→✓）**：
- ⑦ faster→fewer：「I have about 16 threads… **the faster the agents run, of course, the fewer threads I can run**」（38:09/38:21）。✓
- ⑤⑥ 架构碎：「a lot of PRs that **individually perhaps could have been justified… taken all together, destroyed the architecture**」→手工清理；教训=既有大码库 vibe code **需 programmer 保架构**（16:59-17:38）。✓
- ② 单 agent 等待=无用→并行做决策：等一个 agent「feels actually like you're a little bit **useless**」（33:43）→跑一把「you're in a **flow state** because you're constantly… making decisions… unblock an agent… ready for a new task」（34:12）。操作者=跨线程**决策者**非聊天干等者。✓
- ⑥ 背压/封号：8 agents 一次 QA 出 28 真 issue，bot 在「**about 12 seconds**」把 28 条全提 → 「GitHub… marked that as probable spam and **banned my Omarchy bot**」（2:26:38-27:05）。恢复=改走**邮件**（hey.com CLI）「it sends me reports about **outstanding issues and PRs**」（27:20）。✓（此即③压缩层=邮件摘要，非「Amabot 100→10」）。
- ⑥ 并发暴露竞态：多 agent「will **suss out all these race conditions**… never triggered by a human」（2:26:12）。✓
- ⑧ 物理：Herdr=「**tmux plus agent notifications**… ding… ready for its human」，多机各一套（35:39）；**GL.iNet Comet KVM**「a remote way of controlling a computer… hop on your tailnet」（36:26）；**Tailscale**「turning all the computers… into a local network wherever you are」手机直达 Malibu+Copenhagen（37:10）；closet 里 **4 台 mini PC** 各一 Comet、用 Herdr 统管（37:41）；**mise**「agent harnesses updated about **seven times a day**, so we needed an **out-of-band package manager**, and mise… perfect」（2:26:04）。全 ✓。
- 审查工具：Neovim 作 project browser＋Lazygit 看 change log；强调看 agent 产出要**连带上下文**（不只 diff）（40:05）。
- ④ plan 作接力棒：此访谈**无**（保持 △＝协调者框架；我们 handoff＋task-plan 已是现成对应）。

## 八轴

**① 瓶颈迁移（等待→可观测→任务上下文→Review 爆炸）** △四阶段=转述；✓源证「实现→品味/判断」迁移（Pragmatic「bottleneck shifts to taste and judgment」「peak programmer」）。我们现处：可观测（swarm-viz/PROGRESS/status）＋任务上下文（派单信封/角色笔记本）**基本解决**，正撞 **Review/沟通爆炸**（三方审查轮次＋cc 流量→user 连下 S27/S28/S29 压沟通）。**借**：四阶段作**诊断透镜**，验证我们已到第 4 阶段；下一瓶颈预判=审查吞吐＋user 判断带宽（见⑤⑦）。

**② chat 诱人干等 vs 异步任务工具** △源未直证 chat-vs-async；但与 user 的 S27/S29（少沟通、一单两信、耐久箱非聊天）**同根**。张力：我们**刚建 chat-room（群聊）**。若它变成「人盯着聊天窗干等」＝反模式；若是「异步任务队列的可观测投影」（议题开/议完关、读多 tail、不要求实时在场，campfire 式 dispatch→end→resume）＝正解。**借/修正**：控制台**主形态=任务队列/看板**（Basecamp/Jira 形），chat-room 是其上的议题线程投影，**明确不鼓励实时干等**。**不借**：把控制台做成实时聊天中心。

**③ 事件压缩（Amabot/邮件式「12 个 PR 该合该关」）vs S19 呈批＋status-digest** ✓源证「100 PR / 90min，按 URL 批量 merge/close/rewrite」；△「Amabot」名与 100→10 比=转述。我们：协调者≈事件压缩层，S19 呈批＋status-digest 把 agent 事件压成 user 决策，但**批量 UI 弱**（呈批逐条，无一屏批处理）。**借（P1）**：给协调者/控制台**批量决策视图**（N 个待办/PR/审批一屏，一次 merge/close/defer），把「事件→决策」压缩率拉高——直服 user 判断带宽。

**④ Plan 作接力棒（token 尽另一模型接续）vs roster/notebook/继任协议** △源未直证 plan-baton=转述框架。我们**已有雏形**：handoff（携 git 快照＋summary）＋ brain task-plan（T3 规划器，跨 attempt 状态载体）＋继任协议＋笔记本。**借（P2）**：把 **task-plan 正式确立为跨 agent/跨上下文接力棒**（一 agent 产计划→另一 agent 按 step 续；token/context 尽时的显式交棒点）。方向一致，仅需正式化，**不涉不借**。

**⑤ 设计师直用 Agent 失败→37signals 规矩 vs 对抗审查** ✓源证（REWORK：不能直接 merge、须「someone more senior look it over」查性能/架构/安全；Lex：agents「step on each other, write conflicting abstractions, hundreds of lines of plausible technical debt」）。关键差异＋**我们赢面**：DHH 用资深**人**审＝瓶颈（人数有限，agent 爆炸审不过来）；我们审查人是 **agent＝随规模扩**。**但缺口**：局部 PR 各自合理、合起来架构碎＝跨 PR 全局视角，单件审查人看不到。**借（P1）**：补**跨件「架构整体性/一致性」审查维度**（现对抗审查多为单件正确性；加一个「N 件合起来是否架构碎」的整合审查人或协调者级架构守门）——正是 board/chat-room 该承载的全局视图。

**⑥ 三故障（架构碎/并行写冲突/封号=背压缺失）我们防御有无** ✓架构碎＋写冲突源证（Lex）；△「12s28 提交封号」=转述（DHH 确有速率语境）。
- **背压：我们有（赢面）**——总线 PostCounter 60/min、chat-room 限流 30/60s、tunnel Throttled/backlog、耐久箱 claim/ack 不重投。DHH 报的「无背压被限」我们已防。
- **并行写冲突：有结构防御**——多 worktree 隔离（vm-ssh）＋单 owner 有序日志（chat-room）＋裁定簿定序。
- **架构碎：部分防**（对抗审查抓单件，跨件弱→补⑤）。

**⑦ 「agent 越快，人维持的 thread 越少；判断力涨价」→ R18 二级调度/北极星** ✓源证（Pragmatic「taste/judgment」「peak programmer」）。含义：**人的判断带宽是终极瓶颈**→蜂群北极星应是**最大化 user 判断的杠杆**（每单位 user 决策撬动最多正确产出），而非最大化 agent 数量。**借（P2）**：R18 二级调度以 **user 判断带宽为约束优化**；协调者职责＝把 agent 事件压成最少、最高杠杆的 user 决策（接③）；二级调度＝协调者把子协调者事件再压一层（**judgment 分层**）。北极星级洞见。

**⑧ 物理架构（IP-KVM/Tailscale/mise）vs vm-ssh/远程 herdr** ✓Tailscale「turning all the computers into a local network wherever you are」＋分布式 mini-PC（Malibu/Copenhagen）＋Herdr「tmux plus agent notifications… a little bell telling you it's ready for its human」；△IP-KVM/mise=转述。我们：vm-ssh（Railway/GHA 后端，ECH 代理池）＋herdr 双后端（已签收）。**借（P2/P3）**：**Tailscale mesh** 作跨机 herdr/vm-ssh 接入候选（分散机器组本地网，手机/笔电直达，比 relay/ECH 更简）；**mise** 统一各 agent 机工具链（减「在我机器上能跑」）；**IP-KVM** 裸机带外急救（vm-ssh 死机时）。**独立收敛**：两边都用 herdr＝强验证该方向。

## 独立收敛（验证我方设计，非借）
herdr（tmux＋通知，两边都用）· 脑手分离（brains-and-hands = 我们角色-session 解耦＋执行箱）· 协调者=Amabot 事件压缩层 · 「进主库前更高权威验证」（他 senior／我们对抗审查）· 判断力是终极瓶颈（user 的 S27/S28/S29 压沟通＝护判断带宽）。

## 建议蜂群设计变更清单（排优先级）
**P1（高杠杆，直服 user 判断带宽）**
1. 批量决策视图（③⑦）：协调者/控制台一屏批量 merge/close/defer N 个待办/PR/审批。
2. 控制台主形态＝任务队列/看板；chat-room 为议题线程投影、不鼓励实时干等（②）。
3. 跨件「架构整体性」审查维度（⑤⑥）：补整合审查人/协调者架构守门，抓「合起来架构碎」。

**P2**
4. task-plan 正式确立为跨 agent 接力棒（④）。
5. R18 二级调度以 user 判断带宽为约束＋judgment 分层（⑦）。
6. Tailscale mesh 作 vm-ssh/远程 herdr 接入候选＋mise 工具链统一（⑧）。

**P3**
7. 四阶段瓶颈纳入设计评审作诊断透镜（①）。
8. IP-KVM 裸机带外急救（⑧，vm-ssh 补）。

**已领先、无需追**：背压（⑥）、审查扩展性（agent 审 vs 人审，⑤）、脑手分离/herdr（独立收敛）。

## 方法学声明
primary 源经 exa 取回（内置 WebSearch 本会话后端鉴权故障）；三 hey.com 帖为随感/公告，机制细节在 Pragmatic/Lex/REWORK。标△者（四阶段细分、Amabot 命名与 100→10 比、12s28 封号、IP-KVM、mise）为协调者转述，我未逐字取证——建议如需精确引用，由协调者/user 提供访谈全文转写（podscripts.co 本会话被安全策略拦截）。八轴的**对照与变更清单**不依赖这些具体数字成立（结构性比较为主）。未装/未跑 DHH 任何工具。
