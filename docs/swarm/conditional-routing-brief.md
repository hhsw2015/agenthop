# conditional-routing v1 — 契约(冻结)

owner=f32a0507;协调者派单(user 裁 AgentGate/双镜吸收案②,引擎镜头号借「运行时条件路由+动态扇出」)。设计先行判例:**本契约冻结后才动码**。纯层 + dormant 接缝,dispatcher 接线留下轮。off main @7b8e87c。借点出处见 [[agent-gate-eval]] §2(错误类型→责任阶段定向路由)与 §4;本件把「定向回环」的**运行时条件化**与 LangGraph 式 **Send 动态扇出**落到我方 force-pipeline/task-plan 之上,纯决策、确定性、无自由表达式。

## 范围与边界

- 升级对象:`force-pipeline`(DA4,边 = 强制 A→B)与 `task-plan`(dependsOn 数据流 DAG)。
- 本件**不改** `force-pipeline.ts`(保持字节稳定,landed @7b8e87c);新增独立纯模块 `packages/bus/src/swarm/conditional-routing.ts` 层叠其上(复用 `validateForcePipeline` 的 DAG/去重/悬空/环校验,只加 `when` 谓词与扇出)。
- **不接线**:dispatcher/T3 不在本轮改;所有新能力经 dormant 旗 `SWARM_CONDITIONAL_ROUTING`(默认 OFF,opt-in,同 `SWARM_FORCE_PIPELINE`)门控,未启用时运行时零变化。
- 不引入自由表达式/脚本:谓词是**枚举表**(FC-6 确定性);扇出是**位置性**纯展开。

## ① 条件边(conditional edge)

**数据模型**:
```
EdgeCondition =
  | { kind: "status-ok" }                              // 上游状态为 ok
  | { kind: "result-exists" }                          // 上游有 resultRef
  | { kind: "field-eq"; field: string; value: string } // 上游某枚举字段 === value(精确字符串)
ConditionalEdge  = ForceStage & { when?: EdgeCondition }   // 无 when = 无条件边(向后兼容)
ConditionalPipeline = { schema: "conditional-routing/v1"; stages: ConditionalEdge[] }
UpstreamView = { status?: "ok" | "failed"; resultRef?: string | null; fields?: Readonly<Record<string,string>> }
EdgeDecision = "take" | "skip" | "unknown"
```
`UpstreamView` 是 evalEdgeCondition 读的**纯投影**:dispatcher IO 层把真实 `AcceptedResult`/`TaskResult`(task-result.ts:outcome/outputs/…)映射成它,纯核不碰 task-state 机器。禁自由表达式:`when` 只认上述三种 `kind`,其余整体拒绝。

**校验** `validateConditionalPipeline(input, knownNodes?) → Res<ConditionalPipeline>`:
- **入 schema 二选一**:`conditional-routing/v1`(本件声明)或 `force-pipeline/v1`(旧,FC-7);**出恒 `conditional-routing/v1`**,故合法输入既过校验、**输出又能再过同一校验器**(往返,CR-P2-1)。
- **单次捕获 + 捕获时即复制谓词标量**(CR-P2-2):逐边读自有数据 from/to,并**当场** `validateCondition` 把 `when` 的 kind/field/value **校验+复制成独立对象**(不在 snap 里留原 `when` 引用待稍后解读)。这一步在**结构校验之前、任何 knownNodes 读取之前**完成,故后续读取后继阶段或读 knownNodes 时触发的原输入突变,改不动已捕获边的端点或谓词内容。`stages` 非数组(含 getter 返回非数组)、`when` 非法或不可靠捕获 ⇒ 整体拒绝。
- 把由快照构建的**受控 `force-pipeline/v1` 投影**(plain 对象,无访问器)交给已签 `validateForcePipeline`(复用:自引用/重复边/悬空/环=Kahn/from-to 类型,trust-boundary 一致)——**绝不把原输入交给它**(其 schema 可能是 conditional-routing/v1)。投影保序 ⇒ base.stages[i] ↔ snap[i]。
- 组装:已校验 `{from,to}` + 捕获时已复制的 `when`(皆独立于原输入,组装阶段不再读原输入);无 `when` 的边输出 `{from,to}`(与 force-pipeline **边**字节一致,FC-7)。

**裁决** `evalEdgeCondition(edge, upstream) → EdgeDecision`(纯,无时钟/IO/随机;FC-6 确定性表):
| 情形 | 结果 | 理由 |
|------|------|------|
| 无 `when` | **take** | 无条件边(向后兼容) |
| `upstream` 为 null/undefined | **unknown** | 整个上游结果不可读 ⇒ 不走该边、不报错、保留重试 |
| status-ok:`status` 缺失 | **unknown** | 状态不可读 |
| status-ok:`status==="ok"` | take / 否则 **skip** | 可读且判定 |
| result-exists:`resultRef===undefined` | **unknown** | 不知是否有结果 |
| result-exists:非空串 | take;`null`/空串 ⇒ **skip** | 显式无结果=判定跳过 |
| field-eq:`fields` 缺失 / 字段缺 / 值非串 | **unknown** | 判定所需的枚举不可读 ⇒ 保留重试(**不静默 skip 丢下游**) |
| field-eq:值===value | take / 否则 **skip** | 可读且判定 |

