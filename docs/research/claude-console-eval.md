# claude-console 深评(第十五面镜 · CC 插件形态多项目控制台)

owner=f32a0507;协调者派单(user 裁)。对象 github.com/SaM-runtime/claude-console(`console-status`,Claude Code **mod** 形态的本地多项目控制台,v0.19.0,MIT)。gh 全程实证(clone 读源,未运行其代码);纯研究,未改码未提交。七处同构已初筛;本稿聚焦三挖+守卫,头号问:**我方外置 console/晨报/呈批能否长进 CC 会话内(交互成本降一个数量级)**。

## 0. 一句话

它是一个 **CC mod**(非经典 hooks 插件):`hooks.json = {"modules":["./register.tsx"]}`,`register(on, options)` 订阅 **mod 事件**(session.start/prompt.submit/tool.call/ui.render/ui.message…),在会话内渲染「prompt 上方状态带 + `/console` 面板 + toast + 后台执行器派发 + 配额/缓存电池 + 两守卫」。要求 **CC 2.1.289+ with mod support**。与我方七处独立收敛(见各节),**真正的新东西是它活在会话内的「mod 能力面」**——这正是我方可借把外置投影搬进会话的那把钥匙。

## 1. 插件/mod 能力面(头号:我方 console 能否长进会话)

**CC mod API 清单(0.19.0 实测用到)**:
- 事件 `on(event,[filter],handler)` 中间件:`session.start`(初始化+`$.command.register`)/`prompt.compose`(稳定系统段=CARD 契约,`scope:session` 保缓存)/`prompt.submit`(逐轮注入上下文)/`turn.start|step|complete`/`session.compact`/`classic.Stop`(唯一桥到经典 hook,仅取 transcript_path)/`tool.call`(两守卫)/`command.run`(`/console`)/`ui.render{component:'AbovePrompt'}`(状态带)/`ui.render{component:'Pane'}`(面板)/`ui.message`(收键/点击)。
- `$` 上下文:`prompt.suggest{text}`(Tab 暗示)·`prompt.fill{text,mode}`(**预填 composer**,可拒 `no_composer`)·`ui.open/close/toast/ask`(`ui.ask`=模态确认)·`ui.resolve→{Box,Text,Button,Client}`·`clock.now/every/after`·`fs.read/list/write/stat`(**read 上限 4MiB**)·`process.run`·`session.id/usage`(usage 带 `rateLimits[{kind,percentUsed,resetsAt}]`)·`store.get/set`(插件级持久 KV)·`env.get`。
- 渲染:**Ink 式 `<Box>/<Text>/<Button>` 树**(非 statusLine、非裸转义码),`AbovePrompt` 槽放状态带(用 `nextHook(e)` 与他插件同行堆叠),`Pane` 槽放面板(`$.ui.open` 打开)。
- **键捕获**:Client 模块(`rows.tsx`)`surface.onKey(e=>surface.post({key:e.key}))`+`onPointer`→回到 `on('ui.message')`;**是 mod surface API,非裸 stdin、非 keybinding API**;仅 terminal/desktop,手机/Remote 退化为纯 Button。热键 `v/s/c/r/d/g/o`+数字 1-9 答决策。
- **后台派发无官方 API**:shell `claude --bg --name --resume <prompt>`,列 `claude agents --json --all`,读 `claude logs <id>`,直接解析 transcript JSONL(见 §3)。

**可行性判(我有他深 + 头号借并存)**:
- **YES,可行且高价值**:我方投影已是**原子写 JSON 读模型**(board/bandwidth-gauge/morning-digest/decision-batch)。一个 CC mod 做**纯消费者**:`on('ui.render',AbovePrompt)` 读我方投影渲状态带,`$.ui.open`+`Pane` 渲 roster/板/呈批面板,`surface.onKey`→对 DecisionItem 按键 approve/reject/defer 写 DecisionsDoc(或走总线)。**协调者 + user 各自会话跑此 mod,读共享投影,在会话内一键批呈批**——省掉「切外置 console + 耐久箱往返」=交互成本降一个数量级(user 原话痛点)。
- **我方不需借它两处**:①后台派发(它 shell `claude --bg`;我方有总线/herdr,跳过更干净)②轮询(它 `clock.every` 60s/20s/1s;我方有 inbox-wake 事件推送——但 mod 内仍需 `clock.every` 轮询投影文件,因 mod 收不到我方总线推送,属小退化)。
- **硬依赖/风险**:CC **2.1.289+ mod support**(新/受限面);mod 仅渲染在单个 CC 会话(每方各跑一份,读共享投影——恰合我方多方读模型)。`prompt.fill` 可被拒、键捕获仅 terminal/desktop、`fs.read` 4MiB 上限(大文件走 `tail -c` 子进程)——这些限制我方照样会撞。
- **判**:**头号借=in-session mod 控制台**(渲我方现有投影+键捕获批呈批),落点 console 前端(owner 3e097dfe)+新 mod 包,规模中大(纯消费现有投影,派发留总线);门=CC mod API 可得性。**这是本面镜最大、最可落地的发现。**

