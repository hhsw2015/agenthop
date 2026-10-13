# full-fleet-recovery — 全舰队状态恢复 (设计先行 brief)

owner=90b58f9c · off main @d63b1a5 · 审查席 codex:Work · 本件**设计先行**:brief 冻结投协调者后才动码。

北极星:整台机器重启(或崩溃)之后,**一条命令**把整个蜂群带回它倒下前的运行状态 —— 不只是窗口,而是调度器、在途工作、以及"每一件真的回来了"的**证据**。

---

## §0 诚实现状 (证据诚实,先划清已有 vs 缺口)

**已有(F36 resume,不要重写):**

- `scripts/swarm-resume.ts` + `packages/bus/src/swarm/resume.ts`(纯核)已经能:`--snapshot` 把 live roster 抓成 `~/.agenthop/swarm/roster-snapshot.json`(member×cwd×tool×**完整 resumeCmd**),重启后一条命令按 `planResume` 幂等(**按 (tool,cwd) 计数**,不是按 session id —— id 重启就变)relaunch 每个**窗口**,argv 优先否则 canon 模板(F36:绝不裸 `--resume`,会丢 permission/model/effort),herdr 或 Ghostty 后端,部分失败不停其余。
- `roster-snapshot.json` 此刻就在盘上(2.5K,live)。
- **durable 状态树** `~/.agenthop/swarm/` 本来就跨重启存活:`control-log/`(在途 attempt/wait)、`board/`(认领)、`console/`(投影)、`review-queue/`、`rulings`、inbox 各箱、`roster-snapshot.json`。重启丢的**不是**这些盘上状态。

**resume 没覆盖的(=本件的缺口,逐条):**

1. **调度器不是窗口。** dispatcher 是后台进程(`dispatcher.lock` 存 pid、`heartbeat.json`、`dispatcher.log`),**不在 bus roster 里**(没有 tool+cwd 窗口),所以 `swarm-resume` 从不 relaunch 它。重启后调度器就这么没了,没有任何东西把它带回来 —— 而调度器是蜂群的大脑,成员靠它分派/验收/呈批。
2. **调度器的 env 丢了。** dispatcher 跑在一大片 `SWARM_*` 面上(`SWARM_COORDINATOR`、`SWARM_SELF`、约 50 个 flag,见 `swarm-dispatch.ts`)。重启丢进程 env;裸 relaunch 会用默认 flag 跑,**静默改变行为**(哪些 flag 开着)。flags-default-on 把多数置默认开缓解了一半,但 `SWARM_COORDINATOR`/`SWARM_SELF`/端点 var 不可从默认推导。
3. **没有"真回来了"的验证。** `swarm-resume` 报 launch ok/fail/unconfirmed,但"launched"≠"重新上了总线并恢复干活"。F53 已有**精确原语**:`verifyOpsAction`(confirmed/failed/unknown,按 **durable 证据** —— bus-visible / inbox check-in / session-id match),且 **unknown=按失败重做**。恢复必须对每个回来的成员采这个证据,**不信 launch 返回**。
4. **在途工作没被重新接上。** 恢复的 session resume 了 transcript,但它**不知道发生过重启**;它的 board 认领可能过期,inbox 可能有信,调度器 control-log 里有它的在途 attempt。没有任何东西把恢复的 session 重新指回它的活 —— 它可能就**闲着**(恰是 idle-explainer 北极星那个痛:全员 idle,user 问"怎么又空闲了")。
5. **与继任重叠。** F45 继任(`shell-succession.ts`)用 holder-lock + adopt/reject/fresh 处理**单个**成员换壳。全舰队恢复是冷启动后**一次 N 个**成员,必须**不与继任打架**(双重 adopt)—— 恢复时给每个成员打 `writeSuccessionSwap`(swappedAtSec),让 `successionHeartbeatDue` 的宽限窗统一管辖。

---

## §1 目标

