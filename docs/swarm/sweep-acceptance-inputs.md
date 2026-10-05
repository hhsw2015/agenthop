# sweep 验收输入:真实台账迁移 + 两个验收场景(协调者承诺兑现)

日期:2026-10-03。供方:协调者会话(fe0376cd)。消费方:sweep 批(20cab0a5)。
背景:T1 封印后 sweep 开工,此文件兑现两项承诺——人肉台账(~/.agenthop/coordinator-waits.json)的真实 waits 迁成 `{put:"wait"}` 实体作为 sweep 第一批输入;两个真场景作验收。脚手架退役条件:sweep 处置第一个真实过期 wait 后,人肉台账与巡检 tick 退役(dogfood 既定)。

## 1. 真实 waits → {put:"wait"} Change(按 task-wait.ts 的 NewWait/openWait 形状)

迁移时刻 now=1791034877。operationId 按 `wait:<waitId>#<rev>` 约定(765c263 同款)。

```jsonc
// wait 1:T1.5 resume adapter(真实在途,远期限)
{
  "put": "wait",
  "wait": {
    "waitId": "coord-t15-resume-adapter",
    "kind": "wait",
    "subject": { "jobId": "swarm-t1.5" },          // attemptId 等 sweep 批定(T1.5 还没有 attempt)
    "state": "open",
    "deadlineSec": 1791108596,
    "owner": "claude:swarm-brain-io-20cab0a5",      // = 总线 memberId;bus-identity 落地前就用句柄
    "timeoutPolicy": "escalate"                     // 到期不是旁路而是问协调层:T1.5 无自动旁路
  },
  "operationId": "wait:coord-t15-resume-adapter#1",
  "expectedEntityRevision": 0
}

// wait 2:T1 seal 收尾(round-5 已 ALL CLOSED,此 wait 迁入后 sweep 的第一个动作
// 就应是消费「owner 已报完成」的 close——即它是真实的『正常完成与 wait 同批关闭』素材)
{
  "put": "wait",
  "wait": {
    "waitId": "coord-t1-seal-closeout",
    "kind": "wait",
    "subject": { "jobId": "swarm-t1", "attemptId": "swarm-t1/seal/round-5" },
    "state": "open",
    "deadlineSec": 1791038300,
    "owner": "claude:Work-20cab0a5",
    "timeoutPolicy": "bypass"                       // 旁路=追问进度(原台账 bypass 字段)
  },
  "operationId": "wait:coord-t1-seal-closeout#1",
  "expectedEntityRevision": 0
}
```

历史行备注(供 sweep 测试的多样性,不迁实体):1cfa162 审查行经历了「排队→改派→ack→完成→复验→关闭」全周期;765c263 复验行经历了「预登记挂起→激活→关闭」。两种生命周期都是 sweep 将来要原生支持的形态(排队 wait 的 owner 换人 = close+新开,不是 mutate owner)。

## 2. 验收场景 A:过期 wait 自动 begin_action(happy path,crash 窗口已由 1cfa162+765c263 钉死)

真实原型:台账「T1 seal」行曾过期(deadline 1791037163 vs tick 时刻),协调者人肉执行了 bypass「追问进度」。sweep 化:

- 给定:wait coord-t1-seal-closeout,state=open,deadlineSec < now,timeoutPolicy=bypass,owner 经注入 isAlive(owner)="alive"。
- 期待:sweep 本步内 CAS 提交 begin_action{actionId,actionKind:"bypass",target:subject.attemptId,expectedSubjectVersion}(open→action_pending),**然后**才做 IO(发追问消息);IO 完成带证据(消息已送达/回执)后 action_done。
- **【勘误 2026-10-03,R2 语义收紧——原文「action_done→resolved」写松了】**:普通 wait 代表**被等待的工作/答复本身**(R2 严格读法),不是「发一次催办」的通知任务;催办入箱证据**不能**替代原工作的完成/旁路证据。action_done(催办完成)的正确后继是**回 open + 新 deadline**(re-arm,对齐 approval 升级「监督转移不消失」的既有先例;A1 展期预算冻结后自动适用于此路径)。resolved 只能来自:subject 正常完成(同批 close)/改派(close+new,episo 继承)/预算耗尽走终态通道。勘误原因:初稿场景 A 以 T1-seal 实例为原型,该实例中原工作恰已完成,我把「催办送达」误并成「等待满足」——实现按原文做了 resolved,语义缺口由 Codex 增量审查(2026-10-03)问出。裁定与勘误同步发出。
- 断言:① begin 的 CAS 在任何 IO 之前(纯层已证,这里断 IO 调用次序);② 同一过期 wait 在同一 tick 不会 begin 两次(重入=replay no-op);③ 追问消息的收发走 R5 白名单通道(总线),不是裸 exec;④【勘误补】催办完成后 wait 回 open 带新 deadline,**不 resolved**——监督不因一次 ping 蒸发。

## 3. 验收场景 B:UNVERIFIABLE owner → owner-dead 旁路(F13/F16/F17 的机制化)

真实原型:a3def7c0(F16,实测不可达)——台账把它标 UNVERIFIABLE 后人肉改派了 1cfa162 审查单。sweep 化:

- 给定:wait(审查单形态),owner 经注入 isAlive(owner)="dead"(或连续 N 个 tick "suspected",N 为 sweep 配置;单次 suspected ≠ dead,team-collab §2 语义,F17 教训:弱谓词禁用,isAlive 的实现契约是两证据面)。
- 期待:不等 deadline,立即走 owner-dead 旁路:begin_action{actionKind:"reassign"}→IO(关旧开新:close 原 wait(resolution.outcome="owner-dead")+ 对新 owner 开新 wait,**同批提交**)→确认。
- 断言:① suspected 单次不触发(把 isAlive 注入序列设为 ["suspected","alive"] 时 wait 原样);② dead 触发的改派是 close+new,原 waitId 终态留痕,新 waitId 可独立追;③ 新 wait 的 owner ≠ 旧 owner;④ 全程零 human 消息(north-star 对账:这正是今天人肉做过的事,代码化后 human 消息数-1)。

## 4. isAlive 注入契约(双方已对齐的语义,此处只是钉下)

`isAlive: (memberId: string) => "alive" | "suspected" | "dead"`——纯函数注入,sweep 不自己探测。bus-identity 落地后换实现不换 sweep。测试里用序列 fixture;生产首版可用 peers 在册+state 映射(在册 working/idle=alive,unknown=suspected,不在册=dead),它的已知缺陷(F17:unknown≠dead)正是 bus-identity 要修的,sweep 不背。
