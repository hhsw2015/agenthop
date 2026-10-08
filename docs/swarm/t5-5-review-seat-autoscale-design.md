# T5-5 审查席队深自动扩容 — 设计一页（S14，owner 90b58f9c，协调者已过＋两修）

承 DHH 基准审 #5（`docs/swarm/architecture-review-dhh-baseline.md`）：审查席是真瓶颈，审查不可自审、成本 O（N 件）不可压。本设计让「agent 审＝随规模扩」从设计成立变实践成真。协调者已裁实现，本稿含两处批准修订（修①缩容选席／修②新席首单降速带）。

## ① 队深信号源（可观测＝耐久事实，两证据面）
- 审查请求＝耐久记录：作者送审写 `~/.agenthop/swarm/review-queue/<ticket>.<seat>.json`（SHA／作者／席／sentSec）；reviewer 终判（签收或反例集）＝原子改名 `.done`。**queue-depth ＝ open 记录数（per-seat ＋ total）**。
- 防幻深：open 记录须「作者 live × 席 live」（presence 心跳核验）；死会话孤记录按 sweep 过期清除（vm-ssh prune 同款），否则崩溃作者的孤单误拉席。
- 同构于活板（申请队＋事实投影）；observer 复用 delegation-observer 的 change-watch，无新轨道。

## ② 扩容动作（缺口 → spawn，复用容量管理器）
- 触发：total open ＞ seats × K_up 持续过防抖窗 ⇒ 容量管理器 spawn 第 N 个 codex 席。
- 出生证＝spawn 信封：roleProfile=reviewer／tool=codex／modelTier=heavy／cwd=仓根；**独立会话**（R21 对抗独立性：新席与作者、与他席互不共享上下文）。
- 角色笔记本模板＝审查员本：对抗协议（固定 SHA／反例＋阈值／0-0 签收）＋ S27／S28／S29 ＋ 诚实分类学；spawn 即带全部规章（CORE 入职）。
- **【修②】首单降速带（派单侧规则，非席位属性）**：completedReviews=0 的新席，第一单仅限 **显式** priority ≥ P2（即非 P0／P1）或小件；**优先级缺失／未知 ⇒ 拒绝（fail-closed，复判 Q2）**——降速带是安全门,无法确认低风险的单不交给未校准的席。首单过后进大件轮转。

## ③ 缩容与回收（零摩擦，地板=2）
- 条件：total open ＜（seats−1）× K_down 持续过驻留窗 且 **存在 idle 且 in-flight=0（名下 open 记录为 0）的可回收席** ⇒ despawn 该席。
- **【修①】不砍「最新席」而砍「idle 且名下 open=0」的席**（最新席可能正审半件，砍了丢上下文被迫整件重审）；都忙则不缩、等窗。地板=2（保双席并行最小形态），原两席不焚；席去无残留（笔记本／裁定进盘，知识属公司）。
- **地板语义（复判 Q1）**：地板=2 是**缩容下限**,非 top-up 触发。活席 < 地板(有常驻席崩)时自动扩容器 **hold**——补足常驻席是 roster／swarm-resume／sweep 的职责(常驻成员生命周期单一归属,F22);自动扩容器只在地板之上弹性增减,杜绝与 resume 的双 spawn 竞态。

## ④ 防抖（抖动的队列不拉席）
- 滞回：K_up ＞ K_down（带隙），杜绝临界抖动反复 spawn／despawn。
- 持续性：信号须跨窗口持续（非瞬时尖峰）；每次扩／缩后设最小驻留期才可反向动作。
- 门控：spawn 只在 CPA 预算票内自批；超票＝钱门归 user（R16，peer 转述不代 user 同意）；dormant-ahead-of-use 环境旗默认关，接线后单翻。
