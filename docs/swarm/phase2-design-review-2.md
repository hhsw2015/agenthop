# Swarm Phase 2 v2：聚焦二审

日期：2026-10-02。范围：固定的 v2 方案，以及请求中提出的 `sleep N; elapsed += N` 计时实现；未审尚在实现的 `control.ts`。

**结论：v1 的修正方向已进入 v2，但还不能判协议闭合。最关键的是 lease 不会自动隔离旧实例的外部动作、sleep 累加不是经过时间，以及 EXPIRED/未知分配/CONTROL 写入权限的恢复边界。**

快照：`/tmp/ah-swarm-lifecycle-design-review-2/plan.md`，SHA-256 `d4b05bfd82b6e3b9fcc0ca4a8a8b744ff287a43e8ac5e869c7c1584f0338d478`。以下行号均对应该快照。

## P1-1：CAS + lease 保护控制记录，不能单独保证旧 dispatcher 不再产生外部副作用

对应问题 2；方案 18–20、29–35。

可构造序列：

1. A 持有 generation 7，CAS 写下 ALLOCATING(attempt X)，在发 SSH 分配前暂停。
2. lease 到期，B CAS 接管为 generation 8。
3. 如果 B 把旧 attempt/slot 当作失效并重新分配，A 随后恢复，仍会执行已经决定的旧 SSH 动作。
4. A 最后的控制记录 CAS 即使被拒，也撤销不了已创建的 VM。类似问题也适用于发给 worker 的旧 resume/retire 命令。

“每次动作前再读一次 lease”仍有 read→act 间隙。single-active 是需要实现或外部保证的条件，不会因为计划只运行一个实例而自动排除 restart-vs-stale-instance。每任务 claim 也不等于全局 dispatcher owner：两个实例可能分别操作不同任务。

最小要求：

- 全局 owner/generation 与每个任务/attempt 的 ownership 明确分开；所有状态更新验证 owner/generation、预期状态及 expected OID。lease 需要续租/失效后的动作规则与时钟假设。
- allocation attempt 和 capacity reservation 在**同一个 CAS 提交**里落盘，再执行 IO；不因 lease/网络超时就释放未知分配的 slot。结果未知必须 reconcile 原 attempt，而非盲重试新 attempt。
- resume/retire 等命令携带 task、generation、attempt、VM incarnation、checkpoint SHA；目标执行端必须拒绝已被取代的命令。idempotency key 只有被执行端使用才有效。
- 对外部分配，要么 provider/实际执行端支持幂等与隔离旧 owner，要么接管前能外部确认旧实例已被停止/失去执行能力。否则需在“旧 owner 是否还能执行未知”时暂停新分配，或明确接受重复/容量风险；**不能宣称 Git CAS 已实现外部 exactly-once 或气密单活**。

这些不要求自建共识系统；它们是把 Git 里的所有权延伸到实际 IO 的必要契约。IO 边界未确定前，纯函数测试最多证明控制记录不被旧 CAS 覆盖。

## P1-2：sleep-accumulator 会晚于真实寿命，不能作 deadline 的单调时间源

对应问题 3；方案 40–43、59–62。

`sleep N; elapsed += N` 只累计请求睡眠的时长，漏算调度延迟、git push、文件扫描、重试、进程暂停。它的计数可单调增加，却不是实际经过时间；低估误差没有由该算法提供的上界。

本地隔离探针：5 次 sleep(0.01)，每轮另有 0.04 秒模拟工作。累加值 **0.05 秒**，实际 monotonic 经过 **约 0.282 秒**；对于 0.15 秒 deadline，算法判未到期，实际已到期。这不是 Railway 真机测试，但足以反驳算法本身。结果在 `timer-probe.json`。

选择：在 Linux box 上验证 `clock_gettime(CLOCK_BOOTTIME)`，可通过 Python/小 helper 读取；它比累加 sleep 合适，并包含系统 suspend 的时间。还需验证目标 VM 的实际暂停/虚拟时钟行为。`/proc/uptime` 被伪造不自动说明该 syscall 也失真。若只能使用 CLOCK_MONOTONIC，须说明 suspend/暂停是否计入与 provider TTL 的差异。

注入的是扣除分配、准备、传输耗时和误差预算后的 remaining budget；持久化同 incarnation 下的本地绝对 deadline，supervisor 重启/reuse 不得重新获得完整预算。读取真实时钟后，计时循环仍不能被同步 git/网络操作无限阻塞：限时 IO 与 deadline 监视分开执行。

