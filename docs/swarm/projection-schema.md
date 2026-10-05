# 投影 schema:蜂群状态的只读消费者契约

日期:2026-10-03。状态:**v1 定稿**(双边对齐完成;实现随 brain-design §4.3 步骤 A/T2 落地)。消费端对账副本:swarm-viz worktree `docs/swarm/viz-projection-contract.md`(其提交 03c5c49)——两份各自记录同一次对齐,实现期若有出入以本文为准、键名类差异以「executor 判别联合不变、键名可调」为界。
定位:brain-design v3-final 与 team-collab v2-final 的**非规范性伴随文档**——它描述投影(只读视图)的形状,不新增、不修改任何协议条款;权威仍是 CONTROL 日志,投影坏了重放即重建。消费者:swarm-viz(需求来自其 consumer 会话,2026-10-03 总线来函)与 dispatcher 快速启动。
标注沿用:[F] 已实现事实 / [D] 新增设计。

## 0. 消费契约(三条,给所有只读消费者)

- **C-1 读当前态,不读历史。** 投影 = 实体当前状态的 JSON 文件,消费者永远不重放 `control-log/<seq>.json`——重放即重实现 reducer,必然漂移。要历史另开审计接口(非 v1)。
- **C-2 只读文件,不 import 模块。** 消费者与蜂群代码零链接;文件格式就是全部接口。
- **C-3 每文件原子可信。** 写入一律 temp+rename(与现有 mirror 纪律一致 [F] swarm-dispatch.ts:112);消费者任意时刻读到的是某个完整版本,跨文件之间**不保证**同一瞬间(最终一致;需要一致切面时读 `meta.json` 的 seq 并容忍落后)。

## 1. 目录布局 [D]

```text
~/.agenthop/swarm/projection/
  meta.json                     # { schemaVersion: 1, lastAppliedSeq, rebuiltAt }
  control/<launchId>.json       # 现有 ControlRecord 原样(生命周期轴,字段见 control.ts [F])——即今日 mirror 的延续
  jobs/<jobId>/plan.json        # 当前 revision 的 TaskPlan(§2)
  jobs/<jobId>/attempts/<nodeId>.json    # 该节点当前 attempt + 历史摘要(§3)
  jobs/<jobId>/results.json     # 该 job 的 Accepted/Rejected/candidate 索引(§4)
  jobs/<jobId>/budget.json      # 预算与消耗(§5)
  members.json                  # durable 成员名册(协作层,§6)
```

旧 `control/` 目录位置不动(swarm-viz 已在读 [F]),新增全部在 `projection/` 下;过渡期 control 双写,viz 切换后旧路径退役。

## 2. plan.json——DAG 骨架(需求 2)

```jsonc
{
  "jobId": "job-x", "planRevision": 3, "planDigest": "…",
  "jobStatus": "running",               // running|succeeded|failed|blocked —— 由权威 reducer 按 brain §4.4 判定后写入(viz 缺口 1)
  "jobStatusNote": "waiting on I",      // 一行人话
  "nodes": [{
    "nodeId": "P",
    "kind": "work",                     // work|integration|synthesis|review|repair
    "goal": "…",
    "dependsOn": ["C"],                 // 画图就用这个
    "required": true,                   // job 成功是否以此节点为必要条件(brain §4.4「必需节点,默认全部」的投影;viz 缺口 2)
    "runtime": "ephemeral",             // ephemeral|durable —— 员工 vs 外包的节点级标注(需求 5 之一半)
    "visibility": "headless",
    "specDigest": "…"
  }]
}
```

## 3. attempts/<nodeId>.json——业务轴 + binding 接缝(需求 3、4)

```jsonc
{
  "nodeId": "P",
  "current": {
    "attemptId": "job-x/P/a2",
    "status": "RESULT_PENDING_VALIDATION",   // 全枚举:RUNNING|RESULT_PENDING_VALIDATION|SUCCEEDED|RETRY_WAIT|FAILED|ABANDONED
    "complete": false,                       // = currentAccepted(node) != null,由权威 reducer 算(brain §3.1 递归函数)。
                                             // 消费者绝不自算——上游 supersede/改 spec 的级联失效只有 reducer 知道(viz 缺口 1:
                                             // 自算者必与 dispatcher 漂移,画出「看着绿、上游已失效」的最难发现的谎)
    "statusNote": "worker 自报完成,待验收",     // 给人读的一行;viz 直接显示,不自己翻译枚举
    "role": "implementer of P, patch against base …",   // 本次 assignment 的角色文本首行(缺口 4:role 随指派不随成员)
    "retriesUsed": 1, "retryAt": null, "failureClass": null,
    "inputBindings": [{ "depNodeId": "C", "acceptedResultId": "job-x/C/a1/r1" }],
    "executionBindings": [{
      "bindingId": "job-x/P/a2/b0",
      "executor": { "kind": "box", "launchId": "rw-9f21" },
      //           或 { "kind": "member", "memberId": "claude:Work-20cab0a5", "publishKey": "dm-7a31" }
      // kind=box:launchId 连 control/<launchId>.json(外包箱子,唯一接缝不变)。
      // kind=member:memberId 连 members.json(员工领任务,viz 缺口 3 的答案 (ii)——durable 同样走 binding,
      //   业务轴对两类执行者同构);publishKey 是 publisher adapter 的 WORK 分支键(员工没有 control 记录,
      //   不要去找)。publishKey 的生成规则归 C0 定([D],team-collab C0 义务清单的一部分)。
      "publishGeneration": 1,
      "continuationOf": null,              // handoff 链:b1 的这里指 b0
      "state": "open"                      // open|closing|closed
    }]
  },
  "history": [{ "attemptId": "job-x/P/a1", "status": "ABANDONED", "failureClass": "stale" }]   // 摘要,只留判定要素
}
```

