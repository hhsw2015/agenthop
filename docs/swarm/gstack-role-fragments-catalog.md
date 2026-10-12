# gstack 角色片段库 — 招聘目录(吸收①)

owner=aad02248 · 协调者派单(user 亲裁:把 gstack 好的吸收进来;二裁:全量 23 角色入库备选)· 分支 `feat/gstack-role-fragments` off main `a2e8d84` · 审查席 happycapy。

这是 roleProfile v2 `_fragments.json` 里 `roleFragments` 段的**人读对照表**(机读是 JSON)。承 `docs/research/gstack-eval.md` §2.6「专业分工对照表」,把 gstack 的组织图逐席改编为**我方片段**:每席 = 职责 + 把关门 + 送审物形状 + 来源文件 + 改编点 + maturity + 我方对应物。

**核心轴(不变)**:搬的是**分工税目**(谁把哪道门),不是其**执行形态**(同会话换帽子/可选 Codex/git+人类合 PR)。每席落我方时走**真独立进程 + 对抗审查 + model-staffing**;专业度(分工)× 独立性(我方)叠加 = 真公司。

## maturity 分级(诚实)

- **prime(5)**:改编精修,首批交付。= 淘金优先序 cso > designer > release-manager > doc-engineer > retro。
- **candidate(其余)**:忠实改编 + 去单会话假设,**未精修**。协调者按 §9「角色自决」选用时,据此知哪些熟哪些生。
- **库不怕冗余,怕缺**:与我方已有对应物重叠的(reviewer/eng-manager/change-control/context/spec)照收入库,注明「我方已有对应物:X,本片段供补充参考」。

## 落点与硬界

- 落点:`roleFragments` 新段入 `_fragments.json`。引擎 `loadFragmentLibrary` 只读 `instructionBlocks/skillGroups/boundaryGroups`,**无视** `roleFragments` ⇒ 零引擎改动(FC-7 前向保留),守「不动引擎」。`role-fragments.test.ts` 证其惰性(带/不带该键,resolve 结果字节相同)。
- 硬界:片段=内容库,**不动引擎(v2 dormant 照旧)**;**不新增 live 角色**(起用=协调者按 §9 自决 + user 门);本件不碰 bridge、不起真席。

---

## 全量 23 角色对照表

maturity 列:✅prime(批1已交)· ⬜candidate(批2)· 🔁候选但我方已有更深对应物(备选参考)。
「非角色」= gstack 的 infra/IO 工具,不入角色库(见文末,引 §2.6)。

