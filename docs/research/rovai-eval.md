# Rovai AI 深评:与我们蜂群最近的同类,找可借 + 他们付过的学费

owner f32a0507 · 2026-10-06 · 协调者 fe0376cd 派单(S14,普通 tier,user 点名)· 纯静态研究,未装客户端/未注册/未接其云/未碰现役
素材:`github.com/murray17/rovai-ai`(`--filter=blob:none` 部分克隆 `/tmp/rovai-scan`,2018 份 docs)· Rust core + Electron 桌面 + 可选自托管 Server · **MIT(无商用/托管限制)**
方法:5 组并行只读覆盖六轴 + 群聊升格深挖,结论经主实现者复核对照我方系统。

## 结论先行

- **它是什么**:long-lived coding-agent **团队工作台**——给每个成员起名字/角色/职责/工作原则,各选已装的 coding agent + 模型 + 权限,在**共享群聊(Camp)**里同屏看工具执行/审批/文件差异,跨项目留协作记忆(Memory)+ 任务(Mission)。**它只编排不代理**(模型调用走成员自带 runtime 的凭证,同我们 CPA)。与我们对位极高,但它是**单机桌面产品**,我们是**多 agent 蜂群 + 总线**。
- **它比 MyAgents 干净得多**:**MIT**(可借代码,非仅概念)、**零遥测**(全仓无 sentry/posthog/GA/beacon)、**无云账号/无同步**、本地 SQLite 为真相。出境面只剩两处(IM 通道 opt-in + LAN 明文远程)。
- **头号可借(user 点破的真空档)**:**群聊室**——我们没有"多方同屏围一议题",它有。评估=**值得立项**,且是**小投影层**(协调者持有有序 append-log + 扇出到现有耐久箱 + 控制台 tail),不是新传输。见 §⑤。
- **其余四个高价值概念借**:① 裁定簿**准入门**(三条件,防台账膨胀);② **证据诚实分类学**(让对抗审查不可作弊);③ **"不得静默降级"清单** + 行为化轴拆能力探测(防准入处能力洗白);④ **指针活性一等状态**(published-attachment 的 recovery_required)补强 S18。
- **三处独立收敛(✓ 验证我方设计稳)**:F40 稳定身份 ≠ 轮换 run/thread id、S18 指针非复制、对抗审查=独立非辩论、台账 append-only supersede-forward——两边独立到达同样结论。
- **不借**:IM 通道(内容出境,同 IM-ingress 既有定性)、明文 LAN 远程(安全弱点)、SQLite-一切(架构选择,我们走文件/git)。

---

## ① docs 坑清单 & 治理模型 vs 我们 F-台账/裁定簿

Rovai 的 `docs/`(research / decisions / contracts 544 份 / 已退役 ADR)是 user 点名的"大量研究文档"。**三权分立**:research(`authority: research-routing`,只是证据/候选形状,**不是支持承诺也不是实现权威**)· decisions(只讲**为什么**,不是当前真相)· ADR(`authority: none`,已清退)。当前真相归 `architecture/`+`contracts/`+`CONTEXT.md`。

**他们付过、我们可能没踩的学费(最可转移五条)**:

