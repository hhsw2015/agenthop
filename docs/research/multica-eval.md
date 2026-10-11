# Multica 深研(第十一面镜)

owner=f32a0507;user 亲令「agent 协作项目,吸收精华」;协调者 fe0376cd 派单。纯研究,不改码。
实证口径:gh API 拉 `multica-ai/multica@main` 源码+仓内文档(README/VISION/AGENTS/CLI_AND_DAEMON/docs/engineering + server/internal、server/pkg 逐包);标 △ 处为「仅凭 multica.ai 站点文档,未独立拉源验证」。

元信息(gh 实证):Go 后端 + TS 单仓(Next.js/Electron/Expo),PostgreSQL 17,52k★,源可得(NOASSERTION/source-available,非 OSI),活跃(2026-10 仍推)。一句话:**「让人和 AI agent 像一个团队」：把 agent 当队友派到看板上(领 issue、报进度、提卡点、交还审查),自托管、驱动你已装的 26 款 agent CLI、不锁定。**

---

## ① 它是什么 / 架构

**拓扑=中心化 hub(与我方相反)。** 一个 Go 后端(Chi+WebSocket)+ PostgreSQL 做「系统记录 system of record」,前端(web/desktop/mobile)走 HTTPS+WS,**agent 跑在你自己机器上的 daemon**(经 WS 回连后端),daemon 再 spawn 本地 agent CLI。代码永不离开你的 runtime,但**协调/状态/身份的真相集中在后端+DB**。

三面(server/internal + server/pkg 实证):
- **消息面**:WebSocket(`gorilla/websocket`)+ `internal/events`、`internal/realtime`、`internal/daemonws`、`internal/dispatch` + `pkg/eventcontract`/`pkg/protocol`。中心 broker 广播,WS 事件 patch/invalidate 前端 Query 缓存(不塞 server payload 进本地 store,见 AGENTS.md State Rules)。channels(Slack/Feishu/钉钉/企微/TG)是外部入口。
- **状态面**:PostgreSQL 单一真相(`pgcrypto`+`pg_trgm`),sqlc 生成查询;issue/task/activity/comment/wakeup 全在表里,迁移体系庞大(`cmd/migrate` 几十个带测试的迁移)。看板=issue 列表投影;执行日志=task 的 tool-call 回放。
- **身份面**:`internal/auth` + `internal/middleware` + `pkg/dbid` + **`internal/attribution`(问责人瀑布,见 ③)**;角色 owner/admin/member + 每成员可运行哪些 agent 的 access scope;daemon 自带 identity;autopilot 以「规则属主」为授权主体。

核心抽象:**issue=工作单元**(含 intent/plan/diff/preview/test/未决问题全连在一条 issue 上,跨 agent/人 handoff 不丢上下文);**agent=一等队友**(有名字/provider/runtime,出现在 assignee picker 与评论里);**squad=人+agent 一队,leader 路由工作**;**skill=把解过的问题变 playbook 复用**;**autopilot=cron 上的 standup/审计/报表**;**wakeup=issue 上挂事件/条件/定时订阅**(见 ② FC 面)。

---

## ② 与我方逐面对表

