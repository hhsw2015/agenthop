# docker-agent 深评(2026-10-08)

对象:`https://github.com/docker/docker-agent`(Docker 官方 CLI 插件,`docker agent`;Apache-2.0;~4.2k★;"AI Agent Builder and Runtime by Docker Engineering")。纯研究、零遥测、不碰 OpenDots 三门、产物只落 `~/Dev/agenthop/docs/research/`。

我们矿挖的是:它的 **YAML 声明式 agent/多 agent schema** 有什么可搬进我方 `roleProfile+任务信封`;它的编排原语(sub_agents/handoffs/force_handoff/routing)与我方 **总线+耐久箱+板** 逐字对下来谁在哪一层;它的 **OCI 分发**("agent 镜像化")对 `vm-ctl/placement` 的 boot-template 有无启发;它的 MCP 接法 vs 我方 agenthop MCP;以及它与 Docker 生态的绑定度是否与我方 `vm-ctl 解耦宪法`(位置透明/provider-agnostic)冲突。

**诚实前提(影响全篇可信度)**:本环境 SSL 挡了 `docker.github.io` 文档站与 `raw.githubusercontent`。证据分三等:
1. **权威**:`agent-schema.json`(gh raw 取得,声明 `Docker Agent v16`,162KB,draft-07)——schema 字段是硬事实,逐字可引。
2. **二手**:仓库 README(WebFetch 取得)——YAML 示例、命令名、license、telemetry、安装路径。
3. **推断(标注待核)**:**编排运行时内部**(sub-agent 间消息到底走什么线、budget 如何跨子会话结算的实现)只能从 schema 字段语义**推断**,未读运行时源码。凡属此类,下文标「【待核:运行时】」。

结论预告:**docker-agent 是「把一队 agent 塞进一次 `docker agent run` 的声明式单进程编排器」;我方是「一群独立持久会话靠耐久总线协作的蜂群」——两者是不同层,别混。它的 schema 成熟度(可复用引用/flavor 覆盖/共享预算/权限/evaluator 路由)值得逐条借;它的运行时模型与生态绑定不借。**

---

## 一、八轴对表(传感器输出,反洗白逐字)

