# agent-beacon 评估:经验复利 / 弱形式 RSI 底座

owner f32a0507 · 2026-10-06 · 协调者 fe0376cd 派单(S14,普通 tier)· 纯研究,未安装/未登录/未碰现役 session 数据
素材:`github.com/Asymptote-Labs/agent-beacon`(浅克隆 `/tmp/beacon-scan`,静态审为主;其产物多为预编译 Go/包,未做二进制级出境审计)

## 结论先行(TL;DR)

- **它是什么**:跨 harness 的**记忆层**(memory layer),不是安全工具。协调者初判正确。`rules/` + `beacon-sandbox/hostguard` 是其 "security review" 的**一个 lens**,不是主体。AGENTS.md 自述 "local-only endpoint telemetry agent"。
- **与 RSI 的关系**:它是 "经验复利" 的**自动化实现**——`捕获 session → 评分/提炼 → 人审 → 提升为可检索记忆(MCP/Skills)`。这正是我们手搓的 `裁定编号 + F-台账 + runbook + PROGRESS + 笔记本` 体系所做的事,区别在**自动化程度**与**知识形态**。弱形式 RSI = 让后来的 agent 复用先前 agent 的经验;两边都是这个闭环,beacon 自动化 capture/distill/retrieve,我们靠纪律+对抗式审查。
- **一句话取向**:**不整体采用**(出境面 + 自动蒸馏绕过我们的对抗式审查,是两条红线);**可选最小借**=只借 "跨 harness session 捕获 + 归一化 trace" 作为我们台账的**原料**,提炼仍走我们的裁定流程,且**强制 local-only 非交互安装**。见第④节。

---

## ① 抓取面与侵入度

**捕获机制(README 支持表 + AGENTS.md)**:每个 harness 用 OTLP / hooks / poll / plugin / extension 之一或组合。关键几家:

| harness | 机制 | 侵入点 |
|---|---|---|
| Claude Code | OTLP + hooks + poll | 装 hook 进 `~/.claude`(settings/plugin)、起 OTLP collector 常驻、轮询 session 文件 |
| Codex CLI | OTLP + hooks + poll | 同类:hooks + collector + poll |
| OpenCode | Plugin + poll | 装 plugin + 轮询 |
| (另 20+) | 多为 hooks/poll/extension | 各自改配置 |

- **常驻面**:一个后台 **endpoint agent**(`beacon endpoint install`)把事件写 `~/.beacon/endpoint/logs/runtime.jsonl`;它是常驻 collector(监听 OTLP)+ 轮询器。
- **配置写入**:装 hooks 进各 harness 配置;装 **Beacon Skills** 进 `~/.agents/skills` 与 `~/.claude/skills`(除非关掉);选 cloud 时还注册 `beacon-managed` MCP 进 Claude Code/Codex/Cursor/VS Code/Gemini/OpenCode。
- **捕获粒度**:OTel 事件模型——sessions / prompts+responses / tool calls / commands / file activity / approvals / MCP / tokens。即**全量会话内容**(含我们的正文、命令、改动)。
- **对这台机子的可行性/侵入度判定**:**高侵入**。它要装进**每一个** harness 的配置并常驻捕获**所有**会话——而本机正跑一整个蜂群(多 claude/codex 现役 session)。让它接管全机 session 捕获 = 把全部蜂群正文喂给一个第三方 collector,**正是 stopSet 禁区**("不让它碰现役 session 数据")。即便 local 模式数据落本地,捕获面本身已覆盖所有敏感蜂群正文。

---

## ② 提炼管线与知识 schema 对比

**beacon 管线**(实现为 4 个 Agent Skills:`beacon-memory-{distill,promote,recall}` + `beacon-lens-create`):

1. **distill**:选 trace → **评分**(evaluator "Jev"/hosted TypeSafe,**走网络**,需 `TYPESAFE_API_KEY`/`BEACON_JEV_API_KEY`;可跳过改人读)→ agent 读源 trace **起草 lesson**(evaluator 只给概率,不写内容)→ **user 确认/编辑/拒绝** → approve。
2. **promote**:approved memory 装成 Agent Skill(`.agents/skills/<slug>/SKILL.md` 或 `.claude/skills`),harness 按 description 自动加载。
3. **recall**:approved memory 经 MCP 按需检索。

**知识形态对比**:

