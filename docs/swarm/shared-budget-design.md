# shared-budget pool — design one-pager v0 (DA2)

**owner 3e097dfe · status: DESIGN — 投协调者箱待批 · 借 `docs/research/docker-agent-eval.md` 轴成本+Q⑤ 立项② · 基线 main bdd93d7 · 分支 feat/shared-budget**

## 一句话
一个**具名预算池** = 一个上限、多消费者同抽:N 个并发消费者(fanout 运行 / 子任务 / 任意带票消费)引用同一池名,从**同一天花板**结算,fan-out 到 N 不会花 N 倍;**per-消费记账,池尽即停新派(在途不杀)**。是约束**跨运行总花费**的共享层,不替代 fanout 已签的**逐运行**票据上限。

## 为什么 (docker-agent 借 #2)
docker-agent `budgets` 共享池:「几个 agent 引用同一名字 → 从同一上限抽,而非各拿一份,所以 fan-out 到 N 个子 agent 不会花 N 倍」(schema v16 事实)。我方 fanout 的 `budget:{maxTokens,maxUsd}` 是**逐 run** 的(一张 S23/CPA 票),两个并发 run 各自不超额、合起来却可达 2×。缺的正是**跨 run 的共享天花板**。本件补这一层。它也是 R18「并发以 B_cons 为界」的成本面孪生:bandwidth-gauge 用失衡读数节流线程,shared-budget 用剩余额度节流新派。

## 两级预算(组合,不冲突)
| 级 | 归属 | 触顶行为 | 已有/本件 |
|---|---|---|---|
| 逐 run 断路器 | fanout 单请求 `budget` | 硬:**中止在途+未派单元**(超额即杀) | 已签(feat/fanout-native,勿动) |
| **共享池天花板** | 具名池,多 run/多消费者共享 | 软:**拒新派,在途不杀**(协调者令) | **本件** |

一次 fanout run 可同时受「自己逐 run 上限」与「所引用的共享池」双重约束;池是上层聚合,逐 run 票据不变。

## 核心语义
- **池 = 名字 + 天花板 + 已花 + 态**。同名=同池(多消费者共享一上限);异名=独立池。`PoolCeiling = { maxUsd?, maxTokens? }`(至少一维;到任一维即耗尽)。
- **准入(admission,派新前)**:消费者派新单元/新 run 前查池态:`spent < ceiling` ⇒ 放行;`spent ≥ ceiling` ⇒ **拒新派**(返回 `{exhausted, remaining}`,不抛)。
- **记账(accounting,实花后)**:单元/ run 完成后把**实际**花费 CAS 累加进池(LLM 花费只有响应后才知——同 bandwidth-gauge 读实发事件,不预估)。耗尽在**下一次准入**被看见 ⇒ 天然「在途不杀」。
- **幂等抽取**:一次记账按 `(poolName, drawKey)` 内容寻址——同 key 永不二次记账(照搬 fanout `runKey`「same key reuses, never re-spends」)。防重连/重试双记。
- **耗尽 ≠ 关闭**:耗尽是「拒新派」的瞬时态,池可被协调者加额(raise ceiling)复活;不删在途账。

## CAS(并发正确性是本件唯一硬点)
N 个消费者并发记账,**绝不能各自以为握有整条天花板**(否则就退化成 N× 的病)。池「已花」计数器走 CAS:
- **主案(单文件乐观 CAS)**:`~/.agenthop/budgets/<poolName>.json` 带 `version`;记账 = 读(spent,version)→写(spent+amount,version+1)经 **atomic temp+rename + version 校验**,冲突即重读重试(照搬 `control-store.ts` CAS 手法)。幂等:记账前先查 `drawKey` 是否已在 `draws[]`,在则 no-op。
- **备案(预留文件法)**:`budgets/<poolName>/draws/<drawKey>.json` 每抽一文件(O_EXCL 原子创建),`spent=Σ 文件`,耗尽=`Σ≥ceiling`。无单点写争用,代价是列目录求和(照搬 chat-room log/inbox 文件法)。
- 裁决①(下)定主/备。ENOENT=空池(全额可用);EACCES≠空(拒记账+拒准入,不回滚余额——照搬 store 纪律)。

