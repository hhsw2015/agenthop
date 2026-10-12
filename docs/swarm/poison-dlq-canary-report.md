# SWARM_POISON_DLQ — canary 执行实证记录(FC-2 layer-2)

北极星差距审计件②:执行此前观察页(`poison-dlq-observation.md`)推荐的金丝雀,给 FC-2 第二层「strike→quarantine→S19→drain」留一条**实证记录**,清掉观察页的 UNVERIFIED 口径。

- **执行:** 2026-10-12,隔离 canary harness。
- **基线:** main `d63b1a5`;分支 `feat/poison-dlq-canary`。
- **结论:** 全链 **14/14 PASS**。FC-2 layer-2 的 strike-阈值→隔离(字节保留)→毒件通知义务→投协调者 S19→排空(确认送达后删除)**端到端组合正确**。
- **证据:** `~/Work/review-reports/poison-dlq-canary-20261012/`(`evidence.json` + `canary.mts`)。

---

## 0. 范围与权限(诚实口径)

- **这是隔离 harness 验证,不是生产流量观测。** canary 跑在一个独立 `AH_HOME`(mkdtemp),用一个**测试 drainer** 身份 + 一个**测试 coordinator**(非真协调者 fe0376cd),构造一条毒件,驱动**真实的** `packages/bus/src/inbox.ts` + `checkin.ts` 函数,顺序与 `core.ts` 的 drainer 逐行一致。
- **零生产触碰、零花费、零对外发布、可逆**:不碰任何真实成员/真箱/真 PROGRESS;不花钱;S19 投到隔离 home 里的测试 coordinator,不是线上;AH_HOME 是临时目录。故**不触 R16 三门**(spend/publish/irreversible),属普通隔离测试工作(与日常 selftest 同类)。
- **旗状态已核验:** `poisonDlqEnabled` 现 = `flagDefaultOn(SWARM_POISON_DLQ)`,**生产默认开**(user 的默认翻转裁定,2026-10-11 起;`inbox.ts:461`)。观察页当初「翻默认=user 门」已由该默认翻转覆盖;本件只做隔离机制验证,**不改任何生产旗/状态**。
- **「push THROWS」如何构造:** 不 mock 假 push——直接走 `core.ts` 在 push 抛出后执行的那条真实路径(`recordPoisonStrike` → `shouldQuarantinePoison` → `enqueuePoisonNotice` → `quarantineInbox` → `clearPoisonStrikes` → later `drainPoisonNotices`→`deliverToCoordinator`),输入是一条**合法信封**(过 `validInboxMsg`,故 layer-1 schema-quarantine 不会先截它——它是 layer-2 的「合法但投递崩溃」毒件)。

## 1. 方法(逐行镜像 core.ts)

1. 隔离 `AH_HOME`;测试 coordinator presence(`presence/<coordSid>.pid`)使 `deliverToCoordinator` 可解析。
2. 合法信封 `poison`(`validInboxMsg(poison) !== null` ✓),写成 drainer 箱内一个**已认领**文件 `…json.claim-<pid>`。
3. 三次 push-THROW strike:`recordPoisonStrike(file, mem)` ×3,每次 `shouldQuarantinePoison(strikes, 3)` 判定。
4. 第 3 击(达阈值):`source = poisonNoticeSource(file)` → `buildPoisonS19(...)` → **先** `enqueuePoisonNotice(home, source, coord, notice)` **再** `quarantineInbox(...)`(core.ts 顺序:义务先持久化,再移隔离)→ `clearPoisonStrikes`。
5. 排空:`drainPoisonNotices(home, (t,m)=>deliverToCoordinator(home, self, t, m))`——仅当 `isQuarantineConfirmed(source)`(隔离字节在盘)才投递,投出 `"sent"` 后删除通知文件。

## 2. 实证结果(14/14 PASS)

| 检查 | 结果 |
|---|---|
| 旗生产默认开(空 env `poisonDlqEnabled({})`) | ✅ true |
| 信封合法(非 layer-1 schema-poison) | ✅ true |
| 阈值 = 3(`poisonDlqThreshold`) | ✅ 3 |
| strike 1/2 不隔离、strike 3 触发隔离 | ✅ `[{1,false},{2,false},{3,true}]` |
| 毒件通知义务已持久化(`enqueuePoisonNotice`) | ✅ true |
| 隔离结果 = `quarantined` | ✅ |
| 隔离字节在盘(`quarantine/` 1 文件,字节保留) | ✅ `…json.1791768840992.545a16c5fc4ce969` |
| `dead-letters.jsonl` 追 1 行审计 | ✅ |
| 排空前 `poison-notices/` 1 件义务 | ✅ |
| S19 投递返回 `"sent"` | ✅ |
| S19 落测试协调者箱(1 件) | ✅ |
| S19 文案为 `[poison-dlq]` 通知 | ✅ `[poison-dlq] 毒件已隔离(投递崩溃 3 次,已达阈值)。来源 canary-src via local;失败轨迹: Error: canary ho…` |
| 通知队列确认送达后排空到 0 | ✅ |
| 隔离后 strike sidecar 清除(`clearPoisonStrikes`) | ✅ |

- **strike 序列**(`evidence.json`):`[{strike:1,wouldQuarantine:false},{strike:2,wouldQuarantine:false},{strike:3,wouldQuarantine:true}]`——阈值前不误隔离,阈值到才隔离。
- **隔离字节**:`quarantine/0000000000001000-abcd1234.json.<ts>.<hex16>`——原始毒件字节保留(FC-2 承诺:never deleted)。
- **S19 送达**:`deliverToCoordinator` → 测试协调者箱 1 件,文案 `[poison-dlq] …`;`poison-notices/` 排空到空(确认送达后删)。

## 3. UNVERIFIED 口径清零

观察页(`poison-dlq-observation.md`)当时记:**「UNVERIFIED(无正反证据):whether the full strike→quarantine→S19 flow has ever run」**。

- **本件清零该项**:FC-2 layer-2 全链已在隔离 canary 中**用真实函数、按 core.ts 顺序跑通**,组合正确性有实证(14/14)。「从未运行/机制未经演练」的疑虑**解除**。
- **诚实边界(不夸大)**:这是**隔离 harness 对真实函数的验证**,**不是生产流量观测**。生产侧仍是观察页记录的样态:layer-1(F28 schema-quarantine)承接 schema/parse 毒件;一条「合法信封但 push 崩溃」的 layer-2 毒件在生产中罕见,观察窗内生产毒击计数仍为 0(见 `inbox.ts:458` 注与观察页)。本 canary 证的是**机制可用**,不是**生产已发生**。
- **kill-switch 不变**:`SWARM_POISON_DLQ=0` 即关(回 v0:release+retry,无 strike 计数)。

## 4. 复现

```
cd ~/Dev/agenthop-wt/pdcanary
node --import ./node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs \
  ~/Work/review-reports/poison-dlq-canary-20261012/canary.mts
```
输出 `ALL_PASS: true` + 14 检查;`evidence.json` 为固化证据。脚本为 scratch(不入 repo src,零代码改);本报告是唯一 repo 变更。