| 维度 | beacon | 我们(裁定/F-台账/runbook) |
|---|---|---|
| 来源 | 自动全量捕获 → 事后抽取(高召回、原始) | 决策当场手写(高精度、低召回) |
| schema | OTel trace(机器事件)→ 抽取的 "workflow/correction/pattern"(半结构) → Skill(SKILL.md) | 编号裁定(#R*/F-编号)+ 台账行 + runbook,**可溯源到具体决策/事故** |
| 审核 | distill 的 "user 确认" 一道(轻量 human-in-loop) | **对抗式复审循环**(reviewer↔coordinator↔owner,vm-ssh 打了十轮)——重得多、也严得多 |
| 检索 | MCP / Agent Skills **自动按需加载**(机器可取) | docs/memory 文件,**靠人/约定读**,无自动检索 |
| 可复用性 | 机器可取性强;但蒸馏质量系于其 evaluator+轻审 | 精度/可信度强、可追溯;但不自动进 agent 上下文 |

**要害**:beacon 的强项正是我们的弱项(**自动检索** + **高召回捕获**);我们的强项正是它的弱项(**对抗式审查的可信度** + **决策级可溯源**)。谁的知识 "更可复用"?——**机器可取性 beacon 胜,可信度/可追溯我们胜**。把二者简单合并会稀释我们的精度。

---

## ③ local-first 真实性与出境面

README/skills 的自述相当**坦白**,但 "local-first" 有分层真相:

**确属本地、不出网**:
- 默认写本地 JSONL(`~/.beacon/endpoint/logs/runtime.jsonl`);
- 本地 dashboard(只读);
- 本地 `beacon mcp serve` MCP server **从不触网**(README 明示)。

**出境面(逐条)**:
1. **交互安装默认预选 Beacon Cloud**(opt-out 到 Local)——**暗纹**:默认档是云。"signing in forwards nothing;确认 Managed 才转发",confirm 屏会说明——透明,但默认值不利于零出境。
2. **Beacon Cloud 转发**(opt-in,device enrollment,Standard/Metadata-only 两档)。
3. **SIEM/对象存储转发**(opt-in 配置):Splunk/Datadog/Elastic/Sentinel/CrowdStrike/Sumo/Wazuh/S3/GCS/CloudWatch。
4. **distill 评分 evaluator**(hosted TypeSafe/Jev,**默认走网络**,需 API key;**可跳过**)——**README 的云框架之外的第二出境面**:即便 endpoint 设 local,蒸馏时若用默认评分,trace 衍生数据会出网。**本机若用必须跳过评分、改人读 trace**。
5. 选 cloud 时注册 `beacon-managed` MCP(OAuth,联网搜索转发的历史)。

**非交互/package/MDM/CI 安装**:account-free、noninteractive(不预选云)——这是我们唯一可接受的安装路径。

**判定**:"local-first" 承诺**大体属实**(本地 JSONL 默认 + 本地 MCP/dashboard 不触网),但**不是零出境默认**:交互安装偏向云,且 distill 评分是隐藏的第二出境口。与我们 "不出境" 纪律**冲突点明确**,可规避(非交互装 + Local + 跳过评分),但要刻意绕开两处默认。

---

## ④ 借 / 不借(逐条)

**不借**:
- **cloud 转发 / SIEM / Beacon Cloud MCP / distill 评分 evaluator**——任何出网面都撞 "不出境" 红线。distill 默认评分尤其隐蔽,明确不采。
- **自动蒸馏作为知识入口**——它的 "user 确认" 一道审 ≪ 我们的对抗式复审循环。让自动抽取的 "lesson" 直接进 agent(promote→Skill 自动加载)会**绕过我们的审查严谨性**,是知识投毒/质量面。我们刚用十轮对抗审查打磨一个锁协议——那种严谨不能被轻审蒸馏替代。
- **全机 endpoint 捕获**——撞 stopSet(碰现役 session)+ 高侵入。

**可选最小借(若要借)**:
- **概念借,不装它**:借 "跨 harness session → 归一化 trace(OTel 事件模型)" 作为**我们台账的原料层**。我们现在有 agenthop 自己的 session log + bus msglog + `sivtr-memory`,但没有统一归一化 trace。若日后要高召回原料,可借它的**事件 schema 形状**自建一个 local-only、零第三方的采集(不装 beacon)。
- **若真要跑 beacon 取经**:仅 `beacon endpoint install` 的**非交互 + Local** 路径,**隔离目录 + 假 session 数据**,**绝不**对现役 `~/.claude`/`~/.codex` 开捕获,**跳过 distill 评分**。—— 但 ROI 低:为取一个 trace 形状装一个高侵入常驻件不划算。

**给理由不借(主张)**:我们的 `裁定编号 + F-台账 + runbook` 已经是**同一个经验复利闭环的手工高精版**。beacon 的增量价值是 "自动检索 + 高召回",但代价是**出境面 + 轻审蒸馏 + 全机捕获侵入**——三者都与我们的核心纪律(不出境、对抗式审查、不碰现役数据)冲突。**真正值得我们自建的,是 "自动检索" 那一块**:把既有裁定/F-台账做成 agent 可按需 recall 的 local MCP/Skill(我们自己的 schema,零第三方),而**不是**引入 beacon 的自动蒸馏。

---

## 建议(供协调者/user 裁)

1. **不采用 agent-beacon**(出境面 + 轻审蒸馏 + 高侵入捕获三撞红线)。
2. **可借的是"自动检索"这一能力,自建**:把我们已有的高可信知识(裁定簿/F-台账/runbook)做成一个 **local-only、零第三方** 的 agent 可 recall 面(MCP 或 Agent Skill),补上我们"知识不自动进 agent 上下文"的唯一短板——这才是对我们弱形式 RSI 的真正增量。
3. 若 user 仍想实测 beacon:严格 **非交互 + Local + 隔离目录 + 假数据 + 跳过评分**,把它当 "trace schema 参考" 而非常驻件。

> 方法学声明:本评估为静态代码/文档审 + README/skills 自述解读;未运行 beacon、未装 cloud、未登录、未碰现役 session 数据;二进制级出境审计(读 Go endpoint agent 全部转发路径)超出本研究 tier,已就文档化的网络面逐条列出并标注。
