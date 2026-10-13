# Tern+OMP 蜂群席位宿主 — spike 报告(5 件交付,r2)

- 对象: 用 Tern+OMP 的原生 agent 层 `cx.agents` 替代/并行 Herdr 作蜂群席位宿主
- 性质: **纯评估 + 原型,不动产线**。herdr 代码路径一行未改,保留为回退(主审复核:七文件全新增、基线 782 blob 全留、herdr/产线改动 0)。
- owner: `claude:agenthop-f32a0507`;主审: `codex:Work-01a13284`(r1 判回 0P1/4P2/4REMAIN,本稿 r2 应修)
- worktree: `~/Dev/agenthop-wt/tern-spike` branch `spike/tern-migration`
- 可核来源(定点提交外,均在同仓对象库可 `git show`):
  - 图谱 `docs/research/tern-omp-eval.md` **@08351a3**(main,镜 24)
  - **user 亲测 QA** `docs/research/tern-carly-qa-2026-10-13.txt` **@2a5ca5f**(Carly 本机 Tern+omp18.10.3 实测;解了三绿门里两门)
- 日期: 2026-10-13 起;Tern.app 实机 + 主审另在隔离 Tern 0.8.3 headless 复核

## 证据分级(全文标注)

- **【实测】** 本席本会话在实机亲测
- **【user实测】** user/Carly 亲测,入库 @2a5ca5f
- **【文档】** tern.d.luau 类型声明 / `tern ... --help`
- **【推断】** 由 API 形状推断,未跑
- **【未测】** 无人实测

> r1 的教训(已改):别把「omp 证到的」扩张成「所有席成立」,别把「tick 冻结」当成「VM 被阻塞」的因果,别把「环境变量=CLI block id」当成「三方 agent join」。下文逐条按实际证据重写。

---

## 0. 一句话结论(r2 修正)

**omp 席位的 list/状态机制实机可用;但蜂群真正要托管的 claude/codex 裸 TUI,原生 cx.agents 检测【不工作】——不发 OSC 的裸 TUI state 恒卡 "working",无屏幕兜底(user实测)。** 两条可行路径(均【未测】,列入下一步):① Tern 自带 ACP 聊天块(内部通道,能识别权限请求),② 让 agent 自己发 OSC 9;4;4 / 7501。文件-JSON 控制面是**本配置下**我用的 bash 路径(非平台唯一路径——文档另有 window control endpoint)。

---

## 1. ① 状态检测实测(硬前提)

### 1a. omp 席位 —【实测】通过

`cx.agents:list()` 对真 omp agent 的 working/idle 判定正确(证据 `prototype/evidence-agents-list.json`):

```
pane5  [omp/claude-opus-5] state=idle    busy=False at_prompt=True
pane18 [omp/claude-opus-5] state=working busy=True  at_prompt=True   (持续 40s+ 稳定样本)
```

- `busy=True`(OSC 9;4 进度)→ `working`;`busy=False` → `idle`。【实测】
- 这是 omp 的 **TSP 自报**驱动的,不是通用屏幕检测(user实测确认)。
- `at_prompt=True` 在 working 态也成立 ⇒ **不能单用 at_prompt 判等输入**。【实测】+【user实测】
- 边界诚实:这只证了 omp 一类 `program=omp`;**不是** OSC/TSP 来源的隔离因果实验。

### 1b. waiting_input —【user实测】已解(我自己没测到,原因见下)

本席想用脚本合成 OSC 9;4;4 证 waiting_input,但 `start` 请求停住了镜射(见 §2),合成路径没走通,故 r1 只能记「未观测」。**user QA @2a5ca5f 直接给了答案**:

- omp 自调 ask 工具 → `waiting_input`(~16s,`alert=true`,progress indeterminate)。【user实测】
- **任何程序**发 `OSC 9;4;4`(paused)→ `waiting_input`;清 `9;4;0` → 回 working。复现:`printf '\033]9;4;4;50\007'` / `printf '\033]9;4;0\007'`。【user实测】
- **第三方 TUI 画的权限弹窗,若不发 OSC 9;4;4 / 7501,则不触发**——纯文本 "Allow this tool? [y/n]" 实测 state 恒 working,**无任何屏幕内容兜底**。【user实测】
- 即文档 "paused progress or an ask overlay" = (a) OSC 9;4;4,(b) omp 的 ask 覆盖层(经 TSP)。

### 1c. claude/codex 裸 TUI —【user实测】= 负面结论

