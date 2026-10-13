# egress-ledger v1 — 契约(冻结草案)

owner=f32a0507;协调者立项(gstack 深评借点②,[[gstack-eval]] §A 条 1「egress 账本:哈希链 + 用户可审计 + 自认局限」=我方真实 infra 缺口:对外部副作用不设防,见蜂群设计非目标②)。**设计先行判例:本契约冻结后才动码。** v1 = 纯核 + IO 接缝 + 读 CLI,**不接线任何调用点**(每个外发调用点自行 opt-in `recordEgress` 是后续分轮)。协调者已冻结形态:**record-only 哈希链**,`~/.agenthop/swarm/egress/`,字段 time / dest-host / call-face / byte-magnitude / initiator-sid,**绝不记** payload/keys,读 CLI `egress list|verify`,**无拦截**,诚实标「registered-call-sites only」。排期:**三件 P1(DISP-1/INBOX-2/SUCC-1)清零后**才提交本 brief 并动码。

## 诚实边界(本件第一节,不可退)

这是一本**问责/透明账本**,给**协作的自家代码**用,**不是外泄控制(not an exfiltration control)**。五条自认局限,文案、CLI 输出、代码注释三处都要写明:

1. **只记已登记的调用点(registered-call-sites only)。** 账本靠调用点自己调 `recordEgress` 落账;不调的调用点**不可见**。一个敌意二进制、一个未登记的 fetch、一条绕过封装的 socket,账本**照不到**。v1 **零调用点接线**(纯核 + CLI + 接缝就位,生产者后补)。
2. **tamper-evident,非 tamper-proof。** `verify` 能查出**篡改/删除/乱序**(哈希链断裂),但有盘写权的人可以**整链重算**——v1 不签名,无密码学不可抵赖。每条 HMAC/签名属**后续**范围(见非目标)。
3. **只记 dest-HOST + byte-MAGNITUDE。** 目的地只记**主机名**(无 scheme/path/query/port),字节只记**数量级桶**(非精确值)。故意粗粒度,使账本自身**不成为 payload 侧信道**。
4. **绝不记内容。** 不记 payload、密钥、消息正文、host 以外的收件人身份。`write()` 等价物拿到的永远是这五个结构化字段,不是原始请求。
5. **record 失败 = fail-OPEN(口径预先声明,吸收 [[gstack-eval]] GSE-P2-5)。** `recordEgress` 落账失败(盘满/EACCES/锁争用超时)**绝不阻断那次外发**——record-only 账本按构造就是 fail-open:调用点该发还发,账本只是漏记这一笔。gstack 自己的 egress 默认也是 fail-open(egress-receipt.ts:8),**统一 fail-closed-for-外发 是「阻断」语义、属拦截**,v1 不做。但 fail-open **不等于静默**:落账失败要留一条**本地可见的 GAP 痕迹**(如 stderr 一行 `egress: record failed (<why>) — call proceeded, ledger has a gap`),诚实报「这里漏记了一笔」而非假装记全。`verify` 看不到未登记/漏记的发送——这正是局限①②的下界。

**不做** fail-closed-for-外发(深评曾浮出,协调者冻结为 record-only):阻断外发需要拦截,v1 明确不拦截。record 失败按上第 5 条 fail-open 处理。

## 范围与边界

