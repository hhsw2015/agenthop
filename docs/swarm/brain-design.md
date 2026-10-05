# agenthop 蜂群大脑设计（业务编排层）

日期：2026-10-03。对照 HEAD：`01ea35b0a62b155c4f916b0c02137cb7ab77f2b8`（feat/swarm-railway，worktree `/Volumes/Share/projects/dev/agenthop-wt/integration`）。
输入：先验研究报告 `/Volumes/Share/projects/dev/happycapy/_agenthop_prior_art.md`；Codex 复审 `~/Work/review-reports/swarm-codex-review-{2b659cc,a3c5514,01ea35b}.md`；本仓库 swarm 源码全量实读。只读分析，未改任何代码、未启动服务、未动云资源。

标注约定：**[F] 已实现事实**（有 file:line）；**[I] 静态推断**（未跑真机）；**[D] 新增设计**（本文的提议，文件/模块名均为建议，不表示已存在）。

修订：v3（2026-10-03），两轮 Codex 设计审查后的版本——`brain-design-review-2026-10-03.md`（P1=5/P2=8/P3=1）与 `…-v2.md`（P1=3/P2=6/P3=1）逐条修订;v1 快照 `3a696d8f…`、v2 快照 `70f8343f…`。

---

## 1. 概述、范围、非目标

### 1.1 问题

现有系统管理的是 **launch 的生命周期**：一个 Railway 临时 VM 从分配、发布快照、临终交接到退役的全过程。`ControlRecord` 的主语是 launchId（control.ts:42 [F]），`nextAction()` 决定的是 VM 交接动作（control.ts:289 [F]），manifest 只有 launchId/generation/kind/goal/next（manifest.ts:21 [F]）。没有任何结构回答：**这个 VM 在为哪个业务任务工作？任务的输入是什么？产出算不算数？下一个任务能不能开始？**

蜂群大脑 = 把「一个 launch 的可恢复快照」提升为「一个稳定业务任务在固定输入上的可验收结果」，再用这些结果驱动 DAG 和最终综合。它是**新增的一层**，不替换生命周期层。

### 1.2 范围

- 数据模型：TaskPlan / TaskSpec / TaskAttempt / ExecutionBinding / TaskResult / AcceptedResult。
- 业务任务状态机 + 与现有 VM 交接、快照发布两轴的交互规则。
- 纯 ready-set、业务重试、两层结果验收、CONTROL 持久接口升级、聚合/综合协议。
- 真实 Claude worker 接线方案（swarm-task.sh `--task`）。
- 失败模式矩阵、分阶段实施计划（每阶段可失败验收）。

### 1.3 非目标（explicit NON-GOALS）

1. **Exactly-once 执行**。Railway 无 fencing/幂等键（control.ts:8-13 头注 [F]），范围是 at-least-once + 代际隔离输出。重复执行的模型成本由预算约束，不被消除。
2. **不可幂等的外部副作用安全**。任务契约只允许 worker 写自己的 work tree（artifactScope/sourceWriteScope）；worker 对外部系统（发邮件、部署、改第三方状态）的副作用不设防，明确禁止在任务 goal 里要求此类动作。
3. **自动大目标分解**。规划（目标 → DAG）由人或规划 agent 产出**显式 DAG**，校验器只拒绝非法图（重复 ID、缺依赖、自环、环），不自由拆分目标。happycapy 的固定三步模板不是分解算法（先验研究 §2.1）。
4. **异构 worker 竞价/评分**。当前同构 Claude microVM、cap=3，先用硬过滤（槽位、寿命、预算），有遥测后再谈评分。
5. **跨机无 SPOF**。在 commitControl 真实接线（§4.3，Phase T3）完成前，**不得宣称** dispatcher 整机丢失可恢复。当前权威状态在本机 mirror（swarm-dispatch.ts:6-10 头注、:33 [F]）。
6. **第二套基础设施**。不建 Relay Hub、共享 SQLite 黑板、独立 receipt/seq 通道、Python 服务（先验研究 §3.7）。git commit/tree/blob 已内容寻址，Git 内文件不需要另一套校验和。

### 1.4 一条贯穿的例子（后文反复引用）

目标拆为：定接口 C → 并行实现 P、Q → 集成 I → 验收 R。
C 验收后，P/Q 的 inputBindings 指向 C 的 acceptedResultId。P 的 VM 临终，现有 handoffStep 把 checkpoint 接力到新 launch，**P 的 TaskAttempt 不变**（多了一条 ExecutionBinding）。Q 先完成，CONTROL 接受 Q 的结果，但 I 不启动。P 续跑完成并验收后，I 才拿到固定的 P/Q 输出引用。I 发现两份 patch 语义不兼容 → 生成 repair 节点，不回退 WORK 历史。R 验收最终树后 job 成功；VM 清理仍归生命周期层。

---

## 2. 数据模型 [D]

全部为**新增独立模块**（建议 `packages/bus/src/swarm/task-plan.ts`、`task-state.ts`、`task-result.ts`），不往 ControlRecord 堆字段。与现有结构的唯一连接点是 ExecutionBinding 里的 `(launchId, publishGeneration)`。所有结构不可变（每次变更产生新版本记录），与 control.ts 的纯函数风格一致。

### 2.1 TaskPlan / TaskSpec

```text
TaskPlan {
  jobId: string              // 一个业务 job 的稳定身份
  planRevision: number       // 计划修订号；返工/改图 = 新 revision，旧 revision 的未启动 attempt 作废
  nodes: TaskSpec[]          // 稳定顺序 = ready-set 的 tie-break 顺序
  jobBudget: {
    maxTotalAttempts: number       // 全 job 业务 attempt 总数上限
    maxWallClockSec: number        // 全 job 墙钟上限（从 plan 提交起）
    maxModelUsd?: number           // 可选；靠 CPA eph-token 的 budget_usd 槽位（mint.ts [F]，CPA 侧默认 inert）
  }
  planDigest: string         // canonical JSON 的 SHA-256；幂等/冲突判定用
}

TaskSpec {
  nodeId: string             // 计划内唯一
  kind: "work" | "integration" | "synthesis" | "review" | "repair"
  goal: string               // 给 worker 的任务描述
  dependsOn: string[]        // nodeId 列表；必须指向计划内节点；无自环/环（装载时校验）
  outputContract: {          // 验收的机器可读部分
    requiredOutputs: Array<{ logicalName: string; kind: "patch" | "files" | "report" | "notes"; pathHint?: string }>
    baseSourceCommit?: string    // kind=patch 时：patch 相对哪个固定源码 base
  }
  acceptance: Array<{ check: string; args?: object }>   // 声明式验收检查清单，见 §4.2
  artifactScope: string[]    // 允许发布的 WORK 产物路径前缀（supervisor allowlist 的子集）
  sourceWriteScope?: string[] // kind=patch 时:patch 允许改动的**源码** base 内路径前缀——与 artifactScope 是两个
                             // 坐标系（Codex v2-P2-5:patch.diff 在 out/ 里,它改的是 src/,用同一个 scope 必然矛盾）
  estimatedRuntimeSec: number
  retryBudget: number        // 业务重试上限（默认 2）
  specDigest: string         // 本节点 spec（上述字段）canonical JSON 的 SHA-256；跨 revision 的「同一任务」判定用（V5）
}
```

**理由**：
- `planRevision` 而不是原地改图：返工（repair、改依赖）必须产生新 revision，使「哪个 attempt 属于哪张图」永远可判。旧 revision 里 RUNNING 的 attempt 不强杀（杀不掉，at-least-once）；其节点 spec 若在新 revision 中变了（specDigest 不同），结果在验收时被 V5 拒掉，spec 没变的照常验收（§4.2 规则 V5）。
- `nodes` 数组顺序即稳定顺序：happycapy ReadyQueueCalculator 的「按输入顺序排序」被保留（先验研究 §2.2），不用时间戳。
- `acceptance` 是声明式清单而非自由文本，否则 validator 无法机械执行（先验研究 §3.5：不继承「产物校验失败也可成功」）。
- 不设 requiredCapabilities：同构 worker（非目标 4），留给未来 revision 加字段，不预留空壳。

### 2.2 TaskAttempt

```text
TaskAttempt {
  attemptId: string          // `${jobId}/${nodeId}/a${n}`，n 单调
  jobId, planRevision, nodeId
  status: "RUNNING" | "RESULT_PENDING_VALIDATION" | "SUCCEEDED" | "RETRY_WAIT" | "FAILED" | "ABANDONED"
                             // BLOCKED_BY_DEPS/READY 不落盘——它们是 readyTasks() 的派生值，见 §3.1
                             // FAILED 只写终败：permanent / retryBudget 耗尽（勘误 2026-10-03:原文此处还列
                             // 「job 预算尽」——与 §3.1 的判定下沉矛盾:job 预算是 job 层事实,由 jobStatus=failed
                             // 表达(readyTasks 对预算尽一律不放行),不逐个改写 attempt 终态;否则预算尽瞬间要原子
                             // 改写全部在途 attempt,且它们随审计语义是「停格」而非「业务终败」。§3.1 终败判定第二
                             // 分支「或 job 预算尽」同步勘误删除。T1 实现复验时 Codex 核出注释与原文不一致,裁定
                             // 记录于 brain-T1-pure-rereview-2026-10-03.md）
                             // ABANDONED = 作废（stale-input/stale-plan/重试接替/intent 撤销）：不算成功也不算终败，
                             // 历史 attempt 一律只作审计；节点的完成/终败判定见 §3.1，不看历史 attempt 状态
  inputBindings: Array<{     // 创建 attempt 时一次性解析、冻结
    depNodeId: string
    acceptedResultId: string // 依赖的「已验收结果」身份，不是依赖节点的状态
    workCommit: string       // 该结果所在的 WORK commit SHA（固定、可 fetch）
    resultPath: string       // 该 commit 内 result.json 的路径
  }>
  inputBindingDigest: string // sorted(inputBindings) canonical JSON 的 SHA-256
  baseSourceCommit?: string  // 代码任务的源码 base（随 plan 固定）
  specDigest: string         // 创建时从当时 plan 的节点抄入——V5 的比对对象就存这里（Codex 审查问询）
  executionBindings: ExecutionBinding[]   // 只增
  retriesUsed: number        // 业务重试已耗。**唯一计数点 = business-fail 进 RETRY_WAIT 那一步 +1**;接替 attempt 原样继承,不再加（v2 两处都 +1 会双扣,retryBudget=2 实际只剩 1 次——Codex v2-P2-3）。transient-infra/stale/inconsistent-snapshot 不加
  retryAt?: number           // RETRY_WAIT 时的到期时刻；退避+抖动在写入时采样一次并持久，重放不再随机
  failureClass?: "transient-infra" | "business-fail" | "stale" | "inconsistent-snapshot" | "permanent"
  createdAtSeq: number       // CONTROL 提交序（§4.3），不是墙钟
}
```

