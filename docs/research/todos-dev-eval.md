# todos.dev 对比评估(2026-10-05)

site: https://todos.dev/docs — "a minimal product workspace for humans and agents, organized around tasks"
商业托管产品(定价分层 + platform machines),闭源;BYO-PC(机器跑 `tds start`)+ BYOK,只把工单元数据存其云控制面。
同域正面对标:一个把「Chief 拆目标→派给 agent→跟踪→汇报」做成产品的多 agent 团队工作台。user 观察它与我们团队协作相像——确如此,且像到措辞一致。

## 零、核心机制逐项拆解

- **Chief** = 一条跨所有 project 的常驻对话,「grooms work, decides what/who, hands todos out」,**不写代码只判断**;一个 team 一个 Chief,跑在某个 agent 上。「Progress is queried, not remembered」——读 build 对话/板/名册,重复读只回增量。自发起的工作 = 提案卡(accept 才跑);你让它跑 = 立即跑。「does not wake itself to ping you」,你下次说话时给 catch-up。
- **Todo** = 「一件工作 = 一个与 agent 的对话,不是队列里的票」。单一 phase:To Do / Queued / Planning / **Confirm**(待你确认计划)/ Building / **Review**(待你验收 diff)/ Done / Failed / Closed。只有 Confirm、Review 要人。
- **Agent** = team 成员(名/模型+思考档/角色/工具/默认技能/可读密钥/**自有 memory**)。角色每单起始重读;**不绑机器**;并行各跑各单;移除后 memory 留存不再用。
- **Machine** = 跑 run 的地方(`tds start` 自注册或平台机)。**「Machines claim runs; agents do not own them」**——机器拉活,满了排队。每机并发 1–10。存活 = 10 分钟窗口:超 10 分钟无响应 → 在途 run 判 failed;窗口内回来自行 resume。
- **三层持久**(「Nothing an agent needs depends on a conversation staying open」):Charter(你写,Chief 读不能改)/ Memory(agent 写,`save_memory`)/ Projects+todos(平台存,读时取)。对话「不是持久层,填满即压缩,Chief 的可整条重置」。
- **Project** = 一个 git 仓 + 一条 base branch;仓**永久不可换**,base branch 可换。**todo 绑一个 project,agent/machine 是 team 级自由流动**;run 在隔离 worktree,每 todo 一条 branch。
- **AI review** = 选**另一个** agent 只读复审(计划或 diff),贴进 todo 对话,干活 agent 自动据此返工,轮数不限;「review 不决定任何事,confirm/complete 仍是你点」。
- **Permissions** = role/grant/toggle 四处(agent 可做/机器允许/人的角色/API key 携带);七个重能力开关默认关,push/merge/shell/secrets 需 admin 或 Chief 授;shell 需 agent 授 **且** 机器开关。**文档明确:无 agent 间消息鉴别、无签名/加密信任模型。**

## 一、独立趋同(印证我们的设计,不需要抄)

| todos.dev | 我们 | 判定 |
|---|---|---|
| Chief 单一常驻、不写代码只判断、一 team 一个、跑在某 agent 上 | 协调者 Dot = 单一接口,只送三样上桌(该裁/该验/你问),不写代码只判断 | 同构 |
| "Progress is queried, not remembered";重复读只回增量 | F13 状态是证据 + projection 单写者读时派生(名册不变回一行) | 同构,连措辞一致 |
| "Nothing depends on a conversation staying open";三层持久扛压缩 | 铁律2 推进责任必须耐久持有,不在内存/消息/记忆 | 同构(他们的立身原则=我们的铁律) |
| Charter(你写不可改)/ Memory(agent 写)/ Projects+todos(平台) | 冻结契约+CORE(user,机器不改)/ roleProfile 笔记本(成员)/ control-log+board | 同构,逐层对应 |
| "Machines claim runs; agents do not own them";满则排队 | §2d 拉式领活(板+认领 CAS);认领非指派 | 同构(pull 是共同脊柱) |
| Agent 不绑机器;角色+memory 持久;移除后 memory 留存不用 | §3a 角色本体论 role≠session≠node;任期;裁撤零摩擦 | 同构 |
| Plan gate / Review gate;"Needs you" 列聚合待人项 | 两层验收(plan/diff)+ 三类 user 门;呈批件聚合 | 同构(他们两门 ⊂ 我们验收+三类) |
| 自发起=提案卡(accept 才跑);你让跑=立即 | R3 代理权:可撤者自主,三类挂 approval-wait,预授权票据 | 近构(我们多了「老板睡觉助理代行」一层) |
| 10 分钟无响应→在途判 failed;窗口内回来 resume | 铁律5 期限判死活;sweep 到期必处置;suspected≠dead | 同构(同量级窗口+超时即结算) |
| AI review:独立 agent 只读、贴对话、自动返工、轮数不限、异模型更易分歧 | 对抗审查:独立审查员只读、逐轮 REMAIN 收敛、按根因计数、heavy tier | 同构(他们更轻) |

结论:两套系统在无交流下收敛到同一批结构,甚至核心原则的英文措辞与我们的铁律重合,强化对冻结契约的信心(S15 一词一义:这是「独立趋同」不是「抄袭对象」)。

## 二、可借(全部小件,视图/文档层;列建议,裁定归协调者)

1. **"Needs you" 聚合列**:把所有待人项(待确认计划 / 待验收 diff / failed run / 研究问题的回复)收进一列。我们的 user 门物料散在 inbox/板/决策包。落点:viz「助理桌面」叠一个纯查询的「待你」聚合视图,零新状态。
2. **提案卡(accept-or-ignore,可忽略即过期)的呈现形态**:我们 R3-b「问询带默认、到期按默认」是更强的机制版,但提案卡的 UI 形态可借给「代理期自发起工作」的呈现。落点:晨间追认单的卡片形态。
3. **字段级 permanent/changeable 标注**:todos 每个字段明确标死(repo 永久 / base branch 可换)。落点:T3b 让 project 成 job 一等参数时,每字段标可变性(同 openrig "Last validated" 头的精神)。
4. **角色「每单起始重读」**:不只 spawn 时注入,每次认领重注角色,防长期漂移。落点:roleProfile 注入时机加一条。

## 三、不借

- **商业闭源托管平台(定价/platform machines/hosted repo/元数据存其云)**:控制面在云。我们刻意全本地(~/.agenthop)+ agenthop bus 跨机,append-only control-log + CAS + wait reducer 可审计可重放。不换。
- **「工单即对话」(todo = 一个 agent 对话,不是队列票)**:对话会丢、不可 reduce、不能 CAS。我们要的是 wait 实体 + control-log 结构化事实状态机,不是聊天流。不借。
- **「review 不决定任何事,人点两个门」**:他们最终全靠人点 confirm/complete。我们走机制门(0/0 对抗审查 + 变异验证 + 可失败门槛),机制裁定而非每次人点——否则「少占用老板」破功。保留机制门。
- **无成员级 liveness/idle/status**:todos 只有机器 online/free。我们 INV-1 三态 + idle 报到 + dispositions + 事故 episode 是 F16/F17/F18 的学费,刻意更强。不退。

## 四、顺带观察

- **Project 一等实体 = 强印证我们的头号未解耦**:todos 把「project 随 job 走」做成产品核心(todo 绑一个 project;agent/machine team 级流动;上下文走 todo 的 branch + project description,**不走 agent**)。这正是 CORE 标注的「✗ 最大未解耦:项目↔蜂群」。他们的拓扑(谁绑谁)是现成参考,T3b 规划器「plan 携带 project 上下文」方向由此得到外部印证——借的是拓扑思路,不是代码。
- **认领主体不同的两种 pull**:todos 是「机器拉活 + agent 浮动不绑机」;我们是「成员拉活」。todos 的形态对无状态执行体更干净,容量管理(已知缺口1:无适配活成员时 spawn)设计时值得参考。
- **消息鉴别是共同欠账**:todos 文档明确无 agent 间消息鉴别/签名——和我们已知缺口4同病,但他们连设计都没有。不是可借项,反而印证 bus-identity 方向是对的。
- **诚实反模式记录**:todos 写明「钉死的周期任务离线仍 fire→fail→烧一个 slot,每轮如此」。与我们铁律8(问询带默认)同族:钉死=没有默认路径。文档愿意写下自己的坑,值得学。

## 五、给 user 的白话结论

todos.dev 和我们像到「连核心原则的英文措辞都一样」:进度是查出来的不是记住的、没有东西依赖开着的对话、机器拉活 agent 不绑机器、独立 agent 复审。这是**独立趋同**——两边没交流却走到同一批结构,增强我们冻结契约的信心,不是谁抄谁。

最大的不同是**定位**:todos 是商业托管产品(控制面在云、工单做成对话、最终靠你点两个门);我们是全本地可审计的状态机(机制裁定、对抗审查、成员级三态存活、事故免疫),北极星是「少占用老板」到你只做三件事。它更像「给个人/小团队的好用产品」,我们更像「一家机器自营的公司」。

**值得借的全是小件**(都在视图/文档层):一个「待你」聚合列、提案卡的呈现、字段可变性标注、角色每单重读——这些我排了建议,裁定归协调者。真正的收获不是借,是**印证**:他们把「project 一等实体」做成了产品核心,正是我们自己标注的头号未解耦;这说明 T3b 规划器让 project 随 job 走的方向是对的。

(研究口径:只读文档不装不接,不改我们任何契约;趋同算印证不算抄袭对象;借小件不借架构;「不借」均附理由。基线:docs/swarm/CORE.md、cluster-liveness-design.md、team-collab-design.md §2d、S11–S18。)
