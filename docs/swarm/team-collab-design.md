# 团队协作层设计:黑板共识 + 成员直接沟通

日期:2026-10-03。状态:**v2-final,冻结为 brain-design v3-final 之上的增量实现契约**(Codex 两轮审查:v1 2P1+7P2+1P3 → v2 复核 P1=0/P2=0,报告 `~/Work/review-reports/team-collab-review-2026-10-03{,-v2}.md`;本版另清掉复核的 3 条非阻塞 P3)。v1 快照 SHA-256 `252066e1…`。冻结 ≠ 已实现:P0/C0 仍是前置,C0-C2 验收过了才可运行。
定位:`brain-design.md`(v3-final,已冻结为实现契约)之上的**增量层**,不修改它的任何不变量。
输入:`docs/research/collab-primitives.md`(P0-P4 原语)、`docs/research/shared-blackboard-stigmergy.md`(board A/B/C 分期)、brain-design v3 的三轮 Codex 审查结论。
标注沿用:[F] 已实现事实 / [I] 静态推断 / [D] 新增设计。

---

## 0. 总设计目标:一群 Dot 的公司

> **把整个蜂群建成「一群 Dot 的公司」:每个 durable 成员是一名数字员工(有稳定身份、持续责任、自己的节律、明确的决策权与验收标准);临时 VM 是按单结算的外包;dispatcher 是排任务、验成果的项目经理;CONTROL 是签字才算数的正式流程;团队板是公司 wiki;成员直接消息是工位对话。** 用户是老板:交代责任、放权限、看验收,不盯过程。

这个目标给所有分层一个统一的判断标准——每个机制问一句「现实中运转良好的公司是这么干的吗」:

- 公司不开全员大会干活 ⇒ 不做群聊广播(R1 白名单);
- 口头承诺不算数 ⇒ 聊天不进账本(R0);
- 员工手册写清可直接做/需审批/何时停 ⇒ decisionRights(§4.5);
- 新人先复述任务再开工 ⇒ 复述再开工(§4.5);
- 外包不拉进员工群,验收交付即可 ⇒ ephemeral 只走黑板+调度。

商业印证:ChatGPT Dot 把「责任制数字员工」做成了单人产品;三个开源复刻(CopilotKit/OpenDots 等)都停在「单用户对单 Dot」,并把多 Dot 协作、自动委派列为 future work(§4.5)。**本项目两份契约合起来做的正是那一步:brain-design 是公司的流程制度(任务分解、派发、验收、账本),本文是公司的组织与沟通(员工分类、组织架构、沟通纪律)。**

类比的失效边界也作为设计红线:agent 不需要激励与办公室政治,不引入;人离职带走脑子,agent 的「脑子」强制外化(落板/固化 evidence),这点要求比人类公司更严。

## 1. 动机与核心分工

brain-design 的协调模型是纯黑板式:worker 之间不直接通信,一切经「持久介质 + 单活调度」。这对 60 分钟临时 VM 是正确取舍。但蜂群不全是临时 VM:**本地长驻节点**(用户机器上的 Claude Code / Codex / OpenCode 会话)寿命长、总线原生可达(`agenthop_peers`/`send`/`recv` [F]),它们之间走「发布→观察→验收→再派发」的全回路来问一句"接口参数到底是 string 还是 number",是用集装箱运一张便签。

公司类比的逐项映射见 §0;AutoGen GroupChat 式全员广播正是公司不开的那种会(collab-primitives §1.5);「数字员工」手册(dot-green-book)印证同一套方法并补了两件事,见 §4.5。

核心分工(本文的一句话版本):

> **黑板承载共识,直接沟通承载协商。**
> 凡是需要团队**持久同意**的事实——计划、角色分配、任务领取、已验收结果、裁决——只在黑板(CONTROL/board)上存在;凡是**到达共识之前**的过程——提问、澄清、草稿交换、分歧讨论——走成员直接消息,快、便宜、可丢。

一条不可退让的守恒律,保住 brain-design 的全部正确性论证:

> **R0(账本守恒):直接消息永远不推进任务状态。** 任何 attempt 状态、验收决定、依赖解锁,只能由 commitControl 的权威提交产生。

