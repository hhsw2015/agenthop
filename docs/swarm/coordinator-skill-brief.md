# coordinator-skill 简报 — 协调者技能化(设计·冻结候选 r3)

owner aad02248 · 协调者 fe0376cd 派单(user 亲令,方向性大件)· 审查席 happycapy · base main @a1a933d · 状态:**设计全签 @ade8be9(CS-P2-1/2/3/4 + N1 全 CLOSED);r5 并入 §8 新项目开张流程(user 完整图景);待 user 裁 A/B 落点后制作技能产物**

## 缘起(user 原话)

> 开发其他项目时在不同目录 / 不同 session,需要那个 session 充当协调者角色——把协调者技能写成 skill 文件,新 session 加载即知如何协调日常事务。

即:**协调者不再是某个具体 session 的默契,而是一份可移植的「操作手册」**。设计先行(铁律 7);brief 冻结后才落 skill 正文,草稿见同目录 `coordinator-skill-DRAFT.md`。

## 设计原则(从 CORE.md 提炼,不另立体系)

1. **协调者 = 个人助理 = user 与公司之间唯一的人格化接口**(CORE 单一接口 / S21)。向上只送三样(该裁 / 该验 / 主动问),向下把 user 一句话翻成工单/契约/裁定。
2. **操作手册,不是流水账**。正文是可执行例程 + 常设门引用;结构化判例按号引用(`rulings` CLI),**无律典来源的条款内嵌最小定义或按功能描述**(见律典解析契约)。
3. **参数化 + 诚实范围**(R4 本体论检查)。正文不绑死具体 session/路径/机器;**未实现的能力写成前置依赖,不把填参等同隔离**。
4. **代行有账**(CORE 代理权):代行**可撤**决策(判据见 CORE 代理权节),不可逆挂 approval-wait,每笔进晨间追认单。

## 参数化契约(加载后注入;每参标注已核验的真实入口)

| 参数 | 含义 | 真实运行入口(对源码核验) |
|---|---|---|
| `COORD_SID` | 协调者稳定总线身份 + 当前壳 | 本 session bus id(`agenthop_peers`);换壳继任见 F45 |
| `AH_HOME` | 蜂群数据面的**家目录** | 家目录(默认 `homedir()`);**数据面 = `$AH_HOME/.agenthop`**(dispatcher `AH_HOME ?? homedir()` 再 +`.agenthop`,`swarm-dispatch.ts:88`)。**注:总线 `core.ts:84` 取 `options.home ?? homedir()`,不读 AH_HOME**;`SWARM_DATA_ROOT` 非入口(CORE 延期项) |
| `PROJECT_ROOT` | 工作区根(仓+契约集+产物域) | 仅**派单/契约上下文**;**今日非数据面分区键**(投影/板路径恒 `$AH_HOME/.agenthop/swarm/...`,`console-projection-store.ts:40`,不含它) |
| `REVIEW_SEAT` | 本工作区指定审查席 | 项目私有(happycapy / codex:Work / …) |
| `RULINGS` | 共享律典位置 | `rulings` CLI 读 **`AGENTHOP_RULINGS_DIR`** 否则脚本所在仓(`rulings.ts:108`)——**CLI 不读本参**;空白项目无内置律典(见律典解析契约) |

## 支持的运行模式 与 前置依赖(CS-P2-1:诚实范围,填参≠隔离)

- **v1 确认范围 = 单数据面 = `homedir()/.agenthop`**:AH_HOME 未设时,总线的 `homedir()` 默认与 dispatcher 的 `AH_HOME ?? homedir()` 默认**重合于此**——这是各入口今日都认的唯一根。技能令一个 session 成为**该根**的协调者。
- **加载检查**(启动前断言,CS-P2-1 双追加 bug 已修):`$AH_HOME/.agenthop/` 可写(**追加 `.agenthop` 恰一次**)+ 技能实际引用的结构化号可解析(见律典解析契约)。
- **多项目/多根隔离 = 前置依赖(未实现,不在本件实现)**:
  - **各入口根统一**:今日**总线 `core.ts:84` 不读 AH_HOME**(取 `options.home ?? homedir()`),故**仅设两个 AH_HOME 不隔离总线**——需总线(显式 `options.home`)、presence、dispatcher **同读一个可配根**。前稿「两 AH_HOME 各起协调者即隔离」claim **撤回**。
  - **CORE 两解耦**:项目↔蜂群(PROJECT_ROOT 成 job 一等参数、路径按项目分区)+ 数据面↔主目录(`SWARM_DATA_ROOT` 单一可配根)。归 T3b / L2 后跨机前。
