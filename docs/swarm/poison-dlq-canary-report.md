# SWARM_POISON_DLQ — FC-2 layer-2 隔离验证记录(助手组合 + 决策逻辑)

北极星差距审计件②。**诚实范围(r2 按审查 PDC-1/2/3 校正):** 本件是 FC-2 第二层**助手函数组合 + 决策逻辑的隔离验证**(成功路径 + enqueue&&quarantine 持久化失败分支),**不是**对真实 `pushToHost→catch` 触发的金丝雀,**也不清除**观察页的生产历史 UNVERIFIED。真实触发金丝雀(真 push 崩溃驱动真 drainer)**仍待办**。

- **执行:** 2026-10-12,隔离 harness。基线 main `d63b1a5`;分支 `feat/poison-dlq-canary`(r1 固定 `7e61ee3`)。
- **结果:** 隔离验证 **20/20 PASS**(场景①成功路径 15 + 场景②持久化失败分支 5)。
- **证据:** `~/Work/review-reports/poison-dlq-canary-20261012/`(`canary.mts` sha256 `970a2ce1…`,`evidence.json`)。

---

## 0. 这是什么 / 不是什么(PDC-1/PDC-2)

- **是:** 在隔离 `AH_HOME` 里,用**真实的** `inbox.ts`/`checkin.ts` 函数,按 `core.ts` drainer 的**决策顺序**(含 `enqueuePoisonNotice(...) && quarantineInbox(...)` 短路),验证 FC-2 layer-2 的组合与分支逻辑:阈值计击、隔离+字节保留、通知义务、投协调者 S19、排空删除;以及**持久化失败时不隔离、留件待重试**。
- **不是:** 不驱动真实 `pushToHost → catch → 旗门 → strike` 接线(`core.ts:215`),不经 `flushInbox`,不经前两次失败的 release/reclaim。脚本里「push 崩溃」是**直接调用崩溃后那条 strike 路径**(不是真实 pushToHost 抛错)。故**不是**对 `core.ts` 实际 push→catch 的端到端触发。
- **不清除生产历史 UNVERIFIED:** 见 §3。本件只新增一条「FC-2 决策/组合逻辑在隔离下可用」的证据。

## 1. 范围与权限(诚实口径)

- **零生产触碰、零花费、零对外发布、可逆**:隔离 `AH_HOME`(mkdtemp),测试 drainer + 测试 coordinator(非真 fe0376cd),构造毒件;不碰真实成员/真箱/真 PROGRESS;AH_HOME 临时目录。**不触 R16 三门**(spend/publish/irreversible),属普通隔离测试。
- **旗状态已核验:** `poisonDlqEnabled` 现 = `flagDefaultOn(SWARM_POISON_DLQ)`,**生产默认开**(user 默认翻转裁定,2026-10-11 起,`inbox.ts:461`)。本件不改任何生产旗/状态。
- **token 等不涉及**(本件是 poison-dlq,不是 TG)。

## 2. 方法与结果(20/20)

### 场景①:成功路径(15 检查)

逐行镜像 `core.ts` 决策顺序:3 次 strike(`recordPoisonStrike`,`shouldQuarantinePoison` 门)→ 第 3 击:`source=poisonNoticeSource(claim)` → `buildPoisonS19` → **`enqueuePoisonNotice` 先,`quarantineInbox` 仅在 enqueue 持久化成功后(短路 &&)** → `clearPoisonStrikes` → `drainPoisonNotices`(仅 `isQuarantineConfirmed` 为真才投)→ `deliverToCoordinator`。

