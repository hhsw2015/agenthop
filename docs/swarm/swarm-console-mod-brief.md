# swarm-console mod — 契约(冻结)

owner=f32a0507;协调者派单(user 裁「继续」,镜十五 [[claude-console-eval]] 吸收案头号件)。目标:一个 **Claude Code mod** 做我方投影的**纯消费者**,把蜂群监督渲进协调者/user 的 CC 会话——状态带 + `/swarm` 面板 + 键捕获预填呈批答复。**零新后端、零写面**(mod 唯一「输出」是 `$.prompt.fill` 进 composer,由 user 自己发送;派发/回答仍走既有总线与箱,**mod 不代发不写盘**)。设计先行:**本契约冻结后、协调者锁定,才动码**。审查席 happycapy。

## 0. 第一步 gate:mod API 可得性(已实证 PASS)

- **CC 版本**:`claude --version` = **2.1.293**(≥ 2.1.289 要求)。PASS。
- **mod 运行时存在**:实测在 `/tmp/swarm-console-probe` 建最小 mod(`.claude-plugin/plugin.json` + `hooks/hooks.json = {"modules":["./register.tsx"]}` + `register.tsx`),经 `claude --plugin-dir <probe> --debug -p` 加载:
  - 首版用 `$.ui?.toast?.(...)`(把 `$.ui` 当值读/可选链)⇒ 运行时报 **"hooks module did not load … `$.ui` is used as a value; `$` is always spelled `$.noun.event(...)` at the call site, on is always `on("<event>", hook)`, and next.to always `next.to(e, "<tier>")`"**——即 mod 系统**在、且在编译我的 register.tsx**。
  - 改为 `$.noun.verb(...)` 调用式 + `on("ui.render",{component:"AbovePrompt"},($,e,next)=>{const {Box,Text}=$.ui.resolve(e); return <Box><Text>…</Text></Box>})` 后 **加载干净无错**,会话正常完成。PASS。
- **学到的真实 API 文法(契约锚)**:
  - `$` 是**只调用的代理**:恒 `$.noun.verb(...)` 在调用点,**绝不把 `$.noun` 当值读/绑定/可选链**(否则「used as a value」报错)。
  - `on("<event>", [filter], hook)`;hook 为 `($, e, next) => … return next(e)`(或生成器 `function*($,e,next){ yield* next(e) }`)。
  - `next(e)` 透传;`next.to(e, "<tier>")` 定向。
  - `ui.render` 的 hook 返回 `$.ui.resolve(e)` 给出的 `{Box,Text,Button,Client}` JSX 树。
- **残留待实测(实现 step-1,非本 gate)**:可视渲染(状态带真出现在 prompt 上方、面板真开、键真回到 `ui.message`)只能在**交互式会话**观测;headless `-p` 不触发 `AbovePrompt`。先例 [[claude-console-eval]](claude-console v0.19.0 同 API 在产)佐证。实现第一步 = 交互式起一会话 + herdr/annotate 读屏确认三件(band/pane/key)真跑;**若交互渲染跑不通即报不硬做**(保留 gate 诚实)。

## 1. 形态与结构

一个 mod 包 `swarm-console`(建议 plugins/swarm-console/,或独立 marketplace):
```
.claude-plugin/plugin.json      name/version/description
hooks/hooks.json                { "modules": ["./register.tsx"] }
hooks/register.tsx              register(on){ on(...) × N }
hooks/rows.tsx                  Client 模块(键捕获 + 表格)
hooks/read.ts                   纯读投影 + 解析(无写)
```
TS/TSX,CC mod 运行时直载(无 build)。导入 `import type { Register } from "claude-code"`,Client 模块 `import type { ClientModule } from "claude-code"`。

## 2. 数据源(只读我方既有投影,fs.read ≤4MiB)

`HOME = $.env.get("HOME")`,根 `~/.agenthop/`。消费(全部 `$.fs.read`/`$.fs.list`,**只读**):

