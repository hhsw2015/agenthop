# long-run-liveness — 让蜂群能无人值守长跑(事故 2026-10-16 根治单)

> user 定性:「决定了能不能长时间运行,非常严重的 BUG」。本 brief 是设计先行稿(铁律 7),冻结后拆码单。源:PROGRESS #1094、`~/.agenthop/carly/incident-2026-10-16-overnight-stall{,-reply}.md`。

## 0. 事故一句话
01:08-07:37 全体空转 6.5h:协调者把 harness 的工具拒绝误当 user 暂停而停摆;Carly 心跳因清单里的 sleep/wait 超 3min 被 Tern 标 paused;两看门狗同夜失效,成员交付完无人合表派单。另:dispatcher 从 Tern 席重启继承 `TERN_PANE_SOCKET` 使 `tern` CLI 挂住,bridge 噪音 2794 行。

## 1. 不变量(写进 coordinator / swarm-member 技能与 CORE)
- **I1 推进度 ≠ 存活**。判「协调者健康」必须看推进度:`coordinator-handoff.md` mtime、PROGRESS.md 末周期时间、角色箱 unclaimed 数。beat 只证进程活。
- **I2 工具拒绝 ≠ 用户暂停**。user 的暂停只来自 user 正文(或 Carly 转述并带原话)。harness/权限层拒绝一条调用 ⇒ 换路径或记 nit 继续,**绝不**停整个周期。夜间授权期尤其如此。
- **I3 看门狗不得阻塞**。任何 heartbeat / patrol / sweep 检查 = 纯文件读 + 常量时间;禁 sleep、禁等回应、禁 spawn 外部 CLI 超 1s。要等的事交给下一轮。
- **I4 子进程 env 白名单**。dispatcher / sweep / 任何从席位里起的长跑进程只继承显式列表(HOME/PATH/AH_HOME/SWARM_*/CPA_*),剔除 `TERN_*` `HERDR_*` `CLAUDE_*`;recipe 记录「净化后」的 env。
- **I5 三方互盯**。协调者、Carly、dispatcher 三者互为哨,任一检测到另一方「存活但 >2 周期无推进」⇒ 升级到 user 可见面(TG/L0 文件 + 面板 alert),不只投协调者箱。

## 2. 修法(五线,各自可独立并)
| 线 | 内容 | owner | 门 |
|---|---|---|---|
| L1 协调者 | coordinator SKILL §1 加 I2 原文;§1 周期例程末尾加**空转自检**:若本周期零派单零合并且角色箱有 ≥1 真信 ⇒ 必须处理或写明原因;memory `feedback-refusal-is-not-pause` | Platform Dev(skill)+ 协调者(memory) | 文档票;skill 行 hash |
| L2 Carly 侧 | 心跳清单改纯文件判断(beat 新鲜度 / handoff mtime / PROGRESS 末周期 / 角色箱 unclaimed),零 sleep 零 wait;patrol 任务 82 重新启用并按 50ms 预算分任务(每任务 ≤3 pane),check 自记 ms 并在超 40ms 时自降 pane 数;心跳失败三次 ⇒ 写 `~/.agenthop/carly/alerts/heartbeat_failed-*.json`(L0,dispatcher 扫) | Carly(她自提待办 1、2) | 她在干净空闲窗实测 10 轮心跳 <60s 且无 abort |
| L3 dispatcher | **前提修正(Infra Dev 实查 l3-tern-env-finding-8a53f4e8.md)**:`tern ls` 对 TERN_* 不敏感;挂住的是 01:08 当时 Tern 插件 hook 被 disabled(归 L5)。L3 改为:所有 tern 调用走一个 helper;**保留 TERN_PANE_SOCKET**(mirror 命令从面板外找 daemon 需要它);剔 TERN_PANE(指向死块)/TERN_WINDOW_*/TERN_PROMPT_*/CLAUDE_*/HERDR_PANE*;timeout 3s→1.5s;连续 3 次 UNKNOWN 退避 60s 一探一行;recipe 记净化 env;runbook ③ 白名单含 TERN_PANE_SOCKET。另:seat-presence 解析接受 `--session-id=<sid>` 整词(轮换出的干净席无 --resume) | Infra Dev(fix/dispatcher-env-and-presence) | 门见 finding 文件;presence:四个干净席现网全部解析到 |
| L4 dispatcher 哨 | 新 sweep 步 `coordinator-progress-watch`:读 beat + handoff mtime + PROGRESS 末周期 + 角色箱真信数(排除 observer);beat 新鲜 ∧ (handoff >2h ∨ 真信 ≥3 且最老 >1h)⇒ `S19 coordinator-stalled`:投协调者箱 **且** 写 L0 alert **且** `tern send` 协调者块一行唤醒 **且** TG 入口(已有旗)。同样对 Carly:carly-patrol.beat >30min ⇒ alert | Infra Dev | 夹具:伪造 handoff 3h 旧 + 箱 5 真信 ⇒ 三路告警;正控:正常周期零告警 |
| L5 bridge | mirror 定时器链自愈:sweep 发现 tick 不进 ≥3 轮且 reload 防抖已过 ⇒ 允许一次 reload;插件侧 timer_fired_at 超 60s 自重 arm | Platform Dev(桥) | 现网:杀定时器 ⇒ 2 轮内 tick 恢复 |

