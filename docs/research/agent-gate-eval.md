# AgentGate 深评(第十二面镜 · 可靠性/刹车赛道)

owner=f32a0507;协调者派单(user 亲令)。对象 github.com/zw-onemaker-ai/agent_gate,`__version__=1.3.4`(蓝图决策 2026-08-07,v1.3.4 回归修 2026-08-17,文章 2026-10)。MIT。纯 Python 标准库、单机在进程、零三方依赖;127 测试(README 自述)。gh 全程实证(clone + 读码读文,**未运行其代码**);纯研究,未改码未提交。

## 0. 一句话 + 证据诚实

一句话:AgentGate 与我方**同源**——「产出默认不可信,验证后才算数」(其 slogan:Agent 管编,闸门管信;显式把 LangChain/CrewAI/AutoGen「默认产出可信」当反面)。它是这条「刹车赛道」的**单机在进程版**;我方是**无中心分布式版**(见 §6)。不整合(单机 IDE 前置、与北极星相悖),只挖其可靠性机制本身。

证据诚实(文档 vs 代码分叉,按码为准,标 △):
- △ `docs/TECHNICAL_ARCHITECTURE.md` 自标「目标蓝图,非当前代码」;协议文档按 R1-R12 角色写意图,实现在 `src/*.py` 常有出入。
- △ 脱敏(desensitize)被协议文档列为三大核心闸门之一,**代码里默认 OFF**(`check_desensitize=False`)。
- △ 发布的定向回环协议列 5 条 error→role 路由,**代码多一条第 6 路 `SELF`**(通用验收失败+瞬时 LLM 错)才是真正主力。
- △ 三级预算有两套不一致阈值(assembler 8000/16000 字节 vs validator 助手 8192/15360)。
- △ README「无验证成功率约 60%,加验证层 95%+」自标估算,非基准。
- △ Pipeline Doctor 的 `apply_fix` 多为「记录意图的符号动作」(注 prompt/重置计数/清陈旧契约),非真修复。

## 1. EXIT 指纹(claim→指纹→核验)

**机制**:`run_bash(cmd)` 把命令改写成 `bash -c "<cmd>; echo EXIT:$?"`,shell 自己尾附 `EXIT:<码>`。所谓「指纹」**不是哈希**,是对输出正则 `EXIT:(\d+)` 的刮取(`ExitCodeFingerprint.from_output`:**末个匹配**胜出,`-1` 表缺失,`count` 喂 Doctor 的漂移检查)。拦截点在 `quality_gate_check`:无指纹⇒「EXIT_CODE fingerprint absent」(当作伪造),非零⇒「Verification command failed (EXIT:N)」,皆推 `fail_reasons`⇒`GateStatus.FAIL`⇒喂定向回环。超时合成 `EXIT:124`,异常 `EXIT:1`。防伪**全靠认识论赌注**:「LLM 没真跑过的命令,猜不中它的退出码」,无任何密码学绑定。

**对表(我方=固定 SHA + 封存哈希 + 独立复跑)**:两条正交的「真实性轴」。
- 源完整性:**我有他深**。git commit SHA = 全树内容寻址指纹;审查席封存每文件 SHA-256(review-evidence 的 `*-results.json`)并在签收时复核以证「审查→合并」间零漂移(本轮 inbox-wake 682 封存文件校验过);负面对照(diff 旧 SHA)证「修确实改了行为」。他方**根本不给源指纹**,只给「这次运行」的收据。
- 执行провенанс:**我有他深**(但他更廉价)。我方审查席**独立重跑**测试=最强执行证据(完全不信作者声明)。他的 EXIT 刮取是「无独立复跑者」管线里的在进程廉价替身。
- **借:执行провенanス收据**。把「执行器盖章、agent 不经手」这个廉价把戏下沉到我方**工具运行包装层**:凡无完整对抗复跑的无人值守步骤(dispatcher 自检 / autonomous-loop / gauge/digest/placement sweep),让运行包装自动盖一枚 agent 伪造不了的收据(退出码 + 可选廉价输出哈希),使「它过了」有收据背书。补我方 SHA(管源)之外的「管这次运行」一轴。规模:小。

**判**:整体 **我有他深**(密码学绑定+独立复跑 ≫ 认识论刮取);唯一可借=把廉价执行收据用在「够不着审查席」的自动步骤上。

## 2. 三闸门 + 定向回环