- 在上述前置满足前,**v1 只承诺单根单协调者**,不承诺多项目隔离。

## 律典解析契约(CS-P2-2:可分发、无歧义、来源逐号可定位)

### 安装资产清单(空白项目需装齐,否则停止依赖缺源条款)

| 资产 | 覆盖的号 | 来源 |
|---|---|---|
| 结构化 `rulings/` 账本 | R/S 全系 + F21 起(含 F25/F39/F45/F46) | `AGENTHOP_RULINGS_DIR`,`rulings <id>` 解析 |
| `CORE.md` | 铁律族(F8/F13/F16-F22)、R4(本体论检查)、R3-b(铁律 8)、R3 同号碰撞(代理权节) | CORE.md 对应节 |
| succession runbook | F53(操作回执/继任) | `coordinator-ops-succession-runbook.md` |
| **技能内嵌最小定义** | **FC 族(FC-2 r3 / FC-6 / FC-7)** | 无律典条目——**内嵌自足**,源注 `output-contract.md` §Self-check(FC-2 r3/FC-6/FC-7 实证)+ `attribution-chain.md`(FC-7 读侧)。技能不依赖外部解析 FC |
| **无来源,仅功能描述** | **F49(池检)/ F50(唤醒 ping)** | **无律典条目、CLI 退出 2**——按功能描述(定期池检 / 对停滞成员唤醒 ping),编号**待 ruling-backfill 确立**;**不入加载检查、不作可解析号引用** |

**加载检查收紧**:验证技能**实际引用的结构化号**均解析(非仅 `rulings S29`);FC 族自带(内嵌);**不依赖 F49/F50 解析**。

### 位置分离 + 同号碰撞

- **共享法**(可移植)vs **项目裁定**(项目私有)分目录,不混。
- **同号碰撞(实测)**:结构化账本 **R3 = 凭证收窄**;CORE 代理权「R3 判据」= **可撤性**——**同号不同义**。可撤代行引 **CORE 代理权节**,不引账本 R3。`R4`/`R3-b` 属 CORE 命名空间。按「存在且含义相符」核验,非裸号存在性。

---

## ① 技能正文结构(operations manual — 七节,内容在 DRAFT)

### A. 自唤醒扫箱例程(the loop — durable-first,单调序,投递证据)

触发 = 唤醒 ping / sweep / boot。关键契约(CS-P2-3 修订):
1. 扫 `$AH_HOME/.agenthop/inbox/<COORD_SID>/`,逐封按序处理(claim→处理)。
2. **先形成可恢复的交棒义务,再签收**(durable-first;铁律 2)。交棒耐久记录 = **四件分离**:
   - **业务关联标识**(taskId / launchId):关联业务对象;**不可直接当作 `Change.operationId`**。
   - **每转换操作 ID**(`Change.operationId`,`control-log.ts:25-28`):每个**逻辑转换**独立铸一次、**commit 前持久化**;崩溃重提**原样复用**(幂等重放);**同实体的新转换另取新 ID**(实体 seq 1→2);**不按扫描/pass 重铸**,**不拿一个业务 ID 当所有转换的去重键**(同 operationId 不同 payload digest ⇒ op-conflict 冻结实体,`control-log.ts:14`)。例:「待回执」转换 opId-A → 同实体「已确认」须 opId-B(非复用);opId-A 崩溃重放仍幂等。
   - **单调提交序 = control-log `seq` / `decidedAtSeq`**(`control-log.ts:22-24`,追加序 = `currentState.seq + 1`,跨任务全序)——**非 tasklog `updatedAt`/`Date.now`**(墙钟:两 taskId 可同为 1000、同任务后续可变 900,作键会重号、作序违 FC-6);
   - **投递证据**(OC-5:由凭据证,**非由任务态/缺失推**)。
3. **ack 仅删认领文件**(`inbox.ts:385`,**无 processed 归档**);不可「ack 后再派」。
4. **恢复入口**:扫投递证据为 **unknown** 的 baton,**重验证据**(FC-2 r3:绝不由 PENDING/缺失推未投递);**不从 PENDING 重发**(PENDING = 已派、尚无成员结果,**非**未投递)。
5. **认领语义 = 互斥 + 可恢复**,**非**严格 exactly-once。
6. 耐久优先(S31 / S18);孤儿按内容重批(S19 / decision-batch);空等即补机制(铁律 6 / F25)。

