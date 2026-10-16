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
{"ts":<number>,"tick":<number>,"vm":"<per-load id>","window":"<TERN_WINDOW_KEY?>","tick_ms":<number?>,"tick_ms_max":<number>,"timer":"running|stopped-late|overdue","timer_fired_at":<number?>,"agents":[<AgentBlock>...],"error":<string?>}
```

- `agents` = **r6 起由 `cx.session:panes()` 过滤 `kind=="agent"` 自建**(不再调 `cx.agents:list()`):每项 `pane title cwd tab program busy at_prompt exited alert parked alive`(`alive` = `exited==nil`)。协调者现网分段计时:`agents:list()` ~28ms + 对其 encode ~25ms ⇒ tick 40-50ms+(r1-r4 每个 hook 都被杀的真因);`session:panes()` ~0.17ms。`model`/`state`/`last_message` 不在 PaneInfo 上,tick 里不再有;需要完整字段走 `list` op(请求面,不在 tick 里)。目标 <2KB、<3ms/tick。
- 分段面包屑 `mirror-phase.json`(r5)保留为**调试开关**,默认关:`AGENTHOP_BRIDGE_DEBUG_PHASE=1` 或 kv `bridge.debug_phase=true` 时每段前写一次(每次是一次写盘,正是 tick 要避开的开销类)。
- 手动/主驱动刷新:`tern ctl plugins run plugin.agenthop-agents-bridge.mirror`(独立 hook)。
- `tick` 单调自增 = 存活信号(不前进 = 该 VM 的 mirror 停了)。r4:`vm` 每次加载/reload 变的随机 id、`window`=`TERN_WINDOW_KEY`——多窗口覆盖写同一文件时可分辨是哪个 VM 在走(一死一活不再看起来「还在走」);`tick_ms`=上一 tick 耗时(ms,本 tick 的写入无法含自身)、`tick_ms_max`=本 VM 迄今最大值——>50ms 尾部在文件里可观测,不必事后翻 tern.log。
- r4 驱动:**主=`mirror` 命令**(独立 hook,蜂群 sweep 每 ~5s `tern ctl plugins run plugin.agenthop-agents-bridge.mirror`);**辅=`tern.timer` 自续链**(timer hook,非 await;先续后干;若 timer hook 被禁则链停,活性由命令驱动独撑)。await hook 不再使用。
- r11 `timer_fired_at` = 最后一次**真实投递**的 timer 回调的 `tern.now()`(缺省 = 本次加载以来从未投递)。**读者规则**:`agents.json` 只在 tick 时重写,timer 回调不再来时文件就停在最后一次写入的样子——那一次常是 `mirror` 命令刚重启链时写的 `"timer":"running"`(协调者 13:17 现网所见:tick 32→32 而 `timer` 恒 running)。所以 `timer` 字只描述**写入那一刻**;判断加速器是否在投递,看 `ts - timer_fired_at`(同一时钟)与文件 mtime,不看一个冻住文件里的 `timer` 字。活性唯一来源仍是 #1033 的 5s `mirror` 命令扫。
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

写完后**触发** drain(r2:drain 不再挂 sleep 链,改为命令,每个命令是独立 hook):

```bash
TERN_PANE_SOCKET="$HOME/Library/Application Support/Tern/daemon.sock" \
  tern ctl plugins run plugin.agenthop-agents-bridge.drain        # 快 op:list/transcript/wait/ask/interrupt/stop/eval