1. **裁定准入门(三条件全中才记)**:①改动成本高(迁移/兼容/安全/数据/协议);②只读当前码/spec 的人无法理解"为什么";③确有被否的真实替代。可逆实现/步骤/UI 微调/复述当前事实**不记**。→ 我们重仪式审查 → 台账膨胀风险真实,这是解药。**建议借**。
2. **"为什么"与"当前权威"分离 + 同一改动同步更新**:台账讲 rationale,spec 拥有真相,导航文件(CURRENT.md)"不创建 spec、不推断完成度";每条语义裁定必须在**同一改动**里更新其 owning 权威文档,CI 检查被引 fragment 真实存在。防"台账悄悄变成过期真相源"。**建议借**。
3. **append-only + 机器强制不可变**:历史裁定 git-base 冻结,更正走追加式带标题勘误,**CI 断言历史正文与迁移基线逐字节相等**。→ 我们裁定簿正是 append-only,可补一条"测试没改历史"的 CI。**建议借**。
4. **证据诚实分类学(让对抗审查不可作弊)**:每个指标返回 `value/observed/eligible/coverage/source/quality/freshness`;"码里有测试 ≠ 测试跑了";"design-doc 过 / contract 过 / user 批 各自只证自己,不证能力增益";unknown 永不 zero-fill;clean-break 切换胜 backfill。判官规则:硬产出与语义 Gate 分离(判官不能把结构性失败的工具重判成功)、**两副本一致 ≠ 独立证明**、不许改 rubric/删失败样本/重跑到过。→ 直击我方对抗审查可信度。**强烈建议借**。
5. **能力探测必须行为化 + 轴拆,"一次成功 ≠ 普遍能力"** + 显式**"不得静默降级"清单**(不自动换模型、不降级到全权限兜底、不伪造 resume、不未验恢复就发布、不跨版本复用快照)。→ 我们准入 member/runtime/tool 时防"能力洗白"。**建议借**(与 heavy-tier 绑定相通)。

**具体坑样本(可直接抄进我们的坑清单)**:idempotency key 含 parser 版本 → 重放双计费;reasoning token 叠加 Output → 双算;`max(…,0)` 伪造 0;"0 occurrences" 对不支持的 runtime = 假零;P95-of-P95;订阅制**根本没有"这个 run 的真实成本"事实**;retry 复用 Delivery 抹掉旧失败;memory 读取次数 ≠ 有效性;ACP `initialize` 成功 ≠ 已认证(凭证在 host 进程);opaque `toolCallId` 审批无名无入参 = 硬集成阻断;runtime 可能偷偷叠自己的 persona/AGENTS.md/subagents = **两套冲突权威 + 隐藏第二编排层**。

---

## ② 长命成员身份/记忆持久化 vs 我们出生证 + 角色-session 解耦

**成员 = 应用全局 `AgentProfile`(非 Thread 内对象),存权威 SQLite**。三层叠身份:
- **Agent UUID** — 不可变、不对外、纯持久化 id(= 我们的**出生证**)。
- **Agent ID** — `agent_<正整数>`,稳定的模型/工具**路由**地址,单调分配、**移除后永不复用**,用户不见不改。
- **Member Name** — 唯一的用户可见显示名。
身份=六字段(name / Team Role / 职责 / 性格标签 0–6 / 工作原则 / 成长主题),**身份不授任何权限**(每处都重申:不给 runtime/membership/lead/approval)。

**跨重启存活的关键机制**(与我方高度收敛):runtime(Native Session)是**可替换的外部句柄**,真相在 SQLite;每次会话启动经 **Member Identity Bootstrap Projection** 把最新六字段**瞬态重投**(既不存快照也不冻进 AgentRun),固定顺序 Session Charter → Member Identity → Memory Entrypoint,新会话与 Resume 都投。→ 这正是我们"**角色-session 解耦 + 出生证**"。**对照收获(可借精炼)**:三层 id 的明确分工 + "身份不授权" + "重投而非冻结";创建走 idempotent `creationKey` + **不可变成功回执**,且创建**不**配置 runtime/模型/权限/membership(各自独立变更边界)。

---

## ③ 执行卡 vs 我们 S19 呈批 + 控制台

**三位置执行台**(Run Pulse 轻量常驻 chip / 按需 Execution Drawer / Composer 上方 Approval Dock),与公屏共用一套投影。每操作**单条生命周期记录** `(agentRunId, executionEpoch, operation)`,带 `id/sequence/operationId/revision/changeSequence`;输入/结果分两块(各 64MiB blob),**普通工具结果文本封顶 7680 字节**(`outputTruncated`,无"读全文"恢复);thinking 内容落盘前丢弃;文件差异(`runtimeDiff`/Files Changed)**一等公民、不占文本预算**,懒加载。