方案称“supervisor-independent near-death push”，但组件描述把它放在同一个 supervisor 中。若实际意思是 worker-independent，应更正；若要承受 supervisor 自身故障，当前组件还未提供这条独立路径。

## P2-1：状态链还缺恢复语义，尤其不能把 VM EXPIRED 等同于任务结束

对应问题 1；方案 24–28、32–36、64–65。

不一定要增加很多 enum，但至少要显式保存这些事实和边：

- **DRAINING 超时/失败**：不能等到永远，也不能把仍在变化的文件标为最终 quiesced checkpoint。若无法完成 final drain，保留 lastConfirmedSha；VM 到期后任务仍 NEEDS_RESUME，而非谎报完成交接。
- **ALLOCATION_RESULT_UNKNOWN**：请求发出但响应丢失、dispatcher 崩溃，均与“没创建 VM”不同。保存 attempt、可恢复的资源寻址/凭据引用、reservation 和已知寿命信息；恢复原 attempt，不能无条件释放再申请。
- **successor 在 RESUMED 前死亡/超时**：旧方保持未 RETIRED，原 SHA 保留；确认失败/实际到期后再替换 attempt，旧 ACK 必须因 attempt/generation 不匹配被拒。失去心跳不等于资源已不存在。
- **successor 在 RESUMED 后死亡**：ACK 持久化时，应已有 successor 的 RUNNING/恢复记录、继承的 SHA 和任务身份。否则旧方 RETIRED 后，恢复扫描可能再无未完成任务可处理。
- **EXPIRED(lastConfirmedSha)**：这是 source VM 的终态，不是未完成工作的终态。若启动只扫非终态记录，dispatcher 停机期间过期的任务会永久漏掉。需分开 task 与 VM 状态，或至少保留/扫描 `EXPIRED && workPending`。
- **DONE**：只有结果及对应完成事实持久化才是任务终态；VM 是否清理、capacity 是否释放是另一事实。lease-timeout 改所有权，不应抹除 checkpoint/attempt/reservation，也不应把任务倒退回无副作用状态。

cap 的“一个 counter”还需以可恢复的 reservation/资源记录为依据；counter 更新与 attempt/slot 状态必须原子且幂等。交接时旧 VM 和 successor 都占容量。**停止工作用的保守 deadline（例如 58 分钟）并不证明 60 分钟 VM 已销毁**，不能凭该时间释放 physical-box slot。应区分安全工作截止与“资源肯定已结束”的依据；否则虽没有并行 dispatcher，也会少算 VM。

## P2-2：CONTROL repo 的独立写入权限没有落地，当前两种描述互相冲突

对应问题 1、5；方案 24–25 对比 59–67。

方案规定 CONTROL 由受限身份写、worker token 无权修改；但又要求 box supervisor 在 dispatcher 不可用时直接把 confirmed SHA 写到 CONTROL，并要求 successor 持久化 RESUMED。launcher 只描述 work-repo token 和 control-repo coordinates，没有定义谁有权完成这两种写入。

- 如果 box 没有该写权限，成功 push 的 checkpoint 可能无法登记到恢复扫描的数据源。
- 如果把普通 CONTROL contents-write token 放进与 worker 相同 UID/权限域的 supervisor，private runtime dir/askpass 并不能阻止 worker 读取它；“worker 不能改控制记录”就不成立。Git ref CAS 只提供并发条件，不提供按字段授权。

可采用较小的边界：box 只向自己有权写的 WORK/receipt 空间发布带 task、generation、request-id、SHA 的持久不可变 receipt；dispatcher 扫描已登记的 receipt 位置、验证后 CAS 推进 CONTROL。bus 仅通知。这样 dispatcher 离线时成果及恢复证据仍能保留；控制状态暂时不推进是诚实的可用性限制。另一选择是受限外部写入服务或真正隔离的 supervisor 凭据域，验证操作及字段权限。不能只靠“不同 token 名称”声称隔离。

无论哪种方案，都需规定 push 成功但 CONTROL 更新/ACK 丢失时，重启如何通过 receipt 恢复，不能让最后确认只活在即将销毁的 box 内存里。

## P2-3：control file 可以用，但 request-id + ACK 还缺快照与重放契约

对应问题 4；方案 14–17、37–39、59–62。

不要求换成 socket；文件通道足够。需要以下约束：

