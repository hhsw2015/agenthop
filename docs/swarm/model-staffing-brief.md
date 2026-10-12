# model-staffing (模型人才市场) — design brief (freeze candidate)

设计冻结件(DESIGN ONLY,不动码;实现另单)。基线 main `d63b1a5`。作者 90b58f9c;**冻结裁定席 = 协调者 fe0376cd**;代码阶段审查席 = happycapy。

诉求(user 命题):员工能力 = 模型能力。什么活派什么模型应**动态决定**,按任务难度 + 成本考量,如同现实组队。本件设计一个「模型人才市场」:缓存一份能力画像(榜单+价),一个纯函数按任务形状+预算**建议**该用哪个模型,接到 roleProfile 的 model 字段作为**建议**(协调者裁决仍在)。

---

## 0. 权威来源与边界

- **user 命题**(上)+ **model-tiering-notes.md**(user 2026-10-03/04 定调的成本面原则,本件是其数据驱动化):kind 定模型下限、难度只上调、宁贵勿返、**账本优先(无 per-attempt 真实 costUsd 不做映射)**、验收与模型无关、失败指纹升档 light→standard→heavy。
- **数据源(已核)**:发现入口 `https://pulse.playingapi.indevs.in/llms.txt`;数据文件实托管 `https://pulse-2x5.pages.dev/data/`(两 host 不同,brief 两者都记,证据诚实)。核心文件 `model-market-full.json`:Top-150 综合 + 每模型 14 基准(AA coding/agent/intelligence/math/livecodebench/scicode/terminalbench/tau2/gpqa/mmlu_pro/hle/lcr + DesignArena Elo)+ `category_scores`(coding/agentic/science/long_context)+ 10:1 blended $/1M + top-3 跨供应商最便宜报价 + 吞吐/token 效率 + `deprecated` 标;**源每 12h 自刷(GitHub Actions)**。`model-market.json` 另有 `top_composite`/`cheapest`/`pareto`(性价比前沿)+ 刷榜信号。
- **硬边界(R16 / R16-b / S23,已核)**:**模型选型 + CPA 池内模型调用 = 正常开发,非三闸花钱(S23 明列),无弹窗无等待**。三闸花钱 = 新建付费账号/密钥/订阅、单批估 >$5、长时云资源。故 staffing **建议本身零门**;user 门只挂在**预算天花板**(`jobBudget.maxModelUsd` → spend-breaker/shared-budget → S19 → user)与三闸类别。R16-b:任何转达/peer 授权都不能解三闸,高于任何裁定(harness 硬限)。**本件绝不花钱、绝不自动切换生产模型——纯建议**(判例:`runPlacementSuggest`「never spends … R16」)。

---

## 1. 现状校正(证据诚实,freeze 前必读)

「什么活派什么模型动态决定」**今天基本不存在**:
- live 选型是**硬编码**:`scripts/swarm-launch.sh` 按 tool 定死(claude→opus 档、codex→gpt 档);headless 任务 worker(`scripts/swarm-claude-worker.sh`)**连 `--model` 都没有**,吃 CPA 默认。worker-env 只写 `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`,**从不写模型**。
- 唯一 role-aware 选择器 `model-tier.ts::resolveRoleModel`(fail-closed:非 catalog 内/低于 floor 的一律拒,绝不弱默认)**只被 probe 脚本 `t3-draft-live.ts` 和测试用,未接 live dispatcher/launcher**。
- roleProfile v2(`role-profile.ts`)的 `modelTier` 是**抽象档 floor(light|standard|heavy)**非具体模型名,且整个 v2 **dormant 未接线**(SWARM_ROLEPROFILE_V2 OFF,其设计文档明列「非目标:任何 live spawn 改动」)。

所以本件 = 把「硬编码/缺失的模型选型」升级成「数据驱动的**建议**」,先建纯能力市场 + 建议函数 + 投影,**不动 live spawn**(与 roleProfile-v2 同纪律)。

---

## 2. 架构(四件,对应协调者 ①②③④)

