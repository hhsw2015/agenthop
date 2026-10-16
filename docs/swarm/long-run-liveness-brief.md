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
| L3 dispatcher | `scripts/swarm-dispatch.ts` 启动时 env 白名单;`dispatcher-recipe.json` 记净化 env;runbook ③ 启动段改为 `env -i` + 白名单;tern 探测加 `TERN_PANE_SOCKET` 剔除并把 spawnSync timeout 从 3s 降到 1.5s + 连续 UNKNOWN 3 次后退避到 60s(消噪) | Infra Dev | 回归:带 TERN_PANE_SOCKET 的父 env 起 dispatcher ⇒ `tern ls` 0.1s 内返回;噪音行 ≤1/min |
| L4 dispatcher 哨 | 新 sweep 步 `coordinator-progress-watch`:读 beat + handoff mtime + PROGRESS 末周期 + 角色箱真信数(排除 observer);beat 新鲜 ∧ (handoff >2h ∨ 真信 ≥3 且最老 >1h)⇒ `S19 coordinator-stalled`:投协调者箱 **且** 写 L0 alert **且** `tern send` 协调者块一行唤醒 **且** TG 入口(已有旗)。同样对 Carly:carly-patrol.beat >30min ⇒ alert | Infra Dev | 夹具:伪造 handoff 3h 旧 + 箱 5 真信 ⇒ 三路告警;正控:正常周期零告警 |
| L5 bridge | mirror 定时器链自愈:sweep 发现 tick 不进 ≥3 轮且 reload 防抖已过 ⇒ 允许一次 reload;插件侧 timer_fired_at 超 60s 自重 arm | Platform Dev(桥) | 现网:杀定时器 ⇒ 2 轮内 tick 恢复 |

## 3. 不做
- 不给成员席加「主动催协调者」:成员催只会把噪音加回协调者箱;哨由 dispatcher(无模型、常驻)来做。
- 不让 Carly 代行协调者裁定:她只升级给 user,不派单。

## 4. 验收(整体)
人为复现:协调者会话 `kill -STOP` 2.5h(beat 停)或仅停写 handoff 2.5h(beat 续)→ 两种情况下 ≤10min 内 user 面板出现 alert、协调者箱有 S19、L0 文件存在;恢复后 S19 自动闭。
