# console 画布视图 design（一页，待协调者批）

owner aad02248（继任 3e097dfe 席）· 2026-10-09 · 协调者派单（user 三裁:①画布前先学全 Maestri 概念 ②升级既有 swarm-viz 视图族而非新建页面 ③console=入口层读投影零后端）· 设计输入 `docs/research/maestri-concepts-eval.md`（末节「画布实现概念地图」）· 状态:**design 待批,批后实现**

## 1. 目标与核心原则

画布视图 = 我方**系统派生任务图的只读空间渲染**，占「空间 × 派生语义」象限（Maestri 用人手摆+人画连线占「空间 × 人工语义」，我方不走那条）。

- **只读**:S21 单线宪法。画布零写、零编排动作入口(v1)。看=理解协调,不=操作协调。
- **系统派生**:节点与连线全由既有投影派生,**零人手摆、零人手画**。位置自动布局。
- **零新后端**:复用既有 `/state.json`(scripts/swarm-viz-export.ts 已聚合)。新增数据只是让 exporter 多读几个既有文件(纯文件读,非新服务)。

## 2. 视图族整合(非新建页面)

既有 swarm-viz 视图:`topology`(按机器,SVG) / `jobs`(按任务 DAG,SVG,`projection.present` 门控) / `kanban` / `timeline`(web/swarm-viz.html:452-454, viewMode @505)。

**改法**:同数据三投法 = **看板(kanban) / 时间线(timeline) / 画布(canvas)**。画布 = 把现有 `topology` + `jobs` 两个 SVG 空间视图**收敛进化为一个统一画布**(复用 `#svg`/`layout()`/`renderJobsView()` 骨架),不新建页面、不新 HTML 文件。`viewtoggle` 按钮由 topology⇄jobs 二态改为单一 `canvas` 入口;kanban/timeline 按钮不变。

## 3. 节点模型(统一抽象,映射既有实体)

| 节点类 | 源(state.json 字段) | 今日可用? |
|---|---|---|
| agent/席位节点 | `peers`(bus working/idle/blocked)+`projection.members`+`nodes[]` control 生命周期 | 是(members.json 为空占位,真 roster=peers) |
| 任务节点 | `projection.jobs[].nodes[]`(id/kind/required/attempt 验收态) | **门控**(brain 投影未填充,`present:false`) |
| 楼层节点/pill | git `worktree list` + placement floor + `nodes[].control` 分支 | 需 exporter 加读(worktree list) |

着色枚举对齐 Maestri floorStatus = `{working/blocked/review/done}`,源 = board task-state + peers presence + review-queue;验收态按契约**只读投影不重算**(judgment-sink,viz-projection-contract.md),`SUCCEEDED && !complete` 显式画「曾绿现陈,待重跑」。

## 4. 连线模型(系统派生,异色,自动画)

