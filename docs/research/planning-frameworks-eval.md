# 规划/头脑风暴框架 深评:grill-me / Superpowers Brainstorming / OpenSpec Explore, 该借什么进蜂群规划层

owner f32a0507 · 2026-10-08 · 协调者派单(S14 研究)· 纯研究,未改码、未碰 swarm 包、未装/未跑任一工具
素材:grill-me + grill-with-docs = 本机已装技能文件逐字读(`~/.agents/skills/grill-{me,with-docs}/`,权威);Superpowers v4.2.0 = 本机已装插件文件 + GitHub README(`github.com/obra/superpowers`,MIT,Jesse Vincent/Prime Radiant);OpenSpec = GitHub README(`github.com/Fission-AI/OpenSpec`,MIT,未装未跑)
方法:三框架逐轴对照 T3 规划器 / 脑 / chat-room / decision-batch 四件现役,匹配 rovai-eval / dhh-16thread-eval 的借/不借/已领先分法。本会话 WebSearch 后端空返(同 DHH 眼评记录),故 grill/Superpowers 以已装文件为准、OpenSpec 以直取 README 为准。

## 结论先行

- **三者都不整体采用**(都是单用户 IDE 内的 pre-code 工作流,非总线协调的多 agent 蜂群);但三者都补我们规划层的同一真空:T3 是"规划器"不是"拷问器", 有产计划的,没有下计划前对抗式逼问假设的那一步。
- **头号可借 = grill-me 的对抗式决策树逐问**,做成 T3 之前的"grill 门":一次一问、沿设计树逐支解依赖、每问附推荐答、能查码就查码;在派 N 个 agent 之前把 user 决策一次性榨出来。理由:缺口最大 + 集成成本最低(纯方法,零基建、**零遥测**)+ grill-with-docs 的 ADR 准入门与 Rovai 裁定准入门独立收敛(已是既定借项)。
- **次借(概念级,不装工具)**:① OpenSpec 的变更夹 schema(proposal.md / specs/(需求+场景)/ design.md / tasks.md,一夹一改)做 T3 产物=handoff 的标准件;② Superpowers writing-plans 的"假设接手人零上下文、品味存疑"措辞 + YAGNI 硬裁,硬化 T3 交棒质量。
- **诚实分类**:grill 系是唯一零遥测(纯 prompt 技能);**Superpowers 与 OpenSpec 都带(最小化、可 opt-out)遥测**, Superpowers 的 brainstorming 视觉陪伴件回报版本号(`SUPERPOWERS_DISABLE_TELEMETRY`),OpenSpec 回报命令名+版本(CI 自动关、`DO_NOT_TRACK=1`)。house 零出境纪律 → 工具不装,只借概念。
- **已领先**:多 agent 派发+交棒(handoff 带 git 快照 + task-plan 载体)我们是跨机/总线版,Superpowers 的 dispatching-parallel-agents 是单机 IDE 版;对抗审查独立性(implementer→coordinator→reviewer)比三者任一的审查故事都强;event→decision 压缩(decision-batch)三者都没有。

---

## grill-me / grill-with-docs(对抗式逼问)

- **方法**(✓逐字读装机文件):grill-me(635B)= "relentlessly interview … walk down each branch of the design tree, resolving dependencies one-by-one … provide your recommended answer … one at a time",能查码就查码。grill-with-docs 更重:对着 CONTEXT.md 词表挑冲突术语、把模糊词收敛成规范名、用具体场景逼边界、拿码交叉核对矛盾,术语一解即就地写回 CONTEXT.md(只当词表,不含实现);ADR 稀疏发, 仅当三条全中:难回退 / 无上下文会觉奇怪 / 真做过取舍,否则不记。
- **产物/handoff**:grill-me 无耐久产物(只在对话里达成共识)→ 对多 agent 交棒弱;grill-with-docs 产 CONTEXT.md 词表 + 稀疏 ADR = 可交棒。
- **对抗烈度**:三者最高(逐支逼问 = DHH 式 grilling 的方法化)。**本地/许可**:纯技能、零遥测、全本地;△ 上游仓/作者/许可本会话 web 未能证实(DDD 血统:CONTEXT.md 词表 + bounded-context CONTEXT-MAP + ADR,不臆断作者)。
- **对位**:补 T3 的 pre-plan 对抗步;grill-with-docs 的词表纪律 ≡ 我们对 wire/状态词/"local vs peer"的术语洁癖,ADR 准入门 ≡ Rovai 裁定准入门(独立收敛 → 加固既定借项)。

## Superpowers Brainstorming(协作式设计管线)

- **方法**(✓装机 v4.2.0):先摸项目现状 → 一次一问(优先多选)→ 提 2-3 方案带取舍(先亮推荐)→ 分 200-300 字小节呈设计、逐节验证 → YAGNI 狠裁。
- **产物/handoff**:写 `docs/plans/YYYY-MM-DD-<topic>-design.md` 并 commit;接 writing-plans(把设计拆成 2-5 分钟 TDD 小步、带精确文件路径,明写"假设工程师对本库零上下文、品味存疑" = 专为交棒)→ dispatching-parallel-agents / subagent-driven-development(并行子 agent、轮间互审)。全链 = what→how→并发执行。
- **对抗烈度**:中(协作对话 + 强制 2-3 备选 + YAGNI + 分节验证,非逼问)。**本地/许可**:MIT(Jesse Vincent/obra + Prime Radiant);最小 opt-out 遥测(视觉陪伴件回报版本,不含项目/prompt/agent)。
- **对位/重叠**:与 T3 + handoff 高度重叠, 它是单机 IDE 版的"规划+交棒+并发执行";writing-plans 的"零上下文"措辞是三者里最好的 spec-as-handoff 单点,值得借进 T3 产物规范。dispatching-parallel-agents 是我们蜂群本业的独立收敛,不借,作验证。