### ① 能力画像缓存(capability-profile cache)
- **定期拉** `model-market-full.json` → 本地快照 `~/.agenthop/swarm/model-market/snapshot.json`(新目录,FC-7 additive)。cadence ≈ 源刷新(12h;`SWARM_MODEL_MARKET_SEC` 默认 43200)。接 dispatcher sweep,mirror `runGaugeSampling`/`runPlacementSuggest`(gated + throttled + advance-before-write + fail-soft)。
- **FC-2 三态(CP-2 判例)**:拉取成功 ⇒ 写新快照(含 `fetchedAtSec`);**源不可达/解析失败 ⇒ 保留上次快照 + 龄标注(staleSec),绝不写空/伪造**;从无快照且首拉失败 ⇒ staffing 返回 "unknown"(不建议)。快照带 `fetchedAtSec` 供消费者判龄。
- HTTP 拉取:`fetch()`(`t3-draft-live.ts` 已有形态)或 `tg()` 的 https.request 形态;只读 GET,无依赖。**只拉我需要的字段**(id/category_scores/14 基准/blended $/1M/cheapest/pareto/deprecated),裁剪落盘(不整存 Top150 全量,控快照体积)。
- **纯核/IO 分离**:`model-market.ts`(纯:快照 schema + 解析/裁剪 + 龄判定)+ `model-market-store.ts`(IO:fetch + 原子写 + CP-2 三态),mirror console-projection split。