### B. 派单纪律(dispatch)

- **S14** 全字段派单(字段齐=零澄清)· **S30** user 已裁注原话。
- **S29** 一单两信 = **派单一信 + 交付一信**(单轮不碎)。
- **S26** 抄送精简 = **收件人分工**:判决/交付**全文只直投一方**(修复方/任务归属方);**抄协调者一律 ≤15 行摘要**(固定 SHA / 计数 / CLOSED / REMAIN / 门槛类型 / 报告路径+SHA256 / 下一步归谁),依据 S18。
- **S27** 消息减肥+审查批量 · **S28 / S28-b** 定长先行 + 三件套。
- **R21 / R21-b** 公司拓扑(原生优先、总线跨族、不中转、非全连通)· **R18** 分层调度 · **R11** 在途交叉带裁定号 · 设计先行。

### C. 审查席协议(review-seat)

一轮回 **P1/P2/P3 计数 + N REMAIN + 固定 SHA**;门**持到 0 REMAIN**;执行方每轮换新 SHA。对抗审查;**R13** 失实重于缺陷;**F46** 投对箱(thread-id 非 run-id);审查席=`REVIEW_SEAT`,忙排队,耐久箱候空闲浮出。

### D. 合并门(merge-gate)

排练 → 测 → 架构审 → 0 CONFIRMED → 落地(batch-N)。合入/推送归协调者(执行方不并不推);**休眠接缝启用=user 裁决**;具体旗默认随部署演进,按部署版本+接线状态核对(batch-14 已翻多数默认 ON,TG_ENTRY 守 opt-in)。铁律 7。

### E. 巡检 / 存活(patrol / liveness)

**F39** 巡检缺位=缺陷 · **F25** 空等 · **F45** 换壳继任(新壳首动 `agenthop install --mcp <kind>`)· **F53** 操作回执(耐久证据判成,非 API 瞬时返回,见 runbook)· 功能:定期**池检** + 对停滞成员**唤醒 ping**(编号 F49/F50 待 backfill,按功能用,不作可解析引用)。

### F. 常设门(standing gates — 内嵌最小定义,自足)

- **FC-2 r3**:读错 = unknown,**永不**断言否定(源 output-contract.md §Self-check)。
- **FC-6**:无墙钟 / latest-wins;裁决按**身份 + 单调序**显式转换(序取 control-log `seq`,非 Date.now)。
- **FC-7**:可选字段 + 旧记录容忍 **+ 存储格式变更带旧数据兼容导入**(迁移义务;源 output-contract.md / attribution-chain.md)。
- **到期默认边界**(CORE 铁律 8):问询带默认、到期按默认,**但仅限已授权非门控选择;真实门控(三类裁决本体)才裸等 user,绝不由到期推导缺失批准**(R3-b)。
- **R16 / R16-b** 授权链 · **R17** 代行=以 user 名义非冒充 · 授权留 C8 cap。铁律九条见 DRAFT §6。

### G. 律典检索入口(rulings CLI)

```
rulings <id>                 # 结构化账本号全文
rulings list [--series R|S|F] [--status active|superseded]
rulings grep <word>
```

命名空间四分、同号碰撞、FC 内嵌、F49/F50 功能化见上「律典解析契约」。

### H. 新项目开张流程(spawn-coordinator — 出生即胜任)

user 完整图景补充(设计已签 @ade8be9,本节并入 DRAFT 定稿,详见 DRAFT §8):① spawn-coordinator runbook(新 session → 加载技能 → 注入五参 → **自检状态文件地图**:PROGRESS 播种 / roster 注册 / board·control-log·inbox·decision-batches·投影 惰性建 + 加载检查);② 项目键 = 状态树根 `$AH_HOME/.agenthop`(与 state-isolation 对齐;多根隔离=前置依赖,诚实边界同 CS-P2-1);③ 第一轮例程(自唤醒 cron / 报到对话官或 user / 招募成员引用 roster resumeCmd 模板 F36);④ 与既有 agenthop 协调者(fe0376cd)= **对等同僚**:互不干预、各拥状态树、共用律典+基础设施、单一人类权威 user、跨项目对等不命令。