**渲染注解(把两层验收画诚实,需求 4 的约束):** status=RESULT_PENDING_VALIDATION 必须与 SUCCEEDED 视觉可分(待验色 vs 绿);SUCCEEDED 的依据永远是 results.json 里的 accepted 条目,不是 worker 自报——投影保证二者一致(SUCCEEDED ⇔ 存在对应 accepted),viz 不需要也不应该自己交叉验证。

**判定下沉原则(C-1 的语义层延伸,viz 缺口 1 定名):** 凡是「由递归/级联规则导出的判定」(complete、jobStatus、节点终败)一律由权威 reducer 算好进投影;消费者只消费布尔与枚举,不重算。注意 `status=SUCCEEDED` 与 `complete` 可以不同:attempt 验收通过后上游被 supersede,status 仍是 SUCCEEDED(历史事实),complete 变 false(当前有效性)——viz 应画成「曾绿、现失效待重跑」。

## 4. results.json——验收决定(需求 4)

```jsonc
{
  "accepted": [{
    "acceptedResultId": "job-x/C/a1/r1", "nodeId": "C", "attemptId": "…",
    "observedWorkCommit": "…", "resultPath": "out/results/…/result.json",
    "superseded": false, "decidedAtSeq": 41
  }],
  "rejected": [{ "nodeId": "P", "attemptId": "…", "reason": "contract", "atSeq": 44 }],
  "candidates": [{ "nodeId": "P", "attemptId": "…", "note": "duplicate closure" }],
  "peerLate": 2                      // 只给计数,审计明细在日志
}
```

## 5. budget.json——成本可见(需求 6)

```jsonc
{
  "jobBudget": { "maxTotalAttempts": 20, "maxWallClockSec": 14400, "maxModelUsd": null },
  "used": { "totalAttempts": 7, "wallClockSec": 5210, "modelUsd": null },   // modelUsd 在 CPA 账本接通前恒 null,不估算
  "perNode": [{ "nodeId": "P", "attempts": 2, "retriesUsed": 1, "retryBudget": 2 }]
}
```

## 6. members.json——员工名册(需求 5)

```jsonc
{
  "members": [{
    "memberId": "claude:Work-20cab0a5",    // 总线句柄;就是 viz 已有 peers 的键
    "class": "durable",                    // 恒 durable —— ephemeral 不进名册,它们只以 binding.executor 出现
    "visibility": "visible",
    "reachability": "ok",                  // ok|suspected —— gone 语义照 team-collab §2:suspected ≠ 死
    "activeBindings": ["job-x/I/a1/b0"]
  }]
}
```

**role 不放 members.json(viz 缺口 4 的答案)**:按 collab-primitives 的既定立场,role 是**每次指派的提示文本,不是成员属性**——没有角色注册表(否则就是中央状态 + 过期模板)。所以 attempts/<nodeId>.json 的 current 增加 `role: string`(来自该次 assignment);viz 画「员工当前角色」= 顺着 activeBindings 取各 binding 所在 attempt 的 role。一个员工同时领两单可以是两个角色——这是设计语义,不是数据缺陷。decisionRights 摘要同理随 attempt(v1 可不投影,角色提示里已有)。

ephemeral VM 的「外包」画法不需要新字段:**出现在 binding 里但不在 members.json 里的 launchId 就是外包**,其生命周期在 control/<launchId>.json。

## 7. 协作层(DM/板)的投影立场

v1 **不投影** DM 与团队板:DM 是可丢的 advisory(R0),板有自己的 gossip 可读面(viz 将来可直接做板房间的只读成员,Stage A 落地后另议)。投影里唯一的协作痕迹是结果 evidence 文件(在 WORK commit 内,随 resultPath 可达)。这与消费者自declared 的渲染规则一致:DM 永远不画成推进任务状态。

## 8. 一致性与版本

