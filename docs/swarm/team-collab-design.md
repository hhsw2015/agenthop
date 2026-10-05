# 团队协作层设计:黑板共识 + 成员直接沟通

日期:2026-10-03。状态:**分层**——§1 以下的协作协议 = v2-final 冻结(Codex 两轮审查 2P1+7P2+1P3 → 0/0/0,报告 `~/Work/review-reports/team-collab-review-2026-10-03{,-v2}.md`);**§0b 的 R2+R4 执行机制(wait/approval 实体、liveness sweep、meta-job、kind:design、coveredSpecDigests)= 已冻结**(两轮审查:3P1/6P2/1P3 → 0/0/0,报告 `team-collab-R2-review-2026-10-03{,-v2}.md`;终稿快照 0a879071…)。实现注意:coverage 映射属 design 的任务身份,**必须进 specDigest**,不是计划角色注解。R3 为行为原则未进协议面、未审。冻结 ≠ 已实现:P0/C0 仍是前置。
定位:`brain-design.md`(v3-final,已冻结为实现契约)之上的**增量层**,不修改它的任何不变量。
输入:`docs/research/collab-primitives.md`(P0-P4 原语)、`docs/research/shared-blackboard-stigmergy.md`(board A/B/C 分期)、brain-design v3 的三轮 Codex 审查结论。
标注沿用:[F] 已实现事实 / [I] 静态推断 / [D] 新增设计。

---

## 0. 总设计目标:一群 Dot 的分布式蜂群架构公司(v2 表述,用户定稿 2026-10-03)

> **把整个蜂群建成「一群 Dot 组成的分布式蜂群架构公司」:具备自主协作、自主推进、自动化配合完成一个较大任务的能力,且整个流程有自我递归改进的闭环。** 四个承诺词各有落点:**自主协作** = 本文的协商面+黑板共识(§1-§4);**自主推进** = 活性原则(§0b:任何单点卡住不得使 job 永久停摆,审批与等待皆有可见/期限/旁路);**自动化配合完成大任务** = brain 的 DAG 编排+验收闭环(brain v3-final 全部);**自我递归改进闭环** = dogfood §00 的跑→记→(agent 自己)改→再跑,含「记录即处置」协议(F9)。

> 组织类比不变:每个 durable 成员是一名数字员工(稳定身份、持续责任、自己的节律、明确的决策权与验收标准);临时 VM 是按单结算的外包;dispatcher 是排任务、验成果的项目经理;CONTROL 是签字才算数的正式流程;团队板是公司 wiki;成员直接消息是工位对话。用户是老板:交代责任、放权限、看验收,只裁三类事(改原则/花钱/不可逆),不盯过程。

> **成员行为契约:像 Dot 一样工作(user 定稿 2026-10-03——每个节点的第一人称版北极星)。** 收到任务后:**自己完成它**——自己拆步骤、自己找 teammates 协商(R7 名册)、自己重试、自己安排自审;**不烦人**——找人之前先穷尽三层:账本/板(答案可能已在公共空间)→ consultFor 路由的同伴 → 自己的判断(R3:可撤的就做,留审计);升到 human 的只有真裁决(改原则/花钱/不可逆/门控指定),且必须带上下文与推荐选项,不丢裸问题;**可被看见**——进度走发布不走汇报(milestone/result/status hooks),任何时刻 viz 上能看到你在干嘛,这不是监视,是你卡住时系统能来救你的前提(§4「写进度是让自己可被救援」);**交付即验收**——完成的定义是「验收通过」,不是「我做完了」:结果带证据(负例也要,R11)、经得起异构审查、按 Delegation.ackTo 交卷。Dot 精髓四条(重读 dot-green-book 提炼,2026-10-03——「不烦人」与「不瞎做」之间的细节功夫):
> ① **假设分级,交付不阻塞**:非关键细节合理假设并声明;关键项(对应我们的:契约语义、验收标准、不可逆参数)不清时**列为待确认随成果交付**,其余部分照常完成——Dot 不会因为一个待确认项停下整件事,也不会把关键项悄悄假设掉。这是「卡住就问」与「闷头全做」之间的正确中间态。
> ② **认知三分标签**:每份交付物区分**已验证/当前假设/未知**——「完成状态不是结果正确的证明」,validationEvidence 的诚实版就是这三栏;审查者(R11 负例)查的正是假设栏和未知栏有没有被冒充成已验证。
> ③ **单一演进成果**:纠错 = 更新同一份成果并说明变化,不另起冲突副本(R9 单一事实源的交付物版;我们的「整记录新版本 + 变更注明」同构)。
> ④ **Take over / Return control**:需要人完成的**步骤**(登录、授权、一次确认)是结构化的小交接——把具体控制面递给人、人做完那一步、控制权回来任务继续;不是任务中止,也不是裸问题。approval-wait 的细粒度版:人介入的是一步,不是整个决策。

官方文档五条(learn.chatgpt.com/docs/dots 实读提炼,2026-10-03——各自的机制归属标注在后):
> ⑤ **只读主动性免批**:「proactive research is read-only; follow-up actions require permissions」——主动调研、预读上下文、草拟方案在只读空间里**永远自由**,无需任何 grant;动作才过门。给 R3 补了下界:空闲成员可以(且应该)为可能到来的任务做只读准备,这不是越权是美德(机制:读不进 admission,写才进)。
> ⑥ **更新按类分流**:routine 进度留在日志/板,decision 才进人的通道——「哪些变化值得打扰你」是委托时声明的路由规则(机制:Delegation 信封可带 notifyPolicy,缺省 = 全部 routine,只有 R12 重决策层上浮;这正是 R12 节奏匹配的通知版)。
> ⑦ **准入三值而非二值**:官方的 approval 检查结果是 proceed / needs-approval / **hand-this-step-over**——第三值是结构化的「这一步你来」(Take over 的准入侧),不是拒绝也不是全程等批(机制:approval-wait 的 resolution 已有 granted/denied,补 handed-over:人做完该步、控制权回、任务续,wait 同批 resolve)。
> ⑧ **中途改向不重启**:「return with new information or priorities without restarting the work」——人中途给新信息,折进在跑的工作而不是推倒重来(机制边界:advisory 直接折入;改契约语义仍走计划修订+新 attempt——R0 切分不破,改的是「worker 对中途输入的姿态」:欢迎、吸收、声明影响,而非当干扰)。
> ⑨ **自我监督递归**:dot 会检查自己派出的任务并追加指令——受托方对**自己 spawn 的下级**负完整的监督义务(回执/心跳/验收),R5/R7 对内同样生效;「我派了」不等于「它会好」,向下也一样(机制:self-spawn 的产出进 evidence 时须附下级的完成证据,不只结论)。

