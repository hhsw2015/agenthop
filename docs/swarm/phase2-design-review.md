# Swarm Phase 2 生命周期架构对抗审查

日期：2026-10-02。结论：**职责拆分可行，但当前方案尚不足以支撑“无数据丢失、可自愈、幂等且受全局 cap 限制”的保证。建议先修下面的协议缺口，再实现。**

固定方案：`/Users/wowdd1/.claude/plans/encapsulated-wandering-crayon.md`，SHA-256 `4ad33a4ed545b621330aee7e71972593cc68a8868663b7352a07591b64422dac`。引用行号均对应该版本。只读参考 Phase 1 的 `e4eacdd`，没有把工作 checkout 当成目标版本。

## P1-1：box 独立触发提示，不等于 box 独立保存成果

位置：方案 19–24、65–70、89–92。

T-6 worker 卡在长工具调用、模型请求或终端交互；T-5/T-2 的 send-keys 均成功，但没有执行 checkpoint；T-0 删除工作目录或 VM 到期。两次提示和 `alreadyFired` 都不能证明一次保存完成。CPA/模型可用性、worker 健康、GitHub 可达性仍是依赖。T0 无条件擦除与“未上传成果绝不丢失”无法同时保证。

此外，watch 在第二个 tmux window，而目标仅写 `-t swarm`，没有固定 worker pane；活动窗口变化可能让提示投给 watch 自己。即便 pin `%pane_id`，mid-turn、选择框、前台子程序也不会因 literal text+Enter 就成为可靠 RPC。

建议：独立 supervisor 周期性保存可恢复成果，记录远端确认的 SHA、超时与重试；LLM 的提示用于补语义 summary，不能是保存文件的唯一执行者。最终一致快照前应停止接任务并协调暂停写入。触发通道优先采用 worker adapter 的结构化 request/ACK（本地 socket/control file 等），再由经验证的工具或 hook 接口协调语义 checkpoint；不能假定目标 TUI 存在可强制执行的中断接口。TUI 若保留，只是辅助触发，需 request id 和完成 ACK。能承诺的是“已确认 checkpoint 可恢复 + 明确的 RPO”，不是任意故障下零丢失；到期擦除应单独记录为 expire，而非成功 handoff。

## P1-2：缺少冻结与恢复确认，交接可能丢掉最后成果

位置：方案 44–45、68–72、80–84。

反例：旧 worker push C，随后继续生成 D；新 worker 仅加入 bus 达到 READY，dispatcher 发 resume 后通知旧 worker stop/scrub。新 worker 可能还没拉取 C，也可能稍后拉到另一个 branch tip；D 被删掉。T-5/T-2 两次 checkpoint 还会令旧 summary 与新 branch tip 对不上。

需要明确的交接屏障：旧 worker DRAINING/停止接任务 → 停止写入 → 最终 checkpoint 与恢复 manifest 被远端确认 → 新 worker 拉取并校验**不可变 SHA** → 持久化 `RESUMED(taskId, generation, successorId, SHA)` → 旧 worker retire。READY、消息投递成功、idle 均不等于恢复完成。若允许恢复后执行有外部副作用的步骤，任务级幂等键/所有权 generation 也必须随 manifest 传递，不能把双执行仅称为双分配成本。

checkpoint 的完成产物也需覆盖 DONE：当前 DONE 分支只要求 bus 回复，没有要求把最终结果/完成标记持久化。

## P2-1：重启恢复的输入不是持久任务队列，永久 claim 又会阻止接管

位置：方案 27–41、68–84；Phase 1 `relay.ts:50–66`。

当前 relay 每次 `startRelay` 创建 `ephemeralKeys()`，mailbox 与该密钥绑定。旧 dispatcher 收到的 DM、它的内存队列，以及发给它旧 pub 的消息，并不会自动成为新机器可重读的待办。“re-read unclaimed NEED HANDOFF”尚无可执行的数据源。即使 WIP branch 留存，goal/next/DONE/接管阶段目前仍可能只在 bus 文本中。

