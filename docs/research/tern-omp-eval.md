# Tern + OMP 全能力图谱与 Herdr 替代评估(镜二十四)

- 对象: Stencil Tern(终端)+ OMP(捆绑 coding agent,Pi 新身份)
- 日期: 2026-10-13;评者: 协调者 fe0376cd
- 方法: 文档全读(index/architecture/surface/api-host/api-shared/api-window/lenses/security/scripts 全家族/carly/procs/remote/control)+ 本机 CLI 实测(tern process/wait/capture/events/ls/inspect)
- 判决演进: #822「不能替代」→ #824「原语够,缺语义层」→ **本轮终判: Tern 有原生 agent 语义层(cx.agents),评估期间我三次低估,user 三次推对**

## 1. 决定性发现: cx.agents(Window API)

Lua `cx.agents` 就是 herdr agent API 的原生等价物:

| 能力 | API | 对应 herdr |
|---|---|---|
| 全会话 agent 枚举 | `list()` → `{pane,command,model,cwd,state,last_message}` | `agent list` |
| 启动+就绪后注入提示词 | `start({prompt,cwd,command?,how?})`——"window submits the prompt once input is ready, even after the launching VM resets" | `agent start`+F48 就绪探测+双回车,**内建** |
| 发话 | `ask(agent,text)`(贴+回车,要求 ready input) | `agent prompt` |
| 等到 idle | `wait(agent,{timeout?})` → 最后一条 assistant 文本;"Queued/submitted input is not prematurely idle" | `agent wait` |
| 结构化转录 | `transcript(agent,{last?})`(仅 omp TSP) | 无(herdr 也没有) |
| 打断/停止 | `interrupt`(Ctrl-C 保块)/`stop` | 无直接等价 |
| **状态检测机制** | **"Working/idle comes from progress OSC 9;4; paused progress or an ask overlay is waiting_input"** | herdr 自有 TUI 检测 |

关键语义: agent = agent block + "shells running omp"。`agent-command` 可配任意命令(默认 omp)→ 跑 claude/codex 的 agent block 同样入列。

## 2. 全能力图谱(压缩)

- **架构**: 双 VM(host=daemon 侧管 pane,window=UI 线程),pane 活在 daemon,窗口关了不死;块状态 save 跨重启;kv.json 原子写(temp+rename——同我方 DWS 纪律)。
- **Surface Protocol**: 程序发语义节点树,Tern 负责排版/动画;in-band 走 pty,**过 ssh 和 daemon 都通**;非 TSP 终端握手无应答自动回退 ANSI。
- **脚本面**: `tern serve`(headless)+`ctl`(一行命令一行 JSON 回)+scenario 文件;`ready`/`expect`/`run`;**headless 确定性**(钉时钟/不存设置)——比我方 tmux 夹具强一档,蜂群集成测试候选工具。
- **CLI**: ls/inspect/new/split/run/send/capture(--scrollback)/wait(--until exit|prompt|idle=MS)/process(前台 pid/argv/cwd)/events(JSON lines)——#824 已实测。
- **Carly**(内建助理): 真工具 inspect/send_input/read_block/run_command/**lua**(跑插件导出的 Lua)+定时任务+心跳;问题可达 omp。
- **远程**: remote 命令族是 **stage UI 的测试原语,不真连 SSH**;真远程=remote host 跑 host 半+本地 window 半。多机能力存在但文档面向 UI,蜂群级验证待做。
- **安全模型**: 插件=完全信任,无权限系统("sandbox 防 bug 不防恶意");host 半在 daemon 机器上有用户全权。对我方=写个蜂群桥插件无能力障碍,同时插件目录必须只有本人可写。
- **lenses**: 只捕非交互命令输出,TUI(alt-screen)即中止——**不能**用于观察 agent TUI(已核原文)。
- **procs/tasks**: 进程表块,按 pane 的宿主机采样;无 agent 语义。

## 3. 诚实边界(未证事项,spike 必验)

1. **OSC 9;4 覆盖面**: Claude Code 2.x 发 progress OSC;Codex 是否发、ask overlay 判定对 claude 的权限弹窗是否成立——**不验证不切**。若 TUI 不发 OSC,working/idle 对该席退化,需 process+idle 合成兜底(#824 方案仍在)。
2. **cx.agents 是 Lua 插件 API,CLI/脚本面没有 agents 命令**: 蜂群是 bash 驱动的,需一个薄桥插件把 cx.agents 暴露到控制面(socket/文件),或经 Carly 的 lua 工具。这就是 shim 的最终形态: **一个 JSON 桥插件,不再做任何检测逻辑**。
3. sid 映射: `list()` 无 session id 字段;SessionStart hook 自建 sid→pane(自报优于探测,与终端解耦,顺手件)。
4. remote 的蜂群级(多机 fleet)未验。
5. 闭测期产品(TERN_AUTH_URL 指向 closed beta 认证),版本节奏/稳定性未知——基础设施押注要计入。

## 4. 替代判决

- **能力上**: Tern+OMP 的 agent 原生化程度=herdr 同级,部分超出(start 内建就绪注入=我方 F48 手工踩过的坑它产品化了;transcript;Carly 定时任务)。
- **工程上**: 迁移=写一个 agents-bridge 插件(Lua,~百行)+SessionStart hook sid 映射+OSC 覆盖验证。蜂群五命脉(巡检/inbox-wake ping/F48/读屏/fleet-recovery)全部可映射。
- **路线**: ①日常终端立即可换;②蜂群切换走 spike→验收门(fleet-recovery/F48/inbox-wake 三绿)→切,期间 herdr 在位。closed-beta 风险决定 herdr 代码路径保留为回退,不删。

## 5. 流程教训(自批)

三轮低估同一产品,根因=每轮只读到「当前页没有」就下「它没有」的结论——**绝无证明≠证明无**,与 termcp 教训(「现在有没有」≠「将来缺不缺」)同族。改法: 评估「X 能否替代 Y」时,先穷尽 X 的文档目录再下第一版判决;目录级证据(cx.agents 在 api-window 第 986 行)一页就翻案。