R0 的关键切分(v2 按 Codex P1-2 重写——v1 把「共识落板」当终点,板却不是账本,留了一条「写上去就生效」的旁路):

- **advisory(怎么实现既定契约)**:实现技巧、定位线索、风格建议。可以只活在 DM/板上,丢了不伤正确性。
- **规范性决定(改变契约本身)**:改接口语义、改验收条件、改角色义务、改输入含义。**必须提升为 CONTROL 管理的正式条目**(计划修订 / accepted 决定),由新 attempt 的冻结引用消费;板 note 只允许**链接**这个权威决定,不得与 CONTROL 并列成为第二条生效路径。反例(Codex 实审):C 的已验收接口规定金额用「分」,P/Q 私聊改成「元」并落板,I 照板集成——三者抄回的 inputBindingDigest 全部不变,V4 全过,但正式契约已被旁路改写。**V4 核对的是声明的输入引用,不是 LLM 读过什么语境**;防线只能是「规范性决定必须入账」这条纪律,不是指望 digest 抓到它。
- DM 全丢时的退化保证据此收窄为:**advisory 丢了只慢不错;规范性决定本来就不在 DM 里**。

这条就是「效率层可以失败」的设计:直接沟通是加速器,不是承重墙。

第二条守恒律,防消息爆炸:

> **R1(白名单沟通,软策略):一个成员只被告知它的 teammates 名册里的对象,名册由 DAG 邻接推导(§4.1)。** 诚实强度(v2 按 Codex P2-3 修正):这是**提示纪律 + 审计,不是硬隔离**——总线不设防,成员技术上可用 `agenthop_peers` 拿到名册外句柄(mcp.ts:64 [F]),板房间限速只限速率。消息面也不是 O(E_DAG):sibling 按「共享同一下游」互联是**团**不是边,n 个输入指向同一汇点就是 n(n-1)/2 条通信边——所以复杂度按**扩展通信图 E_comm** 算,高扇入(建议 >4 个输入)的汇点不再两两互联,改经板协商或由 integrator 牵头(§4.1)。确需硬限制时,在 P0 task 包装器里按 (attempt, 收件人) 记账拒发——列为 C3 可选项,v1 不做。

## 2. 节点分类:两条正交的轴

**v1 支持的组合收窄为两种执行器(v2 按 Codex P2-7——原「两轴正交覆盖一切」的宣称连自己举的例子都表达不了):**

1. **ephemeral 执行器** = Railway 临时 microVM(swarm-launch 分配,brain-design 原样)。注:**完整 launcher 路径**跑出的 box 在总线上(swarm-launch 注入 AGENTHOP_TEAM 并核验入 bus,swarm-launch.sh:211,254-256 [F];allocate-only 在 :202 提前返回,不走这段——蜂群交接路径分配的 box 是否入 bus 取决于后续 swarm-task 接线,[I])——「不许它参与直连协商」是**本层的策略选择**(寿命短、死不可观察),不是底层没能力。
2. **durable 协作成员** = 预先存在的长驻总线会话(本机或云 VPS,经 AGENTHOP_TEAM 跨机同质 [F]),接本层的 §4 协商面。

其他组合(visible 一次性任务、spawn visible:false 起的后台 one-shot [F] spawn.ts:771-779 是一次性执行,不是长驻 peer)v1 不表达、不支持;将来要支持时按「执行适配器 / 预期寿命 / 可见性 / 当前可达性」四个独立字段扩展,不靠寿命标签推导总线能力。

**可见性(visible | headless)只决定人的介入面**:需要人批的动作(repair 放行)优先派给 visible 成员,headless 成员把待批事项发到板上等人;headless 的对话默认落日志供回看。

| | ephemeral 执行器(现有) | durable 协作成员(本文新增) |
|---|---|---|
| 实例 | Railway ~60 分钟 microVM | 预先存在的本机/云 VPS 长驻会话 |
| 寿命与死亡 | 随时死,死不可观察 | 预期小时/天级;**但 gone ≠ 死**(见下) |
| 协调面 | 仅黑板(WORK 发布 + dispatcher 验收),brain-design 原样;room 仅通知(模块 [F],业务接线 [D]) | 黑板(同一套)+ **成员直接消息** + TASK/GATHER 原语([D],P0 前置) |

