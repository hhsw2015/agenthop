# 结构化裁定簿设计（R22 Top-5 末件，owner 90b58f9c）

分支 `feat/ruling-ledger`（off main `bdd93d7`）。纯核 schema+校验，dormant。**不动 PROGRESS.md**（它仍是叙事日志）。

## 目标与边界

PROGRESS.md 里散落着 R1-R26 / S11-S29 / F17-F45 的裁定引用（R=架构/行为规则、S=消息/社交纪律、F=修复/事故发现），无词表、无法按 ID 检索、无法查某条是否被取代。把它们升格为**可检索的结构化账本**：`~/.agenthop/swarm/rulings/<id>.json` 每条一文件 + `index.json` 投影。

账本是 PROGRESS 的**下游投影**，不是新权威：PROGRESS 仍是叙事源，账本按 ID 检索。两者不一致时以 PROGRESS 为准直到账本重新派生（同 memory「文档为准、索引随后」纪律）。本件只交付 schema + 校验 + index 构建（纯核）；回填全部 ~80 条、解析 PROGRESS、查询 CLI、viz 面都是后续另件。

## 裁定记录 schema（每文件一条 `rulings/<id>.json`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 规范码，`^(R\|S\|F)\d+(-[a-z])?$`（R16 / R3-b / S28-b / F45）|
| `series` | ✓ | `R\|S\|F`，须与 ID 前缀一致 |
| `title` | ✓ | 短名 |
| `statement` | ✓ | 裁定正文（一到数句）|
| `status` | ✓ | `active\|superseded\|retired`（fail-closed：必须显式，无默认）|
| `rationale` | — | 为什么 |
| `supersedes` | — | string[]：本条取代的 ID |
| `supersededBy` | — | ID：取代本条的那条 |
| `relates` | — | string[]：相关 ID（交叉链，同 memory 的 `[[name]]`）|
| `sources` | — | string[]：出处（PROGRESS 行锚 / commit SHA / 设计文档 / 审查报告）|
| `since` | — | ISO 日期或 seq |
| `by` | — | 裁定者（user / coordinator / reviewer）|

`index.json`：`{ version, generatedAtSec, count, bySeriesCount, entries:[{id,series,title,status,supersededBy?}] }`——由各记录**重建**的投影，从不手改。

## 纯核（信任边界，selftested）

- `loadRuling(input: unknown): RulingLoad` —— 整条拒绝，任一畸形（ID 不合 pattern、series 与前缀不符、status 非枚举、statement 非串、未知多余字段可选从宽）整条拒，零静默修复（镜像 `loadPlan`/`loadGrillTree`）。
- `loadLedger(records: unknown[]): LedgerLoad` —— 整簿校验：ID 唯一 + 合 pattern；series 与 ID 前缀一致；status 枚举；**交叉引用完整性**：`supersedes`/`supersededBy`/`relates` 指向的 ID 必须都在簿内，悬空引用=整簿拒（fail-closed：引用缺失裁定的账本是坏账本）；**取代双向一致**：A.supersededBy=B ⟺ B.supersedes 含 A；**状态一致**：被 supersededBy 指向的条目 status 不得为 active（取代了却仍 active = 矛盾）。
- `buildIndex(records): Index` —— 纯投影，确定序（series R→S→F，再数字，再子字母）。
- `rulingFileRelPath(id): string` —— `rulings/<id>.json`。

## IO 壳（dormant）

`rulingLedgerEnabled(env) → SWARM_RULING_LEDGER`（默认 OFF）。扫 rulings 目录、逐条读校、原子写 index、从 PROGRESS 回填——都是后续/dormant；本件不解析 PROGRESS、不写盘。

## 不变量

- PROGRESS = 叙事权威；账本 = 下游投影，从不反写 PROGRESS。
- fail-closed：一条坏记录拒整簿（不给部分信任），同全部 loader。
- 一条裁定一文件（按 ID 检索）；index 是重建投影，从不手改。
- 取代显式且双向；active 条目不得同时被取代。

## 留白（seam）

解析 PROGRESS 自动抽取（有损 NLP）=不做，账本是**人工策展**非爬取；回填 ~80 条是另一遍。编辑 PROGRESS=永不。查询 CLI / viz 面=后续另件。