| 轴 | docker-agent(schema v16 事实) | 我方(agenthop) | 判定 |
|---|---|---|---|
| **身份** | agent = `agents.<name>` 的声明块(`model/instruction/toolsets/sub_agents/...`)。无跨进程稳定 id;身份=一次 run 内 config 里的名字。外部 agent 用 OCI ref(`ns/repo@sha256:...`)寻址。 | 稳定 id(F40)+ `roleProfile`(角色-任期解耦,`packages/bus` t3 schema/translate/recompile 流水线)+ 信封 `from/fromLabel`。身份跨会话、跨机器持久。 | **不同层**:它的身份是 run-局部配置名;我方是蜂群全局稳定 id。它的 OCI-ref 寻址可借给 boot-template(见轴规模/Q3)。 |
| **通信** | run 内:`sub_agents`(agent-as-tool,LLM 调)/`handoffs`(移交对话)/`force_handoff`(绕过 LLM 的确定性移交,查环)/`routing`(evaluator 选 agent)/`a2a` toolset(agent-to-agent 协议)/`background_agents` toolset。共享一个 run 的 session+budget。【待核:运行时 a2a 与 handoff 的线格式】 | 总线单播 + 耐久箱(`composeInboxMsg/writeInbox/claimInbox`,CAS 认领,`quarantine` 毒丸隔离)+ 板(拉式领活)。R6/R7 两两直连去中心化(`team-collab-design.md`:协调者退为「例外处理器」,负担与成员数解耦)。 | **不同层**:它是单进程内对话树的消息传递;我方是跨会话持久消息织物。它的 `force_handoff` 确定性管道可借(见 Q2)。 |
| **耐久** | `session_compaction`/`num_history_items`/`max_old_tool_call_tokens` 管对话史;`cache`(同问复用答)。耐久单位=一次 run 的 session,run 结束即止。toolset 进程有 `Lifecycle`(resilient/strict/best-effort + backoff)。 | 耐久事实=control-log → 投影 → 看板(CORE.md 可观测柱);消息=加速器非唯一通道,完成=耐久产物 observer 自发现;sweep 到期必处置。跨 run/跨重启持久。 | **我方强**:它无跨 run 耐久协作;我方的耐久是宪法级。它的 toolset `Lifecycle` backoff 纪律与我方 `cluster-medic` 自愈趋同(印证方向)。 |
| **审查** | `permissions{allow/ask/deny}`(工具模式,deny 优先)+ `readonly`(全 toolset 只读)+ `redact_secrets`(默认开)+ `evaluators`(provider 背书的独立评估)+ `budget` 到顶即停。 | 三门 HITL(console approve/decline → 决策回执)+ decision-batch(压缩单次裁决)+ grill-gate + review-packet 模板 + F→回归→复发即 CI 红(`immunity-mechanism-brief`)。 | **趋同+各有强**:它的 `allow/ask/deny` 模式化权限干净,可借给 console/agenthop MCP 暴露面;我方的 HITL 带宽感知(bandwidth-gauge)+ F 免疫是它没有的。 |
| **回收** | run 结束=一切回收(单进程生命周期)。`budget.max_time` 到点停。toolset `Lifecycle.restart=never/on_failure/always`。 | 任期心跳陈旧 → 引导根换任期(`cluster-medic`);sweep 到期处置;idle 报到。回收是蜂群级持续机制。 | **我方强**:它靠进程退出「免费回收」,无长活成员回收问题;我方面对的是长活蜂群的回收,本就更难的题。无可借。 |
| **观测** | telemetry(匿名使用数据,默认收集,文档可关)。`hooks`(各生命周期点跑 shell)可自接观测。无内建集群看板(单 run 无此需求)。 | 观测=数据层 control-log→投影→看板(全静默红态);解释=页/视频回指事实。**零遥测宪法**。 | **冲突**:它默认遥测 ⇒ 与我方零遥测宪法**硬冲突,不借**。它的 `hooks` 生命周期钩子形制可借(自观测,不外发)。 |
| **成本** | `budget{max_cost(USD)/max_tokens/max_time}`;`budgets`=**共享池**(具名预算=一个上限多 agent 同抽,fan-out 到 N 个子 agent 不会花 N 倍)。per-run 结算。【待核:运行时跨子会话结算实现】 | 成本=CPA 池常规开发(非花钱门);bandwidth-gauge 用「产出需裁件 vs 清裁」失衡驱动 R18 两级节流(`dual-bandwidth-v1.md`)。 | **高价值可借**:它的**共享预算池语义**正对我方 R18 并发以 B_cons 为界 + bandwidth-gauge 节流——一个具名上限约束一次 fan-out 总花费,直接可映射。 |
| **规模** | OCI 分发:`metadata.version/tags` 发布;`sub_agents/handoffs` 可引外部 OCI 镜像(`ns/repo@sha256:...` digest 固定=缓存;tag=每次 run 重解析)。pull-anywhere。横向规模=组合更多外部 agent 镜像。 | `vm-ctl` placement 引擎(`placement-engine.ts`+`vm-ctl-design.md`):「要一个成员干活」,位置=账本字段非交互步骤,boot 的远程成员与本地**零差别**(machine add + workspace-per-machine)。 | **不同层但有启发**:它分发的是**声明式 config 工件**;我方 vm-ctl 分发的是**活成员的 placement**。它的 **digest-pin 不可变工件** 概念可借给 boot-template 版本纪律(见 Q3);机制本身不借。 |

---

## 二、五问逐答

### ① YAML 声明式 agent 定义 vs 我方 roleProfile+任务信封 —— schema 有何可借

docker-agent 顶层:`version(0..16)` · `providers` · `agents` · `models` · `mcps` · `rag` · `commands` · `skills` · `toolsets` · `budgets` · `flavors` · `permissions` · `evaluators` · `metadata` · `runtime`。`AgentConfig` 字段(节选,全属实):`model/fallback` · `instruction(+instruction_file)` · `toolsets/use_toolsets` · `sub_agents/handoffs/force_handoff/routing` · `budgets` · `safety/readonly/redact_secrets/permissions` · `hooks` · `session_compaction/compaction_threshold/compaction_model` · `structured_output` · `harness`(外部 coding harness,带 `effort/model/thinking`——即可用 Claude Code 之类当执行壳)· `max_iterations/max_consecutive_tool_calls`。

