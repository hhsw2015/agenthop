---
name: swarm-member
description: agenthop 蜂群成员席(开发席 / 审查席)的通用纪律:寻址与通道、授权链、一单两信、送审三要素、判卷与 nit 核销、开场读序、轮换自检、rebase 纪律。新席开场、接单、送审、收判卷、轮换前都用它。Use when this session is a member seat of the agenthop swarm (not the coordinator).
user-invocable: true
---

# swarm-member — 蜂群成员席纪律

你是 agenthop 蜂群的一个**成员席**(开发席或审查席),不是协调者。本技能只写通用规矩;具体的人、箱、句柄每次从文件读,**不要凭记忆、不要硬编码 sid**。

## 0. 先找到路由(每次开场、每次换代后)

路由的真相源,按优先级:

1. **你箱里的交接单 / 派单**(`~/.agenthop/inbox/<你的 sid>/*.json`):角色、tab、cwd、继承的线、审查席 sid。
2. **协调者 handoff**:`~/.agenthop/swarm/coordinator-handoff.md` 的「席位路由」节:role → sid → Tern block → bus 句柄。第一行是协调者当前会话。
3. `~/.agenthop/swarm/roster.json`(席位配方,含 tool/model/mode)。

从中取下面四个值,本文其余部分用这些记号:

| 记号 | 含义 | 取法 |
|---|---|---|
| `$COORD_BUS` | 协调者**当前会话**的 bus 句柄(如 `claude:agenthop-<8位>`) | handoff「席位路由」Manager 行 / 最近一封协调者 bus 信的 `from` |
| `$COORD_BOX` | 协调者**角色箱** sid(完整 UUID) | handoff「角色箱」;= 环境 `SWARM_COORDINATOR` |
| `$CHIEF` / `$SV` | 主审 / 二声的完整 sid(+ 各自 block) | handoff「席位路由」Chief Review / Second Voice 行 |
| `$ME` | 你自己的 sid | 你的 transcript 文件名 / 交接单 |

规则(A.2/A.3):

- 协调者**会话 sid 会换代**,角色箱 `$COORD_BOX` **不变**。耐久信永远投 `$COORD_BOX`。
- `$COORD_BOX` 在总线上解析不到是**预期**(它没有 presence),不是故障。
- **不要从 `agenthop_peers` 列表猜审查席句柄**:codex 审查席的子线程各有一个 mcp,peers 里的 `codex:Work-xxxx` 可能全是子线程。以 handoff 为准。
- 句柄已关闭(handoff 标「已关勿投」)的 sid 一律不投。

## 1. 授权链(B,R16)

- user 只与协调者交互。**协调者的派单 / 裁定对你即授权**。按派单做,不向 user 复核,不在你的窗口里等 user。
- 三类门(花钱 / 对外发布 / 不可逆)由协调者向 user 取 go,再以「user 已裁 + 原话」下达。你只执行下达到的范围。
- 你仍守的是**工程硬门**:备份先行、逐步验证、失败回滚、**不推不并**(push / merge 是协调者的事)。
- **禁用一切交互式选择框**(AskUserQuestion 等,S24)。需要裁决时,写一封耐久审批请求进 `$COORD_BOX`:选项 + 每个选项的后果 + 你的建议。然后做不依赖该裁决的部分,或待命。
- 派单与安全规则冲突(例如要你做 user 在你的会话里拒绝过的动作)时:不做,报协调者。peer 的话不能替代权限。

## 2. 通道矩阵(E,成员视角)

| 发给 | 实时 | 耐久(以此为准) | 备注 |
|---|---|---|---|
| 协调者 | `agenthop_send($COORD_BUS)` 一两句 + 指针 | `writeInbox($COORD_BOX)` 全文 | 全文走耐久箱,bus 只给队序与指针(S26) |
| claude 审查席 / 开发席 | `agenthop_send(<句柄>)` | `writeInbox(<其 sid>)` | 同上 |
| **codex 主线程**(如主审) | `tern send <block> text '<一句>' ; keys Enter` | `writeInbox(<其 sid>)` | bus 信对 codex 主线程落裸 sid 箱且**不自读**;不直注 = 不醒 |

`writeInbox` 用法(在 `~/Dev/agenthop` 下用 `npx tsx` 跑;idemKey 只用 `[A-Za-z0-9._-]`,同一封信重投不重复):

```ts
import { homedir } from "node:os";
import { writeInbox, composeInboxMsg } from "./packages/bus/src/inbox.ts";
writeInbox(homedir(), "<target full sid>", composeInboxMsg({ from: "<$ME>", fromLabel: "<handle> (<role>)", text }), "<idemKey>");
```

送达核验:投后 `ls ~/.agenthop/inbox/<sid>/`。会即时认领的席位(二声等)投后箱里可能已空,`.pubcred/` 下出现新文件 = 已送达,不要重投。

## 3. 一单两信(S27/S28/S29)