独立崩溃路径：D1 创建 `.claimed` 后、分配前崩溃；D2 永久跳过。或分配完成后、记录 successor 前崩溃；D2 无法区分应恢复既有 box 还是再分配。`/tmp/ah-rwkey-*/` 不是跨机器持久 inventory，另一台机器也不会自动拥有对应 key。

建议把 **pending manifest、checkpoint SHA、完成状态、claim owner/generation/租约、allocation attempt、successor 与恢复 ACK** 放进持久控制记录；bus 只作加速通知。启动时扫描非终态记录，必须包括过期 claim 和部分完成的分配。恢复凭据应在适当的秘密存储/原机器上管理，不能为了共享 inventory 把私钥放进 GitHub。控制状态也不应任由 worker 的 contents-r/w token 覆写；独立控制 repo 或受约束的写入主体可避免误破坏。

## P2-2：普通 branch push 不是唯一领取操作；硬 cap 也不能靠本地计数

位置：方案 33–34、76–84。

**本地实证**：两个 claimant 都先读到 ref 不存在，再把同一个 checkpoint OID push 到同一 `.claimed` 分支，两个操作均 exit 0，第二个为 `Everything up-to-date`。所以“push 成功”不证明自己赢了。普通 Git 的 fast-forward 更新同样不是 create-only 锁。

修复方向：claim 必须含唯一 owner/attempt；采用预期 ref 不存在或预期旧 OID 的原子条件更新，失败者重读。夹具中“不同 owner 提交 + expected-absent force-with-lease”确实只允许第一个成功。**这只解决领取的原子性**：还需上一项的租约/恢复，且远端分配 API 若不支持幂等键/fencing，Git CAS 不能把 allocation 外部副作用变成 exactly-once。失联/超时应记为分配结果未知并核对既有 attempt，而非马上盲重试。

cap 反例甚至不需要同一 handoff：live=2、cap=3，两 dispatcher 分别接到不同任务，都判可分配，最终为 4；跨机器只看自身 keydir 更会漏计。需原子预留 slot，计入 allocating、运行中和结果未知的分配；或者给机器划分总和不超过 cap 的固定额度。若接受重复 allocation，就不能同时声称硬全局 cap。满额时还需明确预留交接槽或等待旧 box 退役，不能把“通知 cap hit”当作自动恢复完成。

## P2-3：deadline 尚无可信寿命基准，warm reuse 也没有生命周期升级握手

位置：方案 20–21、62–66、76；Phase 1 `swarm-launch.sh:149,161–180`。

Phase 1 是收到远端 alloc-ok **之后**才记 alloc-ts，网络/分配应答耗时已经吃掉真实寿命；box wall clock 又是另一台机器的时钟。`alloc-ts+3480` 的 120 秒余量并不是误差上界。方案中 dispatcher 的 `+3600` 与 box 的 `+3480` 还需统一成一个明确的 expiration/safety-deadline 模型。

优先使用 provider 到期信息；没有则用保守的分配请求起点与有界误差预算，并验证 clock skew。注入后用经验证的本地单调计时维持剩余预算，避免 wall-clock 回拨延长工作时间；`/proc/uptime` 异常不自动证明所有单调计时都不可用。到期/过期启动应立即进入 drain，不能漏掉已经越过的阈值。启动、上传重试、接收方冷启动和清理均需预算。

寿命绑定物理 VM incarnation，reuse 不能重置它。现有 warm 路径跳过 install、保留旧 TUI；新 env 不会进入已有进程。必须检查其 watchdog 版本/活性、deadline、repo、凭据和 incarnation，不能只因 tmux session 存在就声明生命周期 READY。旧 watchdog 也只能清理它自己的 incarnation/attempt。

