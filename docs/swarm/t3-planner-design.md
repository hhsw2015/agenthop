# T3 规划器设计:需求→TaskPlan(「晚上交代」的入口)

日期:2026-10-04。状态:**rev2**(round-1:2P1+5P2,报告 t3-planner-review-v1;本版逐条修,标 [R1-x];实施 owner=f32a0507)。
短板定位:Dot 四核心能力对账中唯一缺口——目标自动变计划(接单层)。借鉴 claude-task-master(MIT,评估见 docs/research/task-master-planner-eval.md):**只取其 prompt 资产思想,零代码依赖、零其运行时概念**。

## 0. 边界(防跑偏,先说不做什么)

- **不引入第二任务账本**:无 tasks.json 等**可变**中间文件落盘;规划器产出 = TaskPlan 直接经 loadPlan 校验进 control-log。**无可变草案账本;问询恢复所需的不可变快照按 payloadRef 留存**(内容寻址、钉住即不可写——与 CONTROL 中 digest 身份的不可变事实同类;本边界禁的是第二套可变状态机,不禁钉住的事实)[旧句「草案只存在于单次调用内存」与 Q2b 矛盾,按审查方措辞更正]。
- **不新增执行权**:规划器是「产出耐久事实的又一成员」;派发仍唯一经 dispatcher admission(rev4 R2-P1-3 立场)。
- **不自动开工**:计划装载后,重大计划的 design 节点照 R4 停在对抗审查门;user 的「晚上交代」在装载时即可离场,审查链自转。
- **模型档**:规划=方向性工作,恒 heavy(model-tiering 第 3 条,kind 定下限)。

## 1. 流水线(三段纯函数 + 一个装载点)

```
需求文本(PRD/一句话目标)
  → draftPlan(prompt 资产,LLM 调用):结构化草案{任务,依赖,验证思路,复杂度1-10,风险}
  → translateDraft(draft, frozenContext)(纯函数,零 LLM)[R1-P2-1 接口显式化]:
      frozenContext = 版本化显式输入,全部**不来自模型**:{ checkRegistry, ownerDomainMap+冻结范围/动作政策, roleCatalog, 预算系数+上限, 源基线 digest }
      **持久形状 [Q2a 裁定]**:plan 携带各输入的**版本引用**(digest 寻址),不内联内容(内联会让 registry 文字污染 plan 身份);被引用版本以 digest 寻址的耐久快照留存,loader 往返与重放读到完全相同版本;checkRegistry 的执行语义归 V8 执行器(随其版本化),plan 只带引用。
      **needsClarification 恢复契约 [Q2b 裁定,承载定 (a)]**:复用 R3-b query-wait 状态机;承载=**给 WaitRecord/NewQueryWait 加可选 `payloadRef`(内容寻址 digest 引用)字段**——显式记录优于路径约定(监管链原则:恢复所需引用自带于耐久记录,不靠「由 waitId 可推导」的隐式约定)。payloadRef 指向不可变快照 bundle{原草案+PRD 版本+frozenContext 版本引用}(存储与取回=T3b 的 IO 约定)。字段落 T3a(纯层域,加字段不升版);bundle 存储+重编译编排落 T3b。
      **答复物化与重编译环 [新缝2裁定]**:纯函数确定性 ⇒ 同(D,C) 再跑必然仍 needsClarification——**答复必须物化为新输入版本**:投影函数把答案折进归一化草案得 D'(或新 frozenContext 版本 C'),原快照内容寻址不可改写;重编译=T(D',C)。多问题未齐 ⇒ 保持 needsClarification 不装载(安全默认)。**T3b 契约义务:重编译环铸造确定性 operationId,作用域精确化 [终缝裁定]**——铸号规则:operationId = 稳定命名空间 digest(**planningRequestId**, entityKey, 动作类型, snapshotDigest, canonicalAnswerSetDigest)。五元各有职责:planningRequestId 把 id 钉到具体请求轮次(独立请求复制同 PRD/答复 ⇒ 必不同 id,堵「内容唯一 id」的 op-conflict 冻结陷阱——operations 表是全局的,内容相同 jobId 不同 ⇒ digest 不同 ⇒ 复用 id=冻结非 replay);entityKey+动作类型区分一次 commit 的多条 Change(批内检查不看 operationId,唯一性是调用方硬义务);snapshotDigest+答复集 digest 保同请求同轮恢复 ⇒ 同 id ⇒ 良性 replay。答复集 canonical=按 questionId 排序、只含 CAS 获胜答复。planningRequestId 作为请求身份**穿进 frozenContext/payloadRef**(T3b 可确定性派生);translateDraft(T3a 纯)不铸号。两条既有守卫(默认关闭≠gate grant:isGranted 仅 approval+granted;重复提交=replay no-op)为结构性前提,实施测试钉住。
      输出四类显式分流:loadable(可装载) | rejected{原因} | needsRole{缺失角色描述→接动态容量} | needsClarification{问题清单→R3-b 问询 wait 带默认}——后三类**绝不冒充可派**;
      草案→TaskPlan 节点
      · specDigest = 既有 digest 规则(身份)
      · acceptance[] ← 草案 structuredChecks(经 **checkRegistry 校验** [R1-P1-1]:registry=版本化已知 check 清单+各自 args schema;未知 check/错形 args=显式拒,不静默丢弃也不降级);freeTextNotes→review 节点,且该 review 节点的验收=**必需的、绑定候选版本的 review 证据门**(V8 核对「对本候选版本(SHA/digest 精确绑定)存在 verdict∈{pass, approved-exception} 的 review 结论」——**存在结论不够,必须是通过或有效例外**;同版本 reject 含 P1 的结论=验收失败 [Q1 裁定])
      · roleProfile ← 任务域推断 + roles/ 目录匹配(无匹配→标「需新角色」,接动态容量)
      · modelTier [R1-P2-2+SCORE-DISAGREES 消费规则]:**有效复杂度=max(草案自评, 二评分——若二评执行了);未执行二评则用草案分**(宁贵勿返:分歧永远向上,高分绝不被静默忽略;2+9⇒9⇒heavy);**有效档=max(复杂度映射(有效分), kind 下限, roleProfile 下限)**(1-3=light/4-7=standard/8-10=heavy;design/review kind 下限=heavy);draftPlan/expand 自身恒 heavy,调用方给低档=拒
      · 预算 ← 复杂度分合计×系数(粗量级,CPA 账本接通后换真数)
      · R4 判据机械执行 [R1-P1-2]:四条件的**判定输入全部取自 frozenContext**(owner 域计数→ownerDomainMap;改冻结契约→冻结范围清单;不可逆→动作政策),**不吃模型自产的 covers/域标注**——草案声称的归属仅作提示,翻译层以可信映射重算;映射未覆盖的路径=保守按「跨域」处理非默认低风险 ⇒ 触发 ⇒ 自动前置 design 节点+coveredSpecDigests
  → validatePlan(loadPlan 既有校验,唯一入口):非法整图拒
  → commitControl({put:"plan"}):进事实,板/泳道/调度自动可见
```

