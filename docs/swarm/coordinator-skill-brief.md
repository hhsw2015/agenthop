# coordinator-skill 简报 — 协调者技能化(设计·冻结候选)

owner aad02248 · 协调者 fe0376cd 派单(user 亲令,方向性大件)· 审查席 happycapy(mod 判后排队)· base main @a1a933d · 状态:**纯文档设计件,brief 冻结待审**

## 缘起(user 原话)

> 开发其他项目时在不同目录 / 不同 session,需要那个 session 充当协调者角色——把协调者技能写成 skill 文件,新 session 加载即知如何协调日常事务。

即:**协调者不再是某个具体 session 的默契,而是一份可移植的「操作手册」**。任何目录、任何 session 加载这份技能 + 一组参数,就成为那个工作区的协调者。本件是设计先行(铁律 7:裁定与契约文字一个动作);brief 冻结后才落 skill 正文,草稿见同目录 `coordinator-skill-DRAFT.md`。

## 设计原则(从 CORE.md 提炼,不另立体系)

1. **协调者 = 个人助理 = user 与公司之间唯一的人格化接口**(CORE 单一接口 / S21 单线宪法)。技能的职责边界由此派生:向上只送三样(该裁 / 该验 / 主动问),向下把 user 一句话翻成工单/契约/裁定。
2. **操作手册,不是流水账**(dispatch 明令)。技能正文是**可执行的例程 + 常设门引用**,不复述具体事故;具体判例留在律典(rulings 库),技能只按号引用,`rulings` CLI 为检索入口。这样技能本体稳定、可移植,而律典随学费单增长,二者解耦。
3. **参数化**(可移植的前提)。技能正文不绑死任何具体 session/路径/机器(CORE 本体论检查=R4 常设项)。五个参数随工作区注入,见下。
4. **代理权有账**(CORE 代理权):user 离场期协调者代行**可撤**决策(R3),不可逆挂 approval-wait,每笔代行进晨间追认单。

## 参数化契约(新 session 加载技能后需注入的五个参数)

| 参数 | 含义 | 默认 / 来源 |
|---|---|---|
| `COORD_SID` | 协调者的稳定总线身份 + 当前壳 session | 本 session 的 bus id;换壳继任见 F45 |
| `DATA_ROOT` | 蜂群数据面根(收件箱/板/control-log/PROGRESS 所在) | `$SWARM_DATA_ROOT` → `~/.agenthop`(CORE 解耦审计:数据面根应单一可配) |
| `PROJECT_ROOT` | 被协调工作区的根(仓 + 契约集 + 产物域) | 当前项目目录;CORE 最大未解耦项「项目↔蜂群」的落地口 |
| `REVIEW_SEAT` | 本工作区指定审查席 | 项目私有(happycapy / codex:Work / …) |
| `RULINGS` | 律典账本路径 + `rulings` CLI | `PROJECT_ROOT/docs/swarm/rulings/` + `scripts/rulings.ts` |

参数全由注入点提供;技能正文只按名引用,绝不硬编码某个 sid/路径。**一次 session 启动 = 加载技能 + 填五参 = 成为该工作区协调者。**

---

## ① 技能正文结构(operations manual — 七节例程)

技能正文分七节,每节是一段可执行例程或一组常设门引用。此处给**结构与出处**,正文内容在 DRAFT。

### A. 自唤醒扫箱例程(coordinator loop)

协调者的核心循环。触发 = 唤醒 ping(F50)/ sweep tick / boot。步骤:
1. 扫 `DATA_ROOT/inbox/<COORD_SID>/`,**逐封按序处理**(exactly-once:claim→ack→processed)。
2. 每封分类:成员成果 / 审查裁决 / 升级件 / user 裁定转达 / check-in。
3. 处理完**签收**(ack 落 processed),再**派下一棒**(dispatch-next-baton)——把成果转成下一工单 / 推进审查轮次 / 升级给 user。
4. **耐久优先**(S31:耐久箱载全文,队列只作唤醒 ping;S18:file=authority,message=pointer)。孤儿按内容摘要重批(S19 / decision-batch),绝不按时钟(FC-6)。

### B. 派单纪律(dispatch discipline)

- **S14** 派单全字段契约 · **S30** user 已裁事项注明原话。
- **S29** 一单两信(全文投执行/审查席 + 摘要抄协调者;皆耐久箱)。
- **设计先行**:设计/契约冻结后才动码(conditional-routing / output-contract 先例)。
- **R21 / R21-b** 通讯分层=公司拓扑:原生优先、总线跨族、**协调者不中转**、非全连通网;**R18** 分层调度(二级协调者)。
- **S26 / S27 / S28 / S28-b** 精简族:抄送精简 / 消息减肥+审查批量 / 产出定长先行 / 三件套(adhd+ste100+stcn100)全员强制。
- **R11** 在途交叉:范围答复带裁定号。

### C. 审查席协议(review-seat protocol)

- 一轮审查回 **P1/P2/P3 计数 + N REMAIN + 固定 SHA**;审查门**持到 0 REMAIN**(签收)。执行方每轮**换新 SHA** 复提(output-contract 五轮即此形态)。
- 对抗审查;**R13** 原生回执:失实重于缺陷。**F46** 送审投对箱(thread-id 非 run-id)。
- 审查席由 `REVIEW_SEAT` 参数给;mod/忙时排队,耐久箱候其空闲自然浮出。

### D. 合并门流程(merge-gate)