## P2-4：scrub 是尽力清理，不是“不落盘/无痕/凭据失效”保证

位置：方案 43–49、91–92；Phase 1 `swarm-launch.sh:182–186`。

`git -c ...extraheader="...$GITHUB_TOKEN"` 不写 `.git/config`，但 shell 展开后 token 在 **argv** 中。Phase 1 的 CPA token 也被展开到 tmux 启动命令。env 注入不能证明没有进程参数、CLI/MCP 转录、调试输出、tmux 环境/启动命令或其他副本；这些实际落盘点仍需验证。

杀两个窗口不保证所有继承凭据的后代退出，也不保证 tmux server 消失；若 scrub 在 watch pane 内运行，先 kill watch 会中断自己余下的删除。删 known_hosts 不能使认证凭据失效；rm 不能抹掉已复制的 token。fine-grained PAT 的注入方式也不会自动给它短寿命，共享 AGENTHOP_TEAM 可能比 VM 活得更久。

建议单独的运行身份/进程边界及私有 HOME/runtime 目录，supervisor 在待清理 tmux 之外执行幂等清理，先停止写入者再删文件、最后退出自己。git 鉴权避免在直接 argv 暴露 secret；同 UID 可读 env 的边界仍须承认。push 使用明确的产物范围，避免 `git add -A` 把运行凭据/日志一并入库。最终保障是短期、最小权限且可服务端到期/撤销的凭据；删除本地文件是补充手段。单 repo 泄漏范围已获接受，不等于无痕已成立。

## checkpoint 执行细节与验收

另一个确定性 P2：`git add -A && git commit -m wip && git push` 在“工作树 clean，但已有未 push 的本地提交”时，commit 非零使 push 被跳过。应把是否需新 commit 与推送/确认现有 HEAD 分开。ignored 文件、仓库外输出和模型内存也不在 Git 默认恢复范围内，必须明确产物契约。

建议最小状态链：

`RUNNING → DRAINING → CHECKPOINTED(SHA, manifest) → CLAIMED(owner, generation) → ALLOCATING(attempt, slot) → RESUMED(successor, SHA) → RETIRED`

租约超时与 `EXPIRED(lastConfirmedSHA)` 是独立分支。每个阶段应能从持久记录重建；ACK 需绑定任务、代次与 SHA，而非自由文本关键词。可用 GitHub 条件 ref 更新实现小规模协调，不必立即引入大型工作流系统；必须先规定持久事实与失败后的动作。

实现验收优先测：dispatcher 在每个阶段崩溃并换机器；claim 赢者崩溃；两 dispatcher 同任务/不同任务竞态与 cap；alloc 请求超时；TUI mid-turn/弹窗；checkpoint 上传失败；恢复 ACK 丢失；GitHub 断网直到到期；复用旧 warm box；跨机时钟偏差/回拨；scrub 自身不中断。只测 thresholds/canAllocate/parse 加 happy-path SSH 冒烟覆盖不到上述问题。

## 已做验证及局限

- 已完整读取固定方案，核对 Phase 1 的 launch、relay 与相关脚本；主仓库未改。
- 本地隔离 bare Git 测试：普通同 OID claim 两者成功；不同 owner 的 expected-absent 更新第二个被拒。结果：`/tmp/ah-swarm-lifecycle-design-review/claim-probe.json`。
- 其余为设计故障时间线与源码推导，**未进行 Railway/CPA/GitHub live 操作，也未控制任何用户进程或窗口**。本地 Git 的 CAS 测试不是 GitHub 权限/branch protection/E2E 的实证。
- latency 部分的 warm mailbox 思路合理，但没有在本轮重新测量 11–12 秒，亦未验证目标模型对 thinking-budget 环境变量的支持；这些不影响上述生命周期结论。
- 独立复核使用 fable-mode 的分阶段/并行审查流程；证据与子审查见 `/tmp/ah-swarm-lifecycle-design-review/`。
