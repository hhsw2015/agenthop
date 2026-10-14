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