| 边类 | 源 | 今日可用? | 画法 |
|---|---|---|---|
| handoff 边 | `edges[]`(control.successor,前驱→后继 launchId) | **是(今日真实已填充)** | 紫实线箭头(#arrow),端点经 boxRep 解析到席位/盒节点 |
| 派单边 | `nodes[].dispatchedBy` | 门控(**字段仅 fixture 填充,真实 bus peer 未写**;随派单器落地点亮) | 蓝实线箭头(#arrowblue) |
| 依赖边 | `projection.jobs[].nodes[].dependsOn[]` | 门控(brain 投影 present=false) | 右侧 DAG 叠加层(renderCanvasJobOverlay,复用 ACCEPT_COLOR) |
| 强制边 | force-pipeline stages[](packages/bus/src/swarm/force-pipeline.ts) | **v1 跳过**(非既有只读投影文件;落地后加) | 异色实线 |
| 执行边 | `attempts[].executionBindings[].executor`(box→control / member→members) | 门控 | 次切 |

实测校正(v1 实现时):handoff 边(`edges[]`,源 control.successor)是**今日唯一真实已填充**的系统派生边;`dispatchedBy` 字段存在但**仅 fixture 写、真实 bus peer 不写**,故派单边与依赖 DAG 同属门控层(数据到即自动画,无需改渲染)。force-pipeline stages 非既有只读投影文件(是 bus 运行态),v1 不并入 exporter;留待其投影落地。

关键差(独立印证 R21-b):Maestri 连线人手画,我方边**全系统派生**——派单即建边,更强。节点簇 = decision-batch 合并批(次切)。

## 5. 楼层 pill / attention / 仪表

- **楼层 pill**:每 worktree 一 pill(分支名 + floorStatus 色),来自 worktree list。
- **attention 红点**:sentinel(blocked)+ chat-room pendingPrompt + review attention → 节点上红点 + 求人态(对齐 Maestri attention dot,wire-eval ④)。源 = projection `waits/` + stall 定理(`state.stall` 已派生)。
- **双带宽仪表叠加**(次切):`gauge.json`(bandwidth-gauge/v1)若存在则叠加,缺则略。

## 6. 布局(确定性分层,非 force)

复用 scripts/projection.ts 的**拓扑分层**(cycle-safe,layer 内无路径=并行)作主布局;跨层的派单/强制边作正交叠加路由。**不用力导向**——既有代码已明确弃 force sim(漂移到角 + 动 SVG `r` 几何钉死渲染器,swarm-viz.html:125/520 注)。此处**偏离**概念图「DAG/力导向」建议的力导向那半,理由如上;非 DAG 的孤立组件用确定性网格兜底。位置全自动,`fit()` 适配视口,拖拽仅平移/缩放不改语义。

## 7. 数据源与零后端分层(诚实)

- **今日即可点亮**:席位(peers/members)、**handoff 边(`edges[]`←control.successor,今日唯一真实已填充的系统派生边)**、topology 生命周期、stall/attention、楼层 pill(worktree)、kanban/timeline(已有)。
- **数据到即自动点亮(字段就绪,渲染已写,待数据)**:派单边(`dispatchedBy` 字段仅 fixture 填充、真实 bus peer 未写,随派单器落地点亮)、任务节点 / 依赖 DAG / 验收着色 / 执行边(`projection.present` 门控,brain 投影落地点亮,与既有 jobs 视图同降级模式——缺则该层隐,不报错)。
- **需 exporter 加只读聚合**(非新服务,纯读既有文件):worktree list(楼层)、force-pipeline stages(强制边)、decision-batch(簇,次切)、gauge.json(仪表,次切)。

## 8. 范围

**v1 首切**(照概念图落地建议,得「直观理解协调」主价值):统一节点(席位 + 任务)+ 系统派生连线(依赖 + 派单 + 强制)+ 楼层 pill + attention 红点 + floorStatus 着色 + 确定性分层布局 + 优雅降级。

**v2 次切**(不入 v1):partitura→roleProfile 盖章面、Batuta 命令面板(fuzzy 搜 + 跳转 + Ask/Check)、只读共视(user 与协调者同图)、仪表叠加、decision-batch 簇、partitura 盖章 / Batuta 面板。

## 9. 安全(S21)

画布纯只读:无写、无派单/招募/盖章动作(那些是 v2 且须过既有权限门,非画布直接执行)。读 `/state.json` 不 import 模块、不回放 control-log、不重算 judgment-sink 枚举。

## 10. 协调者裁定(已批 2026-10-09)

1. **替换**:收敛三投(看板/时间线/画布),topology+jobs 两 SVG 并入画布;旧两视图藏「legacy ▾」下拉保留一个过渡版本期,确认无回访即删。
2. **允许**:纯文件读聚合入既有 exporter = 零后端本意内。v1 加读 `git worktree list`(楼层);force-pipeline 非既有只读投影文件,v1 跳过。
3. **接受**:席位+派单边+楼层+attention 先上线,依赖 DAG 门控待点亮(与既有 jobs 降级一致)。弃 force 改确定性分层=对,已知会 f32a0507(认可)。

## 11. v1 实现落点(feat/console-canvas)

- exporter(scripts/swarm-viz-export.ts):新增 `VizWorktree` + 纯 `parseWorktreePorcelain()`(自测覆盖)+ `readWorktrees()`(`git worktree list --porcelain`,best-effort 只读)+ Snapshot `worktrees[]`。
- 前端(web/swarm-viz.html):`viewMode` 默认 `canvas`;新增 `renderCanvas()`(统一席位/盒节点 + handoff/派单边 + 确定性最长路径分层 + attention 红点)、`renderFloorStrip()`(楼层 pill)、`renderCanvasJobOverlay()`(门控依赖 DAG 右叠加)。顶栏三投法 + 「legacy ▾」下拉(topology/jobs;无 brain 投影时 jobs 禁用)。
- 门:scripts tsc=0;exporter/projection selftest + swarm-projection vitest(16/16)全绿;JS node --check 通过;分层核心 DOM-free 复刻验证(含周期安全)。
- 诚实缺口:无 jsdom,**浏览器真实渲染未自动化验证**;送审需审查席浏览器实看一次。