| 面 | Multica | 我方(agenthop/swarm) | 判 |
|---|---|---|---|
| **拓扑** | 中心化:后端+PostgreSQL=系统记录,agent 在分布式 daemon 回连 | 去中心 peer:无公网入口两机经中继(只转字节),无 server/无 DB,真相=各家目录 `.agenthop/` 文件+协调者有序 append-log | **有意分歧**(我北极星=serverless peer;他=产品化中心 hub) |
| **协调者/路由** | squad leader 路由 + 后端 `scheduler`/`dispatch` 服务集中派单 | 协调者=一个 peer agent,持有序日志+扇出到各耐久箱;dispatcher sweep 本地推进 | **同构(角色),异构(基底)**:他 server+DB 派单,我 peer+文件;他有我无=路由是已上线产品特性 |
| **耐久箱/投递** | issue+activity 时间线落 PostgreSQL;outbox+**终局投递回执**(`delegatedrecoverybackfill`:回执写进 task 终局事务,sweeper 每 tick outbox 扫描复证已结);Inbox=「需你拍板时才 ping,非每步」 | S11 耐久箱(fs 原子写+claim/ack+FC-2 凭据);outbox.flush/undelivered;S19 协调者 notify | **同构**(耐久投递+恢复+回执),**他明显更省**:DB 事务给真原子性回执,我 fs 版为 exactly-once 绕了十轮 durable-first(见 ③ 诚实面) |
| **审查席/门** | Review gates:工作落 review 不落 main,人审**工作本体**(plan/doc/diff/preview/test)非「状态戏」 | 审查席=3 路对抗式 agent 审 + 裁定簿;合并门归协调者+user | **异构同向**:他=人在 UI 审(产品面更全);**我有他无=对抗式 agent-vs-agent 审 + 裁定账本**(代码审更狠) |
| **herdr 工作台/runtime** | 「你自己的 runtime」daemon,代码不出机;26 款 CLI;desktop 自动注册本机;cloudruntime 可选;`seatcapacity` | herdr 工作台 + vm-ctl(后端无关机器原语)+ placement(K8s reconcile 装箱) | **同构**:他 runtime onboarding 更顺(26 CLI/自动注册);**我有他无=placement 成本感知装箱+snapshot/restore+继任** |
| **S31 双通道/steer** | 「Steer 运行中 agent」回复落**当前 run**(Claude Code/Codex/Grok 已上线)+ Inbox 耐久提醒 + 多 channel | S31 双通道(总线加速、耐久箱为准)+ TG 入口 + chat-room | **同构**:他 channel 更多且 steer 已接线;我双通道语义同 |
| **FC 判例族/可靠性** | `taskfailure.classify`(可重试 vs 不可重试,数字边界护栏防误判,5xx/401/402/429 分桶,仅 `provider_network` 进重试白名单);`resume.UnresumableHistory`(**provider 无关**毒会话检测,宁可不匹配=安全向);wakeup(**无睡眠进程**、revision fencing 409、锁序「持 issue 锁时绝不等 source 锁」、scheduler ~30s、漏周期 coalesce);issue-ID 账本(MUL-xxxx) | FC-2(毒件/可重试分类、push THROW vs return-false)、outbox/undelivered、fencing token、sweep/renew、ScheduleWakeup/cron/force-pipeline、裁定簿 | **深度同构(独立收敛)**:他失败分类学更细(context-exhausted/environment-prepare 等桶)+ 有「会话指针可恢复性」概念(我方无,因我不托管 agent 会话 transcript);**我有他无=裁定簿+对抗式复核** |

一句话:**结构层面我方与 Multica 在「可靠投递/幂等/fencing/可重试分类/无睡眠进程/handoff 不丢上下文」上大面积独立收敛**;最大分歧是拓扑(他中心 hub+DB,我 serverless peer+文件),这直接决定了他 exactly-once 近乎免费、我方要靠 FC 判例族硬挣。

---

## ③ 安全与证据诚实面

**反洗白(`internal/attribution`,实证强项)。** MUL-4302「问责人解析契约」:每个入队 run 必须可溯到**恰好一个问责人**,且**可解释**：不只记「谁」,还记「在瀑布哪一级解析出」(直接成员动作 / 跨 agent hop 的委派副本 / 评论源链 / autopilot 规则属主 / 降级属主兜底)。三条硬不变量:
1. 问责人是「代表 on behalf of」,**非追责**;SOURCE 标签**仅溯源,无任何权限判定读它**。
2. **originator 才是授权值**;`canInvokeAgent` 认它;改 `TriggerOwner` 是**授权变更**非打标,但它只授予「那个人自己的权利」,门不变、只换交给门的主体。
3. 命名 originator **不发任何第三方凭据**:Composio 连接按 **agent 属主**的 allow-list 构建,无视 originator。

→ 这正是我方 **R16(cap 不进中继/转述不带=验不过)+ C8(席位身份 HMAC cap)+ permission-laundering 红线**的同族,且**独立收敛于同一原则:溯源(标签)与授权(主体自有权利)分离,委派不得提权**。他**更进**在「可解释问责瀑布 5 级」;我**更进**在「密码学 cap 不可转述伪造」。