官方全册补三条(getting-started/controls/computers/channels/tasks-and-memory 全文实读,2026-10-03):
> ⑩ **规则四值,不是三值**:官方 custom rules 恰好是我们 decisionRights 的权威对照——Take action without asking(=R3 自主)/ **Take action when you say so**(=「你说了才做」:显式请求即许可,否则先问——我们缺的中间值,push 门正是这形态,S10 的机制名分找到了)/ Ask before acting(=approval-wait)/ Hand off to you(=handed-over)。decisionRights 配置按四值建模,并且官方明文「规则是 dot 尽力遵守的指令,可能出错,不覆盖内置安全要求」——即 **decisionRights 之下还有不可配置的硬安全层**,两层分明(V 系列验收、R0 账本就是我们的硬层,不受任何 decisionRights 放行)。
> ⑪ **委托上下文是选择,不是全量**:「新任务收到 dot 为该工作提供的指令与上下文,不自动获得全部对话」——assignment 的上下文是**策展**:够用的最小集 + 来源引用,不是倾倒历史。R10 上下文包的反面约束:带多了同样是错(浪费+泄露面);「可用上下文 ≠ 可披露权限」(跨 channel 一句)同时写死:成员能用某信息干活,不等于能把它交给另一个受众——R1 话题边界的信息流版。
> ⑫ **人可以直接跟下级任务说话**:官方 Activity 里人能打开任何委托任务、直接下指令,不必每次经 dot 中转——映射到我们:viz 的节点抽屉 + 总线句柄,user 可直达任何 worker 会话;协调者不是信息瓶颈也不是指挥瓶颈(R7 去中心化的人机版)。机制上这天然成立(bus 本来就点对点),写出来是为了确认:**这不是越过协调者,是设计特性**;worker 收到 user 直接指令按 R0 处理(advisory 直接吸收,改契约引导走修订)。

一句话:**领了活,人就当它已经在做了;再听到它的消息,要么是交卷,要么是真需要人的那一刻。**

**行为契约的机制分流表(user 终审:记下来不够,协议/机制上保证——每条 ①-⑫ 按三档归位;「提示档」仅限机制无法强制的认知行为,且必须有审计面):**

| 条目 | 档位 | 机制归宿(协议字段/校验/准入) |
|---|---|---|
| ①假设分级 | **协议** | TaskResult 增 `assumptions[]` 与 `pendingConfirmations[]` 字段(schema 校验);关键项清单 = spec.acceptance 派生,关键项出现在 assumptions 里 ⇒ V8 拒(关键项不许假设) |
| ②三分标签 | **协议** | validationEvidence 条目增 `basis: "verified"|"assumed"|"unknown"`;R11 负例栏核对 assumed/unknown 未冒充 verified——进 review-packet 结构检查 |
| ③单一成果 | **已有** | 整记录新版本 + resultClosureDigest(§2.5);同 attempt 第二份不同闭包 = candidate 不替换(V6) |
| ④⑦步骤级交接 | **协议** | approval-wait resolution 增 `handed_over` 值 + handedStep 记录(人做的那步进 evidence);wait reducer 已留位,随 sweep 批次实现 |
| ⑤只读免批 | **已有** | admission 只管写路径(isGranted 按动作 paramsDigest);读不经 admission——结构如此,无需新机制,写入保障总表 R3 行 |
| ⑥通知分流 | **协议** | Delegation 信封增 `notifyPolicy`(routine→log/decision→人的通道);缺省 routine 全静默 |
| ⑧中途改向 | **已有** | R0 切分照管(advisory 折入/契约走修订);worker 姿态属提示档,但「折入后声明影响」有机制面:下一 milestone 的 manifest.next 必须反映新输入(O1 可见,审计) |
| ⑨下级监督 | **协议** | self-spawn 的 evidence 必须含下级完成证据(回执/产物指针),缺 ⇒ R11 结构检查退回 |
| ⑩四值规则 | **协议** | decisionRights 按官方四值建模:auto / **on-request**(显式请求即许可) / ask / hand-over;硬安全层(V 系列、R0)在四值之下不可配置——写进 decisionRights 的 schema 注释与 admission 实现 |
| ⑪策展上下文 | **协议** | assignment 校验:上下文引用必须是显式清单(digest 引用),不许「全历史」通配;「可用≠可披露」进 R1 条文 |
| ⑫人直达下级 | **已有** | bus 点对点 + viz 抽屉,天然成立;worker 对直达指令按 R0 处理(已有切分) |

分流结果:5 条已有机制、6 条新增协议字段/校验(①②④⑥⑨⑩⑪,全部是 schema/信封/准入层的小增量,随 T1.5/T2 对应批次实现并送审)、1 条提示档带审计面(⑧ 的姿态半边)。**新协议字段统一开一个「行为契约机制化」批次送 Codex 审**——与 wait/sweep 的实现批对齐,不单独走。

> **自驱动终局检验(user 定稿 2026-10-03,整个项目的北极星验收):人只做三件事——给目标、看观测(viz 一屏)、裁三类决策;其余一切(分解、派发、协商、验收、重试、均衡、升级、改进提炼)由集群自转。** 可检验形式:跑一个完整 job,统计 human 消息数——除目标输入与三类裁决外,**每一条额外的人工消息都对应一个机制缺口**(今天的实录即反面基线:user 被迫发了几十条协调/纠偏消息,每条都变成了 R2-R12 的某一条;机制全部落码后,同样规模的 job 里这类消息应趋近于零)。脚手架期诚实声明:在 taskPass+sweep 上线前,协调者是人肉 dispatcher,user 的协调负担是**过渡成本**,不是设计形态。

这个目标给所有分层一个统一的判断标准——每个机制问一句「现实中运转良好的公司是这么干的吗」:

- 公司不开全员大会干活 ⇒ 不做群聊广播(R1 白名单);
- 口头承诺不算数 ⇒ 聊天不进账本(R0);
- 员工手册写清可直接做/需审批/何时停 ⇒ decisionRights(§4.5);
- 新人先复述任务再开工 ⇒ 复述再开工(§4.5);
- 外包不拉进员工群,验收交付即可 ⇒ ephemeral 只走黑板+调度。

商业印证:ChatGPT Dot 把「责任制数字员工」做成了单人产品;三个开源复刻(CopilotKit/OpenDots 等)都停在「单用户对单 Dot」,并把多 Dot 协作、自动委派列为 future work(§4.5)。**本项目两份契约合起来做的正是那一步:brain-design 是公司的流程制度(任务分解、派发、验收、账本),本文是公司的组织与沟通(员工分类、组织架构、沟通纪律)。**

