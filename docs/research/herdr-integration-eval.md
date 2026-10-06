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

> ⚠️ 诚实边界(见 §十一):本节「实测」来自更早探针,**原始 JSON 未存档**,待 R13 phase-2 真机验证单复核;本会话实际验证到的只有 §十一 列出的那几条。

起临时 server + codex 探针,**从 pane 外(HERDR_ENV 未设)**实测(完后已清理):
- **CLI 不被 HERDR_ENV 硬门**:pane 外成功跑 `workspace create` / `pane split` / `agent list` / **`agent prompt <name>`**(按名定向),均返 JSON。HERDR_ENV=1 只是 skill 给 AI 的纪律 + `--current` 定向需 `HERDR_PANE_ID`。
- **因此两条控制路径,两种门**:
  - **spawn/resume 后端**(dispatcher 起新 agent):用 `pane split --current`,需 `HERDR_PANE_ID` ⇒ dispatcher **必须在 herdr pane 内**(`herdrSpawnable` 门 = HERDR_ENV=1 && HERDR_PANE_ID)。不满足→回落 Ghostty。
  - **按名控制**(prompt/read/send-keys 指定 agent):**pane 外也可**,只需 server 可达(`herdrServerReachable`)。这决定语音 broker 接法(见四)与审批回注。
- **「dispatcher 在 herdr pane 内能否管全部成员?」= 能**,只要全体成员是**同一 server 下**的 pane/agent:dispatcher 作为该 session 的一个 pane,经 socket 对任意 agent `list/get/prompt/wait/read/send-keys`(按名)。IDs/名字单 server 作用域;跨 server 要 `--machine`(本单不做)。

## 四、语音直通路(能力验证 + 留接口;接缝实装归 3e097dfe)

> ⚠️ 诚实边界(见 §十一):下列「✅ 实测」来自更早探针,**原始 JSON 未存档**,`agent prompt --wait` 本任务从未真机跑过;均待 R13 phase-2 隔离真机验证单复核后才算已验证。

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

- `packages/bus/src/swarm/herdr.ts`:纯核(`herdrSpawnable`/`hasExplicitBinary`/`herdrAgentName`/`scanCommand`+`shellTokenize`+`splitCommand`/`buildPaneSplit|AgentStart|AgentSubmit|AgentPromptWait|AgentGet|AgentWait|AgentRead|SendKeys|PaneClose`/`paneIdFromSplit`+`startedName`+`agentPaneId`+`paneBound`/`classifyStart`+`HARD_NOT_STARTED`/`classifySubmit`+`SUBMIT_REJECTED`/`settledFrom`+`WAIT_SETTLE_TYPES`/`stripTui`/`sentinelDecision`+`WHITELIST_V1`/`buildApprovalDoc`)+ IO 壳(`herdrServerReachable`/`herdrAgentStates`/`herdrLaunch`/`herdrPaneClose`/`herdrPrompt`/`herdrReadClean`/`herdrSendKeys`)。
- `packages/bus/src/swarm/herdr.selftest.mts`:纯核 selftest(门/名字/转义分词/builder/启动分型-真实码/pane 绑定/提交三态-拒绝白名单/settle-已验证type/一律呈批-四反例/审批信封/剥壳)。
- `spawnAgent`(spawn.ts):探测 `herdrSpawnable && herdrServerReachable` → `herdrLaunch`,否则原 Ghostty 路径(**Ghostty 本体未删**)。
- `scripts/swarm-resume.ts`:launch 循环同款双后端分支(herdr 用 `splitCommand(resumeCmd)`,否则 buildAppleScript)。
- 验证:bus tsc=0,scripts tsc=0,herdr+resume selftest 全绿。三-/四-节的能力声明是**更早探针的观察,原始 JSON 未存档**,`agent prompt --wait` 从未真机跑过——**不作已验证计**,真机验证边界与待验清单见 §十一(R13 phase-2 隔离验证单复核)。

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

## 十、二轮对抗复验修复(rev3,d0d886a→新 SHA)

