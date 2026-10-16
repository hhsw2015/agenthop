# 全集群 ACP → TUI 迁移(herdr 能力移植进 Tern)

- 立项:协调者 #1115 · 2026-10-16 · 会话 4f29a68c(角色箱 c5beaa7c)
- 级别:**liveness**(docs/swarm/liveness-tier.md 四道 + 12h soak 才算交付)
- 替代:tern-adoption-master-plan §I「ACP 席位住 Tern」与 tern-two-shell-cutover-runbook #1056(两者作废,见 §3)

## 0. user 原话(S30)

> 这个 TERN 的 ACP 很不稳定,老是报错,老是需要重启,现在需要把这个 ACP 全面迁移到 TUI。你去把那个 HERDR 的能力要迁移过来。整个集群全部用 TUI,不要用 ACP 了。
> https://github.com/herdrdev/herdr

背景事实:协调者 ACP 会话因 transcript 过大反复 -32603 崩溃,今日已换第二个干净会话;八席全部是 `tern acp claude|codex` 块(`tern ls --json` 2026-10-16 11:5x)。

## 1. 裁定

1. **所有席位 = Tern 里的裸 TUI 块**:`tern new tab <session> --cwd <cwd> -- claude --permission-mode <mode> --model <model> [--resume <sid>]`;codex 席 `-- codex -a never -s danger-full-access [resume <id>]`(精确 argv 由 Phase 0 实测定)。`tern acp` 退役。
2. **herdr 不作壳,作能力来源**:它的 agent 状态检测(working/blocked/idle)、`agent prompt/wait/read/explain/send-keys/start` 语义移植到 Tern TUI 块上。分类器已翻译在 main(`tern/agenthop-agents-bridge/classify.luau` #1041 r5 @7b8e161,PROTOCOL §10);缺的是接线与控制面(§2)。
3. **解读默认(R3-b)**:「把 herdr 的能力迁移过来」= 迁进 Tern(b)。替代解读 (a)「回 herdr 壳」:若 user 裁 (a),T1/T2 作废,T3 改为重启用 `packages/bus/src/swarm/herdr.ts` 后端(S14,已在 main);Phase 0/3/4 不变。**不等裁定,按 (b) 开工**;裁 (a) 时 Phase 0 的产出照样有用。
4. **真理源不变**:派单/回执/判卷全部耐久箱;壳只负责「跑」和「看」。读屏可伪造 ⇒ 安全判定永不信读屏单源(spike P3)。
5. **回退**:roster v1 的 ACP 命令行保留到三夜 soak 全过;每席切换步骤带回滚命令。

## 2. 能力对照(herdr → 蜂群用途 → Tern TUI 等价 → 现状)

| herdr | 蜂群用途 | Tern TUI 等价 | 现状 / 单 |
|---|---|---|---|
| `agent list` 状态 working/blocked/idle(PTY 读屏 + 17 manifest) | 状态板、哨兵、sweep、L4/L7、autoscale | 哨兵每轮 `cx.session:read` **一个** pane → `classify(lines,title,program)` → agents.json 每席 `screen_state` | 分类器在 main;哨兵接线**未证**(sentinel.luau:91 只有接口注释)→ **T1** |
| `agent prompt` | 派单直注、唤醒、开场 | `tern send BLOCK text '…'` + `tern send BLOCK keys Enter` | 已有(tern-wake.ts:159);**Platform Dev 探针:codex TUI 第一次 Enter 不提交,要第二次**(Reserve U3 复核;ask 的「送达」判据须是提交后屏幕变化,不是 Enter 返回 ok) |
| `agent wait --until` | `agenthop_tern wait` / `wait_peer` | 轮询 `screen_state`,有界次数 + 单调钟(L5 r3 的教训) | **T2** |
| `agent read` / `explain` | 卡点取证、F44-⑩、F57 | `tern capture BLOCK --scrollback` + `stripTui`(herdr.ts:318)+ classify 命中的 `rule` | **T2** |
| `agent send-keys` | 审批弹窗 | `tern send BLOCK keys …`;策略不变:**只报不批**(R16;WHITELIST_V1 为空) | 已有 |
| `agent start` / `pane split` | 起席、扇出 worker、L8 继任 | `tern new tab|split … -- claude|codex …` | **T3**(roster v2 + tern-restore) |
| 会话恢复 | 轮换、重启 | `claude --resume <sid>` / `codex resume <id>` | **T3** |
| presence(herdr 无;我方 #1053) | 席位 pid、L4 定位链 | TUI 跑 Claude SessionStart hook ⇒ 回到 origin "bus" 原路;#1053 的 ACP 专用写者(`resolveAgentPid` 走 `tern acp` 子树)退役 | **T3**(简化);codex 席 presence 另核 **U4** |
| transcript | 审查、L4 停滞判定 | 文件:`~/.claude/projects/<dir>/<sid>.jsonl`、`~/.codex/sessions/…` | 已有(与 ACP 无关) |
| 子 agent 可见性 | 扇出观测 | `agenthop hook subagent`(PROTOCOL §11) | 已有 |

ACP 耦合面(退役/改写清单,grep `tern acp|cx.agents|agents.json|acp` 2026-10-16):`packages/bus/src/swarm/{seat-presence,tern-bridge-sweep,tern-wake}.ts`、`scripts/{seat-presence,seat-shell,swarm-dispatch}.ts`、`scripts/tern-install.sh`、`tern/agenthop-agents-bridge/{claim,window}.luau`、`tern/restore/tern-restore.py`、各自测试。

## 2a. herdr 上游对表(克隆 `~/Dev/vendor/herdr-upstream` @143bf5f,v0.9.5,2026-10-16;user 令「参考最新源码,不看本地」)

本地 `~/Dev/herdr` 是 2026-07 的 fork 镜像(31c77f3,17 manifest,AGPL 头);#1041 分类器译自它。上游已走远,T1 以上游为准:

| 项 | 上游事实 | 对 T1/T2 的要求 |
|---|---|---|
| manifest | **22 份**(+devin/letta/maki/muse/qwen);claude.toml 3.7k→7.5k、codex 1.6k→4.3k;`min_engine_version` 到 3 | `tools/gen-manifests.py` 改从上游路径重生成;新区域 `bottom_non_empty_lines(N)` / `top_non_empty_lines(N)` / `prompt_box_body` / `whole_recent` 要在 classify.luau 实现;engine 版本门照搬 |
| 状态机(不只分类) | `pane/agent_detection.rs`:working→idle 要 **3 次确认、每 100ms 复查、700ms 上限**,除非屏上有 visible_idle/visible_blocker;稳定 blocker 每 800ms 刷新;启动 3s 宽限;**PTY 新字节只用来决定读不读屏**(idle 且无新字节 ⇒ 跳过读屏,`decide_detection_screen_read`),**working 只来自规则命中**(#1122 核 pane.rs:1157-1185;AgentDetection 的「PTY activity is the working authority」注释已过时) | T1b 的 `screen_state` 必须带这层滞回;屏哈希只复刻「idle 且无变化 ⇒ 跳过读屏」的省读优化,不作 working 来源;PROTOCOL 注明 |
| codex | #5278 **删了 codex turn-status hooks**;codex = 读屏 + OSC 标题(`Action Required` ⇒ blocked,盲文转圈 ⇒ working) | codex 席不要指望 hook;OSC 标题读取是必需区域 |
| claude hook | `SessionStart` 只报会话身份(session_id/transcript_path),**不报状态**;full-lifecycle 权威只给 pi/omp/opencode/kilo/kimi/mastracode | 我方 presence 走 SessionStart 即可;状态仍靠读屏 |
| prompt 提交 | `submit_agent_prompt`:text(bracketed paste)→ **300ms**(`AGENT_PROMPT_SUBMIT_DELAY`)→ Enter;Copilot 先发 focus-gained;Windows codex 加 paste 边界 | T2 `ask` = `tern send text` → sleep 300ms → `keys Enter`,送达判据 = 屏/transcript 变化;这就是「codex 第二次 Enter 才提交」的原因 |
| wait / 探针 API | `agent wait --until … --timeout`、`pane.wait_for_idle/wait_for_screen_change/wait_for_text`、`pane.screen_hash/screen_diff`、`pane.tui_probe` | T2 `wait` 对齐 `--until` 多态 + timeout;screen_hash 作变化探针 |
| 许可 | 上游 LICENSE = **Apache-2.0** | PROTOCOL §10 的 AGPL 注改为「译自 31c77f3(AGPL 时期);r6 起对齐上游 143bf5f(Apache-2.0)」 |


## 3. 在办件处置(#1115)

| 件 | 处置 | 原因 |
|---|---|---|
| A r10 @7dfa33b(codex 主线程身份;主审 2P1/2P2、二声 1P2) | **复活 → A r11**(#1117) | Platform Dev 探针(codex 0.162.1 TUI):MCP 父进程 = codex TUI 本身,**每个子代理各起一个 MCP**(同一父),与 ACP 下「一席多 MCP」同题;r10 的 classifyParent 把 TUI 父 argv 判成 unknown 才碰巧走保守路。r11 = 加「codex TUI parent」类(身份只取 thread_source=user 且为父进程唯一主线程的元数据;子代理 MCP 不认领)+ r10 四 REMAIN(CID-CLAIM-READ-UNKNOWN P1 / CID-CLAUDE-FALSE-SUCCESS P1 / CM-FLUSH-BUDGET / CID-GAP-CORE-GATE)+ 唤醒改走 T2 `tern send`(TUI 不在共享 daemon 36869) |
| L5 r3 @feed5df(A1 桥自愈;主审 1P1/1P2、二声 1P1/1P2) | **PAUSE** | 桥的 ACP mirror 退役;T1 若沿用桥的 tick/mirror 机制,L5 修复搬进新 mirror(Platform Dev 在 T1 决定并带回) |
| bus.11 r2 @d66fdea(presence/L3/L4;主审 1P1/3P2、二声 3P2+nit) | **继续**:Infra Dev 修 **r3** | 壳无关;并在 TUI 席上复验 L4 定位链(presence 来源改 hook) |
| swarm-soak @7d96245(主审 3P1) | **继续**:Reserve 修 r2(Phase 0 之后) | 壳无关 |
| master-plan §I 两壳合一、cutover runbook #1056 | **作废** | 本 brief 替代;Phase 3 前由 Platform Dev 重写 runbook |

## 4. 分期与派单(#1121 加速版;user「能不能加快推进」)

**现状(2026-10-16 17:3x,与 `tui-herdr-parity.md` 一致)**:现网 0 件 TUI 能力生效 —— 装的仍是 `agenthop v0.6.1-bus.10` 与 10-15 的桥插件;全部等 bus.11 装机(`bus11-install-runbook.md`)。

| 件 | owner | 分支 @ SHA | 状态 |
|---|---|---|---|
| Phase 0a/0b spike | Reserve | spike/tui-seat d323713 | 交付,协调者已收;报告只在 spike 分支,未并 main |
| T1a 分类器对齐上游(22 manifest、engine v3、codex working overlay) | Model Gateway | feat/tui-classify-r6 a9e876e(r8) | 在审 |
| T1b 窗口插件 screen 状态 + 读者 | Platform Dev | feat/tui-screen-state 362e673(r5) | **已并 main a21f9a5**;未装 |
| T2 `agenthop_tui` list/ask/wait/transcript/start/stop | Platform Dev | feat/tui-seat-ops 9a47e25(r2) | 在审 |
| T3 wake 门读 screen_state(裸 TUI 席可唤醒;blocked ⇒ S19) | Platform Dev | feat/tui-wake-screen 34a6450 | 在审 |
| T3 roster v2 + tern-restore TUI + presence 修 | Infra Dev | feat/tui-t3 b152bfc(r1) | 在审 |
| A r11 codex 主线程身份(探针:默认 codex TUI = daemon 路径,无需新 parent 类) | Platform Dev | fix/codex-main-thread-identity fbf9c35 | 在审 |
| bus.11(presence/L3/L4) | Infra Dev | fix/dispatcher-env-and-presence 38edec3 | 在审 |
| T4 L8 继任起 TUI 协调者块 | Infra Dev | — | 未开工(T3 后) |
| 切席 runbook | 协调者 | tui-seat-switch-runbook.md | 已并 main 229ce81 |
| bus.11 装机 runbook | Platform Dev | bus11-install-runbook.md | 已并 main ae92dda |
| Phase 3 切席 | 协调者 + 各席 | — | **2/8**:Reserve(块 38306813313026)、Platform Dev(块 40110699577346,PROGRESS #1168);余 Infra Dev、Model Gateway、OpenDot Dev、两审查席(A r11 后)、协调者(最后,T4) |
| Phase 4 删 `tern acp` 路径 | — | — | 未开始(三夜 soak 后) |

下表为立项时的分期计划(保留原文,供对照)。

原则:**TUI 席位从第一天就能干活**(耐久箱 + bus + 席位自己的 MCP 与壳无关),T1/T2 只加观测与控制 ⇒ 切席不等 T1/T2;Phase 0 的 argv/presence 答案分钟级可得,不等 1h 真值率;并行度拉满(Model Gateway 空闲入列)。

| 阶段 | 内容 | owner | 门 |
|---|---|---|---|
| **Phase 0a(即刻)** | 两个真 TUI 块已起 ⇒ 立刻报 argv + U3(提交方式)+ U4(presence)+ U5(bus 可达) | Reserve | 协调者轻审,解锁 T3 与 Phase 3 |
| **Phase 0b(后台 1h)** | U1 真值率 / U2 codex manifest;产出 docs/research/tui-seat-spike.md | Reserve | 喂 T1b 夹具 |
| **T1a** 分类器对齐上游 | manifests.luau 从 `~/Dev/vendor/herdr-upstream` 重生成(22 份);新区域 `bottom_non_empty_lines(N)` / `top_non_empty_lines(N)` / `prompt_box_body` / `whole_recent`;engine v3 门;接口冻结 `classify(lines,title,program) → {state,rule,agent,skip_state_update,visible_idle,visible_blocker,visible_working}`;只改 classify.luau / manifests.luau / tools / test | **Model Gateway** e555b371 | [liveness] 双声;rg 差分零差异 |
| **T1b** 窗口插件接线 | window.luau `screen` 命令(独立 hook/预算,轮转一 pane)→ 滞回状态机(working→idle 3 次确认/700ms;working 只来自规则命中;屏哈希仅作 idle 省读优化)→ per-VM `tern-panes/screens/<vm>.json` → agents.json;陈旧/缺失=UNKNOWN;L5 r3 两修复带入 | Platform Dev | [liveness] 双声 |
| **T2** 控制面 TUI 语义 | agenthop_tern / 桥 op:list / ask(text→300ms→Enter,送达=屏变化)/ wait(有界+单调钟)/ transcript / start / stop | Platform Dev(T1b 后) | [liveness] 双声 |
| **A r11** codex TUI parent 类 + r10 四 REMAIN | 只影响 codex 审查席(最后切)⇒ 排 T2 之后 | Platform Dev | [liveness] 双声 |
| **T3** roster v2 + tern-restore TUI + presence 退 ACP 写者 + wake 门读 screen_state | 用 Phase 0a 的 argv 即开工 | Infra Dev(bus.11 r3/r3b 已送审,现在就开) | [liveness] 双声 |
| **T4** L8 继任起 TUI 协调者块 | | Infra Dev(T3 后) | [liveness] 双声 |
| **Phase 3 切席** | 序 Reserve(**今天,Phase 0a 过即切**)→ Infra/Platform 开发席 → Model Gateway → 审查席(codex TUI,A r11 后)→ 协调者最后(L8 自继任)。每席:新块 presence + 箱可达 + bus 可达之后才 `tern close` 旧块;T1b 未上前观测靠 transcript mtime / bus 状态 / 箱深 | 协调者 + 各席自切 | 每席一行 PROGRESS + 回滚命令 |
| **Phase 4** | 三夜 soak 全过 ⇒ 删 `tern acp` 路径 | | |

审查队列(两席同序):bus.11 r3/r3b → **T3 → T1a → T1b → T2 → A r11** → swarm-soak r2(soak 工具今晚用得上但不在切席关键路径)。

不可压缩的:liveness 四道 + 12h soak(并行于开发,不串行);读屏真值率需要真实运行时间(后台跑,不挡切席)。

## 5. 不变量(审查席按此判)

耐久箱真理源 · 投递先于记账 · UNKNOWN 零动作(读不到 ≠ 正常,=P1)· 只报不批 · 分类 5ms/哨兵整轮 50ms · 读屏单源不作安全判定 · 预算有界且单调钟 · 零角色名零本仓路径(skill §8 毕业判据)。

## 6. user 裁定

1. **解读 (b) 迁进 Tern —— user 已裁 2026-10-16 12:2x(原话「(b) 迁进 Tern 执行」)**。(a) 作废。
2. herdr 许可已核:上游 143bf5f LICENSE = Apache-2.0;本地 fork 31c77f3 为 AGPL 时期。PROTOCOL §10 注随 T1 改(§2a)。