## 1b. schema 接缝裁定(实施者预审三条,协调者裁定 2026-10-04;随本稿同批送审)

- **F-T3-1(范围签批)**:T3a **包含**对 task-plan.ts 的三个加法扩展——TaskSpec.modelTier(可选)、节点 role/roleProfile 注解(可选)、TaskKind 增 "design"。依据:「加字段不升版」;kind:design 并非新发明——team-collab §0b R4 条款原文已有「kind 增 design(协议面,待终审)」,本次即其落地,不是暗扩冻结契约。三个扩展随 T3a 窄审一并过审。
- **F-T3-2(身份归类,钉死)**:modelTier 与 role/roleProfile **排除出 specDigest**(它们是角色注解,与 required/runtime/visibility 同类,进 planDigest)——重定档/重配人 ≠ 任务变更,不得触发 V5 级联;**kind 计入 specDigest**(kind 是身份)。验收 D 以此为前提成立。
- **F-T3-3(验收机械化边界)**:草案 schema(plan-draft.json)必须**上游预分流**验收形态:structuredChecks[]({check,args} 可机械化)与 freeTextNotes[](降为 review 节点验收说明)两个字段分开输出;translateDraft 零 LLM、只做确定性搬运与校验,不做自然语言解析。空 structuredChecks 且空 freeTextNotes = 拒(验收 C 语义修正为此)。
- 非阻塞确认:预算走 plan 级 JobBudget.maxModelUsd(复杂度合计×系数,粗量级);R4 门节点 kind 用 "design"。

## 2. prompt 资产(借鉴处,重写不搬运)

参照 task-master 的 8 份模板的**结构思想**(参数化 JSON+版本号),按我们术语重写 3 份进 ~/.agenthop/swarm/prompts/:
- plan-draft.json(≈parse-prd):产草案;输出 schema 即 translateDraft 的输入类型(强 schema,解析失败=草案拒,不容忍自由文本);
- complexity.json(≈analyze-complexity):独立评分步(可对草案逐任务复核,防一次生成的自评偏置);
- expand-node.json(≈expand-task):单节点细化(执行期发现过粗时按需调用,产 subtask 走计划修订既有通道)。
出处注释保留其 MIT 版权声明。

## 3. 验收(可失败,照审查纪律)

