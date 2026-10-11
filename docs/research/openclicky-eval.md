# OpenClicky 原生语音助手评估(2026-10-06)

对象:`/Users/wowdd1/Dev/openclicky`(Jason Kneen 的 macOS 原生语音助手),只读取文档。
我们矿挖的是:它作为**有 OS 音频/屏幕权限的原生应用**,怎么解回声/插话/收尾/VAD,它的 `.oc/`
文件队列协议长什么样,push-to-talk+唤醒词与我们的连续通话孰优,以及屏幕引导/子 agent 派生
与我们的蜂群派发的差异。拿来与我们 web 版「协调者 console」语音面对照,产出 借/不借 清单。

**一个必须先讲清的前提(影响全篇诚实度)**:subject repo 里混着**三套代码库**的文档,别当成一套:
1. **openclicky**(本仓,Swift app):它**自己**当前的语音是 **PTT 半双工、无本地 AEC/VAD**
   (`docs/OPENCLICKY_VOICE_PIPELINE.md` §A/§F/§H 明文:"no local AEC or VAD""no barge-in"
   "PTT is push-to-talk half-duplex")。realtime lane 的插话/断句全丢给 OpenAI Realtime 服务端。
2. **clicky-mac**(另一套 Swift,被 `docs/CLICKY_MAC_REALTIME_SPEC.md` 逆向记录):realtime WS +
   `send_to_higher_model` 两层 + 三连 cancel 插话 + `[POINT]`/overlay + `sessions_spawn`。
3. **SKI / heyski.io**(Rust app,被 `docs/SKI_REVERSE_ENGINEERING.md` 逆向):VPIO 苹果硬件 AEC +
   Silero VAD + whisper.cpp + Kokoro,**真全双工**插话,`.ski/` 文件桥(= openclicky 的 `.oc/`)。

结论预告:**可借的原生回声/全双工本事几乎全来自 SKI(逆向所得),不是 openclicky 自己的实现;
而 openclicky 本体在全双工这件事上其实比我们弱(它靠 PTT 回避回声,而不是解决回声)。**

## 一、独立趋同(印证我们的设计 + 如何验证)

| 原生侧做法(来源) | 我们 | 判定 | 如何验证 |
|---|---|---|---|
| clicky-mac realtime 插话 = 服务端三连 `response.cancel`+`input_audio_buffer.clear`+`conversation.item.truncate(audio_end_ms)`(SPEC §2.3/§1027) | `turn_detection.interrupt_response:true`(服务端原生 cancel 在途 response)+ 浏览器 flush 播放队列 | **趋同(语义同,我们更薄)** | `src/server/voice-broker.ts:154` `interrupt_response:true`;`src/client/useConduitVoice.ts:135-136` RMS>0.08 → `flush()`。差:我们没发 `item.truncate`/`buffer.clear` |
| SKI 插话 = 硬截队列 + 喂一段静音让在途 TTS 优雅收尾,**无 crossfade**(REV §F) | 挂断/插话:清 `speakQueue`、`flush()`、`ctx.close()` 硬切,无淡出 | **趋同** | `voice-broker.ts:192` `speakQueue.length=0`;`useConduitVoice.ts:74-84` close+flush |
| SKI 丢空串但仍写一条空文本行"为了对齐",**无人工去重层**(REV §B 行97) | broker 去标点后 `length<2` 丢弃(杀 "야" 类幻听) | **趋同(思路同)** | `voice-broker.ts:171` `replace(...).length < 2` |
| 原生 realtime + clicky-mac `send_to_higher_model`:**便宜快语音层 + 贵的聪明层**两分 | 导管 **MOUTH+EARS only**(`create_response:false`)+ 协调者单线思考 | **近构,但我们刻意更极端** | `voice-broker.ts:153` `create_response:false`;见第五节 |
| `.ski/`/`.oc/` = 纯 JSON 文件桥 + fs-watch + 立即 ack→异步结果(REV §D;INTEG §4.5) | `~/.agenthop/console/` 纯 JSON 文件 + fs-watch(~12ms) | **趋同(传输形制)** | `~/.agenthop/console/{to-coordinator,replies}/*.json` 实测存在 |

这几条是外部独立样本,印证我们的 VAD 配置方向、硬切收尾、幻听过滤、两层拓扑都站在对的结构上。

## 二、逐线 借/不借

### 线① 回声 / 插话 / 收尾 / VAD —— web 几乎无可借,原生赢在沙箱不给我们的东西