- 非 omp agent 的 state 只有粗粒度:**进程在跑 = "working",从不变 idle**(busy/at_prompt 恒 false);不发 OSC 的裸 claude/codex **卡死 "working"** 直到进程退出(退出后行从 list() 消失,无 "exited" 行)。【user实测】
- 非 omp:`wait()` 恒超时("agent_wait timed out"),`transcript()` 返 {},`model`/`last_message` 字段缺(其余 pane/state/busy/at_prompt/... 都有)。【user实测】+【文档】
- **结论**:omp 的 parity **不外延到裸 TUI**。要给 claude/codex 做状态/权限检测,原生 cx.agents 不够,须走 §6 的两条路径。

---

## 2. ② agents-bridge 原型

代码 `prototype/tern-agents-bridge/{plugin.toml,window.luau}`。薄 shim:把 `cx.agents` 镜射到文件-JSON 控制面(tern.fs,CTL=`~/.agenthop/tern-panes`)。

- STATUS 镜:`agents.json` ← `cx.agents:list()`,poll-loop(`tern.sleep():next` 自重排——裸 `tern.timer` re-arm 会拿 nil cx 害死循环,这条是【实测】踩过的)。
- REQUEST 面:`requests/<id>.json` → `results/<id>.json`。

### 2a. 实测通过

- link/reload 干净(ready,problems 空);镜射持续更新(tick 前进);真 omp 状态正确(§1a)。【实测】
- `{"op":"list"}` 往返:请求被认领删除 + 写回 `{"ok":true,...}`。【实测】

### 2b. 认领模型(review TERN-1 修复)

r1 的桥**在被忽略的 pcall 里 remove、只凭读成功就执行**,主审五组复现:remove 失败双执行、read EIO 零执行、answer 写失败无从确认。**已改**(`window.luau` drain):

- **执行只在 remove 成功后**(remove=认领;POSIX unlink 原子,两 VM 同读只有一个删成功,输者 ENOENT 跳过)。
- **读失败绝不删**,留给下一 tick。
- **这是 at-most-once/认领,不是崩溃安全的 exactly-once**:tern.fs 无 rename/O_EXCL(类型声明里没有),claim 与写结果之间崩溃会丢该结果。**恢复义务在 bash 侧**:等够时限仍无 `results/<id>.json` = UNKNOWN(换新 id 重发),绝不当「已执行」。remove 遇 EACCES = 卡住但不执行(安全方向,不双跑)。
- **不再声明 exactly-once。**

### 2c. start 停摆 —(review TERN-3 重新定界,撤回因果)

r1 写「cx.agents:start 同步阻塞冻住 VM」= **超证据,已撤**。实际证据链:

- 我的记录:**空 prompt 的 bash start 是参数报错**(tick 从 53 推进到 78);**tick 80 两次不变无结果的是另一条非空 prompt、默认 OMP 的 start**;且该记录里还留着旧草稿 go.json,不能当最终 drain 执行证据。
- 主审在**隔离原生 Tern 0.8.3 headless** 注册了同 start API 的 palette action(本地 /bin/sh,不调模型):action 的 before 写了、agent 块建了,但 after 缺失,日志明说 **`command start exceeded 50 ms` / `disabled until reload`**;三个独立 stats 请求都成功。
- 故:**action 上下文也会超 50ms 预算**;「tick/记录不动」**无法单独区分**预算退出 / 插件禁用 / 异常 / 持续同步阻塞。
- **可保留的只有观测**:从状态 poll 调 start 会停住镜射(start 不该放进状态 poll);`list()`(只读)在 loop 里安全——这是唯一在此证到的路径。主审也没拿到有效的原生 poll-start 复现。

### 2d. 控制路径定界(review TERN-3)

- `tern ctl`/`tern carly` 在我这台需 `tern serve`(app daemon 没暴露)——所以我用了文件-JSON 面。但**文档明确支持带 control endpoint 的 window**,故「必须 serve / 文件面是唯一 bash 路径」**限定为本测试配置的选择**,不是平台能力结论。【实测】+【文档修正】
- 多 window 各跑一份 window-half ⇒ 多 mirror 抢写同一 agents.json(对状态镜幂等无害;对 request 因 remove 认领安全)。生产可选单 window 主导或按 window key 分文件。【实测】

---

## 3. ③ sid→pane 映射 hook

代码 `prototype/sid-hook.sh` + `.settings.json`。SessionStart hook 读 stdin JSON + `$TERN_PANE`,JSON 编码器序列化 + 往返相等校验后原子落盘。

### 3a. JSON 编码(review TERN-2 修复)

r1 用 printf 拼 JSON,cwd 含引号/反斜杠/换行即写坏且 exit 0。**已改**:用 json 编码器 + 往返相等检查,校验不过就不写(宁缺毋错)。四类输入实测:普通 / 引号+反斜杠 / 真换行 / 字面反斜杠-n 全部正确往返;缺 TERN_PANE → pane=null。【实测】