**理由**：
- **依赖绑定的是 acceptedResultId，不是节点状态**。上游重跑产生新结果后，仅看「上游 SUCCEEDED」会消费旧结果；绑定 ID + digest 让「输入是否还是当初那份」可机械判定（硬问题 #1，§5 场景 F7）。
- **一个 attempt 跨 VM continuation 不变**：VM 交接只追加 ExecutionBinding，`retriesUsed` 不动。正常 handoff 不是业务失败（先验研究 §2.4）。
- BLOCKED_BY_DEPS / READY 不持久化：它们随 acceptedResults 集合变化而变化，落盘就要维护失效，纯函数每轮重算即可（任务规模 cap=3 下 O(V+E) 可忽略）。

### 2.3 ExecutionBinding

```text
ExecutionBinding {
  bindingId: string          // `${attemptId}/b${k}`
  assignmentId: string       // 下发给 box 的任务指派身份（随 assignment.json 注入，worker 回写进 result.json）
  launchId: string           // 执行它的 VM
  publishGeneration: number  // 该 VM 发布的代际（= 其 WORK 分支 swarm/<launchId>-g<gen>，dispatch-step.ts:61 [F]）
  continuationOf?: string    // 前一条 binding 的 bindingId（handoff 链）
  openedAtSeq: number        // 创建即登记（pending）——在指派/后继 IO 之前持久，不等接管成功（Codex P2-4）
  activatedAtSeq?: number    // startTask 确认 / takeover 确认时写入
  closing?: { cutoffTip: string | "empty" }
                             // 截止协议第一步。"empty" 仅当一次**成功**的 ls-remote 确认分支不存在
                             // （clean-fail / 从未发布的 binding——Codex v2-P2-1 反例 B）;查询网络错误
                             // 不得冒充空分支,保持未进入 closing。commit 值则扫完 ancestry 才 close
  closedAtSeq?: number       // closing 的完整扫描（empty 则直接）登记完成后写入
}

binding 三态的候选规则（Codex v2-P2-1——v2 的 V3 无条件引用 cutoffTip,正常 open binding 没有 cutoffTip,规则按字面不可求值）:
- **open**（无 closing）:该 binding 分支上被 O1 登记的结果一律是合法候选——健康 VM 不进 closing 也能验收完成。
- **closing**:cutoffTip ancestry 内的已登记候选保留验收资格;之外拒收 peer-late。
- **closed**:不再扫描;已登记未验收的候选照常走完验收。
```

**理由**：
- 这是业务层与生命周期层的**唯一**接缝。验收时核对「result 声称的 (launchId, generation) 是否属于该 attempt 的某条**未截止** binding」（§4.2 规则 V3），旧 VM 晚到的产物不能只凭 attemptId 相同被接受（brief 硬问题）。
- `closedAtSeq` 用 CONTROL 序而非时间：截止是一个决定，不是一个时刻观察（跨 worker 分支无全序，硬问题 #3）。
- **截止走 closing 协议（Codex P1-5）**：close 分两步。先持久 `closing.cutoffTip`（= 该分支当时的 confirmed tip）；然后 O1 把 cutoffTip 的 ancestry **完整**扫完（可跨多轮分页，游标与 ResultObserved 同批提交），全部登记后才写 closedAtSeq。保证收窄为：**cutoffTip ancestry 内的结果必被登记**；cutoffTip 之后才落地的 push 按 `peer-late` 拒收并审计——这是明确的截止规则，不宣称覆盖「物理上发布早于截止」的全部情况（跨系统无法原子观察发布与截止的先后）。扫描失败/未扫完则保持 closing，不前进。

### 2.4 TaskResult（worker 写，在 WORK 分支内）

路径：`out/results/<attemptId>/result.json`（allowlist `out` 之内，supervisor 原样纳入快照，swarm-supervisor.mjs:41,214-215 [F]）。

```text
TaskResult {
  schemaVersion: 1
  jobId, planRevision, nodeId, attemptId, assignmentId
  inputBindingDigest: string // worker 从 assignment 里抄回——验收时与 attempt 记录比对，防错拿输入
  outcome: "success" | "failure"
  failureReason?: string
  outputs: Array<{ logicalName, kind, path, baseSourceCommit? }>   // path 相对 work tree，必须在 artifactScope 内
  validationEvidence: Array<{ check: string; cmd?: string; exitCode?: number; summaryPath?: string }>
}
```

**理由**：
- result.json **不含**自身所在 commit SHA（自引用不可能）；observedWorkCommit 由 dispatcher 在观察时外层绑定（先验研究 §2.3）。
- `outcome=success` 只是 worker 自报，**不等于验收通过**（§4.2 两层）。`outcome=failure` 也是合法结果——它携带失败证据，驱动业务重试分类，比「什么都没发布」信息量大。
- 大小约束：result.json 本体 ≤ 64 KiB（validator 硬拒超限）；大产物放 outputs 引用的文件，不内联。

### 2.5 AcceptedResult（dispatcher 写，在 CONTROL 侧）

```text
AcceptedResult {
  acceptedResultId: string   // `${attemptId}/r1`——每个 attempt 至多一个 accepted（规则见 §4.2 V6）
  attemptId, nodeId, jobId, planRevision
  observedWorkCommit: string // 观察到该 result 的 pinned WORK commit
  resultPath: string
  resultBlobOid: string      // result.json 的 git blob OID
  resultClosureDigest: string // 内容闭包：result.json + 全部引用 outputs/evidence 文件的 sorted (path, blobOid) 的 SHA-256。
                             // 等价判定用闭包而非单个 blob——引用的 patch 变了而 result.json 字节没变 = 新候选（Codex P2-2）
  inputBindingDigest: string
  validatorVersion: string   // 验收逻辑版本——事件记录 reducer/validator 版本（先验研究 §2.5）
  decision: "accepted"
  decidedAtSeq: number       // CONTROL 提交序 = 跨任务验收的全序（硬问题 #3）
  superseded?: boolean       // 上游重跑裁决后置位（§4.2 V7）；置位本身也是一次 CONTROL 提交
}
```

被拒的结果不进 AcceptedResult，写 `RejectedResult`（同字段 + reason），保留审计且驱动重试分类。

### 2.6 幂等与冲突（硬问题 #4）

（v2 按 Codex P1-1 重写：v1 把实体键当事件键，连 RUNNING→RESULT_PENDING_VALIDATION 这种最普通的合法推进都会被判冲突冻结。）

**实体与操作分开**：
- **实体**（plan/attempt/binding/accepted…）有稳定 ID + 单调 `entityRevision`；状态推进 = 实体的新 revision，同一实体天然被多次更新。
- **操作**（一次具体转换：AttemptCreate、AttemptStatusChange、BindingOpen、BindingClose、ResultObserve、ResultAccept、Supersede…）有不可变 `operationId` + canonical payload digest，并携带 `expectedEntityRevision`。

判定规则：
- 同 operationId 同 digest = 重放 → no-op（崩溃恢复重发天然幂等）。
- 同 operationId 不同 digest = 冲突 → 拒绝 + 告警 + 冻结主体（FAILED(conflict)，需人工或 repair）。绝不「最新覆盖」。
- 新 operationId 但 expectedEntityRevision 过期 = 正常的并发/重算 → 调用方重读重算，**不是冲突**。

PlanPut 的操作身份包含 `(jobId, planRevision)`，不只 jobId。happycapy 黑板查重不比 payload hash（先验研究 §2.5），此处是修正后的规则。

**非语义修订:新候选不自动作废旧 accepted(增补 2026-10-03 dogfood S9;v2 按 S9+R3 审查 P1-1 收窄——spec 身份 ≠ 产物闭包身份,原「specDigest 不变 ⇒ 无级联」过强,会被误读为禁止显式 Supersede/accepted 换代)**:上游发布修订版产物(勘误、措辞澄清——消费者行为无需改变)时,它只是**新候选**:不自动作废仍有效的旧 accepted,下游已冻结的 acceptedResultId 引用不被偷偷替换,currentAccepted 不因此失效,无级联。要让修订版**取代**旧结果,走既有显式通道(Supersede 旧 accepted + 新候选验收),级联照常——spec 不变从不禁止显式作废(§3.1 本就允许)。实证(以当时实际流程为准):冻结契约的两段勘误走的是「正式批准的裁定 + 契约文字同步 + 复验探针按已批准裁定调整预期」,期间无任何 CONTROL 业务作废发生、T1 实现零返工——本条把该实践归纳为规范:此类修订若发生在业务系统内,其形态是「新候选、不自动作废旧 accepted」,取代才走显式 Supersede。灰区(修订是否需要取代)由发起 review 节点裁决,不默认级联。R4 覆盖映射的变更**必**改 D.specDigest,无本条例外。

---

## 3. 三条状态轴与交互规则

### 3.1 业务任务轴（新增）