**可借(逐条,带理由)**:
- **可复用引用 + 具名定义**(`mcps/toolsets/commands/skills/budgets` 顶层定义一次,agent 用名字 `use_*` 引用,去重)。我方 roleProfile 目前没有「片段库+按名引用」。**借:给 roleProfile 加可复用片段**(共享 toolset/指令块/预算),避免每角色复制。杠杆高,直接改善角色编写。
- **flavors(JSON Merge Patch 覆盖层)**:具名补丁在 run 时叠加,`key+:` 追加数组、`key-:` 删除、scalar 升级为单元素数组。**借:角色变体不复制整份**(如 `reviewer` 的 strict/lenient flavor)。杠杆高。
- **structured_output / evaluators / compaction 旋钮**:小借,按需。
- **harness 字段**(把 agent 跑在外部 coding harness 上)在概念上印证我方「roleProfile→实现节点用外部 harness」的分层。

**不借**:`version 0..16` 的线性版本枚举(它把 schema 版本钉死在枚举里,我方用语义化更自由);`agents.root` 的单根约定(见 Q2)。

### ② 多 agent 编排原语 vs 我方总线+耐久箱+板(反洗白逐字对)

docker-agent 的编排 = **一次 `docker agent run` 内的对话树**,四个原语:
- `sub_agents`:agent 作为工具,LLM 决定调用(委托);
- `handoffs`:把对话移交给另一 agent(LLM tool-call 触发);
- `force_handoff`:**绕过 LLM** 的确定性移交(本 agent 一出最终答就无条件转交,查环、禁自指)——给严格管道(extractor→summarizer)用;
- `routing`(`AgentRouting`:`allowed_agents`+`default_agent`,evaluator 选路;`RoutingRule`:示例短语→模型);
- toolset 类型里另有 `a2a`(agent-to-agent 协议)、`background_agents`(后台 agent 当工具)、`scheduler`。

**逐字对比(反洗白)**:
| 维度 | docker-agent | 我方 | 真相 |
|---|---|---|---|
| 作用域 | 一次 run 内,进程退出即止 | 跨会话、跨机器、跨重启持久 | **不同层**。它的「多 agent」= 一次对话里 LLM 调子 agent;我方「多 agent」= 一群独立 session 长活协作。 |
| 消息面 | 共享 run session + tool-call 移交(+a2a)【待核:运行时】 | 耐久箱单播 + CAS 认领 + 板拉式 + 毒丸隔离 + 完成槽 observer 自发现 | 它无持久消息织物、无认领竞争、无毒丸/死信;我方无「一次 run 内共享 context 的即时子调用」。 |
| 拓扑 | 层级(root+具名子)+ 确定性管道(force_handoff) | 去中心化两两直连(R6/R7),协调者=例外处理器 | 它是中心根编排;我方刻意去中心。 |
| 失败 | budget 到顶停 / toolset Lifecycle 重启 | sweep/任期心跳/medic 自愈/F 回归 | 它是进程级;我方是蜂群级。 |

**可借**:`force_handoff` 的**确定性管道原语**(绕 LLM、查环、禁自指)——我方派发目前偏 LLM 判断 + 拉式,缺一个「严格确定性流水」的声明式表达。给 dispatch 加一个 force-pipeline 字段(A 出 → B 必接),杠杆中。**不借**:单进程对话树当蜂群模型(它根本不是持久蜂群);`agents.root` 单根中心拓扑(与我方去中心冲突)。

### ③ OCI 分发("agent 镜像化")对 vm-ctl/placement boot-template 有无启发

docker-agent:`metadata{version/tags/license/author/readme}` 用于 **OCI registry 发布**;`sub_agents/handoffs/force_handoff` 可引**外部 OCI 镜像**——`ns/repo`(tag,每次 run 重解析,即便不调用)或 `ns/repo@sha256:...`(**digest 固定 = 从缓存服务,不每 run 查 registry**)。命令面 `docker agent run myorg/agent:tag`(README)。