**机制**:闸门(`quality_gate_check`)=①文件存在(+`py_compile` 语法,v1.3.4 修了「编译失败仍记 syntax_ok=True」)②EXIT 指纹 ③脱敏(默认 OFF,禁词正则含 `管线|pipeline|R\d|quality_gate|...`)。引擎另加:契约交叉核验(`cross_verify_contract`:契约声称产出文件则逐一复查存在非空,否则 FAIL→回环 BACKEND;端点只标 SKIPPED「没真跑服务 curl 不了」)、`strengthen_verify_cmd`(`.py` 前置 `py_compile`、`.js/.ts` 前置 `node --check`,防「grep-only 命令放行代码文件」)、`sanitize_agent_output`(写盘前剥 markdown 围栏/CONTRACT 块/旁白,空⇒FAIL+SELF)、CPOO prompt 预检(§5)。

**定向回环**:`LOOPBACK_PATTERNS` 正则表(**首匹配胜**)把错误**类型**映到**角色/阶段**:代码错(syntax/traceback/NameError…)→BACKEND;安全(xss/injection/cve…)→SECURITY;前端(html/css/dom…)→FRONTEND;架构(schema/data model…)→DESIGN;需求(requirement/scope…)→REQUIREMENTS;通用验收失败→**SELF**(重试同 agent)。`classify_failure` 合并 `fail_reasons+verification_output` 跑正则,无匹配⇒`NONE`⇒走 HumanGate。引擎按目标**跳到拥有该角色的阶段**,并**裁剪上游契约**到目标阶段及之前(重试不见自己失败的产出)。预算:`max_iterations=5`(全程回环上限)、每阶段 `max_retries=3`;`loopback_count>=5`⇒Doctor+停。

**对表(我方=三闸[作者自检/对抗审查席/协调者+user 合并启用门] + FC 失败分类学 + 返修棒 + classifyFailure)**:
- **他有我无**:错误类型→**责任阶段**的定向路由。我方回环是**单阶段**(发现→修→恒回「再审」);他把缺陷路由到**拥有它的上游**(语法错→后端、需求缺→需求)。
- **他有我无**:回环时**裁剪上游上下文**到回环点(重试的卫生)。我方整件重投。
- **我有他深**:我方 FC 失败分类学是**跨任务持久律典**(65 条 rulings + F21-F47 + FC-2/3/6/7 族,只增);他的 `LOOPBACK_PATTERNS` 是单次运行的静态正则表。且我方 `classifyFailure`(retryable/non-retryable/context-exhausted/environment/unknown)按**失败性质**分,与他按**责任组件**分正交——两轴皆有用。
- **纯理念重合**:从真实 E2E 事故硬化(他 v1.3.4 整批源于一条失败链:未净化输出→语法错→pytest 级联→误判回环→撞 5 环顶);我方 FC 族同样从真实审查发现累积。
- **借:给我方失败分类加一条「责任阶段(WHERE)」轴 + 回环上下文裁剪**。落点:T3 规划器/grill-gate/多阶段任务——把「设计错 vs 实现错 vs 需求缺」路由到重规划/重实现/问 user,而非盲回再审;handoff/decision-batch 在回环时按目标裁剪契约。规模:中。

**判**:**他有我无**(定向路由+上下文裁剪,我方扁平单审拓扑确无);但我方失败**律典**与**性质分类**更深更持久。

## 3. Pipeline Doctor(卡死诊断规则库)

**机制**:`PipelineDoctor(gate).diagnose()` 读 `gate._gate_history`,跑六规则,聚合 `Finding{level,category,description,suggestion,confidence}`,选根因、定可否自动修、选回环目标。六规则(名/类/级/触发阈/置信/建议):
1. `loopback_loop` CRITICAL — 单目标回环 **≥3** 次 — `min(0.9,0.5+0.1·n)` — 「查该 agent 需求/prompt,考虑重排管线」
2. `persistent_fail` CRITICAL — 某角色 ≥2 次且**全 FAIL** — 0.85 — 「查 prompt/验收/上游,或换 role_goal」
3. `context_bloat` CRITICAL — `loopback_count>=max_iterations` — 0.7 — 「归档旧上下文/减上游契约/拆阶段」
4. `exit_drift` WARNING — ≥3 退出码且**单调递增** — 0.6 — 「级联退化,查上游输出是否在拖垮下游」
5. `missing_fingerprint` WARNING — 任一步无 EXIT 指纹 — 0.9 — 「prompt 加『Bash 输出必须以 EXIT_CODE 结尾』」
6. `contract_rot` INFO — 任一步契约缺/summary 空 — 0.8 — 「加 CONTRACT_START/END 块」

`can_auto_fix = 所有 CRITICAL 不属 {context_bloat,loopback_loop}`(此二须人工);类→回环目标映射固定;`apply_fix` 多为符号动作(△ 非真修)。