**gone 的诚实语义(v2 按 Codex P1-1——v1 把 gone 当死亡证据,是 brain-design 物理期限教训的同款错误):** 总线 gone 只证明「那个总线 run 不在当前 roster」(waitForStatus 固定 run id,core.ts:274,287-288 [F];远端 presence TTL 150s directory.ts:70 [F],本地 socket close 即除名 broker.ts:115-119 [F])。断网 151 秒的 VPS worker 还在算、还能从别的路径 push WORK;笔记本休眠、本机 MCP 重启同理。所以:**gone 只把成员标 `suspected/unreachable`**——暂停向它发新 DM、触发核查(查 WORK 分支新发布、重试可达性),**绝不**据此判死 binding、释放资源或触发 transient-infra。执行终结仍走 brain-design 的证据规则(可信结果 / 带证据的物理期限 / closing 协议);要主动改派,走逻辑撤销 + 新 binding + 旧 binding closing,并承认旧执行可能继续(at-least-once 本来就许)。durable 的真实优势据此收窄为:**可达时协商快、不可达是可观察信号**——不是「死亡可检测」。

**[D] 节点标注**:TaskPlan 的节点增加可选 `runtime: "ephemeral" | "durable"`(默认 ephemeral)与可选 `visibility: "visible" | "headless"`(仅 durable 有意义,默认 headless;需要人批环节的节点标 visible 或由板上待批条目兜)。durable 成员由 dispatcher 经 `agenthop_task`(P0,collab-primitives §2.1 [D],前置依赖)派发,而不是 swarm-launch 分配 VM。**验收的诚实表述(v2 按 Codex P2-2 收窄——v1 的「验收路径完全不变」过强)**:V1-V8 的**纯判定核心复用**,但执行与发布需要新增 **durable task/publisher adapter**,它承担 brain-design 发布契约的全部义务:P0 发送前持久 assignment/binding 映射;发布端维持**单父快照链**(每次以已确认远端 tip 为唯一 parent——「自己的分支」这个名字不给任何保证,Codex 的 Git 反例:一个 merge commit 让被删结果的 commit 留在祖先链里却躲过 first-parent 扫描,现有 supervisor 靠单父纪律避免 swarm-supervisor.mjs:233 [F])、manifest、artifactScope、结果闭包与留存规则。P0 的 RESULT 回复只是**通知/指针**,业务结果仍以 WORK 发布 + O1 观察 + V1-V8 为准。

适合 durable 的节点:integration/synthesis/review(要跑整套测试、要强模型)、需要特定环境或凭据的任务、repair(常要和人来回——这类优先 visible)。适合 ephemeral 的:可并行的批量 work 节点。

## 3. 黑板上放什么(共识面)

黑板 = brain-design 的 CONTROL(权威)+ 一块新的**团队板**(board,快照共享语境)。两者职责分明:

**CONTROL(已有设计,权威,不变)**:plan、attempt、binding、ResultObserved、AcceptedResult、裁决。唯一写手是单活 dispatcher。这是**硬共识**——写进去就是事实。

**团队板(新增 [D],软共识,实现走 stigmergy 研究的 Stage A)**:一个团队派生的中继房间(实现直接复用 directory.ts 的 LWW gossip 机制——地址 HKDF 派生、条目密封、任意成员可做 keeper、按 (key, actor) 单调合并 [F] 机制已在 roster 上跑着),条目类型先只要四种:

```text
note     — 签名的共享语境:"C 的接口定稿在 <commit>,params 用 string"(发现、约定、警告)
question — 带 nodeId 锚点的公开提问(答案可能对多个成员有用时,问板上而不是 DM)
answer   — 对 question 的回答,引用原 question id
link     — 指向 CONTROL 事实或 WORK commit 的指针("P 的结果已验收:<acceptedResultId>")
```