TERN_PANE_SOCKET=… tern ctl plugins run plugin.agenthop-agents-bridge.drain-start   # 仅 start
```

`drain` 只认领非 start 请求,`drain-start` 只认领 start;另一类请求原样留在 `requests/`(peek 不 remove)等它自己的命令。ctl 路径在 Tern 非前台时照常执行(协调者实测);任何进程设 `TERN_PANE_SOCKET` 即可调,不必在 Tern 格内。

桥**认领**(见 §3)后执行,写 `results/<id>.json`:

```json
{"ok":true, ...payload}          // 成功
{"ok":false,"error":"<string>"}  // 失败
```

### 2.2 Op 表

| op | 类别 | args | 成功 payload | 说明 |
|---|---|---|---|---|
| `list` | **只读** | `full?` | `{agents:[...]}` / `{full:true,agents:[...]}` | r7:默认=mirror 同款瘦身表(`session:panes()` ~0.2ms);`full:true` 才调 `agents:list()`(~28ms+,剔 `command`/`agent_command` 后编码,18KB→<4KB),调用方承担其预算 |
| `transcript` | **只读** | `agent, last?` | `{transcript:[...]}` | 仅 omp(TSP);非 omp 返 `[]` |
| `wait` | **只读-异步** | `agent, timeout?` | `{message:<string?>}` | idle 时返回末条 assistant 文本;异步经 `:next`,不阻塞轮询;非 omp 恒超时 |
| `ask` | **非幂等** | `agent, text` | `{}` | 贴+回车;native omp 一次 TSP send |
| `start` | **非幂等** | `prompt, cwd, command?, how?` | `{pane:<number>}` | **同步,可能长耗**(见 §4);prompt/cwd 非空。**放置模型**(#1034,user 定):session=项目、tab=长期席位(英文角色名)、block=短命 worker。经 `agenthop_tern` 起 worker 时默认在**调用方席位旁 split**(桥收 how=split,随后 `tern move <新> right-of <调用方 pane>`);`how:"tab"`=同 session 新 tab(扇出 >4);不跨 session。worker 名=`<角色> · <任务>`,不含 sid。**`kind:"tui"`**(#1034 r2,不经本桥):`agenthop_tern` 为 worker 另起独立 herdr session(名 `<角色短>-<任务短>`)并以 `tern split` 嵌成调用方席位旁的块,返回 `{pane, herdr_session}`;登记在 `seat-shell/<sid>.json` 的 `workers[]`。**诚实边界**:tui 块**对 `cx.agents` 不可见**——不能经本桥 ask / wait / approve;它的子 agent 只是画面;状态只读 `herdr --session <名> agent list` 的 agent_status;起停与回报走 #1042 钩子 / 耐久箱,不走本桥 |
| `interrupt` | **非幂等** | `agent` | `{}` | Ctrl-C,不关块 |
| `stop` | **非幂等** | `agent` | `{}` | 关闭块 |
| `eval` | **非幂等** | `code` | `{value:<any>}` | r2(user 亲令「通过插件直接调用 Lua API」):`loadstring` 编译(VM 内 `load` 为 nil)后以 `cx` 为参调用,返回值 JSON 编码;编译/运行错误 → `{ok:false,error}`。走 `drain`(快类) |

**eval 信任边界**:能写 `requests/` 者本已可用 `start` 起任意命令,eval 不新增攻击面。这一条**以控制目录只有本用户可写为前提**——这是假设,不是本桥保证的:桥用 `tern.fs.mkdir` 建目录,不设权限位(2026-10-15 现网 `~/.agenthop/tern-panes` 与 `requests/` 为 0755,即只有属主可写,组/其他可读);`gc.sh` 摘要行带 `mode=<八进制>` 供巡检核对,组或其他可写时另加 `unsafe_mode` 并 exit 1(UNKNOWN)。

**eval 预算(调用方自负)**:eval 跑在 `drain` 命令 hook 内;单次 >50ms(如 `return #cx.agents:list()`,~28ms 且有方差)会禁用 `drain` 直到 `tern plugin reload`,其后所有请求滞留 `requests/` 不被消费(11:28:45 现网实例)。贵调用请拆分、或改用 `list`(默认瘦身)。

**drain 节流(r7)**:每次 `drain`/`drain-start` 触发**至多处理一条**本类请求(FIFO,按文件名),其余留给下一次 `plugins run`——蜂群本就每 publish 一次 drain;一次触发不会因堆叠多条而撑爆预算。

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

