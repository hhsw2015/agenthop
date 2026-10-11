# polydao loop 工程深评(第十四面镜 · 夜跑 loop + 图编排 + loop 编辑 loop)

owner=f32a0507;协调者派单(user 亲令)。对象 @polydao(Mr. Buzzoni)两篇 X 长文:①「CLAUDE LOOP ENGINEERING: HOW TO BUILD AN AGENT THAT WORKS WHILE YOU SLEEP」(7/31)②「300 AGENTS, ONE GRAPH, AND A LOOP THAT EDITS THE LOOP」(9/5)。纯研究,未改码未提交。

## 0. 取文证据诚实

- X 长文 WebFetch 402、r.jina.ai 对 x.com 封禁、WebSearch 后端故障、jshook 浏览器无可执行文件。②经 threadnavigator.com 镜像(Exa)取到全文;①初仅得同作者两条推文摘要(bittide 镜像)故曾标 △。
- **现两篇正文均全**:user 用登录态 EGO 浏览器(X)取到①②全文并贴入,本稿据**全文**评,① 的 △ 撤销。两篇皆 Mr. Buzzoni 增长向创作(末尾引流 TG「Buzzoni Notes」卖 prompt/skill),机制可信但掺营销(「$20 订阅窗」「卖 market map 四位数」「95%/8x 数字作者自标夸大」——不采信为机制)。

## 1. loop 工程要素(唤醒/检查点/防漂移/自愈 + 闸门)对表

①把 loop 拆成**五件**:trigger(触发:消息/时钟/事件/webhook)· work(取上下文→动作→读回)· **gate**(无品味的拒绝器:测试/构建/类型检查/linter 退出码)· state(会话外的盘上文件)· stop(停止条件+硬顶)。一轮按序:**Discover**(自定本轮做什么)→**Hand off**(交给隔离工作区的 agent)→**Verify**(第二个 agent 换指令去打破它)→**Persist**(落盘非聊天)→**Schedule**(排下轮+余量结转)。四种 loop:turn-based(prompt+验证 skill)/goal-based(/goal,**另一个小而快的模型**读 transcript 判 yes/no 给一行理由,一会话一目标,只能判被 surface 的东西)/time-based(/loop 本机·/schedule 云)/proactive(事件+工作流+auto)。

我方:**dispatcher sweep(8min)+ inbox-wake(写侧投递自动唤醒,已并 main)+ ScheduleWakeup 动态节拍** = trigger;adversarial review + **round-doctor**(已上线)+ 分级验证 = gate;**task-state(attempt/binding/generation)+ decision-batch 耐久 + PROGRESS + publish-after-fact** = state;job budget / S29 消息预算 / 配额 = stop;Discover=板/箱自找活、Hand off=**worktree 隔离**(EnterWorktree/agenthop_handoff,我本任务就在隔离 worktree)、Verify=对抗审查席、Persist=耐久箱/结果/git、Schedule=sweep/cron。

- **唤醒**:他=时钟+事件。我方=sweep+**事件驱动写侧唤醒**+动态节拍。**我有他深**(事件+耐久 exactly-once 胜纯 cron);纯理念重合=「schedule 设地板,事件处理尖峰」。
- **检查点/state**:他=STATE.md 单盘文件 + 「VISION.md 持目标防 turn-47 漂移」。我方=分布式 exactly-once(task-state/decision-batch/poison-DLQ)。**我有他深**;**但「STATE 持位置 / VISION 持终点」分离**是个干净点,我方长任务(如 inbox-wake 走 10 轮)靠冻结 brief+PROGRESS,可**次借**显式分「北极星 vs 滚动态」。
- **gate/evaluator(①全文核心,与我方正中红心)**:他反复讲「agent 重读自己的产出=看见自己每条写它的理由⇒自我批准」,**调一个独立怀疑者远易于让作者自我批判**(GAN 形;**不同模型**,同基座=同盲点;**动手**点击/截图/查 DOM 而非只读;**两人复核银行律**:录入大额转账的人与批准的人不能是同一个);/goal 把「完成由**没参与生产的新模型**判」做成产品原语。**= 我方对抗审查席铁律的逐字独立收敛**(作者禁自证+独立复跑+SHA 绑定+封存哈希);**我有他深**(密码学绑定+独立复跑 ≫ 读/Playwright)。
- **防漂移/carry-forward**:②的 CONSTRAINTS.md(每次 launch 顶部加载的纠正累积)+ aliases.csv。我方=rulings 律典(F21-F54,结构化可查)+CLAUDE.md+round-doctor。**我有他深**;「纠正给个永久的家」= 我方「判例改流程」**独立收敛**。
- **自愈**:他=retry 把失败原因附回任务(①②皆强调「不告诉 agent 失败什么就 retry=在同一错误烧预算;把原因传回使 retry 变成 correction」)+二次失败入 human-queue。我方=返修棒+sentinel(假死/ghost/succession)+round-doctor。**我有他深**;retry-pass-reason = 我方 FC-2/返修**纯理念重合**。

