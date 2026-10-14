# agenthop agents-bridge — 控制面文件协议 v1

Tern 的 `cx.agents` 是窗口半 Lua API;蜂群是 bash。本桥是一张薄 shim,把 `cx.agents` 镜射到一个**文件-JSON 控制面**,风格仿 herdr。零检测逻辑自有:状态来自 Tern,判读留给蜂群。

本文件是**权威协议**(A1 定稿)。源于 tern-migration spike r1-r5(`docs/research/tern-spike-report.md`),把五轮审查的修法固化为生产语义。

## 0. 控制目录

```
$HOME/.agenthop/tern-panes/
  agents.json            # STATUS 镜(桥写,蜂群读)
  requests/<id>.json     # REQUEST(蜂群写,桥认领删除)
  results/<id>.json      # RESPONSE(桥写,蜂群读后自行删)
```

`<id>` 由调用方(蜂群)选定,必须唯一且可作文件名(禁 `/`、禁 `.` 开头)。每个文件**恰好一行** JSON + 换行(herdr 风格,单行可 `jq -c` 直读)。

## 1. STATUS 镜 — `agents.json`

桥每 `POLL_MS`(默认 750ms)写一次:

```json
{"ts":<number>,"tick":<number>,"agents":[<AgentBlock>...],"error":<string?>}
```

- `agents` = `cx.agents:list()` 原样(字段富于最小 AgentBlock:`pane state busy at_prompt kind program model cwd alert alive host session tab ...`;omp 行另有 `model`/`last_message`,非 omp 无)。
- `tick` 单调自增 = 存活信号(不前进 = 该窗口 VM 的循环停了)。
- **语义 = advisory 快照,覆盖写(at-least-once 读面)**。被 torn-read 到的半截文件,下一轮(≤POLL_MS)自愈。**它不是耐久义务**,蜂群的 durable 账本才是真理源。
- 多 window 各跑一份 window-half ⇒ 多个 mirror 覆盖同一文件;对状态镜幂等无害(同一全局视图)。

## 2. REQUEST / RESPONSE

蜂群写 `requests/<id>.json`:

```json
{"op":"<name>", ...args}
```

桥**认领**(见 §3)后执行,写 `results/<id>.json`:

```json
{"ok":true, ...payload}          // 成功
{"ok":false,"error":"<string>"}  // 失败
```

### 2.1 Op 表

| op | 类别 | args | 成功 payload | 说明 |
|---|---|---|---|---|
| `list` | **只读** | — | `{agents:[...]}` | 同 agents.json 的 agents |
| `transcript` | **只读** | `agent, last?` | `{transcript:[...]}` | 仅 omp(TSP);非 omp 返 `[]` |
| `wait` | **只读-异步** | `agent, timeout?` | `{message:<string?>}` | idle 时返回末条 assistant 文本;异步经 `:next`,不阻塞轮询;非 omp 恒超时 |
| `ask` | **非幂等** | `agent, text` | `{}` | 贴+回车;native omp 一次 TSP send |
| `start` | **非幂等** | `prompt, cwd, command?, how?` | `{pane:<number>}` | **同步,可能长耗**(见 §4);prompt/cwd 非空 |
| `interrupt` | **非幂等** | `agent` | `{}` | Ctrl-C,不关块 |
| `stop` | **非幂等** | `agent` | `{}` | 关闭块 |

未知 op → `{"ok":false,"error":"unknown op: <name>"}`。坏 JSON(已认领)→ `{"ok":false,"error":"bad request json"}`。

## 3. 认领与恢复(五轮审查的核心)

### 3.1 认领 = remove 成功(不是 read 成功)

桥对每个请求文件:`read` → 成功才 `remove`(认领)→ 成功才执行 → 写结果。

- **remove 是认领**:POSIX unlink 原子。两个 window VM 同读一个请求,只有一个 remove 成功;输者得 ENOENT,跳过。单赢。
- **read 失败绝不 remove**:留在原地,下一轮重试(绝不删我们读不到的东西)。
- **remove 遇 EACCES**:卡住但不执行(安全方向,绝不双跑)。

### 3.2 真实语义:**at-most-once 执行 / 非崩溃安全 exactly-once**

`tern.fs` **没有** rename / O_EXCL(见 `tern.d.luau` fs 面)。认领与写结果之间若崩溃,该结果丢失。**本桥不声明、也无法提供 exactly-once。** 声明的是:每个 claim 至多执行一次;结果写是尽力而为。

### 3.3 恢复义务在蜂群侧,**按 op 类别分**

