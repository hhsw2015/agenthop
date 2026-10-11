# humanlayer 对比评估(2026-10-05)

site: https://docs.humanlayer.com · repo: https://github.com/humanlayer/humanlayer(**自述已弃**:"the code here is pretty much all deprecated",指向 humanlayer.com 的重写版)
对照基线:docs/swarm/approval-delegation-brief.md(**S19**,审批代理简报,已冻结)+ CORE.md + cluster-liveness-design.md。

## 预判裁决(协调者让验证/推翻)

**部分推翻,部分印证——关键是时态。** 协调者预判「humanlayer 主打 = 人在环审批层(require_approval/contact_human)」:
- **历史上成立**:humanlayer 的成名作确实是人在环审批 SDK(`require_approval` 包住工具调用等人批、`human_as_tool` 把「问人」做成可调用工具)。**但该 SDK 仓库自述已全部弃用。**
- **当前已推翻**:现在的 humanlayer(docs.humanlayer.com / humanlayer.dev/code)是**编码 agent 编排产品**("The best way to get AI coding agents to solve hard problems in complex codebases"):task/session/workflow/phase/daemon/workspace,macOS app,跑 Claude Code/Codex,接 GitHub/Slack/Linear/Jira。它与 todos.dev/openrig 同域,审批退化为「工作流阶段检查点」。

所以与 S19 正面同域的是它的**旧 SDK(已死)**,不是现产品。下面两层都拆。

## 零、核心机制逐项拆解

**现产品(已验证,docs.humanlayer.com):**
- **Workflow phases** = research / design / PRD / TDD / structure outline / implementation,每阶段产一个可审**工件**(「审一页短文档比审一个大 PR 快」)。
- **Checkpoints(审批面)** = 「agent 必须不替用户做产品/设计选择」的点:design 讨论保持选项开放到用户明确答复;PRD 需整体方案批准;TDD 需系统+程序设计分别批准;implementation「检查通过后等人工复审」。原则:**「agent 可提议,用户拥有决定」**。
- **自动/批量** = 可「一次要几个阶段」或 auto-advance;例:「do all the phases, committing as you go, and I'll check it at the end」。**只改复审时机,不改控制工件。**
- **超时/升级**:文档**未描述**待批超时或升级行为。

**旧审批 SDK(已弃,本会话三条取证路径均失败——搜索后端挂、pypi/raw-github SSL 握手失败——故仅述可验证层,精确路由/拒绝反馈/超时参数不复述以免杜撰):**
- `require_approval`:装饰/包住一个工具调用,执行前把审批请求发给**人**(历史上经 Slack/email/web 等联系渠道)。
- `human_as_tool` / contact_human:把「联系人类」做成 LLM 可主动调用的工具(问问题/求输入),非仅被动拦截。
- 两者的共性(也是与 S19 的根本差异):**审批对象恒为人**;无「另一个 AI 代批」层。

## 一、独立趋同(印证我们的设计,不需要抄)

| humanlayer | 我们 | 判定 |
|---|---|---|
| 「agent 可提议,用户拥有决定」(checkpoint) | 三类裁决归 user;R3「可撤才自主」 | 同构(但我们把「可撤的」下放给协调者代批,见下) |
| 阶段产可审工件,审短文档早于审大 PR | 两层验收 + 设计稿 R4 冻结先于实现 | 同构 |
| auto-advance / 「do all, I'll check at the end」 | R3-b 问询带默认 + 代理权(睡觉助理代行) | 近构(我们是机制默认,它是人工一次性放行) |
| require_approval 把危险工具调用挡在人批后(旧) | 防呆底线:提权类选项永不代理,直升 user | 同构(都认「某些动作必须人批」) |
| 审批留痕/历史 | 代批决策进 control-log 可事后审 | 同构 |

结论:在「某些选择必须人拥有」「审工件早于审成品」上独立趋同;但审批的**路由哲学**根本不同(见五)。

## 二、可借(小件;列建议,裁定归协调者)