板的定位是**公告栏,不是账本**:条目有 TTL(默认 24h,成员可重发续期),keeper 死了丢板不丢正确性(全部权威事实在 CONTROL,板上只有指针和语境)。**可追溯性因此不能靠板(Codex P2-1)**:结果真用到的关键 advisory 语境,产出方要把「条目 id + actor + 内容摘要」存成自己 WORK 的 evidence 文件(进 resultClosureDigest 与远端留存)——板 24h 后全员清掉、作者退出,只剩一个失效 id 的话,「结果为什么长这样」就没了;重发机制救不了无人再持有的字节。Stage B 的 claim/lease(成员主动认领任务)**不进本文范围**——brain-design 的派发是 dispatcher 决定的,双轨认领会打破单活写手不变量;等有真实需求再按 stigmergy 研究的 Stage B 单独评审。

## 4. 成员直接沟通(协商面)

### 4.1 谁能和谁说话:通信拓扑从 DAG 自动推导,零人工配线

派发时,assignment.json 增加一个 `teammates` 区(dispatcher 自动生成,[D]):

```text
teammates: Array<{
  nodeId,
  relations: Relation[],              // 可多条——P→Q 又共享下游时既是 upstream 又是 sibling(Codex P2-5)
  anchor: { attemptId | acceptedResultId | "unassigned" },   // 这个联系人对应哪个版本的工作(Codex P2-4)
  handle?: string,                    // 总线句柄;仅当对方是 durable 成员且已派发/在线;否则空 ⇒ 走板
  roomAddr?: string,                  // 对方是 ephemeral 时的 room 地址(推送通知用,open question 2)
  topics: string                      // 建议的沟通范围,一句话
}>
```

**两步推导,拓扑与身份分开(v2 按 Codex P2-4——v1 的「最近完成 attempt 的执行者」找错人:P 在 spec A 下由甲做完、spec B 下由乙做完、计划回滚到 A 时,冻结输入指向甲的结果,v1 名册却给乙):**

1. `deriveTopology(plan)` 纯函数:算关系集。upstream/downstream = 依赖边直译;**sibling 收窄为「共享同一直接下游、且扇入 ≤4」**——高扇入汇点的输入方不两两互联(n(n-1)/2 爆炸,Codex P2-3),改为 integrator 牵头或板协商;integrator/reviewer = 我的输出的直接消费者/审查者。
2. 运行期身份解析:**upstream 联系人从本 attempt 冻结的 acceptedResultId 反查**到产出它的 attempt/binding 的执行者(不是"最近完成者");sibling/downstream 解析其**当前有效执行 binding**,未派发或不可达 ⇒ handle 空,有话发板。anchor 字段让双方知道在聊哪个版本,防同 nodeId 不同 attempt 的协商串线。

**不发全员名册**:MetaGPT 的 subscribe-by-relevance 教训(collab-primitives §1.9)——广播一切给一切人是上下文污染,不是协作。

**角色间通信矩阵(白名单,R1 的具体化——不在表里的组合,一律走团队板)。关系可叠加(relations 是数组),判定规则:对每条拟发消息,取发起方与接收方之间**所有**成立关系中「允许面最宽」的那条行权(sibling 的主动权不因对方同时是我的 downstream 而被「仅应答」覆盖);「不允许的话题」列是**叠加生效**的——任一成立关系禁止的话题即禁止(Codex P2-5):**

| 发起方 → 接收方 | 允许? | 典型话题 | 不允许的话题 |
|---|---|---|---|
| sibling ↔ sibling(共享同一下游) | 允许 | 接口/约定对齐 | 替对方做任务、交换草稿代码(各自独立产出是验收前提) |
| downstream → upstream | 允许 | 澄清已验收输出的歧义 | 要求改结果(改结果走 supersede 裁决) |
| upstream → downstream | 仅应答 | 回答,不主动推送("我改主意了"必须走板/裁决,不许私下通知) | |
| reviewer ↔ author | 允许 | findings 求证 | 私下达成"算了不报了"(verdict 必须如实) |
| integrator → 任一直接输入方 | 允许 | 集成冲突定位 | |
| 其余任意对(隔代、无共同下游、跨 job) | **禁止直连** | 发团队板 question,谁有答案谁答 | |