类比的失效边界也作为设计红线:agent 不需要激励与办公室政治,不引入;人离职带走脑子,agent 的「脑子」强制外化(落板/固化 evidence),这点要求比人类公司更严。

## 0b. 活性原则(liveness,用户定调 2026-10-03):任何单点卡住都不得使 job 永久停摆

> **每一个可能的停顿都必须有三件套:可见(卡在哪、等谁、多久了)、有期限(超时后自动走旁路)、有旁路(替代路径或升级路径)。** 「等待」允许存在,「无限期的隐形等待」不允许。这是对 brain/team-collab 全部机制的一条横切要求,优先级与 R0/R1 同级。

逐类停顿的三件套(多数零件已在契约里,此处统一成表;标 ⊕ 的是本原则新增的义务):

| 停顿类型 | 可见 | 期限 | 旁路 |
|---|---|---|---|
| worker 死/失联 | ephemeral:无信号;durable:gone→suspected | ephemeral:physicalExpiresAtSec(证据驱动);durable:⊕suspectedSince 起算的核查期限(建议 2× 心跳) | binding closing → 新 binding/新 attempt(至少一次语义,本来就有) |
| 任务反复失败 | attempt.failureClass + retriesUsed | retryBudget / job 预算 | repair 节点;required=false 的节点失败不挡 job(**仅当不在任何必需节点的依赖闭包内**,v2 与执行机制段一致) |
| 验收悬置(候选观察到但验不动,如 V8 执行环境坏) | ⊕ RPV 停留时长进投影(含可恢复的绝对时刻,非仅 seq) | ⊕ 验收超时(建议 2× estimatedRuntimeSec)→ 建 validation 执行记录,**非** transient-infra(v2 与执行机制段一致:已有 pinned candidate,不重跑业务) | 换 validator 执行位(保留原 attempt/候选引用,回复绑定 candidate+validation run) |
| 依赖永不满足(上游终败/被 supersede 后无人重跑) | jobStatus=blocked + 卡点节点名(已有) | ⊕ blocked 持续超阈值(建议 30min)→ 投影标 escalation:true | repair / 计划修订;人工 |
| **人工审批(repair 放行、live 门控、计划批准)** | ⊕ 投影新增 `pendingApprovals[]`:{what, askedWho, askedAtSec, blocksWhat} —— 审批等待必须是一等公民数据,不是会话记忆 | ⊕ 审批超时不自动放行(安全红线:**超时推进只适用于可逆/非特权动作**),但升级:重提醒→改派给其他 visible 成员→标 escalation | ⊕ 预授权票据:human 可事先给一类动作发「条件自动批」(如 autoDispatch:true、预算内重试免批),把审批从「每次等人」变「越界才等人」 |
| 协商无进展(sibling 对不齐接口) | 消息预算耗尽即信号(R1) | 预算上限就是期限 | 升级为板上 question → integrator 牵头裁决 → 计划修订 |
| dispatcher 自己死 | 投影 lastAppliedSeq 停滞,⊕ viz 可渲染「大脑心跳」 | 本机重启恢复(T2);跨机 T3 后按 CONTROL 重放 | T3 前诚实承认是单点(非目标 5);T3 后新 dispatcher 接管 |

**与安全边界的关系(重要,防止活性吃掉正确性):** 活性旁路永远不得绕过验收(V1-V8)、不得伪造物理证据(UNKNOWN 保守计占用的规则不变——那是算力守恒,不是卡死)、不得替 human 批不可逆/特权动作。自动化的边界是:**可逆的等待自动旁路,不可逆的等待自动升级**。升级的终点仍可能是人,但到达终点的路径是系统铺的、可见的、带时限的,不是靠谁想起来。

**执行机制(v2,用户两次纠偏后定形——原则不靠文档与自觉,靠结构):**

> **R2(推进守恒):任何需要被推进的事物,必须以耐久记录存在于系统唯一的推进循环可见处;不在耐久状态里的等待/审批/待办,对系统不存在。** 推进是 pass 循环的属性,不是任何成员(含协调者)的记忆或美德——成员可以死、可以空闲、可以忘,循环 + 耐久记录保证前进。

三条结构化落地(**v2,按 R2 审查 2P1+5P2 逐条修订**,报告 team-collab-R2-review-2026-10-03.md;取代一切「纪律/自觉/定时器」类方案):

1. **Wait/Approval 成为 CONTROL 一等实体**(Change union 增 `{put:"wait", …}`,协议变更,待终审冻结)。v2 形状按审查的最小落地:

```text
WaitRecord {
  waitId, kind: "wait" | "approval"
  subject: { jobId, attemptId?, bindingId?, observedResultId?, validationRunId?, approvalRequestId? }
                              // 有类型的锚定(P2-1):wait 绑具体执行对象,旧 wait 不得作用于新 binding/attempt
  state: "open" | "action_pending" | "resolved"     // P1-1:决定-执行-确认三段,各自耐久
  deadlineSec, owner
  timeoutPolicy: 预定义的 bypass 或 escalate 策略引用。**escalate 的完成只 resolve「升级通知」这个动作,绝不 resolve 原 approval-wait**(终审②):原 wait 保持 open、decision 仍 pending,同批更新新的核查 deadline 并记 escalatedAt——监督转移而非消失
                              // 【勘误 2026-10-03(经 Codex sweep 增量审查问出+纯层 owner 契约核对拦截,F8 纪律:裁定与契约文字一个动作)】
                              // 上一行的原则同样适用于普通(reversible)wait 的 bypass 催办:**任何超时动作的完成都只结束
                              // 「该动作」,绝不 resolve 原 wait**——wait 代表被等待的工作/答复本身,催办送达证据不能替代
                              // 完成/旁路证据。action_done(催办类动作完成)⇒ 回 open+新 deadline(re-arm,记 escalatedAt 同款字段);
                              // resolved 只能来自:subject 正常完成(同批 close)/改派(close+new)/预算耗尽终态通道(若 A1 增补冻结)。
                              // 原文「完成有证据才 resolve」中的 resolve 范围写松了,特此收紧;原则(监督转移而非消失)自始一致。
  pendingAction?: { actionId, actionKind, target, expectedSubjectVersion }
                              // 超时处置 = 先 CAS 提交这个可恢复的动作意图(复用同 actionId 重试),后 IO,
                              // 完成有证据才确认动作完成(action_done)——绝不先改状态再 IO,也绝不先 IO 再记录(P1-1 两个崩溃窗口)
  resolution?: { outcome, reason, sourceOperationId }
}
Approval 分支(P1-2:resolved ≠ granted,等待结束与授权成立是两回事):
  actionRef + paramsDigest    // grant 绑定到具体动作与参数摘要
  approvalAuthority           // 谁有权批——visible 成员只承接通知/协调,不因可见获得审批权
  decision: "pending" | "granted" | "denied" | "cancelled"   // escalation 只产生通知,永不产生 granted
  grantRef / preauthorizationRef?   // 预授权票据同为耐久记录:issuer/适用条件/有效期/撤销版本/额度占用同批提交
受保护 IO 的准入 = 核对与 actionId+paramsDigest 匹配的有效 grant,不是「没有未解决 wait」。
```

  竞态裁决(P2-1):正常完成/取消/替换与对应 wait 的关闭**同批提交**;超时动作执行前重读 subject 当前状态,正常完成先提交则超时不再 IO;超时意图先提交则晚到的完成按 closing/候选规则处理在途动作。