- A. 真 PRD 实弹,分两级 [R1-P2-4 诚实拆分]:**A1(本批)=编译层**——产出计划通过「扩展后的 loadPlan」往返(LOAD-ROUNDTRIP 门:§1b 三扩展落地后 loadPlan 接受 kind=design/保留 role/modelTier/coverage 字段);**A2(独立后续门)=真派发**——dispatcher 能派第一个节点(DISPATCH-CAPABILITY 门:prepareDispatch 对带验收节点的派发能力登记后)。两门分列,本批不宣称 A2;
- B. R4 自动触发:构造跨两域需求⇒计划含 design 前置节点,缺覆盖映射⇒整图拒;
- C. 草案劣化防御:LLM 输出缺字段/依赖成环/空验收⇒translateDraft 拒绝并报可读原因(不静默修补);
- D. 身份稳定 [R1-P2-3 收紧]:**同一规范化草案+同一 frozenContext 版本 ⇒ 对等节点 specDigest 一致**(LLM 两次草稿措辞差异不在本验收范围——那是草案层非确定性,translateDraft 自身必须确定);R4 coveredSpecDigests **留在 design 节点 specDigest 内**(排除执行配置 ≠ 排除任务义务,覆盖映射是 design 任务的身份);
- E. 档位映射:复杂度边界值+有效档 max 语义+design 恒 heavy。
- F. 需求覆盖基准 [R1-P2-5]:真 PRD 验收时,对照人工预制的需求覆盖基准(I1-I7 各条:被实现/显式延期/受约束审查三态归类),**独立核对**产出计划的覆盖——不采信模型自填的 covers 字段。
- G. 反例矩阵 [R1-P1-1/P2-1,Q3 对齐原语义]:处置分「拒」与「保守出口」两类,原 18 夹具语义逐条保留不换名——
  · AC-UNKNOWN(未知 check)⇒拒;AC-PROSE(纯文本混入 structured)⇒拒;
  · **AC-OBLIGATION-DROP(原 AC-REMOVAL 本义)**:机械检查保留、困难义务(notes 侧)被静默丢弃⇒拒(义务不随难度蒸发);AC-REGISTRY-DOWNGRADE(registry 降版致旧 check 失效)⇒拒并指认失效项——两条都要,互不替代;
  · R4-OWNER-SPOOF(伪造归属)⇒重算后按真实归属处置;R4-FROZEN(改冻结标低风险)⇒强制触发 design 门;
  · **R4 风险模型 [Q3 精确化,终裁 2026-10-04]:两正交轴+三态风险**。风险轴来自可信 riskPolicy{irreversiblePrefixes, undecidablePrefixes, version}(frozenContext 一员):默认 reversible(R3:可撤是自主默认);命中 irreversiblePrefixes=irreversible(已知不可逆);命中 undecidablePrefixes 或节点显式标记=unknown(风险不可判——unknown 是独立三态值,不被并入任何一边,F17 同源)。决策表:
    design 触发(任一):≥2 已知域 / 改冻结 / 超阈值(留白显式标注) / **风险=irreversible(已知不可逆→门,不是澄清)** / unknown-owner 且风险≠unknown(保守门) / **风险=unknown 且非关键路径**(门能吸收的不确定性不问人);
    **criticalPath 信任边界 [终裁]**:criticalPath 是**受信的请求者声明**——T3a 无独立 criticality 真值源,loader 据声明强制决定(critical∧unknown→拒载)但不校验声明真值。安全论证(不对称性,采实施者分析):声明偏低只把「问人」降为「插门」(门吸收,仍安全);声明偏高只多问一次——两个方向都无危险绕过,所以信任声明是正确边界(对照:owner/风险政策不信模型,因其伪造有危险绕过;criticality 伪造无)。未来有可信 criticality 源时在 managed 入口核对,接缝已留。四不变量(bool 校验往返/false 装载 true 拒载/翻标记只动 planDigest/更强业务验收须进 acceptance 不藏排除字段)确认。
**criticalPath 持久化 [复验期裁定]**:TaskSpec 增 `criticalPath?: boolean`(注解类,**排除出 specDigest**,进 planDigest——criticality 是调度/监管属性非任务身份,同 modelTier/roleProfile);translateDraft 从草案写入节点。**managed loadPlan 独立复核不变量**:可装载计划中不得存在 criticalPath=true 且 scope 命中 undecidablePrefixes 的节点(那本应 needsClarification,出现即拒载);critical∧unknown 只有经澄清把风险定为非 unknown 后才可装载——loader 不信上游,按留存字段自核。
    needsClarification:**风险=unknown 且在关键路径**——判据:澄清是「请求者知道而规划器不知道」的信息问题(这事到底可不可逆?),门是「需要专家判断」的审查问题;不确定性本身要请求者解答且代价高(关键路径)时才问,否则门吸收。与 owner 已知与否无关;
    reject 只留结构非法。

## 4. 实施拆分(owner f32a0507,全纯层域)

- T3a:translateDraft 纯函数+类型+§1b 三扩展+loadPlan 往返扩展(LOAD-ROUNDTRIP)+C/D/E/G 验收(零 LLM,TDD 全测);
- T3b:三份 prompt 资产+draftPlan 封装+A1/B/F 实弹;A2(真派发)=独立后续门,随 prepareDispatch 能力登记批。
- 送审:T3a 可先行窄审;T3b 带实弹证据合审。
