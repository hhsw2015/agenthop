# Tern+OMP 蜂群席位宿主 — spike 报告(5 件交付)

- 对象: 用 Tern+OMP 的原生 agent 层 `cx.agents` 替代/并行 Herdr 作蜂群席位宿主
- 性质: **纯评估 + 原型,不动产线**。herdr 代码路径一行未改,保留为回退。
- owner: `claude:agenthop-f32a0507`;审查席: codex:Work 主审;派单依据 user 亲令「开工」(镜 24 终判后)
- worktree: `~/Dev/agenthop-wt/tern-spike` branch `spike/tern-migration`(基线 main 57c13ea)
- 前置: [tern-omp-eval.md](tern-omp-eval.md)(镜 24,cx.agents 原子图谱)
- 日期: 2026-10-13;Tern.app 实机(daemon 运行中,2 window:Default/work),omp v18.10.3

---

## 0. 一句话结论

**核心机制实测可用、原型已跑通、五命脉全部可映射;两条诚实边界(`waiting_input` 态 + claude/codex 裸 TUI 作 agent)未证,是切换前的验收门。** 文件-JSON 控制面(tern.fs)是 bash 蜂群对接运行中 Tern.app 的正确路径(不依赖 `tern serve`)。

---

## 1. ① OSC 9;4 覆盖实测(硬前提)

### 已证(实机数据,证据 `prototype/evidence-agents-list.json`)

`cx.agents:list()` 对**真 omp agent**的状态判定正确,状态源 = pane 的 `busy`(OSC 9;4 进度):

```
pane5  [omp/claude-opus-5] state=idle    busy=False at_prompt=True
pane18 [omp/claude-opus-5] state=working busy=True  at_prompt=True   (持续 40s+ 稳定)
```

- `busy=True`(OSC 9;4 进度活跃)→ `state=working` ✅
- `busy=False` → `state=idle` ✅
- `cx.agents:list()` 返回的字段比 `tern.d.luau` 的最小 `AgentBlock` 类型**更富**(合入了 PaneInfo:`busy/at_prompt/kind/focused/tab/alert/alive/model/program/session/last/running`),对检测是利好。

### 诚实边界(未证,= 验收门)

1. **`waiting_input` 态未观测到**。镜 24 说它来自「paused progress(OSC 9;4;4)或 ask overlay」。本 spike 想用脚本合成 OSC 9;4;4 来证,但 `cx.agents:start` 对非 agent 命令(裸 bash)阻塞了 window VM(见 §2 finding),合成路径没走通。注意:`at_prompt=True` 在 working 态也成立 ⇒ **`at_prompt` 单独不是 waiting_input 的触发器**,不能拿它当「等输入」判据。
2. **两例都是 `program=omp`**。omp 是 TSP-native,状态检测有 TSP + OSC 双保险,稳。镜 24 真正担心的是 **claude/codex 裸 TUI(经 agent-command 配置)是否发 OSC 9;4、其权限弹窗是否 → waiting_input** —— 本 spike **未测**(需配 agent-command 并让 claude/codex 在 Tern 上下文内认证,是闭测期依赖最重的一环)。这条仍是镜 24 §3 点名的头号未知。

**结论**: omp 席位的 working/idle 机制实测通过;`waiting_input` + 裸 TUI 两项是切换前必过的验收门,不验不切(与镜 24 判决一致)。

---

## 2. ② agents-bridge 原型(已跑通)

代码: `prototype/tern-agents-bridge/{plugin.toml, window.luau}`(window.luau 121 行含注释,逻辑 ~65 行)。

形态: **薄 shim,零自有检测逻辑** —— 只把 `cx.agents` 镜射到文件-JSON 控制面,风格仿 herdr。

- STATUS 镜: `<CTL>/agents.json` ← `cx.agents:list()` 每 750ms(poll-loop,`tern.sleep():next` 自重排)
- REQUEST 面: bash 写 `<CTL>/requests/<id>.json {op,...}` → bridge remove 认领(原子)→ 写 `<CTL>/results/<id>.json`
- `CTL = $HOME/.agenthop/tern-panes`

### 已证