2. **dispatcher pass 增 liveness sweep 步**,边界按审查收窄:
   - **聚合状态只发现,不执行**(可观测性追加审的总约束):总线 status/投影是 hint——发现待处理项;一切状态转换与受保护 IO 必须重读当前 CONTROL 的 subject/state/revision、走既有 ready/admission/授权、先提交稳定 intent 再 IO。idle 不证明空槽,blocked 不自动等 approval,suspected 只触发核查,终结仍走证据。
   - **sweep 必须有有界调度延迟**(P2-3):被监督的慢 IO 不得阻止监督步运行——慢动作记录意图即返回循环,后续观察完成;每个前置步骤的时间片不超过相关 deadline。
   - **RPV 验收环境超时 ≠ 业务 transient-infra**(P2-2):已有 pinned candidate 只是验不动时,建 validation 执行记录换 validator 执行位(保留原 attempt/输入/候选引用,回复绑定 candidate+validation run),不重跑业务。
   - **活性承诺的诚实措辞**(P2-3):R2 保证 =「在推进循环运行、存储可用的前提下,等待不遗忘、不静默,到期进入明确的重试/升级/终态」。awaiting-human 可以长期存在;单活 dispatcher 死且无接替时耐久 wait 不自动执行——接替条件是部署前提,不是本协议能证的。
   - **required=false 的边界**(P2-4):非必需节点失败不影响 job 完成,**仅当它不在任何必需节点的依赖闭包内**;在闭包内仍需 repair 或正式计划修订解依赖。
3. **元工作入任务系统,不另设台账**。meta 是 job 用途标签,**不加新 kind**(审查答复 4);交付分三级(P2-5):登记/排期(文档存在+结构检查即可)、方案(同前)、**实施并验证改进**(必须用原反例验证,且遵守原有审查/授权/变更流程)——「落点文字存在」只能验收前两级,冒充第三级即 meta-job 失败。同一 dogfood 问题用稳定来源标识去重,不得每轮再生无限元任务。

**R3(决策自主,用户定调 2026-10-03):自主优先;审批只因真实门控存在。** 两层判据(v3 与段中机制一致):第一层**可撤性**——可撤(本地/分支提交、投影字段、重试、改派、文档沉淀)默认自主,难撤或有害半径大(对外发布/部署、花钱超票据、不可恢复删除、改安全边界/凭据、改已冻结协议)默认要批;第二层**真实策略/执行端门控优先于默认**——可逆动作若被策略或执行端门控指定要批(S10 的 push 门即实例),照批,R3 不豁免任何真实的门。灰区按「能否构造便宜的撤销路径且无门控约束」现场判。每个 approval-wait 带 approvalReason(解释性:不可逆/特权/用户指定门控,审计用——**字段不是授权事实**,v2 按 S9+R3 审查 P1-2):开启 approval 的依据是**真实策略/用户门控判定**(含可逆但被策略/执行端门控指定要批的,如 S10 的 push 门);已有适用的有效 grant/预授权票据 ⇒ 不重复等批直接执行;缺 approvalReason 字段 ⇒ 修复请求重提,**绝不**转为原动作自主执行(那会让格式错误变成越权通道)。这是 decisionRights(§4.5)的默认值反转:v1 把「需升级」当保险默认,R3 把「可直接做」当默认,升级要自证必要。

**S11 消息纪律(user 定调 2026-10-04,行为契约增条)**:一切蜂群消息带任务锚——json={via,taskRef,title(≤15字标签),text(纯正文)};裸文本通道=[taskRef] title 头行。字段与正文不互相复述;发件人由传输层携带不自报。代码归宿:InboxMsg 增 taskRef/title 字段+信封自动携带(4/n),届时由 schema 强制。

**R3-b(问询不裸等,user 定调 2026-10-03):任何向人/上级发出的问询,必须自带默认选项与决断期限,到期按默认执行——除非该事项本身是真实门控(三类裁决),那才允许无限期等。** 问题形状:「我倾向 X,理由一行;若 T 前无答复,按 X 执行;可改」。机制落点:这样的问询 = 一个 timeoutPolicy:"bypass" 的普通 wait(默认选项就是 bypass 动作),到期 sweep 自动按默认推进——复用既有实体,零新机制;真实门控才开 approval-wait(timeoutPolicy:"escalate",可以长期 awaiting-human,A1 预算只停自动催办不停等待)。判据接 R3 两层:可撤的决策问询必须带默认(问只是礼貌与透明,不是让渡推进责任);难撤的才允许真阻塞。反面实证(2026-10-03 当天两例):实现方「(a)-(d) 你定」停在检查点裸等、纯层 owner 整单挂起等裁定——协调者恰好在场所以几分钟续上,不在场即死等;正确形状是「无答复则按 (c) 安静 hold 到 reducer 落地」这样的自带默认。