### 3b. id 关联 —(review TERN-4 重新定界,agent-join 留待验)

- **两路观测(【实测】)**:同一普通 shell pane 的 `$TERN_PANE`(如 103079215106)=== `tern ls --json` 的 block id。这只证**该 shell 环境值与 CLI 一致**。
- **【推断】**:类型声明把 `AgentBlock.pane` 与 agent 参数都叫 pane id,支持「同一命名空间」的接口推断。
- **【未测,待验】**:定点提交的 agents-list 只有 pane 5/18,**没有**那个大编号;hook 测试是宿主侧手设 TERN_PANE + 合成 SessionStart JSON。**同一个真 agent 的「环境值 + cx.agents 条目 + CLI block」三方同期 join 没做**,生命周期/重启稳定性也没测。r1 的「join 钉死/跨重启」**已撤**。
- 类型规整:hook 原输出 pane 为字符串、list 为数字——**已在 TERN-2 修复里把 pane 规整为数字/ null**,消除 join 的类型错配。

---

## 4. ④ 五命脉 → tern 等价映射表

验证列严格分级。

| 命脉 | herdr 机制 | tern 等价 | bridge/CLI | 验证 |
|---|---|---|---|---|
| **巡检点名** | agent list / 读屏 | `cx.agents:list()` → agents.json `state/busy/at_prompt` | **bridge** | 【实测】omp idle/working |
| **inbox-wake ping** | writeInbox 成功 → ping pane | `tern run <pane> '<nudge>'` 键入;或 `cx.agents:ask` | CLI / bridge | `tern run` 基本可键入【实测弱】;`--pane` 旗实测报错;ask 执行结果【未测】 |
| **F48/F45 继任** | 检测死 → 新席领养 | 检死:list `alive=false`(非 omp 是行消失,无 exited);起席:`start` 或 `tern new tab` | bridge+CLI | 检死【user实测:行消失】;`tern new tab`【实测】;start【见 2c 不定】 |
| **F44 读屏** | 读 pane 屏 → 识别卡点 → HINT | `tern capture <pane> --scrollback [--surfaces]` | **CLI** | 【实测】但仅捕获**普通 shell marker**,非 omp/非 alt-screen TUI |
| **fleet-recovery** | 一命令带回全员+在途+断点 | daemon 侧 pane 存活;list 重发现;③hook 重建 sid→pane | bridge+CLI+hook | 单机 list 重发现【推断】;多机 fleet【未测】 |

读屏补注:lenses 看不了 alt-screen 是 **lenses** 的限制;`tern capture` 抓终端 surface,但我只在**普通 shell** 上验过,OMP/alt-screen TUI 的 capture **未测**。

---

## 5. ⑤ seat-driver 接口草案

四函数,herdr/tern 双驱动,按席位 config `host` 选 —— 回退地基。各函数标 tern 侧证据强度。

```ts
type SeatState = { state: "idle"|"working"|"waiting_input"|"exited"; busy?: boolean;
                   cwd?: string; model?: string; lastMessage?: string };

interface SeatDriver {
  // 巡检。tern: 读 agents.json 该席 pane 条目。【实测:omp】【未测:裸 TUI 恒 working】
  status(seat: Seat): Promise<SeatState>;
  // 派话/唤醒。tern: cx.agents:ask(bridge) 或 `tern run <pane>`。【实测弱:run 键入】【未测:ask 执行】
  send(seat: Seat, text: string): Promise<void>;
  // 读屏。tern: `tern capture <pane> --scrollback --surfaces`。【实测:普通 shell】【未测:TUI/omp】
  read(seat: Seat, opts?: { lines?: number }): Promise<string>;
  // 等 idle。tern: cx.agents:wait(bridge,:next) 或 `tern wait --until idle=MS`。【文档】【未测:非omp 恒超时(user实测)】
  wait(seat: Seat, opts?: { timeoutMs?: number }): Promise<string | null>;
}
```

- 席位 config `host:"herdr"|"tern"` 选驱动;异常降级回 herdr = 闭测期风险闸(「herdr 不删」的兑现点)。
- tern driver 的 `send`(若用 ask)与继任的 `start` 受 §2c 约束:走 action 上下文或独立 window,不进状态 poll。
- **裸 claude/codex 席的 status 目前拿不到 idle/waiting_input**(§1c),此接口在裸 TUI 上只有 herdr 驱动可用,tern 驱动须等 §6 两路之一落地。

---

## 6. 替代判决(r2 重写)

