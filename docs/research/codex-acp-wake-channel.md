# codex-acp 唤醒通道研究(C 单,研究,未改码)

> 起因:codex 主线程席(Chief Review 01a13284)收到耐久箱信不会醒,只能靠协调者 `tern send` 直注。A 单(fix/codex-main-thread-identity,在审,未并)要让它的 mcp 领到正确身份、信落对箱;本文只回答「怎样让它醒,且不靠 Tern 直注」。给 user 裁。
> 证据日期 2026-10-15,codex 0.162.1,codex-acp 2.2.2(Tern 内置),全部来自本机进程与文件,没有对 Chief Review 发过任何东西。

## 1. 现状(实测)

进程链:`tern acp codex --resume 01a13284`(21477)→ codex-acp node 适配器(22073)→ **私有** `codex app-server`(22074,经 stdio 对话)→ 6 个 `agenthop mcp` 子进程(主线程 1 个 + 每个 subagent 一个)。

- 私有 app-server 不监听任何 socket(lsof 只有 stdio 管道和到上游代理的 TCP)。
- 共享 daemon(`~/.codex/app-server-control/app-server-control.sock` → pid 36869)`thread/loaded/list` 为空;它对 `thread/read 01a13284` 能读出元数据,因为那是读 rollout 文件,不代表已加载。
- 总线的 codex 投递是 `codex queue --thread <id>`,它走共享 daemon。

## 2. 候选通道与判断

| # | 通道 | 能否不靠 Tern | 风险 | 判断 |
|---|---|---|---|---|
| 1 | `codex queue --thread 01a13284`(现有投递路径) | 能 | 共享 daemon 会从 rollout **再加载一次**同一线程,与 22074 成为同一 65 MiB rollout 的两个写者;两边的上下文也会分叉。 | **不可用**,没有实测(不对现役审查席做破坏性试验)。要证伪需在一次性 codex 会话上复现:私有 app-server 持有线程 T,另起 `codex queue --thread T`,看 rollout 是否被两处追加。 |
| 2 | ACP `session/prompt`(适配器入口,index.js:4202/27146) | 不能直接 | 该请求只能由 ACP 客户端(=Tern)经 21477 的 stdio 发出;第三方进程无法加入这条管道。 | 唯一干净的入口在 Tern 手里。可行形态是 Tern 侧提供「给某 agent 块发一条 prompt」的 API——bridge 已有 `ask` op(PROTOCOL.md §ask:贴 + 回车),本质仍是 Tern。 |
| 3 | app-server `turn/start` / `turn/steer`(适配器内部 index.js:36303/36558) | 不能 | 同 2:只有持有 stdio 的 codex-acp 能发。 | 同 2。 |
| 4 | 让 codex-acp 连共享 daemon 而不是自起 app-server(codex 支持 `--remote unix://`) | 能 | 需要 codex-acp 支持「连远端 app-server」的配置;若支持,所有线程都在共享 daemon 上,`codex queue` 与身份 cwd 匹配都恢复正常。 | **最有希望的根治**,待查:codex-acp 2.2.2 的 `startCodexConnection(codexPath, env, appServerStartupArgs)` 默认参数是 `["app-server"]`,参数可由调用方传入——需确认 Tern 的启动配置能否把它改成连接共享 daemon。 |
| 5 | 成员自轮询:codex 主线程定期调 `agenthop_recv` | 能 | 需要模型自己记得调;空闲的 codex 不会主动发起 turn。 | 不能解决「空闲时唤醒」,只能缩短忙时延迟。 |

## 2a. 方案 Z:codex-acp 改连共享 daemon(2026-10-16 一次性实测)

**机制**:codex-acp 用 `spawn(<codex>, ["app-server", ...])` 起私有 app-server,并通过它的 stdio 讲换行分隔的 JSON-RPC。只要把这个 `<codex>` 换成一个包装程序,把 `app-server` 改为「接到共享 daemon 的控制 socket」,线程就会住进共享 daemon(36869),bus 现有的 `thread/loaded/list` → cwd 匹配 → `codex queue` 投递整条路都能用,不经 Tern。

**实测**(一次性块 `/tmp/z-probe/cwd`,tab 11441792876545,测完已关;没碰 Chief Review / Second Voice):