## 2. STATUS 卡 schema + 受管状态(对表我方投影)

他:每项目 `STATUS.md` 内一块 `<!-- CARD -->…<!-- /CARD -->`,行 `- key：value`,字段 **狀態/等使用者/下一步/關卡(spec|review|release)/驗證(`cmd` → 判词)/更新(time · job id)/rev**;`Project` 再加 jobs/tasks/git/pr/isStale(STALE_DAYS=3)。**六步 pipeline** `spec→build→sync→verify→review→release`(StageStatus `done|active|wait|fail|todo`),**纯**从 CARD+jobs+本地验证派生(无盘)。**autoSync**:完成但未吸收的 job→**派一个 sync 改写 CARD(每 job 一次,失败/空写不重试)**,SyncStage `dispatch|running|done|unchanged|dispatch-failed|run-failed`,`cardStamp=更新|mtime`(移动才算 done)。状态存:`$.store`(幂等 Set 上限 200)/`dispatch.json`(executor/model/effort,优先级 pane>registry>global)/`claude-sessions.json`(项目→session+近 20 job 记录,坏内容 fail-closed)。

我方:decision-batch `DecisionItem{id,kind,summary,suggestedAction,evidenceRef,hardGate}`+投影(board/gauge/digest JSON)+任务 brief/task-result。

- **他有我无(次借)**:**紧凑可一瞥的 per-项目 STATUS 卡**(固定小 schema:狀態/**等使用者**/下一步/關卡/驗證),尤其 **`等使用者`=显式「卡在人身上等什么」字段**。我方投影更富但缺「一卡一瞥的 per-任务监督卡」。**次借**=一个紧凑 STATUS 卡投影(state/ask/next/gate/verify),mod 控制台渲之;规模小中。
- **互补非替代**:他的卡是 per-项目**状态**(执行器写、控制台读),我方 decision-batch 是**决策队列**、conditional-routing 是**路由**——决策/路由侧我方更发达。
- **独立收敛确认**:autoSync「每 job 一次不重试 fail-closed」=我方 publish-after-fact/幂等;六步 pipeline「纯派生无盘」=我方纯核纪律;claude-sessions「坏内容 fail-closed」=我方 FC。

## 3. 执行器摘要三元组(对表 herdr 读屏+哨兵)

他(`digest.ts`):per 项目四行,**数据源=CC 会话 transcript JSONL(盘上)** `~/.claude/projects/<slug>/<sessionId>.jsonl`(`CLAUDE_CONFIG_DIR` 或 `$HOME/.claude`;sessionId 解析序:daemon `jobs/<id>/state.json`→插件 job→项目记录)。解析末 64KiB:`最後活動`(末 timestamp+分钟前)·`最後動作`(**末 3 个 tool_use**:`Name: <command|file_path|pattern|description|url [:80]>`)·`最後一句`(末 assistant text 块,400 字)。Codex 无 transcript→降级「不提供」。**独立审查故意不给 digest**(0.19.0,避免把执行器自述喂进审查)。

我方:`paneInfoForSession→{paneId,state}`(仅 pane+agent_status,herdr `agent list`)+sentinel-denoise 读**屏幕**(screenIndicatesContentFilter/classifyFailure on explain)+live-sentinel(blocked/fake-death/idle/ghost)。

- **他有我无(头号 ③ 借)**:**结构化执行器摘要 from transcript JSONL**(末 3 tool + 末一句 + 末活动时戳)比我方**裸读屏**更可靠、更机读。我方 herdr 跑的 agent 同样有 `~/.claude/projects/*.jsonl` 可读 ⇒ **解析 transcript 把 blocked 诊断从「屏幕说 content-filter」升级到「末 3 工具是 X/Y/Z,末一句『…』,末活动 8 分钟前」**,直接升级 sentinel-denoise/live-sentinel。「结构化摘要 vs 裸读屏」判:**结构化胜(诊断面),借之**;读屏保留给 content-filter/审批检测(不在 transcript 里)。落点 sentinel+一个 transcript 解析器,规模中。
- **独立收敛确认**:「独立审查不给 digest」=我方审查席无作者上下文独立复跑。

