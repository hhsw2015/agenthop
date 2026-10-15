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

### 2.0 发布必须原子(TA-A1-PUBLISH,硬要求)

蜂群**不得**直接 `echo … > requests/<id>.json`:shell 重定向先创建/打开最终路径再写正文,桥在中间窗口会读到空串/半截——旧实现会据此当坏 JSON 认领删除,**合法请求被毁**。发送方必须**原子发布**:先写一个不被桥列举的临时名,写完 `mv` 成最终 `.json`(同目录 rename,POSIX 原子)。Bash 的 `mv` 可用,**不受 tern.fs 无 rename 限制**(限制只在插件 Lua 侧)。

用现成的 `publish.sh`(推荐,已把下面的门封好):

```bash
publish.sh ~/.agenthop/tern-panes '{"op":"list"}'   # 打印 request id;写失败则 exit!=0 且不产生最终 .json
```

或内联——**rename 必须以写成功为前置**(`&&`),否则 printf 半途失败后无条件 `mv` 仍会把半截正文发布成最终 `.json`(TA-A1-PUBLISH):

```bash
D=~/.agenthop/tern-panes; id="q-$$-$(date +%s%N)"    # 唯一 id
tmp="$D/requests/.$id.tmp"                            # 临时名:点开头、不以 .json 结尾 => 桥不列举
printf '%s' '{"op":"list"}' > "$tmp" \
  && mv -f "$tmp" "$D/requests/$id.json" \
  || { rm -f "$tmp"; exit 1; }                        # 写成功才 rename;失败清理且不发布
```

桥侧另有兜底:读到空串**不认领**(claim.luau 的门,留待下一轮);但权威修法是**发送方写成功门 + 原子 rename**。桥只列举 `*.json`,临时名(`.`开头或非 `.json` 后缀)天然被跳过。

### 2.1 请求 / 应答

蜂群(原子)写 `requests/<id>.json`:

```json
{"op":"<name>", ...args}
```

桥**认领**(见 §3)后执行,写 `results/<id>.json`:

```json
{"ok":true, ...payload}          // 成功
{"ok":false,"error":"<string>"}  // 失败
```

### 2.2 Op 表

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

**已落地(tick 冻结根修)**:生产中复现——两次 start 后 `agents.json` tick 冻结、`plugin reload` 不能恢复、start 本身成功。根因:mirror 与 drain 共用一条 `step` 链,且 reschedule 在 drain **之后**;sync start 超 ~50ms 预算被 Tern 外部终止(pcall 捕不到)⇒ 下一 tick 从未排上 ⇒ 整条轮询冻结。修=**拆两条独立 sleep 链**(`mirrorStep` 活性 / `drainStep` 认领分发)+**每条先 reschedule 再干活**:被杀的 tick 已有继任者,链自愈;被杀那一个 op 落入 §3 的至多一次恢复。门 `test/window.test.lua`(拆链 / mirror 在 drain 卡死时照常推进 / 两链 reschedule-before-work / 杀后自愈),三个变体(drain 或 mirror 的 reschedule 挪到末尾、并回单链)均 RED。start 异步化仍是更深的后续。

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
- **读屏故障不吞元数据告警(TA-A2-READ)**:`p.alert`(OSC 来的"需要人")来自 panes 元数据,**不依赖**屏幕正文;正文读失败时仍写 `osc_alert`(带 `unreadable`),其余两型(需正文)该轮跳过。
- **停滞按连续 busy 计(TA-A2-STALL)**:`stall` 计时起点 = "连续 busy 且尾 hash 未变"的起点;非 busy 即重置,重入 busy 从当次重新计——**idle 时间不计入**。
- **非计级(明示)**:① 耐久写是**尽力而为**——`alerts/` 写失败不阻塞,返回的 Carly 字符串仍显示(活信号优先于耐久副本);② 哨兵每轮报**当前态**,对持续的 filter/permission/osc_alert **不自去重**(边沿检测留作后续)——**去重/节流契约归蜂群扫描方**,按 `(pane,kind,marker)` 折叠。哨兵 = 传感器,蜂群 = 策略。

## 8. A3 — OSC 9;4 alert 通道

同插件第三件。给**裸(非 ACP)席**一条"需要人"信号:席位在需要人时发 OSC 9;4,Tern 置 `PaneInfo.alert`(并/或 `state=waiting_input`),A2 哨兵读 `pane.alert` 并入告警流。实证基础 = Carly V6 对照(OSC 9;4;4→alert=true、聚焦即清、无 OSC 不变)。

> **范围(TA-A3-SCOPE)**:本批**只交付 Claude Code 发端**(下列事件,配置 `~/.claude/settings.json`)。**Codex 未接线**——它用不同事件(`PermissionRequest`,见 `docs/research/codex-opencode-hooks.md`)与配置路径,当前 hook 对它零输出。Codex/opencode 发端**待验**,留后续批次。读端(哨兵读 `pane.alert`)与席位类型无关,任何发 OSC 的程序都通。