**投递成功怎么算(诚实面)。** Multica 以**终局投递回执**计:回执写进 task 的终局 DB 事务(真原子),sweeper outbox 扫描每 tick 复证「已结」,backfill 一次性收编旧行。**这恰是我方十轮 digest-wiring 用 fs durable-first 凭据硬挣的同一保证**：DB 事务让 exactly-once 近乎免费,fs-only 则要面对两将军问题(我方接受的「占凭据与写消息间崩溃窗⇒当日漏投」残留,在 DB 事务下根本不存在)。**诚实结论:我方 serverless/fs 选择为 exactly-once 付了真实复杂度税;这不否定设计(独立收敛证明方向对),但是明账。**

**泄密防护(`pkg/redact`)。** agent 输出落库/WS 广播**前**按正则屏蔽密钥(AWS AKIA/secret、PEM 私钥、GitHub ghp/github_pat、OpenAI/Anthropic sk-、Slack token…),首个命中优先。→ 对应我方 `sanitizeForTransport`(FC-2 只剥控制字符)+ seal(E2E 加密):**他防「输出里的密钥泄漏」、我防「注入+端到端加密」,互补**。

**自托管遥测**:每日一条匿名部署级快照(版本+分桶计数,无名/无内容/无 ID),`DO_NOT_TRACK=1` 关。→ 比 Superpowers/OpenSpec 的 opt-out 遥测克制,但**仍非零遥测**(我方既有裁断:带遥测工具一律不装)。

---

## ④ 吸收清单

**头号借:问责人瀑布(可解释 attribution)→ 并入 C8/R16。** 理由:我方 cap 已防「转述伪造」,但缺「**每单可溯到恰好一个问责人 + 解析级别**」的可解释链;Multica 的 5 级瀑布(直接/委派跨 hop/评论源/autopilot 属主/降级兜底)是现成成熟模型,且与我方「溯源≠授权、委派不提权」同原则。落点:dispatch/task 记录加 `accountableHuman + resolutionLevel` 纯分类层(复用 mint.ts/bus-identity,不另造),SOURCE 只溯源、授权仍走 cap。**规模:中(一个纯 role-classification 模块 + 账本字段,量级同 mint.ts);立项候选=`attribution-chain`。**

**次借:**
1. **失败分类学 + provider 无关毒会话检测(`taskfailure`)→ 哨兵/FC 族。** 借「数字边界护栏防误判桶」+「宁可不匹配=安全向」+ context-exhausted/environment-prepare 等桶,升级我方哨兵 blocked 识别 + 给 herdr 读屏加一个 provider 无关的「毒/不可恢复」检测器(不 key provider 名/状态码)。规模:小-中,接 sentinel-denoise。
2. **密钥屏蔽正则集(`pkg/redact`)→ 我方输出/stdout 路径。** `sanitizeForTransport` 现仅剥控制字符;补一层「落盘/转发前密钥正则屏蔽」(AWS/GitHub/OpenAI/Anthropic/Slack/PEM)。规模:小,纯函数 + 一处接线。
3. **wakeup `checkin --note`「CI 还在跑」→ 我方 working 收条。** 我方已有收条,借其「在 pending 唤醒上附一句无害状态注解」语义(与 F44-⑩ content-filter HINT 同向)。规模:微。

**明确不借:**
1. **中心服务器 + PostgreSQL 系统记录**:理由=直接违背北极星(无公网入口两机、中继只转字节、无 server/DB)。采它=换个产品。落点:N/A(有意架构分歧)。**但记明账:DB 事务让 exactly-once 近免费,是我方 fs 路线的复杂度税来源。**
2. **web/desktop/mobile 产品 UI(Next.js/Electron/Expo)**:越界(我方是 CLI/总线,swarm-viz 是只读控制台,非产品前端)。
3. **Composio/第三方应用叠加**:越界(我方不代持第三方凭据)。
4. **自托管遥测**:再克制也非零遥测,循既有裁断不装。

---

验证:gh API 全程实证拉取(repo meta/tree/README/VISION/AGENTS/CLI_AND_DAEMON/issue-wakeups + taskfailure/attribution/redact/delegatedrecovery 源码头);multica.ai 站点文档(security-model/how-it-works)未独立拉,涉处标 △。纯研究无改码。已交付协调者 fe0376cd,未提交(同其他研究 eval)。
