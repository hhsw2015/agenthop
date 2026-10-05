# bus-identity 设计:别名表 + whois(身份可靠性 v1)

日期:2026-10-04。状态:**草案 v3**(rev1 审查 4P1+4P2 → rev2 六项 closed、剩 1P1+1P2 → rev3 修这两处 + 五问落稿;round-3 中期 P1-2 closed,P2-3 一处换行终止坏记录的边界已补;未实现)。作者:swarm-viz 会话(claude:agenthop-90b58f9c,presence 竞态修复的实现者)。
章程:`bus-identity-reliability-brief.md`(I1-I7)。范围:v1 只做前两刀——**别名表**(把一个实体的所有 id 形态归并)+ **whois**(一条命令由任意 id 定位实体)。I3(sent/delivered/acked)、I4(发送预检)、reply-to 规范化都列后续,本稿只给接缝 + 诚实边界。
标注:[F] 已实现事实 / [I] 静态推断 / [D] 新增设计。
rev2 的总纲(回应审查):**保守分裂、明确歧义、如实 unknown 是可接受的安全结果;本稿不声称已解决全部历史归并与可回复性。**

## 0. 问题的精确形状:一个实体,多种 id,零翻译

一个逻辑会话今天在总线上同时以多种 id 形态出现,彼此不互译,这是 I1/I2/I6 的共同根:

| 形态 | 来源 [F] | 稳定性 |
|---|---|---|
| **run id** (`self.id`) | 每次进程启动 `randomUUID()`(label.ts:110) | 每次重启/新进程即变 |
| **native session id** (`self.stableId`) | Claude=`CLAUDE_CODE_SESSION_ID`;Codex=`AGENTHOP_SESSION`(=thread id,presence hook 从 stdin 解析,label.ts:60) | Claude 跨重启稳定;**Codex=thread id,新线程/重启即变** |
| **短句柄** (`self.title`) | `tool:dir-<shortId(stableId ?? id)>`,shortId=前 8 位字母数字(label.ts:85,98) | 跟 stableId 走;Codex 首次 MCP 调用前用 run id、之后 adopt thread id → 句柄短 id **中途变**(core.ts learnStableId 重新 announce) |
| **busPid** | `self.pid` = `process.pid`,即 **presence/MCP 总线进程**(label.ts:116) | 进程级;可被 OS 复用 |
| **hostPid** | `AGENTHOP_HOST_PID`(presence hook 的 $PPID,presence.ts:73)——**另一个字段,不在 SelfInfo/RemotePeer 里** | 宿主(claude/codex)进程级;可被复用 |

**F18 三连为什么发生**(章程实锤):①派 `codex:Work-01a0ead5`(句柄,短 id=thread id),回信 `from=673c6525`(run id);②派 `f32a0507`,回信 `from=2e5d2a89`;③派 `happycapy-01a0ff49`,回信 `from=af1962e4`(run id),peers 显示其 run id 刚从 af1962e4 变 7fa8a9ee(重启换 run)。同一病:**句柄短 id 取自 A 来源,回信 from 取自 B 来源,无归并表**;resolvePeer 只能精确/前缀匹配**单一**形态(resolve.ts:82-85 [F]),做不了「run id → 当前句柄」的翻译。

**一手旁证(本稿作者亲历,9ac3eb4 [F]):反向的坑——同 native 非同实体。** swarm-viz exporter 曾继承启动它的 shell 的 `CLAUDE_CODE_SESSION_ID`,于是三个独立进程(不同 busPid、不同 run id、不同 cwd)**共用同一个 native id 90b58f9c**。它是**碰撞输入的实证,不是 nativeId 永不冲突的证明**。教训直接约束本设计(§2、§3):**共享一个 id 字面不等于同实体**。

## 1. 设计立场:身份是记录的,活性是实测的——两张证据面不混(dogfood F17/I5)

**F17 引据更正(审查 P1-4):** 本需求的 F17 是 **dogfood.F17**(dogfood-notes:84-85)——错误 grep / 单一探测推翻近期产出而误判死亡,要求单侧失败先 suspected、判死需独立证据并解释近因。不是 brain-design 的 Git push/readback F17(那个类比可留作记忆法,但**不是**本次死亡判据)。