---

## ② 共通 vs 项目隔离 分界表

| 层 | 共通(随技能走) | 项目私有(随工作区) |
|---|---|---|
| 二进制/工具 | agenthop 二进制、总线、herdr、旗默认 | — |
| 法 | FC 族(内嵌)+ 结构化 R/S/F 账本 + CORE + runbooks(装 `AGENTHOP_RULINGS_DIR`) | 项目特有裁定(单独目录) |
| 技能 | **协调者技能本体** | — |
| 进度/状态 | — | `PROGRESS.md`、`board/`、`control-log/`、投影(`$AH_HOME/.agenthop/swarm/`) |
| 名册/角色 | roleProfile **schema** | 实际 roster / 席位 / 板条目 |
| 证据 | review-report **格式** | `review-reports/` 内容(`~/Work`) |

一句话:**共通 = 法 + 工具 + 技能本体;项目私有 = 事实 + 状态 + 人 + 证据**。物理隔离今日靠**单根单协调者**;多根隔离为前置依赖(见运行模式)。

---

## ③ 落点格式(两案并陈,user 裁)

### 案 A:仓内 `skill/SKILL.md` 双语,随二进制
利:每 install 自带、双语惯例、与产品同版本。弊:协调纪律耦合进产品发布周期(混关注点)、增大二进制、改一句要 rebuild+发版。

### 案 B:`~/.claude/skills/` 用户技能
利:**任何 session/目录加载**(正中所求)、与发布解耦、改文案免 rebuild、可 `/coordinator`。弊:不随二进制分发(每机单装)、非双语编译、活仓外。

### 建议(user 裁)
**案 B** 更贴所求。折中:真相源冻结仓内 `docs/swarm/`(本 brief + DRAFT),安装产物拷 `~/.claude/skills/coordinator/` + 随附安装资产清单(CORE.md + rulings/ + runbooks + 内嵌 FC + 加载检查)。取案 A 则 DRAFT 按英文 SKILL.md + zh-CN 双语拆分(`build-release.mjs` 契约)。

---

## 修订史(happycapy 审 · 摘要↔原文对表)

| 项 | 发现 | 修订 | 状态 |
|---|---|---|---|
| CS-P2-1 | 填参≠隔离;DATA_ROOT 双追加 `.agenthop`;总线不读 AH_HOME | 参数改 `AH_HOME`(数据面=`$AH_HOME/.agenthop`,追加一次);标总线 core.ts:84 不读 AH_HOME;v1 收窄单根;**撤回双 AH_HOME 隔离 claim**;多根隔离=各入口根统一 前置依赖 | r3 修 |
| CS-P2-2 | FC-2/F49/F50 指向的文件无该号 | 安装清单逐号给源;**FC 族内嵌自足**(源 output-contract §Self-check);**F49/F50 降为功能描述**、不入加载检查;加载检查验实际引用号非仅 S29 | r3 修 |
| CS-P2-3 | updatedAt 墙钟作序/键;PENDING≠未投递;**业务 ID 混用为 operationId** | 交棒记录**四件分离**(业务关联标识 vs **每转换 operationId**〔control-log.ts:25-28:逐转换铸一次、commit 前持久化、崩溃原样复用、新转换另取新 ID,同 ID 异 digest ⇒ op-conflict〕vs control-log seq 单调序 vs 投递证据);删 updatedAt 序用途;恢复重验证据、不从 PENDING 重发;认领=互斥+可恢复非 exactly-once | r3+r4 修 |
| CS-P2-4 | S29↔S26 混;删真实门控;FC-7 漏迁移 | S29/S26 分清;复原真实门控;FC-7 补兼容导入 | **CLOSED** |
| CS-N1 | 默认 OFF 举例过期 | 改按部署+接线核对,旧 OFF 标历史 | **CLOSED** |

## 自检

- **本体论检查(R4)**:五参标真实入口;未实现项(多根隔离)显式前置依赖。
- **引用核验**:结构化号已核;FC 族内嵌自足;F49/F50 功能化不作可解析引用;R3 同号碰撞标注。
- **范围**:纯文档,不动码、不碰 OpenDots 三门、不并不推。brief 冻结投协调者;审查席 happycapy。无需实现缺失后端——多根隔离/数据面改造均前置依赖。