**审批**:需审批的工具调用进 `waiting`/"等待审批"相,**永不计为完成**;审批入口/决定走**私有业务投影("私有审批隔离")**,独立于证据详情读;`--to-principal`/`mentionUser` 明确"**不代表审批**"(注意力与审批是两条独立通道)。→ ≡ 我们 S19 呈批(审批是独立耐久件,非对话消息)+ R13 诚实回执。**对照收获**:"waiting 永不计完成" + "注意力 ≠ 审批"值得写进我们呈批契约措辞;文件差异不占文本预算是好工程。

---

## ④ 协作记忆 schema + 审核流 vs 我们裁定编号制

**Memory Library** = 应用全局、用户治理、归一化 SQLite(Memory + 不可变 Revision + 隔离的 Hearth Review Item + Supersession)。条目字段:**Scope**(hearth 全员 / companion 用户↔单成员 / relationship 一对)· **Kind**(preference/agreement/lesson)· body(1–2048 字节,secret 预过滤)· 1–3 retrieval keys · **Origin**(user/agent/accepted_hearth_review)· Lifecycle(active/retired/forgotten)· Direction(relationship 用)。

**审核流(与我们关键差异)**:agent 只能即时写**自己的 Companion + directed Relationship**;**agent 写 Hearth(共享)→ 变成隔离的 pending Hearth Review Item,须用户 accept/reject**;lifecycle/supersede/forget 仅用户。每 AgentRun 封顶 4 次成功变更。SHA-256 canonical digest 去重。→ **他们共享记忆由"人"把关;我们裁定由"对抗 agent 审查 + 编号"把关**。两种哲学:他们人审轻、我们 agent 审重。**可借**:Scope/Kind/Origin/Direction 这组字段 + "agent 写共享=提案进队列不是直接落"的隔离审核模型,比我们"裁定直接编号落"多一道**提案缓冲**(防投毒);但人审瓶颈是他们的代价,我们对抗 agent 审更快。**选择性借 schema,不借人审瓶颈。**

**审查流 review-duo/grill-duo**(= 我们三方对抗审查的近亲):发起者 + 恰好一个固定伙伴(2 agent),走总线,trusted-agent-id + 直接回复校验;"对抗"=**独立**(独立 reviewer/独立轴)非辩论。review-duo 分 Standards(伙伴)vs Spec(发起者)两轴,**只读默认**(不授权改/提交),冻结快照 `git:<merge-base>...<head>` / `patch:sha256:...`,四消息,最终一份报告(Standards 先 Spec 后、**无合并分**)。grill-duo 走 Q1–Q4 编号轮、**人确认门**后才实现。→ 我们是 implementer→coordinator→reviewer 三方链;他们是 pairwise。**独立收敛**(见下)。

---

## ⑤ 群聊室(升格:可借性深挖 + 立项评估)★ 头号可借

**背景(user 点破)**:我们现状 = user 只单聊协调者、成员间点对点信件,**没有"多方同屏围一个议题"**。晚交代早验收里 user 想同屏看多个成员就一个议题往来。Rovai 实现了,我们没有。

**它的数据模型**(Camp = 多成员群聊室,公开名 Thread;Single Chat = 私密 1:1):
- **房间实体** `Camp`:`rvcamp_<26 Crockford base32>`(UUIDv7),**是定位符不是授权令牌**,无别名无映射表 → 跨重启稳定。
- **回合归属**:每条 `CampMessage` 带 `authorType`(user/agent/system)+ 冻结 `sourceAgentRunId`,作者=**canonical Agent ID**(落盘时绑定,**不从正文解析**)。
- **@寻址(房间内)**:三源并集去重冻结——`to`/`--to` canonical id、内联 `@agent_N`、精确 `@显示名`(先解析成 canonical);人=保留 `@Principal`;`--public-only` 入日志但**零** agent 投递。
- **并答排序**:**单一 Core 拥有的 per-Camp 单调 `sequence`**;每次 `send` = **一个原子事务**写 1 CampMessage + 每收件人 1 Delivery + 1 CampTurn,并发由 DB 事务串行化分配 sequence。线程=`reply_to_camp_message_id` 边(不是嵌套房间)。
- **可见性**:Camp 是**开放读面**(人人见每条公开消息);每成员另有私有执行 Conversation(`camp_member`),但公开产出落在同一条共享日志。
- **人在场 vs 不在场:数据模型不分叉**——同一条 append-only 日志;差别只在**注意力**(away → `--to-user` → 不可变 `user_mention` 通知 + Inbox)和**活性**(在场看 live 投影,离场事后 `camp-history` + Inbox 读)。`campfire` 技能显式异步("dispatch 后结束 Run,回复到了再 resume,不轮询")= 正是人不在场的过夜轮次执行。