**一条命令 = 从"机器刚开机、蜂群全没"到"调度器在跑、每个成员回到它倒下前的活、协调者手里有一份谁真回来谁没回来的证据报告"。** 幂等(重跑只补缺)、fail-soft(一处失败不停其余)、证据诚实(每个"已恢复"背后是 durable 证据,不是 API 瞬时返回)。

---

## §2 四件 (对应协调者 ①②③④)

### ① 关机时刻快照 (capture)

durable 状态树已跨重启存活,**唯一易失的**是:(a) **调度器的启动配方** —— 它的命令行 + 精确 `SWARM_*` env + 协调者/自身身份;(b) 干净时刻的 roster(resume 已管窗口,本件复用)。

设计:新 `~/.agenthop/swarm/fleet-snapshot.json`(schema `fleet-recovery-snapshot/v1`),抓:

- **dispatcher 启动配方**:从 `dispatcher.lock` 的 pid 读它的命令行(`ps -o args=`,复用 resume.ts 的 psArgs 形态)+ 它 env 里的 **`SWARM_*` 子集**(平台相关:macOS `ps eww`/Linux `/proc/pid/environ`);
- **roster 指针**:指向同目录 `roster-snapshot.json`(不重复抓,复用 resume 的 `--snapshot`);
- `capturedAtSec`(算 staleSec)。

**证据诚实关键:**
- **env 不可读 ⇒ 抓不到就标 source="unavailable",绝不伪造 flag 值**(fail 向"用当前 env + 明确告警"跑,绝不"用编造的 flag"跑)。
- **密钥绝不进快照**:`CPA_API_KEY`/`*_TOKEN`/deploy key 一律不写,recover 时从各自 canonical 文件(`~/.agenthop/cpa.json` 等,镜 `model-catalog-store.ts::cpaBaseUrl`)**重新取**。单独一份 fleet-snapshot 泄露不等于泄露密钥。
- 写:on-demand(`--snapshot`),可选(④)挂 closeout seam(resume.ts 注释提到的同一个 at-closeout 写入点)。

### ② recover runbook → `scripts/swarm-recover.ts` (可执行)

一条命令。每步 fail-soft + 计入报告:

1. **读 fleet-snapshot.json(+ roster-snapshot.json)。** 缺 ⇒ 清晰报错退出(**绝不猜一个舰队**);corrupt ⇒ null ⇒ 退出(绝不从垃圾部分 relaunch)。staleSec 过大 ⇒ 告警但继续(让人知道在用旧快照)。
2. **先调度器**(它是大脑,成员自报靠它)。`dispatcher.lock` 的 pid live ⇒ skip(幂等);否则用捕获的命令 + `SWARM_*` env(**密钥 recover 时重新取,不来自快照**)relaunch 调度器,沿用既有 lock 保单活。env source="unavailable" 时:用当前 shell env + 打印明确告警"调度器以可能不同的 flag 启动,请核对"。
3. **成员:委派给既有 resume 核**(`planResume` 幂等 + `resumeCommandForMember` 完整命令)。**不重写** —— swarm-recover **调用** resume 核。每个 relaunch 的成员打 `writeSuccessionSwap(swappedAtSec)`,让 F45/F53 心跳宽限统一适用、继任不双 adopt。
4. **验证,不信任(F53)。** 对每个 relaunch 的成员**和调度器**,采 durable 证据(bus-visible via `core.peers` / 协调者 inbox 里的 check-in / session-id match),跑 `verifyOpsAction`。confirmed ⇒ 成;unknown/failed ⇒ S19 呈协调者(redo+account),**绝不"假设起来了"**。复用 `OpsReceiptRecord`(`pending→confirmed|failed|unknown`),结果是一份 durable 收据,不是一行 log。采证前给宽限窗(`SWARM_OPS_RECEIPT_GRACE_SEC`,session 上线要时间)。
5. **断点注入(breakpoint injection)。** 对每个 **confirmed-恢复**的成员,注入**一条** durable inbox 信(`writeInbox`,inbox-wake 自动 ping pane):"fleet 重启后已恢复 @<T>;你的 board 认领=<X>,在途 attempt=<id>,未读 inbox=<n>;继续你的活。" **纯重新指路;不派新活,不花钱。** 这闭合缺口#4(恢复后闲置)。断点内容**从 durable 状态读**(board 认领、control-log `liveEntities` 里该成员的 attempt)—— 诚实派生,绝不编造。
6. **双报。** 一份恢复摘要(relaunch 了谁/confirmed/unknown-redo/failed)投协调者 inbox(durable);若有 redo/failed 另发一行 S19。

