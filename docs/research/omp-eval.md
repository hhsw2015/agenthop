# OMP 深评(镜二十五):Tern 生态的另一半

- 日期: 2026-10-14;评者: 协调者 fe0376cd;user 亲令「结合 OMP 一起研究」
- 一手材料: omp.sh/docs(sdk/rpc/acp/subagents/hooks/skills/sessions/handoff/collab 全读)+本机 omp 18.10.3 CLI 探测
- 定位: 前序镜24(@08351a3)覆盖 Tern 侧;本镜补 OMP 侧。结论先行: **OMP 不只是 Carly 的手脚——它自带一个完整的「微型蜂群运行时」,四个接口(SDK/RPC/hooks/subagents)每个都对我方有独立价值,其中 hooks 的 tool_call fail-closed 门是头号借点。**

## 1. 四接口能力图

### ① RPC 模式(embed 首选路)
`omp --mode rpc`:stdin/stdout 换行 JSON,任意语言可驱。要点:
- prompt ack=受理非完成;真终点=agent_end(isTerminal);**受理/完成分离**=我方 submit-tag 同构
- steer(打断插话)/follow_up(排队)/abort 族——**比我方对席位的 send-keys 注入高一个抽象层**
- host tools 反向回调:omp 可以调「宿主进程的函数」当工具——**蜂群可把 durable inbox/rulings 查询注册成 omp 的工具**
- v2 分帧 64MiB;错误=普通响应帧进程可继续

### ② SDK(Bun 同进程)
createAgentSession:模型/工具/MCP/设置全可注入;SessionManager.inMemory=请求级零残留;customTools 用 zod schema。**蜂群用途:dispatcher 若要起「一次性验证工人」,SDK 路径零 TUI 零 pane,比开席位便宜一个量级。**

### ③ hooks(头号借点)
- **tool_call 钩=执行前策略缝**:可 block/改 input;**异常/超时=fail-closed 阻断**——我方 approval-delegation 的 Bash-IFS fail-closed 纪律,它做成了运行时原语
- tool_approval_requested/resolved 通知钩——**席位权限弹窗的程序化信号源!** 若 omp 席入队,approval-delegation 不用读屏:钩子直接回调
- context 钩(单次模型调用改 messages)/before_agent_start(改系统提示)——roleProfile 注入的运行时路径
- session_stop 可请求一次模型可见续跑=我方「收尾检查」可注入

### ④ subagents(微型蜂群)
- maxConcurrency 32/递归深 2/软预算 200 请求;七个内置专家(scout 只读侦察/reviewer/security-reviewer 只读/sonic 机械活)
- **Agent Hub(Alt+A):状态/模型/用量/成本/谱系逐工人可视**——我方 T5-2 双带宽仪表的现成参照
- 隔离=Git worktree(Auto 模式),补丁/分支集成;明言「非安全沙箱」
- **诚实边界同我方**:「More workers do not make a dependency chain parallel」

## 2. 其余面(短)

- **ACP**:`omp acp` stdio 服务——Tern ACP 块的实证(waiting_input)背后就是这协议;Zed 等编辑器同可挂
- **collab**:多**人**(非多 agent)进同一会话;E2E AES-256-GCM,链接=bearer secret;中继不可自托管(生产)——**与 agenthop 定位重叠但轴不同:它人进会话,我们 agent 对话**;不采用,记互证
- **handoff/sessions**:会话树/fork/--from-claude 导入——证实 omp 席可继承 claude 席的历史(迁移时有用)
- **skills**:与 CC 技能同族,--skills glob 过滤

## 3. 对蜂群的采用判定(并入总图)

| 件 | 判定 | 归属 |
|---|---|---|
| omp 席(RPC 驱动,非 TUI) | **升格**:B7 从「观测富集席」升「RPC 原生席」——steer/follow_up/事件流/approval 钩全套,是三工具链里唯一不用读屏不用注入的 | 总图 B7 改写 |
| tool_call fail-closed 钩 | 头号借点:approval-delegation 的 omp 侧实现=注册一个钩,零读屏 | B7 附属 |
| host tools 反向注册 | 蜂群工具(查 inbox/rulings/PROGRESS)注册给 omp 席=成员自带蜂群手册 | B7 附属 |
| SDK 一次性工人 | dispatcher 起验证工人的轻量路径(Bun 依赖是代价) | C 档候选 |
| Agent Hub 成本谱系 | T5-2/verification-ledger 的 UI 参照(纯研究) | 记档 |
| collab | 不采用(多人轴,与我方多 agent 轴不同);bearer-secret 设计记security 对表 | 关闭 |

## 4. 风险与边界

- Bun-only SDK;RPC 无此限
- subagents headless 无逐工具审批(文档自认)——入队后其子代理面必须受我方 spend-breaker/预算天花板管
- 与 Tern 同属 Stencil closed-beta 节奏;RPC 协议有版本协商(v1/v2)是好信号
- 未实测面(诚实):RPC 实跑/钩子实跑/SDK 实跑均为文档级,入队试点时逐一验证

状态: 纯研究。B7 升格建议候 user 裁;其余并入 tern-adoption-master-plan。