1. **`require_approval` 的「按工具调用」粒度**:它把审批绑在**具体工具调用**上(此函数必过人批)。S19 是按 PermissionRequest 弹窗(会话级)。可借:预授权规则(§机制2.cluster-medic runbook)用「工具名+参数模式」做键,比会话级更细。落点:预授权矩阵的键设计。
2. **`human_as_tool` 的「主动问人」**:把「升级一个问题给审批方」做成 agent 可**主动调用**的工具,不止被动弹窗。S19 只覆盖被动(弹窗→blocked)。可借:给成员一个主动 `ask_coordinator(question, options, default)` 工具,主动升级比等弹窗更早。落点:S19 机制1 加一个主动入口。
3. **拒绝带反馈回环**:审批被拒时把人的评语回给 agent 令其调整。S19 说「协调者回消息给成员」但没显式规定**拒绝必带可执行理由**。可借:代批/升级的回复强制带「为何+改法」字段。落点:S19 审批矩阵回执格式。
4. **按阶段工件审(而非按 diff 审)**:现产品把审批前移到 research/design 工件。可借给我们规划器:T3 的 plan 工件也应是独立审批点(已部分有,可强化)。落点:T3b 规划器审批点。

## 三、不借

- **「审批对象恒为人」(Slack/email 联系人类)**:humanlayer 两个时代都把人放在每个审批的环上。这正是 S19 要消灭的——user 没看到弹窗就卡很久。我们走**协调者代批**:可撤+域内+不花钱不改原则的,助理替你批,只有三门真到你。不借其「always contact human」。
- **已弃的旧 SDK 本体**:deprecated,仓库自述指向重写版。不接代码。
- **现产品的「用户拥有每个设计决定」密度**:research/design/PRD/TDD 每处都等人答。与「少占用老板(人只做三件事)」冲突。我们要的是机制门+代理权,把人从多数审批里摘出来。不借其审批密度。
- **闭源托管编排(macOS app/daemon/平台机)**:同 todos-dev 结论,控制面在产品侧。我们全本地可审计。不借。

## 四、humanlayer 有、而 S19 简报没想到的边角(协调者点名单列)

- **主动升级原语**(`human_as_tool`):S19 全程被动(弹窗触发)。成员主动「我拿不准,升级这个决定」的入口,简报没有。**建议补**:ask_coordinator 主动工具。
- **按工具调用的细粒度审批**:S19 粒度是弹窗;「此工具永远需批 / 此工具+此参数自动批」的细粒度预授权,简报只提了「高频模式沉淀为预授权规则」但没定键的粒度。**建议补**:预授权键=工具+参数模式。
- **拒绝反馈作为一等回路**:S19 有「代批回成员」但没强制「拒绝必带可执行理由」。**建议补**。
- **批量审批**(auto-advance / 「全做完我最后看」):S19 的 R3-b 是单项带默认;一次放行多项(整个 job 的所有审批预批)这个批量档,简报没有。**建议补**:批量预授权档(谨慎,须限可撤项)。
- **审批撤回**:协调者点名的「审批撤回」——humanlayer 现产品文档也**未见**显式撤回语义(已批后反悔);**双方共缺**。值得 S19 补一条:已代批但未执行的决定,user 醒来可在晨间追认单翻案(S19 已有追认,但「撤回在途审批」的时窗语义可显式化)。

## 五、给 user 的白话结论

协调者的预判对了一半:humanlayer **曾经**就是「人在环审批层」(require_approval/human_as_tool 是它的成名作),但那套 SDK **已经弃用**,公司转型做了一个**编码 agent 编排产品**(和 todos.dev 一个赛道)。所以今天的 humanlayer 不再是审批层,审批退成了「工作流每个阶段等你点一下」。

最该记住的一点:humanlayer **两个时代都把人放在每个审批的环上**(旧版发 Slack 问你,新版每个阶段等你点)。而我们 S19 的核心恰恰是**别这么干**——协调者(你的助理)把能代的审批代掉,只有真正需要你的(改原则/花钱/不可逆)才上你的桌,且带默认和期限,绝不静默卡死。**这个「助理代批」层是 humanlayer 从没有过的,是 S19 的真正新意**,外部对照反而印证了它的价值。

值得借的全是小件(列了建议,裁定归协调者):把「问人」做成成员可**主动**调用的工具、审批粒度细到「工具+参数」、拒绝必带可执行理由、批量预授权档。另有一处**双方共缺**值得 S19 顺手补上:已代批但未执行决定的**撤回时窗**(我们已有晨间追认,差一个显式撤回语义)。

(研究口径:只读文档不装不接,不改任何契约;可借仅建议。取证诚实声明:现产品面经 docs.humanlayer.com + GitHub 仓库自述**已验证**;旧审批 SDK 的精确路由/拒绝/超时参数本会话三路取证均失败(search 后端故障、pypi/raw.githubusercontent SSL 握手失败),故只述可验证的概念层,未复述无法再验证的细节以免杜撰——如需精确 SDK 语义,建议从 git 历史或可达镜像补证。基线:S19 简报 + CORE + cluster-liveness。)