**已落地(tick 冻结根修,r2 订正根因)**:现网实证——`agents.json` tick 冻结、`plugin reload` 前不恢复。**Tern 的禁用单位是 hook**:所有 `tern.sleep():next` 续体同属 hook `await`,任一续体超 ~50ms(`await exceeded 50 ms`)即禁用本 VM **全部** await 续体,已排队的继任也不再投递(Tern docs concepts/runtime.md:one slow timer callback disables all of the plugin's timer callbacks in that VM)。耗时来源不只 start:仅 `list`+编码 41KB+写盘的 mirror 偶发 >50ms 也会触发。故 r1「拆两条 sleep 链+先排队 ⇒ 自愈」**不成立**(两条链同一 hook,协调者 40 分钟现网三次复现)。

r2 修法 = **命令面隔离 + 蜂群侧 reload 恢复**(不是 VM 内自愈):① drain 改为 `tern.command`,由蜂群写完请求后 `tern ctl plugins run` 触发,每个命令是独立 hook `command <id>`;② 按 op 类拆 `drain`(快 op)与 `drain-start`(仅 start),start 撑爆预算只禁 `drain-start`,不连坐快 op 与 mirror;③ mirror 瘦身(§1)远离预算,仍走 sleep 链,另可命令手动触发。④(r3→r4)A2 挂哨只在 `arm` 命令(独立 hook,蜂群每次加载/reload 后触发):其三次跨 VM `tern.carly.*` 在首个 await tick 实测超 50ms(11:05:40),r3 曾放 `tern.timer(0)`,r4 timer hook 承载 mirror 链,故挂哨不再上 timer。⑤(r4)slim mirror 自身仍偶发 >50ms(11:12:17 第二次 await kill,tick 冻 33):mirror 移出 await hook——主驱动改 `mirror` 命令(蜂群 sweep 每 ~5s 触发),辅以 `tern.timer` 自续链;agents.json 加 `vm`/`window`/`tick_ms`/`tick_ms_max`(§1)。⑥(r6)**真因定位**:换 hook 都会被杀,因为 mirror 本身就 40-50ms——`cx.agents:list()` ~28ms + 全量 encode ~25ms(协调者用 eval op 现网分段计时)。mirror 改由 `cx.session:panes()`(~0.17ms)自建最小表,tick 不再调 `agents:list()`。⑨(r10)**真机加载门**:Tern 插件 VM 的 `_G` **只读**——r9 的 `_G.__bridge_test = …` 在真机加载即抛 `attempt to modify a readonly table`、整插件哑掉(本地 lua 夹具却能过;今日第二次「本地过真机挂」,前一次 10:56 Luau 语法)。测试缝改为 window.luau **chunk 返回值**(Tern 忽略);夹具以只读代理 `_G`(`__newindex=error`)加载 window.luau 与 sentinel.luau,任何全局写即 RED。**资源回收(无泄漏)**:`gc.sh`(蜂群 sweep 调,插件内不做 fs 遍历)——`results/` 超 1h 未消费⇒删;`requests/` 超 5min 无人认领⇒**移** `requests/quarantine/<id>.<epoch>.<rand>.json`(不删:可能是结局 UNKNOWN 的非幂等 op,§3.3;r12:**独占新名、`mv -n` 绝不覆盖**已有隔离件〔BTF-GC-QUARANTINE-OWN〕;移之前先把 mtime 设为隔离时刻,**24h 检查期从隔离起算**而不是请求出生〔BTF-GC-QUARANTINE-AGE,最旧请求首次 GC 也留满 24h〕;任一步失败⇒请求原地留在 `requests/`、计 `requests_held`,下轮重试,绝不删也不顶掉别人——代价是它的 mtime 已被刷新,5min 计时重新起算)。r14〔BTF-GC-SOURCE-OWN〕**先取得再判断**:按路径看着老的请求先 `mv -n` 到私有名 `requests/.gc-<id>.<pid>.<rand>`(drain 只认 `*.json`,看不到它;macOS 的 `mv -n` 拒绝时也 exit 0,所以成败一律靠事后看文件),再对**手里这个对象**算年龄——不够老(drain 认领旧件后 `agenthop_tern` 以同 id 重发的只读请求)⇒原名放回;原名已被更新的发布占了⇒手里这件进隔离(留存不删)。gc 持有时崩溃留下的 `.gc-*` 下轮按 TTL 进隔离、崩溃遗留 `.tmp` ⇒删、quarantine 超 24h⇒删;控制目录不可读⇒exit 1(UNKNOWN,不当「无可清」)。r13〔BTF-R10-P2-4〕:三个受管子目录(results / requests / requests/quarantine)是 symlink 或解析到控制目录外⇒**整项跳过不跟随**,摘要行加 `skipped=<dir>(symlink|outside|…)`;子目录里本身是 symlink 的条目也跳过——gc 绝不删、移、touch 控制目录外的一个字节。`agents.json` 每 tick 由 live `panes()` **整份重写**,关掉的 worker 块下一 tick 即自然消失,无需另清。旧巡检任务:每次 reload 后 arm-scan 列出、sweep 循环 arm-cancel-next 到只剩 1(或 0 后 arm-schedule.sh)。⑦(#1036)**timer 仅作前台加速器**:12:01:42 timer hook 被杀而 tick_ms 仅 0.28ms——活不慢,是回调**迟到**(macOS App Nap/后台合并定时器),迟到的那次被记入 50ms 预算。链现在在回调迟到 >400ms 时**自停**(不再续排,`agents.json` 的 `timer`=`stopped-late`),下一次 `mirror` 命令(#1033 的 5s 扫)再重启它;r13〔BTF-R10-P2-1〕重启带**代际号**:每次重启 `timerGen+1`,回调闭包捕获自己那一代,到达时不是当代就直接返回(不续排、不 tick、不写 `timer_fired_at`)——Tern 迟迟投递的旧回调不会再起第二条链,任何时刻至多一条在排;活性只靠命令驱动,timer 被 Tern 禁用也不告警。`arm` 拆成三条各含一次 `tern.carly` 调用的命令:`arm-scan`(列我方旧巡检,存 kv)→ `arm-cancel`(每次取消一条,重复到 `pending_cancel=0`)→ `arm-schedule`(仍有待取消时拒绝,避免重复巡检);`arm` 保留为第一步。⑧(r8 二声 P2)drain 按**解码后**顶层 op 分类(转义键/值、嵌套字段不再错领);`eval` 保留假值返回(`return false` 不再变 nil)。**恢复剧本(蜂群侧,须自动化)**:tick 停 >5s,或触发 drain 后 2s 无 result ⇒ `tern plugin reload`(协调者实测 tick 从 1 重计,<2s 恢复);被禁那一刻在途的 op 落 §3 恢复(start = 非幂等 HOLD)。

门 `test/window.test.lua`:**结构证据,不是宿主行为复现**——夹具按 hook 记录回调归属、以「不再调用」模型化禁用,验证 start 只在自己的 hook、mirror 与快 op 在别的 hook;不模拟也不声称模拟 Tern 的预算终止。live 门 = `bridge-smoke.sh`(#1032-D)。start 异步化仍是更深的后续。

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

- **机制**:title `agenthop tern patrol`、`when="every 1m"`、`check=<sentinel.luau 源>`。`check` 是自包含 Luau 源,返回 `function(ev, cx, state)`;返回 nil=静默(无模型轮次),返回字符串=直接显示(仍无模型)。
- **挂哨(r9,#1036)**:**插件内不再调 `tern.carly.schedule`**——单次 schedule 在命令 hook 内现网超 50ms(12:21/12:24),禁 hook 至 reload。挂哨由**蜂群侧 CLI** 完成:`arm-schedule.sh` = `tern ctl carly task add <JSON>`(**`#` 必须转义为 `\u0023`**,ctl 把 `#` 当注释截断参数;空白/换行无碍)。tern 0.8.3 的 `ctl carly task` 只有 add,无 list/cancel,所以列举与取消**留在插件**(都便宜:`tasks()` ~2.2ms):`arm-scan`(只读,写 sentinel.json `{step:"scanned", ids, count, scheduled=(count==1)}`,兼作 add 后的核验——**只认 tasks() 不认 ctl 的 ok**)、`arm-cancel-next`(r11,**零参数零 kv**:读上次 arm-scan 写进 sentinel.json 的 ids,**保留最新一个**(id 最大者),取消其余中最小的一个,改写 sentinel.json `{step:"cancelled-one", id, ids, count}`;**取消失败保留义务** step=cancel-failed、ids/count 不变;sentinel.json 读不到/无 ids=cancel-unknown 不推进;已 ≤1 个=cancel-idle;状态写失败返回失败不报推进)。r11 删掉了旧的 `arm-cancel` + kv `bridge.arm_cancel_id` 路径:桥的数据目录只许桥写,进程外直写 kv.json 与 VM 内 `tern.kv` 并发会撕裂。`arm-schedule.sh`(r12):清旧 sentinel.json 失败(非「本来就没有」)⇒exit 1 零 add〔BTF-ARM-FRESH〕;`count` 必须是 JSON 非负**整数**原值,`false`/`0.9`/`"0"`/负数/null 一律 UNKNOWN、exit 1、零 add,绝不洗成 0〔BTF-ARM-COUNT〕。序列(蜂群 #1033 扫,每次 load/reload 后):`arm-scan` → count>1 则循环 `arm-cancel-next` 直到 count==1 → count==0 则 `arm-schedule.sh`(它自己先扫、count≠0 即拒,add 后再扫要求 count==1)。幂等按 title:count==1 即已挂,不再 add。
- **读法**:`cx.session:read(pane, {as="table", lines=N, scrollback=true})` 取 agent pane 的尾 N 行。**r9:每轮至多一次 read**(单次 ~23ms,lines=1 亦然;原 batch 4 ⇒ 每轮 ≈90ms,自建任务两轮均 `schedule exceeded 50 ms`),N≤24;元数据扫(`panes()` ~0.17ms)每轮仍覆盖全部 pane,正文按 pane 轮转。**一读两用**:读到的 lines 交给可选纯函数 `classify(lines, title)`(#1041,与 f32a0507 对齐的接口),结果记在 state.class,不另读。
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
  - OSC 必须到 pane 的 PTY。**r9 订正(spike #1037 @b01c1f0,`docs/research/tui-osc-hooks-spike.md` raw/ 证据)**:Claude Code 跑 hook 时**无控制终端**,写 `/dev/tty` 14/14 失败——旧默认从未到达 Tern,A3 发端一直是哑的;沿父进程链找第一个有 tty 的祖先(`ps -o tty= -p`,即 TUI 自己的 `/dev/ttysNNN`)12/12 成功。默认改为该祖先 pty,找不到才退 `/dev/tty`;`AGENTHOP_OSC_TTY` 覆盖保留(夹具据此捕获)。
  - **可信信号只有 alert**(spike 事实):OSC 2 标题约 1 秒内被 Claude TUI 重绘覆盖,不能作持久信号;进度 OSC 不作承诺。另:OSC 777→`pane.alert` 粘住不清(Stop / 9;4;0 都不清)——读端须按边沿/去重处理,勿把持续 alert 当新事件。
  - **仅在 Tern pane 内发**(`$TERN_PANE` 有值);herdr/其它终端席位是 no-op ⇒ 全席可挂,安全。
  - 注册见 `osc-alert-hook.settings.json`(Notification/Stop/SubagentStop/UserPromptSubmit 四事件)。
- **读端(reader)**:A2 `sentinel.luau` 的 `scan_pane` 增一型 `osc_alert`:`p.alert == true` 即写入告警流(耐久文件 + Carly 字符串,同 §7 双路)。
- **夹具**:`test/osc-hook.test.sh`(四事件 → 正确 OSC、未知事件无输出、无 TERN_PANE no-op);`test/sentinel.test.lua` 增 `osc_alert` 两例(alert=true 折入 / alert=false 不发)。
- **关系**:ACP 块席位(迁移主路)天然有 waiting_input+surface;OSC 9;4 通道是**裸 TUI 席的次优信号路**,让它们也进 A2 的"需要人"流,不必解析屏幕。

## 9. A2 r2 增补(dormant,atop 冻结 tern 批)

四件,免模型纪律照旧,各带牙(夹具 `test/sentinel.test.lua` + `test/cpa-probe.test.sh`):

- **① 互盯 beat(#924:存活证明落 L0 文件,互读文件不互读进程)**:beat 合同 = **裸 epoch 秒、一行文本、宿主 wall-clock**(`os.time()`,非 `tern.now()` monotonic——跨程序相减必须同一 wall 时基)。哨兵每轮写 `<L0>/carly-patrol.beat`(`<epoch 秒>\n`,我的存活;蜂群 8 分钟循环读,>20min 过期=我被停/Tern 关→接管+TG 兜底);同轮读 `~/.agenthop/swarm/coordinator.beat`(**不在 L0 根下**:协调者扫箱循环在钉死的合同路径写它,写者/读者/知识包 §5 同一字面值;裸秒,`tonumber` 去空白),过期(wall 秒龄 > `coordinator_stale_sec`=20*60)→ `coordinator_stale` 告警;坏载体(空/非数字/旧 JSON)→ 不报不崩。对称:我盯协调者、蜂群盯我,都靠 L0 文件。(stall/性能的时长计时仍用 `tern.now()` monotonic,不改。)
- **② 预算拆分**:每轮只 body-scan `batch_size`(4)个 pane,偏移轮转(`state.scan_offset`),防单轮读超时;**但 metadata 清扫覆盖全 pane 每轮**(osc_alert + proven-idle 停滞钟重置不受分批延迟)。牙=分批覆盖完整性(偏移不前进→有 pane 永不覆盖→RED)。
- **③ L0 告警路径**:`l0_root()` 占位常量 + `TODO(M2-a 投影契约)`;告警文件在 `<L0>/alerts/`,**TG 直接从文件取,不经 Carly**。
- **④ W3 CPA 探针(`cpa-probe.sh`,蜂群侧 bash,独立于 Carly/哨兵)**:CPA 管家自己挂了投不了箱⇒蜂群直探。探**无鉴权健康路由 `/healthz`**(2s 超时;`/v1/models` 是鉴权门,无 key 恒 401——ACP 试点实测,旧「非 200=DOWN」会把它误报成 CPA 挂=假警报族,F1 根治)。**三态(F1)**:完整 `200`=UP;**传输失败**(curl 非零退出 / 无连接 / `000`)=DOWN;其他完整 HTTP(401/404/5xx)=UNKNOWN。**判序要紧(F1 r2 / F1-CURL-RESULT):先判传输失败,再确认 UP**——`200` 只是头,传输仍可能截断(rc18)或读超时(rc28)而 `%{http_code}` 仍为 `200`;带非零 curl 退出的 200 绝不读作 UP、绝不清警(与 CS-OUTBOX-ONCE 同课:单信号 OK≠全链 OK;200 是头的事,rc 是整条传输的事)。**连续 3 次 DOWN**→写 `cpa_down` L0 告警;一次 **UP**(完整 200)→清 streak + 删告警(恢复即清);**UNKNOWN=纯空操作**(exit 4:不进 streak、不清告警、不碰 state)。streak 落 `<L0>/cpa-probe.state` 跨轮持久。牙=3 连击(第 1/2 次不报)+ 恢复清 + 状态码×退出码矩阵(200+rc0=UP / 200+rc18 / 200+rc28=DOWN / 401=UNKNOWN)。注入口:`AGENTHOP_CPA_PROBE`(hook exit 0=up/2=unknown/其他非零=down)、`AGENTHOP_CPA_HTTP`(注入 HTTP 码)、`AGENTHOP_CPA_RC`(注入 curl 退出码,测矩阵)、`AGENTHOP_CPA_URL`。退出码:`0` up+clean / `1` down+advanced / `2` down+state-unavailable / `3` persist/cleanup incomplete / `4` probe UNKNOWN。

状态/新 L0 产物:`<L0>/carly-patrol.beat`(我写)、`~/.agenthop/swarm/coordinator.beat`(我读,协调者写;非 L0)、`<L0>/cpa-probe.state`(bash 探针)、`<L0>/alerts/{osc_alert,content_filter,permission,stall,coordinator_stale,cpa_down}-*.json`。

## 10. 裸 TUI 读屏分类器(#1041)

给 Tern 里的**裸 TUI 块**(非 ACP)一个 idle/working/blocked/unknown 状态。**适用面(两壳合一拓扑,master-plan §I @96cbe6e):只用于住在 Tern 里的裸 TUI 块;住在 herdr 里的 TUI worker 用 herdr 自带分类器,ACP 块有真状态——两者都不跑这个。**

- **来源(诚实标注)**:`classify.luau` 的规则引擎与区域函数、`manifests.luau` 的 17 份规则数据,**直接翻译自 herdr**(本地克隆 `~/Dev/herdr`,commit `31c77f3`:`src/detect/manifest.rs` + `src/detect/manifests/*.toml`)。herdr 许可 = **AGPL-3.0-or-later**(见其 `LICENSE`)。user 2026-10-15 亲裁「翻译原文,不要管 AGPL 风险」;此处是归属说明,不是风险评估。`manifests.luau` 由 `tools/gen-manifests.py` 从 TOML 生成,不手改。
- **接口(纯函数,一读两用)**:`classify(lines, title, program[, progress]) → {state, rule, agent, skip_state_update}`。不自己读屏(`cx.session:read` ~23ms/pane);由哨兵每轮读一个 pane 后把 `lines` + PaneInfo `title` 交进来。`program` 选 manifest(herdr `parse_agent_label` 同表 + `…/claude/versions/<semver>` 原生路径);认不出 ⇒ `unknown`。
- **语义 = herdr**:每条规则在自己的区域上求值,**最高 priority 胜**(同分取文件序先者);无规则命中且 agent 已知 ⇒ `idle`(herdr fallback)。`contains` 不分大小写子串。`regex`/`line_regex` 用内置匹配器:**r3 起为线性时间 Pike VM**(无回溯;实际 opencode 模式在 24×234 非命中屏上从 ~2.6s 降到 ~0.02s),`\s \w \d \p{Alphabetic}` 为 **Rust regex crate 的精确码点表**(`uclasses.luau`,由 `tools/gen-uclasses.py` 经 ripgrep 14.1.1 生成,不手改),不再近似;`\p{L}` 等无精确表的类直接拒绝编译。对 ripgrep 差分:33 个实际模式 × 500 个含 Unicode 空白/全角标点/符号的输入 = 16500 例零差异;主审的 67 例 state 对照零差异。
- **agenthop 叠加规则(非 herdr,单独列在 `classify.luau` 的 `OVERLAY`)**:Claude Code 2.1.293 在 Tern 里**工作时 OSC 标题转圈是 ◐/◑(U+25D0-25D3),不是 herdr 规则期待的盲文**;没有这条,工作中的屏(❯ 输入框一直画着)会被 `live_prompt_box` 判成 idle。叠加 `agenthop_osc_title_halfcircle_working`(priority 1100,region osc_title)。
- **写文件授权框(叠加规则,协调者裁 #1041)**:2.1.293 的写/改文件授权框文案是「Do you want to create X?」/「…make this edit…?」,不含 herdr `generic_permission_prompt` 要的「do you want to proceed?」⇒ 该规则不中、只剩 300 分兜底。授权框判 blocked 是哨兵最要紧的一类(F44-⑩/F57),故加 `agenthop_file_permission_dialog`:priority **840**,region after_last_horizontal_rule,要「do you want to」+「esc to cancel」+ 同时有带号 yes 行与带号 no 行。**恰好 840 不更高**:同分时先求值者胜,叠加规则排在 manifest 之后,所以 herdr 自己的「proceed?」框仍归 `generic_permission_prompt`(夹具钉住这条平局)。
- **硬上限(r3)**:单次 classify 超 `BUDGET_MS`=5ms(规则之间与匹配器内部每 64 字符各查一次时钟)即返回 `state=unknown, rule=slow`——哨兵把 unknown 当「本轮无新信息」,不当 idle;真错误(坏模式)照常抛出,不伪装成 slow。Tern 真 VM 实测:实际 opencode 最坏屏 ≈5.1-6.1ms 返回 slow(r2 无上限时会撑爆 50ms)。
- **预算(Tern 真 VM 实测,单 hook 单次)**:规则按「priority 降序、同分文件序」排好后**首个命中即停**——与 herdr 的全扫取最高分结果相同(随机 16000 例差分零差异),但贵的低分规则(`legacy_no_prompt_blocker` 整屏正则)在高分规则已中时不再跑。24 行 tail:idle ≈ 0.63ms、working ≈ 0.12ms、blocked ≈ 2.4ms(r3 精确码点表+Pike VM)(<3ms 门;blocked 仍最贵,因它排在 840 之下的规则全要先试一遍)。一个 hook 里连跑多次会累计撞 50ms——哨兵每轮只分类它读到的那一个 pane。
- **夹具** `test/classify.test.lua`(76 检):5 份**真实** Claude TUI 截屏(`test/fixtures/tui/`,2026-10-15 Tern pane 采集:idle×2 / working×2 / blocked×1)+ herdr claude 规则各族合成屏 + 两条 `not` 门 + 区域函数 + 正则子集 + 选 agent。mutant:`MUTANT=no-prompt-box`、`MUTANT=no-title-working`、`MUTANT=no-write-dialog` 各 RED;生产码 mutant(`\b` 失效、最高分→首命中)各 RED。
- **接线**:写 `agents.json` 每席 `screen_state` 由哨兵做(Platform Dev r9 的一读两用钩),本件只交纯函数。

## 11. #1057 — TUI 席子代理可见性钩子(`agenthop hook subagent`)

- 事件:SubagentStart / SubagentStop / PermissionRequest ⇒ 父席耐久箱一条 fyi;PermissionRequest 另经祖先进程 pty 发 OSC 777(仅 `TERN_PANE` 存在时)。注册见 `subagent-hook.settings.json`(并入席级设置,非全局)。
- 收件人只取 `SWARM_PARENT_SID`;未设 ⇒ SKIPPED 不写。投递走 `writeSessionInbox`:非 session UUID 或本机无 `presence/<sid>.pid` ⇒ 拒收,不建孤箱。**目标来自外部输入(环境变量、钩子负载、命令行)的调用方用 `writeSessionInbox`;`writeInbox` 保持原样,供 `approvals:<sid>` 等合法非会话箱使用。**
- 去重键:`tui-sub-<start|stop>-<seat8>-<agent_id>`;`tui-perm-<seat8>-<tool_use_id|事件秒>`(Claude Code 2.1.293 不给 tool_use_id ⇒ 每席每秒至多一条权限消息,已知上限)。
- 永远 exit 0;每次结果一行日志 `~/.agenthop/logs/subagent-hook.log`(`AGENTHOP_SUBAGENT_HOOK_LOG` 可覆盖)。
- 时延:`bin.ts` 见 `hook subagent` 即只载 `hook-entry.js`(不载完整 CLI 模块图)。目标 **< 200ms / 次**。实测(2026-10-15,macOS arm64,bun --compile 单二进制,21 次中位):本钩子 ~90ms;拆分前 ~117–135ms;空程序编译底 ~18–36ms。余量主要是编译二进制解析整包的固定开销。

## 12. #1115 T1b — TUI 席屏状态(`screen` 命令 + 发布状态机)

- **谁读、读几个**:window 插件新增命令 `screen`(自己的 hook,与 mirror / drain 的 50ms 预算互不影响)。每次运行**只读一个 pane**(`cx.session:read`,约 23ms),在本窗口里 `classify.agent_for(program)` 认得的、未退出的 pane 之间轮转;`tern acp` 块的 program 是 "tern",不算。sweep 在每个到达桥的 tick 里与 mirror 一起触发它(约 5s 一次)。`screen` 失败或被禁用**不算停滞信号**,只会让屏状态变旧,读者据此判为 UNKNOWN。
- **一个 VM 只看得见自己窗口**:有几个 window 就有几个插件 VM,各写 `tern-panes/screens/<vm>.json`(`{vm, window, ts, screens:{"<pane id>": {...}}}`),agents.json 里另带一份 `screens`(本 VM 的)。读者(`packages/bus/src/swarm/tern-screens.ts`)按 pane id 合并,两个 VM 报同一个 pane 时取 observed_at 新的那份。
- **发布状态机**按上游 herdr 143bf5f `src/pane/agent_detection.rs`(详见 `UPSTREAM-DETECTION.md` §4,Apache-2.0),常量照搬,时钟用 Tern 的单调钟 `tern.now()`:新 pane 或 agent 变化 ⇒ 发布 unknown,宽限 3000ms;宽限到期的那一次也跳过;working → 普通 idle 先 hold,第 4 个连续 idle 样本或距第一个 ≥700ms 才发布 idle(本桥采样间隔是秒级,通常第二个 idle 样本就因 700ms 上限放行);visible_idle、转 working、转 blocked 立即发布;持续的 visible_blocker 每 ≥800ms 重新发布;`skip_state_update` 不发布并清 hold;visible_* 按状态屏蔽。
- **PTY 字节**:上游在这个 commit **不**把新字节当 working 信号,只用来在 idle 且内容未变时跳过读屏。插件 VM 看不到 PTY 字节,所以本桥每次都读所选的那个 pane;状态结果不受影响。这是有意的差异,不是用屏哈希冒充的 working 信号。
- **每条记录**(读者可见):`state / rule / agent / visible_idle / visible_blocker / visible_working`(已发布的值)、`observed_at`(确认该状态的最后一个样本的墙钟 epoch 秒)、`try / tried_at`(最后一次尝试:ok | grace | held | skip | unreadable | slow | error)。单调钟字段(宽限、hold、refresh 时刻)不对外写出。
- **UNKNOWN**:读失败、classify 超出 5ms 预算或抛错、返回值不对,只改 try / tried_at,已发布的状态不动;从没成功分类过的 pane 没有 state。读者端:没有条目、文件读不出或格式不对、observed_at 早于新鲜度上限、或在未来(时钟回拨)⇒ unknown,**永不当 idle**。
- **预算**:每次运行 = panes() 约 0.2ms + 一次 read 约 23ms + classify ≤5ms(`BUDGET_MS`,超了返回 slow)+ 记录与一次文件写入 ⇒ 远低于 50ms。
- **接口**:按冻结接口 `classify(lines,title,program) → {state, rule, agent, skip_state_update, visible_idle, visible_blocker, visible_working}` 编写;T1a(Model Gateway)合并前,现有 classify 少的几个布尔一律当 false。