- 插件 link/reload 干净(`status:ready, problems:[]`),window-half 装载即起循环。✅
- 镜射实测:agents.json 持续更新(`tick` 字段证活),真 omp agent 状态正确(见 §1)。✅
- 请求往返实测:`{"op":"list"}` → `{"ok":true,"agents":[...]}`,请求被 remove 认领一次。✅

### 关键 finding(影响生产设计)

1. **`cx.agents:start` 是同步阻塞,会冻住单线程 window VM**。从 poll-loop 调它,镜射直接停摆(`tick` 不再前进)。`list`/`ask`/`interrupt`/`stop` 快;`wait` 经 `:next` 异步不阻塞。**生产设计**:长阻塞的 mutating op(尤其 start)应走 user/palette 的 action 上下文(`tern.command`)或一个独立的「非镜射」window,不能塞进状态 poll。`list`(镜射)只读、放 poll 里安全 —— 已证。
2. **start 参数校验**:prompt/cwd/command 三者不得为空(实测报错 `agent command, cwd and prompt must not be blank`)。
3. **多 window 各跑一份 window-half** ⇒ 多个 mirror 抢写同一 agents.json(stomp)。对状态镜无害(同一全局视图,幂等);对 request 安全(remove 原子认领,只有一个赢)。生产可选:选一个 window 主导,或按 window key 分文件。
4. **`tern ctl`/`tern carly` 需 `tern serve`**(app daemon 不暴露)⇒ 文件-JSON 面(tern.fs)是对接运行中 app 的唯一 bash 路径,选对了。

---

## 3. ③ sid→pane 映射 hook(已测)

代码: `prototype/sid-hook.sh` + `prototype/sid-hook.settings.json`。

- Claude Code SessionStart hook,读 stdin JSON 的 `session_id`/`cwd` + 环境 `$TERN_PANE`,原子写(temp+rename)`<CTL>/sid/<sid>.json`。
- **机制已实测钉死**:`$TERN_PANE`(如 `103079215106`)=== `cx.agents:list()` 的 `pane` 字段 === `tern ls --json` 的 block `id`,**同一 id-空间**(早期 pane 是小数 5/18,新建的是大数,仅数值大小之别)。所以 swarm 读 `sid/<sid>.json` 的 pane,直接在 bridge 的 agents.json 里查到同一条,join 成立。
- 实测两路:带 `$TERN_PANE` → `{"sid":...,"pane":"103079215106",...}`;不带(herdr/他宿主)→ `pane:""` 优雅降级。
- 自报式:会话自己宣告 sid→pane,比外部探测好 —— 终端解耦、跨重启、不刮屏。

---

## 4. ④ 五命脉 → tern 等价映射表

| 命脉 | herdr 机制 | tern 等价 | bridge/CLI | 验证 |
|---|---|---|---|---|
| **巡检点名** | agent list / 读屏判状态 | `cx.agents:list()` → agents.json 的 `state/busy/at_prompt` | **bridge**(poll 镜) | ✅ 实测(omp idle/working) |
| **inbox-wake ping** | writeInbox 成功 → ping herdr pane 唤醒 | `tern run <pane> '<nudge>'` 键入唤醒;或 `cx.agents:ask(pane,text)` 注入 | CLI(`tern run`)轻量;bridge(ask)结构化 | ◐ run 实测可键入;ask 有阻塞风险(§2) |
| **F48/F45 继任** | 检测 holder 死 → 新席领养 | 检测死:`cx.agents:list()` `state="exited"`/`alive=false`;起新席:`cx.agents:start()` 或 `tern new tab` | 检测=**bridge**;起席=bridge(start,阻塞)或 **CLI**(`tern new`) | ◐ 检测路径就绪;start 阻塞 finding |
| **F44 读屏** | 读 pane 屏 → 识别内容过滤/审批卡点 → HINT | `tern capture <pane> --scrollback [--surfaces]` | **CLI**(`tern capture`) | ✅ 实测(捕获 marker) |
| **fleet-recovery** | 一命令带回 dispatcher+成员+在途+断点 | daemon 侧 pane 跨窗口关闭存活;`cx.agents:list()` 重发现;③hook 重建 sid→pane | bridge(list 重发现)+ CLI(daemon 重连)+ ③hook | ◐ 单机重发现就绪;多机 fleet 未验 |

