# OpenRig 对比评估(2026-10-04)

repo: https://github.com/mvschwarz/openrig — "persistent teams with roles, shared context and owned work"
4.8k 星,Apache 2.0,TypeScript,daemon(Hono+SQLite)+ CLI + TUI + MCP,tmux 承载会话。
同域正面对标:Claude Code/Codex 混编持久团队。

## 一、独立趋同(印证我们的设计,不需要抄)

| OpenRig | 我们 | 判定 |
|---|---|---|
| "unknown beats a confident wrong answer",unknown 一等值 | INV-1 三态 OK/UNVERIFIABLE/STALL | 同构 |
| PARKED(意外停=空闲×有未尽义务) vs HELD(故意停,有主有唤醒) | F23 dispositions/ 合法空闲机制 + idle-watch | 同构,连定义都一致 |
| DONE-UNSEEN(完成无人消费),读时派生 | F25/F22 → L2 完成槽+独立 observer(耐久义务) | 我们更强:消息全丢仍可发现 |
| Seat:席位身份/上下文恒定,占据者可换 | §3a 角色本体论(role≠session≠node) | 同构 |
| 单一 oracle 计算状态,所有 surface 只渲染 | projection 单写者 + schema v1 | 同构 |
| oracle 非推断契约(不读队列,PARKED join 在外) | INV-1 纯内核只吃组装切面 | 同构 |
| needs-input = {count, reason},不是状态值 | blocked + note(report_status) | 同构 |

结论:两套系统在无交流情况下收敛到同一批结构,增强对我们冻结契约的信心。

## 二、可借(全部是小件,视图层/文档层)

1. **resumability 第三轴 + `context-walled` 命名**:session(present/detached/exited/absent) × activity × resumability(live/resumable/context-walled)。context-walled=会话在但上下文耗尽、resume 无意义——我们遇过(compaction)未命名。落点:swarm-resume/whois 输出词表。
2. **读时派生诊断列**:kanban 叠 PARKED(idle ∧ 板上有适配 open 项)与 DONE-UNSEEN(done 改名 ∧ 无消费回执)两列,零新状态纯查询。落点:viz 轨小 board 项。
3. **"改了你机器什么"全披露表**:install 时逐项列出所有对用户机器的写入(hooks/LaunchDaemon/配置)。落点:merge+install 批的文档件。
4. **roster 授权声明 vs 运行时观测分离**:authored 文件永远只是推荐,运行时事实读时 join,对不上标 unknown/stale,命令绝不回写 roster。落点:fitProfile 纪律一条。

## 三、不借

- CULTURE.md:协作规范写成文档。我们的 F 账本已证明文档不约束(F23/F24/F25 全是有文档仍踩),机制才约束。
- edges:五种边仅 2 种有运行时行为(launch 顺序),不路由消息、不强制委托,自认装饰。我们 board dependsOn/conflictsWith 是真门。
- daemon+SQLite+tmux 架构:我们的 append-only control-log + CAS + wait reducer + agenthop bus 是刻意选择(可审计、可重放、跨机),不换。

## 四、顺带观察

- 文档纪律好:reference 文档带 "Last validated against code: 日期 + Source of truth: 文件路径" 头。我们用 SHA 冻结契约,同精神。
- typing-guard(护住人正在手打的席位,自动消息改为 hold+wake):我们走 MCP 投递不打键盘,暂无此问题。
- RigBundle(SHA-256 拓扑打包跨机分享):暂无需求。