| # | 我方片段 roleId | gstack 来源 skill | 职责(一句) | 把关门 | 我方对应物 / GAP | maturity |
|---|-----------------|-------------------|-------------|--------|------------------|----------|
| 1 | `cso` | cso | OWASP+STRIDE 应用模型 + 攻击面普查,找可利用缺陷 | 安全签字(每 finding 过独立挑战 + 显式覆盖面) | GAP(协调者③) | ✅prime |
| 2 | `designer` | plan-design-review + design-review | 视觉/间距/层级/AI 味审,维度 0-10 打分 | 设计签字(维度分 + 补计划/修源码) | GAP | ✅prime |
| 3 | `release-manager` | ship + land-and-deploy | 合基线/跑测/审 diff/VERSION/CHANGELOG/发布健康 | 发布门(清单作送审物,席不自 push/merge) | PARTIAL | ✅prime |
| 4 | `doc-engineer` | document-release + document-generate | Diataxis 覆盖面比对 + 生成缺失文档 | 文档门(每行为变更有文档或具名债) | PARTIAL | ✅prime |
| 5 | `retro` | retro + learn | 从记录产教训 + 跨会话复利 learnings | 复盘门(教训从记录生成,非凭感觉) | GAP(借②) | ✅prime |
| 6 | `ceo-founder` | plan-ceo-review + office-hours | 重想问题,找 10 星产品(四模式:扩张/选扩/守界/缩减) | 产品/战略门(值不值得做) | GAP(grill-gate 是通用对抗树,无专产品席) | ⬜candidate |
| 7 | `eng-manager` | plan-eng-review | 锁架构/数据流/边界/测试,逼出隐藏假设 | 架构/工程合理性门 | 🔁我方已有:对抗审查席(codex:happycapy,真独立)+round-doctor,本片段供补充 | ⬜candidate |
| 8 | `staff-reviewer` | review | 找过 CI 但炸生产的 bug,门完整性(具名被削弱测试) | 工程审查门(生产 bug + 简化透镜) | 🔁我方已有:对抗审查席,本片段供补充(「每门强制双声」纪律借此) | ⬜candidate |
| 9 | `devex-lead` | plan-devex-review | DX 计划审:persona/TTHW/magical moment/摩擦点 | DX 计划门(20-45 逼问) | GAP | ⬜candidate |
| 10 | `devex-tester` | devex-review | 实测 onboarding/getting-started/TTHW 计时截图 | DX 现场门(对照计划分=回旋镖) | GAP | ⬜candidate |
| 11 | `qa-lead` | qa | 探 browser/API/CLI/job/webhook,复现 bug 写回归再修 | QA 门(先失败回归再修再验) | PARTIAL(tests/selftest-CI,无驱真产品 QA 席;可接 herdr) | ⬜candidate |
| 12 | `qa-reporter` | qa-only | 只探只报,可重放证据,建议回归不改码 | QA 报告门(报告-only) | PARTIAL | ⬜candidate |
| 13 | `debugger` | investigate | 系统化根因(铁律:无调查不修;3 次失败即停) | 调试门(数据流追踪 + 假设验证) | GAP(debugger 是全局 agent,非蜂群席) | ⬜candidate |
| 14 | `sre-canary` | canary | 部署后监控环:console 错误/性能回归/页面失败 | 发布后健康门 | PARTIAL(dual-bandwidth 是吞吐非页面健康) | ⬜candidate |
| 15 | `perf-engineer` | benchmark | 基线页面加载/Core Web Vitals/资源大小,PR 前后对比 | 性能回归门 | PARTIAL(round-doctor 是审查健康,非 web 性能) | ⬜candidate |
| 16 | `eval-planner` | eval-plan | 付费 eval 预注册:bars/arms/decoys/stop-rules + $0 dry run + 三项试点 | eval 支出门(试点外推 gate 批准) | 🔁我方已有:mirror-13 orchestration eval 引擎,本片段供补充 | ⬜candidate |
| 17 | `spec-author` | spec | 模糊意图→可执行 spec(五相位 why/scope/technical/draft/file) | spec 质量门(外审 ≥7/10 才归档) | 🔁我方已有:task brief/TaskPlan,本片段供补充(五相位结构可借) | ⬜candidate |
| 18 | `test-auditor` | test-audit | 扫低价值/重复/无断言/test-only-export 测试 | 测试卫生门(证据卡,批准才删) | PARTIAL(selftest-CI/coverage) | ⬜candidate |
| 19 | `shared-code-reviewer` | deslop-shared-libs | 找共享代码抽取机会,比至多 5 推 3(带证据) | 抽取建议门(仅建议) | GAP | ⬜candidate |
| 20 | `design-partner` | design-consultation | 从零建设计系统,研究 landscape + 产 mockup,写 DESIGN.md | 设计系统门 | GAP(可折入 designer,独列为备选) | ⬜candidate |
| 21 | `design-explorer` | design-shotgun | 产 4-6 mockup 变体,浏览器比较板,taste 学习迭代 | 设计探索门(taste memory) | GAP | ⬜candidate |
| 22 | `design-engineer` | design-html | mockup→生产 HTML(动态布局,零依赖,slop-gate) | 设计落地门(可发非 demo) | GAP | ⬜candidate |
| 23 | `change-control` | careful + freeze + guard | 破坏性命令 ask/deny + 目录锁编辑 | 变更控制门(unparseable fail-closed) | 🔁我方已有(收敛):approval-delegation+sanitized-read+FC-2,本片段供补充 | ⬜candidate |

**我方更深、不借其形态(列入对照,不入片段库)**:`autoplan`(编排=我方 dispatcher+coordinator,耐久/分布式/sweep)、`context-save/restore`(=我方 succession/handoff,身份连续+adopt 锁)、`codex//claude-code`(第二意见=我方常设对抗席,真独立进程)。其中 `change-control`/`spec`/`eng-manager`/`staff-reviewer`/`eval-planner` 虽我方已有,仍入库作备选参考(user:库不怕冗余)。

**非角色 = infra/IO 工具(8,引 §2.6,不入角色库)**:browse/scrape/skillify/diagram/make-pdf/pair-agent/open-gstack-browser/gstack-upgrade/setup-*/sync-gbrain/setup-gbrain + iOS 全家 + openclaw 子包 + 独立二进制(gstack-egress/wtree/review-log/evidence/context-bill…)。对表我方 bus/relay/herdr/vm-ctl(基础设施,相反轴)。

---

## 交付批次

- **批1(本次)**:schema(`roleFragments` 段)+ maturity 字段 + 5 prime 片段(精修)+ 本对照表(全 23)+ `role-fragments.test.ts`(shape + 引擎惰性)。
- **批2(次次)**:#6-23 candidate 片段(忠实改编,去单会话假设),含我方已有对应物注记。

证据诚实:gstack 自称「23 specialists + 8 power tools」,其 specialist 表实为 ~30 条 persona 化 skill(含若干其实是工具)。本表按**公司职能**合并同族(designer=5 skill 合 1、release=2、doc=2、retro=2),得 23 个**角色**席 + 一组工具,与 §2.6 一致。来源版本号见各片段 `source` 字段。
