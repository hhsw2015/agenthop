# 模型档位裁定(user 2026-10-05 推荐基线)

user 原话定位:「这只是我的个人推荐而已。其实 CPA 有很多模型,可以让他去选。」
⇒ 语义=**推荐基线,非封闭白名单**:实现方可在 CPA 目录内自选,但选择须满足
「与推荐同级或更强」且选择理由留痕;推荐表本身是审查时的对照基准。

## 按工种的推荐表

| 工种 | 推荐模型 | 档位语义 |
|---|---|---|
| 规划/拆解(draftPlan/expand/plan-revision) | fable 5.1 · opus 5.5 · gpt 6 astra | PLANNER-HEAVY 的解析目标;推理强度优先 |
| 编码(work/repair 执行) | sonnet 5.5 · opus 5.5 · opus 5 · opus 4.8 · gpt 6.1 sol | 性价比区间,按任务 tier 分层 |
| Review(对抗审查/验收) | gpt 6 astra · opus 5.5 | 与实施方异源优先(不同家族互审) |

## 机制要求(并入 heavy-tier-binding 单)

1. heavy 解析必须落在「规划推荐级」集合或经留痕批准的同级+模型;解析失败/目录无可用项=fail-closed 拒绝起草,不静默降档。
2. 选择器可查询 CPA 目录自选,但须输出 {chosen, why, benchmark=推荐表} 三元留痕进 worklog。
3. review 工种尽量与被审实施模型异源(防同源盲区);同源时留痕声明。
4. 推荐表数据化存放(roles/model-tiers.json 之类),更新=user 裁定,不随代码漂移。