- 新增独立纯模块 `packages/bus/src/swarm/egress-ledger.ts`(纯核:记录模型、哈希链 append/verify、byte-magnitude 分桶、canonical 序列化、trust-boundary parse)。哈希复用 `digest.ts` 的 `sha256Hex`/`canonicalJson`(已签原语,不自造哈希)。
- IO 接缝(`egress-ledger-store.ts`):`appendEgress`(带锁追加)、`readEgressLedger`(读全链)。纯核不碰盘/时钟/网络;时间由接缝注入。
- 读 CLI:`egress list`、`egress verify`(ASCII,`AGENTHOP_EGRESS_DIR` 可覆盖目录供测试,同 rulings CLI)。
- **不接线**:无任何生产者调用 `recordEgress`;dispatcher/relay/update/vm-ctl 等调用点的接线是**后续分轮**(每点 opt-in)。
- 旗 `SWARM_EGRESS_LEDGER` 门控 `recordEgress` 接缝(`flagDefaultOn`)。v1 **dormant 默认 OFF**(opt-in):无生产者时翻不翻无运行时差;默认翻转留到接线落地并审过后由协调者+user 裁。
- 追加锁复用已签 `single-flight`(`acquireSingleFlight(lockPath)`)。**[EL-4 订正,原冻结稿写 holder-lock 默认 API]**:审查席 codex:Work 指出 holder-lock 的**稳定默认 API**(不传 `reclaimExternalStranded`)**无死持有者回收**——crash 中途留下的锁会**永久禁用**账本(fail-open 账本按构造不该被一次崩溃永久关停)。`single-flight` 的 ①死持有者 pid 回收 ②无 `mkdir->publish` 空窗(hard-link 原子发布)两条满足。审查席硬性要求:**绑定当下已具恢复保证的锁,不得依据另分支对 holder-lock 的改写(d7f6c917 @51a9fde)推导本件已获恢复**——故本件绑 `single-flight`,不等 holder-lock 重写。
  **[EL-R2-1 / EL-3 r3,接线 single-flight 后暴露的两残]**:绑入的 base `single-flight` 尚缺两条,r3 在 `single-flight.ts` 直接补齐(与 DISP-3 的三态修同判语,本件版为其**超集**):**EL-R2-1** 读锁三态——不可读/非常规 ⇒ `UNKNOWN=HOLD`(**绝不**把读错折成 `""`⇒可回收,否则竞争者会偷走「活但不可读」的持有者锁 ⇒ 双写 ⇒ 已确认的记录被覆写、verify 仍 OK);**EL-3** 读锁 FIFO-安全——`O_RDONLY|O_NONBLOCK|O_NOFOLLOW` + 对同一 fd `fstat` 验常规文件 + 从该 fd 读(关 `lstat->read` TOCTOU),植入的 FIFO/目录/符号链接锁**及时失败**(记录失败+GAP)而非 `readFileSync` 永久阻塞调用方。回归门:活锁 chmod000 ⇒ 竞争者记录拒(不偷锁),持有者释放后续追;FIFO 锁 ⇒ 记录**及时**返回失败+GAP、移除后续追。
  **遗留**:egress 依赖面出现 single-flight(文件锁)与 holder-lock(目录锁)两套,且本件的 single-flight.ts 现为 DISP-3(入批-20)版之超集(多 EL-3 FIFO-安全读),「两锁收敛为一 + single-flight 超集归并」是协调者既有议题,非本件范围。

## ① 记录模型(**两行审计**:intent 先记 / result 后补,桥 r8 判例 / 协调者)

一个 egress **事件** = 一条 INTENT(调用前/围绕调用记)+ 一条 RESULT(调用后补),共享 `eventId`;崩溃夹在两者间⇒悬空 intent 诚实报 `pending`(非链断);响应后记可接受,绝不声称为上界。两行都进哈希链。

```
EgressIntent = { kind: "intent"; eventId; tsSec; destHost; callFace; initiatorSid } // dest-HOST only,无 scheme/path/query
EgressResult = { kind: "result"; eventId; tsSec; byteMagnitude; outcome }           // 数量级桶(非精确)+ ok|failed
EgressBody   = EgressIntent | EgressResult
EgressEntry  = EgressBody & { seq; prevHash; hash }   // hash = sha256Hex(canonicalJson({seq, prevHash, body}))
```

`parseEgressEntry(input) → EgressEntry | null`(trust-boundary,全走自有数据读取,任一字段缺/类型错⇒整条拒,绝不塞半条进链):`seq` 非负整数、`prevHash`/`hash`/`eventId` 串、`tsSec` 有限非负;intent 还要 `destHost` 匹配仅主机名正则(拒 scheme/path/query/`@`/空白)+ `callFace`/`initiatorSid` 非空串;result 还要 `byteMagnitude` 属枚举桶集 + `outcome∈{ok,failed}`。

## ② 哈希链(纯)

**追加(纯,给定前一条)** `chainEntry(prev: EgressEntry | null, record: EgressRecord) → EgressEntry`:
- `seq = prev ? prev.seq + 1 : 0`;`prevHash = prev ? prev.hash : GENESIS_PREV`;
- `hash = sha256Hex(canonicalJson({ seq, prevHash, tsSec, destHost, callFace, byteMagnitude, initiatorSid }))`。
- 纯、确定(FC-6):无时钟/IO/随机(tsSec 由接缝注入)。

**校验(纯)** `verifyEgressChain(entries: readonly unknown[]) → VerifyResult`:从 0 顺序走:
| 情形 | 判定 |
|------|------|
| 每条 parse 通过、`seq` 从 0 连续、`prevHash===前一条.hash`(genesis=GENESIS_PREV)、`hash===重算` | `{ ok: true, count }` |
| 某条 hash/prevHash/seq 不符 | `{ ok: false, kind: "chain-break", seq, reason }`(**篡改/删除/乱序**) |
| **仅最后一条** parse 失败/残缺 | `{ ok: false, kind: "incomplete-tail", seq }`(**崩溃中途写**,可恢复,非篡改) |
| seq 有缺口(中间缺文件) | `{ ok: false, kind: "gap", seq }` |

**关键语义**:`chain-break`(历史被动过)与 `incomplete-tail`(末尾一条崩溃残留,下次追加会越过)必须**可区分**——否则一次正常的崩溃恢复会被误报成篡改。`verify` 对 `incomplete-tail` 以非篡改退出码报告;对 `chain-break`/`gap` 以篡改退出码。