- **不借:SKI 的 VPIO 单 AudioUnit 硬件 AEC**(REV §A/§F:同一个 `kAudioUnitSubType_VoiceProcessingIO`
  既采麦又放 TTS,render buffer 直接当回声参考,TTS 永不漏进转写麦路)。**理由:native-only CoreAudio
  API,浏览器拿不到 VPIO**。浏览器唯一等价物是 `getUserMedia echoCancellation:true` —— 我们已用
  (`useConduitVoice.ts:95`)。价值在认知:**VPIO 是"正解"(硬件 AEC 让你无需 gate 就能真全双工);
  我们的半双工 gate 是浏览器沙箱逼出来的软件近似**——麦帧丢弃≈SKI 半双工,RMS 阈值插话≈SKI 的
  VAD speech_start interrupt,`echoCancellation:true`≈VPIO AEC 的弱化版。结构对,只是层级被沙箱压低。
- **不借(我们本就不需要):clicky-mac 的 `conversation.item.truncate(audio_end_ms)`**。它把助手条
  在"实际播了多少 ms"处截断,是为了**让会思考的 realtime 模型的上下文记忆 = 用户真正听到的内容**。
  我们导管 `create_response:false`、不就对话史推理(推理在协调者,且协调者收的是干净文本不是音频),
  **所以这条服务于一个我们导管根本没有的"脑",不借**。
- **借(小,验证向):把被丢弃的幻听记一条观测线**。SKI 丢空串仍写空文本行"for correlation"。
  我们现在是静默 `break`(`voice-broker.ts:171`)。加一条结构化丢弃日志(符合我们诚实/可观测文化,
  不改行为),便于日后调 `length<2` 阈值。成本极低。
- **记一个缺口待核**:我们插话只靠 `interrupt_response:true`+浏览器 flush,没发 `input_audio_buffer.clear`。
  正常情况无碍(导管不留上下文),但**若出现"插话后下一轮把上一轮残留音频一起 commit"的脏尾**,
  clicky-mac 的 `buffer.clear` 是现成补丁。现在不做,留作线索。

**线①净判:对 WEB 没有真正可搬的回声/全双工技术——原生的赢点(硬件 AEC)正是沙箱拒绝我们的。
我们的半双工 gate 是给定约束下的正确形状;原生 realtime 服务端插话的趋同印证了我们的 VAD 配置。
唯一落地动作是把丢弃幻听做成可观测(小)。**

### 线② `.oc/` 事件协议 vs 我们的 console 文件队列 —— 一处可借(类型化消息名),一处我们更强

`.oc/`(= SKI `.ski/`,REV §D)Schema:
- **追加式单文件**,每方向一个:`events.jsonl`(→agent)/`commands.jsonl`(←agent),每行一个 JSON,末尾 `\n`。
- 幂等 = fs-watcher **只读新增尾字节**(byte-offset);**无 ack**,fire-and-forget;**无轮转,文件无限增长**
  (REV §D 行137 自认的弱点,只有截图另有 sweeper 清)。
- `session_id = SHA-256(绝对项目路径)[:16]`(确定性,重启复用)。
- 公共字段:`session_id, ts(unix 秒 f64), text, duration_ms, audio_seconds, system, screenshots[], reason, path`。
- **类型化消息名**(internally-tagged enum,点分小写):事件 `session.started / utterance.final /
  tts.done / tts.interrupted / screen.captured / summarize`;命令 `tts.speak / tts.cancel / voice.set /
  screen.capture / agent.heartbeat`。

我们的 console 队列(实测 `~/.agenthop/console/`):
- **一消息一文件**:`<ts>-console-chat-<uuid>.json`(→协调者)/`<ts>-console-reply.json`(→console)。
- 幂等/消费 = 消费后移进 `processed/`(**显式 ack + 天然轮转**);文件名 `<ts>-` 前缀 = 字典序即时间序。
- 路由信封:`{from, fromLabel, via, ts, taskRef:"console-chat", title, text}`(无音频元数据,无类型区分)。

| 维度 | `.oc/`(他们) | console(我们) | 谁更优 |
|---|---|---|---|
| 存储 | 追加单文件 | 一消息一文件 | **我们**:半写文件是离散故障而非坏尾;崩溃安全 |
| 消费/幂等 | tail byte-offset,无 ack | move→`processed/` | **我们**:显式消费,重启不重放 |
| 轮转 | 无(无限增长,自认弱点) | move 即天然轮转 | **我们**:他们的弱点被我们设计掉了 |
| 消息语义 | **类型化 enum 名** | 全是 `taskRef:"console-chat"` 自由文本 | **他们**:能不解析文本就分辨回合生命周期 |
| 载荷 | 音频元数据(duration/audio_seconds/screenshots) | 纯路由信封 | 各取所需(单语音环 vs 多 agent 总线世界) |