机制化形状(纯层 owner 提案+协调者裁定 2026-10-03,随本条一起送审):
- 问询 wait = 普通 wait(kind:"wait", timeoutPolicy:"bypass")+ **耐久默认** `defaultOnTimeout:{outcome, reason, …}`(在记录里,sweep 与恢复都看得见;便捷构造 openQueryWait,零新 reducer)。
- **到期应用默认走 close,不走 action_done,也不是第四种 resolved 来源**——定格框架:默认是**预存的答复**,到期 close(outcome:"default-applied") 就是「subject(问题)正常完成,答案来源=默认」,与勘误「resolved 只来自 close」自洽。应用默认无必要 IO(通知发问方是 advisory,R0;答复以耐久 wait 状态为准,发问方观察消费),故无 CAS-then-IO 窗口,直接 CAS close。
- 人提前答复与到期默认的竞态 = 两个 close 争同 revision,既有 CAS/replay 规则裁决,晚到者被拒(P2-1 同款)。
- **类型层不变量**:bypass 问询 wait 必须带 defaultOnTimeout;approval(真实门控)必须不带——「问询不裸等 vs 门控才裸等」在类型上分开。实测依据(双面,与 S10 一致):「push 共享分支」按可撤性属自主类,但该成员的执行端存在真实门控(其 user 的明确指令)——R3 的正确结论是**协调者不再把「无门控的可撤动作」误开成审批等待**,而不是「有门的也该自主」;门的变更只能来自门的 owner。

**R4(先设计后实施,用户定调 2026-10-03):重大实施前必须有一个显式的设计阶段——召集相关成员、碰撞方案、对抗审查、冻结共识,然后才动手。** 前期多烧的讨论,买的是后期返工概率的坍缩——本项目自身就是证据:brain 契约三轮对抗审查(5P1/8P2→0)全部发生在零实现时,每条反例的修复成本是改一段文字;同样的错留到代码里,是改模块+重测+重审。

机制化(**v2,按 R4 补审修订**——首版有互等死锁:design 的 accepted 等 review 节点通过,review 节点又 dependsOn design 的 accepted;已按方案二消解):
1. **重大任务的 plan 必须以 design 节点开头**:kind 增 `design`(协议面,待终审)。**对抗 review 是 design 节点的验收活动,不是 DAG 节点**(与 dogfood S1「流水式 review=验收活动」同一原则):design 的候选产出(设计文档,report/notes 形态)发布后停在 RPV,固定 candidate SHA/闭包,V8 = 核验**绑定同一设计版本**的对抗 review 证据(P1/P2 清零或显式例外批准)——通过才 CONTROL 接受,实现节点 dependsOn design 的 accepted 因此才解锁。**实现开工前设计已冻结**由 DAG 结构保证,且无互等环。V7 对 design 退化为必需产物(设计文档)存在+结构+闭包,不伪造代码测试。
2. **召集即 teammates 推导的设计期版本**:design 节点的 assignment 自动带「利益相关名册」——下游实现节点的(预定)执行者、被改动模块的 owner、至少一个异构 review 成员(S3)。owner 映射 v1 = **plan 内冻结的映射**(带 digest 引用),不加新 CONTROL 实体。头脑风暴 = 设计期 sibling 协商(§4.3 场景 1 放大版),结论按 R0 落板/落契约。
3. **「重大」的判据,loader 机械执行**(R4-P2):四条件 OR(跨 ≥2 个 owner 地盘——按 plan 冻结 owner 映射数;改冻结契约/协议;估算 > 阈值——jobBudget 同级配置;不可逆动作在关键路径)统一落在 loadPlan 校验,且验证**每个受约束实现节点的依赖祖先里有 design 节点**。**设计门绑定覆盖范围(终审①,v3 收缝)**:coveredSpecDigests(design 审过的各实现节点 specDigest 映射)是 **design 节点 spec 的一部分**(规划器写入),不在 accepted 里。于是闭环全走既有机制:计划修订改了 M 的 spec ⇒ 规划器同批更新 D.spec 的覆盖映射 ⇒ D 的 specDigest 变 ⇒ currentAccepted(D) 因 spec 失配自动 null(§3.1 既有规则)⇒ D 重新 ready 可调度重审,M 因依赖 D 自然 blocked——**无需新失效通道,也不存在「M blocked 而 D 不可调度」的死等**(终审最后接缝)。loadPlan 校验补一条:受约束实现节点的 specDigest 必须 ∈ 其 design 祖先 spec 的覆盖映射,否则整图拒(规划器忘更新映射 = 非法 plan,装载期就挡)。不满足的小事直接做(R3),不得拿 R4 当拖延——设计讨论自身受 R2 wait 纪律约束(有期限)。

实证:本项目全程就是 R4 的人肉版(契约→审查→冻结→实现→符合性 review),零方向性返工(dogfood S1/S4);R4 把这条已验证的路径写进 plan 结构,让未来的蜂群 job 天然走它。

**R6(最大并行,用户定调 2026-10-03):能并行的绝不排队。** 判据 = 依赖与资源,不是习惯:两件事之间**没有** DAG 依赖边、**不碰**同一 owner 地盘(写冲突)、**不抢**同一稀缺资源(cap/同一审查者),就必须并行派发,串行要自证必要。机制落点(多数已有,此条把它们接成一个承诺):① readyTasks 天然全量放行就绪节点——brain 的 DAG 语义本身就是并行引擎,计划里人为串行化(加不必要的依赖边)是规划反模式,R4 的 design review 应当查它;② 稀缺资源不应闲等——同类角色可多实例(如多个 Codex 会话并行审不同批次,今天实际发生过);③ 协调者巡检的空闲×无主匹配(R2 循环)保证「有活没人干」与「有人没活干」不并存;④ 流水线不等待(dogfood S4:绿一个发一个、review 异步)已是实践,此条升为规范。反例警示:并行的边界是 R0/R1/写 scope——并行不等于两个会话改同一文件(F 类写冲突),也不等于绕过依赖消费未验收输入。

**R7(委托自带通讯方案,用户定调 2026-10-03):派发一件任务时,把完成它所需的协作关系一并交付——找谁 review、问谁澄清、期限多少、回执给谁,写进委托本身;受托方也可自建下级协作(在自己的 CLI 里起后台 agent 做自审),但自建的下级同样受 R5 约束。** 这是 teammates 名册(§4.1)从「实现节点的 DAG 邻居」到「一切委托」的推广:委托信封的标准字段 =

```text
Delegation {
  task, deadline, ackTo              // 活、期限、回执地址(稳定句柄,R5 可观测通道)
  reviewBy?: handle | "self-spawn"   // 审查者:bus 上现成角色的句柄,或授权受托方自起后台 agent 自审
                                     //   自审产物同样走 evidence 固化(§4.4),且重大产出仍须异构终审(S3 不豁免)
  consultFor?: { topic → handle }    // 按话题的咨询路由(「契约疑问找 fe0376cd、bus 语义找 Work-20cab0a5」)
  escalateTo?: handle                // 卡住时的升级地址(默认回 ackTo)
}
```

