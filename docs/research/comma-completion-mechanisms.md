# Comma(AFK-surf)调研:它如何确保「这件事办完」,对 agenthop 蜂群的价值

日期:2026-10-03。来源:github.com/AFK-surf/Comma(AGPL,Elixir/OTP + Lean + TLA+,161 star)。
读过:README、docs/agent-runtime.md、docs/salix/tasks-background-execution.md、docs/verification.md、docs/architecture/PRODUCT_MODEL.md、tla/salix/ 目录。

## 它是什么

自我定位是 **Dot 的开源替代**(user 确认其宣称对标 Dot)——与我们「一群 Dot 的公司」总目标同源:它是「单个 Dot 怎么做到 relentless」的完整工程答案,我们做「一群 Dot 怎么协作」,单体机制可直接对照吸收。

"Sessionless, relentless personal agent":会话只是界面,**Task 是持久执行状态**;目标拆成 Task 后由独立 agent loop「计划-执行-review-验证」直到完成。Router(协调者)+ Worker(执行者)结构,一个 Task 恰好一个责任 Worker,Router 独占状态变更权。

## 它靠什么确保办完(机制清单,按层)

1. **接受的工作不丢(内核级证明)**:Lean 定理 accepted_work_conserved——已接受输入在任意崩溃/重启的有限轨迹上必有耐久表示;「队列 ACK 只确认落盘,不等于业务完成」。负例测试钉住「未过 fence 的接受」「无工作实体的接受」。
2. **意图先于效果(intent-before-effect fence)**:副作用动作先记录再执行;被打断的变更动作**绝不自动重跑**;诚实声明不承诺 exactly-once 外部效果,要求下游用稳定去重键。
3. **旧执行者不能覆盖新状态**:epoch/fence 机制,stale worker 的写被栅栏拒绝。
4. **看门狗层层叠**:
   - TaskWorkerWatch:监控活跃 Task,对沉默停摆的 Worker **提醒一次**,然后**每次委派只通知发起者一次**——有界催促,不无限唠叨。
   - WaitExtension:超时/恢复时重新武装 wait,但有**累计展期天花板**(1800s)——等待可以延,不能无限延。
   - Loops Reconciler:每分钟重放未 ACK 事件;15 分钟无 ACK 则 Loop 进入 failed 终态并解释重试/丢弃。
   - 失控护栏:连续 2 轮不结算判回合失败;5 次相同结果停;单输入 120 轮硬顶。
5. **完成判定收权**:只有拥有者 Router 能完成 Task,且仅限「已验证交付+无剩余工作+无待人决策」的一次性 Task;**消息永远不能 reopen Task**;客户端超时/卡片不能独立完成或取消;「completed 状态不证明人已验收」——人工验收是独立的带版本检查的操作。
6. **廉价常驻看守(Loops)**:agent 自己写的小 C 程序(编译成 eBPF 沙箱),盯收件箱/仓库/feed,**只在有事时唤醒 agent**——"a quiet hour uses no large-model tokens"。唤醒有预算(6 次/10 分钟),超了自动暂停。
7. **诚实失败分类**:「有界的依赖错误是合法终态;无界的静默重试不是」;「不得把存储故障归类为毒输入来让循环看起来有界」。
8. **身份纪律**:"Do not persist a live process or connector-run ID as the Agent's stable identity"——稳定身份与运行时进程 ID 分离。

## 与我们冻结契约的收敛点(相互印证,不需要改)

| Comma | 我们(brain/team-collab) |
|---|---|
| accepted work conserved | CONTROL 日志耐久 + R2(不在耐久状态里的等待对系统不存在) |
| intent-before-effect fence | commitControl 意图先提交再 IO,崩溃可重放(R2 最小验收 item 2) |
| stale worker fencing | generation 隔离输出 + publishGeneration |
| failed reply ≠ completed work | 两层验收:worker 自报 ≠ SUCCEEDED,accepted 条目是权威 |
| completed ≠ human acceptance | 北极星:人只裁三类,验收独立 |
| messages never reopen Tasks | R0:DM 永不推进任务状态 |
| TaskWorkerWatch 有界催促 | 委派三纪律(ack/心跳/产物探针)+ sweep 匹配规则 |
| 毒输入分类诚实条款 | transient-infra vs business-fail 分类 + F13 证据原则 |
| 进程 ID ≠ 稳定身份 | bus-identity I2(F18 双 ID 实弹正是此教训)|