读屏补注:镜 24 说 lenses 看不了 alt-screen TUI —— 那是 **lenses** 的限制,**不是 `tern capture`**。capture 抓的是终端 surface,alt-screen TUI 能抓到当前屏(但 alt-screen 无 scrollback 历史)。`--surfaces` 额外带 TSP surface 文本。

---

## 5. ⑤ seat-driver 接口草案

四函数接口,herdr/tern 双驱动,按席位 config 选 —— 双栈并行 + 回退地基。全部基于已验证原语。

```ts
type SeatState = { state: "idle"|"working"|"waiting_input"|"exited"; busy?: boolean;
                   cwd?: string; model?: string; lastMessage?: string };

interface SeatDriver {
  // 巡检点名。herdr: agent list / 读屏;tern: 读 agents.json 里该席 pane 的那条
  status(seat: Seat): Promise<SeatState>;
  // inbox-wake / 派话。herdr: pane 注入;tern: cx.agents:ask(bridge request) 或 `tern run <pane>`
  send(seat: Seat, text: string): Promise<void>;
  // F44 读屏。herdr: pane screen-read;tern: `tern capture <pane> --scrollback --surfaces`
  read(seat: Seat, opts?: { lines?: number }): Promise<string>;
  // 等到 idle。herdr: 轮询到 idle;tern: cx.agents:wait(bridge,:next 异步) 或 `tern wait --until idle=MS`
  wait(seat: Seat, opts?: { timeoutMs?: number }): Promise<string | null>;
}
```

- 席位 config 加 `host: "herdr" | "tern"`,工厂按此选 driver 实例。
- **双栈并行**:迁移期部分席 herdr、部分 tern,同一 dispatcher 透明调度。
- **回退**:tern 席异常(闭测期不稳)→ 降级回 herdr,席位 config 一翻即可。这就是「herdr 不删」的工程兑现点。
- 生产注意:tern driver 的 `send`(若用 ask)与继任的 `start` 受 §2 阻塞 finding 约束 —— 这两个走 action 上下文或独立 window,不走状态 poll。

---

## 6. 替代判决(更新镜 24)

- **能力**: omp 席位的 list/state/screen-read/wait 全部实机可用,sid→pane join 钉死,五命脉全可映射。与镜 24「herdr 同级」判决一致,且本轮**把图谱落成了跑得起来的原型**。
- **门槛(验收门,三绿才切)**:
  1. `waiting_input` 态实证(含 claude 权限弹窗 → waiting_input)。
  2. claude/codex 裸 TUI 作 agent-command 发不发 OSC 9;4 的实证。
  3. 多机 fleet-recovery 实证。
- **风险**: Tern = 闭测(TERN_AUTH_URL),稳定性/版本节奏未知 = 基础设施押注 ⇒ herdr 代码路径保留为回退(本 spike 一行未动 herdr),seat-driver 的 `host` 开关是回退闸。
- **路线**: ①日常终端可立即并行试用;②蜂群切换走此 spike → 三绿验收门 → 切,期间 herdr 在位。

---

## 7. 交付物清单

| 件 | 路径 | 状态 |
|---|---|---|
| ① OSC 实测 + 证据 | 本报告 §1 + `prototype/evidence-agents-list.json` | ✅ 核心证,2 边界待验 |
| ② agents-bridge 原型 | `prototype/tern-agents-bridge/{plugin.toml,window.luau}` | ✅ 跑通 + finding |
| ③ sid→pane hook | `prototype/sid-hook.sh` + `.settings.json` | ✅ 测通 |
| ④ 五命脉映射表 | 本报告 §4 | ✅ 原语全验 |
| ⑤ seat-driver 接口 | 本报告 §5 | ✅ 草案 |

实测用过的 tern 原语(全部实机验证): `tern plugin link/reload/list --json`、`tern ls --json`、`tern new tab [--keep-open] [--cwd] [-- CMD]`、`tern run BLOCK CMD`、`tern capture BLOCK --scrollback [--surfaces]`、`tern close BLOCK`;Lua: `cx.agents:list`、`tern.fs.{read,write,list,exists,mkdir,remove}`、`tern.sleep():next`、`tern.json.{encode,decode}`、`tern.getenv`、`tern.now`。