**它分发的是「声明式 config 工件」,不是活进程**。我方 `vm-ctl` 分发的是「活成员的 placement」(`vm-ctl-design.md`:位置透明,boot 远程成员与本地零差别)。两者不同层,机制不照搬。

**启发(可借概念,非机制)**:**digest-pin 不可变工件** = 可复现 boot。我方 boot-template 若把「角色工件」按内容寻址(digest)固定,就得到:(a)可复现——同 digest 同 boot;(b)位置透明分发面——pull-anywhere 的缓存语义天然对齐 placement 的「位置是账本字段」。**立项候选:boot-template 版本纪律用 digest-pin**(角色工件内容寻址 + tag=可变指针/digest=不可变),borrow 自 docker-agent 的 sub_agents OCI-ref 语义。杠杆中。

### ④ MCP 集成方式 vs 我方 agenthop MCP

docker-agent 是 **MCP 宿主/客户端**:`MCPToolset` 字段 `command/args`(stdio)· `ref`(`docker:context7` 目录引用)· `remote`(streamable-http/SSE + oauth + headers)· `version`(自动安装)· `tools`(只暴露子集)· `defer`(延迟加载)· `config` · `lifecycle`;顶层 `mcps` 可复用;toolset 另有 `mcp_catalog` 类型。还有 dial-time SSRF 防护(默认拒 loopback/RFC1918/link-local/169.254.169.254,Docker Desktop 在时只放行 docker.io 系)。

我方 agenthop MCP 是 **MCP 服务端**(暴露 `agenthop_spawn/send/peers/handoff/...` 给别的 agent 用)。**角色相反**:它消费 MCP,我方供给 MCP。

**可借**:(a)`MCPToolset` 的**声明式接线 schema**(`ref/remote/defer/tools-subset`)比临时接法干净——若将来 console/角色要声明式挂 MCP,照此形;(b)`tools`(只暴露子集)+ `defer`(懒加载)+ `permissions{allow/ask/deny}` 组合 = 一个干净的**最小暴露面**模型,可借给 agenthop MCP 的暴露治理;(c)dial-time SSRF 防护清单是扎实的安全基线(我方若开远程 MCP 可借)。**不借**:`docker:` 目录引用(绑 Docker 生态,见 Q5)。

### ⑤ 威胁面:Docker 生态绑定度 / 遥测 / license

- **Docker 生态绑定(高)**:CLI 插件(`~/.docker/cli-plugins/docker-agent`)· Docker Desktop 4.63+ 预装 · Docker Model Runner(本地模型)· `docker:` MCP 目录引用 · `FederationAuthConfig`(`organization_id/service_account_id/identity_token/federation_rule_id` = Docker 企业联邦)· 受保护 HTTP 客户端在 Desktop 在时**只放行 docker.com/docker.io 系走 PAC 代理**。→ **与我方 `vm-ctl 解耦宪法`(位置透明/provider-agnostic/后端可换)硬冲突**:采用其运行时=把蜂群钉在 Docker 上。**不借运行时**;只借与 Docker 无关的 schema 概念。
- **遥测**:默认收集匿名使用数据(README 承认,文档可关)。→ **与零遥测宪法硬冲突,不借**(连带:若试用也须 air-gap + 关遥测)。
- **license**:Apache-2.0。→ **读/借 schema 设计安全**(宽松许可,借思路/字段形制无授权障碍;不引入代码依赖)。
- **tag 重解析副作用**:外部 OCI ref 用 tag(含隐式 `:latest`)**每 run 都查 registry,即便子 agent 从不被调用** → 供应链 + 可用性面(registry 挂=run 退化)。借 digest-pin 概念时**必须钉 digest**,别继承 tag 行为。

---

## 三、独立趋同(外部样本印证我方方向)

| 它的做法(schema 事实) | 我方 | 判定 |
|---|---|---|
| `budgets` 共享池:具名预算一个上限多 agent 同抽,fan-out 不翻倍 | R18 并发以 B_cons 为界 + bandwidth-gauge 节流 | **趋同**:都认「fan-out 的总成本须有一个共享上限」。 |
| toolset `Lifecycle`:resilient 默认指数退避重启 / strict 快失败 | `cluster-medic` 自愈 + 任期心跳 | **趋同**:长活依赖的监督/退避形制一致。 |
| `permissions{allow/ask/deny}` deny 优先 | console 三门 HITL + deny 优先直觉 | **趋同**:人审边界模式化。 |
| `force_handoff` 确定性管道(绕 LLM) | 完成=耐久产物 observer 自发现(非 LLM 中转) | **近趋同**:都想在确定性路径上去掉 LLM 中间商。 |
| dial-time SSRF 拒私网/metadata 端点 | (我方远程面尚少)| **印证**:远程 MCP/fetch 的安全基线方向。 |

