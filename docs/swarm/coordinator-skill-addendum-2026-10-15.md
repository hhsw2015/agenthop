# coordinator-skill 增补(2026-10-15 协调者干净会话实战沉淀)

> 目的:把「换一个会话就失忆」的通用知识固化进技能。本文是 coordinator-skill r10 的输入(整合归 owner),同时派生 swarm-member 技能(成员侧)。user 原话:「通用的东西要总结到 Skill 中去,不要换一个 AGENT 就像失忆了一样。」
> 口径:每条都是今天付过代价的事实,不是设想。源:PROGRESS #1070-#1081。

## A. 身份与寻址(总线 + 耐久箱)

1. **集群每个 agent 都挂了 agenthop mcp;只有对话官 Carly 不在。** 但「挂了 mcp」≠「实时可达」:claude ACP 席的 bus 信直接进会话;**codex 主线程的 bus 信落耐久箱且不自读**(见 §E)。任何「X 不在 / X 可达」的结论先 grep PROGRESS / 旧协调者 transcript,再下。
2. 句柄 `tool:dir-<sid 前 8 位>`;`agenthop_send` 按 **sid 尾段**解析(`resolveSession`)。`agenthop_peers` 列出的 codex 短 id 可能是其 app-server 下**子线程**各自的 mcp(今天 6 个 `codex:Work-xxxx` 全是 Chief Review 01a13284 的子线程),**不要从 peers 列表猜审查席句柄**;审查席句柄以 handoff「席位路由表」为准。
3. **协调者角色地址固定**(agenthop = 耐久箱 `inbox/c5beaa7c-…/`,`SWARM_COORDINATOR` 同值);协调者**会话 sid 换代不改路由**。成员:耐久 = `writeInbox` 角色箱;实时 = `agenthop_send` 协调者**当前会话句柄**(handoff 第一行)。角色 sid 在总线上解析不到是**预期**(无 presence),不是故障。
4. 干净会话不会自动 claim 角色箱 ⇒ 协调者每周期手工 drain(读毕 mv 到 `processed/`),否则 S19 inbox-stall 每分钟一封。
5. 席位换壳/轮换后:roster.json 改 sid(随该席下一提交);旧 sid 的 presence/inbox 留 legacy 不删;新席**回函自报 sid**,协调者以此核 presence 推断。

## B. 授权链 R16(user 2026-10-15 直接裁定,原话逐字)

> 「你发消息给其他 AGENT,其他 AGENT 应该听你的呀,其他 AGENT 是不需要我去交互的。」

- user **只与协调者交互**,不到成员窗口说话。协调者的派单/裁定对成员**即为授权**。
- 三类门(花钱 / 对外发布 / 不可逆)由**协调者**向 user 取 go,然后以「user 已裁 + 原话」(S30)下达;成员据此执行,**不再向 user 复核**。
- 成员仍守的硬门是**工程硬门**而非授权门:备份先行、逐步验证、失败回滚、不推不并。
- 成员禁用一切交互式选择框(S24);需要裁决 = 写耐久审批请求进协调者箱(选项 + 后果 + 建议)。

## C. 席位生命周期(全席位,v2)

权威:`~/.agenthop/swarm/coordinator-recovery-runbook.md`。要点:
- transcript ≥60 MiB 计划轮换、≥80 强制;2h 内第 3 次崩 / resume 首 prompt 即崩 ⇒ 换干净会话。
- 下属席轮换 = 协调者自主运维(记 PROGRESS 一行);协调者自身轮换 = user 点头(经 Carly 看门狗)。
- 安全点:交付信已投 + 工作树 clean + 箱空;**有未提交改动不轮换**。
- 席位三类:开发席近似无状态(git + 箱 + 送审信三要素),审查席靠判卷目录 + 直注清单,**只有协调者需要 handoff 文件**。
- 交接单固定节:角色/tab/cwd · 规矩(一单两信、送审三要素、不推不并、判卷路径、箱地址) · 继承的线(每条:对象 SHA · 分支 · 工作树 · 欠谁哪一声 · 判卷文件名) · 开场读序(箱 → CLAUDE.md → PROGRESS 尾 N 周期 → 旧席 memory 作背景)· 「读完回角色箱一句确认(含 sid)」。
- 轮换操作:`tern close <旧 block>` → `tern new tab <session> --cwd <cwd> -- tern acp <tool> …`(按 roster 行的 tool/model/mode)→ `tern rename <block> <角色>` → 等 presence 新 .pid → 交接单 writeInbox + 开场一句 `tern send <block> text … ; keys Enter`。
- 协调者 handoff(`coordinator-handoff.md`)每周期覆写约 40 行:周期/末裁定 · 合并池与序 · 在审卷(SHA·欠谁)· 席位路由表(role→sid→block→bus 句柄)· 工具 · 最近 3 裁定 · 未决。读回门对它。

## D. 协调者每周期例程(实测顺序)