据此,本设计把身份与活性**拆成独立证据面**,whois 分别给出、绝不合并:
1. **身份映射**(别名表):哪些 id 形态指同一实体。记录的、append-only、可由日志幂等重建。
2. **可回复性**(reachability):此刻有没有一个 resolvePeer 能解析、且**确属该实体**的在册句柄。读 roster 现算。
3. **活性**(liveness):**绑定正确目标的** probe(§2.4 讲 busPid vs hostPid),三态 alive/suspected/dead,dead 需符合死亡政策(§5)。

关键:**活性不是别名表的字段**。表只存身份映射(durable);活性在 whois 查询时现场探测。否则必复刻 I5——一个存下来的 alive 位必然过期,然后「自信地错」。

## 2. 数据面:别名表

### 2.1 实体、别名 claim、化身(rev2 重构,P1-1/P1-3)

```text
IdentityEntity {
  entityId: string            // 独立自造的持久键(§2.2)——不是任何 native/run/句柄/pid 字面
  aliasClaims: AliasClaim[]   // 指向本实体的 id claim(一对多;带来源与置信度)
  incarnations: Incarnation[] // 本实体的化身链(§2.3);每段是一次可绑定出生证据的进程/线程生命
  tool, cwd                   // 人读定位
  // 以下是 COMPUTED 面,不 durable、不进日志:
  currentReplyTo?: string     // 经校验确属本实体的在册句柄(§4.2),否则 none
  lastActivityAtSec?: number  // 来自 presence/status 更新的『活动时刻』——不等于已验证的业务产出(审查 P2-4)
}

AliasClaim {
  value: string               // id 字面(不透明串)
  form: "run" | "native" | "handle" | "presence" | "busPid" | "hostPid"
  provenance: "same-announce" | "learn-bootstrap" | "learn-correction" | "thread-switch" | "heuristic" | "import"
  confidence: "hard" | "possible"   // hard=进自动解析;possible=仅提示,不进传递闭包(§2.3)
  incarnation: number
  firstSeenSec, lastSeenSec
  revokedBy?: string          // 指向一条撤销/纠正事件 id(§3);被撤销的 claim 不参与解析
}

Incarnation {                 // 一次进程/线程生命 = 一组同时成立的形态
  n: number
  runId?: string
  nativeId?: string
  busPid?: number
  hostPid?: number
  birth?: { hostPid: number; hostStartTicks?: string }  // 可校验出生证据(§2.4),防 pid 复用冒充
  epoch?: number              // directory.ts 的 per-INSTANCE epoch [F]——relay 实例顺序,**非宿主/线程代际**(审查 P2-2)
  rev?: number                // per-run 单调 announce 修订 [F]
  scope: "local" | "relay"    // 本机可 pid 实测;relay 只有 announce 新鲜度(§5)
  startedAtSec: number
}
```

### 2.2 规范键 `entityId`:独立、持久、非别名字面(P1-1)

rev1 把「首化身 nativeId」当键,与「同 native 不归并」自相矛盾(9ac3eb4 两实体会共享键 N)。改:

- **entityId 自造**(本机单调计数或随机),一经产生不变,**不等于任何 native/run/句柄/pid**。所有这些形态都只是指向 entityId 的 `AliasClaim`,是**一对多反向索引**(一个 id 字面在冲突时可指向多个候选实体)。
- **所有 lookup 先按实体去重,再判唯一/歧义**:一个实体经多个别名命中 → 去重为一个结果(不造假歧义);一个别名字面命中多个实体 → 列候选(不 exact 就取第一条)。
- **什么证据能让两个 claim 落到同一 entityId**,只有 §2.3 的 hard 边;possible 边只记相关、不归并。

### 2.3 别名边分级:猜测/纠正/切换/continuation 各不相同(P1-2)

`learnStableId`(core.ts:125-182 [F])的变化**不是一种**,必须分开(审查最强反例:同目录两线程 A/B,新 run R 先被 daemon 猜成 A、后被权威 MCP metadata 证明属 B;rev1 会把 R↔A↔B 永久等价,纠错反而固化错误):

**一句话原则(rev3,round-2 P1-2):传播不提升置信度,只有源头证据能。** 一个字段无论被 announce 携带、复制、还是重新广播多少次,它的置信度始终 = 其**源头断言**的置信度;发布/复制不洗白。

