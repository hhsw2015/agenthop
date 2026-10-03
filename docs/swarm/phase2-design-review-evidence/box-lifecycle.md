# Swarm Phase 2：box 生存、checkpoint 与清理的独立设计审查

范围：固定方案 `plan.md`；只读参考 `e4eacdd:scripts/swarm-launch.sh`，已保存为 `swarm-launch.phase1.sh`。这是设计推导与源码核对，**不是故障实测**。未运行 SSH、分配、push、进程信号、窗口操作或 bus 消息，未修改项目。

## 结论

将生存触发从 dispatcher 移到 box 是合理方向，但“watchdog 给 TUI 发字，再由模型提交”不能支撑“dispatcher 全死也绝不丢数据”。必须把可程序化的 checkpoint、远端确认和最终清理做成可靠状态机；LLM 负责补上下文和协作提示，不应是保存已写文件的唯一执行者。不存在在 GitHub 持续不可达且 VM 必死时仍保证零丢失的实现，文案必须给出最后已确认 checkpoint 之后的损失边界。

## P1-1：watchdog 是独立的提示器，不是独立的保存器

可构造时间线：

1. T-6：worker 已写入大量本地改动，随后卡在一个长工具调用、模型请求或交互式子程序。
2. T-5、T-2：watchdog 的 `tmux send-keys` 均成功，只能证明键被投到终端；不能证明 Claude 将文本解析成新 turn，更不能证明 git push 完成。
3. T-0：watchdog 开始 scrub，或 provider 直接终止 VM；最近改动没有离开 box。

还有更直接的寻址问题：方案把 watchdog 放在同一 `swarm` session 的第二个 `watch` window，却发送到 `-t swarm`。它没有固定 worker 的 pane id；若活动 window 是 watch，提示可能打到 watchdog 自己的前台 bash，而不是 worker。新建 window 是否激活取决于实际 argv；方案没有约束，不能假设始终选中 worker。即便固定 pane，TUI 弹窗/子进程输入状态仍不受控制。

最小可靠修改：

- 启动时记录确切 worker `%pane_id`；使用文字输入与明确 submit，且把“已注入”和“已确认 checkpoint”分开。它仍只用来请求语义 summary。
- 独立的 box-local supervisor 按周期保存已落盘成果；不要仅在最后 5 分钟第一次尝试上传。保存动作必须有超时、重试、失败状态和远端 commit OID。
- deadline 前先停止接新任务，要求 worker 进入 quiesced 状态；只在执行者不再改写相关文件后制作最终一致 checkpoint。不能只靠“往 TUI 输入一句话”作为 quiesce 确认。
- watchdog 重启可根据持久状态重试未确认的保存；`alreadyFired` 不能将一次未被处理的提示视为完成。

这不要求一个全局中央控制器；每个 box 可以有自己的小 supervisor。没有网络或仓库权限时仍必须如实报告未持久化，不能承诺零损失。

## P1-2：T-0 无条件 scrub 可以主动删除未获远端确认的唯一副本

独立于上一项，即使 worker 正常响应：

1. T-2：worker 正在生成 WIP 或上传大对象；GitHub 请求发生重试。
2. T-0：上传未获成功响应，甚至只有部分对象传输；方案无条件删 clone 并终止 TUI。
3. 最后 checkpoint 不存在，或只存在更早版本。硬删除没有因“正在 handoff”而变得安全。

另一条边界：旧 worker 在 push C 后继续写出 D；dispatcher 仅看到新 worker `READY` 和发出 resume，就告诉旧 worker “handoff done”。若没有新 worker 对 **确切 checkpoint C** 的拉取/校验 ACK 与旧 worker 的 quiesce，可能删除 D，或新 worker实际并未加载 C。bus 的已投递不等于模型已执行恢复。

最小可靠修改：

- 定义 `QUIESCED -> CHECKPOINT_LOCAL(oid) -> CHECKPOINT_REMOTE_CONFIRMED(oid) -> HANDOFF_PENDING -> RESUME_ACK(taskId, attemptId, oid) -> RETIRED`，不要用自由文本 DONE/READY 代替各阶段。
- 接收方按 commit OID 恢复，不只按可能继续变化的 branch；checkpoint manifest 要把 goal/next 与该 OID 绑定。
- 明确两种关停原因：成功交接后的 retire（可清理）与到达硬截止的 expire（可能未保存）。expire 的“无条件删除”是保密优先的取舍，**不能同时宣称无数据丢失**；必须记录/通知 last confirmed OID 和未确认风险。
- 最终保存、重试、通知与清理分别留预算，不能把清理安排在 provider 实际销毁那一刻。

## P2-3：规定的 git 命令会在 clean 工作树时跳过必要的 push

确定性设计反例：worker 在本地已经提交 C，但还未 push；工作树 clean。到 checkpoint 时执行 `git add -A && git commit -m wip && git push`：`git commit` 因 “nothing to commit” 返回非零，后面的 push 不执行。没有提交者身份、hook 拒绝或 lock 竞争也会中断，但 clean + 未推送提交不属于异常任务。

最小修法：将“是否需要新提交”与“是否需要推送当前 HEAD”分开；有暂存差异才 commit，已有有效 HEAD 则仍执行受控 push 并验证目标分支的 OID。明确失败原因，不用 `commit || true` 吞掉索引损坏或 hook 错误。另说明 git checkpoint 只覆盖仓库内可纳入 Git 的文件：ignored 数据、外部输出和纯对话中的下一步不会被 `git add -A` 自动保存。需要的语义 summary 应进入同一 durable manifest，而非只通过 bus 发一次。