**私聊 vs 群聊切换**:两面同属一个 Camp;Single Chat = 本地用户 ↔ 一个在场成员的私密旁路,**唯一隐私承诺**=单聊正文/Source Ref/最终答不进公屏。**无内置桥**:single-chat 冻结策略 `single_chat_v1` 的 `rovai send` 返回 `operation_denied` → 私聊**无法**升进群聊,私密记录**不会**被提升。两面是用户开面板二选一,不是可转换状态。

**agent 互引产出 = 指针,匹配我们 S18**:附件走 `LocalAttachmentSourceRef{source_path,...}`,Core **不复制/移动/链接/staging/冻结**,重发同文件**复用身份**,每次读解析当前内容 = **就是 S18**。消息互引靠 id(`sourceAgentRunId`/`reply_to_camp_message_id`/`member_mention{agentId}`),不内联引述正文。**更强处**:`camp-published-attachment-view` 把**指针活性做成一等状态**(失效 → `recovery_required`,从新 Context 过滤**但不禁用房间、不改历史**)——这点**比我们耐久箱强,建议借进 S18**。S26 的对位 = campfire 成员回复契约(一次完整结果回请求者,固定 Judgment/Reasons/Risk/Would-change/Confidence,"返回一次、略去背景与他人观点");它多一个我们没有的 `--public-only` 广播变体。

**执行卡内嵌对话流**:不是 chat 消息,是三位置台——Run Pulse(Header chip)/ Execution Drawer(按需、键联到该 Run 的公开消息)/ **Approval Dock(Composer 正上方、非模态、流内作答)**;主列共享"时间线 + 执行台 + Approval/Recovery Dock + Composer";**Files Changed 锚在其源 Run 最后一条公开消息之后**;Stop = Composer 里替代 Send 的单一危险动作。→ 审批在流内但**不是一条消息**,是 Composer 上方的 dock。

**最小借法 + 差距**(房间 over 我们单播总线 + per-recipient 耐久箱):

| 件 | 我们有? | 缺口 | Rovai 可复用形状(概念非代码) |
|---|---|---|---|
| 房间实体 | 无 | room id(≠成员 stableId),定位符非令牌 | ✅ `camp-identity`(UUIDv7 定位符,严格边界) |
| per-room 有序 append-log | 无(箱是 per-recipient、跨发送者无序) | 单调 per-room `sequence` + `since(seq)` 增量 | ✅ `camp-history`/`camp-conversation-find`(`sequence ASC,id ASC`) |
| 房间花名册 | 无 | 成员集/进出/generation/lead/在场 | ✅ `camp-membership`(CampMember、membershipGeneration、Default Lead) |
| 扇出投递 | 半(循环 N 次单播) | 1 帖 → append-log + N 箱 原子 | ✅ `camp-message-send` §7(1+N+1 一事务) |
| **跨发送者定序** | **无**(点对点无中央 sequencer) | 单写房主分配权威 sequence + reply 边 | ✅(概念)Core 原子 sequence;映射到我们**协调者** / agenthop"房间归第一个 host" |
| 读游标 | 半(箱 claim/ack 是投递游标非共享日志读位) | 每成员对共享日志的 watermark | ✅ `single-chat` `lastAcceptedPublicBoundarySequence` |
| 房内 @寻址 | 半(有 stableId 无 @文法) | `@member`+`@human`→stableId | ✅ `member_mention{agentId}` / `@Principal` |
| 人不在场注意力 | **有**(耐久箱 + S26) | 标"需人" | ✅ `--to-user` → `user_mention` |
| 互引 | **有**(S18) | — 直接匹配 | `camp-attachment` live Source Ref ≡ S18 |
| 前端同屏渲染 | 无 | 时间线 + 归属气泡 + 执行台 + approval dock | ✅ `conversation-workspace`/三位置台/"回到最新" |