`--dry`(只打印会做什么 + 调度器命令 + 每个成员的 resumeCmd)、`--snapshot`(=①)两 flag,镜 swarm-resume 的 UX。

### ③ 对话官 / 协调者 双入口 (trigger)

恢复要两种触发:

- **(a) 协调者(或机器前的人)** 直接跑 `swarm-recover.ts`。
- **(b) 远程经对话官** —— 重启后 user **常常不在机器前**(这正是 TG/对话官的全部前提)。对话官接待层加一个识别意图("把蜂群恢复" / "recover the fleet"),把恢复**请求**排给协调者执行。

**硬界**:对话官**绝不自己跑 recover**(它无执行权 —— dialog-officer brief 已裁);它把请求**路由给协调者**,协调者执行(R16 邻域:relaunch sessions = spend-邻接操作,协调者门)。设计上恢复**是一个协调者动作**,两个入口只是两个到达协调者的触发。

### ④ boot 自动化 (可选档)

最高自动化档:macOS LaunchAgent / 登录项,开机即跑 `swarm-recover.ts`。**仅 opt-in**(持久系统改动 = user 门,同 `install --mcp` 先例),**默认 OFF**。brief 定 plist 形状;没有它恢复仍完整可用(手动/对话官触发)。

**诚实**:开机自动意味着恢复**无人在场**跑,没人看见"unknown-redo" —— 所以自动档**仍必须 durable 双报**(§2②⑥),让协调者/user 回来时看得到结果。

---

## §3 FC-2 / CP 纪律 (新零-bug 夹具律适用 —— 本件触核心原语)

- **快照读**:ENOENT ⇒ 清晰报错退出(绝不猜);corrupt ⇒ null ⇒ 退出(绝不从垃圾部分 relaunch)。
- **env 捕获三态**:不可读 ⇒ 捕获空 + 标 source="unavailable",**绝不伪造 flag 值**。
- **验证三态**:`verifyOpsAction` 已 confirmed/failed/unknown;**unknown 当失败**(redo+account)。
- **幂等重跑**:调度器 lock live ⇒ skip;成员 `planResume` 按计数 ⇒ skip live;断点注入经 `writeInbox` publishOnce 键(per 成员×恢复-episode)幂等。
- **CP-3**:任何文件写(fleet-snapshot.json、收据)lstat 边界守(符号链接/非目录 ⇒ 拒)。
- **密钥绝不进快照。**
- **三类零-bug 夹具(新律)**:
  - **crash-recovery**:recover 跑到一半被中断(relaunch 了调度器但没 relaunch 完成员)—— lock + 计数幂等让重跑干净接上。
  - **restart-idempotency**:recover 跑两次 ⇒ 无双 launch、无双断点(publishOnce 键)。
  - **concurrency-race**:两个 recover 同时跑 —— 调度器单活 lock + 原子写(temp+rename)各自落完整文件。

---

## §4 硬界

- 恢复 relaunch **既有** session(resume 它们的 transcript)—— **不** spawn 新活、**不**扩编、**不**花超出这些 session 本来就在做的钱。relaunch = 这些本来在跑的东西的重启等价物。
- 但:launch sessions 消耗模型预算 ⇒ **触发器协调者门**(③);自动开机档 user-opt-in。
- **无新任务。** 断点注入只重指**既有**工作(从 durable 状态派生)。
- 对话官入口**绝不执行** —— 路由给协调者。
- **证据诚实**:每个"已恢复"背后是 `verifyOpsAction` durable 证据,绝非 launch 返回。

