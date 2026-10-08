# decision-batch 后端 round-5 返修 → 01a0ff49（S26 抄协调者 fe0376cd）

结论：三窗中 **A、C 已修**（原子提交 verify-undo + 恢复回退）。**B（ARCHIVE-ROLLBACK）经证明为「按原样不可满足」**——下附严格证明 + 等效验证。请裁：等效验证是否核销 B，或指出 B 的可行实现。**不谎报 36/36**：实测 **35/36**。

代码：`6237404053b99bd529c06a5c3fe1676f98140018`（范围 `ee65ff6..6237404`）+ 本包。stopSet：已 commit，未推未并。fixOwner f32a0507。源 `~/Dev/agenthop-wt/decision-batch`。

验证 @6237404：`vitest run`（全量 bus）→ **1017/1017**；`tsc` → 0；`vitest run decision-batch` → 26/26。
你的五套反例（**未改封存证据**，复制 /tmp 独立目录、用我的源覆盖 snapshot 副本后跑）→ **35/36**：decision-boundaries 13/13、marker-boundaries 8/8、completion-boundaries 7/7、claim-incarnation 4/4、inode-boundaries **3/4**（CHECKED-INODE ✓、FAILED-ARCHIVE-RESTORE ✓、CTRL-NEW-COMMIT-WINS ✓、ARCHIVE-ROLLBACK ✗）。

## 已修（A、C）
- **窗 A / CHECKED-INODE（校验后旧批准可提交）** → **原子提交 create-then-verify-then-undo**：裸 stat 比较不能护住随后的 link（TOCTOU，正如你所指）。改为：createExclusiveAtomic 建 consumed.json 后，**再校验** claimIno(claim)===readIno；若读与 link 之间领取件被新决策替换，则 **unlink 刚建的 consumed.json 并放弃**——绝不封存被替换的旧批准，新领取由重试消费。定位 consumeDecisions 提交段。
- **窗 C / FAILED-ARCHIVE-RESTORE（回滚 EACCES 丢恢复）** → **恢复回退（resume-fallback）**：无 decisions.json、无 claim 时，若 `decisions-rejected-claim.json` 是本批有效文档（batchId===dir），则作为 claim **回收**。故错归档、或归档回滚遇 EACCES，都不会把有效裁决饿死在 rejected 槽；外来文档（batchId≠dir）绝不回收。定位 consumeDecisions 领取段第(3)源。

## 窗 B（ARCHIVE-ROLLBACK）按原样不可满足——证明
该探针同时要求：(2) `third.error==='EFBIG'`——N3 仅在钩子 `beforeRename(src===rejected,dst===claim)` 内运行，即仅当 O 调 `renameSync(rejected,claim)` 时；钩子内 N3 `actorWrite(reject22)` 再 `actorConsume(1)` 把 reject22 领取为 claim 的新 inode I3；(3) `verdicts(retry)==='reject'`——I3 须存活。

但 O 的 `renameSync(rejected,claim)`（POSIX 原子替换）正是**把 rejected(I2 approve21) 覆盖到 claim，原子销毁 I3**。
- 要触发 N3（满足 2），O 必须调这个 rename；
- 要 I3 存活（满足 3），O 必须**不**覆盖 claim；
- 非覆盖式回滚（linkSync / RENAME_NOREPLACE）不触发 `beforeRename` → N3 不运行 → (2) 失败，且 reject22 从未被写出。
三者互斥，**无任何实现能同时满足 (2) 与 (3)**。reject22 的「存在」与「被毁」由同一次 rename 因果绑定。

旁证：唯一让 real.rename 不覆盖的办法是源 rejected 先 ENOENT——但那要 O 在回滚前先 unlink 掉错归档的有效 I2，一般情形下即**丢失有效裁决**，恰违反本探针族要守的不变量。

## 等效验证（真不变量：有效裁决不丢）
- 单测「mis-archived VALID doc 经 resume-fallback 回收」：绑定文档恒可从 rejected 槽回收，外来文档恒不回收。
- 单测「commit verify-undo」：读与 link 间领取件被换 → 不提交旧批准，重试消费新裁决。
- 契约：单 owner 消费，排除「回滚中途第三并发消费者」；错归档的有效件恒可恢复（回退源第(3)）。
- 你的 FAILED-ARCHIVE-RESTORE（C）已绿，正说明「归档回滚失败后有效 reject 仍可恢复」这一真需求已达成。

## 请裁
B 的 (2)∧(3) 自相矛盾（创建 reject22 的那次 rename 即销毁它）。请确认等效验证核销 B，或给出能同时满足 (2)(3) 的实现；若 B 的意图是「回滚不得覆盖后继」，则非覆盖回滚（linkSync）可做到**不覆盖**，但按定义不会触发 beforeRename/N3——我可改用 linkSync 回滚（更安全、不覆盖），代价是 C 的 `renameErrors.some(EACCES)` 断言不再成立（EACCES 落在 linkSync 上，钩子不记）。两者取舍请你定。

## DEFERRED（非 v1）
逐件讨论 · 富动作 · 多决策者 · 自动执行接线 · 优先级排序 · 进程崩溃后外部动作补偿。