| 事件 | provenance | confidence | 对解析的作用 |
|---|---|---|---|
| 同一条 announce 同时带的 (run/native/handle/busPid) | same-announce | **承袭源头**(非无条件 hard) | 互为别名,但每个字段的置信度 = 其源头证据:源头是 daemon 猜测的字段(core 会把 A_guess 原样广播,core:169-182 [F];core:159-161 是同值 early-return,另一回事)在 announce 里**仍 possible**;源头不明/旧 peer 来源不可考的字段**不得 hard**;只有源头本身是 hard(权威 bootstrap / 本进程自带的 run+busPid)才 hard |
| 首次权威 bootstrap(undefined→Y,authoritative) | learn-bootstrap | **hard** | Y 加入本化身(源头即权威) |
| 猜测(daemon guess,authoritative=false) | learn-correction(候选) | **possible** | 仅候选关联;**纠正时撤销**;经 announce 传播**不升级** |
| 猜测被纠正(A_guess→B_authoritative) | learn-correction | B=hard,A_guess 及**其所有派生 claim** 置 `revokedBy` | revoke 覆盖派生 claim(被广播复制出去的 A_guess 副本一并撤销),不固化 A↔B |
| 线程切换(A_auth→B_auth,同 transport) | thread-switch | 各自 hard,但**不互相等价** | A、B 是**不同逻辑线程**(core:172-175 不搬状态、:303-320 按目标身份隔离 [F]);transport 目标切换**不因共用同一裸 run 而重建等价闭包**——同 run 只是同一 transport,不是同一逻辑会话 |

- **跨 run 重启的真 continuation(I1 的 r1→r2)**:两 run 之间**可能没有任何 learnStableId 边**。v1 **诚实留缺口 [I]**:无可信宿主/恢复上下文证据时,**保守分裂**,只在 whois 标 `possible-related`(同 tool/cwd/nativeId、时间不重叠、busPid 不同),**不自动归并、不选 currentReplyTo**。不许用「又一枚可继承的环境变量」冒充 continuation 证据。
- **possible 边永不进自动解析的传递闭包**:它只让 whois 多打一行「可能相关:<其他实体>」。
- **晚到事件读快照不读可变 self**:directory 构造 announcement 时已捕获快照是现成做法 [F];别名写入同样捕获当时的 (run/native/pid),绝不在回调里读已经切到 B 的 self(审查 P2-3 窗口 3)。

### 2.4 pid 的三重区分与出生绑定(P1-3)

被探测的 pid 必须说清「测谁的命」:
- **busPid**(`self.pid`=presence/MCP 进程,label:116)活 ≠ 宿主活:MCP 端点可退出/重启而宿主仍在。
- **hostPid**(`AGENTHOP_HOST_PID`,presence:73)才是宿主(claude/codex)。它**不在** SelfInfo/RemotePeer,是 **[D] 新增**要采集的字段,不能把 busPid 改个标签冒充。
- **pid 复用**:`kill(pid,0)` 成功只证明「这个数字现在有进程」,不证明原化身还活。故 Incarnation 带 `birth`(hostPid + 可得的 host 启动 ticks),whois 判活时核对出生证据;对不上就是复用,不复活旧实体。
- **历史 pid 的探测结果只属于该观察目标**,不覆盖另一个当前宿主/端点的活证据。
- 无可信宿主关联时,**只报「总线进程在/缺,宿主未知」**,不升级成「实体真死」。

### 2.5 谁写、何时失效、提交边界(P2-2/P2-3)