| 待验点 | 结果 |
|---|---|
| 怎么把包装程序塞进去 | **`env CODEX_PATH=…` 无效**:Tern 自己给 codex-acp 设 `CODEX_PATH=<它解析出的 codex>`(进程 env 实测 `/Users/wowdd1/.local/bin/codex`),覆盖调用方的值。**PATH 有效**:`env PATH=<含名为 codex 的包装>:$PATH tern acp codex`,Tern 解析到包装。 |
| `codex app-server proxy --sock` 能否直接当包装 | **不能**。它只原样搬字节;共享 daemon 的控制 socket 讲 WebSocket(握手 + 帧),而 codex-acp 写的是换行 JSON。实测:裸 JSON 行 ⇒ proxy 报 `Broken pipe`;自己写 HTTP Upgrade ⇒ 拿到 `101 Switching Protocols`。所以包装 = 换行 JSON ↔ WebSocket 文本帧的桥(`codex-acp-wake-z/ws-bridge.mjs`,约 20 行,与 bus `codex.ts` 同一套帧逻辑)。 |
| 新线程是否进 36869 的 `thread/loaded/list` | **是**。块启动后 loaded 从 [] 变为 [01a14052…](cwd=/private/tmp/z-probe/cwd),之后一次 turn 正常(回 "ready")。 |
| bus 节点能否按 cwd 领到它 | **是**。peers 出现 `codex:cwd-01a14052`(pid 950,父进程 36869)。**另见一个隐患**:第一次 turn 之后 loaded 里短暂多出同 cwd、无 parent、空 preview 的线程 01a14053,同时多出一个未领身份的 bus 节点 `codex:cwd-38f37773`(pid 2474);稍后 01a14053 不再出现在 loaded 里。950 是在它出现之前领的身份;在它存在期间启动的节点会因 cwd 不唯一而不领(F47-1 严格,不会领错)。01a14053 的来源未查明。 |
| `agenthop_send` 到该块是否唤醒 | **是**。send 返回 "Queued to durable inbox"(同机恒先落箱),随后 bus 用 `codex queue` 推进线程:rollout 里出现 `[bus] claude:agenthop-378177a0 → codex:cwd-01a14052 …` 的 user 消息,并开出一个新 turn,回 "woke",收件箱清空。**空闲席位被总线唤醒,不经 Tern 直注。** |
| `-c hooks=…` 是否透传 | **不透传,是本方案真正的缺口**。本次 codex-acp 只传了 `app-server`(codex-acp 进程 env 里没有 CODEX_CONFIG),所以没触发;但适配器在有 hooks 时会传 `app-server -c hooks=<toml>`,桥只能连接一个**已经在跑**的 daemon,改不了它的配置——这些 -c 会被丢掉(包装已写日志记录)。需要 hooks 的席位要把 hooks 放进 daemon 自己的 config。 |
| 共享 daemon 断开 / 重启时块的行为 | **只测了桥断开**(kill 桥进程):codex-acp 立刻重起一次 `app-server`(日志 00:12:04 第二次 argv),块继续工作,下一 turn 正常(回 "after-drop"),线程仍是 01a14052。**没测 `codex app-server daemon restart`**:那会打断所有共享 daemon 上的会话(包括其他人的),一次性实测不该这样做。按适配器的 `[APP-SERVER RECOVERY] resuming a session in the restarted app-server` 路径推断:daemon 回来后它会 resume 同一线程。待隔离环境验证。 |
| 关块后的残留 | 块关闭后桥进程消失,bus 节点 950 退出;关块后紧接着查,线程 01a14052 仍在 36869 的 loaded 列表里。约 40 分钟后复查,列表已为空。**这只是一次观察**:说明复查时线程已不在 loaded 里,不说明 daemon 有自动回收策略、也不说明多久回收。回滚不能依赖它,必须显式退订并确认(见 runbook §4)。 |

**结论**:Z 在机制上成立,且实测打通「总线投递 → 空闲 codex 席位被唤醒」,不经 Tern。上线前还差三件:① hooks 的配置放到 daemon 侧;② 在隔离环境验证 daemon 重启后的 resume;③ 关块后线程会留在 daemon 的 loaded 里;是否、何时自动卸载未知,回滚必须显式退订并确认释放(见 runbook)。代价:所有 codex 席位共享一个 app-server 进程,它一崩全体受影响(今天的私有 app-server 是每席一个)。