等够时限仍无 `results/<id>.json` = **UNKNOWN**。UNKNOWN **不释放去重义务**(蜂群 ruling):"不能确认已执行" ≠ "可假定未执行"。

- **只读(list/transcript/wait)**:换**新 id** 重发即可——重复只是再观察一次,无副作用。
- **非幂等(ask/start/interrupt/stop)**:**HOLD,绝不自动换 id 重发**。该操作可能已执行、只是回执丢了;盲目重发=第二次副作用。调用方须:(a) 先核对原操作效果(如 `list` 看 agent 是否已 start/收到),或 (b) 带独立业务幂等键,或 (c) 显式接受重复风险 / 交人裁。

## 4. start 的设计风险(spike 观测)

`cx.agents:start` 文档为同步;spike 中一次非空 prompt 的 OMP start 从状态轮询里发出时,镜射 tick 冻结。**未证因果**(tick 冻结无法区分预算退出/插件禁用/异常/持续阻塞;主审在隔离 action 也见过 `command start exceeded 50ms, disabled until reload`)。

**生产建议(非已证属性)**:长耗 op(尤其 start)不要从状态轮询里同步调;放独立窗口/action 上下文,或把 start 做成"下指令+轮询 list 看结果"的异步形态。`list`(只读)在轮询里安全是观测,不是安全证明。

## 5. 装机

```bash
tern plugin link <repo>/tern/agenthop-agents-bridge     # 原地用(开发/本仓)
# 或 tern plugin install <repo>/tern/agenthop-agents-bridge   # 复制进 `tern plugin dir`
```

`tern plugin dir` = `~/Library/Application Support/Tern/plugins`(非 `~/.tern/plugins`)。reload:`tern plugin reload`。

## 6. opt-in / 回退

本桥是**新增旁路**,不碰 herdr 任何调用,不改现有五命脉。seat-driver 按席位 `host:"herdr"|"tern"` 选驱动;tern 侧异常降级回 herdr。Tern 为闭测 beta ⇒ herdr 代码路径全程保留。

## 7. A2 — 免模型巡检哨兵(promptless patrol sentinel)

同插件第二件。零模型成本地每分钟巡检全席位,把三类"需要关注"写成告警。

- **机制**:`tern.carly.schedule({title="agenthop tern patrol", when="every 1m", check=<sentinel.luau 源>})`。`check` 是自包含 Luau 源,返回 `function(ev, cx, state)`;返回 nil=静默(无模型轮次),返回字符串=直接显示(仍无模型)。源在 `sentinel.luau`,window 半在**作用域回调内**(tern.carly 需要)读它并注册一次,按 title 去重(跨 reload/window 末者胜)。
- **读法**:`cx.session:read(pane, {as="table", lines=N, scrollback=true})` 取每个 agent pane 的尾 N 行。
- **比对用哈希,不用偏移**:长度/字节偏移在 TUI 重绘/滚动下失效(Carly V 批实证),故哈希**尾 N 行**文本做比较。
- **告警三型**:
  1. `content_filter` — 尾文本命中内容过滤短语(可调 `filter_pats`)。
  2. `permission` — 命中权限弹窗短语(`perm_pats`,如 "allow this"、"[y/n]")。
  3. `stall` — `busy==true` 且哈希自上次起 `>= stall_ms`(默认 3 分钟)未变。
- **双路输出**:
  - 耐久:`~/.agenthop/carly/alerts/<kind>-<pane>-<ts>.json`(单行 JSON,**蜂群扫**)。记录含 `pane kind marker program cwd text(尾部摘要≤400) ts check_ms`。
  - Carly 面:返回一行字符串(直接显示,无模型),形如 `tern-patrol: permission@pane<id>; ... (<ms>ms, N alert(s))`。
- **自计时**:每次 check 用 `tern.now()` 前后计 `check_ms`,写进每条告警(实机样本 ~1-3ms/数 pane;Carly 样本 8.65ms/3pane×200 行 = 样本观测,非普适上界)。
- **状态**:`~/.agenthop/tern-panes/sentinel.json` = `{scheduled, id, ts, error?}`(武装信号,可核)。
- **实证**:真机 schedule id=4,1m check 真跑,对探针 pane("Allow this tool? [y/n]")写出 `permission` 告警(check_ms 2.8ms)。夹具 `test/sentinel.test.lua`(三告警型+stall+reset+not-busy,teeth:清空 perm_pats→RED)。
- **边界**:`stall` 依赖 `state` 跨 run 持久(TaskSpec 的 state);若调度器不持久 state,stall 退化(其余两型仍在)——生产可改为把 seen 哈希落盘。