**立项裁定:建议 YES,一个聚焦小项目(读多投影层,非新传输)。** 晚交代早验收 = Rovai `campfire` 异步模式叠在有序共享日志 + Inbox 升级上,我们异步底座(单播 + 耐久重投箱 + S18 指针 + S26 报告)已在,**只加一个读多投影层,爆炸半径小**。
- **最大风险 = 跨发送者 sequencer / 单写定序**:我们总线无房主,N 成员并发写 N 个 per-recipient 箱 = **N 种排序、无共享真相**;必须先定一个进程分配权威 per-room `sequence`(Rovai Core / 我们协调者 / agenthop"房间归第一个 host")。先解决它,其余都是投影。
- **最小首切**:**协调者持有的 append-only 有序日志**(当作权威 S18 产物)。成员照常单播 DM 给协调者;协调者把每条 append 成日志条目、盖 `{seq, fromStableId, fromLabel, text}`(复用现有 `{from,fromLabel,text,via}`)、扇一份到每成员现有耐久箱;控制台 tail 该日志。**只含**:归属有序消息 + `@member`/`@human` + 同屏渲染 + 每观者读游标。**先缓**:公平/回合栅栏、房内审批、附件做房间对象、reply 树、Single-Chat 隔离。复用单播(扇出循环)+ 耐久箱(重投)+ S18(日志即产物)+ S26(报告变日志条目),**基本只新增一个实体:有序房间日志**。

---

## ⑥ 出境面(逐条)vs 不出境纪律

| 内容 | 去向 | 判定 | opt-in |
|---|---|---|---|
| Agent 执行/工作区/对话/团队状态 | 本机 SQLite | ✅ 本地,干净 | - |
| 模型 prompt/completion + 工具调用 | 成员自带 runtime 用**自己凭证**调,Rovai **不代理** | 任何 agent 不可避免(同我们 CPA) | 内在 |
| 远程 MCP server | 用户配的 url+headers(日志里 masked) | ⚠ 内容+元数据到用户选的端点 | **opt-in** |
| 远程浏览器接入(host remote) | **入向** LAN axum(8766/8767),token 门 + 2 分钟一次性 QR ticket | LAN 本地,无厂商出境,**但明文 HTTP** | opt-in |
| DingTalk / Feishu 通道 | 钉钉/飞书 OpenAPI | ❌ **内容出境**到第三方 SaaS + OAuth 身份 | opt-in(**仅桌面**) |
| 自更新 | 仅 GitHub(版本 tag + 二进制 + SHA256SUMS) | 元数据+二进制,**无用户内容** | 用户触发 |
| 云同步/云账号 | **无**(实例间不迁移不同步) | ✅ 本地 | - |
| 遥测/分析/崩溃上报 | **无**(全仓 grep 零命中) | ✅ 干净 | - |

**判定**:Rovai 本体出境极窄(仅 GitHub 自更新)。真正内容出境只有 **IM 通道**(opt-in、内容到第三方 SaaS——与我们 IM-ingress 借项的既定定性一致:提供商中转、user 主动选择)。**明文 LAN 远程**是安全弱点(**不借那条**;我们若做远程必须 TLS)。无 AGPL、无闭源云、无账号、无遥测——**出境面完胜 MyAgents**。

---

## ✓ 独立收敛(验证我方既有设计,非新借)