机制归宿:它就是 assignment.teammates 的委托级等价物——brain 的 assignment 已带 teammates(实现节点用),R7 把同一形状延伸到协调期的临时委托(review 单、修复单、调查单);wait 实体的 owner/ackTo 对齐此处。受托方自起的后台 agent 是「受托方的内部资源」,不进全局名册、不占 cap,但其产出进 evidence、其通道受 R5(裸 detached 不算自审完成的证据通道)。实证来源:今天的复验单已经在人肉这么做(委托里写明回执给谁、产物路径、按什么纪律自报)——R7 把它变成信封标准字段。**R7 的真正收益是去中心化协调**(用户点破):受托方知道该和谁沟通,疑问/审查/升级都直连对应角色,不再每件事都回协调者中转——协调者从「所有消息的路由器」退为「例外处理器」,其负担与成员数解耦;这也是 R6 并行的前提(两两直连的协作不经过中心瓶颈)。协调者只在三处出现:派发时写路由、例外升级、验收。

**R8(容量前置规划,用户定调 2026-10-03):派活之前先算角色容量——需要多少个什么角色,提前备齐;稀缺角色过载时起新实例,而不是让队伍在它门口排队。** 两半:

- **派发期的容量核算**(协调者/规划器职责):一批任务放行前,按角色维度数需求——N 个实现件要几个 reviewer?审查者当前有几单在手?不足时的顺位(勘误 2026-10-03,两来源):**① 先用已存在的空闲同类实例**(名册上 idle 的同角色会话是第一扩容来源——「有人闲着还排队」是双重浪费,user 实测点破:bus 上躺着空闲 Codex 无人派);**② 再建议起新实例**——扩容建议是协调者职责,**执行受资源 owner 的门控约束**(起常驻实例是资源承诺,须经该会话 user,S10 资源版实证),协调者不能命令扩容;③ R7 self-spawn 自审分流轻量单。判据沿 R6:同角色多实例审**不同批次**零冲突,天然可并行;同一批次不拆两人(避免标准漂移)。扩容本身是可逆动作(R3 自主类),不必等批。
- **角色负载进推进引擎**:reviewer 也是成员——它的在手单数就是「成员状态面」的一部分(投影 members.activeBindings 已有形状);sweep 的空闲×无主匹配反向用 = **过载×排队时触发扩容建议**。review 单作为 wait 登记时,台账即天然看见「谁门口在排队」。
- 实证:今天 happycapy Codex 单实例串行吃了全部审查(协议五批+实现三轮)——幸而批次恰好错开,没塞车;但 R6 并行化后审查需求会翻倍,单 reviewer 必然成为瓶颈。R8 是 R6 的配套:**并行产出要配并行验收,否则只是把队伍从实现端挪到审查端**。
- 边界:扩容的新实例无历史上下文,首单配「上下文包」(契约路径+既往报告索引——review-packet 模板已是现成形状);异构要求(S3)按产出类型保持,不因扩容降格为同构互审。

**R9-R12(协调者自提批次,2026-10-03——按 F9'不等 user 发现'主动提炼;各自有今日实证,未经事故验证的部分标注为预防性):**

**R9(单一事实源):同一事实在系统里只许有一个权威copy,其余必须是派生投影。** 今日实证三起:契约 integration 本体 vs swarm-brain 分支副本两度漂移、我台账与真实会话状态脱节(F13)、裁定在消息里而契约文字滞后(F8)。既有机制(CONTROL 权威/mirror 投影、判定下沉)已是此原则,R9 把它扩到**一切**工件:文档以 integration 为本体,分支副本标「同步于哈希 X」;台账以 CONTROL wait 为权威(脚手架期标过渡);口头裁定不是事实,落账才是。违例检测:出现「两个地方都声称是最新」即违反。

**R10(交接带完整上下文,预防性):成员更替/新实例加入时,上下文包是交接的一部分,不是新成员的自助作业。** 包 = 契约路径 + 相关报告索引 + 当前在途 wait + 它的 decisionRights。实证:R8 扩容新审查实例配包;f32a0507 接手 b26fa697 时靠 handoff 自带 brief(当时顺利是因为 brief 写得好——把运气变成规定)。

**R11(验收包含负例):任何「它能工作」的声明必须附带「它该拒绝的都拒绝了」的证据。** 今日全程实证:T1 验收 8 类坏结果逐条拒、R2 审查的最小验收集合全是反例、复验探针 9/10 是失败场景。升为规范:review packet 的测试清单必须分「正例/负例」两栏,负例空白的 packet 退回——「410 绿」不说明什么,说明力在「该红的都红过」。

**R12(节奏匹配,预防性):高频轮次配轻量通道,重决策配重流程——不给小事开大会,不给大事走捷径。** 判据表:候选级(discard/重试)= 直接做+审计;attempt 级 = 流水 review;协议级 = R4 设计门+异构审查;原则级 = user。今日反面教材:我曾把「push 分支」(轻)误放进审批(重),又把「裁定落账」(重)当顺口一提(轻)——两个方向都错过。机制归宿:decisionRights 的粒度分层即此表,实现时按它配通道。

(自提批次的审查安排:R9-R12 不动协议面——全部是对已冻结机制的使用纪律——按勘误通道记录,下一批协议件送审时请 Codex 顺带核一遍定性是否准确。)

**原则的机制保障总表(2026-10-03,user 终审要求「每条原则必须有机制去保障」——此表是 §0b 的收口:每条 R 原则 → 它的强制机制 → 违例如何被系统抓住,而不是靠人记得):**

