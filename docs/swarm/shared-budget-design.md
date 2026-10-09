# shared-budget pool — design + v1 (DA2)

**owner 3e097dfe · status: APPROVED (DA2, 5 裁已定 2026-10-09) · IMPLEMENTED (feat/shared-budget, dormant) · DA2-R1 返修已折入 · 借 `docs/research/docker-agent-eval.md` 轴成本+Q⑤ 立项② · 基线 main bdd93d7**

## 一句话
一个**具名预算池** = 一个上限、多消费者同抽:N 个并发消费者(fanout 运行 / 子任务 / 任意带票消费)引用同一池名,从**同一天花板**结算,fan-out 到 N 不会花 N 倍;**准入计入在途、池满拒新派、在途不杀**。是约束**跨运行总花费**的共享层,不替代 fanout 已签的**逐运行**票据上限。

## 为什么 (docker-agent 借 #2)
docker-agent `budgets` 共享池:几个 agent 引用同一名字 → 从同一上限抽,fan-out 到 N 不会花 N 倍。我方 fanout 的 `budget:{maxTokens,maxUsd}` 是**逐 run** 的,两个并发 run 各自不超额、合起来却可达 2×。缺的正是**跨 run 的共享天花板**。它也是 R18「并发以 B_cons 为界」的成本面孪生。

## 两级预算(组合,不冲突)
| 级 | 归属 | 触顶行为 | 来源 |
|---|---|---|---|
| 逐 run 断路器 | fanout 单请求 `budget` | 硬:中止在途+未派单元 | 已签(feat/fanout-native,勿动) |
| **共享池天花板** | 具名池,多消费者共享 | 软:**拒新派,在途不杀** | **本件** |

## 核心语义(DA2-R1 返修后)
- **池 = 名字 + 天花板 + 已花(committed draws)+ 在途(reservations)**。同名=同池;异名=独立池。`PoolCeiling = { maxUsd?, maxTokens? }`,至少一维,到任一维即耗尽(裁③ fail-closed)。
- **准入 = reserve(派新前,锁内写)**:消费者派新单元前 `reserve(reserveKey, 估额=该单票面额, pid)`。判据 `committed + inflight >= ceiling ⇒ 拒`(裁 A)。放行则把该估额计入在途。**这是本件的 overshoot 上界凭证**:只要 spent+inflight<ceiling 才放行,唯一溢出就是「压过线的那一张票」⇒ 上界 = ceiling + 单票最大面额,**与消费者数量无关**(修 SB3:旧版准入只读 spent,10 个消费者可并发全放行=无界)。
- **记账 = commit(实花后,锁内写)**:单元完成后 `commit(drawKey, reserveKey, 实际花费)` ——移除该 reservation(在途减)、记入实花(committed 增)。实花可小于估额。幂等 by `drawKey`。
- **在途回收(settle 非 refund,修 SB3/R2+R3)**:crash/超时的 reservation 由 `settleExpiredReservations` **标记 `settled`(估额仍计入在途责任),绝不删除、绝不退款、绝不转成 draw**(删除会退回 vanished 单元可能已花的额度=重开无界超支;转成 draw 会让内部键混入真实 drawKey 去重空间)。每条 reservation **单次活性采样**判定(避免两次采样让责任落空),已 settled 的不再重判(幂等)。pid-liveness 为主 + TTL 3600s 兜 pid 复用。真单元若仍活,日后 `commit` 以实际额**对冲**(移除该 reservation + 记真实 draw);若真死,则估额作为保守上限长留。`commit` 只移除**本消费者自己**的 reservation(open 或 settled 皆可,consumer 绑定),且对已提交的 drawKey 为纯 no-op——重放或跨消费者提交都不会抹掉他人责任。
- **幂等**:reserve by `reserveKey`、commit by `drawKey`,内容寻址(照搬 fanout runKey)——重连/重试不双记。
- **耗尽 ≠ 关闭**:耗尽是拒新派的瞬时态;协调者可加额复活(裁⑤)。

