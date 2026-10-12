# decide — 决策批生产 runbook(协调者侧)

北极星差距③:decision-batch 后端 + `console/decisions` 投影 + swarm-console mod 呈批卡**各组件均已落地**,但生产端缺一个口子——协调者凡向 user 呈批的事项(启用旗、立项裁点、风险签字)应**落 decision-batch**,而不是只写进 PROGRESS 散文。`scripts/decide.ts` 补上这个生产口:它是 `openBatch`(已签 store 写面)的薄前端,**零新 store 写面**。

**已实证到的链段**:`decide submit → openBatch → writeConsoleProjection → console-decisions/v1 信封 → decide list / mod 卡片渲染`(隔离库 + 真会话 tmux)。**尚待真会话验收**:数字键→面板原生焦点→user 发送→入库,以及协调者的业务执行——"组件已在"不等于"整条原生交互链已验收"。

三个分开的角色:**生产(decide)/ 消费(consumeDecisions 读回 user 裁决并返回 `{resolved, undecided, unknownIds}`)/ 业务执行(协调者据 `actionable(resolved)` 动手)**。`decide` 只做第一个。

## 全链

```
decide submit  →  openBatch(已签)写 ~/.agenthop/console/decision-batches/<id>/batch.json
               →  sweep 的 writeConsoleProjection 镜像到 ~/.agenthop/swarm/console/decisions/<id>.json(信封 console-decisions/v1)
               →  swarm-console mod 渲呈批卡(/swarm 面板)
               →  user 数字键预填答复、自己发送
               →  consumeDecisions(已签)恰好一次读回裁决,返回 {resolved, undecided, unknownIds}
                  (resolved 含 approve/reject/**defer**——defer 是显式"稍后再问"也算已决,留在 resolved;**无独立 deferred 字段**)
               →  协调者对 actionable(resolved)(= resolved 滤掉 defer)执行业务动作(启用旗/立项/签字),
                  把 undecided + resolved 里的 defer 重新组批
```

`decide` 只做**第一步(生产)**。消费(consumeDecisions:读回裁决、返回 `{resolved, undecided, unknownIds}`;`actionable(resolved)` 选当前要执行的 approve/reject,**不替协调者执行业务**)与投影(writeConsoleProjection,在 dispatcher sweep 内,SWARM_CONSOLE 默认开)都已在,不归 `decide`;业务执行归协调者。

## 用法

```bash
# 提交一个批次(items 文件或 - 读 stdin);owner 必填(= 你的协调者身份)
npx tsx scripts/decide.ts submit <file|-> --owner <coord-sid> [--notify <inbox>] [--batch-id <id>]

# 看 store 里有哪些批次
npx tsx scripts/decide.ts list
```

- `--notify <inbox>`:可选,给某个收件箱发一条"N 项待裁"的耐久 ping(走已签 notifyOnce,恰好一次)。不传则只落 store,靠 mod 面板被看到。
- `--batch-id <id>`:可选,幂等键。省略则生成 `batch-<hex>`。同一 batchId 再 submit 是幂等 no-op(绝不重置已存批次)。
- `--home <dir>` / `AGENTHOP_HOME` / `AH_HOME`:覆盖家目录(测试/沙箱)。
- 退出码:0 成功 · 2 用法/输入错 · 1 意外。

## 输入 JSON

一个**裸 items 数组**,或一个对象 `{ owner?, notifyTo?, batchId?, items:[…] }`(flag 覆盖对象里的 owner/notifyTo/batchId)。每个 item:

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 批内唯一(重复 id = 歧义,整批拒) |
| `kind` | ✓ | 类别标签(如 `呈批`) |
| `summary` | ✓ | 一行决策摘要(卡片标题) |
| `suggestedAction` | ✓ | 建议动作(卡片"建议:"行) |
| `evidenceRef` | | 证据指针(卡片"证据:"行) |
| `hardGate` | | `true` = 硬门:user 只能 approve `once`(无 this-chat/always 宽 scope)。启用旗/风险签字/外部副作用用它。 |

每个 item 过**已签 `validDecisionItem`**(零新解析);任一非法或重复 id ⇒ **整批拒**(绝不写半截批次)。

**A/B 二选一**映射:decision-batch 是逐项 approve/reject/defer,不是 A/B 选择器。把"落点 A vs B"写成一个 item,`summary` 点明两选项、`suggestedAction` 给推荐项,user approve=取推荐、reject + reason=取备选;或拆成两个互斥 item 由 user 各裁。

## 首个真实批次(闭环首跑)

`docs/swarm/decision-batch-first-draft.json` 是当前在挂 user 门清单(TG 桥 token / 语音 Phase2 / T5-1 / 隔离动码时机 / skill 落点 A·B)的**草案**。**措辞是草案,须协调者核**——这些卡片会原样呈给 user。核定后:

```bash
npx tsx scripts/decide.ts submit docs/swarm/decision-batch-first-draft.json --owner <coord-sid>
npx tsx scripts/decide.ts list      # 确认入库
# 在跑 swarm-console mod 的会话里 /swarm 看卡片渲染
```

## 边界

- `decide` **只写批次**(经已签 openBatch),不消费、不执行、不替 user 发答复。
- mod 侧只**预填**(user 自己发送);`decide` 侧只**生产**。两端都不代 user 决策。
- owner 必填且为协调者身份:批次的主语是"谁向 user 呈批"。