- **借:类型化消息名**。给我们消息加一个 `kind`/`event` 字段(如 `user.turn / tts.read /
  tts.interrupted / call.started / call.ended`),让 console↔协调者**不靠解析 text** 就能分辨回合
  生命周期。契合我们"状态即结构化事实"文化,便宜,是本线唯一真借点。
- **不借:追加单文件 + tail-offset 幂等 + 无 ack**。我们的"一文件 + move→processed"**严格更优**
  (显式消费、天然轮转、崩溃安全),把他们自认的"无限增长"弱点直接设计掉了。**此处记"我们赢"。**
- **不借:确定性 `session_id=SHA256(path)`**。我们已有 `taskRef`+`fromLabel` 承载身份与跨通话连续性,
  边际收益小。

### 线③ push-to-talk + 唤醒词 vs 我们的连续通话

OpenClicky 计划(`VOICE_WAKE_WORD_PLAN.md`):三模式 `push_to_talk / toggle_wake_word / always_wake_word`;
唤醒词用**端上 Porcupine**(唤醒前绝不把房间音频传出设备);PTT = 半双工(回声按构造不可能);
选 PTT/唤醒的理由是**隐私(不连续外传)、省电、防自触发、原生 PTT 给干净半双工回合**。

> **前提(herdr-direct 输入,已定的前向premise)**:我们的语音**输入**正在改为 herdr-direct ——
> broker 转写后,herdr agent 的 prompt **直接命中协调者会话**,用户的口语回合变成**真实 user 回合、
> 流式回复立即开始**,**退役当前 10-20s 文件通道往返**;干净文本 TTS 源仍走 `replies/` 回来。
> 下面的 PTT-vs-连续权衡**按近实时流式输入**来判,不按当前文件通道延迟。

在近实时流式输入下的浏览器权衡:
- **连续通话(我们)此时输入延迟已低**(无文件往返),所以历史上支持 PTT 的主论点——"用显式
  '我说完了'信号掩盖慢回合"——**被削弱**:流式下 server_vad 断句 + 回复立即起,连续模式已够跟手。
- 但两条浏览器特有论点**仍支持提供 hold-to-talk 选项**:(a) 嘈杂/共享环境里 server_vad+RMS gate
  仍会误断,**按住说话给确定性回合边界、并按构造绕开回声 gate(TTS 时麦本就关)**;(b) 隐私/成本:
  连续模式把麦+realtime socket 热着整整 10 分钟上限,**浏览器 tab 连续上传 PCM16 即便静默也烧
  audio-minutes**;PTT/唤醒给它封顶。
- **借:push-to-talk(hold-to-talk)作为可选次模式(非替换)**。浏览器里实现极廉(按住 Space/按钮→
  开麦,松开→commit),**确定性消灭回声环(TTS 期间麦关,无需 gate)**,是嘈杂/共享/隐私/成本场景
  的对的默认。**herdr-direct 把显式回合边界的延迟代价压到可忽略,所以加 PTT 此刻低成本**;连续仍作
  免手默认。
- **不借:浏览器唤醒词**。理由:(a) Porcupine 是原生/端上 SDK;浏览器唤醒词要在 tab 里常驻一个
  WASM VAD/关键词模型连续跑(openWakeWord/Picovoice Web),重、费电,且**连续热麦正是唤醒词本想
  避免的隐私姿态**;(b) 对一个 **tap-to-connect** 的 console,用户已经主动开了通话,唤醒词几乎无增值。
  **herdr-direct 不改变这条唤醒词判定**(它改的是输入延迟,不是唤醒词的端上/热麦人体工学)。

**线③净判(herdr-direct 下重判):借 PTT 选项(浏览器内廉价、确定性杀回声、嘈杂/隐私/成本友好,
且流式输入抹平其延迟代价);不借唤醒词(native-only 人体工学 + 连续热麦自毁隐私目的 + tap-to-connect
下低价值)。**

### 线④ `[POINT:x,y:label]` 屏幕引导 + 子 agent 派生 vs 我们的蜂群派发 —— 只记差异,一律不借进导管