## 2b. 首次试点(2026-10-16 00:50,协调者执行,Second Voice)

日志:`~/.agenthop/swarm/z-pilot-sv-1792083012.log`。按 runbook §3 逐条:

| # | 结果 |
|---|---|
| 1 包装生效 | 过:wrapper argv 只有 `app-server`,无参数被丢 |
| 2 线程进共享 daemon | 过:01a13e9a 出现在 36869 的 loaded 列表 |
| 3 接上旧上下文 | 候 Second Voice 回答时尚未出结论 |
| 4 单写者 | 过:rollout 唯一持有者 36869 |
| 5 bus 身份 | 过:bus 节点 41323,父进程 36869 |
| 6 bus 唤醒 | 过:bus 投递唤醒线程并得到回话 |
| 7 SessionStart hook | **无执行痕迹**:presence 记录未变(仍是 pid 36072 / ts=1792051812000,该 pid 已不存活),hook 日志里也没有本 sid 本次的条目。即在共享 daemon 下,这次 `--resume` 没有触发会写 presence 的 SessionStart hook |

另外:直注到 Tern 块的中文开场被模型侧内容过滤连拦 5 次,同一内容走 bus 正常,所以 runbook 的开场一句已改为走 bus。

第 7 条的后果:presence 指向一个已死的 pid,依赖 presence 判活的读者会把 Second Voice 判成不在线,尽管 bus 投递正常。迁移审查席之前要解决:要么查明共享 daemon 下 hook 为何不触发,要么由迁移步骤显式写 presence(走 `scripts/seat-presence.ts set`)。

## 3. 建议(供裁)

1. 方案 Z(§2a)是候选 4 的具体做法,已实测打通唤醒。建议:先在一个非审查席位试点(带 hooks 配置迁到 daemon 侧),验证 daemon 重启 resume 与关块退订,再决定是否把审查席位迁过去。**A 与 Z 的兼容是待验前提,不是已知结论**:Z 之后 mcp 的父进程是共享 daemon 本身(`codex app-server --listen unix://`,探针里 bus 节点 950 的父进程就是 36869),它也是一个 `codex app-server`。A 必须能区分「共享 daemon(带 --listen)」与「私有 stdio app-server」,否则会把 Z 下的主线程 mcp 判成托管子线程。这条归 A 的审查(CID-HOST-SCOPE),试点前要先确认已修。
2. 4 不行 ⇒ 向 Tern 提需求:一个非交互的「给 agent 块投递 prompt」API(语义同 ACP `session/prompt`,不经键盘模拟)。在那之前,唤醒继续由协调者直注(现状),bus 不内置 Tern 直注(协调者已裁 B 不做)。
3. 1 号通道在有隔离复现前一律不用。

## 4. 未做 / 边界

- 没有对 01a13284 发过 `codex queue`、`session/prompt` 或任何写操作。
- 双写者风险是推断(rollout 是追加写的 JSONL,两个进程各自追加会交错),未实测。
- codex-acp 没有「连远端 app-server」的选项;Z 靠替换它启动的 codex 程序实现。
- daemon 重启未实测(见 §2a)。
- hooks:探针**未见参数丢失**(argv 只有 `app-server`;权限靠 env `INITIAL_AGENT_MODE`,不经 hooks)。hooks 在共享 daemon 下是否真的触发**未验证**——runbook 核验第 7 条要求有可归因于本次的执行证据。只有将来经 `CODEX_CONFIG` 传 hooks 的席位才会被桥丢掉参数。

## 5. 清理(2026-10-16)

- 探针块 tab 11441792876545 已 `tern close`;桥进程、bus 节点 950/2474 均已退出。
- 探针线程 01a14052:`thread/unsubscribe {"threadId":"01a14052-959c-75d3-ab99-c577eb48294c"}` 返回 `{"status":"notLoaded"}`,前后两次 `thread/loaded/list` 均为 `[]`——即复查时它已不在 loaded 里(是谁、何时卸载的未知)。rollout 文件 `~/.codex/sessions/2026/10/16/rollout-2026-10-16T00-08-36-01a14052-….jsonl` 保留(只是记录,不在任何席位名下)。
- 试点 runbook:`docs/swarm/codex-shared-daemon-pilot-runbook.md`(未执行)。