- **排练 → 测 → 架构审 → 0 CONFIRMED → 落地**(batch-N 形态:rehearse-batch → 装机 → dispatcher 重启 → board=done)。
- **合入/推送/启用归协调者**(执行方不并不推);休眠旗**启用门归 user**(attribution / FC-4 / output-contract 皆此姿势)。铁律 7。

### E. 巡检 / 存活(patrol / liveness)

- **F39** 协调者巡检缺位=缺陷 · **F49** 池检 · **F50** 唤醒 ping · **F25** 空等是最大成本。
- **F45** 换壳继任 + **F53** 操作回执(协调者自己的 spawn/inject 以**耐久证据**判成,非 API 瞬时返回)+ 继任心跳。见 `coordinator-ops-succession-runbook.md`。

### F. 常设门(standing gates)

- **FC-6** 无时钟/latest-wins(显式转换)· **FC-7** 可选字段/旧记录容忍 · **FC-2 r3** 读错=unknown,永不断言。
- **R16 / R16-b** user 授权链宪法 · **R17** 协调者代行=以 user 名义实施,非冒充 · 可追溯/核验标签**永不**被授权路径读取(授权留在 C8 cap)。
- CORE **铁律九条**(状态是证据 / 推进责任有耐久持有者 / 交接两端监管 / 两证据面 / 期限只判死活 / 空等最大成本 / 裁定即契约文字 / 问询带默认 / 域不合不领)。

### G. 律典检索入口(rulings CLI)

技能按号引用判例;检索靠 `rulings` CLI(feat/rulings-cli):

```
rulings <id>                 # 单条全文, 如 rulings R16 / rulings S29
rulings list [--series R|S|F] [--status active|superseded]
rulings grep <word>          # statement 含词的紧凑列表
```

**这是技能「操作手册而非流水账」的关键机制**:正文只留可移植的法(FC 族 + S/R/F 号),律典随学费单增长,`rulings` 把号解析成全文。技能不内嵌判例正文,故不随律典膨胀。

**号的覆盖面(honest caveat)**:结构化 `rulings/` 账本覆盖 R/S 全系 + F21 起;**FC 族(FC-2/6/7)、F49/F50/F53、及铁律引的早期 F 号(F8/F13/F16-F22)目前在 F-ledger / CORE.md,`rulings <id>` 未必返回**——查 CORE 铁律节 + `coordinator-ops-succession-runbook.md`(F53)。ruling-backfill 推进后逐步并入。技能正文对此已标注,避免「`rulings F49` 空返」误读。

---

## ② 共通 vs 项目隔离 分界表

| 层 | 共通(可移植,随技能走) | 项目私有(随工作区) |
|---|---|---|
| 二进制/工具 | agenthop 二进制、总线、herdr、旗默认 | — |
| 法 | FC 族 + S/R/F 判例=可移植律典;rulings 账本 + CLI | 项目特有裁定(若有) |
| 技能 | **协调者技能本体** | — |
| 进度/状态 | — | `PROGRESS.md`、`board/`、`control-log/`(数据面 `DATA_ROOT/swarm/`) |
| 名册/角色 | roleProfile **schema** | 实际 roster / 席位 / 板条目 |
| 投影 | 投影**契约** | 被投影的数据 |
| 证据 | review-report **格式** | `review-reports/` 内容(`~/Work`) |

一句话:**共通 = 法 + 工具 + 技能本体;项目私有 = 事实 + 状态 + 人 + 证据**。技能移植时只带左列;右列由五参定位到具体工作区。

---

## ③ 落点格式(两案并陈,user 裁)

### 案 A:仓内 `skill/SKILL.md` 双语形态

随 agenthop 二进制走(`build-release.mjs` 编入 `skill-text.ts`,`agenthop install` 写盘);英文 `SKILL.md` + 中文 `SKILL.zh-CN.md`(仓内既有惯例)。

- **利**:每个 install 自带;双语惯例现成;与产品同版本化;装机即分发。
- **弊**:把**协调纪律**技能耦合进 **agenthop 产品**发布周期(产品技能讲的是配对/中继工具,混关注点);增大二进制;改一句要重新 build + 发版。

### 案 B:`~/.claude/skills/` 用户技能形态

用户级 Claude Code 技能(可 `user-invocable`,`/coordinator`)。

- **利**:**任何 session / 任何目录加载**,与项目无关——**正中 user 所求**;与 agenthop 发布解耦;改文案免 rebuild;可设 slash 入口。
- **弊**:不随二进制分发(每机单独装);非双语编译;活在仓外(版本化在 user dotfiles 而非仓)。

### 建议(待 user 裁)

**案 B 更贴所求**(跨项目/跨目录可移植、与发布解耦)。折中:**真相源**冻结在仓内 `docs/swarm/`(本 brief + DRAFT),**安装产物**从它生成/拷到 `~/.claude/skills/coordinator/`——仓内可审可版本化,用户技能即时可加载。若 user 取案 A,则 DRAFT 按仓内英文 + zh-CN 双语拆分(`build-release.mjs` 契约)。

---

## 自检(FC / CORE 对齐)

- **本体论检查(R4 常设项)**:技能正文引入的名词全部参数化(COORD_SID/DATA_ROOT/PROJECT_ROOT/REVIEW_SEAT/RULINGS),无一绑死具体 session/路径/机器/厂商。
- **FC-6**:扫箱例程按内容标识(taskRef)判序,不按时钟/latest-wins。
- **授权边界**:技能是**操作手册**,不赋任何权限;代行权本身仍受 R3(可撤才自主)+ R16 授权链约束,三类裁决归 user。
- **范围**:纯文档设计件,不动码、不碰 OpenDots 三门、不合并不推送。brief 冻结投协调者;审查席 happycapy。