- **发端(emitter)**:`osc-alert-hook.sh` = Claude Code hook。
  - `Notification` → `printf '\033]9;4;4;50\007'`(paused→需要人)。
  - `Stop` / `SubagentStop` / `UserPromptSubmit` → `printf '\033]9;4;0\007'`(清除)。
  - OSC 必须到 pane 的 PTY:hook 的 stdout 被 Claude Code 截获,故写 `/dev/tty`(可用 `AGENTHOP_OSC_TTY` 覆盖,夹具据此捕获)。
  - **仅在 Tern pane 内发**(`$TERN_PANE` 有值);herdr/其它终端席位是 no-op ⇒ 全席可挂,安全。
  - 注册见 `osc-alert-hook.settings.json`(Notification/Stop/SubagentStop/UserPromptSubmit 四事件)。
- **读端(reader)**:A2 `sentinel.luau` 的 `scan_pane` 增一型 `osc_alert`:`p.alert == true` 即写入告警流(耐久文件 + Carly 字符串,同 §7 双路)。
- **夹具**:`test/osc-hook.test.sh`(四事件 → 正确 OSC、未知事件无输出、无 TERN_PANE no-op);`test/sentinel.test.lua` 增 `osc_alert` 两例(alert=true 折入 / alert=false 不发)。
- **关系**:ACP 块席位(迁移主路)天然有 waiting_input+surface;OSC 9;4 通道是**裸 TUI 席的次优信号路**,让它们也进 A2 的"需要人"流,不必解析屏幕。

## 9. A2 r2 增补(dormant,atop 冻结 tern 批)

四件,免模型纪律照旧,各带牙(夹具 `test/sentinel.test.lua` + `test/cpa-probe.test.sh`):

- **① 互盯 beat(#924:存活证明落 L0 文件,互读文件不互读进程)**:beat 合同 = **裸 epoch 秒、一行文本、宿主 wall-clock**(`os.time()`,非 `tern.now()` monotonic——跨程序相减必须同一 wall 时基)。哨兵每轮写 `<L0>/carly-patrol.beat`(`<epoch 秒>\n`,我的存活;蜂群 8 分钟循环读,>20min 过期=我被停/Tern 关→接管+TG 兜底);同轮读 `<L0>/coordinator.beat`(裸秒,`tonumber` 去空白),过期(wall 秒龄 > `coordinator_stale_sec`=20*60)→ `coordinator_stale` 告警;坏载体(空/非数字/旧 JSON)→ 不报不崩。对称:我盯协调者、蜂群盯我,都靠 L0 文件。(stall/性能的时长计时仍用 `tern.now()` monotonic,不改。)
- **② 预算拆分**:每轮只 body-scan `batch_size`(4)个 pane,偏移轮转(`state.scan_offset`),防单轮读超时;**但 metadata 清扫覆盖全 pane 每轮**(osc_alert + proven-idle 停滞钟重置不受分批延迟)。牙=分批覆盖完整性(偏移不前进→有 pane 永不覆盖→RED)。
- **③ L0 告警路径**:`l0_root()` 占位常量 + `TODO(M2-a 投影契约)`;告警文件在 `<L0>/alerts/`,**TG 直接从文件取,不经 Carly**。
- **④ W3 CPA 探针(`cpa-probe.sh`,蜂群侧 bash,独立于 Carly/哨兵)**:CPA 管家自己挂了投不了箱⇒蜂群直探。探**无鉴权健康路由 `/healthz`**(2s 超时;`/v1/models` 是鉴权门,无 key 恒 401——ACP 试点实测,旧「非 200=DOWN」会把它误报成 CPA 挂=假警报族,F1 根治)。**三态(F1)**:完整 `200`=UP;**传输失败**(curl 非零退出 / 无连接 / `000`)=DOWN;其他完整 HTTP(401/404/5xx)=UNKNOWN。**判序要紧(F1 r2 / F1-CURL-RESULT):先判传输失败,再确认 UP**——`200` 只是头,传输仍可能截断(rc18)或读超时(rc28)而 `%{http_code}` 仍为 `200`;带非零 curl 退出的 200 绝不读作 UP、绝不清警(与 CS-OUTBOX-ONCE 同课:单信号 OK≠全链 OK;200 是头的事,rc 是整条传输的事)。**连续 3 次 DOWN**→写 `cpa_down` L0 告警;一次 **UP**(完整 200)→清 streak + 删告警(恢复即清);**UNKNOWN=纯空操作**(exit 4:不进 streak、不清告警、不碰 state)。streak 落 `<L0>/cpa-probe.state` 跨轮持久。牙=3 连击(第 1/2 次不报)+ 恢复清 + 状态码×退出码矩阵(200+rc0=UP / 200+rc18 / 200+rc28=DOWN / 401=UNKNOWN)。注入口:`AGENTHOP_CPA_PROBE`(hook exit 0=up/2=unknown/其他非零=down)、`AGENTHOP_CPA_HTTP`(注入 HTTP 码)、`AGENTHOP_CPA_RC`(注入 curl 退出码,测矩阵)、`AGENTHOP_CPA_URL`。退出码:`0` up+clean / `1` down+advanced / `2` down+state-unavailable / `3` persist/cleanup incomplete / `4` probe UNKNOWN。

状态/新 L0 产物:`<L0>/carly-patrol.beat`(我写)、`<L0>/coordinator.beat`(我读)、`<L0>/cpa-probe.state`(bash 探针)、`<L0>/alerts/{osc_alert,content_filter,permission,stall,coordinator_stale,cpa_down}-*.json`。