---

## §5 实现形态 (设计-only,供 FROZEN→code 轮)

- **`packages/bus/src/swarm/fleet-recovery.ts`(纯核)**:snapshot schema(`fleet-recovery-snapshot/v1`)、`parseFleetSnapshot`(容错→null)、env 子集过滤器(`SWARM_*` allowlist,密钥排除)、恢复计划构造(调度器-需-relaunch? + 成员计划**委派** `planResume`)、断点信构造(纯,从 durable 状态事实)、复用 `coordinator-ops-receipt.ts` 的 `verifyOpsAction`/`OpsReceiptRecord`。selftest + 三类零-bug 夹具。
- **`packages/bus/src/swarm/fleet-recovery-store.ts`(IO)**:`writeFleetSnapshot`(原子,CP-3,密钥排除)、`readFleetSnapshot`、调度器-liveness(lock 读 pid)、env 捕获(`ps eww` / `/proc`)、收据写。
- **`scripts/swarm-recover.ts`(薄 IO 壳)**:编排 —— 读快照、relaunch 调度器、**调用** swarm-resume 核 relaunch 成员、采证、写收据、注断点、双报。`--dry`/`--snapshot`。
- **对话官意图(③)**:接待层一个识别的"recover"意图,把请求路由协调者 inbox(无执行)。依赖 dialog-officer bridge(d7f6c917 的件)落地;在那之前,**协调者-run 入口独立可用**。
- **④ boot**:一份 LaunchAgent plist 模板 + `install --recover-on-boot` opt-in(默认 off)。
- **Flag**:`SWARM_FLEET_RECOVERY` 只挂**可选的 closeout 自动快照**那一个 sweep-ish 件(默认值见 Q4);recover 本身是手动/触发动作,不是 sweep,不挂 flag。

---

## §6 开放项 (请协调者裁)

- **Q1(头号)env 捕获范围**:哪些 `SWARM_*` 安全/必要进快照?荐:非密钥的身份+行为 var allowlist(`SWARM_COORDINATOR`/`SWARM_SELF`/`SWARM_CAP`/flag 集),密钥(`CPA_API_KEY`/`*_TOKEN`/deploy key)**绝不**捕获,recover 时从 canonical 文件重取。
- **Q2 调度器 relaunch**:swarm-recover **relaunch 调度器**,还是只验证+报告、把调度器 relaunch 留给人?荐:relaunch(="一条命令"的全部意义),单活 lock 保安全。
- **Q3 断点注入默认**:给每个恢复成员注入重指信(荐 ON,=恢复后闲置的修),还是仅按需?
- **Q4 自动开机档**:现在就出 plist 模板(默认 off)还是推迟?荐:brief 定形,code 轮出 opt-in。`SWARM_FLEET_RECOVERY`(closeout 自动快照)默认值:荐 flagDefaultOn 默认开(只写盘快照,零风险),或保守 OFF 候显式启用 —— 请裁。
- **Q5 对话官入口依赖**:依赖 bridge(d7f6c917)。先建协调者-run 入口,对话官意图作 bridge 落地后的 follow-on?荐:是。
- **Q6 快照新鲜度**:recover 从最后一次 on-demand 快照,还是要求关机时 fresh `--snapshot`?荐:closeout 自动快照(④ seam)保鲜 + 手动 `--snapshot` 兜底;recover 在快照过旧时 staleSec 告警。

---

姊妹件:[[swarm-idle-explainer]](恢复后闲置是它的北极星痛,断点注入是预防面)/F36 resume(本件复用其核)/F45 succession(`shell-succession.ts`,恢复打 swappedAtSec 不双 adopt)/F53 coordinator-ops-receipt(`verifyOpsAction`/`OpsReceiptRecord`,本件复用验证面)/dialog-officer(③ 远程入口)。

**STOP 候协调者冻结或返修。**
