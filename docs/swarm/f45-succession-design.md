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

**round-8 修两残留（审查席 happycapy r7 判回 1 P1 + 1 P2）：**

- **F45-R7-P1-2（P1，SID 路径未绑定到准确 sid）：** `stableId` 是未校验的 peer 字段。`../bridge` 会让探测路径逃出 `presence/` 命名空间、连上无关监听器（如 bus bridge 的 socket）=假耐久，消息进无人消费的箱。修：纯 `isValidSessionId`（单段安全路径，`^[A-Za-z0-9_-]+$`、非空、≤128）。核 `relayLocalSid` 计算仅对合法 sid 探测，非法=保留 relay、绝不探测别的端点。`resolveInboxTarget` 对每个耐久键校验：非法的 relayLocalSid 退回 relay，非法的本地/离线 sid=fail-closed none。不做有损清洗（拒绝，不改写）。
- **F45-R7-P2-1（P2，旧实例退出删掉新实例的监听路径）：** 旧的 bind 前无条件 unlink 会抢走同 sid 活监听器的路径；且 Node v20 `server.close()` 本身按路径 unlink socket 文件，旧实例退出删掉新实例的文件=新实例虽活但后续探测得 ENOENT⇒全退 relay。修：`claimLivenessSocket` 绝不 unlink 活监听器——先 listen，`EADDRINUSE` 则探测，活 incumbent 则**让渡**（返回 null，下一心跳 tick 重试，待其释放再接管），仅死守护的陈旧文件才 unlink 重建。关停只 `server.close()`（只 unlink 自己 bind 的路径），不再无条件 rmSync（让渡中的实例绝不碰 incumbent 的文件）。整条监听生命周期都不删他人端点。

**round-9 修两残留（审查席 happycapy r8 判回 1 P1 + 1 P2，均为内核 socket 层）：** r7/r8 用确定性共享路径 `presence/<sid>.sock`，两处结构性缺陷连带出现——改为**有界哈希前缀 + 每实例 nonce**，一并消解。

- **F45-R7-P1-2（P1，合法长 SID 内核路径碰撞）：** 128 字符守卫不限制最终 socket 路径字节数；两个 127 字符仅尾字母不同的 SID 均过校验，但 macOS sun_path（104 字节）把超长路径**静默截断**成同一前缀，send(B) 连上 A 的 socket 回 durable=假归属。修（协调者裁 B 之「有界稳定映射」）：socket 名 = `<sha256(sid) 前 32 hex>.<nonce>.sock`——哈希使 `../bridge` 无法穿越、两个长 SID 得不同前缀不再截断成同一端点（定向碰撞需 2^64 = 不可行）；另加 `sockPathFits`（≤103 字节）在开 socket 与探测两侧**拒绝放不下的路径**（退 relay，绝不探测会截断的路径）。原始 SID 仍经 isValidSessionId 守**耐久箱目录键**（箱名是生 SID，无 sun_path 限制但要防穿越）。**身份回验（协调者 r9 提示①）**：socket 被连上时**吐出自己的全 SID** 再关；`probeSessionAlive` 连上后读该 SID，仅当 == 被探 SID 才算活——哈希文件名只是键，emit 的全 SID 是回验，哪怕（不可行的）128 位碰撞或同前缀残留也无法替它不拥有的 SID 应答。
- **F45-R7-P2-1（P2，旧实例退出删新实例路径）：** 共享路径下 Node v20 `server.close()` 按路径 unlink，旧实例退出删掉新实例的文件；且失败探测（活 incumbent 的瞬时 ECONNREFUSED / timeout / EACCES）不得授权删除。修：**每实例 nonce 路径**——`openLivenessSocket` 每次绑定全新随机 nonce 路径（无 EADDRINUSE 争用、无回收、close() 只 unlink 自己的路径，绝不碰他人端点）；收端 `probeSessionAlive` 按哈希前缀 readdir + 逐一 connect 探测，任一连上即活。**全程无任何探测授权的删除**（陈旧孤儿留在盘上，探测不通即跳过，绝不被某个失败探测删掉）——彻底消除跨实例删除与瞬时误删。孤儿（崩溃残留）无害且实践中有界（仅崩溃产生），留一条 age-based reaper 的后路但绝不做探测删除。

**round-10 收口（审查席 happycapy r9 判：R7 两项全 CLOSED，仅剩 1 P2）：**

- **F45-R9-P2-1（P2，身份回应异步写错终止守护进程）：** r9 新加的「accept 即吐 SID」回调 `c.end(sessionId)` 未给连接 `c` 挂 error 监听；客户端在回应前断连则写 SID 触发 EPIPE/ECONNRESET，这是连接自身的**异步**流错误——外层 try/catch 只接同步异常、Server 的 error 监听不收连接流错误，于是未处理 error 让 presence 以退出码 1 终止，后续活性探测全失败。修（协调者裁：socket.on error 吞 EPIPE）：accept 回调**先给每条连接挂 `c.on("error", …)`** 再写——单条断连/写失败只结束该连接，绝不终止守护进程；正常身份探测照常成功。

这是修 bug（非 dormant 新机制）：改在本分支、未合并故 main 不受影响，经合并门后应**默认生效**。

## 门与边界

- 纯核自测：shell-succession 38、coordinator-report 12 = 作者 50/50；send-fallback 26/26（r8 isValidSessionId + 不安全耐久键；r9 sidSockPrefix/sockPathFits 边界 + openLivenessSocket/probeSessionAlive 真 socket：开→活 / 无 socket→relay / 两个 127 字符长 SID 不碰撞 / 同前缀但吐错 SID 的 socket 被回验拒绝 / 同 SID 两实例独占路径关一个另一个仍活 / 死孤儿被容忍不删 / 连接异步 error 只结束该连接不杀守护）。bus 全量 tsc 净（exit 0）；liveness+core 邻接 48/48；全量 bus 1269/1269。
- 留白：①的采证 IO（读 roster-snapshot + presence 存活 + herdr pane）与重写 pid、②的 S19/herdr 面接线、live 重跑 bus 全量，均按既定范围 dormant/未接，候合并门。
- ③的修改触及 live 代码（send-fallback.ts、core.ts），已随邻接测试验证不破坏既有 send 路径。