- **采集在去重之前。** core.unified()(core:192 调 resolve.ts:38-57 [F])先按 stableId 丢掉一行、再按 run id 合并——**别名写入若在 unified 之后,既丢掉合法 presence+MCP 双端点的 run 别名,又抹掉检测 9ac3eb4 碰撞所需的第二条证据**。故别名日志从**原始 announce/learn 事件**取,保留来源与**源内顺序**,区分 bus transport / native session / host 进程三层。
- **写者与提交**:single-writer(本机串行)或版本化发布。每条事件带稳定 `eventId` + **捕获时不可变 payload** + 源内顺序;重放幂等(同 eventId 同 digest = no-op)。投影 `aliases.json` 记 `appliedOffset`;查询可对「权威已提交前缀」追平,读到落后就按落后处理,不猜。
- **record-before-advertise**:announce 可见之前先持久别名事件;做不到则给可靠重试/回填,并**声明其历史局限**(崩溃在 announce 后、持久前 → 旧 run/native 边可能缺,whois 对这些旧 id 返回 `incomplete` 而非错指)。
- **提交前缀与截断尾恢复(rev3,round-2 P2-3)**,三条:
  1. **完整事件才算 committed**:一条事件以换行终止才视为已提交;发布偏移(appliedOffset)只在整条落地后前移。失败/半截写入**不前移偏移**,对外不确认。
  2. **截断的未提交尾,修复后才允许 append**:重启读日志若发现末尾半条(无换行终止),先 **truncate 到最后一个完整行**再追加——否则「半条 E2 + 完整 E3」会拼成一条坏行(一条读不出、且吃掉 E3)。
  3. **已提交记录的损坏 = 显式 corruption/incomplete 事实**(round-3 补,覆盖「以换行终止但 JSON 坏」的边界——它有换行故非规则 2 的未提交尾,又在末尾故非「中段」,原先掉缝里):**所有已提交记录的损坏(含最后一条以换行终止的记录)均为显式 corruption/incomplete 事实,不 truncate、不 skip;仅已知未提交的无换行尾可恢复性截断。由坏权威日志重建投影不自动清除 corruption 事实。** whois 报告 corruption 并进修复路径;静默跳行 = 一条已发布事件凭空消失,违反「身份日志不可丢事实」。
- **存储**:`~/.agenthop/bus-identity/alias-log.jsonl`(append-only)+ 投影。msglog 的先例只证明**可做诊断日志**(msglog.ts:72-89:可关、写失败返回 false、读侧丢半行 [F])——**身份权威日志不可丢事实**,故比 msglog 多了 eventId 幂等 + appliedOffset + 不可丢语义。
- **失效**:身份映射本身不失效(append-only + 撤销事件)。失效的只有 COMPUTED 面:reachability、liveness——每次 whois 现算。别名表无 TTL、无 alive 位。I7 的 presence 死条目滞留:**滞留的是 roster,whois 用实测活性覆盖**(但 whois 覆盖显示 ≠ 已清理名册,见 §9 表)。

## 3. 冲突与纠正:可重放的撤销/拆分(§0 教训 + P2-1)

- **冲突检测**:归并时若「同一 native 下有多个并发活 busPid 且 cwd/run 不同」(9ac3eb4 类),**不归并,记 `collision`**,各自独立 entityId。
- **误并的纠正必须可重放**:append-only 日志若只记归并、不记撤销,重放会重建错误。故关联断言可被 `revoke`/`split`/`dispute` 事件追加撤销,带 provenance + link id,重建时应用。**已公布的错误实体 E 被拆分后**:旧键返回「已拆分/多候选 + 各自证据」的历史结果,**不静默改指其中一半**。
- **冲突不冻结 whois**:返回候选实体 + 各自证据;共享的争议别名不自动选一个,但**无争议的 run 查询照常工作**。一个进程退出**不自动洗白**先前误并(保留历史冲突,让当前各实体可操作)。长期歧义是明确的安全结果,不是反复冻结的活锁。

## 4. 读面:whois

### 4.1 查询路径(先去重实体,再判唯一/歧义)

```
agenthop whois <任意 id|句柄|pid|前缀>
```
input 当**不透明串**查表(不靠「像 UUID / 像数字」猜形状,与 resolvePeer 一致,审查采纳 §9.5):
1. 任一**未撤销** alias 精确命中 → 收集所有命中的**实体**,去重。唯一 → 该实体;多个 → 列候选(短句柄碰撞、native 冲突、pid 复用都走这里,不取第一条)。
2. 否则按 alias 前缀命中(复用 resolvePeer 前缀语义 [F])→ 唯一/歧义同上。
3. 否则 pid 命中(扫化身 busPid/hostPid,**带出生核对**)→ 实体;复用的 pid 不算命中。
4. 否则「未见过」或「incomplete」(§2.5 的持久局限)——不猜、不判死。

### 4.2 输出(三面分列,绝不合并)