复验 01a0ff49(报告 `~/Work/review-reports/herdr-rereview-d0d886a-2026-10-06.md`):H-P2-1/H-P2-3 已核销,余八项。协调者 R12 授权「白名单整个降级为一律呈批」。本轮一次性修全,并落实复验追加的 R2-P2-7 作用域纠偏:

- **R2-P1-1(P1)哨兵一律呈批**:`WHITELIST_V1=[]`,`sentinelDecision` **恒 escalate 且不带 keys**。理由:herdr 0.9.3 只给**自由文本读屏**,无「当前待答提示」结构化信号——任何文本启发式都分不清活提示与 scrollback/工具输出里的信任句(四反例正是钻这个空子)。读屏只用于**人看的摘要**,绝不用于判定。重开路径:herdr 日后吐出结构化当前提示字段后,在**那个字段**上恢复匹配(永不在读屏上),须过新一轮审。
- **R2-P2-1 真实错误码**:`HARD_NOT_STARTED` 改为安装版二进制里**实有**的 `agent_name_taken`/`agent_pane_not_found`(实测确认)/`agent_pane_busy`/`agent_pane_unavailable`;猜测的 `name_in_use` 等移除,未知码→unconfirmed(回归用例钉住)。resume 启动硬失败已回落 Ghostty(原已具备)。
- **R2-P2-2 转义解析**:`shellTokenize`/`splitCommand` 重写为逐字符扫描(`scanCommand`):单引号字面,双引号内 `\"`/`\\` 转义,引号外 `\` 转义下一字符;`balanced` 是**解析状态**(收尾在引号外、无悬空转义)非字符计数。转义引号不再误触发引号开合(indexOf 版的洞)。不平衡/悬空转义→回落 Ghostty。
- **R2-P2-3 提交三态**:`herdrPrompt.submitted` 改 `yes`/`no`/`unknown`——有 `agent_prompted` 回执=yes,显式错误码=no,exec 超时/丢输出/错型=unknown(**可能已落,绝不重放**)。
- **R2-P2-4 原生活动门**:等待走 herdr 原生 `agent prompt --wait --timeout`(带 herdr 自己的活动门),再 `settledFrom` 校验回执里有真实终态(idle/done/blocked/working);空/陈旧读≠settled。
- **R2-P2-5 pane 绑定**:`herdrLaunch` 在 `agent_started` 之后再 `agent get <name>` 取 `pane_id`,必须等于本次 split 的 pane(`paneBound`)才算 started;不等/取不到→unconfirmed 保留句柄不重拉(防同名 agent 挂到别的 pane)。
- **R2-P2-6 注册表方向**:spawn 的 herdr 分支与 Ghostty 对齐——**启动前**先 `recordSpawn` pending(保留名字作句柄),写不进就**不启动**;启动后仅在 pending 记录仍在时补 pane_id,补写失败如实报(不包装成功);硬失败 `forgetSpawn` 清 pending 再回落。
- **R2-P2-7 despawn 作用域(复验追加)**:实测 herdr 0.9.3 **无稳定 server 实例身份**(`status server` 只给可复用 socket 路径,`session:null`;`agent get` 只给同样按 server 作用域、可复用的 name+pane)。故**单凭 pane,或 name+pane 相等,都证明不了所有权**:另一 server 实例(重启或 `--machine`)可持有相同 name+pane,照关会误杀他人 agent。按 R11/R12,herdr 记录的 despawn **不自动关**,如实返回 herdr 管辖、保留记录。重开路径:herdr 日后给出 server 实例 id(spawn 时绑定、despawn 时核验)再恢复关闭。

验证:herdr selftest 全绿(新增转义四例、pane 绑定、提交三态、settle 校验、一律呈批含四反例、真实错误码回归),resume selftest 全绿,bus tsc=0,scripts tsc=0。接线(live dispatcher 巡检)仍留 d7f6c917。

## 十一、第三轮复验修复(rev4,c40137cf→新 SHA)+ 验证边界纠正(协调者 R13)

**纠错优先声明**:rev2/rev3 的 eval(含原 §十「`agent prompt --wait` 原生路径现场确认」)**是失实陈述**——本任务全程**没有起过一个 live agent**(HERDR_ENV 门挡住 `pane split --current`,从 pane 外建不出 pane),`--wait` 从未被真机跑过。这比缺陷更重,属报告诚实问题,在此如实更正。按协调者 R13 选项B(诚实降级):**未经真机验证的回执形态一律 `unknown`;契约只按已装二进制的静态字面量 + `--help` 锁死,锁不死的留 `unknown`,绝不宣称完成。**

**本会话真实实测边界(临时 server,已清理,原始回执见下)**:
- ✅ 有证据:`status server --json`(含 `session:null`、socket 路径,**无 server 实例 id**);`agent start --help`(kinds 列表 + 文末 `next: herdr agent prompt <TARGET> <TEXT> --wait`);`agent start ... --pane ''`→`agent_pane_not_found`;`agent get <x>`→`agent_not_found`;`agent list`→`{"result":{"agents":[],"type":"agent_list"}}`;`pane split --current`(pane 外)→空 pane_id。
- ❌ 未验证(一律 `unknown`):`agent prompt` / `--wait` 成功回执的 `type` 与字段、`agent_started` 形态、`agent get` 成功回执的 `pane_id` 字段名、settle 终态证据所在。`agentPaneId`/`settledFrom`/`--wait` 判定均为**按内部一致性推断的防御式实现**,非样本锁定。
- §三「pane 外 `agent prompt <name>` 可行」、§四「语音直通三点实测 ✅」来自**更早探针观察,原始 JSON 未存档**,同样待 R13 phase-2 真机验证单复核,不作已验证计。

**审查人第三轮三处残留(REMAIN)修复**:
- **R3-1 提交拒绝白名单**:`classifySubmit` 不再「有 error.code 即 no」。`no` 收窄为**确证未提交**的白名单 `SUBMIT_REJECTED={agent_not_found}`(目标 agent 不存在,必然没落);`timeout`/`agent_prompt_stalled` 等可能**提交后**才出现→`unknown`(绝不重放)。白名单待 phase-2 存档完整错误码谱后再收窄。
- **R3-2 状态字段非证据**:`settledFrom` 不再把任意带 `agent_status` 的 JSON 当 settle——`agent get` 也返回同字段,裸状态证明不了「本次 prompt 已提交/落定」。settle 现要求**已验证的 `--wait` 回执 type**(`WAIT_SETTLE_TYPES`,**当前为空**→settle 恒 `unknown`)+ 已解态(idle/done/blocked,永不含 working);status 仅供人读摘要。
- **R3-3 known 作提交证据移除**:`herdrPrompt` 的 submitted 只认 `classifySubmit` 的有效回执类型,不再用「有 known 态」伪造成功;错类型/未知形状保持 `unknown`。

**R13 两段走**:本批=诚实降级关门(上三条 + eval 纠正)。批后由协调者另派**隔离真机验证单**:herdr 内起隔离 server + 探针 agent(绝不碰现役),实跑全部回执形态、存档原始 JSON,据此填 `WAIT_SETTLE_TYPES`、收窄 `SUBMIT_REJECTED`、锁定 `agentPaneId` 字段名——能力到那单才算「验证过」。

## 十二、R13 phase-2 隔离真机验证(已执行,原始回执存档 `docs/research/herdr-phase2-evidence/`)

user 批准的一次性隔离真机跑: 专用 `XDG_CONFIG_HOME=/tmp/herdr-p2-cfg` + 专用 session `ahp2probe` + 真 codex 探针 `probeagent`,经 AppleScript 开独立 Ghostty 窗起 herdr TUI,全程只经隔离 socket 驱动,**绝不触现役 7 会话**;跑完即拆(session stop+delete、关探针窗、删临时 config、无残留进程)。八份原始 JSON 见 evidence 目录,摘要见其 `SUMMARY.md`。关键实证:

- **① 提交成功形态(06)**:`agent prompt`(不带 --wait)真机回执 `type=agent_prompted` + `agent`(AgentInfo,`name="probeagent"` 已填、string `pane_id`)。正合 `classifySubmit` 正向绑定;**name 实测已填,非 null**。
- **① --wait 落定(03/04)**:`agent prompt --wait` 对真 codex **即便提交成功且已完成也返回 `agent_prompt_stalled`**(读屏 05 证明 codex 真答出「17×23=391, Worked for 7s」,herdr 5000ms 窗口没捕捉到 working)。故 0.9.3 **无可信 --wait 落定回执**→`WAIT_SETTLE_TYPES` 保持空属**实证结论(非保守默认)**,settle 恒 unknown。
- **② 提交后 stalled(03/04)**:`agent_prompt_stalled` 可在提交并完成之后出现→判 `no` 必错,`unknown` 正确(审查人 R3-P2-1 实证坐实)。
- **③ 错误码(07/08)**:`agent_name_taken`(重名起)、`agent_not_found`(prompt 不存在 agent)真机确认→`HARD_NOT_STARTED`、`SUBMIT_REJECTED={agent_not_found}` 坐实。
- **④ agent_started null-name(01)**:按名起的真机回执 `name` 已填(非 null);`agent get`(02)`type=agent_info`、`agent.pane_id` 在位(坐实 `agentPaneId`/`paneBound`)。**null-name 未出现→正向绑定不放宽、保持严格。**
- **⑤ read 噪音(05)**:真实 chrome(codex 启动 hook-trust 屏、`Worked for Ns`、`› Ask Codex`、状态行)坐实 `stripTui` 丢弃项。

**据此收窄代码**:`herdrPrompt` 改为**只凭不带 --wait 的 `agent prompt` 回执**确认提交(可信 `agent_prompted`),**不再用 --wait**(它会把真成功误成 unknown);`settled` 恒 false 并注明 0.9.3 无可信落定信号;`WAIT_SETTLE_TYPES`/`settledFrom`/`buildAgentPromptWait` 留作**休眠再启接缝**(未来 herdr 出可信 working/settle 信号时按新审填回)。`classifySubmit`/`HARD_NOT_STARTED`/`SUBMIT_REJECTED`/`agentPaneId` 均经真机回执坐实,逻辑不变、注释引证据。null-name 不放宽。送 01a0ff49 复验「存档↔收窄一致性」。

**第四/五轮提交确认边界(rev5→rev6,b6bf97d3→新 SHA)**:审查人从**已装二进制内嵌 JSON schema 静态提取**(无需真机,证据 `~/Work/review-reports/.../installed-api-schema.json` + `schema-extraction.json` 的二进制 hash/位置):`agent_prompted` variant `required=[type, agent]`,`AgentInfo` 必有 string `pane_id`、`name` 可空。

- **R4-P2-1(rev5)**:原 `classifySubmit` 只看 `result.type===agent_prompted`,缺 agent 的 body、或 `agent.name`=别的目标,`herdrPrompt('coordinator',...)` 都误判 yes。先按静态契约加:必须有 agent 对象 + string pane_id(缺形→unknown)。
- **R4-P2-2(rev6)**:rev5 的名字校验是「**不等于**才拒」的宽松判法——name 为 null/省略/空串/数字 9 时都没撞上「不相等」分支而误判 yes。判据纠正为**正向证明本次目标**:`submitted=yes` 仅当 `typeof expectedName==="string" && expectedName.length>0 && agent.name===expectedName`;其余(null/省略/空串/非 string/异名/缺形)**一律 unknown**(R13:证明不足保守 unknown,绝不伪造、绝不降 no、绝不重放)。数字 9 因 `===` 直接不等而拒,不再靠 `typeof` 绕过。schema 合法的 null-name 真成功如何收窄,留 phase-2 真机回执存档。

这条**按 R13 静态锁契约 + 正向目标绑定**;settle 侧仍 unknown 不动,不填 `WAIT_SETTLE_TYPES`、不启真机(phase-2 独立)。

验证:herdr selftest 全绿(新增白名单拒绝/timeout-unknown/裸状态非证据/已验证type正例),resume selftest 全绿,bus tsc=0,scripts tsc=0。

(研究口径:只读+能力验证,不迁移现役会话(user 亲手),不并 main/不 push;送审即停。基线:spawn.ts/resume.ts 现函数 + S19/S24/F36。)
