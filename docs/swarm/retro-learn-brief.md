# retro-learn — 复盘·教训生产命令环 (设计先行 brief)

owner=90b58f9c · off main @a2e8d84 · **冻结席=协调者**(本件不占审查席;判回优先打断) · 吸收④(gstack /retro+/learn 镜十六头号借之一 ∩ polydao「周期 meta-review」镜十四,同题合流)。本件**设计先行**:brief 冻结后代码另单。

北极星:我方有**完整记录面**(PROGRESS.md / docs/swarm/rulings/ / ~/Work/review-reports/ / control-log),缺的是**从记录生成教训**的生产命令 —— 「一段时间内我们在哪里反复跌倒」没人自动汇总,全靠人翻。

---

## §0 诚实现状(先划已有 vs 缺口)

**已有(只读源,本件消费不新增):**
- **PROGRESS.md**(`~/.agenthop/swarm/`,~420K):批次标记(`## <日期>`、`批-N`)、done-claim 带 SHA、审查判词(`0 REMAIN` / `2P1` / `返修 r2`)、复盘叙事。**半结构化 markdown**(可行号引用,不可可靠 AST 解析)。
- **docs/swarm/rulings/\*.json**:已签裁定簿,`Ruling{id,series(R|S|F),title,statement,status,rationale?,supersedes?,relates?,sources?,since?,by?}`(ruling-ledger.ts,`loadLedger` 已签)。learn 面的草稿产物就是这个形状的**生坯**。
- **~/Work/review-reports/\<ticket>-\<sha>-review-\*/**:每轮审查证据目录。**目录名编码 ticket+sha+轮次**(例 `approval-v1-3a384b8` / `approval-v1-7a0a3fa` / `approval-v1-a23e629` = approval-v1 三轮)⇒**返修轮数分布的结构化信号**。
- **control-log/**(`~/.agenthop/swarm/control-log/`):attempt 历史(RUNNING/RPV/SUCCEEDED/ABANDONED+failureClass+retriesUsed,control-log.ts `replayLog`/`liveEntities`)⇒**结构化返修/失败信号**。
- 次源:worklog.jsonl、decision-batch consumed.json。

**缺口=本件:** 没有「读记录→产教训」的命令。gstack `/retro`+`/learn`(镜十六)与 polydao 周期 meta-review(镜十四)指向同一件。

**与 morning-digest 的分界(③,关键)**:digest=**昨夜发生了什么**(面向 user 验收,日频,console 投影);retro=**一段时间内蜂群在哪里反复跌倒**(面向蜂群改进,周频/批频,协调者箱草稿)。两产物、两节奏、两受众——**不复用 digest 的投影面,复用它的生产骨架**(纯核+store+sweep+durable-first 投递+旗+节流,见 [[swarm-digest-wiring]])。

---

## §1 目标

两个**只读**生产命令:
- **retro**:输入=时间窗(`--since <日期>` / `--days N`)或批次号(`--batch N`),从记录面提取三类教训信号(返修轮数分布 / 重复病灶 / 流程缺口),产出=**复盘报告草稿投协调者箱**(绝不自动入 PROGRESS)。
- **learn**:复盘报告里「可判例化」条目→草拟 **ruling JSON 生坯**(写 staging,**协调者签后才入 rulings/ 簿**)。

硬界(④,polydao loop-edits-loop 红线):**全只读分析+草稿投箱,绝不自动改 PROGRESS/rulings/任何状态**——绝不无外部复核自编辑。证据诚实(⑤):**每条教训带源引用**(PROGRESS 行号 / 审查目录名 / control-log attempt id)。

---

## §2 五件(对应协调者 ①②③④⑤)

### ① retro 面(复盘报告草稿)

输入=窗口(`--since`/`--days`)或 `--batch N`。扫三类信号,**结构化源优先,prose 源作行引 HINT**:

- **返修轮数分布**:按 ticket 聚合 `review-reports/<ticket>-<sha>-...` 目录名(同 ticket 多 sha = 多轮)+ PROGRESS 的 `返修 rN`/`N REMAIN`/`SIGNED` 判词(行引)。产出:每 ticket 轮数、窗口内中位/最大轮数、「一次过 vs 多轮」比。
- **重复病灶**:窗口内跨 ticket **复发的缺陷类目**聚类。**结构化优先**=control-log `failureClass` 计数;**HINT**=审查报告/PROGRESS 文本里复发短语的词频(例:本周三连「读错空集」=idle-explainer/model-staffing/TG 同型 FC-2 读错⇒跨件模式)。每簇带**命中源清单**(文件:行 / 目录),标「结构化」或「启发式(待人核)」。
- **流程缺口**:门漏网事件(例:`tsc 红出门`=门没拦住;`装机后 grep 教训`;`吞错继续`)。从 PROGRESS 的事故叙事 + rulings 的 F 系列(每条 F 本就是一次事故的根治)行引提取,标「候补新门?」。

产出=**retro 报告草稿**(markdown + 一份结构化 JSON 侧档),投**协调者 inbox**(durable-first,like digest 的 .pubcred 幂等,键 `retro-<窗口标识>`)。**绝不自动入 PROGRESS**——人审后由协调者决定是否收录。

### ② learn 面(ruling 生坯)

复盘报告里标了「可判例化」的条目(重复病灶/流程缺口中够格成规矩的)→ 草拟 **Ruling JSON 生坯**:填 `title`/`statement`/`rationale`/`sources`(命中源),**但 `id` 留空或建议下一序号、`status` 不置签**。写 **staging**(非 rulings/ 活簿),协调者审+派 id+签后才移入 rulings/。

**生坯去重**:草拟前经 `loadLedger` 读现簿,若该病灶已有活跃 ruling(statement/sources 近似)⇒不重拟,改在报告标「已有 \<id> 覆盖」(证据诚实,不刷重复生坯)。

### ③ 与 morning-digest 分界(契约)

| | morning-digest | retro-learn |
|---|---|---|
| 问题 | 昨夜发生了什么 | 一段时间内哪里反复跌倒 |
| 受众 | user(验收) | 蜂群/协调者(改进) |
| 节奏 | 日频 | 周频 / 批频 |
| 产物 | console 投影(user 读) | 协调者箱草稿(人审后入) |
| 写面 | console/morning-digest/ | 协调者 inbox + staging 草稿 |

retro **复用 digest 生产骨架**(纯核+store+sweep+durable-first+旗+节流),**不碰 digest 的投影**。

### ④ 硬界(polydao 红线)

- **全只读**:只读 PROGRESS/rulings/review-reports/control-log;**绝不写** PROGRESS、**绝不写** rulings/ 活簿、**绝不改**任何运行态。
- 唯一副作用=**投协调者箱**(草稿)+**写 staging 草稿文件**(非活簿)。
- **绝不无外部复核自编辑**:生坯是草稿,协调者签是唯一入簿路径。retro 报告是草稿,人审是唯一入 PROGRESS 路径。

### ⑤ 证据诚实

- 每条教训带**源引用**(`PROGRESS.md:<行>` / `review-reports/<dir>` / control-log attempt id / ruling id)。
- **结构化 vs 启发式分层标注**:control-log failureClass/目录名轮数=结构化(可信);PROGRESS/报告文本词频=启发式(标「待人核」,绝不当定论)。
- **PROGRESS 半结构化诚实**:retro 对 PROGRESS 做**行引 grep 启发**,不声称可靠 AST 解析;结论强度取决于结构化源,prose 只作 HINT。

---

## §3 FC-2 / CP 纪律(触只读分析+草稿投递,新零-bug 夹具律适用)

- **源读三态**:一个源目录/文件不可读(EACCES)⇒该信号标 `unknown`(不当「无病灶」——缺证据≠健康);ENOENT(无该源)⇒该信号空但诚实标「源缺」。绝不把读失败折成「一切正常」。
- **草稿投递 exactly-once**:协调者箱投递走 durable-first(.pubcred 幂等键 `retro-<窗口>`,like digest),重跑同窗口不重投。
- **CP-3**:staging 草稿写走原子+祖先链边界守(复用本周 CP-3 整链法)。
- **只读不可变**:retro 对所有源**只 readFileSync/readdirSync**,零写入源面(单测断言零源面 mutation)。
- **三类零-bug 夹具**:crash-recovery(报告生成中断⇒重跑干净,草稿原子)/restart-idempotency(同窗口重跑⇒同报告+不重投协调者)/concurrency-race(两 retro 并发⇒durable-first 键去重,草稿原子写)。

---

## §4 数据源映射(每源产什么,诚实标强度)

| 源 | 读法 | 产信号 | 强度 |
|---|---|---|---|
| review-reports/ 目录名 | readdir + 解析 `<ticket>-<sha>-...` | 返修轮数分布(同 ticket 多 sha) | 结构化 |
| control-log/ | `replayLog`/attempt 历史 | failureClass 计数、retriesUsed、ABANDONED 率 | 结构化 |
| rulings/\*.json | `loadLedger` | 现有覆盖(去重生坯)、F 系列事故史 | 结构化 |
| PROGRESS.md | 行引 grep 启发 | 判词(REMAIN/返修 rN/SIGNED)、事故叙事、流程缺口 | 启发式(行引,待人核) |
| worklog.jsonl / decision-batch | 只读 | 次源(产出节奏、决策量) | 结构化(次要) |

---

## §5 实现形态(设计 only,供 FROZEN→code 轮)

- **`packages/bus/src/swarm/retro-learn.ts`(纯核)**:信号提取纯函数(parseReviewRoundDist(dirNames)、clusterAilments(failureClasses, textHints)、extractProcessGaps(progressLines))+ retro 报告构造(markdown+JSON 侧档)+ learn 生坯构造(lesson→Ruling 生坯,id 空/status 未签)+ 去重(vs loadLedger)+ `retroEnabled`(SWARM_RETRO flagDefaultOn,见下 Q)+ 窗口/批次节流。selftest + 三类零-bug 夹具。
- **`packages/bus/src/swarm/retro-learn-store.ts`(IO)**:只读源读取(review-reports readdir / control-log loadControlLog / rulings loadLedger / PROGRESS 行引 grep,各 FC-2 三态)+ staging 草稿原子写(CP-3 祖先链)+ 协调者箱 durable-first 投递(复用 inbox writeInbox+publishOnce)。
- **`scripts/swarm-retro.ts`(薄壳)** 或 dispatcher sweep 接线:`--since/--days/--batch` 手动 + 可选周频/批频 sweep(节流)。**默认手动**(Q:是否挂 sweep 自动周频)。
- **staging 位置**(Q1 头号):`console/retro-drafts/`(与活簿 rulings/ 物理隔离,协调者签=移入+派 id);**不写 rulings/ 活簿**(④ 红线;若写 rulings/ 需 loadLedger 能拒未签生坯=脆,故荐独立 staging)。

---

## §6 开放项(请协调者裁)

- **Q1(头号)生坯 staging 位置**:荐 `console/retro-drafts/`(与 rulings/ 活簿物理隔离,loadLedger 永不误收;协调者签=移入+派 id)。替=写 rulings/ 但 status:"draft" 让 loadLedger 拒(脆,依赖拒绝逻辑)。请裁。
- **Q2 节奏**:retro 默认**手动**(`--since/--batch`)还是挂 sweep 自动**周频/批频**?荐:手动 + 可选 sweep(SWARM_RETRO flag),批频触发点=并库事件(批-N 完成时自动产该批 retro 草稿)。
- **Q3 重复病灶聚类强度**:v1 仅**结构化**(control-log failureClass + 返修轮数)+ prose 词频**作 HINT 标待人核**,还是 v1 就要文本语义聚类?荐:v1 结构化为主+词频 HINT(语义聚类留 v2,避免启发式当定论)。
- **Q4 flag 默认**:SWARM_RETRO flagDefaultOn 默认开(只读+草稿投箱零风险,like digest)还是保守 OFF?荐:默认开(zero-risk 只读;投递是草稿非状态改)。
- **Q5 learn 生坯的 id 建议**:生坯是否预填「建议下一序号」(读 loadLedger 现有 max+1 per series)还是全留空由协调者派?荐:预填**建议**序号(协调者可改),省协调者一步。
- **Q6 窗口默认**:无参时默认窗口=`--days 7`(周频)还是「上次 retro 以来」(需记录上次 retro 水位)?荐:默认 7 天 + 可选水位记录(staging 存 last-retro 标记,下次默认增量)。

---

姊妹件:[[swarm-digest-wiring]](复用生产骨架,分界见 ③)/[[swarm-ruling-ledger]]+rulings-cli(learn 生坯目标形状 Ruling{})/[[swarm-idle-explainer]](北极星差距审计同族,retro 是其周频对应)/镜十四 polydao(周期 meta-review+loop-edits-loop 红线)/镜十六 gstack(/retro+/learn 借鉴源)。

**STOP 候协调者冻结或返修。**