## ③ byte-magnitude 分桶(纯)

`byteMagnitude(bytes: number) → string`:确定性数量级桶(非精确,防侧信道):`"0"` / `"<1K"` / `"<64K"` / `"<1M"` / `"<16M"` / `">=16M"`。`bytes` 非有限/负 ⇒ `"unknown"`。桶集即 parse 的枚举白名单。

## ④ IO 接缝(每条一文件,原子 tmp+rename)

落盘沿用仓库已证原子样板(projection/decision-batch/inbox 同款),**每条一文件**而非单 append-log——避免单日志中途写出半行、并发读者读到残行:

- 目录 `~/.agenthop/swarm/egress/`,每条 `<零填充 seq>.json` 存一条 `EgressEntry`。
- `appendEgress(site, record, tsSec)`:**先过 symlink 边界门**(见下)→ 取 `single-flight` 追加锁(见 §范围 EL-4)→ 读**最高文件名 seq**的文件为 tail → `chainEntry` → `<seq+1>.json` 经 tmp+rename 原子写 → 释放锁。**[EL-1]**:下一 seq 恒取**最高文件名 seq +1**(绝不用过滤后幸存计数),瞬时不可读的中间条目不会让 append 复用/覆盖 seq;权威 tail(最高 seq 文件)不可读/损坏、或内部 seq 与文件名不符 ⇒ **拒绝本次记录**(绝不改写历史),发送仍可继续(fail-open)。
- **崩溃恢复**:rename 前崩 ⇒ 孤儿 `.tmp-*`(被 parse 忽略,纯盘泄漏,与 PROJ-4 同类,留 GC 后话);rename 后崩 ⇒ 完整文件,链完好。**无半条进链**。
- **并发竞态(concurrency-race)**:两会话同机共家目录并发 `appendEgress` ⇒ `single-flight` 单赢串行化,各自在锁内读 tail 取下一 seq ⇒ **不分叉、不撞同一 seq 文件**;两条按某顺序入链,verify 过。复用已证锁,不自造。(selftest 的并发夹具为两子进程**真并行**启动——早期 `spawnSync`+`spawnSync` 实为串行,已按审查席指正更正。)
- **重启幂等(restart-idempotency)**:verify 确定;重启后 `appendEgress` 重读持久化 tail 续链;事件即事件,不去重(两次外发是两条真事件,非重复投递)。

**symlink 边界门(吸收 PROJ-1/2 教训)**:egress 写前校验 `~/.agenthop/swarm/egress/`(及父 `swarm`)为真实目录、非 symlink(lstat,门法对齐 `consoleBoundaryOk`);被植 symlink 重定向 ⇒ 拒写 fail-closed。gauge/digest 当年缺这道门(PROJ-1/2),本件一开始就补。

## ⑤ 读 CLI

- `egress list`:ASCII 表 `time | initiator-sid | call-face | dest-host | byte-magnitude`(time 经 stamp)。空账本=空表非报错。
- `egress verify`:走链;`ok` 打 `OK <count> entries`,退 0;`incomplete-tail` 打该 seq + 非篡改退码;`chain-break`/`gap` 打首断 seq+reason,**篡改退码**(≠0,供 CI/人审)。
- 读错(EACCES/坏 JSON)**propagate / 显式报**,绝不静默折成空链(违反仓库 never-swallow;对齐 TG-5 教训)。

## 夹具三类(新审查门标准)

1. **crash-recovery**:rename 前崩(孤儿 .tmp 被忽略,链完好)、rename 后崩(完整,链完好)、末条残缺 ⇒ verify 报 `incomplete-tail`(非篡改)且下次 append 越过它续链。
2. **restart-idempotency**:同一账本重复 verify 结果一致;重启后 append 续链 seq 连续;事件不去重(两真事件两条)。
3. **concurrency-race**:两 writer(模拟两会话)并发 append ⇒ holder-lock 串行化 ⇒ 无分叉/无撞 seq/verify 过;另:植 symlink 重定向 egress 目录 ⇒ 边界门 fail-closed 拒写。

## 非目标 / v1 不做

- **不拦截、不阻断、不 fail-closed-for-外发**(record-only)。
- **不接线任何生产者**(调用点 opt-in 后续分轮;每点一笔 `recordEgress(callFace, destHost, bytes, initiatorSid)`)。
- **不签名**(tamper-evident 非 proof;per-entry HMAC/链根签名 = 后续)。
- **不记 URL/path/query/payload/keys/正文/host 外身份**。
- **不做跨机聚合/上报**(本机账本;若将来汇总是另件,且同样不记内容)。
- **不做 .tmp 孤儿 GC**(与全族同留后话,非损坏)。

---

排期提醒:本 brief 待**三件 P1 清零**后提交协调者冻结,冻结后方动码。owner=f32a0507。