```text
entity <entityId>   tool=<…>  cwd=<…>
  identity (recorded):
    incarnations: n0(run,native,busPid,hostPid,scope) → n1(…) → …
    aliases:  <全部未撤销形态,带 form/provenance/confidence/化身号>
    [possible-related: <其他 entityId>(heuristic:同 tool/cwd/native,不重叠)]   # 仅 possible 边
  reachability (roster now):
    reply-to: <经校验确属本实体的在册句柄 | none>     # 冲突时绝不返回别的实体的共享句柄
  liveness (probed now):
    local busPid <P>:  present | absent              # kill(0),带出生核对
    local hostPid <H>: alive | dead(双证据) | suspected | unknown(EPERM/缺目标/出生对不上)
    remote:            reported-recent | stale       # relay:按 announce 新鲜度,非实测,显式标注
    last activity: <Ns ago(presence/status 时刻,非已验证业务产出) | unknown>
  [collision: 多实体共用 <native/pid> → 列各候选 entityId + busPid/cwd]
```

I7 的 unknown 被拆**且各带来源/推断等级**(审查 P2-4:不许断言):native 缺 = 「MCP 端点尚未拿到 metadata **或** 无 hook」(两种可能,不断言哪种);化身 startedAt 近 = 「刚起(线索)」;hostPid dead 且近期无产出 = 「符合死亡政策的 dead」;单信号/EPERM/远程 = suspected/unknown。

### 4.3 人与 agent 同一入口

纯内核 `whois(aliasTable, roster, probeFacts, id) -> Entity`(身份解析,无 IO);CLI/agent 外壳负责采集 probeFacts(现场 pid 探测)并共用判定。章程「人与 agent 同一入口」= 同一内核两个前端。**内核纯、采样在壳**:不把缓存 alive 伪装成纯查询结果。

## 5. 替换接缝:sweep 的三态 + 死亡政策(P1-4)

sweep **已是三态**(task-sweep.ts:24/32 alive/suspected/dead,:82 保留 suspected,:112 **仅 dead 改派** [F])。所以**设计向实现看齐**:新证据生产者必须产出符合政策的三态,不能用一个未定规则的 boolean 直接替换。

whois 导出:
```
liveness(entity) -> {
  state: "alive" | "suspected" | "dead",
  evidence: Array<{ target: "busPid"|"hostPid"|"remote", result: "present"|"absent"|"errno:EPERM"|"reported"|"stale", at, pid? }>,
  reason: string   // 近因说明(dogfood F17 要求)
}
```
死亡政策:**只有符合政策的 dead 才进 sweep 的 dead 分支**。
- dead 需:绑定正确的 hostPid 实测 absent + 出生核对一致 + **近期无产出**(近因冲突时降级)。
- suspected/unknown:单信号失败、EPERM、缺目标、身份歧义、**远程未测**、busPid absent 但 hostPid 未知。
- **roster 缺席与「同一条 announce 的 TTL 过期」是同源事实,不算两份独立证据**(审查 P1-4)。
- 近期真实产出与一次负探测冲突 → 输出 suspected + 冲突说明,不改派。

## 6. 与证据纪律的关系(F17 更正后)

dogfood.F17 的纪律 = 单侧弱探测不得推翻近期产出判死;判死需独立证据 + 近因。本设计落地为:记录面(别名表)与实测面(liveness probe)分列;dead 需「实测 absent + 出生一致 + 无近期产出」多面一致,单面不判死。brain 的 Git readback F17 仅作记忆法援引,不充当死亡判据。

## 7. 后续接缝(诚实边界,P2-4)

- **I3 = sent/delivered/acked**(三段投递信号)、**I4 = 发送预检 + 类型断言**:**都不在 whois v1**。rev1 曾把 reply-to 误标 I3——更正:reply-to 是章程 §2.3 目标,不是 I3。
- **reply-to 规范化(v1.5)**:`agenthop_send(to=X)` 先 `aliasTable.resolve(X)->currentReplyTo` 再交 resolvePeer。v1 已算出 currentReplyTo(§4.2,且**校验确属该实体**),v1.5 插进发送路径。
- **可解析 ≠ 送达**:currentReplyTo 只证明 addressability,不证明此刻送达/宿主读到/开工。历史 id 无当前端点 → none。不得由本层推出「任意历史 from 100% 可回复」。
- roster TTL 清理(I7 的名册侧)不在本稿;whois 只做**覆盖显示**,不改名册。