这几条是外部独立样本,印证我方共享预算、自愈退避、人审模式、确定性路径都站在对的结构上。

---

## 四、结论三栏(带杠杆排序)

### 借(leverage 降序)
1. **[高] 声明式可复用片段 + flavor 覆盖**(Q1):roleProfile 加「具名片段库 + `use_*` 引用 + JSON-Merge-Patch flavor 覆盖(`+`追加/`-`删除)」。直接砍角色定义重复,改善编写。→ 立项①。
2. **[高] 共享预算池语义**(轴成本/Q⑤):具名预算=一次 fan-out 的共享上限,映射 R18 两级节流 + bandwidth-gauge。→ 立项②。
3. **[中] force_handoff 确定性管道原语**(Q2):给 dispatch 一个声明式「A 出→B 必接、查环、禁自指」,补我方偏 LLM/拉式的严格流水缺口。→ 立项④。
4. **[中] digest-pin 不可变工件 → boot-template 版本纪律**(Q3):角色工件内容寻址,tag=可变指针/digest=不可变可复现。→ 立项③。
5. **[中] MCP 声明式暴露治理**(Q4):`tools`子集 + `defer`懒加载 + `allow/ask/deny` = 最小暴露面模型,借给 agenthop MCP 暴露面 + console 权限。
6. **[低] hooks 生命周期钩子(自观测,不外发)· evaluator 路由 · structured_output · compaction 旋钮**:小借,按需。

### 不借
1. **Docker 生态运行时绑定**(CLI 插件/Desktop/Model Runner/`docker:`ref/Federation/PAC 只放行 docker.io)——与 vm-ctl 解耦宪法硬冲突。
2. **遥测**(默认匿名使用数据)——与零遥测宪法硬冲突。
3. **单进程 run 内对话树当蜂群模型**——不同层,绝不用它替换 总线+耐久箱+板。可借 schema 思路,不借运行时模型。
4. **OCI 当「活成员」分发机制**——我方 vm-ctl 分发 placement(活成员),非 config 工件;借 digest 概念,不借机制。
5. **外部 ref 的 tag 重解析行为**(每 run 查 registry/`:latest`)——供应链+可用性风险,借时必钉 digest。

### 立项(建议,杠杆降序)
1. **[高] roleProfile v2:可复用片段 + flavor 覆盖**——小 schema 工程,高编写杠杆;落在现有 roleProfile + t3 translate 流水线上。
2. **[中] 共享预算上限原语,接 bandwidth-gauge/R18**——成本治理件,与 T5-2 失衡读数闭环。
3. **[中] boot-template digest-pin 版本纪律**——vm-ctl 可复现性件。
4. **[低] dispatch 确定性 force-pipeline 字段**——严格流水的声明式表达。

**一句话**:docker-agent 是成熟的**声明式单进程编排 schema** + **Docker 生态分发**;它的 schema 设计(可复用/flavor/共享预算/权限/确定性管道)值得逐条借进我方 roleProfile 与成本/派发面;它的**运行时模型与生态/遥测绑定不碰**——我方的持久去中心蜂群是另一层,且在耐久/回收/观测上本就更难、更完整。

---

## 待核清单(诚实缺口,SSL 挡文档站所致)
- 【运行时】sub_agent/handoff/a2a 的进程间消息线格式与 budget 跨子会话结算实现(本篇从 schema 语义推断)。
- 【运行时】OCI 工件内到底打包什么(仅 YAML+refs?还是含模型/工具?)——README 只给 `run ns/repo:tag`,未见打包清单。
- 【文档】multi-agent 概念页、distribution 页、telemetry 页原文(`docker.github.io/docker-agent/*`)本环境不可达;补网后应二次核对编排拓扑与遥测可关性细节。
