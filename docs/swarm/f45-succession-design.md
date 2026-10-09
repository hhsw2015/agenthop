# F45 — 换壳继任协议 + 协调者降级呈报 + I3 投递缺口根因（S14，owner 90b58f9c）

分支 `feat/f45-succession`（off main `3732f4b`）。纯决策 + dormant 接线，不并不推，合并/接线门归协调者 + user。

## 事故

user 重启协调者后，新壳拿到全新 native sid，未继承稳定 sid（`fe0376cd`）的 presence 绑定（`presence/<stableSid>.pid`）。于是：

1. dispatcher 每次 `resolveSession(COORDINATOR, …)` 返回 null，STALL 告警落到没人读的日志 = 协调者**聋**。
2. 同一事故另一面（③）：我连续两次派单（吸收批、F45 本单）的耐久副本都没落我箱，只经总线到达。

三件都落传输/调度面，家无关；纯核各带自测，IO 壳一律 dormant。

## ① shell-succession（领养决策，family = decision-batch 空锁领养）

新壳要接管稳定 sid 的 presence 槽 + 扫箱，必须先**自证连续性**，且只在 incumbent 非活时才接管：

- 连续性（round-5 收紧，F45-P1-1）= **环境须已知**（machine/cwd/tool 皆非空）AND 三者皆相等 AND **至少一条绑定具体 stableSid 的结构化凭据**。凭据三种：① `resumeTargetSid`——`parseResumeTargetFromArgv` 只认**精确 codex 入口**（argv[0] basename 恰为 `codex`、`resume` 恰在 argv[1]、目标 argv[2]；`codex-inspector`/`node …`/任何包装一律 null、不猜取值选项边界）；claude 不解析 argv（resumed claude 保留原 sid、走 ② sidBinds）② 本壳已持 stable native sid（sidBinds）③ 继承的 herdr pane 与本 sid 记录一致。绝不用自由文本；空环境/未识别入口/指向别的身份一律否决。无法证明=fresh（fail-closed）。
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

**修复**（round-7 定案，F45-R1 协调者裁 B：每会话活性 socket）：归属只认 socket，不认时间。presence 守护进程在 `presence/<sid>.sock` 监听（bind 前 unlink 旧文件；accept 即关，监听器存在本身即活证）；收端 `probeLivenessSock` connect 探测，200 ms 超时。连上=当前实例活（内核在守护死时即丢监听器，故无窗——不同于任何 last-write/mtime 新鲜度方案）；陈旧 sock（守护死残留）connect 得 ECONNREFUSED、缺文件得 ENOENT、挂起得 timeout，皆 false⇒保留 relay。sock 文件名即 sid=天然绑定。core 的 relayLocalSid=await probeLivenessSock（presenceSockPath（sid））。r6 的 mtime 心跳保留作哨兵 liveness 辅证（分类用），归属不认。**scope：send 路径 + presence 守护进程（+socket 监听/清理、保留心跳）。** 真跨机（无本地活 socket）仍 relay。

这是修 bug（非 dormant 新机制）：改在本分支、未合并故 main 不受影响，经合并门后应**默认生效**。

## 门与边界

- 纯核自测：shell-succession 20、coordinator-report 12；send-fallback 新增 2 例（同机 relay ⇒ 耐久 / 跨机 relay ⇒ relay），既有 8 例不变 = 10/10。bus 全量 tsc 净；send-path 邻接 28/28（legacy-inbox-keys/inbox/core-legacy-refresh）。
- 留白：①的采证 IO（读 roster-snapshot + presence 存活 + herdr pane）与重写 pid、②的 S19/herdr 面接线、live 重跑 bus 全量，均按既定范围 dormant/未接，候合并门。
- ③的修改触及 live 代码（send-fallback.ts、core.ts），已随邻接测试验证不破坏既有 send 路径。