```text
(派生) BLOCKED_BY_DEPS ──deps 全部有 current AcceptedResult──▶ (派生) READY
READY ──startTask 派发成功（attempt 创建+binding 打开）──▶ RUNNING
RUNNING ──当前未截止 binding 的 ResultObserved──▶ RESULT_PENDING_VALIDATION（已截止 binding 的候选只审计，不动 attempt，Codex P2-1）
RESULT_PENDING_VALIDATION ──验收通过──▶ SUCCEEDED
RESULT_PENDING_VALIDATION ──business-fail（outcome=failure / V7 / V8 拒）──▶ RETRY_WAIT（retriesUsed+1，retryAt 持久）
RESULT_PENDING_VALIDATION ──permanent（milestone 来源的 V1/scope-violation、冲突）或 **retryBudget** 耗尽──▶ FAILED（V2/V3 是候选级丢弃,不出现在这里——Codex v2-P3-1;「预算尽」勘误明确为 retryBudget,job 预算不写 attempt 终态）
RESULT_PENDING_VALIDATION ──stale（V4/V5 拒：输入/计划已变）──▶ ABANDONED（不耗重试；节点随新绑定重新就绪）
RESULT_PENDING_VALIDATION ──inconsistent-snapshot（rescue 不完整，§4.2）──▶ RUNNING（等一致快照；不耗重试）
RETRY_WAIT ──retryAt 到期──▶ (派生) READY（新 attempt **原样继承** retriesUsed + 旧 attempt 转 ABANDONED(retry-succession)，同一批提交——计数只在进 RETRY_WAIT 时加,接替不再加,Codex v2-P2-3）
RUNNING ──attempt 全部 binding 截止且无已观察结果──▶ RETRY_WAIT（transient-infra，不耗 retriesUsed;勘误 2026-10-03:原句尾「FAILED 仅当 job 预算尽」删除——job 预算尽由 jobStatus=failed 表达,不写 attempt 终态）
```

任一时刻一个 node 至多一个「活」attempt（RUNNING / RESULT_PENDING_VALIDATION / RETRY_WAIT）；重试接替的新建与旧 attempt 转 ABANDONED 同批提交，不出现两个活 attempt；FAILED 只在终败时写入（Codex P1-2 反例 B：v1 把被接替也写成 FAILED，a2 作废后回看 a1 会误判终败）。

**节点的完成与终败不看历史 attempt 状态，只看当前有效性。唯一的有效性函数（v3,Codex v2-P1-1——v2 只查本节点 spec,上游改 spec 后下游照样拿旧结果）：**

```text
currentAccepted(node, plan, acceptedResults) -> AcceptedResult | null   // 递归,DAG 无环所以有界
  r = node 的 accepted 中 !superseded、attempt.specDigest == plan 中该节点当前 specDigest、
      且创建时间最新的那一个（新旧两个未 superseded 并存时,current 规则 = 取 decidedAtSeq 最大者）
  若 r 为 null -> null
  对 r.attempt 的每个 inputBinding(dep, acceptedResultId):
      currentAccepted(dep, …) 必须非 null 且其 id == acceptedResultId   // 输入必须仍是依赖的 current
  任一不满足 -> null（r 存在但已失效——不必显式 supersede,判定自己递归失效）
```

- 完成 ⇔ `currentAccepted(node) != null`。上游 spec 一改,上游的 current 变 null,所有下游递归变 null——PlanPut 无需原子级联置位,有效性函数自动传播（显式 Supersede 仍保留,用于 spec 没变但结果被裁决作废的场合）。
- readyTasks 第 4 步、V4、job 成功全部用同一个 currentAccepted,不得各查各的 superseded 位。
- 终败 ⇔ 存在 FAILED attempt：specDigest == 当前 spec **且** inputBindingDigest == 此刻按 currentAccepted 解析出的绑定 digest（勘误 2026-10-03:原文此处还有「或 job 预算尽」,随 §2.2 状态注释的同次勘误删除——job 预算尽由 jobStatus=failed 表达,不构成单节点终败）。spec 或输入变了，旧 FAILED 不挡新执行。
- 历史 SUCCEEDED / FAILED / ABANDONED 一律只作审计。

持久化的只有 attempt 的 status（§2.2）；BLOCKED/READY 每轮由 `readyTasks()` 重算。

### 3.2 与 VM 交接轴（现有，不改）的交互

VM 轴：RUNNING → DRAINING → CHECKPOINTED → CLAIMED → ALLOCATING → RESUMED → RETIRED，分支 DONE/EXPIRED（control.ts:21-26 [F]）。

交互规则（每条都是不变量，可测）：

- **X1：owner generation ≠ task attempt。** reclaim 提升 owner generation（control.ts:191 [F]）不触碰任何 TaskAttempt 字段。已有测试钉住「owner g2 不拒 successorGen g1 的发布」（swarm-dispatch-step.test.ts:183 [F]），任务层沿用同一事实。
- **X2：handoff 时 binding 的开合（v3 按 Codex v2-P2-2 重排时序）。** successor 的 pending binding **不在** awaitResume 之后 append——那太晚了:dispatch-step 在一次调用里连做 pin successor→allocate→resume（dispatch-step.ts:182-220 [F]）,后置的 task pass 插不进去。落地方式:**allocation/resume 的 adapter**（swarm-dispatch.ts:158,169 的实现层）在执行 IO 前先调任务层的准备协议——持久 pending binding（launchId/successorGen 此时已被 allocating 事件 pin 好 [F]）+ successor assignment（§4.5-6b）,然后才跑 swarm-launch/swarm-task。生命周期纯决策零改动,改的是 IO 适配层;这与 CAS-then-IO 是同一纪律的任务层延伸。awaitResume 确认后的批只做两件事:**激活**已存在的 pending binding + 旧 binding 进入 closing（钉 cutoffTip）。随后 O1 把 cutoffTip ancestry 完整扫完（可跨多轮分页）才写 closedAtSeq（§2.3;Codex P1-5）。attempt 的 status 不变。判死路径同样走 closing。崩溃在任一步之间 ⇒ 恢复推导补发（§4.3 步骤 A,幂等）。
- **X3：VM EXPIRED ≠ 任务失败。** EXPIRED 是 VM 终态非任务终态（control.ts:124-126 [F]）。任务层看的是「该 attempt 是否还有未截止 binding」：生命周期层还在 reconcile/allocate 后继时，binding 链未断，任务保持 RUNNING。只有生命周期层 give_up（alloc 链耗尽，control.ts:151 [F] cap=3）或全部 binding 截止且无结果时，任务层才判 transient-infra。
- **X4：任务 SUCCEEDED ≠ VM 释放。** 验收通过后 VM 照常活到 deadline；物理容量始终由 physicallyOccupies 管（control.ts:344 [F]）。反之 VM DONE/RETIRED 也不自动推进任务——只有验收推进任务（先验研究 §3.3）。
- **X5：任务层不碰 effectiveLive。** 容量 = 物理 VM 数（dispatch-step.ts:88 [F]），任务并发由独立的「逻辑执行槽」管（§4.5：一个 box 同时只跑一个 assignment）。Codex 01ea35b 残留的 P1-1/P1-2/P2-2（预留漏算/物理 TTL 混用/phantom reservation）是生命周期层的既知缺口，任务层不修、不绕、也不得把业务状态当物理证据去「帮忙」释放槽位——那会重蹈 P1-2。诚实边界（v3 再修正,Codex v2-P3-1）:**业务结果判定**（验收/有效性/幂等）可独立成立并单测;占用失真时任务派发会被错误放行（**同时违反 cap 这个资源约束,不只是吞吐问题**）或饿死——资源上限与活性依赖生命周期占用事实正确,见附录。

- **X6：执行端 fence 的诚实落地（brief 硬问题；v2 按 Codex P2-7/P3-1 收窄）。** box 端**没有**硬 fencing（基底限制,control.ts:8-13 [F]——旧实例恢复后照样能跑）。实际落地的是「隔离输出 + 拒收」,每条按真实强度标注：(a) 每个 box 按约定只向自己的 `swarm/<launchId>-g<gen>` 分支发布——这是**受信 supervisor 的行为约定,不是服务端 ACL**：worker 与 supervisor 共用同一把 repo 级写 deploy key（swarm-task.sh:117,121 [F]）,不守约的 worker 技术上能向别的分支 push。(b) 验收的绑定核对（V2/V3）+ 闭包身份（V6）捕捉的是**错投与迟到,不是主动冒写**——身份字段可以被持有同 repo 写 key 的旧 box 抄袭,内容 hash 只证明内容不同,不证明发布者（Codex v2-P2-6）。**威胁模型据此明确限定**:WORK 内容完整性假设所有持写 key 的 box 都跑受信 supervisor;抵御主动跨分支冒写需要服务端分支授权或产物签名,是显式非目标（如需,列入未来工作,不在 v1 宣称）;(c) 命令通道 per-launch room key——room.ts:43 是已有**模块能力 [F]**,当前 Phase-2 dispatcher/task 脚本未接,业务接线是 [D]（Codex P3-1）;(d) 僵尸成本由 CPA token TTL 封顶——mint 只把请求 TTL 夹在 1..3600（mint.ts:42 [F]）,**按剩余寿命收紧是调用方职责 [D]**,当前 launcher 传固定 3600（swarm-launch.sh:108 [F]）。这是 §1.3 非目标 1 的正面版本,不是新能力宣称。

### 3.3 与快照发布轴（现有，不改）的交互

发布轴：milestone / rescue / final + confirmed SHA（manifest.ts:19 [F]；supervisor 单发布者，swarm-supervisor.mjs:148 [F]）。

