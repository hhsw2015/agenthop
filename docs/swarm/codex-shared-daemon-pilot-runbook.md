# Runbook:codex 席位改住共享 daemon 的试点(方案 Z)

> **状态:草案,未执行,等 user 裁。** 研究与实测依据见 `docs/research/codex-acp-wake-channel.md` §2a(2026-10-16 一次性块实测:空闲 codex 被总线投递唤醒,零 Tern 直注)。
> 候选席位:**Second Voice**(sid `01a13e9a-ea58-7a30-a8db-35cd3ad3f879`,cwd `~/Dev/happycapy`)。理由:它今天已经 bus 可达,迁移失败的代价最小;要验的新东西是 `--resume` 一条已有长会话到共享 daemon 的行为。
> 执行人:协调者或其指派的席位。审查席本人不执行自己的迁移。

## 0. 前置(全部满足才开始)

0. A 单(fix/codex-main-thread-identity)要么未装机,要么已装且能区分共享 daemon 与私有 app-server(其审查项 CID-HOST-SCOPE)。否则迁到共享 daemon 后,主线程 mcp 可能被判成托管子线程,不领身份。

1. Second Voice 处于安全点:手上没有在审卷(判卷已投,箱空),它自己确认「可换壳」。
2. 共享 daemon 在跑:`ps -o command= -p $(pgrep -f 'app-server-daemon/.*/codex app-server --listen')` 有一行,`~/.codex/app-server-control/app-server-control.sock` 存在。
3. 包装与桥已就位(从仓里复制,不从 /tmp):
   ```
   mkdir -p ~/.agenthop/codex-z/bin
   cp ~/Dev/agenthop/docs/research/codex-acp-wake-z/ws-bridge.mjs ~/.agenthop/codex-z/
   cp ~/Dev/agenthop/docs/research/codex-acp-wake-z/codex-z.sh ~/.agenthop/codex-z/bin/codex
   ```
   `chmod +x ~/.agenthop/codex-z/bin/codex`。包装按自己所在位置找桥,日志写 `~/.agenthop/codex-z/wrapper.log`。
4. 记下回滚所需的现状:`tern ls --json` 里 Second Voice 的 block id 与启动命令(期望 `env INITIAL_AGENT_MODE=agent-full-access tern acp codex --resume 01a13e9a…`)。

## 1. hooks 与权限(研究稿列的缺口,这里核清)

- 权限不靠 hooks:codex-acp 只读 env `INITIAL_AGENT_MODE`(PROGRESS #1066 实证),桥不影响 env,照旧生效。
- hooks:codex-acp 只在 `CODEX_CONFIG` 里带 hooks 时才给 app-server 加 `-c hooks=…`(dist/index.js:45591)。本机这条为空(探针块日志:argv 只有 `app-server`)。席位真正生效的 hooks 来自 `~/.codex/hooks.json`(`[features] hooks = true`,config.toml),共享 daemon 读的是同一个 `~/.codex`。⇒ **对现有席位不是阻点**。若将来某席靠 `CODEX_CONFIG` 传 hooks,桥会丢掉它们(包装写日志),那时要改放进 `~/.codex/hooks.json`。
- 待验(本试点的第 3 步):迁移后 SessionStart 等 hook 在共享 daemon 下是否照常触发——看 `~/.agenthop/presence/01a13e9a….pid` 是否被写。

## 2. 换壳

1. 关旧块:`tern close <Second Voice block id>`。确认 `tern ls --json` 里它消失,`pgrep -f 'tern acp codex --resume 01a13e9a'` 无输出。
2. 用包装起新块。**PATH 必须写成字面值**——restore 的身份解析只接受不含 `$` 的 `env K=V`(tern-restore.py `ENV_ASSIGN`),写 `$PATH` 会让 restore 判它身份不可证:
   ```
   P="$HOME/.agenthop/codex-z/bin:$PATH"     # 在执行人的 shell 里先展开成字面值
   tern new tab agenthop --cwd ~/Dev/happycapy --json -- \
     env "PATH=$P" INITIAL_AGENT_MODE=agent-full-access tern acp codex --resume 01a13e9a-ea58-7a30-a8db-35cd3ad3f879
   ```
   记下返回的 block id;`tern rename <block> "Second Voice"`。
3. 开场一句直注(此时它还没读箱):`tern send <block> text '<交接一句:你已迁到共享 daemon,先读箱>' && tern send <block> keys Enter`。

## 3. 核验(逐条,任何一条不过 ⇒ 第 4 节回滚)

| # | 检查 | 期望 |
|---|---|---|
| 1 | 包装生效:`tail ~/.agenthop/codex-z/wrapper.log` | 有一行 `argv: app-server`,且没有 `dropped app-server args: …` |
| 2 | 线程进共享 daemon:对 `app-server-control.sock` 做 `thread/loaded/list` | 列表含 `01a13e9a-ea58-7a30-a8db-35cd3ad3f879` |
| 3 | 会话接上了旧上下文:让它回答一句只有旧上下文才知道的事(如「你最后判的是哪卷、什么 SHA」) | 答对;rollout `~/.codex/sessions/2026/10/15/*01a13e9a*.jsonl` 继续追加,而不是新开一个 rollout 文件 |
| 4 | 只有一个写者:`lsof <上面那个 rollout>` | 只有共享 daemon 的 pid(36869 一类),没有别的 `codex app-server` |
| 5 | bus 身份:`agenthop_peers` | 出现 `codex:happycapy-01a13e9a`,其进程的父进程是共享 daemon |
| 6 | bus 唤醒:在它空闲时 `agenthop_send codex:happycapy-01a13e9a "<一句:回 woke>"` | 一分钟内在块里出现该消息并回复;它的耐久箱随后为空 |
| 7 | presence:`cat ~/.agenthop/presence/01a13e9a-ea58-7a30-a8db-35cd3ad3f879.pid` 及 `.origin` | 有值,且 pid 活着(SessionStart hook 照常) |

## 4. 回滚(任何时候都可以做)

1. `tern close <新 block>`。
2. 按第 0 步记下的原命令重起:
   `tern new tab agenthop --cwd ~/Dev/happycapy -- env INITIAL_AGENT_MODE=agent-full-access tern acp codex --resume 01a13e9a-ea58-7a30-a8db-35cd3ad3f879`,`tern rename <block> "Second Voice"`。
3. 线程若还挂在共享 daemon:对 `app-server-control.sock` 发 `thread/unsubscribe {threadId: 01a13e9a…}`(探针实测:已卸载的返回 `{"status":"notLoaded"}`,无害)。**先退订再让私有 app-server 恢复,避免同一 rollout 两个写者。**
4. 包装目录 `~/.agenthop/codex-z/` 留着不删(下次试点复用),它不在任何 PATH 默认值里,不影响其他席位。

## 5. 不在本试点范围

- Chief Review 迁移:等本试点 7 条全过并跑满一天再议。
- 共享 daemon 重启(`codex app-server daemon restart`)下的恢复:会打断共享 daemon 上所有会话,另找无人值守的时段单独测。
- 关块时自动退订:试点期间手工做(第 4 节第 3 步);定型后再决定放进哪个组件。
- 风险提示:迁移后所有住在共享 daemon 上的 codex 会话共用一个进程,它崩了全部受影响;今天每席各有一个私有 app-server。