(宪法:导管脑残、单线;以下全部 **DON'T-BORROW into conduit**,仅记录对比。)

- **`[POINT]` 管线**(SPEC §4.2-4.3/§9):higher-model 回 `[POINT:x,y:label:screenN]`(及 `TARGET/
  HOVER/HIGHLIGHT/SHAPE`/walkthrough beats),app 正则解析→渲染屏幕 overlay(蓝三角光标飞到坐标、
  8s TTL 标注、guided-click 武装)。**realtime 层被禁止直接发 POINT**,必须 `send_to_higher_model`
  要坐标。这是一条 **视觉→坐标→overlay** 管线,死死绑在"有 OS 全屏坐标空间 + overlay 窗口"上。
  - 不借理由:(a) 导管脑残/纯文本,不产坐标;(b) **web console 没有 OS 级屏幕坐标空间、没有可飞光标
    的 overlay 窗口(浏览器被沙箱限在自己 tab)**;(c) 这是协调者/tool-renderer 的事,不是语音导管的事。
    我们世界里的等价物 = console 的 CopilotKit tool-renderer / 富媒体卡(见 console-refs-eval),**由协调者
    驱动,不由导管**。
- **子 agent 派生**(SPEC §4.6/§R-330):`send_to_higher_model_handoff` → `AgentSessionsBridge.spawn(prompt)`
  (`sessions_spawn`/`session_status`);更广的"agent intent"还会经本地 relay 直接拉起真 Claude Code CLI
  (mirage 计划)。即**语音前端直接派生/驱动 sub-agent**。
  - 不借理由:**语音前端派生子 agent = 多线/直控,正是我们宪法禁止的**(同 console-refs-eval 里"多 agent
    直控"的判定)。我们这边,所有蜂群派发归**协调者那一条线**所有;导管不碰工具、不派生。
- **记一处"近趋同但刻意背离"(重要)**:clicky-mac 的 `realtime 前端 + send_to_higher_model` 在**形状上
  与我们 导管+协调者 两分同构**——双方都认"便宜快语音层 + 贵的聪明层"。**但关键差异:他们的前端对简单
  回合仍自己答、且持有工具带(higher-model/point/type/clipboard/spawn);我们的导管按宪法 100% 脑残
  (`create_response:false`)**。他们在"智能前端+升级工具"落线,我们为护单线拓扑在"零智能"落线。
  **验证**:我们 `voice-broker.ts:153 create_response:false` + 注释"MOUTH+EARS ONLY" vs SPEC §9
  "Call `send_to_higher_model` whenever the user asks about the screen"。**把 POINT/spawn 工具给导管 =
  破脑残/单线宪法,明确不借。**

## 三、无法仅凭文档核实(诚实停放)

1. **原生 AEC 的实战优劣**:无法从文档比出 SKI 的 VPIO 硬件 AEC 是否真的比我们的 gate 更干净——
   没有运行时对照数据。只能说"原生在正确的层解,我们在被允许的层近似"。
2. **subject repo 的"原生赢点"多属逆向他仓**:可借的回声/全双工本事来自 **SKI(Rust,逆向)** 与
   **clicky-mac(逆向)**,**不必然是 openclicky 自己在跑的代码**;openclicky 本体当前(VOICE_PIPELINE
   §H)是 PTT 半双工、无 AEC,**全双工上比我们弱**。引用时别把三仓当一仓。
3. **herdr-direct 尚未落地**:线③的重判建立在"输入改 herdr-direct、流式回复立即起"这个**前向 premise**
   上(协调者供料,已定但未见运行)。若 herdr-direct 滑期,**线②/③ 会多出一个借点**:SKI 的
   **"立即 ack 短确认 → 异步结果"**(INTEG §4.5)正是为掩盖 agent 思考延迟设计的,恰对我们今天的
   10-20s 文件往返;届时导管可先念一句"收到,在想"再念协调者结果。**herdr-direct 落地则此借点作废
   (流即是 ack)**。此条随 herdr-direct 状态翻转,须核实。

## 四、借单清单(供协调者/user 裁是否开后续 ticket;借本身是另一任务,此处不实现)

- **借(小)**:console 消息加 `kind`/`event` 类型字段(线②)——回合生命周期结构化,最干净的一借。
- **借(小)**:丢弃幻听记可观测线(线①)——不改行为,便于调阈值。
- **借(中,herdr-direct 下低成本)**:hold-to-talk 作可选次模式(线③)——确定性杀回声 + 嘈杂/隐私/成本友好。
- **记"我们赢"**:文件队列 一文件+move→processed 优于 追加单文件+tail-offset(线②,他们自认无限增长)。
- **不借**:VPIO 硬件 AEC(native-only)、`item.truncate`(服务于我们没有的脑)、浏览器唤醒词
  (热麦自毁隐私 + tap-to-connect 低价值)、`[POINT]`/overlay 与 语音前端派生子 agent(破脑残/单线宪法)。
- **条件借(随 herdr-direct 翻转)**:立即-ack→异步-结果;herdr-direct 落地则作废。

(研究口径:只读 subject 文档,未改任何代码;我们侧的趋同/缺口均已对 `voice-broker.ts` /
`useConduitVoice.ts` / `~/.agenthop/console/` 实测核实。选型仅建议,裁定归协调者/user。)
