# herdr 整合评估 + 落地设计(2026-10-06,S14,author 90b58f9c)

对象:**herdr 0.9.3**(~/.local/bin/herdr,Rust,server+CLI,unix socket 协议 /Users/wowdd1/.config/herdr/herdr.sock;源 https://github.com/herdrdev/herdr)。
注意:user shell 有指向不存在 `herdr-cmux` 的旧 alias——一切验证用**绝对路径**;代码用 `HERDR_BIN` 环境变量指绝对路径。
目标:把拉起/恢复从「osascript 盲打 Ghostty」升级为 herdr 后端(JSON 回执 + 生命周期状态),并为 S24「禁弹框」提供机制部件(blocked 检测;**整链接线属 d7f6c917 后续单,本批只交部件,S24 整链未上线**)。**双后端并存,Ghostty 不删。**

## 一、herdr 是什么(与我们相关的面)

terminal workspace manager:把终端组织成 workspace/tab/pane,识别 pane 内的 coding agent,经 `herdr` CLI 暴露 socket API。关键概念:
- **pane** = 一个终端位置(有无 agent 皆可)。`agent start` 需一个**已存在的空闲 shell pane**,自己不建/不拆/不移布局。
- **agent 生命周期状态**:`idle` / `working` / `blocked` / `done` / `unknown`。**`blocked` = herdr 识别到审批/问题 UI**(就是我们要的卡点信号);`unknown` = 有 agent 但分类不确定,不证明完成。
- 控制命令**多返回 JSON**(`{id,result}` 或 `{error:{code,message}}`);读 id/state 从响应取,不猜。
- **HERDR_ENV=1 门**:skill 纪律要求「控制前确认自己在 herdr pane 内」。实测:这是**纪律非 CLI 硬门**(见三)。
- IDs/名字按单 server 作用域;`--machine` 可控远端(本单不碰跨机)。

## 二、CLI 能力 → spawn.ts/resume.ts 映射表

| 我们现有 | 现实现(Ghostty) | herdr 等价物 | 备注 |
|---|---|---|---|
| `spawnAgent({tool,cwd,visible})` | `buildAppleScript`→osascript 开 Ghostty 窗跑命令 | `pane split --current --cwd <cwd> --no-focus`(得 pane_id)→ `agent start <name> --kind <tool> --pane <id> -- <flags>` | herdr 不开窗,在现有 pane 分裂;返回 JSON 回执 |
| `resumeCommandForMember(m)`(F36 完整命令) | buildAppleScript 原样跑 resumeCmd | `splitCommand(resumeCmd)`→{kind,args}→ `agent start --kind <kind> -- <args>` | claude 的 flags / codex 的 `resume <sid>` 作 native args |
| (无)成员存活 | presence pid/status | `agent list`→`agent_status`;`agent wait --until <state>` | idle/working/blocked/done/unknown |
| (无)卡点检测 | 无——弹框静默卡死 | **`agent wait --until blocked`** 或轮询 `agent list` | S24 机制部件(整链未上线,接线归 d7f6c917) |
| (无)读屏 | 无 | `agent read --source recent-unwrapped`(带 TUI 噪音,`stripTui` 剥壳) | 供网页镜像/审批摘要 |
| (无)注入 | 无 | `agent prompt <name> <text> [--wait] [--until S]`;`agent send-keys <name> <key>` | 语音直通 + 审批回注 |

落地:新模块 `packages/bus/src/swarm/herdr.ts`(纯 builder+检测+分类 / IO execFile 壳),`spawnAgent` 与 `swarm-resume.ts` 各加一个**探测→herdr,否则回落 Ghostty** 的分支。

## 三、HERDR_ENV 门 / 「从 pane 内控制」边界——实测

起临时 server + codex 探针,**从 pane 外(HERDR_ENV 未设)**实测(完后已清理):
- **CLI 不被 HERDR_ENV 硬门**:pane 外成功跑 `workspace create` / `pane split` / `agent list` / **`agent prompt <name>`**(按名定向),均返 JSON。HERDR_ENV=1 只是 skill 给 AI 的纪律 + `--current` 定向需 `HERDR_PANE_ID`。
- **因此两条控制路径,两种门**:
  - **spawn/resume 后端**(dispatcher 起新 agent):用 `pane split --current`,需 `HERDR_PANE_ID` ⇒ dispatcher **必须在 herdr pane 内**(`herdrSpawnable` 门 = HERDR_ENV=1 && HERDR_PANE_ID)。不满足→回落 Ghostty。
  - **按名控制**(prompt/read/send-keys 指定 agent):**pane 外也可**,只需 server 可达(`herdrServerReachable`)。这决定语音 broker 接法(见四)与审批回注。
- **「dispatcher 在 herdr pane 内能否管全部成员?」= 能**,只要全体成员是**同一 server 下**的 pane/agent:dispatcher 作为该 session 的一个 pane,经 socket 对任意 agent `list/get/prompt/wait/read/send-keys`(按名)。IDs/名字单 server 作用域;跨 server 要 `--machine`(本单不做)。

## 四、语音直通路(能力验证 + 留接口;接缝实装归 3e097dfe)

user 裁定:语音 broker 转写用户话音→`herdr agent prompt <协调者> <转写>` 直打进协调者会话,话音以**真实用户回合**落地(说话者就是 user,此处「无身份=正确语义」),流式答即起,替代文件通道 10-20s 往返。三点实测:
1. **pane 外进程能调 prompt**:✅ 可行(三-实测)。broker=node server 非 pane agent,按 agent **name** 定向即可,无需在 pane 内。接口:`herdrPrompt(name, text, {wait,until,timeoutMs})`(herdr.ts 已留)。
2. **prompt 命中 working 会话**:✅ **排队接住**。working 中二次 prompt 返回 `agent_prompted`、状态仍 working、无 error——Claude Code/codex 的中途消息机制接住。(语音可随时说,不必等协调者空闲。)
3. **输出侧 `agent read --source recent-unwrapped`**:带 **TUI 噪音**(`Worked for Ns`/输入框/状态行)。`herdr.ts: stripTui` 已剥壳,`herdrReadClean(name)` 返净文本供网页镜像。
留给语音单:broker 调 `herdrPrompt(coordinatorName, transcript)` 注入 + `herdrReadClean` 轮询镜像。

## 五、卡点哨兵 + 审批闭环(设计 + 模块)

两件(herdr.ts 已含纯核,dispatcher 消费):
1. **哨兵**:dispatcher 侧 `agent wait --until blocked` / 轮询 `agent list`(`herdrAgentStates`)→ blocked → `herdrReadClean` 取屏 → **`sentinelDecision(screen, WHITELIST_V1)`**:
   - **白名单机制弹框**(目录信任 / hook 信任,S24 已裁静默)→ `herdrSendKeys(name, keys)` 自动解除 + 留痕。
   - **非白名单** → `buildApprovalDoc(...)` 组 **S19 七字段审批件**(含 `stripTui` 读屏摘要 + 选项/后果/建议)投协调者 inbox,S19 流转。
2. **审批回注**:协调者/授权 dispatcher 拿 user 裁决 → `herdrSendKeys(stuckMember, decisionKeys)` 落进卡住终端,闭环。全程 user 只碰网页/语音面。

哨兵的**循环**(cadence/巡检)属 dispatcher(sweep,IO/brain 域),我出**模块与判据**(classify/whitelist/approval 格式/herdr IO 助手),不接进 live dispatcher(跨域,留接缝,同 worklog 挂点同款分工)。

## 六、规矩(硬边界,写死)

- **herdr prompt injection 权限仅两类**:① 语音 broker(用户的嘴)② 运维救援。**成员间互发消息仍走总线,禁用 herdr prompt 互打**。
- **白名单外永不自动代答**:`sentinelDecision` 非白名单恒 `escalate`,绝不合成答案。三门项(改原则/花钱/不可逆)herdr 仅「读屏呈批 + 回注裁决」,**裁决永远出自 user**。
- **白名单宁窄勿宽**:v1 仅 2 条(目录信任门 / hook 信任门),均 dogfood 实录 + S24 已裁。加条需 dogfood 记录 + 裁定。
- **不新造审批格式**:复用 S19 七字段(taskRef=approval)。

## 七、风险与不借

- **风险:blocked 误判**。herdr 的 blocked 靠 UI 识别;误报→哨兵升不该升的,漏报→卡点没抓到。缓解:白名单只 auto-clear 强匹配,其余 escalate(宁可多呈批不可误代答);哨兵不改成员 CLI。
- **风险:herdr server 是新依赖**。缓解:双后端——server 不可达/不在 pane 内自动回落 Ghostty;Ghostty 路径一行不删。
- **风险:read 噪音漂移**(herdr 版本变 TUI)。缓解:`stripTui` 是 best-effort 行过滤,漂了只是多留几行噪音,不致命;网页镜像可再治。
- **不借:`--machine` 跨机控制**——本单明确不碰跨机;成员跨机仍走总线/relay。
- **不借:herdr 作成员间通讯**——总线是唯一成员通讯面,herdr prompt 仅运维/语音(见规矩)。
- **不借:让 herdr 管布局/workspace 编排**——我们只用它 pane split + agent 生命周期;topology 编排非本单。

## 八、实现物(本分支 feat/herdr-backend)

- `packages/bus/src/swarm/herdr.ts`:纯核(`herdrSpawnable`/`herdrAgentName`/`splitCommand`/`buildPaneSplit|AgentStart|AgentPrompt|AgentWait|AgentRead|SendKeys`/`stripTui`/`sentinelDecision`+`WHITELIST_V1`/`buildApprovalDoc`)+ IO 壳(`herdrServerReachable`/`herdrLaunch`/`herdrPrompt`/`herdrReadClean`/`herdrSendKeys`/`herdrAgentStates`)。
- `packages/bus/src/swarm/herdr.selftest.mts`:39 selftest(builder/分类/剥壳/审批格式)。
- `spawnAgent`(spawn.ts):探测 `herdrSpawnable && herdrServerReachable` → `herdrLaunch`,否则原 Ghostty 路径(**Ghostty 本体未删**)。
- `scripts/swarm-resume.ts`:launch 循环同款双后端分支(herdr 用 `splitCommand(resumeCmd)`,否则 buildAppleScript)。
- 验证:bus tsc=0,scripts tsc=0,herdr+resume selftest 全绿;三-/四-节能力均**临时 server 实测**过(已清理,server 不留)。

## 九、首轮对抗复验修复(rev2,16bf8c8→新 SHA)

01a0ff49 首轮判决 1 P1/7 P2(8 REMAIN),协调者裁定#R11:注册表退化须修(裁 A),哨兵接线批准延期(d7f6c917),via 先用 local。本轮一次性修全八项:

- **H-P1-1(P1)白名单误代答**:`sentinelDecision` 改为只在**当前提示区**(`currentPromptRegion`=stripTui 后末尾 12 行)匹配**完整机制形制**;`dir-trust`=「do you trust the files in this folder/directory/workspace」整句,`hook-trust`=trust/allow+`\bhooks?\b`(词界排除 webhook)+ in this/for this/run/execute。四反例(deployment/webhook/历史陈旧/工具输出引用)全 escalate,真实正例保留。认不准即呈批。
- **H-P2-1 审批信封**:`buildApprovalDoc` 产出合法 `InboxMsg`(`via:"local"`),selftest 过真实 `validInboxMsg` 往返;F38 的 composeInboxMsg 落地后再换。
- **H-P2-2 启动异常/回退/句柄**:`herdrRun` 捕获非零退出不再抛穿;`herdrLaunch` 返回分型 `started/not-started/unconfirmed`——未启动硬失败(name/kind/pane)清理本次空 pane 后回落 Ghostty;agent_not_ready/超时/空/畸形=unconfirmed 保留 pane/name **绝不重拉**;spawn+resume 同消费。名字按 live agent 去重防碰撞。
- **H-P2-3 binary override**:`hasExplicitBinary` 门——设了 AGENTHOP_SPAWN_BIN_* 或 ALLOW_CMD 时 herdr 让位 Ghostty(herdr --kind 只跑 canonical exe)。
- **H-P2-4 带空格参数**:`shellTokenize` 引号感知,spaced config 保一个参数;不平衡引号→`balanced:false`→resume 回落 Ghostty 保边界。
- **H-P2-5 wait 语义**:`herdrPrompt` 拆**提交**(agent_prompted 回执=submitted)与**等待**(独立 bounded,默认 120s 显式);超时返 `{submitted:true,settled:false}` 不盲重放;无提交回执→submitted:false。
- **H-P2-6 成功回执**:`startedName` 校验 type==agent_started + name 匹配;空/畸形/错型/错 name→unconfirmed,不虚构成功。
- **H-P2-7 注册表/despawn(裁 A)**:herdr 启动经 `recordSpawn`(backend=herdr+pane(windowId)+name(surfaceId)+每次启动 launchId)入册,`readRegistry` 带出;`despawnAgent` 见 backend=herdr 走 `herdrPaneClose(pane)` 清理或诚实报 herdr 管辖,绝不按可复用名字猜 owner。

验证:herdr+resume selftest 全绿(含四反例、inbox 往返、启动分型、spaced 参数),bus tsc=0,scripts tsc=0。接线(live dispatcher 巡检)仍留 d7f6c917。

(研究口径:只读+能力验证,不迁移现役会话(user 亲手),不并 main/不 push;送审即停。基线:spawn.ts/resume.ts 现函数 + S19/S24/F36。)