三态语义(**关键**):`take`=走边(强制派发后继);`skip`=已判定不走(该分支永不取,可剪枝);`unknown`=**此刻无法判定**(上游/字段不可读)⇒ 不走、不报错、保留重试,**绝不当 skip 静默丢后继**(宁可见挂起,不可静默丢—CLAUDE.md 不退条)。`skip` 与 `unknown` 必须可区分:dispatcher 对 skip 剪边,对 unknown 留挂起下轮再评(受既有重试预算约束)。
`evalEdgeCondition` 读 upstream 的 status/resultRef/fields **全走自有数据捕获**(ownVal,getter 无 descriptor.value ⇒ 视为不可读,**绝不调用不可信 getter**),整体 try/catch 兜底——任一读取/描述符陷阱抛错 ⇒ 统一 `unknown`,**绝不以异常或 skip 代替未知**(CR-P2-3)。顶层与叶层处理一致。

## ② 动态扇出(dynamic fan-out,Send 语义)

**数据模型**:
```
FanoutSubtask = { subtaskId: string; index: number; item: string }
FanoutPlan    = { subtasks: FanoutSubtask[]; total: number; capped: boolean; dropped: number }
```
`planFanout(template, items, cap?) → Res<FanoutPlan>`:一条模板任务按上游产出的 `items`(上游 TaskRecord 的**类型化字段**,`readonly string[]`——每项是串键/逻辑名,非自由对象)展开 N 个子任务。
- `template = { templateId: string }`(非空串;dispatcher 据此 + item 物化真实 TaskSpec,本纯核只出计划)。
- `items` 必须是真数组(`Array.isArray`),逐项 by-index 校验为串(trust-boundary);非串项 ⇒ 整体拒绝(仅校验被展开的前 N 项)。
- **上限** `cap`(默认 `SWARM_FANOUT_MAX`=8,防爆):`N = min(items.length, cap)`。超限**不静默丢**:`capped=true`、`dropped=total-N` 显式报出,dispatcher 可据此升级/调高 cap(不静默截断)。
- **确定性**(FC-6):同 `(template, items, cap)` ⇒ 同 `FanoutPlan`;子任务 id = `fanoutSubtaskId(templateId, index)` = `fan-` + `sha256(templateId \u0000 index)` 前 16 hex。**位置性**:id 只由 templateId+index 决定(不含 item 内容),同模板同序号恒同 id ⇒ 幂等派发;item 内容进子任务**输入**(由既有 inputBindingDigest 捕获内容变更触发重试),不进 id。契约要求 items **稳定有序**(上游须产出定序数组)。
- `fanoutMax(env)`:读 `SWARM_FANOUT_MAX`,整数 ∈ [1,1000] 才采,否则回落默认 8(坏值不致 0 也不致爆)。

## ③ 旗与接缝

- `conditionalRoutingEnabled(env)`:`SWARM_CONDITIONAL_ROUTING` ∈ `1|true|yes|on` 才 ON;**默认 OFF**(dormant-ahead-of-use,同 `forcePipelineEnabled`)。
- `SWARM_FANOUT_MAX`:默认 8,见上。
- **seam(本轮不接线)**:dispatcher/T3 在 force-dispatch 后继时,对每条 `ConditionalEdge` 先 `evalEdgeCondition(edge, 上游投影)`:take ⇒ 派发;skip ⇒ 剪枝;unknown ⇒ 留挂起下轮。对声明了模板扇出的节点,`planFanout` 出计划后按 subtask 物化 TaskSpec(id=subtaskId,input 绑 item)。映射 `AcceptedResult/TaskResult → UpstreamView` 亦在 IO 层。本模块只出纯决策,绝不碰盘/派发。

## 不变量(审查锚点)

- **FC-6 确定性**:evalEdgeCondition、planFanout、fanoutSubtaskId 纯函数,同输入恒同输出(无时钟/IO/随机/自由表达式);自测钉 1000× 一致。
- **FC-7 向后兼容**:无 `when` 的 force-pipeline/v1 边经 validateConditionalPipeline 产出 `{from,to}` 与 force-pipeline 一致;evalEdgeCondition 对无 when 边恒 take(= 旧无条件强制边行为)。
- **trust-boundary**(同 force-pipeline/task-plan/grill-gate):untrusted 整树校验或整体拒绝;ownVal 自有数据读一次捕获;数组 by-index 走(不走输入迭代器);枚举 proto-safe。
- **异常边界**(CR-R3-P2-1):validateConditionalPipeline 整体有异常边界——任何读取(schema/stages/边 from-to-when/谓词标量/knownNodes 槽)的描述符或 Proxy 陷阱抛错 ⇒ 返回 `{ok:false}`,**绝不外抛、绝不吞成 undefined 按无 when 放行**。与「accessor `when` ⇒ 无 when」区分:getOwnPropertyDescriptor 取访问器**不调用**它(⇒ 读为缺失=无 when),描述符访问**失败**则是捕获失败(⇒ 拒绝)。evalEdgeCondition 同样对不可读(含 Proxy 陷阱)统一返 unknown。
- **不静默丢**:unknown≠skip(保留重试);扇出超限 capped/dropped 显式报。
- **force-pipeline.ts 零改**(字节稳定,landed);本件纯加法。

## 交付物

- `docs/swarm/conditional-routing-brief.md`(本件,冻结)。
- `packages/bus/src/swarm/conditional-routing.ts`(纯模块)。
- `packages/bus/src/swarm/conditional-routing.selftest.mts`(FC-6/FC-7 独立自测)+ `packages/bus/test/conditional-routing.test.ts`(vitest)。
- dispatcher/T3 接线 = **下轮另单**。