**四种账单(①的失效分类学,头号可借诊断面)**:verification debt(Ralph Wiggum loop:agent 在半成品上点「完成」;治=无意见的 gate)· comprehension rot(仓库长、你脑中地图没长)· cognitive surrender(停止形成判断,照单全收)· token blowout(每轮/每日预算+max retry)。「当**复核能力本就是你的上限**,loop 是加长队列不是缩短」= **我方 dual-bandwidth 带宽仪(produce/consume/backlog)逐字命题**——他把它当警句,我方已做成读数。**verification debt 正是我方 backlog 可视化**。

## 2. 「一张图」架构(图=什么/边=什么/谁编辑 loop)对表

②:**图=领域知识图谱**(节点 company/person/filing,边 shared_investor/depends_on/supersedes/**contradicts**),SCHEMA.md 定类型+阈值(0.6/2 独立源),node 落全才画边(防顺序偏置),每边带 evidence 源行。**launch 块=对图状态的查询**(dispatch WHERE unverified OR last_checked>30d OR inbound≥3 AND conf<0.8,cap 300 取 inbound 最高),**按 node 状态路由**(fresh→跳/stale→delta/thin→补源/contradicted→两 agent 异源/new→全跑),verdict 分支+cap retry。目录 one-author-per-dir+数字前缀定写序+40-runs append-only。

我方:roster+板+force-pipeline+**conditional-routing(when 谓词边+planFanout 扇出,已并 main dormant)**+裁定簿。

- **关键轴差异**:他的「图」是**知识图谱=产物/记忆**(loop 编辑这张知识图);我方的「图」是**编排图**。他的图 ≈ 我方 task-result+耐久工作树的结果累积,**不同轴,非我有他无**。
- **launch=查询+按状态路由**:正落我方刚建的 conditional-routing+扇出。**纯理念重合**(我方有原语,他是应用层模式);**头号借**=conditional-routing 的 **IO 接线轮**照「launch=查询累积状态」把派发做成「dispatch WHERE result 陈旧/未验证/contradicted」+一张 state→route 表。规模:中。
- **Stripe Minions 实证(①案例,强印证我方)**:1300 PR/周无人写码,**确定性 orchestrator 先装配上下文**(扫链接/Jira/文档/Sourcegraph/MCP)**再**让 agent 写,硬编码 linter 流水线 agent 绕不过;「**凡规则能决定的,绝不交概率模型**」「可靠性来自约束不是模型大小」「人没走,从写码换桌到复核」。**= 我方 force-pipeline/conditional-routing(LLM 不决定 handoff)+ AgentGate 双脑借 的逐字外部印证**。
- **知识图谱作可查记忆**:他「memory with a shape, not a transcript」(节点+边+evidence+confidence+contradicts)——我方结果偏 transcript/工作树,查询形弱。**他有我无(异轴)**:task-result 聚成可查 node/edge 图。**次借**,接 swarm-viz/画布(aad02248),规模中。

## 3. 「loop 编辑 loop」自反性 vs 我方「判例改流程」谁更系统

②step 14:**周度 meta-loop**——fresh-context agent 读 40-runs 近 7 天,找「失败原因≥2 次 / 升人≥1 次 / alias 碰撞」,**提出**对 SKILL/SCHEMA/aliases/CONSTRAINTS 的编辑,**输出 diff,人批准或拒,绝不自写**。安全论:「能不经复核改自己 constraint 的 agent,迟早把碍事那条改掉还自圆其说」⇒**保留批准步**。①同调:cognitive surrender「执行可交,决定不可」。

- **核心安全独立收敛(强)**:他第一安全律(**绝不让 agent 无外部复核改自己约束**)= 我方铁律(合并/启用门=协调者+user;禁自证;peer 非授权)。两边在最关键处独立收敛。
- **谁更系统:我方**。他=周度单 agent 提 diff+人批 4 文件。我方=每次流程变更过**对抗复跑+密码学 SHA 绑定+封存哈希**+**持久 rulings 律典(F 系列带 provenance/可查/轮次史)**+协调者+user 门+round-doctor 自诊;F49-F54 是逐条走完整门的 loop-编辑-loop 实例,我方有**自编辑台账**而非一个 CONSTRAINTS.md。**我有他深**。
- **他的清爽点值借**:**周期性 meta-review 主动提流程改进 diff**——我方「判例改流程」是**反应式**(审查触发),补一个**定时**「从 F 台账+round-doctor 史提改进 diff 候 user 批(绝不自写)」互补。**次借**,规模小。触发器纯理念重合:「失败原因≥2 次」= round-doctor persistent_fail/loopback_loop + 已吸收 AgentGate exit_drift([[agent-gate-eval]])。

## 4. 吸收清单(排序,落点+规模)

1. **launch=查询累积状态 + state→route 表**(§2 头号)——conditional-routing 的 **IO 接线轮**(待另单)照此:派发「WHERE result 未验证/陈旧/contradicted」+状态→路由表(skip/delta/补源/双 agent 异源/全跑);Stripe Minions 式「确定性先装配上下文再喂概率模型」一并落。规模:中。正落已建原语的应用形。
2. **四账单诊断面 + 「cost per accepted change」单指标**(§1)——把 verification-debt/comprehension-rot/cognitive-surrender/token-blowout 四失效做成运维自检;我方已有 dual-bandwidth(=verification debt)、预算(=token blowout),缺一个**单一北极星「每个签收结果的成本(token/agent 轮)」**(他的 the one metric),并入 dual-bandwidth 投影。规模:小。
3. **gate 分级成本阶梯**(②)——无人值守步骤先跑零成本确定性脚本挡掉能挡的,再花 token 验证(deterministic→fresh-context verifier→threshold→human)。规模:小。
4. **周期性 meta-review 主动提流程改进 diff**(§3)——定时 agent 读 F 台账+round-doctor 史,产改进 diff 候 user 批,补反应式「判例改流程」。规模:小。
5. (次借)**VISION/STATE 分离**(§1)——长多轮任务显式分「北极星文档 vs 滚动态」防目标漂移(他 turn-47 漂移)。规模:小。
6. (次借)**结果累积成可查知识图**(§2)+ **contradicts 边/证据规则**(「两条新闻稿=一个源」)——结果查询形+证据诚实具体规则。规模:中。

不借:领域特定(公司/filing 研究、aliases.csv、卖 market map 商业模式)、单机非耐久 state/文件夹(我方已 exactly-once)、Kimi K3 Agent Swarm 运行时、订阅/数字增长话术。

## 5. 刹车/对照一句 + user 侧提醒

他是**单人单机、把 loop+gate+自编辑用来建知识图谱/夜跑码**的应用版;我方是**无中心分布式多 agent 蜂群**。同一核心纪律(**carry-forward + reject-before-carry-forward;自编辑必经外部批准门;规则能决定的不交概率模型**)两边在几乎每根支柱上独立收敛——他在最关键安全律与 gate/evaluator 命题上逐字印证我方,我方在耐久/分布式/密码学绑定/持久律典上更系统。与 [[agent-gate-eval]](「产出默认不可信」刹车赛道)、[[dist-ha-theory-eval]](「重新发现分布式系统」)同族。

**给 user 的一条**:①的「四账单」里 **comprehension-rot(你脑中地图跟不上仓库)+ cognitive-surrender(停止形成判断)是人侧风险**,正落我方「一人多 loop」的你——建议把「每周读几个已签 diff 向自己解释」纳入节律(他的解药),这是我方全自动化里唯一机器补不了的一环。

已交付协调者 fe0376cd,待裁。