- 投影由 commitControl 的 apply 钩子同步更新(每批提交后重写受影响文件),`meta.lastAppliedSeq` 单调;消费者检测到 seq 回退 = 投影在重建,整目录作废重读。
- schemaVersion 起 1;加字段不升版,改语义/删字段升版并保留一个过渡版本期。
- 投影丢失/损坏不是故障:dispatcher 重放 control-log 全量重建(brain §4.3 步骤 A 的既定能力)。

## 8b. v1 增补(2026-10-03,实弹笔记五缺口定稿;「加字段不升版」)

- **review 两种形态的建模指引(S1)**:节点式 review = 消费冻结输入的终审,进 DAG;流水式 review(边做边审)= **验收活动**,不建节点,每轮结论落 results.json 的 accepted/rejected。把流水 review 建成 DAG 节点会与递归 currentAccepted 冲突(它依赖未完成节点,恒 complete:false)——那是模型故意不让,不是缺陷。
- **decidedBy(S4)**:accepted/rejected 条目加 `decidedBy: string`(memberId 或 validator 标识);同 attempt 的多轮验收结论靠 decidedBy+时序+supersede 链区分「曾绿已修」与「反复横跳」。
- **issuedBy(S8)**:supersede 置位时投影在被 supersede 的 accepted 上暴露 `supersededBy: { issuedBy, atSeq }`——打回边 = issuedBy→target,viz 画虚线。
- **runDrift(S5/F1)**:members.json 条目加 `runDrift: { count, lastChangeAtSec }`——memberId 稳定不变,漂移次数作可靠性信号可见。
- **observed[] 节选(S2)**:results.json 加 `observed: ResultObserved 摘要[]`(每 attempt 最近 N 条,含 commit/path),attempt 内多 commit 推进的轨迹由此可见——零件 CONTROL 本就有,此前投影漏暴露。

viz 渲染侧若再报缺口,作后续增补,不阻塞本批。

## 8c. v1 增补二(2026-10-03,wait 实体投影;「加字段不升版」)

- 目录新增 `waits/<waitId>.json` = control-log `{put:"wait"}` 实体当前态**原样**(WaitRecord 全字段;若 §0b A1 增补冻结,预算/耗尽字段随之出现——消费者按可选字段处理)。
- 渲染注解:approval 的 `decision:"pending"` 与 wait 的 `state:"open"` 是两根轴,分开画(resolved≠granted 是冻结语义);`automationExhausted` 置位 ⇒ 画「自动催办已停、等人」,这是合法长期状态不是故障;判定下沉原则同 §3——过期与否由 sweep 判,投影只给 deadlineSec,viz 可以画倒计时但不得自判「已超时」改状态色。
- sweep 的处置动作本身不投影(它们是 CONTROL 转换,结果已反映在 wait 状态里);审计走日志。

## 9. 与 tasklog(P0 运输记录)的分层——防止再长出两套任务模型

swarm-viz 仓库里已有 `packages/bus/src/tasklog.ts` [F]:file-per-task、temp+rename、读者永不阻塞写者——**正是本文 C-3 的纪律,先例有效**。但它是 **P0 TASK 的运输记录**(「一单工作递给了谁、对方回了什么状态」,总线层),不是业务任务轴(attempt/验收/依赖,brain 层)。分层立场:

- 业务轴只有一套 = brain 的 attempt/accepted,经本投影暴露;viz 的任务河/DAG 从投影渲染。
- tasklog 保留为 P0 的运输明细(durable 派发的送达凭证);viz 若渲染它,画成运输层注脚,不画成第二条任务轴。
- viz 现有 `fromControlMirror` 合成行与 launchId 子串匹配,投影落地后退役(其会话已确认)。
- tasklog 的 TaskResult 已带可选 costUsd [F]——P0 落地后这是 budget.json 的 modelUsd 从 null 变实数的最近数据源,记入对齐事项。

## Open questions——已全部与 viz 会话对齐(2026-10-03)

1. attempts 历史摘要:**定,最近 8 条 + 计数**。
2. statusNote:**定,投影只给英文,翻译归 viz**。
3. 反向指针 boundTo:**定,不加**——viz 为画 DAG 本就读全部 attempts,顺手派生反向索引;去规范化指针反而是漂移隐患(binding 变了 boundTo 没同步 ⇒ 画出错绑)。能从已读数据派生的,不在写入侧再存一份。

## 消费者承诺(viz 会话自报,记录在案)

- attempt 文件从 plan.nodes[] 驱动读,不 glob 目录(无需索引文件)。
- 工作状态 = members.json + 总线 peers() 合并;不要求投影带 live 状态。
- 跨文件 skew 防御式渲染(引用了尚未出现的文件 ⇒ 画 pending,不报错不凑切面);meta.lastAppliedSeq 回退 ⇒ 整目录作废重读。
- DM 永不画成推进任务状态(R0);预算条留运输层 costUsd 输入位(§9)。
