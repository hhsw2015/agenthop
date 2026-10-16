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
| `agent prompt` | 派单直注、唤醒、开场 | `tern send BLOCK text '…'` + `tern send BLOCK keys Enter` | 已有(tern-wake.ts:159);TUI 多行提交待验 **U3** |
| `agent wait --until` | `agenthop_tern wait` / `wait_peer` | 轮询 `screen_state`,有界次数 + 单调钟(L5 r3 的教训) | **T2** |
| `agent read` / `explain` | 卡点取证、F44-⑩、F57 | `tern capture BLOCK --scrollback` + `stripTui`(herdr.ts:318)+ classify 命中的 `rule` | **T2** |
| `agent send-keys` | 审批弹窗 | `tern send BLOCK keys …`;策略不变:**只报不批**(R16;WHITELIST_V1 为空) | 已有 |
| `agent start` / `pane split` | 起席、扇出 worker、L8 继任 | `tern new tab|split … -- claude|codex …` | **T3**(roster v2 + tern-restore) |
| 会话恢复 | 轮换、重启 | `claude --resume <sid>` / `codex resume <id>` | **T3** |
| presence(herdr 无;我方 #1053) | 席位 pid、L4 定位链 | TUI 跑 Claude SessionStart hook ⇒ 回到 origin "bus" 原路;#1053 的 ACP 专用写者(`resolveAgentPid` 走 `tern acp` 子树)退役 | **T3**(简化);codex 席 presence 另核 **U4** |
| transcript | 审查、L4 停滞判定 | 文件:`~/.claude/projects/<dir>/<sid>.jsonl`、`~/.codex/sessions/…` | 已有(与 ACP 无关) |
| 子 agent 可见性 | 扇出观测 | `agenthop hook subagent`(PROTOCOL §11) | 已有 |

ACP 耦合面(退役/改写清单,grep `tern acp|cx.agents|agents.json|acp` 2026-10-16):`packages/bus/src/swarm/{seat-presence,tern-bridge-sweep,tern-wake}.ts`、`scripts/{seat-presence,seat-shell,swarm-dispatch}.ts`、`scripts/tern-install.sh`、`tern/agenthop-agents-bridge/{claim,window}.luau`、`tern/restore/tern-restore.py`、各自测试。

## 3. 在办件处置(#1115)

| 件 | 处置 | 原因 |
|---|---|---|
| A r10 @7dfa33b(codex app-server 主线程身份;主审 2P1/2P2、二声 1P2) | **PAUSE**,分支与两票留档 | TUI 下 codex 无 app-server 子线程;Platform Dev 在 Phase 0 核 codex TUI + MCP 的 bus 身份是否仍有同类问题,有则复活 |
| L5 r3 @feed5df(A1 桥自愈;主审 1P1/1P2、二声 1P1/1P2) | **PAUSE** | 桥的 ACP mirror 退役;T1 若沿用桥的 tick/mirror 机制,L5 修复搬进新 mirror(Platform Dev 在 T1 决定并带回) |
| bus.11 r2 @d66fdea(presence/L3/L4;主审 1P1/3P2、二声 3P2+nit) | **继续**:Infra Dev 修 **r3** | 壳无关;并在 TUI 席上复验 L4 定位链(presence 来源改 hook) |
| swarm-soak @7d96245(主审 3P1) | **继续**:Reserve 修 r2(Phase 0 之后) | 壳无关 |
| master-plan §I 两壳合一、cutover runbook #1056 | **作废** | 本 brief 替代;Phase 3 前由 Platform Dev 重写 runbook |

## 4. 分期与派单

- **Phase 0 · U-spike(Reserve b90ccae9,≤2h,不改产线)**:在 Tern 起一个真 claude TUI 块与一个真 codex TUI 块(§1.1 命令),跑 ≥1h;每 30s `tern capture --scrollback` + 调 classify(`~/.agenthop/swarm/tern-eval.sh` 或 Lua 测试入口)记 `state` 序列,与人工真值对照。回答:**U1** idle/working/blocked 真值率(claude、codex 各报);**U2** codex manifest 是否命中;**U3** `tern send text` 多行 + `keys Enter` 是否真提交(含粘贴模式);**U4** presence `.pid` 是否由 hook 自然出现(claude);codex 如何得 pid;**U5** 两席 bus 可达(`agenthop_peers`)。产出 `docs/research/tui-seat-spike.md` + 证据目录;协调者轻审,不进双声。
- **Phase 1 · 席位原语(Platform Dev 378177a0,[liveness])**:**T1** 哨兵接线 classify → agents.json `screen_state`(每轮一 pane;分类 5ms 上限;整轮 ≤50ms;UNKNOWN=本轮无新信息不当 idle);**T2** `agenthop_tern` / 桥 op 的 TUI 语义:list(tern ls + screen_state)/ ask(send text+Enter,投递先于记账)/ wait(有界轮询单调钟)/ transcript(文件)/ start(tern new)/ stop(tern close,pid 确认)。先用 PROTOCOL §10 的 5 份真实截屏做夹具,Phase 0 数据到了再扩。
- **Phase 2 · 生命周期(Infra Dev 8a53f4e8,bus.11 r3 之后,[liveness])**:**T3** roster v2(role/tool/model/mode/sid → TUI argv)+ tern-restore TUI + seat-presence 退 ACP 写者 + inbox-wake/tern-wake 门改读 `screen_state`;**T4** L8 继任起的是 TUI 协调者块。
- **Phase 3 · 逐席切换(协调者 + Reserve)**:序 Reserve → 开发席 ×2 → 审查席(codex TUI)→ **协调者最后**(L8 自继任进 TUI 块)。每席:新块 presence 出现 + 箱可达 + bus 可达 **之后**才 `tern close` 旧块;runbook 每步带回滚。
- **Phase 4**:三夜 soak 全过 ⇒ 删 `tern acp` 路径。

## 5. 不变量(审查席按此判)

耐久箱真理源 · 投递先于记账 · UNKNOWN 零动作(读不到 ≠ 正常,=P1)· 只报不批 · 分类 5ms/哨兵整轮 50ms · 读屏单源不作安全判定 · 预算有界且单调钟 · 零角色名零本仓路径(skill §8 毕业判据)。

## 6. 待 user 裁(不阻塞)

1. 解读 (b) 默认(§1.3)。
2. herdr 许可:GitHub README 现写 **Apache-2.0**;PROTOCOL §10 翻译时记 AGPL-3.0。核实后改注。