**预算(v2 改述:这是**软预算**——提示纪律 + 评审回看,不是机制强制;要硬闸走 C3 的记账包装器,Codex P2-3):**
- 每 attempt 对每个 teammate 的主动 DM 上限:建议 8 条(回复不计;超了说明该开会的不是 DM,是节点切分有问题——升级为板上 question 或计划修订提案)。
- 每 attempt 总预算:主动 DM 合计 ≤ 24 条,note+question+answer 合计 ≤ 16 条(answer 计入,防「用回答刷屏」)。
- 板房间沿用中继每房间 60 条/分钟限速 [F]——这限的是速率不是总量,挡风暴不挡慢性灌水,后者靠评审回看。
- 先查板再提问:question 发出前的角色提示义务(T4)。

### 4.2 怎么说:现有原语,不发明新机制

- **durable ↔ durable**(本机↔本机、本机↔云 VPS、VPS↔VPS,同一条总线):`agenthop_send` 点对点——**发现/发送/跨机运输现成 [F]**;带 task_id 关联的正式问答用 P0 `agenthop_task`(**[D],未落地**,01ea35b 的 MCP 注册里没有它;落地前正式问答退化为 send + 人工关联)。
- **durable → ephemeral**:经该 VM 的 per-task room `send()`(room.ts [F] 机制已有,业务接线是 [D];brain-design X6(c) 已把它定位为通知通道)。到达不保证,worker 下一次 pull 才看到。
- **ephemeral → durable / ephemeral ↔ ephemeral**:**v1 不支持直接对话**。VM worker 要问问题,把 question 写进 `out/results/<attemptId>/questions/`(**结果辅助目录之内**——v1 写的 out/questions/ 会被 brain-design 冻结的累计 scope-violation 检查判违规,一次提问打死业务 attempt,Codex P2-6),随 milestone 发布,dispatcher 观察到后转贴到团队板,有答案再经 room 推回。慢,但复用全部现有通道,零新基础设施。诚实的代价表:VM 间协商延迟 = 一次发布周期(分钟级),所以**需要密集协商的节点对,规划时就该标 runtime=durable 或合并成一个节点**——这是规划指南,不是机制缺陷。

### 4.3 协商什么:三个高价值场景(也是 v1 的全部场景)

1. **接口对齐(sibling)**:P、Q 开工前各自把拟定接口发给对方,对齐。落地分两种(R0 v2 的切分):对齐结果**没有**与任何已验收契约冲突(纯粹补白,如"错误码用负数") ⇒ 写板 note,双方各自把它存进自己结果的 evidence 文件(§4.4);对齐结果**改变**了已验收的上游契约或验收条件 ⇒ 必须发起计划修订/裁决(CONTROL),板上只放指向它的 link——否则就是 Codex 的「分改元」反例。I 的 assignment 引用的是 evidence 固化后的内容,不是裸板 id。
2. **上游澄清(downstream→upstream)**:I 发现 P 的 patch 有歧义,直接问 P 的执行者(local 时秒级往返),省掉一轮「I 失败→repair 节点→P 重跑」的全回路。**问答改变不了 P 的已验收结果**(R0)——若答案表明 P 确实错了,正式路径照旧:板上发 link 引用对话 → 人工或 review 节点裁决 supersede。
3. **评审往返(reviewer↔author)**:review 节点给出 verdict 前,可以把拟定 findings 发给作者求证(减少误报);verdict 本身仍是正式结果,走 V1-V8,P3 VERDICT 约定(collab-primitives §2.5 [D])作为 result.json 的 body 格式。

### 4.4 对话的记录义务

效率面可丢,但不可密谋:**凡是影响了正式产出的对话,产出方把关键共识固化为自己 WORK 内的 evidence 文件**(`out/results/<attemptId>/evidence/…`,内容 = 板条目 id + actor + 摘要正文),进 resultClosureDigest 与远端留存——不是只留一个会过期的板 id(Codex P2-1)。validationEvidence 引用这个文件。做不到的对话就当没发生过——下游只认黑板与固化证据。

### 4.5 数字员工的两条补充(来自 dot-green-book 的交叉印证 [D])