**对表(我方=sentinel-denoise + live-sentinel + inbox-sentinel)**:
- **我有他深**:我方诊断的是**活的分布式进程/会话态**——`classifyMemberHealth`(ok/disconnect-candidate/ghost-daemon)、`live-sentinel` `SentinelKind`(blocked/fake-death/idle-timeout/ghost-daemon)、`isDispatcherAlreadyRunning`(重复循环进程,解析 ps 树)、`detectStalledInboxes`(跨会话躺箱)、`screenIndicatesContentFilter`(内容过滤卡点)、`AlertDedup`(事件冷却)、跨进程活性(kill(0)/ECONNREFUSED 三态)。他只读单进程内存 gate_history。分布式失效模式(ghost/fake-death/重复 dispatcher/跨机躺箱)他结构上没有。
- **他有我无(失效模式)**:
  - `exit_drift`=**级联退化检测**(每次重试在变差,非单纯失败)。我方无「退化趋势」信号。
  - `loopback_loop`/`context_bloat`=**循环/轮次过多自诊**。我方审查轮次无自动诊断(本轮 inbox-wake 走 10 轮全靠人工判断;一枚「同类 P2 跨轮复现=该方案可能错,升级重设计/问 user」的自动提示是真缺口——尽管本轮每轮都是正当进展)。
  - **置信度分数**(0-1):我方 sentinel 告警是二元的,加置信可调抑误报。
- **纯理念重合**:卡死诊断→建议→自动修/人工分界(我方 sentinel 也诊断+升级、不自动修;双方都不该夸「自动修复」——他 apply_fix 符号化,我方亦只升级)。
- **借:级联退化检测 + 轮次/循环过多的诊断升级 + 诊断置信度**。落点:sentinel-denoise 加 `exit_drift` 式趋势规则;审查/返修环加「N 轮未收敛→问询升级」;给告警带 confidence。规模:小。

**判**:**我有他深**(分布式活性远超他);但**级联退化**与**循环过多自诊**是他想到我方没有的两个失效模式——头号可借项在本面镜。

## 4. ContextPackage 物化 + 三级预算