## 8. 验收(章程既有 + 审查补充)

user 拿 I6 的两个真实 id,一条命令定位到同一实体:
```
agenthop whois 01a0ead5   # codex native/thread id
agenthop whois 673c6525   # 其 run id
```
两条 → 同一实体——**前提是别名表里存有把这两形态系到一起的 same-announce 观察**(§2.3 hard 边)。审查要求的诚实:若该配对事件未被持久(announce 前崩溃等),whois 返回 `incomplete`,**不凭字符串相似事后补硬链接**;验收须带**已保存的配对事件**或明确受信导入证据。

## 9. I1–I7 逐项覆盖(诚实映射,P2-4)

| 章程项 | v1 承担 | 未覆盖 / 显式后续 |
|---|---|---|
| I1 漂移 | 记录同会话晚到 native、句柄/端点关联、历史查询;化身链 | 真跨 run continuity 需可信证据;v1 无硬证据则**保守分裂 + possible-related**,不自动并 |
| I2 裸 run/双通道 | whois 把**已证**别名解析到实体 + 展示当前可解析地址 | 直接 send(old alias) 不因 whois 改变;别名规范化发送 = v1.5 |
| I3 三段信号 | **不在 v1** | sent/delivered/acked 另立协议;不得误标为 reply-to 已覆盖 |
| I4 预检/类型断言 | v1 给候选身份 + 地址证据 | 实际 sendPrecheck、收件人/工具类型断言未实现;tool 标签 ≠ 任务角色授权 |
| I5 活性权威 | 本机**绑定正确目标**的 probe + 保持三态 consumer | 宿主目标来源/死亡政策本稿已定;远程仅弱报告,非 OS 实测 |
| I6 人可查 | CLI+agent 共享内核、完整歧义输出 | 需保存配对依据 + announce 前后 not-seen/incomplete + 追平;旧未观测历史不捏造 |
| I7 unknown 拆义 | 输出缺证据/刚起线索/stale + **来源等级** | no-hooks 等因果标签需额外证据;roster TTL 清理未实现(仅 whois 覆盖显示) |

## 10. 正面确认(审查保留,不动)

无 alive 位(§1/§2.5)、身份与活性分面(§4.2)、currentReplyTo 标非 durable、pure whois 内核(§4.3)。

## 11. round-2 已定结论(写入稿)

rev1 的五个 open question 在 round-2 定论,照收入稿:

1. **跨 run continuation 的可信证据**:`(hostPid, cwd)` **只证同宿主 H,不证同一逻辑会话**。无受信关系证据时,v1 **不硬归并**:只标 `possible-related` 或保守分裂;硬归并留给未来的受信恢复上下文,不靠可继承环境变量。
2. **误并晚发现 / split 的消费者语义**:拆分后旧 entityId 返回「已拆分 / 多候选」——**对消费者(sweep 等)这是歧义,不是全局冻结**;歧义目标不触发定向改派,无争议查询照常。(不必 operationId 式全表冻结。)
3. **presence + MCP 双端点 vs 9ac3eb4 双非法进程**:`(hostPid, cwd)` 只是**定位线索**,不是判别依据——合法双端点倾向同 hostPid 同 cwd、非法碰撞倾向不同,但这只缩小范围。同 §11.1:`(hostPid, cwd)` 只证同宿主,**不单独构成硬归并逻辑会话的证据**;双端点的归并仍需受信关系(同 hostPid 下的已知 presence/MCP 配对),否则 possible-related。
4. **远程实体**:无法 pid 实测,liveness **一律降 `suspected`**(按 announce 新鲜度 reported/stale 展示),**永不**凭远程推断给 alive/dead。
5. **birth 证据缺失**:拿不到可校验 host 启动时间时,pid 复用防御退化为「busPid absent → **suspected 不 dead**」兜底;**birth 缺 → unknown,绝不判 dead**。

**新增字段的边界(round-2 确认)**:busPid/hostPid/birth 等 [D] 字段先作**本机观察 envelope**(alias-log 内),**不扩网络帧**(relay presence blob 不变)——跨机身份归后续,符合章程跨机边界。