| 原则 | 强制机制(谁在什么时刻机械执行) | 违例如何被抓 |
|---|---|---|
| R0 账本守恒 | commitControl 是唯一状态写入口;DM/板无写账能力(结构性,非纪律) | 不走 commit 的「状态」对系统不存在,自然失效 |
| R1 白名单沟通 | teammates 名册 = assignment 字段(不发名册外句柄);硬记账 C3 按触发条件 | 评审回看 evidence;预算耗尽即信号 |
| R2 推进守恒 | wait 实体(不开 wait 的等待不存在)+ sweep 是 pass 固定步(代码,非人) | sweep 扫到过期/UNVERIFIABLE 即自动处置 |
| R3 决策自主 | decisionRights per-member 配置 + 执行端 admission(isGranted 按 paramsDigest) | 无 grant 的受保护 IO 被准入拒;乱开 approval 被「缺真实门控依据」拒载 |
| R4 先设计后实施 | loadPlan 校验(重大四条件 OR→design 祖先→coveredSpecDigests 结构) | 非法 plan 装载期整图拒 |
| R5 可观测委托 | wait.verify 准入(UNVERIFIABLE 拒开)+ sweep owner-dead 旁路 | 黑箱委托登记即拒;失联自动改派 |
| R6 最大并行 | readyTasks 全量放行(引擎天然并行);规划反模式由 R4 design review 查 | 人为串行边在设计审查被问「为何不并行」 |
| R7 委托带通讯 | Delegation 信封字段(assignment.teammates 的委托级等价) | 缺 ackTo/deadline 的委托,台账拒登记 |
| R8 容量前置 | **sweep 增一条匹配规则(本表新增,机制缺口补钉):过载检测 = 角色在手 wait 数 > 阈值 ∧ 名册有同角色 idle ⇒ 自动产出「改派建议」动作(begin_action 走 R2 链);无 idle 实例 ⇒ 产出「扩容建议」wait 派给资源 owner** | 排队与空闲并存时 sweep 下一轮必然产出动作;建议未被处理 = 过期 wait,再升级 |
| R9 单一事实源 | 投影/副本必须带「derived-from 哈希」字段;判定下沉(消费者无计算权) | 两处声称权威 = 哈希对不上,核验即穿 |
| R10 交接带上下文 | 上下文包是 Delegation 信封必填(新成员首单缺包,受托方有权退单) | 退单即信号 |
| R11 验收含负例 | review-packet 模板的正/负例两栏(负例空白退回)——模板已落库 | packet 结构检查 |
| R12 节奏匹配 | decisionRights 粒度分层表(候选/attempt/协议/原则级各配通道) | 错层调用被对应层的准入拒 |

表中唯一新增机制 = R8 的 sweep 过载匹配规则(第五条匹配:忙闲失衡→改派/扩容建议),归 IO 轨 sweep 接线批次——其余各行都是已冻结机制的引用,本表的作用是让「原则没有机制」这件事**本身可检查**:新原则入 §0b 时必须同时填这张表,填不出强制机制列的原则只能标「纪律(过渡)」并挂机制化欠条。

**R2 与可观测性是同一枚硬币(用户点破 2026-10-03):推进引擎 = 两个输入 + 一个循环。**

```text
输入1:每个节点现在在做什么(成员状态面)
    = 总线 status(working/idle/blocked [F]) + 投影 members.json(reachability/runDrift/activeBindings)
      ——含「每个角色几单在手、谁空闲」:负载可见性就是成员状态面的一部分(user 定调:
      知道有哪些角色/各在干什么/谁闲着,是负载均衡的前提——均衡是观测的消费,不是独立机制)
输入2:每件事进展到哪、卡在哪(任务状态面,公共空间)
    = CONTROL 投影(attempts/results/jobStatus) + wait 实体(等待/审批台账)
循环:liveness sweep 每轮消费这两个输入,机械匹配(五条):
    空闲成员 × 无主 ready 任务  → 派发
    过期 wait                  → bypass / escalation
    blocked 成员 × 其 wait 记录 → 审批催办 / 改派
    suspected 成员 × 其 binding → 核查 / closing
    过载成员 × 同角色 idle 实例 → 改派建议;无 idle ⇒ 扩容建议 wait(R8 负载均衡,门控照 S10)
```

推进能力不足,永远先问:是输入缺了(某种状态没被写进公共空间——那就补实体/字段),还是循环没消费它(sweep 缺一条匹配规则——那就补规则)。**人来提醒 = 两个输入某处有洞的症状**,修洞,不修人。这也给公共空间立了准入门槛:一种状态若不进投影/CONTROL,它就对推进引擎不存在——「写进度到公共空间」不是汇报义务,是让自己的卡点能被系统救援的唯一途径(员工视角的激励相容:写了才有人管你)。

进度的真实数据源此处明确(防止「公共空间」被误解为又一个手写台账):worker 的进度 = WORK 分支 milestone + result.json(已有);成员的忙闲 = 总线 status hooks(已有 [F]);等待/审批 = wait 实体(R2 新增);任务轴 = CONTROL(已有)。**没有新的「进度汇报」动作**——公共空间是这四个既有通道的投影聚合,swarm-viz 渲染的就是它。

**完成上报与再调度的触发链(user 定调 2026-10-03:完成必须触发状态改变,状态改变触发新调度——此段把既有链路说显式,并补一环):**

```text
业务任务完成:worker 写 result.json → 请求 milestone(发布=上报,收件人是公共空间,不是某个人)
  → [补环] 完成 ping:worker 经既有通知通道(ephemeral:room send;durable:总线消息)发一行
    「result published @<commit>」——纯 hint,只用于把 O1 的下一次扫描提前到现在,
    不能替代发布(没 ping 照样被轮询扫到,慢但不丢;ping 了没发布 = 无事发生——hint 不执行)
  → O1 观察 → V1-V8 验收 → accepted 落账(状态跃迁,任务状态面改变)
  → currentAccepted 翻转 → 同轮 readyTasks 解锁下游 → 派发(完成即触发新调度,闭环)
汇总到整合方:integration/synthesis 节点的 inputBindings 引用全部上游 accepted——
  「汇总」不是谁把结果搬给谁,是整合节点作为普通任务被解锁后,按冻结引用自取(brain §4.4)
协调级委托完成:回执给 Delegation.ackTo(R7),其 wait 同批 resolve——台账行消失即状态改变
```

要点:**「告诉谁」的答案是「告诉账本」**——完成写进公共空间,所有依赖方(下游节点、sweep、viz、协调者)从账本各取所需;点对点通知一律只是加速 hint。这保证完成事件不因「该通知的人死了/换了」而丢(账本不死),也正是观测与推进同一枚硬币的完成侧。

**ping 的第二重价值:唤醒(user 点破 2026-10-03)。** agent 会话是事件驱动的——没有消息进来就不转;若全体都在「等下一轮轮询」,系统就有全员静默的间隙,极端情况(轮询者自己也闲置)= 整体卡住。完成 ping 恰好构成**事件驱动的接力链**:每个完成事件主动戳一下相关方(ackTo/下游执行者/sweep 宿主),被戳者醒来处理、产生自己的完成、再戳下一个——活跃度沿 DAG 自传播,**只要还有任一任务在动,系统就不会全员沉睡**。轮询(O1/sweep 周期)仍是正确性保底(ping 丢了照样被扫到),ping 是活性加速——两者缺一:只有轮询 = 慢但不死;只有 ping = 快但一次丢失就断链。机制义务:Delegation.ackTo 与 assignment 的下游名册就是 ping 的收件人来源(R7 字段复用,零新结构)。