## CAS / 并发(修 SB1、SB5)
- **单文件乐观 CAS + 持有者身份锁**:池状态一个 JSON 文件,所有变更在**每池锁**下读改写(atomic temp+rename)。锁 = atomic `mkdir <name>.lock` + 内部发布 `<pid>.<nonce>` 身份文件。
- **破锁仅凭持有者 pid 死活**(修 SB1):`process.kill(pid,0)` 判死才破;**绝不凭锁龄破锁**(旧版 >10s 即删→暂停的活持有者的已确认扣额被覆盖=丢钱)。未知/空的外部锁一律争用,不偷。释放前核验锁仍属自己。
- **池名先验后动**(修 SB5):每个公开写入口 `acquireLock` 第一步 `assertName`,**任何文件路径拼接/操作之前**——非法名(如 `../../x`)绝不在预算目录外创建/回收/删除锁。
- **fn 异常直抛**(修 SB4):锁竞争处理全在 `acquireLock` 内;临界区 `fn()` 在其后独立 try/finally 运行,其 EEXIST 不再被误吞成锁竞争。

## 账本完整性(修 SB2)
- **缺失 ≠ 损坏**:`ENOENT ⇒ null(真缺失)`;**不可解析 / 校验不过 / 正文池名≠请求名 ⇒ 抛**。坏账本**绝不当缺失**(旧版坏 JSON→当缺失→createPool 重建满额=凭空再授额)。
- **全量值校验**:`resolveCeiling`(正数、至少一维、tokens 整数)+ draws/reservations 值校验(非负、整数 tokens)——双空上限 / 负支出 / 非有限上限一律拒。
- **正文身份绑定**:正文 `poolName` 必须等于请求名 ⇒ 大小写不敏感文件系统的别名(`Shared` vs `shared`)跨池被拒。

## 投影(冻结读契约 budget-pool/v1)
原子写 `~/.agenthop/console/budget-pools/<poolName>.json`(裁④,与 `bandwidth-gauge/` 并列)。**每次变更都重写投影**(含幂等重放)⇒ 修 SB4:先前投影写失败后,重放会把投影收敛回已提交账本。
```
{ "schema":"budget-pool/v1", "poolName":string, "generatedAtSec":number,
  "ceiling":{ "maxUsd":number|null, "maxTokens":number|null },
  "spent":{ "usd":number, "tokens":number },      // committed
  "inflight":{ "usd":number, "tokens":number },   // reserved-but-not-committed (estimates)
  "remaining":{ "usd":number|null, "tokens":number|null },   // ceiling - spent - inflight, >=0
  "state":"open"|"exhausted", "drawCount":number, "reservationCount":number,
  "consumers":[{ "id":string, "usd":number, "tokens":number }] }
```
(前端 3e097dfe:额度条 + 在途段 + per-消费者细目 + open/exhausted 色,防御式渲染。= 后续 OpenDots console 切片,非本 agenthop 单。)

## 架构(沿用 dual-bandwidth 范式)
- **纯核 `shared-budget.ts`** + selftest:`reserve/commit/applyDraw/settleExpiredReservations/isExhausted/raiseCeiling/project`,loud 校验,无 fs/clock(时间戳/liveness 注入)。
- **IO `shared-budget-store.ts`**:持有者身份锁 + CAS 读改写 + fail-closed 读 + 投影原子写。
- **dormant**:独立文件,**不接线 fanout**(feat/fanout-native 仍在审)。接点①fanout:派 run 前 `reservePool`、单元完成 `commitDraw`;②bandwidth-gauge/R18:读 `remaining/state/inflight` 作成本面节流读数。实际接线 = fanout 并库后另单。

## 设计律
池**度量+拒新派**以让调度**少派**;绝不杀在途、绝不变审批跳板(同 bandwidth-gauge DHH 18:51)。软节流,非硬闸。

## 协调者裁决(已定 2026-10-09,全部折入上文)
1. **CAS 主案** = 单文件乐观 CAS(持有者身份锁,与 decision-batch 同族)。
2. **超额容忍** = 记账滞后的**有限**溢出,上界在 admit 处可证(reserved-in-flight);非准入侧无界(裁 A,修 SB3)。投影如实显示 `spent>ceiling`,不隐藏。
3. **耗尽维度** = maxUsd / maxTokens 任一到即耗(fail-closed)。
4. **投影落点** = `~/.agenthop/console/budget-pools/`(与 bandwidth-gauge 并列)。
5. **加额** = 仅协调者(钱门族,R16 三门:成员/票据不自授;`raisePoolCeiling` 的门在调用方/调度层)。

## DEFERRED(非 v0)
悲观预扣的精确反冲 · 跨池继承/层级预算 · 自动加额策略 · 多币种/多 provider 定价归一 · 历史曲线 · draws[] 压实(长活池的审计条目增长)· 实际接线 fanout(待其并库)· 前端额度条(OpenDots console 切片)。