把 agent 当数字员工管理的公开手册(Tiee7/dot-green-book,教 ChatGPT Dot 用户的「责任与验收」方法)与本设计的验收/角色模型高度同构(运行结束≠验收、稳定偏好与版本化事实分开、旧约定被替代要显式声明——全部已在 brain/本层)。它多出两件便宜且直接打失败模式的东西,采纳:

1. **决策权三分**:assignment 增加 `decisionRights` 区——`可直接做`(writeScope 内产出、板上提问)/ `需升级`(改契约 → 计划修订;对外副作用 → 本来就是 X6 非目标;超预算协商 → 板)/ `停止条件`(软期限到、输入失效信号、收到撤销指令)。这把散落在各节(scope/R0/R1/预算)的边界在**worker 视角**汇成一页,是角色提示的骨架——员工手册写给员工看,不是写给制度设计者看。
2. **复述再开工**:worker 的第一个动作是把「我理解的责任、输入、完成标准、我会先做什么」写成首条 milestone 的 manifest.next(或 durable 成员的首条回执)。一行成本,直接打 MAST 最大失败类(任务规格误解),dispatcher/人工抽查即可发现跑偏,不加新机制。

开源 Dot 复刻的交叉印证(2026-10 核对):CopilotKit/OpenDots(常驻同事+每 Dot 一台电脑+审批卡)明确把「多 Dot 群组对话与自动委派」列为 future work——本层做的正是三家复刻都没有的那部分;Anil-matcha/open-dots 的 deny-by-default 动作网关(高风险暂停审批+审计事件)是 decisionRights「需升级」类的机制化先例,C3 的硬记账包装器照此形态做即可。

## 5. 自动化全景:一个任务进来之后(回答"无人干预")

```text
任务进来
  → 规划(人或规划 agent)产出 plan:节点、依赖、runtime/visibility、角色    ← 唯一的"写计划"环节
  → dispatcher 装载:校验 DAG + 推导每个节点的 teammates(§4.1,自动)
  → readyTasks 循环(brain-design,自动):
      就绪节点并行派发 —— ephemeral 走 swarm-launch,durable 走 agenthop_task(本机/云 VPS 同句柄寻址)
      assignment 自带:目标/角色/冻结输入/输出契约/teammates 名册
      成员间按需协商(§4.3,自动,不经 dispatcher)
      结果发布 → O1 观察 → V1-V8 验收 → currentAccepted 解锁下游(自动)
      失败 → 分类重试 / repair 节点(自动生成,默认停 READY 等放行 —— 唯一常设人工闸)
  → 汇点(integration/synthesis,通常 durable)聚合 → job 成功
```

人工只剩两处,都是开关:计划的提出(Q2,可换成规划 agent)、repair 的放行(Q8,autoDispatch 翻开即全自动)。成员沟通全程不需要也不允许人工转信。

## 6. 失败模式(本层新增的,逐条)

| # | 场景 | 处理 |
|---|---|---|
| T1 | DM 全部丢失 / durable 成员失联 | R0 保证退化:advisory 丢了只慢不错;规范性决定本就在 CONTROL。失联处置按 §2 的 gone 语义:标 suspected、停发新 DM、查 WORK 分支新发布;**不判死、不释放、不触发 transient-infra**——断网 151 秒的 worker 可能还在算还能 push(gone 只是 roster 缺席,core.ts:287-288 [F])。执行终结仍走证据规则;急需改派走逻辑撤销 + 新 binding + 旧 binding closing,承认旧执行可能继续 |
| T2 | 两成员私聊出与已验收契约矛盾的"共识" | CONTROL 赢。规范性变更必须走计划修订/裁决(R0 v2);只落板不入账的"共识"对系统不存在,照它干活的结果可能照常通过 V4——所以防线是纪律+评审回看,不宣称 digest 能抓到(Codex P1-2) |
| T3 | 板 keeper 死,板内容丢 | 权威事实全在 CONTROL,板只有语境和指针;成员按 TTL 重发自己仍关心的条目(roster 的 re-announce 模式 [F]) |
| T4 | question 风暴 / 上下文污染 | teammates 名册限定对象;板条目有 TTL;worker 的角色提示写明"先查板再提问,同问题不重复发"。不做机制强制——成员是全功能 agent,提示纪律 + 评审回看足够(collab-primitives 的反广播立场) |
| T7 | 笔记本休眠 / VPS 挂起后恢复,旧 run 的总线身份变了 | 同 T1:失联期 suspected;恢复后以**新 run** 重新入 roster,teammates 的 handle 按运行期解析刷新(anchor 不变,聊的还是同一 attempt)。它休眠期间发布的 WORK 照常被 O1 看到 |
| T5 | durable 节点用本机/VPS 环境产出别处复现不了的结果 | 验收契约不变:输出必须自带可复现证据(V7/V8 在隔离目录核验 patch/测试)。本机特权只允许用于**执行**,不允许成为结果的隐含依赖;依赖本机的检查在 acceptance 清单里显式标 locale:local(brain-design Q3 已有此槽位) |
| T6 | DM 内容被当成输入(绕过冻结 inputBindings) | 使用约束(诚实版,Codex P1-2):V4 只核对**声明的** accepted 引用,检测不了 LLM 读过的 DM/板语境。约束 = advisory 只许影响"怎么做";改"输入是什么/契约是什么"必须走修订入账;影响了产出的语境按 §4.4 固化为 evidence。审计手段是评审回看 evidence,不是 digest |