| 维度 | omp 席 | claude/codex 裸 TUI 席(蜂群实际需要) |
|---|---|---|
| working/idle | ✅【实测】+ TSP 自报 | ❌ 恒 "working",无兜底【user实测】 |
| waiting_input | ✅ ask/OSC 9;4;4【user实测】 | ❌ 弹窗不发 OSC 不触发【user实测】 |
| wait/transcript | ✅ | ❌ 超时 / {}【user实测】 |

- **omp 席**:能力 herdr 同级,原型跑通。可立即并行试用。
- **裸 TUI 席**:原生 cx.agents **不够**。两条路径(均【未测】,=下一步):
  1. **ACP 聊天块**(`agents.auto_acp` / 调色板 "New Claude Code block"):claude/codex 状态走 Tern 内部通道,二进制含 "has a question / wants plan approval / needs your permission" 横幅文案 ⇒ **权限请求会被识别为「需要你」**。**最值得先试的一条。**(user QA 明说未实测)
  2. **OSC 7501 / 9;4;4 自发**:让 agent wrapper 主动发状态(changelog 称 omp/agent chats/会说 7501 的工具显示 working/waiting/finished/failed,"locally or over SSH")。7501 完整字段语法无文档(只确认过 `state=clear`)。

### 三绿验收门(r2 更新)

1. **waiting_input**:✅已解(user实测)——但结论是「裸 TUI 弹窗不触发」,故门①的真正通过条件 = ACP 块或 OSC 自发之一落地。
2. **裸 TUI OSC**:✅已解(user实测)——负面(恒 working)。同上。
3. **多机 fleet**:❌仍【未测】。user 只有本机单 host;线索:list 行有 `host` 字段(本机=0),OSC 7501 "over SSH" 可用,start 的 `~` 按 launch host home 展开(但 opts 无 host 字段,无指定远端办法)。待有远端环境实跑 `cx.agents:list()` 看 host 字段。

### 其它押注因素

- **CLI 无 agents 命令**(【user实测】`tern: agents: No such file`);桥插件是现状唯一 bash 路径之一,官方是否出 CLI 未知 ⇒ 桥寿命有不确定性。
- **headless/CI**:`cx.agents` 是 Window-only;headless(`tern serve`)无启 omp/agent 入口,settings 只在内存。**CI 无法用 cx.agents**,自动化只能 `tern new/run/send/wait` 或直接跑 omp CLI。【user实测】
- **API 稳定性**:无 cx.agents/插件 API 稳定性承诺;changelog 多条 "Plugins: ..." 行为变更(如 cx.canvas 对未知字段改报错)⇒ 建议桥对字段 nil 容错 + 钉版本 + 升级回归测 ①②③。【user实测】
- Tern=闭测(TERN_AUTH_URL)=基础设施押注 ⇒ herdr 回退保留(本 spike 0 改 herdr)。

---

## 7. 交付物 + r2 修复对照

| 件 | 路径 | r1→r2 |
|---|---|---|
| ① 状态实测 + 证据 | §1 + `prototype/evidence-agents-list.json` | omp 证据保留;waiting_input/裸TUI 由 user QA 补实(负面);分级标注 |
| ② agents-bridge | `prototype/tern-agents-bridge/` | **TERN-1** 认领改 at-most-once(remove 门控+读失败不删+撤 exactly-once);**TERN-3** start 因果撤回、控制路径定界 |
| ③ sid hook | `prototype/sid-hook.sh`+`.settings.json` | **TERN-2** JSON 编码+往返校验;**TERN-4** pane 规整为数字、三方 join 降为待验 |
| ④ 映射表 | §4 | 验证列严格分级;capture 仅普通 shell;`run --pane` 报错如实 |
| ⑤ seat-driver | §5 | 每函数标证据强度;裸 TUI 席仅 herdr 可用 |

**实测确认的 tern 原语**:`tern plugin link/unlink/reload/list --json`、`tern ls --json`、`tern new tab [--keep-open --cwd -- CMD]`、`tern run BLOCK CMD`(键入;`--pane` 旗不存在)、`tern capture BLOCK --scrollback --surfaces`(普通 shell)、`tern close BLOCK`;Lua:`cx.agents:list`、`tern.fs.{read,write,list,exists,mkdir,remove}`、`tern.sleep():next`、`tern.json.*`、`tern.getenv`、`tern.now`。
**未由我执行**:`cx.agents:{ask,wait,start,transcript,interrupt,stop}` 的成功执行(start 见 2c;ask/wait 结果未取到);capture 对 omp/alt-screen;多机 fleet。这些有的在 user QA 里有答案(wait/transcript 非 omp 的负面),其余列【未测】。