## 5. 角色无关性(user 2026-10-16:「不能依赖 Platform Dev 这个角色,其他项目可能没有」)
修法只落在三个**不绑角色**的地方:① coordinator SKILL(任何项目的协调者都加载;§1b 拒绝≠暂停)② dispatcher(无模型、常驻、随 agenthop 二进制走;L3/L4/L5/L6/L7)③ Carly(可选第三哨;没有她时 ①② 仍成立)。§2/§6 的 owner 列是**本仓这次谁来写码**,不是机制依赖——换项目换编制,机制不变。成员侧同理(swarm-member SKILL 授权链一节,角色无关)。

## 6. 第二轮缺口(2026-10-16 09:5x 复盘发现;立项 L6/L7)
| 线 | 内容 | 本仓执行席(非依赖) | 门 |
|---|---|---|---|
| L6 dispatcher 自拉起 | dispatcher 是所有哨的根,自己死了无人管(昨夜 disp-80614 挂住 6h 无人重起)。**不用 launchd、不开机自启、不写系统目录**(user 2026-10-16:「尽量少改系统的东西」)。改为用户会话内看护循环 `swarm-dispatch-supervise`:按 recipe 的 argv + 净化 env 起 dispatcher,退出 3s 后重拉;`dispatcher.stop` 哨兵文件 = 干净停(runbook ③ stop 先 touch 再 kill,start 先 rm);锁被活 pid 持有的退出 ⇒ 循环自退不空转。由协调者按 runbook ③ setsid 起;重启机器不自动回来 —— handoff §恢复第 5 步让协调者核缺则起。配套:Carly 心跳加 `kill -0 $(cat dispatcher.lock)` 不活 ⇒ L0;coordinator skill §1 周期例程核 dispatcher pid | Infra Dev | 夹具:`kill -9` ⇒ ≤5s 新 pid 持锁、sweep 行续写;touch stop + kill ⇒ 不重拉;双起 ⇒ 后者退出 |
| L7 审查席停滞自处理 | 审核是流水线上的卡点,不能靠协调者手工盯 transcript:席位箱内有信 >10min ∧ transcript 无新 assistant 行 ⇒ dispatcher 按席位通道再唤醒一次(claude ACP:bus/箱 flush;codex 主线程:tern send 直注);再 10min 无效 ⇒ S19 + 投协调者箱「补声或改派」;协调者收到即**自己补第二声**(作者≠审者仍守)或改派,不等 | Infra Dev(dispatcher)+ 协调者(skill §3 一行) | 夹具:伪造审查席 idle 12min + 箱 1 信 ⇒ 恰一次唤醒;再 12min ⇒ 恰一条 S19;活跃席零动作 |
| L8 协调者自继任(无人值守的最后一环) | **今天**:协调者死/卡,dispatcher 的 succession 只「分配继任箱」(allocateSuccessor → swarm-launch --allocate-only),**没有任何东西起继任席**;runbook 还写「协调者自身轮换 = user 点头」。user 2026-10-16:「必须可以达到无人值守,还能持续推进」⇒ 改为:dispatcher 判定协调者 **dead**(presence pid 不活 ∧ beat >15min)或 **stalled**(L4 判定持续 >2 周期且两次唤醒无效)⇒ 按 roster 的 Manager 行**自动起继任席**(`tern new tab … tern acp claude --mode bypassPermissions --model …`,干净会话,不 --resume 死会话)+ 交接单 = coordinator-handoff.md(它本来就是为此写的)+ 开场一句直注「你是继任协调者,读 handoff」;旧席 `tern close`;角色箱地址不变(c5beaa7c);PROGRESS 写一行 + S19 告知 user(事后告知,不是事前请示)。**计划轮换**(transcript ≥60 MiB)同路径,由协调者自己在安全点触发,不再等 user。双起防护:继任席起来后先 `kill -0` 旧 pid,活着 ⇒ 自己退出(先到者赢)。 | Infra Dev(dispatcher)+ 协调者(runbook v3 + skill §5) | 夹具:kill -9 协调者 ⇒ ≤10min 新席 presence 出现、角色箱被新 sid 认领、PROGRESS 有「继任」行;kill -STOP ⇒ 同;活跃协调者 ⇒ 零动作;双起 ⇒ 后者退出 |

## 3. 不做
- 不给成员席加「主动催协调者」:成员催只会把噪音加回协调者箱;哨由 dispatcher(无模型、常驻)来做。
- 不让 Carly 代行协调者裁定:她只升级给 user,不派单。

## 4. 验收(整体)
人为复现:协调者会话 `kill -STOP` 2.5h(beat 停)或仅停写 handoff 2.5h(beat 续)→ 两种情况下 ≤10min 内 user 面板出现 alert、协调者箱有 S19、L0 文件存在;恢复后 S19 自动闭。
