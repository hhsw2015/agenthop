# §0b 增补草案 rev3(两条,源自 Comma 对照调研)——round-2 核销 0P1+1P2,唯一 P2 已按总线确认文字落入,待 round-3 终核

日期:2026-10-03。状态:**草案 rev3**。round-1 报告:…review-2026-10-03.md(2P1+4P2→全 closed);round-2 报告:…review-2026-10-03-rev2.md(0P1+1P2,A2 通过);本版唯一改动=落入 round-2 唯一 P2 的最小补句(successor 继承完整自动化状态,[R2-1]),文字即总线上双方确认稿。流程不变:审到 0/0 → user 门(改冻结协议)→ 合入。
来源:docs/research/comma-completion-mechanisms.md(agenthop 主仓)。

## A1:WaitRecord 自动展期预算(堵「escalate 无限续命」)

**缺口**(不变):R2 现行条款要求 escalate 带 newDeadlineSec 且不 resolve 原 approval,但无累计上限,自动催办可无限循环。

**增补文字(rev2)**:

1. **字段与实化 [R1-A1-P2-1]**:CreateWait(openWait)时把**有效值**实化并持久化——`extensionBudgetSec`(整数秒)、`extensionCount`(整数次数上限)、`extendedTotalSec=0`、`extensionsUsed=0`、`budgetPolicyRef`(策略来源+版本)。新建即使采用全局默认也写实值,**不省略字段**。legacy 缺字段记录保持旧行为(无自动展期约束),有限性不变量**仅覆盖带实化预算的记录**;要覆盖 legacy 需显式迁移,不借投影「加字段不升版」推导协议零迁移——那条只管读侧形状,不管权威 reducer 行为。
2. **计费定义 [R1-A1-P1-1]**:计量对象=「授权的未来等待窗口」:费用 = `newDeadlineSec − decisionNowSec`,其中 `decisionNowSec` 是**随操作持久化的决策时刻**(sweep/调用方在提交的 Change 里携带,reducer 不读墙钟——同 operationId 重放输入不变,费用不变,且重放本就 no-op 不重复收费)。每次自动展期**最小正消耗 1 秒**(`newDeadlineSec ≥ decisionNowSec + 1`,整数秒);不满足 ⇒ 拒绝该展期。`extendedTotalSec` **单调不减**:缩短期限是另一种操作(不走展期分支),不返还额度。次数与量双界:`extensionsUsed+1 ≤ extensionCount` 且 `extendedTotalSec+费用 ≤ extensionBudgetSec`。**有限性证明**:有限预算 B+最小消耗 q=1 ⇒ 自动展期 ≤ min(extensionCount, floor(B/1)) 次。物理消息重试沿同 actionId,不算新授权展期。
3. **耗尽分支是可提交的转换,不是裸拒绝 [R1-A1-P1-2]**:预算/次数不足以再展期时,action_done 走**exhausted 分支**,原子提交:既有动作完成证据 + `automationExhausted{atSec, budgetPolicyRef}` 标志 + (approval 且 decision 仍 pending 时)唯一的**最终交接意图**(finalHandoffAction,同 CAS-then-IO 纪律,未知送达沿同 actionId reconcile)。被拒绝的只是「继续自动展期」,完成证据与耗尽事实**绝不丢弃**。
4. **两种终局分开 [R1-A1-P1-2 / 六问③]**:耗尽终结的是**自动催办**,不是审批责任。approval 可此后长期、公开地处于 pending/awaiting-human(automationExhausted 可见,sweep 不再对它产生自动动作);真实裁决(granted/denied/cancelled,带权限与 subject revision 检查)任何时候照常完成。预算算式**永不**产生 grant、不伪造人工拒绝、不释放 UNKNOWN 实体、不绕 R4 验收(brain 物理证据规则不变)。`resolution` 留给真实等待终结;自动耗尽是独立事实字段。
5. **预算与自动化状态不可洗 [R1-A1-P2-1 + R2-1]**:预算不被 put-wait 重放、owner 变更重置。若最终交接/迁移创建 successor wait:successor 继承同 episode 的**完整自动化状态**——extendedTotalSec、extensionsUsed、extensionBudgetSec/extensionCount/budgetPolicyRef、automationExhausted 标志,以及(若已存在)finalHandoffAction 的**不可变身份引用与其完成/未知状态**。**同一 episode 至多一个 finalHandoff 身份;耗尽状态跨 successor 单调不可逆;已耗尽 episode 不因换 waitId 重新武装自动展期或再造 final 动作**(重复迁移沿同 actionId reconcile,不产生新『最终』通知)。已存在的 finalHandoff:**已完成的不因迁移重发;未知状态的沿同 actionId reconcile,payload/target 不改**——继承禁止的是再造与变体,不是完成。等价实现:同 episode 始终同 waitId(不建 successor)亦满足本条。
6. **约束位置 [六问①]**:全部在 reducer/提交验证层(所有写入口共享),sweep 只是提议者之一;人工工具同受约束。