## P2-4：deadline 基准偏晚及 reused warm box 没有配置续接契约

Phase 1 源码在分配命令返回 `alloc-ok` 后才写 `date +%s > alloc-ts`。设 provider 在 t=0 创建 VM，网络响应到 t=45 才到本机，则 `alloc-ts+3600` 比真实到期晚 45 秒。再叠加 box 的 `date` 与 dispatcher 不同步，T-0 清理可能根本来不及执行。`/proc/uptime` 不可靠也不等于跨机 epoch 已经校准；方案未证明后者。

另外，现有复用路径会跳过 install；若 `swarm` tmux session 已存在，还会直接保留 warm TUI、不重新启动。新 env 不会追溯进入旧进程。若直接把新 deadline/token/repo/watchdog 注入新建分支，复用 Phase 1 warm box 就可能没有 watchdog/GITHUB_TOKEN；若对复用错误地使用本次 launch 时间，又会把剩余寿命重置到一小时。老 watchdog 与新任务若共享同一会话名/路径，还可能在旧 deadline 清理新任务。

最小修法：

- deadline 必须归属于不可变的物理 box incarnation，保留最早可信 allocation-start（或 provider 提供的 expiry），从预算里扣掉 provisioning、时钟误差及退出余量；不能每次复用延长。
- 握手报告 box 当前时间与 incarnation，检查时钟偏差；用当地单调时间跟踪经过的时间，避免后续 wall-clock 跳变延长寿命。没有可靠 expiry 时使用保守预算，并承认 provider 可提前终止。
- warm reuse 做生命周期能力/版本握手：watchdog 是否存活、它守护哪个 incarnation、有效 deadline/repo/branch/凭据是什么。缺少能力不能只因 tmux session 存在而声明生命周期 READY。
- 剩余预算不足时拒绝接新长任务并直接交接。固定窗口名称不应是清理归属证明；旧 watchdog 只能管理自己的 incarnation/attempt。

## P2-5：“不写 git config”和“杀两个窗口”均不足以保证无 token / 无痕

这项是保密边界说明与清理设计缺口，不声称本次观测到真实 token 泄漏。

- `git -c http.https://github.com/.extraheader="AUTHORIZATION: bearer $GITHUB_TOKEN" push` 确实不需要把令牌写进 `.git/config`，但 shell 展开后 secret 会进入 git 的进程 argv；短时可被同权限进程观察，也可能被诊断/trace 记录。环境变量本身同样不是隔离同 UID 进程的保密容器。
- Phase 1 当前 launcher 把展开后的 CPA token 拼到远端 `tmux new-session` 命令里；这说明“仅 env 注入”不能等同于“从未出现在其他表示”。tmux server 的环境/启动命令、CLI 会话日志、MCP 子进程及其他已继承凭据的进程，未必随两个 window 消失一并消失。
- 删除 clone、mcp.json、gh config、known_hosts 和 `/tmp/swarm-*` 不是对 agent 日志、tmux、其他临时文件、工作目录外输出的穷尽枚举。`git add -A` 也不会因为凭据最初来自 env 就阻止后续任务把它写入文件后上传。
- scrub 如果在 watch pane 内运行，先杀 `watch` 就可能杀掉正在清理的 shell，后面的删除根本不执行。方案未规定清理执行者独立于被清理对象。

最小修法：

- 用单独的 per-box runtime 目录与最小权限承载运行文件，明确关闭 shell tracing/秘密日志；将 git 鉴权从直接 argv 秘密迁移到专用凭据通道，并说明同 UID 仍可见的边界。不得把 argv 改成 env 就宣传绝对保密。
- cleanup 由生命周期 supervisor 在被管理的 tmux/CLI 之外执行，幂等处理每个步骤，最后结束自身；不要先杀自己的执行窗口。处理仍可继续写入文件的工作进程后才做最终删除。
- repo push 前至少排除明确的 runtime/config/credential 路径；不要把整个目录无差别 stage 当作无敏感内容证明。
- 真正的离机保障是短有效期、最小权限凭据及服务端到期/撤销；本地删除是尽力清理，不是抹除已复制令牌或撤销权限。用户已接受单 repo 泄漏范围，不应扩大为“无 traces”承诺。

## 最小验收矩阵（本轮未运行）

- worker 长工具调用/TUI弹窗、watch 成为活动 pane、提示已发送但无 checkpoint ACK。
- clean 工作树 + 未推送 HEAD；commit 失败；push 超时/断网；checkpoint 已远端确认但响应丢失。
- 新 worker 仅 bus READY、未拉取 OID；恢复 ACK 错 attempt/错 OID；旧 worker push 后继续写入。
- 在每个状态重启 watchdog；重复 T-5/T-2 不重复破坏状态，未确认动作可以重试。
- allocation ACK 延迟、跨机 clock 偏差、wall-clock 后跳、复用 Phase 1 warm box、复用时剩余寿命不足。
- scrub 从 watch pane 触发、运行中途失败、仍有持有凭据的子进程、清理重复调用；确认记录的结论是“哪些步骤完成”，而不是以命令成功推断“绝无痕迹”。

主审可以合并 P1-1/P1-2 的零丢失文案讨论，但两个修复面不同：前者消除 LLM/TUI 作为唯一保存执行者，后者为确切 checkpoint 与清理建立确认边界。
