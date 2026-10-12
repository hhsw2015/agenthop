# coordinator-skill 简报 — 协调者技能化(设计·冻结候选 r2)

owner aad02248 · 协调者 fe0376cd 派单(user 亲令,方向性大件)· 审查席 happycapy · base main @a1a933d · 状态:**纯文档设计件,r2 修齐 happycapy 首审 4P2+nit 后待复审**

## 缘起(user 原话)

> 开发其他项目时在不同目录 / 不同 session,需要那个 session 充当协调者角色——把协调者技能写成 skill 文件,新 session 加载即知如何协调日常事务。

即:**协调者不再是某个具体 session 的默契,而是一份可移植的「操作手册」**。本件是设计先行(铁律 7);brief 冻结后才落 skill 正文,草稿见同目录 `coordinator-skill-DRAFT.md`。

## 设计原则(从 CORE.md 提炼,不另立体系)

1. **协调者 = 个人助理 = user 与公司之间唯一的人格化接口**(CORE 单一接口 / S21 单线宪法)。向上只送三样(该裁 / 该验 / 主动问),向下把 user 一句话翻成工单/契约/裁定。
2. **操作手册,不是流水账**(dispatch 明令)。正文是可执行例程 + 常设门引用;判例留律典,按号引用,`rulings` CLI 检索(§律典解析契约)。
3. **参数化 + 诚实范围**(可移植的前提,R4 本体论检查)。正文不绑死具体 session/路径/机器;但**未实现的能力写成前置依赖,不把填参等同隔离**(见「支持的运行模式」)。
4. **代行有账**(CORE 代理权):user 离场期协调者代行**可撤**决策(判据见 CORE 代理权节),不可逆挂 approval-wait,每笔进晨间追认单。

## 参数化契约(加载技能后注入;每参标注「真实入口」)

| 参数 | 含义 | 真实运行入口(已对源码核验) |
|---|---|---|
| `COORD_SID` | 协调者稳定总线身份 + 当前壳 | 本 session bus id(`agenthop_peers`);换壳继任见 F45 |
| `DATA_ROOT` | 蜂群数据面根 | **`AH_HOME` ?? homedir(),再追加 `.agenthop`**(`scripts/swarm-dispatch.ts:88`)。`SWARM_DATA_ROOT` **尚非入口**——仅 CORE 解耦审计的延期项(CORE.md:68-69),v1 不依赖 |
| `PROJECT_ROOT` | 被协调工作区根(仓+契约集+产物域) | 仅作**派单/契约上下文**;**今日非数据面分区键**——投影/板/console 路径恒为 `AH_HOME/.agenthop/swarm/...`(`console-projection-store.ts:40`),不含 PROJECT_ROOT(CORE 开放项「项目↔蜂群」) |
| `REVIEW_SEAT` | 本工作区指定审查席 | 项目私有(happycapy / codex:Work / …) |
| `RULINGS` | 共享律典位置 | `rulings` CLI 读 **`AGENTHOP_RULINGS_DIR`**,否则脚本所在仓 `<repo>/docs/swarm/rulings`(`scripts/rulings.ts:108`)——**CLI 不读 `RULINGS` 参数**;空白项目无内置律典(见「律典解析契约」) |

## 支持的运行模式 与 前置依赖(CS-P2-1:诚实范围,不把填参等同隔离)

- **v1 诚实范围 = 单数据面、单协调者/机**:一个 `AH_HOME` 对应一套 `.agenthop/`(收件箱/板/control-log/投影)。技能令一个 session 成为**该 AH_HOME** 的协调者。
- **真正的多项目隔离 = 前置依赖(未实现,不在本件实现)**,挂两条 CORE 开放解耦:
  - **项目↔蜂群**:PROJECT_ROOT 成为 job 一等参数(workspace 根+仓+契约集随 job 走);投影/板路径按项目分区。归 T3b/规划器。
  - **数据面↔主目录**:`SWARM_DATA_ROOT` 成为单一可配根(一次 sed 级改造,宜 L2 后跨机前)。
- **过渡期做法**:要并行协调两个项目 ⇒ 两个 `AH_HOME`(各一套数据面),各起一个协调者 session;**不要**指望单 `AH_HOME` 内按 PROJECT_ROOT 自动隔离(今日不成立)。技能加载检查应断言 `AH_HOME` 已设且 `.agenthop/` 可写。

## 律典解析契约(CS-P2-2:可移植、无歧义)

### 位置分离(共享法 vs 项目裁定)

- **共享法**(可移植,随技能装):`CORE.md` + 结构化 `rulings/` 账本 + runbooks。装到一个已知共享位置,`export AGENTHOP_RULINGS_DIR=<该位置>/docs/swarm/rulings`。
- **项目裁定**(项目私有):该工作区自有的 R/S/F(若有),单独目录;不与共享法混。
- **空白项目无默认律典**:`rulings` 在陌生目录会退回脚本所在仓或报错——故**安装资产清单必须含** CORE.md + rulings/ + runbooks,且**加载检查**先验证 `rulings S29` 能解析,再依赖任何引用。