- 要么单请求在途，未收到 ACK 不覆盖 request；要么每 request-id 独立文件的有界 spool。用 temp+rename 发布完整请求和 ACK，schema/大小/路径校验，绑定 incarnation/generation/kind/序号。
- 同一 request 的重试返回**同一个已确认 SHA/结果**，不能在几秒后重读变动工作树却仍当作该 milestone 的相同 ACK。push 后、ACK 前崩溃应从持久 receipt 恢复。
- worker 发 milestone 后要有一致快照的边界：短暂暂停写入直到 snapshot captured，或提供已经固定的 snapshot。否则 supervisor staging 时 worker 改多个文件，可能得到从未对应任何完整阶段的混合版本。snapshot captured 与 remote-confirmed 是不同事件。
- milestone、T-5/T-2、final-drain checkpoint 共享一个串行 checkpoint writer；不能并发争用 worker index/refs，也不能让较旧请求把 confirmed SHA/manifest 回退。最终 checkpoint 固定后，普通 milestone 不得重新打开写入阶段。
- completion ACK 必须意味着约定的远端成果及可恢复 receipt 已确认；失败给出明确结果和重试边界，不能用“已收到请求/本地 commit 已成”冒充完成。

RPO 措辞也需改成 **“最后成功确认的 checkpoint 之后的工作可能丢失”**。发出 milestone 或走到 T-5 不是确认；上传失败时不能承诺“最多丢到最后 milestone/T-5”。milestone-based 本身不提供固定分钟数的损失上界，这与用户已选的策略并不冲突。

## 凭据、scrub 和产物：方向通过，保留三个具体条件

对应问题 5；方案 44–53、59–63。

1. **askpass** 能消除直接 token-in-argv，但现在有意生成了凭据文件；应创建即私有权限、路径不在产物范围、关闭 trace/credential-store 等另存路径，限制凭据用途并按退出/到期清理。需要同时改掉 Phase 1 展开 CPA token 到 tmux 命令的路径。不能又恢复“没有秘密落盘”的说法，同 UID 可见的边界已正确承认。
2. **supervisor 位置仍有文字冲突**：“outside cleaned tmux”与“separate tmux window sup”未说明是否同一个 session/server。如果 sup 在将被 kill 的 session 中，问题仍在。最清楚的实现是 supervisor 在被管理 tmux 之外；或限定精确 worker pane 清理且绝不杀包含 sup 的 session/server。先让所有写入者真正停止，再删产物，最后退出 supervisor；EXPIRED 的强制保密清理与成功 RETIRED 是不同原因。
3. **tracked-only 会漏掉正常新增文件**：新建源码/测试在 git add 前是 untracked，也已写盘。若这是有意契约，必须要求 worker 在请求 checkpoint 前登记新成果；否则用显式允许的产物目录/manifest 纳入新的文件。不能把“所有写盘成果可恢复”和“仅 tracked”混用。commit/push 分离方向正确。

## 给 control.ts 的重点时间线（本轮未执行其代码）

建议优先加入以下契约测试，并把外部 action acceptance 作为独立模拟目标，不只 mock CAS 成败：

1. A 写 ALLOCATING 后暂停 → lease 到期 B 接管 → A 恢复发旧 IO；slot 不得复用，旧命令的执行端隔离需有证据。
2. allocation 成功但响应/登记丢失 → 重启能找回同 attempt；unknown 不作为零占用。
3. DRAINING 卡住 → box EXPIRED → dispatcher 隔天启动仍能找到未完成任务及 lastConfirmedSha。
4. successor 在 ACK 前/后死亡 → 旧 SHA 不丢、未完成任务不消失、旧 attempt ACK 不满足新 attempt。
5. push 成功、receipt/ACK 返回前崩溃 → 重试获得相同 request-id 的同一 SHA；不同 checkpoint 请求不会倒序覆盖。
6. 旧 VM 到工作截止但物理 VM 未销毁 → cap 不提前释放；重复 DONE/RETIRED 不能重复减 counter。
7. supervisor 重启、循环 IO 卡住或被调度延迟 → 不能延长同 incarnation 的剩余寿命。

## 验证范围

已读取并固定整个 v2，运行了本地 sleep 累加反例（约 0.3 秒、无进程信号），其余为明确的设计时间线与契约审查。未读取/执行正在编写的 control.ts，未操作 VM、GitHub、实际 tmux 或用户会话。CLOCK_BOOTTIME 在目标 Railway VM 的语义、实际凭据隔离和 IO fencing 仍需后续验证；这里没有把建议当成已经闭合的实现。
