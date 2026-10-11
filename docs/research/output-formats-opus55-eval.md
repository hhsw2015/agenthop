# 「理解模型输出」帖 + Opus 5.5 指南评估(2026-10-05)

来源:Karpathy 式输出格式帖(STE100/图/HTML/讲解视频 + answer-me-with-html 仓库)+ Anthropic Opus 5.5 使用指南。

## 一、核心论点与我们的印证

帖子论点:智能与代码充裕后,人的工作上移到「监督与理解」;理解环节本身也能让 LLM 代劳——
为单次理解生成**可抛弃的定制软件产物**(网页/视频),以前不值得做,现在边际成本趋零。

这正是我们北极星的另一半:「人只做给目标/看观测/裁三类」里的**看观测**。我们已在做的:
kanban/worklog/board-viz = 为监督而生的定制观测产物;三态诚实(UNVERIFIABLE)= 指南里
「mark what you couldn't confirm」;对抗审查轨 = 指南「fan out subagents + check evidence」
的重型版。第四个独立趋同样本(comma/openrig/灵姐视频之后)。

## 二、可借增量(小而实)

1. **user 门物料 HTML 化**:merge+install 决策包、L2 全量汇总这类呈批件,从 markdown 升级为
   单页交互 HTML(zero 依赖,board-viz 管线现成)。裁决类材料的理解成本直接决定 user 介入时长。
2. **受控语言思想**:给 user 的报告向 STE100 方向收紧(短句/一义/无从句堆叠)——与已有
   caveman 纪律同族,不新立规,写进协调者 notebook 即可。
3. **Opus 5.5 操作面对账**(user 档位表含 opus 5.5,编码/review 两用):
   - 「done 定义+停点声明」派单模板 = 我们已有(验收门槛+三门),无需改;
   - 「task list in file」= board/PROGRESS 已是;
   - fast mode(/fast)可用于协调者交互态,成员长跑态不需要。

## 三、一个真风险:flag 降档 vs PLANNER-HEAVY

指南明示:被 flag 的消息**自动切到旧模型继续干**。对聊天无害;对蜂群是**静默降档**——
规划档成员若被切,PLANNER-HEAVY fail-closed 原则被运行时击穿且无人知晓。
处置(并入 heavy-tier-binding 单的留痕面):draftPlan 的 {chosen,why,benchmark} 三元留痕
之外,**运行回执须含实际应答模型标识**(CPA 返回体里有),校验 chosen==served,不符即拒绝
该轮产物。顺带这也是 CPA 指纹(cpa:fingerprint)存在的同一理由:声称的模型≠服务的模型。

## 四、不借

- 讲解视频:理解收益/生成成本比当前不划算,观测面已有交互页。
- answer-me-with-html 仓库:思想已吸收(HTML 作答载体),实现自有管线,不引依赖。

## 补:psychopomp 评估(2026-10-05,user 问是否整合)

kitlangton/psychopomp:Rust 写的 code-first 动效引擎,场景程序→1080p60 真动模糊视频或可交互演示。
237 星,作者自称 vibe-coded 早期原型,仅 macOS/Metal 实测。

**风格定位**:与 manim(数学教学)和 am video(组件逐拍)是第三种物种——**产品级 motion graphics**:
2.5D 摄影机(跟拍/变焦/甩镜/手持晃动)、粒子/辉光/爆炸、代码 diff 逐行动画、终端/Slack/PR 原生面、
按词触发的节拍对齐(重配音自动重对时)。打个比方:manim=3b1b 课堂,am=白板讲解,psychopomp=产品发布会片。

**判定:暂不整合,收藏观察。**理由:
1. **需求面**:我们的可解释性产物是"从观测数据讲清楚发生了什么",白板/课堂档足够;发布会级
   运镜对决策理解是噪音不是信号(S15:突出重点)。
2. **成本面**:Rust 工具链+GPU+早期原型(作者自认 vibe-coded,无 release),接入等于领养一个
   不稳定依赖;违反 F33 的"装=最后手段"与 ponytail 阶梯。
3. **已有链未饱和**:manim 重档验收片才出第一支,am 轻档刚加 STE/HTML 档——现有两档的产能
   还没用满,第三档没有真实需求缺口。
**复评触发器**(何时回头看):①出现"对外展示/发布"类需求(产品 demo 片,恰是它的主场);
②它出 release 且跨过原型期;③我们的 PR 走查场景(它的 pr-walkthrough 正是把 PR 拍成片)
在装机后真实出现高频需求。

## 补2:hyperframes/pr-to-video 评估(2026-10-05)