**不变量(rev3)**:∀带实化预算的 wait episode(跨所有 successor):自动展期次数 ≤ min(extensionCount, extensionBudgetSec);extendedTotalSec 单调;automationExhausted 单调不可逆;**episode 内 finalHandoff 身份唯一**;耗尽后不再有自动展期转换,但既有 finalHandoff 的确认/reconcile、取消与真实裁决仍可提交。
**可失败验收**(照搬 round-1 开列):zero-charge/负 delta 不得循环;负向调整不减 total;同操作跨重启费用不变;耗尽分支提交前后/最终通知 IO 前后崩溃,耗尽事实与待执行动作不丢、重放不新增通知身份;人永不回复 ⇒ 无 grant、审批保持 pending、不再自动展期;真实裁决到来仍可正常完成;successor 不重置额度且继承 exhausted+finalHandoff 身份(W0 exhausted+H0 完成 ⇒ W1 不得产生 H1,自动迁移链上『最终』动作恒一个);默认配置变更不改已存在记录的预算。A2 补回归(round-2 建议,非阻塞):notComparable 作不可比较屏障的显式用例;episode 恢复不清业务/job 预算的显式用例。

## A2:失败指纹重复检测(堵「预算内空转」)

**缺口**(不变):同一确定性失败烧完预算才终局。

**增补文字(rev2)**:

1. **指纹是版本化 profile,结构化白名单 [R1-A2-P2-1]**:`failureFingerprint = digest(profileVersion + 白名单字段)`。白名单**保留**:failureClass、origin/phase、ruleId/checkId、errorCode、稳定细节(逻辑路径、服务/操作、业务日期、expected/actual 断言值)。**仅剥离** profile 明确列名的运行元数据:envelope 时间戳、traceSeq、实例/VM ID;workspace 根只在受信执行上下文中替换为占位,保留相对路径。**不按「长得像日期/UUID」猜噪声**。只有自由文本无法可靠解析时 ⇒ `notComparable`,走既有预算策略(诚实漏检,不造假等价)。原始 evidence 引用+规范化 payload+指纹+profileVersion 一并保存。复用 canonical JSON 哈希原语,**不改**任何既有 spec/result/operation digest 的序列化规则。profile 升级不重算旧日志、不追改已提交终态。
2. **比较域=同身份失败谱系 [R1-A2-P2-2]**:同 job/node、同 specDigest+inputBindingDigest 的链;不同 profileVersion 之间不可比。**只计 CONTROL 顺序内首次提交的合法失败裁决**:后继 attempt 继承 streak(a1:F→a2:F ⇒ 2);ResultObserved/日志/validator 回包不计数;同失败 operation 重放不多计([1,1,2] 不是 [1,2,3])。**新候选不增不清**:S9 修订、V2/V3 discard、V6 replay、handoff 均不改链;spec/input 变更开新链;成功断链;旧记录缺指纹=不可比较边界(F→unknown→F 不拼成连续 2)。显式重启检测 episode 须受控 reset 决定,不能借改 candidate/waitId 隐式洗史。
3. **触发语义=获准的换策略,不是永久性证明 [R1-A2-P2-1/P2-3]**:连续 2 次同指纹 ⇒ 触发 `repeat-failure-policy`(记录原因),**不把 failureClass 偷换为 permanent**——相同指纹不证明第三次必失败,这是成本政策不是确定性判决。business-fail 的触发动作:在**既有单计数点**记一次 retriesUsed 后,按政策提前走修复链/FAILED(计数、理由、状态同批提交,崩溃重放不多计)。
4. **infra 分支独立接线 [R1-A2-P2-3]**:transient-infra 不经过 business_fail hook——在其自身合法事件分支调用**共享纯失败记录器**(不加 retriesUsed)。先区分「读取失败/同一 UNKNOWN 的重复查询」与「真正已提交的 infra 终结」,前者不计。连续 2 次同指纹 infra 终结 ⇒ 按显式策略开**可恢复的 backoff/health-check wait**(固定 subject、幂等身份、deadline/timeoutPolicy、自动恢复条件),并接入 retry admission(wait 未解除不派发;解除后检查身份/预算/容量,**保留恢复后第三次合法重试**)。不默认永久终败、不转人工审批、不因暂停释放 UNKNOWN。该 wait 的展期服从 A1。
5. **「≤2」的诚实限定 [R1-A2-P2-3]**:不变量限定为「本次自动重试 episode 内,同谱系连续同指纹失败达 2 即触发政策」;经受控恢复/换策略后的后续重试是新 episode,可合法出现第三次失败。

**不变量(rev2)**:同 episode 同谱系连续同指纹失败 ≤2 必触发政策;指纹不同/不可比较按原预算;候选与观察操作零副作用于链。
**可失败验收**(照搬 round-1):仅 envelope 噪声不同 ⇒ 同指纹;状态码/逻辑路径/业务日期/断言值不同 ⇒ 异指纹;两次 ECONNRESET 后第三次成功不被禁止;a1/C1:F+a2/C2:F ⇒ 触发;重放 ⇒ [1,1,2];S9/V6 不改链;两次真 infra 终结 ⇒ wait 且 retriesUsed 不变;两次读取错误不冒充 infra 终结;wait 未解除不派发、恢复后第三次可成功;先 commit 后 IO。

## 审查要求(round-3 终核)

单点核销:round-2 唯一 P2 的补句是否按确认稿落实、是否引入新接缝(episode 继承与 brain 既有 supersede/handoff 语义的交互)。0/0 即出具终核结论,随后进 user 门。