人工协调阶段(dispatcher 未上线)的过渡:协调者的等待台账与巡检 tick 是**脚手架**,显式标记为「taskPass liveness sweep 上线即拆」;脚手架的存在本身被记为 wait 实体的待迁移项。

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

**基石三元组(user 定调 2026-10-04,F21 复盘后):可观测性、自驱动、消息通讯是同级的核心环节——任何一个缺位,无人值守就塌。** 这是 Dot 的核心功能定义:Dot 之所以能「给目标后自己做完」,靠的恰是这三根柱子,缺一即退化回需要人盯的工具。三者的关系与分工:
- **消息通讯**是加速器:让完成信号快速传播。但它可以丢(会话掉线、名册失明),所以**永远不作唯一通道**。
- **可观测性**是地基:每个状态、每个完成、每个等待都有「不依赖任何会话在线」的耐久落点(wait 实体/产物文件/两证据面)。消息丢了,事实还在盘上,谁都能来核。
- **自驱动**是闭环:sweep 这样的推进循环定期对照耐久事实,发现「该走没走」就推一把。它消费可观测性、容忍消息丢失。
- **自我递归改进**是免疫系统(user 补定调,F21 当晚):前三者保证单次任务做完,它保证**同一事故不发两次**。**其经济学本质(user 再定调,同晚):重复踩坑是最大的时间成本浪费**——第一次踩坑付的是学费,第二次踩同一个坑付的是纯浪费,且按「时间是最大成本」计价:一次 F21 级的复发 = 再烧一次全集群的静止时长 + 一轮完整的诊断-修复链。因此免疫系统的投资回报永远为正:记录即处置(F9)的四步成本是分钟级,而它防住的每次复发是小时级。坑的清单(dogfood F 系列)就是集群的免疫记忆,其条目数只增不减、其复发数应恒为零——**「同编号 F второй次出现」本身要立即升级为最高优先级事故**,因为它意味着免疫系统自身失效。F21 本身就是它的实弹检验:事故发生 → 当场三层根因 → 机制当场落地(wait 实体登记+常驻 sweep 循环,事故后 30 分钟内跑起来,不是文档承诺)→ 原则入契约 → 判据可验收。四步缺一步,改进就退化成「记过了但还会再犯」。
判据(F21 的教训升为验收):**系统中任何一条「正在等 X」,断网断总线断会话之后,仅凭文件系统必须仍能回答三个问题——在等谁、到期没有、完成的证据应该出现在哪**。回答不了的等待,就是下一次全集群静止的伏笔。

**停摆定理(user 命题,2026-10-04 F21 复盘后的系统反思):「所有节点停止」只允许是任务完成的推论,绝不允许是事故。** 形式化:AllIdle ⇒ jobStatus ∈ {succeeded, failed, awaiting-human-gate}。逆否命题即运行不变量:**任务未完,则任一时刻以下三者至少其一非空**——
- E(执行集):至少一个节点在干活;
- W(武装等待集):至少一条耐久 wait 带未到期 deadline,且 sweep 循环活着(到期必有动作);
- R(就绪集):至少一个 ready 任务,且 dispatcher 活着(下个 tick 必派)。
E∪W∪R 为空而任务未完 = 停摆事故(F21 即此形态:推进责任只存在于协调者的内存提示词与总线消息里,三集皆空)。

**推进责任的监管链(custody)规则**:推进责任在任何时刻必须有**唯一、耐久记录**的持有者——某节点(binding)、某 wait(owner+deadline)、或人(approval-wait,三类裁决)。责任交接必须是耐久转换(完成与下游唤醒同批提交:close wait + 下游节点 ready 是同一个 commit 的两面,ping 消息只是加速器)。**责任只活在内存、消息、或某人记忆里的瞬间,就是停摆的伏笔**——F21 的全部三层根因都是这一条的违例。

**合法的全静默只有两种形态**,且都必须可观测:① 任务终态(投影 jobStatus 可查);② 等人裁决(approval-wait open 可查,sweep 对它安静但武装——awaiting-human 不是「都停了」,是「一条 wait 挂着、看门的醒着」)。user 看板上「全员 idle 且无 open wait 且任务未完」应渲染为红色事故,不是平静。

**诚实的剩余单点(v1)**:sweep/dispatcher 自身是心跳源——它死,W/R 两集失去看守,集群退化为纯 E(正在跑的节点跑完即静)。v1 立场:单活 dispatcher 是既有部署前提,「保住一个进程」远易于「保住 N 个协调者会话」;协调者 harness 的定时唤醒作冗余第二层;dispatcher 心跳+外部重启的完整方案归蜂群日常运行批(欠条,触发=蜂群进入持续运行)。

**R13(无人值守收尾,user 定调 2026-10-04):人可以随时走开;集群必须能自己把「做完 → 装上最新 → 安顿机器」这整段跑完。** 人不可能一直在场等收尾,这是开发流程的一部分,不是临时安排。协议形状(今晚首次实弹,2026-10-04 凌晨):
1. **收尾序列显式化**:人离场前,协调者给出检查单(在途链各环的完成判据 → 合并范围 → 构建+安装+版本验证 → 收尾汇报落盘 → 安顿动作)。检查单本身是耐久记录,不在人脑里。
2. **质量不因无人而降**:人不在场时,审查轮次照常跑满(「不赶时间,做好为止」),返工照常;无人值守恰恰要求更严,因为没人能当场纠偏。
3. **本地环境必达最新**:收尾必含「把本机安装更新为合并后的最新版本」——下次人回来,用的就是包含全部修复的版本,不带「我是不是在用旧版」的疑问成本。
4. **安顿动作有授权边界**:关机/休眠等机器级动作需人显式授权(本次:user 给出强制关机授权);授权是一次性的、针对本次收尾的,不是常设权限。
5. **卡死不冒进**:任何环节卡死且探问无果 ⇒ 不执行安顿动作,留完整现状说明,宁可机器亮着等人,不把半成品封进关机。
6. **离场前的问询按 R3-b**:带默认带期限,人走后到期按默认推进,不裸等。
机制归宿:v1 由协调者会话人肉执行本协议;vNext 可做成 closeout job(DAG 末端节点:验收全绿 → 构建安装 → 安顿),届时本条升级为 job 模板。
   - **R13 环境前置(2026-10-04 补)**:无人值守期间机器不得睡眠——合盖需求用 Clamshell 类工具(Option+合盖继续运行;无 sudo/驱动,符合零弹框路线;低电量保护=卡死不冒进的硬件版,睡眠暂停不丢耐久状态,开盖即续)。无该工具时开盖离场,屏幕熄灭不影响进程。