- **X7：业务结果骑在 milestone 上，绝不用 final。** final 会冻结 publish 生命周期（swarm-supervisor.mjs:193-194,294 [F]：finalized 后拒绝一切后续发布）。一个 box 完成任务 A 后可能还要接任务 B 或等 handoff，用 final 表示「子任务做完」会把箱子焊死。worker 的「任务完成」动作 = 写 result.json + 请求一次 **milestone** checkpoint（req/ack 契约照旧，swarm-supervisor.mjs:67-68 [F]）。
- **X8：rescue 可以携带 result.json，但验收不因 kind 放宽。** rescue 是近死快照、可能跨文件不一致（manifest.ts:14-16 [F]）。验收规则（§4.2）只看 result.json 内容 + 绑定核对 + 项目验证，通过就接受——「kind=rescue」本身不是拒绝理由，也不是通过理由。
- **X9：两套观察,各自负责。** 生命周期 acceptance（tipToEvent,acceptance.ts:32 [F]）只服务**恢复锚点**（sha/checkpoint 推进）,原样不动。业务结果的观察（O1,§4.2）由任务层**自己**对每条未 closed binding（含 pending/closing——创建即登记,Codex P2-4）的分支做 ls-remote + pinned fetch（复用 observeTip 同款 scratch 设施,swarm-dispatch.ts:74 [F];但任务层接口必须区分 branch-not-found 与 query-error——现有 observeTip 两者都返回 null [F],闭空分支判定不能建在这个混同上,Codex v2-P2-1）——不搭生命周期 observe 的时机便车,所以 claim 之后生命周期停扫原分支（Codex 延期项 a3-P2-6）不影响结果可见性。O1 继承同一条 no-rollback 纪律：lastScannedSha 必须是新 tip 的祖先,否则该分支被改写,拒扫 + 告警。

---

## 4. 协议

### 4.1 纯 ready-set：`readyTasks(plan, attempts, acceptedResults, now)` [D]

```text
readyTasks(plan, attempts, acceptedResults, now) -> Array<{ node, proposedBindings, digest }>
  按 plan.nodes 的稳定顺序（tie-break；不排序时间戳）遍历每个 node：
    1. 节点已完成（存在 !superseded 且 specDigest 匹配当前 spec 的 AcceptedResult，§3.1） -> 跳过
    2. 有活 attempt（RUNNING / RESULT_PENDING_VALIDATION；或 RETRY_WAIT 且 now < retryAt） -> 跳过
       （RETRY_WAIT 未到期不放行——修正 happycapy 的 retrying 门控缺陷，先验研究 §3.4）
    3. 节点终败（§3.1 定义：同 spec 同输入的 FAILED），或 job 预算（attempts/墙钟）已尽
                                                          -> 跳过（join 节点因此永不 ready，job 不完成）
    4. 对每个 dep ∈ node.dependsOn：
         currentAccepted(dep)（§3.1 的递归有效性函数,不是裸查 !superseded——Codex v2-P1-1）
         任一为 null                                       -> 跳过（BLOCKED_BY_DEPS）
    5. 产出 proposedBindings = 这些 acceptedResult 的 {depNodeId, acceptedResultId, workCommit, resultPath}
       + digest。bindings 在**派发被 CONTROL 提交时**冻结进新 attempt——不在规划期假造尚未存在的 result SHA。
```

纯函数、无 IO、全量重算（规模小，不做增量缓存——非目标）。装载 plan 时校验：重复 nodeId、缺依赖、自环、环 → 整个 plan 拒绝（不静默删边——先验研究 §2.1 明确不移植 happycapy loader 的静默修复）。

### 4.2 结果验收：观察协议 + 两层验证 [D]

**观察协议（解决「晚到结果 + supervisor 空 index 重建导致旧文件消失」，硬问题 #2）：**

supervisor 每次从空 private index 构建快照（swarm-supervisor.mjs:201-204 [F]），所以 `out/results/x/result.json` 可以在后续快照的**树**里消失；但它所在的历史 **commit** 永远可达——发布是 non-force FF-only，每个新 commit 以旧 tip 为 parent（swarm-supervisor.mjs:148-258 [F]），祖先链不断。两条互补规则：