## 4. 守卫双件(对表 approval/round-doctor)

他:**命令守卫**(`guard.ts`,on `tool.call`,ask 默认/deny/off,仅 Bash/PowerShell)`dangerReason` 查不可逆命令(`rm -r`/`git push --force`/`reset --hard`/`clean -f`/`DROP TABLE`/`mkfs`/`dd of=/dev`/`chmod -R /`/`terraform destroy`/`kubectl delete --all`/`publish`/`gh delete`…),**解包** sudo/`bash -c`/eval(深<3),**豁免** scratch/temp 目录/dry-run/`--force-with-lease`/单文件;返回 `{deny}` **即便允许规则也拦**;`$.ui.ask` 模态。**循环守卫**(`loop.ts`,on 默认)**同错两次**(阈值 2):`loopKey=tool|agentId|stable(args)`,第二次相同失败+相同错误(`VOLATILE` 正则忽略时戳/uuid)才命中,**不拦**——把 `LOOP_NOTE` 注入 `result.context`+toast;成功即遗忘,上限 200。

我方:approval-delegation(安全读清单自动放行/凭据·写·活状态→user,刚上线)+round-doctor(`DegradationKind none|remain-not-falling|fix-one-open-one`,alertN=5,assessRoundHealth/detectDegradation/diagnoseRounds)。

- **命令守卫 ↔ approval(独立收敛,方向互补)**:他是**危险命令 deny-list**(拦不可逆写),我方是**安全读 allow-list**(放行安全读、其余升 user)。**次借**=他的 `dangerReason`(解包+豁免的不可逆命令识别)**硬化我方 approval**:即便委托/允许规则放行,危险写(`rm -rf`/force-push/`DROP TABLE`)也强制升 user。规模小中。
- **循环守卫 ↔ round-doctor(我有他深,粒度互补)**:round-doctor 有退化分级(remain-not-falling/fix-one-open-one)+N 轮,比「同错两次」深;但他是**per-tool-call**(一个工具同参重试),我方是**per-审查轮**。**低借**=per-tool-call「同错两次→注入原因不拦」补我方 round-doctor 的 per-轮(与 AgentGate exit_drift / polydao「retry 带原因」同族)。规模小。

## 5. 吸收清单(排序,落点+规模)

1. **头号:in-session CC mod 控制台**(§1)——mod 渲我方现有投影(band=AbovePrompt / pane=`/swarm`)+键捕获→decision-batch 批呈批,协调者+user 会话内一键批,交互成本降一个数量级;派发留总线、投影走 `$.fs.read`+`clock.every` 轮询。落点 console 前端(3e097dfe)+新 mod 包;门=CC 2.1.289+ mod API。规模中大。
2. **次:结构化执行器摘要 from transcript JSONL**(§3)——解析 `~/.claude/projects/*.jsonl` 末 3 tool+末一句+末活动,升级 sentinel/blocked 诊断(胜裸读屏)。落点 sentinel-denoise/live-sentinel+解析器。规模中。
3. **次:紧凑 STATUS 卡 schema**(§2)——per-任务一瞥卡(state/**ask=等人**/next/gate/verify),mod 渲之。规模小中。
4. **次:dangerReason 危险命令 deny-list 硬化 approval**(§4)——不可逆写强制升 user(解包+豁免)。规模小中。
5. (低)per-tool-call 同错两次→注入原因守卫(§4)补 round-doctor per-轮。规模小。

不借:STATUS.md markdown CARD(我方 JSON 更结构化)、`claude --bg` shell-out 派发(我方总线/herdr)、轮询(我方 inbox-wake 推送)、Codex companion、deny-list 命令集逐字(改编非照抄)。

## 6. 刹车/对照一句

他是**单人单机、把控制台做成 CC mod 活在会话内**的应用版;我方是**无中心分布式蜂群、控制台外置(投影→swarm-viz/TG/herdr)**。七处独立收敛(STATUS 卡≈投影 / 决策键 approve-reject-defer≈decision-batch / 执行器摘要≈读屏[但他结构化更优] / 配额电池≈dual-bandwidth / 守卫双件≈approval+round-doctor / autoSync 幂等≈publish-after-fact / 独立审查不给 digest≈审查席无作者上下文)。**他的独到 = mod 把监督搬进会话内**——这恰是我方最该借的那一样(我方分布式/耐久/密码学更系统,但「人机交互在会话内一键」是我方外置投影的薄处)。同族 [[agent-gate-eval]]/[[polydao-loops-eval]]/[[dist-ha-theory-eval]]。

已交付协调者 fe0376cd,待裁。