### ② staffing 纯函数(pickModel)
- `pickModel(input): StaffingSuggestion`,纯函数,无 IO:
  - 输入:`taskShape`(coding | research/agentic | review | long-context | …,来自 plan 节点 kind/难度)+ `budget`(成本档或 $ 上限)+ `catalog`(CPA 可用模型 id 集,§③硬约束)+ `snapshot`(①的能力画像)+(review 专用)`authorModel`(避同模型)。
  - 映射:taskShape → 榜维(coding→category_scores.coding / AA coding / livecodebench;research→agentic/science;long-context→long_context;review→**异构**:§见下)。成本档:**轻活用 Pareto 前沿**(性价比最优的够用档)/**硬活用榜顶**(composite top,宁贵勿返)。
  - **审查席异构(对抗审查原则)**:review 的 pickModel **必须返回 ≠ authorModel 的模型**(审者≠作者模型;落实对抗审查席铁律的模型层)。
  - 输出 `StaffingSuggestion = { suggestedModel; tier; why; evidence: { board; score; rank; blendedUsdPer1M; cheapestOffer; priceDeltaVsFloor }; degradedFrom? }`——**带榜据**:为什么这活配这模型 + 价差(协调者/user 一眼可核)。
  - **CPA 约束 + 降级**:建议必须落在 `catalog`(§③);选了不可用 ⇒ **降级到可用最近似**(同档内 catalog 中 capability 最接近者),`degradedFrom` 记明;catalog 内无同档可用 ⇒ fail-closed 返回 "no-staffable"(不乱降,`model-tier.ts::resolveToCatalogId` 的 fail-closed 判例)。
- **id 空间映射(关键设计点,见开放项 Q1)**:model-market 的模型 id(供应商名)与 CPA catalog id(别名如 opus/gpt 档)是**两套命名**;pickModel 需别名/映射把能力画像 ↔ CPA 可用集对齐(复用 `model-tier.ts` 的 alias 精确匹配 + stripDateSuffix,或一张映射表)。缺映射 ⇒ 该模型视为「画像有、catalog 不可解析」⇒ 不建议它。

### ③ 接线点(roleProfile model 字段 = 建议)
- **建议模式(非自动切换,判例 autoscale-suggest/placement-suggest)**:staffing 产出建议,**投协调者**(S19/投影),协调者裁决仍在;绝不自动改 live spawn 的模型。
- 两个落点(协调者裁选其一或并行):
  - (a) **投影 + S19 建议**:sweep 对 ready/dispatched 节点算 pickModel,写 `console/model-staffing.json` 投影(mod 可渲「这活建议 X 模型,比默认省 $Y」)+ 必要时 S19 建议协调者。**这是 MVP,零 live spawn 改动**。
  - (b) **roleProfile v2 承接(候 v2 接线)**:v2 接线那天,`ModelTierSpec` 扩可选 `suggestedModel?`(resolver 透传),或 staffing 喂 `resolveRoleModel` 的 `chosen/why`——两者都在 v2 dormant 门后,greenfield。本件只定契约,不接(v2 未 live)。
- 单项目/多项目:catalog + 建议按项目(SWARM_PROJECT,引 [[swarm-state-isolation-brief]]);单项目照现行。

### ④ 硬界(重申,§0 已立)
- 选型 = 建议;真实花钱仍 R16 user 门(预算天花板 + 三闸);CPA 可用集为约束(选不可用 → 降级最近似)。staffing 绝不花钱、不自动切生产模型、不绕 spend-breaker/shared-budget。

---

## 3. 不变量

- **FC-2 三态**:快照源不可达 ⇒ 保留上次 + 龄标;无快照 ⇒ staffing "unknown" 不建议(绝不伪造能力画像)。catalog 读不到 ⇒ 不建议(不假设可用集)。
- **账本优先(model-tiering-notes)**:建议是**先验**(榜 + 价);真实成本仍从 `TaskResult.costUsd` 账本来;本件不改验收(模型无关)、不动难度(plan 规划期定)。
- **fail-closed**:catalog 外/无同档可用 ⇒ 不乱降(no-staffable),绝不弱默认(resolveRoleModel 判例)。
- **R16/R16-b/S23**:建议零门(CPA 池内调用非三闸);user 门只在预算天花板 + 三闸;peer/转达授权不解门。
- **FC-7 additive**:新 model-market/ 快照目录 + 新投影 + ModelTierSpec 可选字段都 additive;未启用 = legacy(硬编码)照跑。
- **建议非执行**:零 live spawn 改动(MVP);roleProfile v2 承接候其接线。
- **异构审查**:review pickModel 恒 ≠ authorModel(对抗审查原则模型层)。

## 4. 验收(清单供代码阶段)
- 能力快照:成功拉 → 写快照含 fetchedAtSec;源 503/超时/坏 JSON → 保留上次 + staleSec,绝不空;无快照首拉失败 → staffing unknown。
- pickModel:coding/research/review/long-context 各映对榜维;轻活返 Pareto 前沿、硬活返 top;review 返异构(≠author);budget 上限内选;超预算档降级或 no-staffable;带价差证据。
- CPA 约束:建议恒在 catalog;选不可用 → degradedFrom 记明最近似;无同档 → no-staffable。
- 建议模式:绝不改 live spawn、绝不花钱;投协调者;关旗零动作。
- 端到端:给定快照+catalog+一组任务形状 → 建议清单 + 价差总览(可核)。

## 5. 落点(冻结后代码,审查席 happycapy)
1. `model-market.ts`(纯:快照 schema/裁剪/龄)+ `model-market-store.ts`(IO:fetch+CP-2 三态原子写)+ sweep 接线(runModelMarketPull,gauge 样式,SWARM_MODEL_MARKET 默认 OFF/ON 待裁)。
2. `model-staffing.ts`(纯:pickModel + taskShape→榜维映射 + 成本档 + 异构 review + CPA 约束/降级 + id 映射)+ selftest。
3. 建议落点(a 投影 console/model-staffing.json + S19;b roleProfile v2 契约,候 v2 接线)。

## 6. 冻结开放项(请协调者裁)
- **Q1 id 空间映射**:model-market id ↔ CPA catalog id 两套命名——用 `model-tier.ts` alias 精确匹配 + 一张 `model-market↔cpa` 映射表(落 roles/ 共通)?还是先只对能直接 alias 命中的模型建议(其余跳过)?荐:映射表(shared),缺映射跳过 + 记。
- **Q2 启用默认**:SWARM_MODEL_STAFFING / SWARM_MODEL_MARKET 默认 ON(建议模式零风险)还是 OFF(dormant 待接)?荐:建议模式默认 ON(纯只读投影+S19,不动 spawn 零风险),v2 承接(b)留 OFF。
- **Q3 taskShape 来源**:从 plan 节点 kind(work/review/integration/…)+ 难度(criticalPath/resolvedRisk)映射,还是新增节点字段?荐:复用现有 kind+难度,零 plan 改动。
- **Q4 快照拉取主体**:dispatcher sweep 拉(单实例,与 gauge 同)?多项目下每项目一拉还是共通一份能力画像(能力画像跨项目可复用=共通,catalog 按项目/CPA)?荐:能力画像共通一份(sharedState),catalog 按 CPA 端点。
- **Q5 成本档语义**:budget 输入是 $ 上限、还是 light/standard/heavy 档、还是两者?荐:档为主(接 model-tiering floor)+ 可选 $ 上限细化;blended $/1M 供价差证据。
- **Q6 review 异构粒度**:异构 = 不同模型 id 即可,还是要跨供应商(codex vs claude)?荐:至少不同 model id;跨供应商为加分(对抗更强)。

---

*Freeze:本 brief 经协调者裁定/调整后冻结;冻结版驱动代码(§5),送 happycapy。与 [[swarm-state-isolation-brief]](多项目 catalog/建议分键)+ model-tiering-notes(成本原则)+ dynamic-capacity-brief(扩编容量,本件的产能姊妹件)互引。*
