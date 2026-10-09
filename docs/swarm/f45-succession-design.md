# F45 — 换壳继任协议 + 协调者降级呈报 + I3 投递缺口根因（S14，owner 90b58f9c）

分支 `feat/f45-succession`（off main `3732f4b`）。纯决策 + dormant 接线，不并不推，合并/接线门归协调者 + user。

## 事故

user 重启协调者后，新壳拿到全新 native sid，未继承稳定 sid（`fe0376cd`）的 presence 绑定（`presence/<stableSid>.pid`）。于是：

1. dispatcher 每次 `resolveSession(COORDINATOR, …)` 返回 null，STALL 告警落到没人读的日志 = 协调者**聋**。
2. 同一事故另一面（③）：我连续两次派单（吸收批、F45 本单）的耐久副本都没落我箱，只经总线到达。

三件都落传输/调度面，家无关；纯核各带自测，IO 壳一律 dormant。

## ① shell-succession（领养决策，family = decision-batch 空锁领养）

新壳要接管稳定 sid 的 presence 槽 + 扫箱，必须先**自证连续性**，且只在 incumbent 非活时才接管：

- 连续性（round-3 收紧，F45-P1-1）= **环境须已知**（machine/cwd/tool 三者皆非空）AND 三者皆相等 AND **至少一条绑定具体 stableSid 的结构化凭据**。凭据只认三种：① `resumeTargetSid`——IO 经 `parseResumeTargetFromArgv`（round-4：工具/位置感知——codex 只认 `argv[1]==="resume"` 子命令、claude 只认位置正确的 `--resume`/`--resume=` 且跳过取值选项、遇 `--` 停；取值选项值、`--` 后正文、flag-soup 一律不认）从真实 argv 解析的确切 sid、与 stableSid 精确相等；② 继承的 herdr pane 与本 sid 记录一致；③ 本壳已持该 stable native sid。**绝不用 resumeCmd 自由文本 includes**（正文里出现某 sid 不授权继任），**空环境不证明同环境**。任一在场凭据指向不同身份（resumeTargetSid≠stableSid、pane 冲突）⇒ 整体否决。
- incumbent 是**活的别的进程** ⇒ `reject`（绝不偷活槽；重启是误启或旧壳仍在）。incumbent 是**本进程**（pid 相同）⇒ `adopt` 幂等。incumbent 死/缺 + 连续性成立 ⇒ `adopt`：把 `presence/<stableSid>.pid` 重绑到本 pid，并**复用记录的 bus-identity mintedId**（身份连续，绝不另铸——另铸会孤立所有 cap HMAC 并在 roster 制造别名）。
- 任何证据不足 ⇒ `fail-closed` 到 `fresh`（以新身份开机，绝不劫持稳定槽）。

纯核：`provesContinuity` / `successionVerdict` / `presencePidRelPath`。IO 壳（采证 + 重写 pid）dormant 于 `SWARM_SUCCESSION`。

## ② coordinator-report（协调者未解析时的降级呈报面）

裁定：**日志文件不算呈报**。必须到达协调者的通知，在协调者未解析时要升级到真实面：

- 协调者已解析 ⇒ `inbox`（耐久箱，真呈报）。
- 未解析 + stall/critical ⇒ 升级：`s19`（结构化事件，首选）▸ `herdr-pane`（send-text 到协调者 pane）▸ `log`（降级，`isReport=false`——通知是聋的，诚实标出供调用方重试/告警）。
- 未解析 + info ⇒ `log`（info 不升级；`isReport=false`）。

`isReport` 仅 `log` 面为 false——调用方把它当投递**失败**重试，不当成功。纯核 `coordinatorReportPlan`。接线进 dispatcher 的 `notifyCoordinator` dormant 于 `SWARM_COORD_ESCALATE`（live 默认仍 log-only，直到合并门开）。

## ③ I3 投递缺口根因（我报的派单未落箱）

**根因**：send 路径的「同机 ⇒ 耐久-always」保证只在**单一 broker 内**成立。一个**同机但不同 bus broker**的对端，被 `resolve()` 判成 `via:"relay"`（跨 broker），于是 `resolveInboxTarget` 走 relay 分支 = live-only 送（桥接送达），**不写耐久副本**。协调者与我在不同 broker（它经 `agenthop-bus` 桥到达我），所以它的派单 live 送到了（我作为 cross-session-message 收到），但耐久箱一个字没写。

**现场证据**（本单实时复现）：我的 `~/.agenthop/inbox/90b58f9c-…/` 顶层空，吸收批与 F45 两次派单都不在；派单仅经总线桥到达。唯一的隔离件是 10-05 的旧 reboot-rollcall（与本缺口无关）。

**修复**（round-3 收紧，F45-P1-2：活 pid 不等于归属——陈旧 presence 文件的 pid 可能被回收给无关活进程）：`relaySameMachineSid(peer, isLocalInstance)` 要求注入的 `isLocalInstance` **证明当前实例归属**、不只是 signal-0 活。core 的 `isLocalInstance(sid)` = presence pid 活（signal-0）AND 该 pid 的**环境**携带启动者传入的身份（`presenceEnvOwnsSid`、`readPidEnv` 经 `ps eww` 读）——round-4：presence 写的是守护进程自身 pid、其 argv 无 sid、身份经 env 传（agents.ts presenceStartCommand 设 `AGENTHOP_PID_FILE=…/<sid>.pid`、继承 `CLAUDE_CODE_SESSION_ID=<sid>`）、故按 env 判归属而非 argv 正文：env 含 `AGENTHOP_PID_FILE=…/<sid>.pid` 或 `CLAUDE_CODE_SESSION_ID=<sid>` ⇒ 归属；回收的无关 pid（sid 仅在 argv 普通参数）两者皆无 ⇒ 不归属 ⇒ 保留 relay；真 presence 守护进程两者皆有 ⇒ 走同机耐久。无法证明一律 relay、绝不误报耐久。对端**自己的** durable ID（stableId）在本机拥有归属证明时，它共享本机文件系统、**有**本地耐久箱 ⇒ 走耐久（以该精确 sid 为键），而非 live-only relay。恢复「同机 ⇒ 耐久-always」**跨 broker** 成立。真正跨机的 relay 对端（无本地 presence）仍走 live relay。`relayLocalSid` 由调用方（core.ts）算好传入，保持 send-fallback 纯。

这是修 bug（非 dormant 新机制）：改在本分支、未合并故 main 不受影响，经合并门后应**默认生效**。

## 门与边界

- 纯核自测：shell-succession 20、coordinator-report 12；send-fallback 新增 2 例（同机 relay ⇒ 耐久 / 跨机 relay ⇒ relay），既有 8 例不变 = 10/10。bus 全量 tsc 净；send-path 邻接 28/28（legacy-inbox-keys/inbox/core-legacy-refresh）。
- 留白：①的采证 IO（读 roster-snapshot + presence 存活 + herdr pane）与重写 pid、②的 S19/herdr 面接线、live 重跑 bus 全量，均按既定范围 dormant/未接，候合并门。
- ③的修改触及 live 代码（send-fallback.ts、core.ts），已随邻接测试验证不破坏既有 send 路径。