| 检查 | 结果 |
|---|---|
| 旗生产默认开(空 env `poisonDlqEnabled({})`) | ✅ |
| 信封合法(非 layer-1 schema-poison) | ✅ |
| 阈值 = 3 | ✅ |
| strike 1/2 不隔离、strike 3 触发 | ✅ `[{1,false},{2,false},{3,true}]` |
| enqueue 义务持久化(true) | ✅ |
| 隔离结果 = quarantined | ✅ |
| 隔离字节在盘(1 文件) | ✅ |
| **隔离字节 == 原信封(逐字节相同)** | ✅ |
| dead-letters.jsonl 1 行 | ✅ |
| 排空前通知队列 1 件 | ✅ |
| S19 投递 `sent` | ✅ |
| S19 落测试协调者箱(1) | ✅ |
| S19 文案 `[poison-dlq] …` | ✅ |
| 通知队列确认送达后排空到 0 | ✅ |
| 隔离后 strike sidecar 清除 | ✅ |

### 场景②:持久化失败分支(5 检查,PDC-2 顺序语义)

把 poison-notices 路径预置为**文件**,使真实 `enqueuePoisonNotice` 的 `mkdirSync` 抛错 → 返回 **false**;按 `core.ts` 短路 `enqueue && quarantine`,enqueue 失败 ⇒ **不调用** quarantine。

| 检查 | 结果 |
|---|---|
| enqueue 返回 false | ✅ |
| quarantine **未被调用**(短路) | ✅ |
| 消息**留件待重试**(`.claim` 仍在) | ✅ |
| strike 在 mem 保留(=3,未清) | ✅ |
| 未建 `quarantine/` 目录 | ✅ |

> 这修正了 r1 的顺序缺陷(r1 无条件先后调用两函数再查 enq);现与 `core.ts:241` 的「义务持久化失败就不隔离、保留消息」逐字一致。

## 3. 生产历史 UNVERIFIED —— 维持,不清除(PDC-1)

观察页(`poison-dlq-observation.md:27`)原文完整为:

> **UNVERIFIED(无正反证据):** whether the full strike→quarantine→S19 flow has ever run **in production**.

- **本件不清除该项。** 隔离的函数组合验证只能新增「此组合已在隔离环境执行且逻辑正确」的证据,**不能改变生产历史是否发生过的未知状态**。本报告后文「不是生产观测」与「清零生产历史」不可同时成立——故**生产历史 UNVERIFIED 继续成立**。
- **保留观察页采样局限:** 成功 ack 会清 strike sidecar;`dead-letters.jsonl` 只记隔离**结果**(非每次 strike);采样时这些文件不存在**不能证明**窗口内无 strike。本件未新增任何生产观测,**不可**据此延伸为「当前生产毒击计数 0」。
- **要核销生产历史问题,需另有真实运行记录**(真 push-crash 触发或生产流量观测);本席不为此触碰生产。
- **kill-switch 不变:** `SWARM_POISON_DLQ=0` 即关(回 v0:release+retry,无 strike 计数)。

## 4. 复现(自包含失败门,PDC-3)

```
cd ~/Dev/agenthop-wt/pdcanary
node --import ./node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs \
  ~/Work/review-reports/poison-dlq-canary-20261012/canary.mts <OUT_DIR>
# 退出码:全通过=0,任一检查失败=1(process.exit(ALL_PASS?0:1))。
# OUT_DIR 可省(默认 /tmp/pd-canary),脚本 mkdir -p 父目录;evidence.json 写入该目录。
```

- **自包含门(PDC-3):** 失败即非零退出(r1 缺此门,6 项 false 仍退 0 — 已修)。
- **输出路径参数化 + 建父目录**(r1 硬编码 `/tmp/pd-canary` 且不建父目录 — 已修)。
- **固定依赖:** 基线 `d63b1a5`;脚本 sha256 `970a2ce1718ef9a9be0383e8b3196547cce1c1111474afc960eb9503c8c243db`。脚本为 scratch(不入 repo src,零代码改);本报告是唯一 repo 变更。

## 5. 仍待办(诚实)

- **真实触发金丝雀**:用真 `pushToHost→catch` 或运行真 drainer 对一条真崩溃毒件走通——这才清除生产历史 UNVERIFIED;需隔离宿主 IO(不需真协调者/生产消息),或生产流量观测。本件未做。