- **O1（dispatcher 侧，权威）：按 ancestry 扫描增量，不只看 tip 的树。** 任务层为每条扫描分支维护 `cursor` 游标（CONTROL 内）:`null`(before-root 哨兵) 或 commit SHA。**首次 = null,不是根 SHA**——git 双点区间不含左端点,「cursor=根再扫 根..tip」会永远漏掉根提交,而短任务的唯一结果可能就在无父根提交里（Codex v2-P1-3,实测 `R..R` 为空集）。cursor=null 时扫 `rev-list --first-parent --reverse T`(全链含根);cursor=C 时扫 `C..T`。观察到新 confirmed tip T 时，沿 first-parent 链**从旧到新**枚举（单发布者 + FF-only ⇒ 该链是全序 [F]），对每个 commit 列 `out/results/**` 相对其 parent 的新增/变更 blob，连同**引用闭包**（result.json 引用的 outputs/evidence 文件的 (path,blobOid)）一起登记 ResultObserved——闭包变化（引用文件变了而 result.json 没变）也产生新候选（Codex P2-2）。每轮上限 N 个 commit（建议 64），超出分多轮；**游标推进与该段 ResultObserved 同批提交**（根提交完整处理并同批持久后 cursor 才从 null 变为根 SHA），绝不越过未完整处理的 commit（Codex P1-5/v2-P1-3）。这样短暂出现、后被快照清掉的结果也会被看到。
- **O2（worker 侧，保险带）：结果保留契约。** assignment 告知 worker：result.json 及其引用的 outputs 在收到 dispatcher 的接受指令（经 task room 下发,room.ts send [F]）或 binding 截止前**不得删除**。这不是正确性依赖（O1 已覆盖），是让「最新 tip 的树里就有结果」成为常态、降低扫描深度的工程优化。
- **O3：已验收结果的持久可达（v2 按 Codex P2-3 重写）。** fetch 本身不钉对象——没有命名 ref 的对象会被 `git gc` 清掉（Codex 实测反例）。两个动作：(i) 本地 results scratch 为每个 accepted result 打命名 ref `refs/swarm-results/<acceptedResultId>`；(ii) **远端留存**：dispatcher 用 WORK 写凭据向 WORK repo push 轻量留存 ref `refs/swarm/keep/<acceptedResultId>`（指向 observedWorkCommit）——下游 worker 只从 origin fetch（§4.5-2），T3 整机恢复也只剩远端，两者都必须在远端可达；留存 ref 存在期间相关分支即使删除对象仍可达。**顺序**:远端留存 ref push 确认成功,才提交 CONTROL 的 ResultAccept;ACK 未知则重试留存(幂等),未远端固定的对象不得宣称可灾后恢复(Codex v2 对原 P2-3 的补充)。ref 命名空间(refs/swarm/keep/*)能否被目标 Git 服务接受在 T3 验证。accepted 未被 supersede 前不删留存 ref。注意：这与 Codex 延期项 a3-P2-6 相邻但不同——O1 挂在任务层自己的扫描位置上，不借用生命周期层的 observe 时机。

**两层验证：**

第一层（worker 自报）：result.json 的 outcome + validationEvidence（跑过什么命令、退出码、摘要文件）。只作证据，不作结论。

第二层（dispatcher/validator，机械执行，任一失败即拒）：

| # | 规则 | 拒绝时的记录 |
|---|------|-------------|
| V1 | schema：result.json 可解析、schemaVersion=1、≤64 KiB、**声明的** outputs 路径在 artifactScope 内。分类看来源（Codex v2-P2-4）:候选来自 **rescue** 且解析失败/引用缺文件 ⇒ 按 inconsistent-snapshot 处理（候选级,不耗重试,等冻结 milestone——rescue 逐文件暂存可抓到半写 JSON,worker 没有违反协议）;来自 **milestone**（worker 冻结后确认的快照）才是结构坏 ⇒ permanent。worker 契约同时要求 result.json 原子写（temp+rename,demo worker 已示范该模式 [F]） | reject(schema) 或 candidate(inconsistent) |
| V2 | 身份：jobId/nodeId/attemptId/assignmentId 与 CONTROL 里的 attempt 记录一致 | reject(identity) |
| V3 | 绑定：observedWorkCommit 所在分支的 (launchId, generation) 属于该 attempt 的某条 binding，且按该 binding 的状态合法（§2.3 三态规则:open 一律合法;closing 看 cutoffTip ancestry;closed 只认已登记候选——Codex v2-P2-1）。**候选级拒绝**：stale-binding 只丢弃这份候选并审计 peer-late，绝不改 attempt 状态（Codex P2-1） | discard(peer-late) |
| V4 | 输入：result.inputBindingDigest == attempt.inputBindingDigest，且每个被引用的 acceptedResultId 仍 == `currentAccepted(dep)`（§3.1 递归有效性,不是裸查 !superseded——Codex v2-P1-1） | reject(stale-input) |
| V5 | 计划：当前 revision 中仍存在同 nodeId 的节点,且其 specDigest == attempt.specDigest（§2.2 存储；revision 号只作审计——否则 repair 引入的新 revision 会无谓作废所有不相关节点的 RUNNING attempt） | reject(stale-plan) |
| V6 | 唯一：该 attempt 尚无 AcceptedResult。等价比 **resultClosureDigest**（内容闭包,§2.5——同 result.json 字节但引用的 patch 不同 = 不同候选,Codex P2-2）:闭包同 = 重放 no-op;闭包不同 = 记 candidate,不替换(「接受首个通过验证的结果」,先验研究 建议五) | candidate(duplicate) |
| V7 | 契约：outputContract.requiredOutputs 全部存在于 observedWorkCommit 的树内；kind=patch 的输出能 `git apply --check` 到 baseSourceCommit | reject(contract) |
| V8 | 项目验证：acceptance 清单逐条执行（见下）；outcome=failure 的 result 跳过 V7/V8,直接进失败分类 | reject(validation) |

V8 的执行者：**默认由 dispatcher 本机在隔离目录执行**（checkout baseSourceCommit + apply patch + 跑声明的检查命令，有超时与资源上限）；计算重的验收声明为独立的 review 节点（kind=review,普通 DAG 节点,在 box 上跑）。两者用同一 acceptance 清单格式。

**scope 的真实强度（Codex P2-8/v2-P2-5）**：artifactScope 是「允许发布的成果范围」,不是执行端文件系统权限（box 上没有 per-task 隔离——非目标）。检查是**累计的,不是单 commit 的**:O1 逐 commit 登记相对 parent 的新增/变更/**删除**,validator 对候选核对「该 binding 自起始快照以来的累计变更集」——v2 只看 result 所在 commit 相对 first-parent 的 diff,越界文件在前一个 commit 里发布就漏检（Codex v2-P2-5 反例 A）。累计集中出现 artifactScope 外且不属于 `.swarm/manifest.json`、`out/results/<attemptId>/` 的路径 ⇒ reject(scope-violation)。patch 的**应用目标**由 V8 在隔离目录应用后用 diff 文件集对 **sourceWriteScope** 核对（两个坐标系,v2-P2-5 反例 B）。box 上写到 allowlist 外的文件（如 /tmp）本来就不进快照,无法也无需由结果验证证明不存在。

**失败分类（驱动重试,先验研究 §2.4 的最小移植）：**

先分**层**再分类（Codex P2-1）：V2 身份不符 / V3 迟到候选是**候选级**问题——丢弃该候选并审计,attempt 状态不动。只有当前有效 binding 产出的候选的失败才进入 attempt 级分类:

| failureClass | 触发 | 代价 |
|---|---|---|
| transient-infra | attempt 全部 binding closed 且 cutoffTip 内无可验收结果（VM 链死透）；alloc give_up | **不耗** retriesUsed（VM 侧已由 MAX_ALLOC_ATTEMPTS=3 约束,control.ts:151 [F]）；retryAt = now + 60 + jitter；新 attempt 计入 job maxTotalAttempts |
| business-fail | outcome=failure；V7/V8 对**一致快照**的拒绝 | retriesUsed+1;超 node.retryBudget 则 FAILED,否则 RETRY_WAIT,retryAt = now + min(60·2^retriesUsed, 1800) + jitter（采样一次持久,重放不重掷） |
| inconsistent-snapshot | V7/V8 拒,且候选来自 rescue 且闭包不完整/自相矛盾（Codex P2-2:rescue 逐文件暂存可得「新 result.json + 旧 patch」的混合版） | **不耗** retriesUsed;attempt 回 RUNNING 等一致快照（worker 冻结后的 milestone）;binding 全部截止仍无一致结果才转 transient-infra |
| stale | V4/V5 拒绝（输入/计划已变——不是任务的错） | attempt 转 ABANDONED,**不耗** retriesUsed;节点随新绑定重新就绪,新 attempt 计入 job maxTotalAttempts |
| permanent | **milestone 来源的** V1/scope-violation 拒绝（结构坏——重跑同样坏;rescue 来源按 inconsistent-snapshot 行,与 F11 一致——勘误 2026-10-03,T1 实现复审发现本行原文漏来源限定与 §4.2 分层/F11 矛盾,裁定记录于 brain-T1-pure-review-2026-10-03.md）；冲突（§2.6）；**retryBudget** 耗尽（勘误:job 预算不在此列,由 jobStatus 表达） | 直接 FAILED |

三种预算彻底分开：allocation cap（每 ControlRecord 链 3 次 [F]）／node retryBudget（业务重试）／job 预算（总 attempt 数 + 墙钟 + 可选模型费）。successor 新记录不继承父记录 attemptCount（dispatch-step.ts:192 [F]）,所以 allocation cap 从来不是全局预算——全局停止条件只能由 job 预算承担。

**上游重跑的下游失效（硬问题 #1 完整回答）：**

上游节点 N 的 current 失效有两条路：**显式 Supersede**（repair/review 产出或人工裁决——CONTROL 提交）,或 **PlanPut 改了 N 的 spec**（currentAccepted 的 specDigest 匹配自动失效,无需级联置位——Codex v2-P1-1）。两条路之后的传播相同:下游的 currentAccepted 递归变 null → readyTasks 重新放行 → 新 attempt → 新 accepted。显式 supersede 时附带的处置：
1. supersede 与后续处置在**同一批** CONTROL 提交里：枚举所有 inputBindings 引用被 supersede 结果的 attempt。
2. 其中未启动派发的（无 binding）→ attempt 转 ABANDONED(stale-input),不耗重试。
3. RUNNING 的 → 不杀（杀不掉）,留给 V4 在验收时拒绝;拒绝即 ABANDONED(stale),节点随新绑定重新就绪,新 attempt 自然绑定新结果。
4. 已 SUCCEEDED 的下游 → 其 accepted 也级联 supersede（递归,同批提交）。下游节点的完成判定同样自动失效——无需动那些 SUCCEEDED attempt 的状态,它们只是审计。级联是有限的（DAG 无环）。

### 4.3 CONTROL 持久接口升级：`commitControl` [D]

**接口（现在定形,分两步实现）：**

```text
commitControl(expectedSeq: number, changes: Change[]) -> { ok: true, newSeq } | { ok: false, conflict: { currentSeq } }

Change =
  | { put: "plan",    plan: TaskPlan }
  | { put: "attempt", attempt: TaskAttempt }            // 含 status/binding 变更（整记录新版本）
  | { put: "observed", observed: ResultObserved }
  | { put: "accepted", accepted: AcceptedResult }       // 或 rejected / supersede
  | { put: "intent",  intent: DispatchIntent }          // 派发意图,见下
  | { put: "lifecycle", record: ControlRecord }          // 现有生命周期记录也走同一提交流
  | { put: "scan",    branch: string, cursor: string | null }      // null = before-root 哨兵（§4.2 O1）
  | { put: "tombstone", launchId: string }                // 删除即 tombstone（Codex 审查:v1 没定义 delete）。投影删文件,
                                                          // 权威留 tombstone;discovery(keydir)重建遇 tombstone 跳过——
                                                          // 既知 P2-3(删除后被 keydir 重建)在步骤 A 的消解路径,但这
                                                          // 要求 pass 的 discovery 查 tombstone,是明确的接线义务,不自动发生
```

每个 Change 隐含操作身份（operationId + expectedEntityRevision,§2.6 v2）。

- **成组原子**：一批 changes 要么全可见要么全不可见。关键组合：「接受 Q 的结果 + 更新 Q attempt=SUCCEEDED + 不启动 I」是一批；「close 旧 binding + append 新 binding」是一批（X2）；「supersede + 级联处置」是一批（§4.2）。
- **expectedSeq 冲突语义**：返回 conflict + currentSeq,调用方重读重算。单活 dispatcher 下冲突只来自自身崩溃恢复的重放——同 operationId 同 digest 的重放是 no-op（§2.6 v2）,所以恢复天然幂等。
- **顺序纪律**（先验研究 建议三）：先提交 DispatchIntent,再做 startTask IO;先提交 accepted,再对外宣布/解锁下游。与现有 CAS-then-IO 纪律（dispatch-step.ts:14-17 [F]）同构。
- **decidedAtSeq = 跨任务全序**（硬问题 #3）：不同 worker 分支各自只有 ancestry 偏序,接受顺序由 CONTROL 提交序唯一确定;同一批内多个 accepted 按 plan 稳定顺序编号。

**DispatchIntent**：

```text
DispatchIntent {
  intentId: string           // = assignmentId
  attemptId, nodeId, launchId（目标 box）, bindingId
  assignmentDigest: string   // assignment.json 的 digest——同 intent 的重发必须逐字节同一份（见 F3:重发≠改派）
  allocRequestStartSec: number   // 分配请求起点,IO 前持久（Codex P1-4:对齐 dispatch-step 的 attemptStartSec 纪律 [F]）
  workDeadlineSec: number        // 工作截止 = start + SWARM_BUDGET_SEC:只驱动 drain/checkpoint,**绝不**用于判实体死亡
  physicalExpiresAtSec?: number  // 物理寿命上界——**可缺失,且必须带证据来源**(Codex v3 终稿:两轮都证明没有本地可
                                 // 证明的上界)。只有两种来源可填:provider 给出的可靠 expiry/termination 证据,或
                                 // 有服务端保证的创建完成上界 + PROVIDER_LIFETIME_SEC(3600) + skew。本地 runScript
                                 // 的 300s SIGKILL(swarm-dispatch.ts:144,150 @01ea35b [F])只是**操作超时**:杀的是
                                 // 本地 bash,不撤销 provider 已接受的请求(t299 受理、t500 创建、活到 t4100),不可
                                 // 作为创建截止。本字段缺失 ⇒ UNKNOWN 分配**无限期保守计占用**,直到可信结果、WORK
                                 // 首快照、或人工确认。可选的启发式回收(如 start+4020 经验值)必须另列为显式策略,
                                 // 声明「可能超 cap」,绝不冒充可靠物理死亡
  physicalEvidence?: "provider-expiry" | "creation-bound" | null   // 上述字段的证据来源,与值同批持久
  allocOutcome: "pending" | "created" | "clean-fail" | "unknown"   // 无本地证据只能停在 unknown,不得判 clean-fail
  status: "pending" | "confirmed" | "abandoned"
}
```

startTask 的分配走与 handoff 相同的 CAS-then-IO 纪律:先 commitControl 这条 intent（含请求起点与物理期限）,再调 swarm-launch;分配结果未知时 allocOutcome=unknown 持久保留,恢复期**保守计物理占用**直到可信结果、WORK 首快照出现、或**带证据来源的** physicalExpiresAtSec 过期（证据缺失就无限期保留——本地超时不是证据;物理上界与工作预算无关,缩短 SWARM_BUDGET_SEC 只提前 drain,Codex v2-P1-2/v3）。keydir 在 /tmp（swarm-launch.sh:99 [F]）,机器/tmp 丢失后它不存在≠分配没发生——**keydir 只是本机便利证据,不是分配事实的权威**（Codex P1-4）。

**实现分两步：**

- **步骤 A（随 Phase T2）：本机实现。** MIRROR_DIR 旁新增 `~/.agenthop/swarm/control-log/`：append-only 的批提交 JSON 文件（`<seq>.json`,原子 rename,内容含 prevSeq 链接）；现有 per-record mirror（swarm-dispatch.ts:112 [F]）降级为**投影**（由 log 重放生成,只服务 swarm-viz 与快速启动）。saveRecord/persist 的调用点改为经 commitControl——步骤 A 里 `ops.persist` 可保持同步签名（本机 fsync 即屏障）:每次 persist = 一个单变更提交,落盘先于后续 IO（CAS-then-IO 不变,dispatch-step.ts:184-187 [F]）。**步骤 B 会把这个签名升级为可等待**（见下——这是 v2 对审查 P1-3 的让步:屏障语义优先于「控制流原样」）。成组原子只用于任务层自己的批（验收+状态+级联等）。两层间的一致性靠恢复推导：重放日志时,发现 RESUMED 的生命周期记录而对应 binding 开合缺失 ⇒ 补发 binding 批（同键同 digest,幂等）。这一步**不解决跨机**,但把全部业务+生命周期变更收口到一条有序日志,崩溃恢复从「读一堆独立 JSON 的最新状态」变成「重放日志」。Codex 01ea35b P2-4（removeRecord 吞 unlink 错误）在这一步顺带消失：删除也是一条日志记录,投影文件删不掉只影响投影,不影响权威。
- **步骤 B（Phase T3,可与 T2 并行开发）：GitHub CONTROL 仓接线。** 独立 repo（open question Q1 收窄:同仓 control 分支方案因 repo 级 deploy key 无法区分分支写权而基本出局,Codex P2-7）,每批 = 一个 commit;expectedSeq 映射为 expected ref OID,写入用 `git push --force-with-lease=control:<expectedOid>`——服务端原子比较,不是「同 OID push」假锁（control.ts:18-19 头注已承认 [F]）。

  **屏障语义（Codex P1-3,v1 的致命洞）**：v1 说「异步完成、后续批排队、控制流原样」——但 persist-before-IO 的全部意义就是「持久**先于**副作用」,CONTROL push 还在路上就跑 allocator,远端没有这条分配,整机丢失后 T3 恢复就找不回它。步骤 B 必须把屏障调用点改成**可等待**:`ops.persist` 升级为 async（或等价的 flush 屏障）,所有 persist-then-IO 的调用点（dispatch-step.ts:186,205 的 ALLOCATING/placeholder、:276-283 的 child anchor、RESUMED、tombstone）都 await 远端 CAS 成功后才执行后续 IO。这是对 dispatch-step 调用点的**明确签名升级**,不是透明替换——「控制流原样」的说法作废。每轮 pass 的延迟增加一次 push RTT,单活下可接受。

  **force-with-lease 的保证边界（Codex 实测）**：lease 失败只对「不同目标」可靠;stale lease + 相同目标 OID 会返回 0（Everything up-to-date）。所以「push 成功」≠「这次是我写进去的」。恢复期判定改为:push 返回后**读回 ref 并核对内容**,批内容已在链上（无论谁写的,同 operationId 同 digest ⇒ 等价,幂等语义本来就不区分写者）则前进;内容不同才是真冲突 ⇒ 停机告警。F17 据此修正。

  **权限分离**：CONTROL 仓写凭据只在 dispatcher 机器。box 的 work deploy key 对 CONTROL 仓无任何权限（独立仓即天然边界）;注意这只隔离 CONTROL,WORK 仓内部 worker 仍可技术上冒写别的分支（X6 已收窄,结果可信性靠验收不靠分支 ACL）。

  **只有这步完成并通过「丢弃整机 mirror 后从 CONTROL 全量恢复」的验收,才允许宣称跨机可恢复**（非目标 5 的解除条件）。

**崩溃时点矩阵见 §5（F1-F4）。**

### 4.4 聚合/综合 [D]

integration / synthesis / review / repair 都是**普通 DAG 节点**,没有特殊执行器：

- 输入 = 固定的 accepted result refs（和任何节点一样经 inputBindings）。
- **代码成果**：上游 work 节点交付 `patch.diff`（相对 plan 固定的 baseSourceCommit）或命名文件,integration 节点按 plan 稳定顺序 `git apply` 到 baseSourceCommit 的干净 checkout、跑集成验证（acceptance 清单）、把合成树/测试报告作为自己的 result 交付。**WORK 快照是 curated artifact snapshot（默认只有 out/ + manifest,swarm-task.sh:47 允许列表 [F]）,不是可合并源码分支**——禁止 cherry-pick/merge 快照 commit（先验研究 §2.6）。两个 patch 无文本冲突 ≠ 语义兼容：集成验证失败 → integration 节点 business-fail → 生成 repair 节点（新 plan revision,repair 的 dependsOn 指向冲突双方）,不静默覆盖、不回退 WORK 历史。
- **研究成果**：synthesis 节点按题纲综合已接受来源,输出报告 + 来源清单 + 未解决冲突列表。
- job 成功 = 必需节点（plan 里标注,默认全部）+ 终端聚合节点全部满足 `currentAccepted != null`（§3.1 同一函数,不是查 attempt SUCCEEDED）。它与任何 launch 的 DONE/RETIRED 是两个事实（X4）。

### 4.5 真实 worker 接线（swarm-task.sh `--task`）[D]

现状 [F]：swarm-task.sh 只接受 --demo/--resume（:25,:26,:32）,resume 也跑 bash demo worker（:192-204）;Claude --task 未接。补法沿用全部既有安全模式（本地构建 scp、sup-env 0600、tmux 持久、READY 门槛）：

1. **assignment 下发**：dispatcher 先 commitControl(DispatchIntent),再生成 `assignment.json`（assignmentId、jobId/nodeId/attemptId、goal、inputBindings（含每个输入的 workCommit+resultPath）、outputContract、artifactScope/sourceWriteScope、inputBindingDigest、binding 的 (launchId,generation)、结果保留契约 O2、软期限 = 剩余寿命 - checkpoint 预算 - handoff 余量）。与 sup-env 同模式 scp 到 `/root/.swarm/assignment.json`（0600,不走 argv/heredoc——Codex #6 的教训已固化在 swarm-task.sh:95-101 [F]）。
2. **输入物化**：box 端用既有 deploy key `git fetch origin <各输入 workCommit>`,把每个输入的 resultPath + outputs 展开到 `/root/inputs/<depNodeId>/`（只读约定）。输入是固定 SHA,与分支现状无关。
3. **CPA 短时 token**：dispatcher 用 mint.ts 的 `mintEphToken({ sub: launchId, ttlSec: 剩余寿命 }) `（mint.ts [F],TTL 封顶 3600、按 dispatcher 时钟）,写进 worker-env 文件 scp 过去（0600、sourced,token 不进 argv——Phase-1 的 argv 泄漏教训,swarm-task.sh:12-14 头注 [F]）。`ANTHROPIC_BASE_URL` 指向 CPA。token 过期 ≠ 执行停止（box 还活着但模型调不动）——派发前检查 `token 剩余 ≥ estimatedRuntimeSec + 余量`,不满足就不派发（先验研究 建议四）。
4. **worker 进程**：tmux session `swarm` 里跑 headless Claude（`claude -p "$(assignment 渲染的提示)" --output-format stream-json` 或当期等价物——具体 CLI 形态是 open question Q6）。提示模板里固化契约：读 assignment → 在 writeScope 内工作 → 写 `out/results/<attemptId>/result.json` → 写 checkpoint.req(kind=milestone) → 等 confirmed ack（req/ack 文件协议照旧,demo worker 的 await_ack 即参考实现 [F]）→ 之后不再改动结果文件（O2）。
5. **持续进度**：长任务中途也按阶段请求 milestone（demo worker 已示范 [F]）;supervisor 的 T-5/T-2 rescue、近死逻辑零改动。
6. **新任务入口 `startTask`**：走 `swarm-launch.sh`（AGENTHOP_ALLOCATE_ONLY=1 + AGENTHOP_LAUNCH_ID,swarm-launch.sh:52,96 [F]）+ `swarm-task.sh <lid> --task`。**不得复用 allocateSuccessor 假装新任务有前驱**——allocate 要求 handoffSha（dispatch-step.ts:176-179 [F],undefined 直接 skip）,新任务没有。分配前先 commitControl 耐久 intent（含请求起点/物理期限,§4.3——Codex P1-4）;生命周期记录照常以 RUNNING gen0 进入 records。
6b. **业务 resume（Codex P2-5:v1 写「--resume 原样」却要求真实任务续跑,矛盾）**:swarm-task.sh 的 --resume 当前跑的是 bash demo worker（swarm-task.sh:192-204 [F]）,生命周期接管会成功而业务不会继续。T1 必须给 --resume 增加业务模式:dispatcher 在 resumeSuccessor 前为 successor binding 生成**新的** assignment.json（同 attemptId,新 bindingId/assignmentId,输入物化引用同一批 accepted 输入 + handoffSha 处的既有进展）,随 resume 下发;--resume 检测到 assignment 存在时启动真实 Claude worker 而非 demo。生成者 = **resume adapter 的 pre-IO 准备步骤**（X2 v3——不是后置的 task pass:主循环 handoff pass 在先,等 task pass 轮到时 resume 已经跑完了,Codex v2-P2-2）;adapter 从 CONTROL 读 attempt/binding 上下文。demo 路径保留用于管线验证。
7. **逻辑执行槽**：v1 固定「一 box 一 assignment」。box 空闲复用（任务 A 完成后接任务 B）**不做**进 v1——它需要 box 端 assignment 切换协议与剩余寿命评估,收益在 cap=3 下有限（open question Q5）。

**task pass 的位置**：swarm-dispatch 主循环（swarm-dispatch.ts:197 pass [F]）旁新增 `taskPass(plan, attempts, records, ops)`：每轮先跑现有 handoff pass（生命周期推进、binding 开合随 X2/X3 的事件产生）,再跑 task pass（O1 扫描 → 验收 → readyTasks → 派发）。两个 pass 共享 records 只读视图,写全部经 commitControl。保留 handoff pass 原样。

---

## 5. 失败模式矩阵

每条：场景 → 设计如何处理（引用上文规则）。崩溃恢复统一前提：恢复 = 重放 CONTROL 日志 → 重建投影 → 对 pending intent 逐个 reconcile。

| # | 场景 | 处理 |
|---|------|------|
| F1 | **派发：intent 提交后、startTask IO 前崩溃** | intent 的 allocOutcome 仍是 pending/unknown 时,**不得**因 keydir 缺失判「没发生」——/tmp 丢了照样可能已分配。处置:保守计占用,观察该 launchId 的 WORK 分支;仅当 physicalExpiresAtSec **有证据来源**且过期才 abandoned + 节点回 READY（不耗重试）,否则保留 UNKNOWN 计占用待人工/证据（Codex v3）。只有 allocOutcome=clean-fail（provider 明确拒绝）才可立即放弃 |
| F2 | **派发：IO 后、confirm 前崩溃（box 可能已在跑）** | 同 F1 的统一规则:allocOutcome 非 clean-fail ⇒ 不重发新指派,观察该 binding 的 WORK 分支等结果（「宁等勿重」,同 unknown-allocation 哲学 control.ts:60-62 [F]）;带证据来源的 physicalExpiresAtSec 是唯一可按时间终结的依据;无证据则保留 UNKNOWN（Codex P1-4/v2-P1-2/v3） |
| F3 | **重发 vs 改派（Codex P2-6:v1 混成了一件事）** | **重发** = 同 intentId/同 binding/同 box 的原字节重送,digest 必须一致——只在向同一 box 的投递不确定时用。**改派** = 同 TaskAttempt 下新 ExecutionBinding + 新 assignmentId/intentId/digest(内容含新 launchId/binding),旧 binding 走 closing 截止——box 端 lifecycle lock（swarm-task.sh:72-79 [F]）拒绝同 LID 重跑,所以换 box 永远是改派,不是重发。两个 binding 并存 = 允许的重复执行（非目标 1）,V6 闭包等价保证只接受一份 |
| F4 | **验收后、本地缓存/投影更新前崩溃** | accepted 已在 CONTROL（顺序纪律：先提交后宣布）⇒ 重放重建投影;重复验收因 §2.6 重放判定 no-op。**绝不多推进一次** |
| F5 | **结果发布后 VM 立刻死（ACK 前）** | commit 已在 WORK 分支（git 即收据）;O1 ancestry 扫描迟早看到。截止走 closing 协议（§2.3）:保证收窄为 **cutoffTip ancestry 内的结果必被登记**（分页扫完才 close,Codex P1-5）;cutoffTip 之后才落地的迟到 push 按明确截止规则拒收并审计——不再宣称覆盖一切「物理上发布早于截止」的情形 |
| F6 | **结果短暂出现后被后续快照清掉** | O1 按 first-parent 链扫历史 commit,不只看 tip 树;已验收的被 O3 钉死（长期 scratch fetch）。**两者解决的是不同问题,不混淆**（先验研究 §2.3） |
| F7 | **上游重跑,下游拿着旧输入** | supersede 级联（§4.2）：未派发 ABANDONED、RUNNING 留给 V4 拒（拒即 ABANDONED,不耗重试）、已成功的下游级联 supersede——完成判定基于 !superseded 的 accepted（§3.1）,自动失效,无需改历史 attempt 状态。digest 比对是机械的,不依赖人记得 |
| F8 | **旧 binding 截止后晚到产物** | V3 **丢弃候选**并记 peer-late 审计——候选级,attempt 状态不动,续跑中的 b1 照常推进（Codex P2-1）。同 attemptId 不是通行证 |
| F9 | **同一 attempt 两个不同内容的 success 结果（重复执行都跑完了）** | V6 按 resultClosureDigest 判等（含引用产物,Codex P2-2）:首个通过验证的被接受,闭包不同的后来者记 candidate。candidate 不推进任何状态,供 repair/人工比对 |
| F10 | **worker 谎报 outcome=success** | 第一层只是证据;V7 契约核对 + V8 项目验证在 dispatcher/review 节点执行,shell exit=0 与 outcome 均不单独构成通过（先验研究 §3.5） |
| F11 | **worker 越界写入 / result.json 超限 / schema 坏** | 声明列表越界由 V1 拒;**未声明的**越界发布由**累计** scope-violation 检查拒（§4.2,binding 起始快照以来——单 commit diff 会漏前一个 commit 的越界,Codex v2-P2-5）;发布快照外的写入（/tmp 等）不进快照,无法也无需证明不存在。milestone 来源的结构坏 permanent;rescue 来源按 inconsistent-snapshot（Codex v2-P2-4） |
| F12 | **VM 链死透（handoff 失败 + alloc 耗尽 give_up）** | 生命周期层 notify + park（dispatch-step.ts:167-168 [F]）;任务层把该 attempt 全部 binding 截止 ⇒ transient-infra ⇒ 新 attempt 新 launch 链（受 job 预算约束）。give_up 的 ControlRecord 不复活 |
| F13 | **集成节点：两份 patch 各自通过、合起来挂** | integration 节点 business-fail → repair 节点（新 revision）→ job 保持未完成。**两份上游 accepted 不被撤销**——它们各自对自己的 acceptance 负责,语义冲突是 integration 层事实 |
| F14 | **CPA token 过期但任务没跑完** | box 还活着,模型调用 401。worker 把已有进展写成 outcome=failure(token-expired) + milestone;验收按 business-fail 重试。派发前的 token 余量检查（§4.5-3）让这成为罕见路径 |
| F15 | **plan 冲突重放（同 jobId 不同内容的 plan 再提交）** | §2.6：digest 不同 ⇒ 拒绝 + 告警。改图必须走新 planRevision |
| F16 | **dispatcher 整机丢失** | Phase T3 前：**明确不可恢复**（本机 log/投影全失;WORK 分支与已分配 box 仍在,人工凭 keydir/分支考古）。T3 后：CONTROL 仓重放 + pending intent reconcile + O1 续扫,验收标准见 §7 |
| F17 | **CONTROL push 冲突（T3）** | v2（Codex 实测 force-with-lease 对同目标 OID 返回 up-to-date 成功）:push 返回后一律**读回 ref 核对内容**。批内容已在链上 ⇒ 前进（同 operationId 同 digest 幂等,不区分写者——「已写过」不等于「我写的」,也无需等于）;内容不同 ⇒ 真冲突,停机告警——第二个活 dispatcher 是部署事故,宁可停不可裂脑 |
| F18 | **rescue 混合快照（新 result.json + 旧 patch）** | V7/V8 拒,分类 inconsistent-snapshot:不耗重试,attempt 回 RUNNING 等 worker 冻结后的一致 milestone;O1 的闭包登记保证 patch 修复后（即使 result.json 字节未变）产生新候选（Codex P2-2） |
| F19 | **successor 发布了可验收结果但始终没有合格接管 ACK** | binding 创建即 pending 登记（§2.3）⇒ O1 一直扫它的分支,结果照常进验收——不等 RESUMED（Codex P2-4）。生命周期层到期删除该 successor 记录是它自己的轨道;任务层的 binding 走自己的 closing 截止,已登记的结果不丢 |

---

## 6. 与现有代码的接入点、不替换什么

### 6.1 接入点

| 现有位置 | 接法 |
|---|---|
| `scripts/swarm-dispatch.ts:197` pass 主循环 | 旁加 taskPass（§4.5）,handoff pass 原样 |
| `scripts/swarm-dispatch.ts:112` saveRecord / `dispatch-step.ts:55` ops.persist 契约 | 实现改为 commitControl 批写,签名不动（步骤 A） |
| `scripts/swarm-dispatch.ts:74` observeTip + `acceptance.ts:32` tipToEvent | 不动;任务层 O1 扫描复用同一 scratch/fetch 设施,挂自己的 cursor（null=before-root）,接口须区分 not-found 与 error（§3.3 X9） |
| `scripts/swarm-task.sh:32`（模式分发） | 新增 `--task` 分支;--resume 增业务模式（检测 assignment 则启动真实 worker,§4.5-6b——「原样」已不成立,Codex v2-P3-1）;--demo 原样 |
| `dispatch-step.ts:260` awaitResume 确认成功处 | 产生 X2 的 binding 开合事件（经任务层监听「RESUMED 发生」,不改 awaitResume 本身——它已在同点持久 child anchor [F],任务层批随后续 commitControl 落） |
| `packages/bus/src/swarm/mint.ts` | 原样用于 worker token（§4.5-3） |
| `packages/bus/src/swarm/room.ts` | 原样用作 dispatcher→VM 的接受指令/催告通道（O2）;结果主通道是 git,room 只作通知 |
| 新模块 | `task-plan.ts`（schema+校验）、`task-state.ts`（attempt/binding 纯转移）、`task-ready.ts`（readyTasks）、`task-result.ts`（V1-V8 纯判定）、`control-log.ts`（commitControl 两步实现）——全部纯函数+注入 IO,照 control.ts/dispatch-step.ts 的既有纪律 |

### 6.2 明确不替换（先验研究 §2.8 的结论,逐条确认仍成立于 01ea35b）

- Git 发布管线：串行发布、固定远端 parent、foreign tip 拒绝、lost-ACK 集合重认、final 冻结、启动恢复（swarm-supervisor.mjs:148-258,360 [F]）。
- 快照 acceptance：pinned SHA、同代际、祖先、幂等（acceptance.ts:32 [F]）。
- 交接状态机与恢复协议：unknown 保留 attempt、successorGen pin、placeholder 预建、qualified takeover 门槛（control.ts、dispatch-step.ts 全部 [F]）。
- 物理容量模型 physicallyOccupies/effectiveLive——**连同其已知缺口**（Codex 01ea35b 残留 3P1+5P2+延期 P2-6）：任务层不修改、不绕过;业务结果判定不依赖它们,admission 的资源上限与活性依赖(X5/附录),缺口按生命周期层自己的轨道修。
- durable inbox / 会话总线：与任务账本无关,不混用（消息送达 ≠ 任务验收）。

---

## 7. 分阶段实施计划（每阶段可失败验收）

遵循先验研究的实施次序：单任务闭环 → DAG+综合 → 跨机 CONTROL。阶段内先纯函数+测试,后 IO 接线;全程 SWARM_EXEC 门控照旧。

### Phase T1：task 契约 + 真实 Claude worker（单节点闭环）

做：TaskResult schema + V1-V8 纯判定（task-result.ts）;assignment 下发 + swarm-task `--task`;CPA token 注入;O1 扫描;单节点 plan（无依赖）手工提交;验收在 dispatcher 本机执行。
**可失败验收**：
- 真实 Claude worker 在固定输入上产出可读取的 result.json,V1-V8 全链路可拒可收（构造 8 类坏结果逐一证明拒绝路径,不只测通过路径）。
- 任务中途强制 handoff（缩短预算触发 drain/checkpoint/resume）,attemptId 不变、binding 链 +1、successor 上继续的是**真实业务任务**（同 assignment 语境,非 demo——Codex P2-5）且其业务输出按同一 attempt 验收通过;只验 successor milestone 不算过。
- 只有 milestone、没有合格 result.json 时,节点**不**SUCCEEDED——bash demo 管线绿 ≠ 本条通过（先验研究 建议一原话）。
- worker 越界发布 → 声明的由 V1 拒、未声明的由累计 scope-violation 检查拒（§4.2 v3）;allowlist 外的本就不进快照,不纳入断言（Codex v2-P3-1——v1「双层证明」的说法作废）。

### Phase T2：Plan/Attempt 状态机 + ready-set + 聚合（单机 DAG 闭环）

做：task-plan/task-state/task-ready;commitControl 步骤 A（本机日志,mirror 降投影）;taskPass;supersede 级联;integration/synthesis 节点;重试三预算。
**可失败验收**：
- 菱形 plan（C→P,Q→I）：P/Q 并行派发（两个 box）,I 等两侧 accepted 才派发;Q 先完成不触发 I。
- 环/缺依赖/重复 ID 的 plan 被整体拒绝。
- 上游 supersede 后：未派发下游作废、RUNNING 下游结果被 V4 拒、已成功下游被级联 supersede——三条分别注入证明。
- 同一任务经两台 VM 完成,retriesUsed 仍为 0;业务拒绝一次后 retryAt 未到不进 ready-set（时间注入测试）。
- 两份 patch 单独通过、集成失败 ⇒ job 保持未完成 + repair 节点出现在新 revision。
- 崩溃时点 F1/F2/F4 注入重放：恢复后不多派发、不多验收（对日志逐批断言）。
- 杀掉投影目录,仅凭 control-log 重建,状态与崩溃前一致。
- （审查新增,P1-1）同一 attempt 连续经历创建→结果观察→验收→binding 更新:每步成功;重复同一 operationId 同 payload = no-op;篡改同一 operationId 的 payload 才冲突。
- （审查新增,P1-2）成功根节点被 supersede 后重新 ready;a1 重试→a2 stale ABANDONED→a3 可派发,节点不被 a1 误判终败;同 nodeId 改 spec 后旧成功不满足新节点。
- （审查新增,P1-5）backlog 65/129 个 commit、结果在最后一页、终扫中途网络失败、close 批之前迟到 push:分别断言哪些必须补录、哪些按 cutoffTip 规则拒收。
- （审查新增,P2-1/P2-2）旧 b0 迟到候选被拒而 b1 照常成功;rescue 混合快照不耗重试,修复 patch 后闭包变化产生新候选并验收通过。
- （v2 复核新增,P1-1）只改上游 C 的 spec、P 的 spec 不变:C 与 P 的 currentAccepted 都变 null,新消费者不得绑定旧 C;C 重新验收后新旧并存时 current 取 decidedAtSeq 最大者。
- （v2 复核新增,P1-3）唯一结果在无父根提交里:cursor 从 null 起扫含根,任务可完成;空分支后来出现根提交同样处理。
- （v2 复核新增,P2-1）健康 VM 不进 closing 完成任务;clean-fail binding 以 empty 截止合法终结;查询失败保持未决不冒充空分支。
- （v2 复核新增,P2-3）retryBudget=2 恰好允许初次执行后两次业务重试;handoff 与 transient-infra 不动计数。
- （v2 复核新增,P2-4/P2-5）rescue 抓到半写 result.json 不封死 attempt,后续完整 milestone 照常验收;越界文件在前一 commit 发布、result 在后一 commit,累计检查仍拒;patch 改 sourceWriteScope 内源码文件通过、scope 外被拒。

### Phase T3：GitHub CONTROL 接线（可与 T2 并行开发,放行跨机宣称的闸门）

做：commitControl 步骤 B（force-with-lease CAS、异步批、冲突停机）;权限分离核查;整机恢复演练。
**可失败验收**：
- 发送前/发送后-ACK 前/接受后-缓存前三类崩溃,恢复均不多推进（F1/F2/F4 在真 git 后端重跑）。
- （审查新增,P1-3）人为延迟 CONTROL push ACK:allocator 调用数必须保持 0;远端拒绝或 ACK 未知时不越过屏障。
- （v2 复核新增,P1-2）把 SWARM_BUDGET_SEC 调成 60:pending allocation 的物理占用期限不变（physicalExpiresAtSec = 最晚创建时间 + provider 常数),只有 drain 提前。
- （v3 复核终稿,P2）无 provider 证据的 UNKNOWN 分配在任意时间推进后仍计占用、不被判死;注入 provider expiry 证据后才可按时释放;启用启发式回收策略时断言它被明确标记为「可能超 cap」而非物理死亡。
- **丢弃整机**（删 mirror+log+scratch+/tmp keydir）,仅凭 CONTROL 仓 + WORK 仓恢复：pending/unknown 的分配 intent 被找回、保守计占用、同一逻辑分配不重复创建（P1-4）;已 accepted 的结果经远端留存 ref 仍可达（P2-3）。
- 双 dispatcher 并发注入:不同目标 ⇒ 后写者 lease 失败停机;**相同内容**目标 ⇒ 读回核对判等价前进,无裂脑（P1-3 边界,不只测两个不同 commit）。
- 只有本阶段全过,才把文档/对外说法升级为「dispatcher 整机丢失可恢复」。

### 此后（不进本设计承诺）

box 空闲复用、异构评分、增量 ready 缓存、动态分解——均在有真实遥测后再议。

---

## 8. Open questions（需要用户拍板）

1. **CONTROL 仓形态**：独立私有 repo,还是 WORK repo 的 `control` 分支？v2 收窄（Codex P2-7）:repo 级 deploy key 无法按分支分权,同仓方案要么接受 box 技术上能写 control 分支、要么上服务端分支保护——独立 repo 是唯一干净边界。**建议（基本定论）：独立 repo。**
2. **planRevision 的提出者**：v1 是否只接受人工编写的 plan JSON（规划 agent 后接）？**建议：v1 人工/主会话编写,校验器把关;规划 agent 输出同一 schema 是纯增量。**
3. **V8 项目验证的默认执行位置**：dispatcher 本机隔离目录（快、省 box 寿命,但吃本机资源且引入本机环境差异）vs 一律 review 节点上 box 跑（贵、慢、环境干净）。**建议：轻检查本机,重检查（整套测试）review 节点;acceptance 清单每条标 `locale: local|box`。**
4. **job 模型费预算**：是否接 CPA 的 budget_usd 账本（mint.ts 字段已预留但 CPA 侧 inert [F]）？不接则 maxModelUsd 只能靠 attempt 数粗约束。
5. **box 空闲复用**：v1 一 box 一 assignment（本文立场）。若 60 分钟寿命内任务平均 10 分钟,浪费显著——要不要在 T2 后紧跟一个「串行复用」小阶段？
6. **headless Claude 的具体调用形态**：`claude -p` 的输出格式/退出语义随版本变,assignment→prompt 模板与「何时算 worker 自然结束」需要在 T1 第一周用真 CLI 定稿（设计上只依赖「能读文件、能写文件、退出码」三件事,形态变化不伤骨架）。
7. **peer-late / candidate / RejectedResult 的保留与 GC**：CONTROL 日志只增,多久归档一次？（纯运维,不影响协议正确性,但 T3 前要有答案避免日志无界。）
8. **repair 节点的自动化程度**：integration 失败自动生成 repair 节点并派发,还是停下等人批？**建议：自动生成、默认停在 READY 等人工放行（plan 加 `autoDispatch: false` 标志）,跑熟后放开。**

---

## 附：与 Codex 残留问题的关系（v2 按设计审查收窄——「独立成立」原说法过强）

**可独立开发的**：Task schema、纯 ready-set、验收函数（V1-V8 + scope diff）、commitControl 日志接口——全是纯函数 + 注入 IO,不碰生命周期模块;生命周期层修自己的缺口也不需要知道任务层存在。

**端到端行为有前置契约的**（设计审查逐条核实）：
- **结果可见性**:binding 创建即 pending 登记（§2.3 v2）使 O1 不依赖接管成功——但 v1 确实依赖（X2 只在 RESUMED 后开 binding,失败 successor 的成果任务层永远看不见,Codex P2-4）;修订后仍依赖「successor 的 launchId/gen 在 IO 前可知」,这由现有 allocate 的 pin 纪律提供（dispatch-step.ts:186 [F]）。
- **删除/重建**:步骤 A 的 tombstone 消解既知 P2-4（unlink 吞错）,但既知 P2-3（keydir 重建已删 child）还要求 pass 的 discovery 查 tombstone——这是明确的接线义务,写进步骤 A 的 Change union,不自动发生。
- **容量/活性**:task admission 读生命周期的占用事实;既知 P1-1/P1-2/P2-2（预留漏算/物理 TTL 混用/phantom reservation）失真时,任务派发会被错误放行或饿死。任务层不修它们、不绕它们,等它们按自己轨道修——此期间 T2 验收在注入的正确占用模型上做,live 吞吐不作承诺。
- **child anchor 异常路径**:awaitResume 的 anchor 写入只覆盖正常路径（写失败重试跳过、非 seed 不推进、missing child 绕屏障——既知复审 01ea35b P2-5）;任务层对**已发布结果的识别/验收**不依赖该 anchor（binding + O1 够了）,但业务 continuation 的恢复输入（handoffSha 处的进展）仍由生命周期层提供——anchor 坏的异常路径下续跑起点可能偏旧,这是前置契约不是任务层能绕的（Codex v2 附录修正）。

**结论改述**:任务层的**模型与模块**可独立开发并单测;**端到端上线**依赖上列契约成立或由任务适配层提供等价保障。Phase-3 live handoff 的放行与本设计无关,按 Codex 报告自己的闸门走（三份报告一致:当前不放行）。