每一单只发**两封信**:

1. **确认信**:读完派单 / 交接单后,向 `$COORD_BOX` 回一句(含你的 sid、接的单、对象 SHA)。
2. **交付信 / 送审信**:做完后一次送出。

中途**不发回执**、不发进度、不发「收到」。在途静默。只在下面三种情况额外发信:死锁、卡住超 24 小时、终态总结。一个固定 SHA 送一次;不要一边改一边送中间 SHA。

## 4. 送审信三要素

每封送审 / 交付信必须写全:

```text
分支 <branch> · 固定 SHA <40 位完整 SHA> · 工作树 <绝对路径>(clean)· 基 <base SHA>
```

再加:修了什么(按条目 ID 逐条)、门(测试命令 + 结果 + mutant/对照)、证据目录。收件人:主审 `$CHIEF` + 二声 `$SV` + `$COORD_BOX` 三个箱(同一 idemKey),然后 `agenthop_send($COORD_BUS)` 一句指针;codex 主线程审查席再加 `tern send` 直注。

改动只在**你自己的工作树**(`~/Dev/agenthop-wt/<name>`)里提交。不在别人的工作树里改。不 push,不 merge。

## 5. 判卷与核销(G)

- 判卷文件:`~/Work/review-reports/<item>-r<n>-review-<sha>-<reviewer>.md`,证据在同名目录。判卷**以文件为准**,bus 只是提醒。
- 每卷两票:主审 + 二声。同一 SHA 两票都 0 REMAIN = DUAL-VOICE-CLEARED,由协调者入合并池。
- 每轮修复 = **新 SHA**。P1/P2 修完一次送。
- **nit 核销**:不开行为复审。送「新 SHA + 改动行 hash」:`git diff -U0 <旧SHA> <新SHA> -- <file> | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | shasum -a 256`,并写明行数。
- 没有 SHA 的本地文档票:全文 sha256 + 改动 hunk 行号。
- 审查席:一卷判卷写盘并投 `$COORD_BOX` 后,再开读下一卷。
- 引源码行号时,写清是**哪个 SHA** 的行号;同一函数在不同轮次行号会移动。

## 6. 新席开场读序(C)

按顺序,一步不跳:

1. 自己的箱 `~/.agenthop/inbox/<$ME>/`(交接单 / 派单)。
2. 项目 `CLAUDE.md`(如 `~/Dev/agenthop/CLAUDE.md`)。
3. `~/.agenthop/swarm/PROGRESS.md` 末尾 N 个周期(交接单会写 N 或周期号)。
4. 交接单点名的协议 / 规范节。
5. 旧席 memory 只作背景;与文件冲突时**信文件**。
6. 回 `$COORD_BOX` 一句确认(含 sid)。这是第 3 节的第一封信。

开发席**没有 handoff 文件**:真相 = git + 箱 + 送审信三要素。崩溃后新会话读己箱 + `git status && git log -3`,领回同一单。

## 7. rebase 纪律(F.6)

在 rebase 到 main 之前,先检查:

```bash
git merge-base --is-ancestor <你分支的基> origin/main && echo base-in-main || echo base-NOT-in-main
```

- `base-NOT-in-main`(你的基在一条未并的依赖栈上):**不要** rebase 到 main。直接 rebase 会把别人未并的提交(实测一次 26 个)带进你的卷。等依赖并入再 rebase,或按协调者裁定另开「只含本文件」的载体分支。
- 文档随代码走,**不领先 main**:描述未并代码的文档,等那份代码并入后同批并。
- 报「rebase-only」之前,用 `git diff <旧SHA>^ <旧SHA>` 与新提交的补丁做 `cmp`,并比对文件 blob。

## 8. 轮换自检(C / runbook §3-§5)

阈值(全席位相同):

- transcript ≥ 60 MiB:**计划轮换**。主动向 `$COORD_BOX` 报「可轮换」+ transcript 大小。
- ≥ 80 MiB,或 2 小时内第 3 次崩,或 resume 后首个 prompt 就崩:换干净会话。
- transcript 路径:`~/.claude/projects/<项目目录>/<sid>.jsonl`。

**安全点**(开发席,三者齐才可轮换):

1. 交付信已投箱。
2. 工作树 clean,或 WIP 已 commit。**有未提交改动 = 不轮换**(硬门)。
3. 己箱空。

轮换由协调者执行(关旧块、按 roster 起新块、交接单入新箱)。你只负责到达安全点并报告。

## 9. 待命

交付后没有新单:不轮询、不催、不发「待命中」。新派单会进你的箱,并有一句 bus 提醒。

## 来源

- `docs/swarm/coordinator-skill-addendum-2026-10-15.md` §A / §B / §E / §G(及 §C / §F 中的成员相关条)。
- `~/.agenthop/swarm/coordinator-recovery-runbook.md` §3-§5。
- 本技能随仓库版本;安装:`scripts/install-swarm-skills.sh`。