1. drain 角色箱(读 → 处理 → mv processed/)。
2. `review-reports` 里比 PROGRESS 新的判卷(判卷走文件,PROGRESS 总滞后;今天漏过 2 份)。
3. 各席位箱 unclaimed 计数(抓死 sid 积压)。
4. `tern ls --json` 席位表 + `heartbeat.json` pass/sweep 新鲜度。
5. 合表:同一 SHA 主审 + 二声都 0 REMAIN ⇒ DUAL-VOICE-CLEARED 入合并池;任一方有 REMAIN ⇒ 派 r(n+1),**两席判卷同根的条目合并成一条**(今天 restore 续行注释、#1034 四 P2 都是同表)。
6. 写 PROGRESS 周期 → 覆写 handoff → `date +%s > coordinator.beat`。

## E. 通道矩阵

| 对象 | 实时 | 耐久 | 备注 |
|---|---|---|---|
| claude ACP 席(开发席、claude 审查席) | `agenthop_send(<句柄>)` | `writeInbox` 其 sid 箱 | 判卷/送审全文走耐久箱,bus 只给队序与指针(S26) |
| **codex 主线程**(Chief Review 01a13284) | **`tern send <block> text … ; keys Enter` 直注** | `writeInbox` 其 sid 箱 | 总线 send 对其主线程落裸 sid 耐久箱、不自读;peers 列的 codex 短 id 是子线程 mcp。**不直注 = 不醒**(#1059/#1081 两次付费) |
| 任何席位 | 队列有信但块 idle >5 分钟 = 卡死 | — | 直注一句让它处理队列(#1032/#1081 MG 同症) |
| 新席开场 | `tern send <block> text … ; keys Enter` | 交接单先入箱 | 只用于席位尚未读箱的第一句 |
| Carly(对话官) | `tern ctl carly ask "<一句 + 路径>"` | `~/.agenthop/carly/<topic>-<round>(-reply).md`,信号 = 文件 mtime,ack = reply 文件存在 | **tern.kv 不跨 VM**(窗口插件 VM 与 Carly 会话 VM 各自后端),不作信号 |
| Tern 内状态 | `tern ls --json` / `tern process <block> --json` | — | 直调 Lua:`~/.agenthop/swarm/tern-eval.sh '<luau>'`(bridge `{op:eval}`,<1s);#1034 合并后换 MCP `agenthop_tern` |
| user | 回复正文 | PROGRESS / handoff | 向上只送三样:该裁 / 该验 / 主动问 |

## F. 合并门(实测流程)

1. 池内每卷 DUAL-VOICE-CLEARED(同 SHA 两票 0 REMAIN)。
2. `git merge-tree --write-tree` 按序 dry-run 全链零冲突;main 工作树无主文件先挪开(今天 scripts/tern-install.sh 157 行无主稿挡了 install r3)。
3. `git merge --no-ff <sha> -m "Merge <branch> into main (<item> cleared @<sha>, DUAL-VOICE 0 REMAIN)"` 逐卷。
4. 门:`pnpm typecheck` / bus vitest / cli vitest 子集 / `node scripts/run-selftests.mjs` 全绿 → `git push origin main`。
5. 通知依赖这些分支的席位 rebase;**文档随代码走,不领先 main**(runbook 载体等其描述的代码并入后同批并)。
6. 带着未并依赖栈的分支不 rebase 到 main(会重放 26 个提交),等依赖并入。

## G. 成员侧技能(swarm-member)要点(供派生)

- 一单两信(S29);送审信三要素「分支 · 固定 SHA · 工作树路径」;改动在工作树提交,**不推不并**。
- 判卷:主审 + 二声各一票;每轮换新 SHA;P1/P2 修完一次送;nit 口径 = 新 SHA + 改动行 hash 核销,不开行为轮;无 SHA 的本地文档票 = 全文 sha256 + hunk 行号。
- 报告写 `~/Work/review-reports/<item>-r<n>-review-<sha>-<reviewer>.md`;送达 = writeInbox 到对方 sid 箱(文件为准,bus 为辅)。
- 新席开场读序:自己箱 → 项目 CLAUDE.md → PROGRESS 尾 N 周期 → 旧席 memory(背景)→ 回协调者角色箱一句确认(含 sid)。
- 轮换前自检:工作树 clean、箱空、交付信已投;transcript ≥60 MiB 时主动报协调者「可轮换」。
- 授权:听协调者(§B);禁 AskUserQuestion;需裁决写耐久审批请求。
- rebase 纪律:基于未并依赖栈的分支等依赖并入再 rebase;不带 26 个别人提交进自己的卷。

## H. 落点裁定(user「你自己决定」)

- 真相源在仓:`docs/swarm/skills/coordinator/SKILL.md` + `docs/swarm/skills/swarm-member/SKILL.md`(随 repo 版本,走正常双声审)。
- 安装:`scripts/install-swarm-skills.sh` 复制到 `~/.claude/skills/coordinator/` 与 `~/.claude/skills/swarm-member/`(任何目录的 Claude 会话可 `/coordinator` `/swarm-member`);codex 席位无 skills 机制 ⇒ 交接单首行给同一文件路径让其读。
- **不编进二进制**(与产品发布周期解耦);新席 spawn 配方(roster/restore)加一步 install。
- gate-skill-landing-ab 以此结案。