## 投影(冻结读契约候选,gated on 批准)
一枚 console/协调者可读的小 JSON,落 `~/.agenthop/console/budget-pools/<poolName>.json`(与 `bandwidth-gauge/`、`decision-batches/` 并列),atomic 写:
```
{ "schema":"budget-pool/v1", "poolName":string, "generatedAtSec":number,
  "ceiling":{ "maxUsd":number|null, "maxTokens":number|null },
  "spent":{ "usd":number, "tokens":number }, "remaining":{ "usd":number|null, "tokens":number|null },
  "state":"open"|"exhausted", "drawCount":number, "consumers":[{ "id":string, "usd":number, "tokens":number }] }
```
(前端 3e097dfe:一条额度条 + per-消费者细目 + open/exhausted 色,照搬 bandwidth-gauge 防御式渲染。gated。)

## 架构(沿用 dual-bandwidth/chat-room 范式)
- **纯核 `packages/bus/src/swarm/shared-budget.ts`** + selftest:池状态机(open/exhausted)、`admit(pool, state) → {ok}|{exhausted,remaining}`、`applyDraw(state, {drawKey,usd,tokens}) → newState`(幂等)、耗尽判定、`project(state) → projection`。**纯**:无 fs/clock,喂进「当前池态 + 一笔抽取」,出「新态/准入判定/投影」。可纯单测(并发交错用序列化事件表模拟)。
- **IO `shared-budget-store.ts`**:CAS 读改写池文件 + 写投影 + `readPool`(console/测试)。ENOENT/EACCES 纪律同 store 族。
- **dormant**:本件**独立文件,不接线 fanout**(fanout 仍在审)。接点留注释缝:① fanout `applyDraw` 调用点(run 完成记账)+ `admit` 调用点(派 run 前);② bandwidth-gauge/R18 读 `remaining/state` 做节流输入。实际接线 = fanout 并库后另单。

## 设计律
池**度量+拒新派**以让协调者/调度**少派**;它绝不杀在途、绝不变审批跳板(同 bandwidth-gauge 设计律 DHH 18:51)。软节流,非硬闸。

## 接点(本件只留缝,不接)
① **fanout budget/ROI**(feat/fanout-native,已签逐 run 票据,勿动):fanout run 的 `budget` 之上叠一个可选 `pool:<name>`;run 准入查池、完成记池。本件提供纯核+store,接线留注释。
② **bandwidth-gauge/R18**:池 `remaining/state` 作为 R18 两级调度的成本面节流读数(额度近尽 ⇒ 少开线程),与失衡读数并列喂调度。

## DEFERRED(非 v0)
预留/悲观锁(预估上限预扣、完成反冲)· 跨池继承/层级预算 · 自动加额策略 · 多币种/多 provider 定价归一 · 历史曲线 · 实际接线 fanout(待其并库)。

## 协调者裁决(待批,design 卡在此)
1. **CAS 主案**:单文件乐观 CAS(简单、单池热点)vs 预留文件法(无写争用、代价列目录)——建议**单文件乐观 CAS 起步**(池数少、争用低),压测不够再切。
2. **超额容忍**:纯「实花后记账」有并发准入突发 overshoot(多 run 同时通过准入后才各自记账)。建议 v0 **容忍小 overshoot**(软池,拒新派即可),把悲观预留列 DEFERRED;若要零 overshoot 再上预留。定一个可接受 overshoot 比(如 ≤1 个在途 run 的上限)?
3. **耗尽维度**:maxUsd / maxTokens 任一到即耗尽(建议)vs 仅 USD 为准?
4. **投影落点**:`~/.agenthop/console/budget-pools/`(与 bandwidth-gauge 并列,建议)确认?
5. **加额(raise ceiling)**谁可做:仅协调者 / 票据内 user 预授权?(关乎耗尽后复活路径)

**批后实现序**:纯核 shared-budget.ts + selftest 先行 → store(CAS)→ 冻结投影契约 budget-pool/v1 → 前端额度条。全程 feat/shared-budget,独立文件 dormant,不动 fanout 分支。