**机制**:`ContextPackage{package_id,source_role,target_roles,agent_output,gate_result,created_at}`=不可变审计快照,逐步 append 进 `state.steps`。阶段间结构化交接走 `Contract{agent_id,summary,output_files,endpoints,start_command,test_hints,schema_info}`(agent 发 CONTRACT_START/END 块,`parse_contract_from_output` 抽取;**仅 PASS 才累积**进 `_upstream_contracts`,渲成 markdown 注入下游「## Upstream Outputs」)。**三级字节预算**(对拼装 prompt 的字节数,非 token/时间):`CTX_NORMAL ≤8KB`=注全部契约;`CTX_WARNING ≤16KB`=只注最新一条契约;`CTX_CRITICAL >16KB`=只注 summary 拼接+提示「details truncated, ask if needed」。失败上下文**无视预算恒注入**。记忆分层 L1 项目/L2 会话/L3 工作(未实现);`INDEX_MAX_BYTES=4KB` 超则拒启。

**对表(我方=handoff + 投影 + S11 + roleProfile + dual-bandwidth + 配额)**:
- **他有我无(头号)**:**分级上下文预算降级**——随上下文增大自动 full→latest-only→summary-only。我方 handoff 是全量(摘要+git 快照),无按字节降级。
- **他有我无**:**带声明核验的类型化交接契约**——契约声称产出文件/端点,接收端**自动复查**声明(文件真存在)。我方 handoff 是散文摘要+git 快照,无「声明须被核验」的类型化契约(端点他也只敢标 SKIPPED,诚实)。与 Multica 的 attribution 问责、我方 C8/R16、submit-tag 同源。
- **我有他深**:我方投影是**分布式读模型**(console/TG/swarm-viz 多消费者读同一原子写 JSON);S11 是**耐久跨进程 exactly-once 箱**(poison-DLQ/publish-after-fact);他是单进程内存 ContextPackage 列表 + 磁盘会话文件。耐久+多消费者+exactly-once 他没有。
- **我有他深(反讽)**:他 `INDEX_MAX_BYTES=4KB 拒启`——我方本会话正撞 MEMORY.md 超限,解法是把细节移入 topic 文件(更优雅的降级,非拒启)。
- **纯理念重合**:不可变审计快照(他 ContextPackage)↔ 我方 append-only Talk 日志/裁定簿/git 史。
- **借:分级上下文预算降级 + 类型化可核验交接契约**。落点:①`agenthop_handoff`/morning-digest/decision-batch 拼装处加字节阈值+降级函数(full/latest/summary);②handoff/submit-tag 加类型化契约 schema(produced-files/endpoints/start-cmd/test-hints)+接收端声明核验,接 C8/R16 attribution。规模:①小 ②中。

**判**:**他有我无**(预算降级+可核验契约是两个干净借点);但我方上下文面的**耐久/分布式/多消费者**更深。

## 5. 其他机制一瞥(四挖之外)

- **CPOO prompt 评分**(`cpoo_scorer.py`):5 模块各 20 分=100,**正则打分不用 LLM**(「打分的人自己不能幻觉」),<80 不过、<60 LLM 重写、否则离线模板补全(v1.3.4 修了 60-80 死区)。↔ 我方 roleProfile 质量,但「不用 LLM 自评」思路可借入提示质量门。他有我无(但属 prompt 层,非可靠性核)。
- **工具白名单+风险分级**(`tool_registry.py`):`@`-工具 `{risk: low/medium/high/critical, requires_gate}`,「约束手不约束脑」。↔ 我方 `cap≠user 授权`/权限门,同向;纯理念重合。
- **HumanGate 结构化升级**(`human_gate.py`):回环=NONE 时按 `FAIL_CATEGORY_MAP` 给**分类清单**(每类 question+options,选项映回环目标),非空白提示。↔ 我方 R3-b 问询带默认/grill-gate;纯理念重合,但「分类清单式人工升级」措辞可借入 grill-gate。
- **loopback-context 净化**(`sanitize_loopback_context`):剥命令行/Traceback/`EXIT:\d+` 噪声,防「重试模型把 verify 命令抄进产出」(真 E2E 见过伪造 `test_app.py`)。↔ 我方 `oneLine()`/stdout 净化,同源。
- **双脑**:设计脑(设计时 LLM 出 config+prompts)+执行脑(运行时**零 LLM 纯规则引擎**,「规划可模糊,执行须精确;subprocess.run() 不胡说」)。编排选择,非可靠性机制;我方编排由协调者+user 驱动,不借。

## 6. 刹车赛道立论:我们是分布式版

**是。** 同源「产出默认不可信」,差异几乎全由「单机 vs 分布式」一条推导:
- 他能用的廉价在进程把戏,我方因分布式用不了,只能上更硬的:EXIT 刮取 → 我方内容寻址 SHA+封存哈希+独立复跑;内存 ContextPackage → 我方耐久 exactly-once 箱;字节预算 → 我方 dual-bandwidth 带宽仪;6 规则内存 Doctor → 我方跨机活性哨兵;单次正则回环表 → 我方跨任务 FC 律典;并发=ThreadPool → 我方 O_EXCL/rename-CAS/genesis 哨兵(本轮一条竞态走 10 轮)。
- 他有而我方(刻意)没有:单机同步闸门、单 prompt 字节预算、同进程契约交叉核验——这些是「单机红利」,分布式里要么不需要要么代价过高。
- 呼应 [dist-ha-theory-eval] 的「我们在重新发现分布式系统」:AgentGate 是**同一条刹车论、免分布式税**的对照组,恰好照出我方哪些复杂度是分布式**必要税**(耐久/无共识协调/fencing),哪些是我方**真没想到的失效模式**(§3 级联退化、循环过多自诊)。

## 7. 吸收清单(排序,落点+规模)

1. **级联退化 + 轮次过多自诊**(§3)——sentinel-denoise 加 `exit_drift` 式趋势规则 + 审查/返修环「N 轮未收敛→问询升级」;小。**头号**(真失效模式缺口)。
2. **分级上下文预算降级**(§4)——handoff/morning-digest/decision-batch 拼装加字节阈值+full/latest/summary 降级;小。
3. **执行провенanス收据**(§1)——工具运行包装层自动盖 agent 伪造不了的执行收据,用于无审查席的自动步骤;小。
4. **错误类型→责任阶段定向路由 + 回环上下文裁剪**(§2)——失败分类加 WHERE 轴,T3/grill-gate 多阶段路由重规划/重实现/问 user;中。
5. **带声明核验的类型化交接契约**(§4)——handoff/submit-tag 加类型契约+接收端核验,接 C8/R16 attribution;中。
6. (低)诊断置信度分数(§3,微)、CPOO「不用 LLM 的提示质量门」(§5)、HumanGate 分类清单措辞入 grill-gate(§5)。

## 8. 不借 / 我有他深(明列)

- EXIT 正则刮取作**主**完整性机制——我方 SHA+封存+独立复跑严格更强,勿降级。
- 字节预算作唯一上下文控制——我方耐久多消费者投影+exactly-once 箱更强。
- 内存单进程 Doctor——我方哨兵已覆盖他没有的分布式活性。
- 双脑/设计时 LLM 配置生成、CPOO 全家、工具白名单——编排/安全选择,偏题本面镜四挖,不整合。
- 脱敏闸门——默认 OFF(△),且我方 seal/oneLine 已覆盖信息泄漏面。

已交付协调者 fe0376cd,待裁。