收敛密度这么高说明两边都在解同一组分布式 agent 的根本问题——我们的设计方向有了独立旁证。

## 值得吸收的四件事(按价值排序)

1. **等待的累计展期天花板(直接的契约缺口)**:我们 WaitRecord 的 escalate 要求 newDeadlineSec 且「升级绝不 resolve 原 wait」,但**没有累计上限**——escalate→新期限→再 escalate 可以无限循环。Comma 的 wait_for_extension_ceiling(总额 1800s)堵住这个洞。建议:WaitRecord 增 extensionBudget(总展期预算,耗尽→强制进入终态裁决),走 §0b 勘误/增补通道,双审查方记录。
2. **相同结果重复检测**:我们有重试预算,但没有「同一失败指纹连续出现 N 次→提前停,不烧完预算」的护栏。可作为失败分类的廉价增强(failureFingerprint 连续 2 次相同→直接 escalate,不再 RETRY_WAIT)。
3. **Loops 思路佐证 sweep 方向**:他们用「廉价看守唤醒昂贵模型」把 relentless 做到零闲置成本——正是我们「sweep 用代码替换人肉协调者」的极致版。印证优先级排序正确;远期可把巡检 tick 从「唤醒完整 Claude 回合」降级为「纯代码检查台账,只在匹配时唤醒」。
4. **性质清单当测试检查表**:他们 Lean/TLA+ 检查的性质目录(接受不丢/失败回复不算完成/副作用先记录/打断不重跑/旧写被栅栏/数据跨界按策略)可直接当我们 reducer+sweep 组合测试的性质检查表用——不必上 Lean,property-based 测试即可覆盖同类性质。1cfa162 的反例驱动+变异验证已经是同一方法论。

## 不建议搬的

- Elixir/OTP + Lean + TLA+ 整套:他们是产品级常驻服务,我们是 git+文件+总线的轻量蜂群;形式化的**性质**可搬,**工具链**不必。
- eBPF Loop 编译器:我们的看守需求用纯 TS 代码跑台账即可,没有不可信第三方 watcher 的沙箱需求。

## 附:ChatGPT Dot(OpenAI,2026-10 上线)对照笔记(user 供料,视频实测转述)

OpenAI 版的同一物种,验证整个方向已是行业共识。与我们蜂群的对照:
- **形态同源**:异步委托(交代→推进→有进展回电)、云端自有电脑(合盖继续干)、任务拆解+持续跟进、只在需判断时回人——正是我们的北极星「晚上交代早上验收」+ R3-b 通知分流。
- **它的「叫醒理由」分级**(交期变化/成本增加/待批才通知,一般进度只记工作日志)——与我们三类裁决+worklog 完全同构;它的 worklog 思想我们今天刚落地。
- **协调层也同构**:Dot 可启动/协调 Work 与 Codex 任务 = 我们的协调者 Dot 派活给成员;「并行任务在后台、对话照聊」= 我们的板+泳道。
- **我们已走在它前面的**:对抗审查流水线(它无)、停摆定理+sweep 机器监督(它靠云端常驻,无明示活性保证)、免疫流水线(F→回归)、单编辑者/监管链纪律、全链耐久事实(它的记忆分层含糊)。
- **它走在我们前面的**:产品化入口(电话/Slack/Teams/短信规划)、云端浏览器带独立登录态、本机授权桥(桌面 app 接管)、费用隔离(Dot 对话不计额度)。
- **可借鉴落点**:①「连接服务≠建立监控:观察什么变化、何时通知需要明说」——这句该进我们的委托信封模板(通知策略字段);②「接管云端电脑再归还控制台」的人工介入形态 = 我们 approval-wait 的 UI 化方向;③新手三小测(先定完成判据)= 我们验收纪律的用户侧包装。