### 编号命名空间(区分 + 显式映射)

| 命名空间 | 覆盖 | 解析 |
|---|---|---|
| 结构化账本 | R/S 全系 + F21 起 | `rulings <id>`(CLI) |
| CORE/F-ledger | FC 族(FC-2/6/7)、F8/F13/F16-F22、F49/F50/F53、R3-b、R4 | 查 `CORE.md` 铁律节 + `coordinator-ops-succession-runbook.md`(F53);`rulings <id>` 可能退出 2 |

**同号碰撞警告(实测)**:结构化账本 **R3 = 凭证收窄**(`--init` 非敏感+secret);而 CORE 代理权节的 **「R3 判据」指可撤性**——**同号不同义**。故「可撤才代行」须引 **CORE 代理权节**,不得引账本 R3。`R4`(本体论检查)、`R3-b`(问询带默认)亦属 CORE 命名空间,非结构化账本。按「存在且含义相符」核验,不按裸号存在性。

---

## ① 技能正文结构(operations manual — 七节,内容在 DRAFT)

### A. 自唤醒扫箱例程(the loop,durable-first 交棒)

触发 = 唤醒 ping(F50)/ sweep / boot。关键契约(CS-P2-3 修订):
1. 扫 `DATA_ROOT/inbox/<COORD_SID>/`,逐封按序处理(claim→处理)。
2. **先形成可恢复的交棒义务,再签收**(durable-first;CORE 铁律 2:推进责任任何时刻有耐久持有者):处理一封 → 把「下一棒」耐久落盘(新派单信入目标箱 / task-log / control-log 一条)→ **再** ack 消费件。
3. **ack 仅删认领文件**(`inbox.ts:385`,**无 processed 归档**)——故不可「ack 后再派」:ack 与派单间崩溃会丢义务。此前稿「ack 落 processed」是误述,已删。
4. **恢复入口**:boot/sweep 扫未完成 baton(task-log PENDING / 未投递的下一棒),从中段续。
5. **唯一操作键 = 单调序**(control-log 显式转换 / task-log updatedAt),**非 taskRef**(taskRef 只关联、不证先后;FC-6 要单调序)。exactly-once 收窄为「claim→ack 认领语义 + 下一棒 durable-first」,不声称全链 exactly-once。
6. 耐久优先(S31 / S18);孤儿按内容重批(S19 / decision-batch);空等即补机制(铁律 6 / F25)。

### B. 派单纪律(dispatch)

- **S14** 全字段派单契约(字段齐=对方零澄清可做)· **S30** user 已裁注原话。
- **S29** 单轮对话效率「一单两信」= **派单一信 + 交付一信**(单轮不碎,别把一次对话拆成多信)。
- **S26** 抄送精简 = **收件人分工**:判决/交付**全文只直投一方**(修复方/任务归属方);**抄协调者一律摘要件 ≤15 行**(固定 SHA / 计数 / CLOSED 清单 / REMAIN 清单 / 门槛类型 / 报告路径+SHA256 / 下一步归谁),依据 S18。**(修正:全文/摘要分投是 S26,非 S29)**
- **S27** 消息减肥+审查批量 · **S28 / S28-b** 产出定长先行 + 三件套(adhd+ste100+stcn100)。
- **R21 / R21-b** 公司拓扑:原生优先、总线跨族、协调者不中转、非全连通;**R18** 分层调度。**R11** 在途交叉范围答复带裁定号。

### C. 审查席协议(review-seat)

一轮回 **P1/P2/P3 计数 + N REMAIN + 固定 SHA**;审查门**持到 0 REMAIN** 才签收;执行方每轮换新 SHA 复提。对抗审查;**R13** 失实重于缺陷。**F46** 投对箱(thread-id 非 run-id)。审查席=`REVIEW_SEAT`,忙/mod 排队,耐久箱候其空闲自然浮出。

### D. 合并门(merge-gate)

排练 → 测 → 架构审 → 0 CONFIRMED → 落地(batch-N:rehearse-batch → 装机 → dispatcher 重启 → board=done)。合入/推送归协调者(执行方不并不推);**休眠接缝的启用=user 裁决**(enable-gate=user)。铁律 7。

### E. 巡检 / 存活(patrol / liveness)

**F39** 巡检缺位=缺陷 · **F49** 池检 · **F50** 唤醒 ping · **F25** 空等 · **F45** 换壳继任(新壳首动 `agenthop install --mcp <kind>`)+ **F53** 操作回执(耐久证据判成,非 API 瞬时返回)+ 继任心跳(见 runbook)。

### F. 常设门(standing gates)

- **FC-6** 无时钟/latest-wins(显式转换,单调序)· **FC-2 r3** 读错=unknown,永不断言否定。
- **FC-7** 可选字段 + 旧记录容忍 **+ 存储格式变更须带旧数据兼容导入(迁移义务,非仅容忍)**(CS-P2-4 修订,门原文在证据目录)。
- **到期默认的边界**(CORE 铁律 8 复原):问询带默认、到期按默认,**但到期默认仅限已授权的非门控选择;真实门控(三类裁决本体)才裸等 user,绝不由到期推导出缺失的批准**(R3-b)。
- **R16 / R16-b** user 授权链 · **R17** 代行=以 user 名义实施非冒充 · 授权留 C8 cap,可追溯/核验标签永不被授权路径读取。铁律九条见 DRAFT §6。