skills.sh 上的 HeyGen 官方 skill:PR(经 gh 读入)→解读变更→分镜/脚本→HTML 逐帧→渲染 MP4。
30 万安装/56.7k 星,编排型 skill(主 agent 当导演,Step5 派帧工人)。

**与 psychopomp 的判定不同:这个值得试,一个条件。**
- 需求正对口:它做的就是「把一次代码变更讲成片」——我们装机门呈批、签收复盘的形状
  (今晚 T3b 五轮收敛片=同类需求,我们用 manim 手搓的);它是 skill 不是引擎,零工具链负担
  (HTML 帧+渲染,和 am 同底盘),安装即用,F33 阶梯过得去。
- 编排形制可借鉴:gate 制分步(每步过门再继续)+帧工人分发——与我们的审查轨/S14 门槛表同构,
  读它的 SKILL.md 本身对 explainer-video 的编排面有参考价值。
- **一个条件=媒资面审查**:/media-use 从 HeyGen 目录解析音乐/音效/图片——外部目录调用,
  需确认是否要 HeyGen 账号/key、是否产生费用、资产许可(页面未写)。装前先读 SKILL.md 验证;
  若需付费账号,过三门(花钱)再用。
**定位**:与自建链并存不替代——敏感内容(swarm 内部状态/未并代码)走自建链(数据不出机);
公开可晒的 PR/发布说明片可走它(产品级产出省手搓)。先装(免费面)试一支低敏 PR 验成色。

### 补2 实测收尾（90b58f9c，2026-10-05;F35 本该派我）

协调者的「一个条件=媒资面审查」已实测澄清——**无需 HeyGen 账号/key/费用**:
- `npx hyperframes auth status` 原文:**"Not signed in to HeyGen — voice & music will use local engines (free, offline)"**;`~/.heygen` 不存在。本地引擎:MusicGen ✓ 就绪、Kokoro(语音)可选未装→走静默档。**不暗扣费**是 skill 自带设计:「无离线 provider 的能力不静默省略要 surface」+ `music: none`+无 SCRIPT.md 的静默标记。费用面条件=清除(免费面成立)。
- 装齐兄弟件(① 完成):hyperframes/animation/creative/media-use + 全家族(cli/core/keyframes/registry/studio/audio),`npx hyperframes skills update`,**全程无登录/付费提示**。**要 Node≥22**(机器默认 node20;用 nvm node22)。

**③ 真跑试片(无账号离线)**:
- PR→项目 ingest 实测绿:PR #5「Declare all four tool hints on every MCP tool」(#18 fork 拓扑 gh 不可解,自选低敏公开 PR)→ fetch-pr+ingest → pr.json/diff.patch/extracted 齐全。
- 真出片:① 工具链证明 warm-grain 示例 → 3.3MB/10s mp4(硬件 GPU,18s);② **PR 专属片** → pr5.mp4 508K/6s(PR #5 标题+真实 diff hunk 上屏,静默,h264)。**全程无 HeyGen、无付费**。

**渲染浏览器(实测发现 + user 裁定)**:hyperframes **render 必须用它自己钉住的 chrome-headless-shell,无法驱动 EGO/Arc**(render 无 `--browser-path`,只有 preview 有;与 am video 不同),实测自动下载 166MB 到 `~/.cache/hyperframes`。**user 裁定(修订):先删,用时再装**——不留 166MB 闲置;render 时 hyperframes 自动重新 ensure 下载。已删 ~/.cache/hyperframes/chrome。

**④ S16 工具清单条目(落档)**:
| 工具 | 归类 | 何时用 | 敏感边界(写死) |
|---|---|---|---|
| **pr-to-video**(hyperframes) | 可解释性 ·「交付解释 / PR 档」出口 | 公开可晒的 PR / 发布说明片,要产品级成色、省手搓 | **内部未并代码 / 敏感路径 PR 绝不喂它**——走自建 explainer-video 链(数据不出机);仅喂已合并的公开 PR |
| explainer-video(自建) | 可解释性 · 通用+敏感 | 任意主题、内部状态、数据驱动(worklog/control-log);敏感内容默认走这条 | 数据不出机;结构图 manim 矢量可回指 |

**分工铁律**:pr-to-video 与自建链**并存不替代**;选择按**敏感度**不按喜好——公开 PR 可走 pr-to-video,一切内部/未并/数据敏感走自建链。

取证口径:只读不改契约;auth/实测命令原样留档(/tmp/hf-auth-status.txt);装的是公开 skill + user 裁定保留的渲染引擎,无账号无付费。