- **F40 稳定寻址**:Rovai 显式"Native identity separation"——`native_session_id`/`native_thread_id`/`native_turn_id`/ACP/Codex thread id **全部轮换、都不是会话地址**;地址=canonical Agent ID;`rvcamp_` 作为 runtime resume 目标无效,反之亦然。≡ 我们 **F40**(稳定身份 ≠ 轮换 run/thread id,寻址只认稳定身份)。**两系统独立到达同一结论。**
- **S18 指针**:`camp-attachment` live Source Ref(不复制/移动/冻结、复用身份、每次读当前内容)≡ 我们 S18"消息是指针、文件是权威"。独立收敛。
- **对抗审查=独立非辩论**:review-duo(独立 reviewer、独立轴、Standards vs Spec、只读、无合并分、不自批)≡ 我们 implementer→coordinator→reviewer 的独立性。收敛于"独立 + 分轴 + 无自批"。
- **台账 append-only、supersede-forward**:版本内冻结正文、追加式勘误、CI 断言历史逐字节不变 ≡ 我们裁定簿 append-only 编号。收敛。
- **终态诚实**:"send 只证提交、不证收件方开工/完成";"需审批的工具调用是 waiting、永不计完成";usage"unknown≠zero" ≡ 我们 §0b 终态诚实 + R13 诚实回执。收敛。

---

## 借 / 不借(汇总)+ 最小借法

**借(概念/schema 级;MIT 允许代码级,但先概念自建)**:
1. **★ 群聊室**(§⑤)——立项,协调者持有有序 append-log + 扇出现有箱 + 控制台 tail;先解决跨发送者定序,其余投影。**头号,直解 user 真空档。**
2. **裁定准入门**(三条件)——防台账膨胀。
3. **证据诚实分类学**(`value/observed/eligible/coverage/source/quality/freshness` + "码里有≠跑了" + "两副本一致≠独立证明" + 不许改 rubric/删样本/重跑到过)——让对抗审查不可作弊。**强烈建议。**
4. **"不得静默降级"清单 + 行为化轴拆能力探测**——member/runtime/tool 准入防能力洗白(接 heavy-tier)。
5. **指针活性一等状态**(recovery_required,失效即过滤但不禁用房间不改历史)——补强 S18。
6. **记忆 Scope/Kind/Origin/Direction schema + "agent 写共享=提案进隔离队列"**——多一道投毒缓冲(选择性借 schema,**不借人审瓶颈**)。
7. **执行卡措辞**:"waiting 永不计完成"、"注意力≠审批"、文件差异不占文本预算——精炼我们 S19 呈批。

**不借**:IM 通道(内容出境)· 明文 LAN 远程(安全弱点)· SQLite-一切(架构分歧,我们走文件/git)· Hearth 人审瓶颈(我们对抗 agent 审更快)· 整件产品(单机桌面形态 ≠ 蜂群)。

---

## 建议(供协调者/user 裁)

1. **不采用 Rovai 整体**(单机桌面产品,非蜂群);但它是**最干净、最可借**的同类(MIT + 零遥测 + 本地优先)。
2. **立一个项目:群聊室**(§⑤ 最小首切)——user 点名的真空档,小投影层,爆炸半径小;先定"谁当房主做跨发送者 sequencer"(建议协调者 / 复用 agenthop 房主模型)。价值最高。
3. **立两条审查硬化借项**:裁定准入门(三条件)+ 证据诚实分类学——直接强化我们核心(台账防膨胀 + 对抗审查防作弊)。
4. **记一条信心**:四处独立收敛(F40 / S18 / 对抗审查独立性 / 台账 append-only)证明我方核心设计与一个成熟同类殊途同归——继续走开源自建、本地优先路线。

> 方法学声明:静态代码/docs/契约审 + 5 组并行只读摘录,主实现者复核对照我方系统;未装客户端、未注册账号、未接其云、未碰现役数据、未做二进制级出境审计(已就 docs + 源码 + 依赖清单的网络面逐条列出并标注)。素材=部分克隆(blobless),个别超大文件(CONTEXT.md 235KB、ADR-MIGRATION-MANIFEST.json 2.9MB)按需 grep 未全量读,已标注。