D15-D1(实路径已裁,批-15 live):`console/` 与 `swarm/console/` **分家**——gauge/digest 在 `~/.agenthop/console/`(dual-bandwidth/morning-digest store),decisions/roster 在 `~/.agenthop/swarm/console/`(console-projection-store,90b58f9c)。board 在 `~/.agenthop/swarm/board/`。

| 用途 | 路径 | 状态 |
|------|------|------|
| 带宽水位(gauge) | `console/bandwidth-gauge/gauge.json`(schema `bandwidth-gauge/v1`) | **已产**(dual-bandwidth-store) |
| 晨报(digest) | `console/morning-digest/digest.json`(schema `morning-digest/v1`) | **producer 已在**(SWARM_DIGEST,到点产) |
| board 表(每任务一文件) | `swarm/board/*.json`(`<itemId>.json` 未认领 posted · `<itemId>.<state>.<who>.json`;body 带 `itemId`〔正式板〕或 `id`〔协调者板〕) | **已产**(scan 目录) |
| 待裁呈批(decisions) | `swarm/console/decisions/<batchId>.json`(**信封** `console-decisions/v1`,`.batch`=逐字 DecisionBatch v1) | **已产 live**(console-projection-store,90b58f9c,批-15) |
| 各席状态(roster) | `swarm/console/roster.json`(**信封** `console-roster/v1`,`seats[{sid,tool,pane,alive:alive|dead|unknown,inflight}]`) | **已产 live**(同上) |

**mod 零新后端**:凡缺的只读投影,**mod 不产**(那违反零后端);须我方别处 producer 产出(另单),或 mod 读既有 store 的只读面(若在 4MiB 内且 schema 稳)。大文件走 `tail -c 65536` 子进程(`$.process.run`,仅读)。无 file-watch ⇒ `$.clock.every(60_000, …)` 在 `session.start` 起一次,回调 `$.ui.invalidate("ui.render")` 刷新(mod 收不到我方总线推送;ui.render 结果带缓存,须显式 invalidate)。**源区分三态**:缺/不可读 ⇒ 未知占位(`待裁:?` / `带宽:源未产` / gauge 坏字段 ⇒ `unknown` zone,绝不伪装成 0/green);确认空(目录在但无文件)⇒ `待裁:0`。

## 3. 三件渲染 + 键捕获(按实测文法)

- **① 状态带**(`on("ui.render",{component:"AbovePrompt"}, …)`):一行 = 各席状态(roster)· 待裁呈批数 · 带宽 zone(green/amber/red,读 gauge.ratio vs 0.8/1.2)。与他插件同行用 `const below = await next(e); return isEmptyTree(below) ? mine : <Box flexDirection="column">{mine}{below}</Box>` 堆叠。
- **② 面板**(`$.command.register({name:"swarm"})` + `on("command.run",…)` `$.ui.open({id:"swarm-console",title:"蜂群主控"})` + `on("ui.render",{component:"Pane",requestId:"swarm-console"}, …)`):board 表 + gauge 条 + 晨报节 + **呈批卡**(每 DecisionItem 一卡:summary/suggestedAction/evidenceRef + 选项)。
- **③ 键捕获**(Client 模块 `rows.tsx`:`surface.onKey`,host 侧 `on("ui.message",…)` 过滤 `requestId==="swarm-console" && e.element==="rows"`,载荷在 `e.data`):↑↓/jk 移光标,**数字键 1-N 选中聚焦卡的选项 → Client `surface.post({batchId,itemId,fp,verdict,scope?})`**(post 载荷须 JsonValue,`scope` 缺省时不带键)。host **复读投影、核对 (batchId,itemId) 仍在且 fingerprint 一致**(SCM-P2-2:列表变即要求重选,绝不按旧位置顶替),再核该 verdict+scope 是该卡**实际提供**的选项(hardGate 卡永不给宽 scope),才 `$.prompt.fill({text, mode:"replace"})` 预填 DecisionsDoc 答复草稿;`$.prompt.fill` 可拒(`isFilled===false`/`refusal:"no_composer"`)⇒ toast 提示 user 手输。**仅预填,绝不自动发送。** 键捕获须面板获原生焦点(terminal/desktop);phone/Remote 读选项手输。