## 7. 实施排期(全部排在 brain-design T1-T3 之后或并行,不插队)

- **C0(新增,C1 的硬前置)**:durable task/publisher adapter(§2)——P0 发送前持久 assignment/binding;发布端单父链 + manifest + artifactScope + 闭包 + 留存,全套对齐 brain-design 发布契约。没有它,durable 成员产不出可验收结果,后面全空转。前置:P0 TASK 落地(auto-task 轨道 [D])。
- **C1**:deriveTopology + 运行期身份解析(§4.1 两步);decisionRights + 复述再开工(§4.5)进 assignment/角色模板;durable 派发走 agenthop_task。前置:C0;跨机 durable 需 AGENTHOP_TEAM 已配置 [F]。
- **C2**:团队板 Stage A(note/question/answer/link,复用 directory.ts 的 LWW gossip 机制 [F],板工具本身 [D]);evidence 固化约定(§4.4)写进角色提示模板。
- **C3(可选,按痛感)**:VM 的 question 中转(out/results/<attemptId>/questions/ → 板 → room 推回);硬预算记账包装器;P2 GATHER(只在"durable 成员自己当小编排者"的场景才需要)。

每阶段可失败验收:
- C0——durable 成员发布含 merge commit 的历史时,O1 不漏其中的结果(单父纪律挡住 Codex 的 first-parent 反例);P0 RESULT 只作通知,业务状态只由 WORK+验收推进。
- C1(板未到,验收不依赖板)——菱形图 P/Q 标 durable(一个本机、一个云 VPS,证明跨机同质),对齐接口:纯补白共识直接固化为各自 WORK 的 evidence 文件(板 id 一栏暂空);改契约的对齐被拒绝、被要求发起修订;断总线 180 秒(worker 仍在算)不触发判死;spec 回滚场景下 upstream 联系人解析到 acceptedResultId 的真实产出者,不是最近完成者。
- C2——keeper 被杀,板重建,系统无感知;板条目全过期后,已验收结果的关键语境仍可从其 WORK evidence 文件取回;未固化的私聊共识对 I 不可见;C1 暂空的板引用自此补全(evidence 文件加注条目 id)。

## 8. Open questions

1. durable publisher adapter 的形态:进程内库(成员自己调,纪律靠代码)还是本机伴生 supervisor(进程隔离,纪律靠架构)?单父链/manifest/scope 义务两者相同(§2,C0),差别在违约半径。建议:v1 进程内库,够用;云 VPS 的 deploy key 范围与 X6 威胁模型一起定。
2. teammates 里 ephemeral 节点要不要给 room 地址(durable 可以主动推消息给 VM)?v1 建议给,反向(VM 发起)仍走 out/results/<attemptId>/questions/(§4.2)。
3. 板条目要不要进 validationEvidence 的强校验(验收时核对引用的 note 确实存在)?v1 建议只约定不校验,审计靠人。