### G. 律典检索入口(rulings CLI)

```
rulings <id>                 # 单条全文(结构化账本号)
rulings list [--series R|S|F] [--status active|superseded]
rulings grep <word>          # statement 含词
```

正文只留可移植的法(号),判例正文在律典,按号解析。命名空间与同号碰撞见上「律典解析契约」。

---

## ② 共通 vs 项目隔离 分界表

| 层 | 共通(随技能走) | 项目私有(随工作区) |
|---|---|---|
| 二进制/工具 | agenthop 二进制、总线、herdr、旗默认 | — |
| 法 | FC 族 + 结构化 R/S/F 账本 + CORE + runbooks(装到 `AGENTHOP_RULINGS_DIR`) | 项目特有裁定(单独目录) |
| 技能 | **协调者技能本体** | — |
| 进度/状态 | — | `PROGRESS.md`、`board/`、`control-log/`、投影(数据面 `AH_HOME/.agenthop/swarm/`) |
| 名册/角色 | roleProfile **schema** | 实际 roster / 席位 / 板条目 |
| 证据 | review-report **格式** | `review-reports/` 内容(`~/Work`) |

一句话:**共通 = 法 + 工具 + 技能本体;项目私有 = 事实 + 状态 + 人 + 证据**。注:今日「项目私有」的物理隔离靠**独立 AH_HOME**,非单 AH_HOME 内按 PROJECT_ROOT 分区(见「支持的运行模式」)。

---

## ③ 落点格式(两案并陈,user 裁)

### 案 A:仓内 `skill/SKILL.md` 双语,随二进制走
- **利**:每 install 自带;双语惯例现成;与产品同版本化。
- **弊**:协调纪律技能耦合进 agenthop 产品发布周期(产品技能讲配对/中继,混关注点);增大二进制;改一句要 rebuild+发版。

### 案 B:`~/.claude/skills/` 用户技能
- **利**:**任何 session/目录加载**(正中所求);与发布解耦;改文案免 rebuild;可 `/coordinator` 入口。
- **弊**:不随二进制分发(每机单装);非双语编译;活仓外。

### 建议(user 裁)
**案 B** 更贴所求。折中:真相源冻结仓内 `docs/swarm/`(本 brief + DRAFT),安装产物拷到 `~/.claude/skills/coordinator/` + 随附安装资产清单(CORE.md + rulings/ + runbooks + 加载检查)。取案 A 则 DRAFT 按英文 SKILL.md + zh-CN 双语拆分(`build-release.mjs` 契约)。

---

## r2 修订(happycapy 首审 4P2+nit · 摘要↔原文对表)

| 项 | 首审发现 | 修订 |
|---|---|---|
| CS-P2-1 | 五参未绑真实数据面,填参≠隔离 | 参数表标真实入口(AH_HOME,非 SWARM_DATA_ROOT;PROJECT_ROOT 非分区键);新增「支持的运行模式/前置依赖」把多项目隔离写成前置依赖,v1 收窄为单 AH_HOME |
| CS-P2-2 | 律典依赖无可移植解析契约;R3 同号异义;R4/R3-b 漏源 | 新增「律典解析契约」:位置分离 + 安装清单 + 加载检查 + 命名空间表 + **R3 同号碰撞警告**(可撤引 CORE 代理权节非账本 R3)+ R4/R3-b 标 CORE 命名空间 |
| CS-P2-3 | ack 后交棒、无 processed、恢复/定序不足 | §A 改 **durable-first**:先耐久落下一棒义务再 ack;删「processed」(ack 仅 unlink);恢复入口=扫未完成 baton;唯一键=单调序非 taskRef |
| CS-P2-4 | S29↔S26 混;删了「真实门控才裸等」;FC-7 漏迁移义务 | §B 分清 S29(一单两信/不碎)vs **S26(全文/≤15 行摘要分投)**;§F 复原「真实门控才裸等 + 到期默认仅限已授权非门控」;FC-7 补「格式变更带兼容导入」 |
| CS-N1 | attribution/spend-breaker/output-contract 称默认 OFF 已过期 | DRAFT §4 改为「启用=user 裁决」原则 + 显式注:具体旗默认随部署演进(batch-14 已翻默认 ON,TG_ENTRY 守 opt-in),按部署版本+接线状态核对 |

## 自检

- **本体论检查(R4)**:五参全标真实入口 + 未实现项显式降为前置依赖。
- **引用核验**:结构化号(R/S + F21起)已核;CORE 命名空间号(FC 族/F49/F50/F53/R3-b/R4)+ R3 同号碰撞已标注。
- **范围**:纯文档,不动码、不碰 OpenDots 三门、不并不推。brief 冻结投协调者;审查席 happycapy。无需先实现缺失后端——多项目隔离/数据面改造均列为前置依赖。