## 4. 不变量(审查锚点)

- **只读 + 零写面**:mod **唯一副作用 = `$.prompt.fill` 进 composer**(+渲染+toast)。**绝不 `$.fs.write`、绝不发总线、绝不写 DecisionsDoc/箱**。真正的决策落盘/派发由 **user 发送预填后、其会话内 Claude(持总线工具)或既有外置 console 执行**——mod 不代发(user 裁铁律)。
- **fail-soft**:任一投影缺失/损坏/超 4MiB/解析失败 ⇒ 该格显 `—`,**绝不崩会话、绝不抛**(mod 错误会坏掉用户的 CC 会话)。
- **版本/能力 gate 降级**:`session.start` 探 CC 版本/mod API;不足或 `ui.render`/`ui.Client` 不可得 ⇒ **静默 no-op**(纯 Button 退化或不渲),绝不报错阻断会话。键捕获仅 terminal/desktop;phone/Remote 退化纯 Button(或只读不收键)。
- **per-session 纯消费**:协调者/user 各自会话跑一份,读**共享投影**;多份实例互不写、无状态竞争(都只读 + prompt.fill)。
- **`$.noun.verb(...)` 调用式**:全程遵实测文法,绝不把 `$.noun` 当值读(gate 已钉此为首错)。
- **系统提示稳定**:若用 `prompt.compose` 注固定段,只放稳定身份(`scope:"session"`);活数据走渲染/轮询,不进系统提示(保缓存)。

## 5. 依赖与接缝(非 mod 范围,须协调者派/定)

- **decision-batch 只读投影**:~~依赖~~ **已产 live**(90b58f9c,批-15,console-projection-store.ts)。`swarm/console/decisions/<batchId>.json`,信封 `console-decisions/v1`,`.batch`=逐字 DecisionBatch v1(mod 解信封校 schema≠`console-decisions/v1`⇒整拒 fail-soft,取 `.batch` 再 parse)。只镜在库未裁(未 consumed)批;consumed/vanished 才 prune。
- **roster/各席状态只读投影**:~~依赖~~ **已产 live**(同上)。`swarm/console/roster.json`,信封 `console-roster/v1`,`seats[{sid,tool,pane,alive:alive|dead|unknown,inflight}]`。状态带「席:<alive>/<total>」只数 `alive==="alive"` 的席。
- **答复语法契约**:键捕获预填的 DecisionsDoc 答复文本,须与既有 console/decision-batch 接受端**同一语法**(`DecisionsDoc{batchId,decisions:[{id,verdict,reason?,scope?}]}`,verdict∈approve|reject|defer,scope∈once|this-chat|always)。预填产出需对齐接收端(与 3e097dfe 的 console I/O 对齐)。
- **前端归属**:console 前端域 = 3e097dfe;本 mod 是其姊妹消费面,实现须与之协调(路径/schema/答复语法单一事实源)。

## 6. 交付物与轮次

- **本轮(设计先行)**:本 brief(契约)+ gate 实证报告 → 投协调者**锁定契约**。**不动码**(冻结再动码)。
- **下一轮(契约锁定后)**:实现 swarm-console mod(register.tsx/rows.tsx/read.ts)+ 交互式渲染实测(band/pane/key 三件跑通,跑不通即报)+ 投 happycapy 审。依赖投影(§5)若未产,先阻或并行派单。
- 实现时:mod 纯加法;不碰 bus/cli/relay;投影 schema 以 producer 为单一事实源。