## OpenSpec Explore(规格驱动)

- **方法**(✓GitHub README,未装未跑):`/opsx:explore` = "no-stakes thinking partner",读码、权衡选项、在动工前把计划成形(适合"还不确定要建什么")。`/opsx:propose`→开变更夹;`/opsx:apply`→实现;`/opsx:archive`→归档并回写 specs。"动一行码前先对齐要建什么",流体非瀑布、面向 brownfield。
- **产物/handoff**:最强结构件, 每个变更一夹:`proposal.md`(为何/改什么)+ `specs/`(需求+具体场景)+ `design.md`(技术路线)+ `tasks.md`(实现清单),纯 Markdown。Stores(beta)= 独立共享规划仓,跨仓/跨 agent 一个真相源(直指多 agent 交棒)。
- **对抗烈度**:低(explore 是"无风险陪伴",权衡选项但不逼问)。**本地/许可**:MIT;specs 是本地 Markdown(好),但工具带 opt-out 遥测(命令名+版本,CI 自动关)。
- **对位/重叠**:变更夹 schema 对位 T3 产物 + 裁定簿;Stores 对位 chat-room / 裁定簿(我们已有 owner 有序日志 + 耐久箱,不借 Stores 作基建,只借 schema)。

---

## 逐轴对照

| 轴 | grill-me/-docs | Superpowers Brainstorm | OpenSpec Explore |
|---|---|---|---|
| 方法内核 | 对抗逐问、解设计树 | 协作对话、分节验证 | 无风险探索、成形计划 |
| 结构产物 | 无(docs 版:词表+ADR) | design.md → 任务计划 | 变更夹 4 件(最强) |
| 对抗烈度 | **高** | 中 | 低 |
| spec-as-handoff | 弱(-docs 版中) | 强(零上下文措辞) | **最强**(可审变更夹) |
| 本地/零遥测 | **零遥测**、全本地 | MIT,最小 opt-out 遥测 | MIT,opt-out 遥测 |
| 许可 | △ 未证实 | ✓ MIT | ✓ MIT |
| 与现役重叠 | 补 T3 前空档 | **高**(=T3+handoff+并发) | 中(=T3 产物+裁定簿) |
| 集成成本 | **低**(纯方法) | 中(方法束) | 高(另 CLI+遥测) |

## 独立收敛(验证我方,非借)

- grill-with-docs ADR 三条准入门 ≡ Rovai 裁定准入门三条件(已定借), 两独立来源同一门槛,加固。
- Superpowers dispatching-parallel-agents / subagent-driven-development(并行子 agent + 轮间互审)≡ 我们蜂群本业 + 对抗审查链, 单机 IDE 版印证我们跨机/总线版方向。
- 三者皆"动码前先对齐"(explore / brainstorm / grill)≡ 我们"派单前把决策定下来", 撞 DHH"保护 user 判断带宽"(grill 是 pre-hoc 决策榨取,decision-batch 是 post-hoc 压缩,互补非重复)。

## 借 / 不借 / 已领先

**借(概念级,先自建不装工具)**:① ★ grill 门, T3 之前一次一问解设计树、每问带推荐、派 agent 前榨 user 决策(零遥测、成本最低、缺口最大);② grill-with-docs 词表纪律 + ADR 准入门(加固既定借项 + 术语洁癖);③ OpenSpec 变更夹 schema(proposal/specs/design/tasks)做 T3 产物=handoff 标准件,`specs/`(需求+场景)最可交棒;④ writing-plans "零上下文、品味存疑"措辞 + YAGNI 硬裁,硬化交棒质量。

**不借**:任一工具整体(单机 IDE slash-command UX,非总线蜂群)· Superpowers/OpenSpec 遥测(house 零出境)· OpenSpec Stores 作基建(chat-room/裁定簿已覆盖)· Superpowers 全 TDD 管线强绑(我们执行层另有约定)。

**已领先**:多 agent 派发+交棒(handoff 带 git 快照 + task-plan + T3,跨机/总线版)· 对抗审查独立性(三方链强于三者任一)· event→decision 压缩(decision-batch,三者皆无)。

## 建议(供协调者/user 裁)

1. **立一个小项:grill 门**, 在 T3 规划器之前插一个对抗式逼问阶段(一次一问、解设计树、每问带推荐、能查码就查码),输出"已解决的决策清单"喂给 T3。纯方法层,爆炸半径小,零遥测,直服 user 判断带宽。
2. **定 T3 产物标准件**:借 OpenSpec 变更夹 schema(proposal/specs(需求+场景)/design/tasks)+ writing-plans "零上下文"措辞,让 T3 产计划 = agent 可直接接棒的 spec。
3. **记一条信心**:grill-with-docs ADR 门 / Superpowers 并发子 agent 两处独立收敛,印证裁定准入门与蜂群派发-互审方向;三框架一致指向"动码前对齐",与 DHH 判断带宽论同根。
4. **工具一律不装**(两者遥测 + 单机 UX);只搬概念,自建在现役 brain/T3/chat-room 之上。

> 方法学声明:grill-me/grill-with-docs/Superpowers 以本机已装技能/插件文件逐字为据(权威);OpenSpec 仅据 GitHub README(未装未跑)。本会话 WebSearch 后端空返,故未做更广 web 交叉;grill 系上游仓/作者/许可未能证实(标 △),其行为契约不依赖此结论成立。未装、未跑、未接任一工具的云或遥测。
