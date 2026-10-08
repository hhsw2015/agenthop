# chat-room 后端 审查包 round-3 → 01a0ff49

> ✅ **已签收** 审查人 `codex:happycapy-01a0ff49` @ 代码 `74e9732`（2026-10-07）：**0 P1、0 P2、0 P3,0 nit**。25/25 探针（17+8）。
> 链：689ee16 v1 → 1c951f6（round-1 五项 + 限流）→ **74e9732**（round-2 三 P2 + nit CLOSED）。签收范围=纯核 + 文件 IO + 限流
> 部件 + 冻结契约；**merge/push/install/端到端上线仍属独立批准门**（未并未推未部署）。

分支 `feat/chat-room`，范围 `c3439cd..74e9732`（代码）+ 本包。round-2 判决=0 P1/3 P2+1 nit，本轮全修。stopSet：已提交分支，未并未推。fixOwner f32a0507。源 `~/Dev/agenthop-wt/chat-room`。验证：`vitest run` → 79 files/1020 green;`tsc -p tsconfig.json --noEmit` → 0；审查人原 17 探针 + 新增 8 边界探针对本修 **25/25 PASS**（重指向 src 复跑）。

## round-2 三项 + nit → 修法 → 测试
| 条 | 修法 | 测试 |
|---|---|---|
| CR-P2-1 规范化未落盘 | writeMeta 落 `validRoomMeta` 的**规范化结果**（owner 入名单、去重），文件本身满足冻结不变量，非仅读投影 | store「putMeta persists NORMALIZED meta」;probe META-NORMALIZATION |
| CR-R2-P2-1 回执写失败仍消耗去重位 | admit 不再置 notifiedAt;postToRoom **仅在回执写成功后** markNotified；写失败留位（后续拒绝补发）且仍返回 throttled（不抛不静默） | rate「without markNotified notify 仍 DUE」;store「failed receipt… re-sends」;probe RECEIPT-FAILURE |
| CR-R2-P2-2 非法配置 NaN/绕过 | 构造器校验 limit（正整数）、windowMs（正有限），否则抛；无 NaN retry、不静默关限流 | rate「invalid config rejected」;probe INVALID-LIMITER-OPTIONS |
| nit CR-N1 窗口描述不符 | 统一文档+注释为**滑动窗口**（逐帖按 `t>now-windowMs` 剪枝）;rate 模块/契约/packet 一致 | probe OBSERVE-ROLLING-NOT-FIXED-WINDOW。**此项新 SHA 74e9732 核销，changed-line 哈希=该提交**，不另开轮 |

## round-1 四项（已 CLOSED，保持）
CR-P1-1 roomId 安全拒绝 · P1-2 尾行补 LF 不吞帖 · P1-3 ENOENT≠读错（EACCES 抛拒写）· P2-2 ts=nowSec*1000。原 17 探针仍 17/17。

## 自标（沿用，仍请裁）
单 owner 不变量(v1);appendPost O(n) 重读（不缓存保崩溃重读）；扇出 best-effort 返 fannedOut；中段损坏行跳过；dispatcher 接线留缝；限流窗口 in-memory（重启重置）。

## DEFERRED（非 v1）
回合/公平栅栏 · 房内审批 · 附件做房间对象 · reply 树 · 跨进程并发写 · 排队延发式限流。
