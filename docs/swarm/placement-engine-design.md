# placement 引擎 phase-2 — 设计一页（S14，owner 90b58f9c，设计先行待裁）

目标：vm-ctl 的**上层**（两层架构 ⓪）——user/协调者只说「要一个成员干活」，引擎把「分配 VM/建环境/到期接棒」收敛成现实。头号借项=K8s controller 模式（工业先例）。北极星：零外部激活（成员自现、自愈、自接棒），位置是账本字段、非交互步骤。

## ① reconcile loop（期望态 vs 实际态，抄 K8s controller）
- **期望态**=声明式 spec：`{tier, capacity, domain} → 需要 N 台`（来源见③）。**实际态**=vm-ctl 账本（在册 Machine + 各自 capacity/health）。
- 引擎**电平触发**（收敛到期望、非边沿事件）：缺口→`up`/`adopt`+`boot`+`creds`；过剩→`down`；将到期→`snapshot`+重建（穷人版睡眠）。幂等：从任意实际态收敛到同一期望态（崩溃重放安全）。

## ② 分级健康探针（liveness ≠ readiness，CORE 两证据面）
- **liveness**=进程/VM 活（vm-ssh/machine status）；**readiness**=能接活（vm-ctl `readyVerdict` + boot 完成 + herdr machine-add + 有空闲 capacity）。**ready≠alive**。
- 处置分流：非 live→重建（reclaim+respawn）;live 但 not-ready→给时间（boot 收尾）,**不杀**;ready→喂活。单探针不定罪（F16/17）。

## ③ bin-packing 喂活（两消费者）
- (a) **板准入容量字段**（durable 成员：填到各机 `agentCapacity` 为止，不超订）；（b） **fanout 机器需求**（ephemeral：一阵并行要 N 台）。
- 期望态 N = 由这两股需求算出；装箱：活儿打包到现有机 capacity 内，需求>总容量→spawn，空闲容量>阈 过驻留窗→reclaim（滞回防抖，同 T5-5）。

## ④ 与 vm-ctl 的缝（单向）
引擎**调用** vm-ctl 命令族（up/adopt/boot/creds/ready/snapshot/down/forward）；**vm-ctl 不知引擎存在**（单向依赖：命令族=无状态扳手，引擎=唯一持期望态者）。缝即两层架构：placement=上层、命令族=下层，不回指。

## ⑤ dormant + 分期 + 不变量
- 分期：**2a=单后端 Railway Free reconcile**（期望→up/boot/ready/reclaim 一环，一个 backend）；**2b=多后端 + 成本感知装箱**（按成本/容量选 backend,CPA 预算感知）。
- 不变量：电平触发幂等 reconcile；两证据面健康；**Betabrand 预警（三态同镜像）**——`snapshot` 谱系 checkpoint/template/fork 同出一镜像，**fork 前必验 template 健康**：中毒的 golden = N 台中毒，reconcile 绝不把一个坏快照放大成坏机群（fail-closed：未验 template 不 fork）。
- 门控：spawn 只在 CPA 预算票内自批；超票=钱门归 user（R16,peer 转述不代 user 同意）。`SWARM_PLACEMENT` 默认关（dormant-ahead-of-use，同 SWARM_VM_CTL/BOARD_ADMIT）；纯核（diff/装箱/健康分类/reconcile 决策）+ selftest 先行，接线后续翻。

## phase-2b 实现（多后端 + 成本感知选择，纯核）

接 ⑤ 的分期：2b 不动 reconcile（期望态 vs 账本）与 vm-ctl 单向缝，只在 reconcile 的 backend-**无关** `{spawn,n}` 之下加一个纯选择函数，把 N 台缺口变成**按后端的 spawn 计划**。

- `selectBackends(want, options, budgetMicroUsd) → BackendSelection`：`options` 的 `backend` 复用 vm-ctl 的 `Backend` 类型（不新造接口，type-only import）。每个候选带 `costPerMachineMicroUsd`（**整数 micro-USD**，0=免费层）+ `freeSlots`（配额）+ 可选 `priority`。
- **钱不走 float（PE2B-1）**：成本/预算全程**整数 micro-USD**（1 USD=1e6 µ），预算守恒 `totalCostMicroUsd <= budgetMicroUsd` **精确整数成立**——无浮点除法尾差、无 epsilon。affordable=floor(budgetLeft/cost) 是精确整数除法；take*cost 受 budgetLeft 约束不溢出安全整数。
- **成本感知装箱**：最便宜优先铺（cost 升 → priority 升 → backend 名升，**确定性、无时间戳**——FC-6），受每后端 `freeSlots` 与 `budgetMicroUsd` 上限双重约束。
- **三面缺口是 `want` 的干净划分**：`funded`(预算+容量内可放) + `unfundedByBudget`(有容量但预算不够→**钱门归 user, R16**,引擎绝不自动超支) + `unplaceableByCapacity`(任何价都无容量) === want。
- **门控不变**:spawn 只在预算票内自批;`unfundedByBudget>0` 由**活调用方**路由到 user 钱门(R16,peer 转述不代 user 同意)。引擎只**决策**,真实花钱仍归 user。`SWARM_PLACEMENT` 仍默认关。
- 幂等/纯:同输入同输出;重复 backend 去重(首个赢,不翻倍容量);**want 须非负安全整数(PE2B-2,对齐 reconcile PE4,不 floor 不猜)**;**priority 非 undefined 时须有限数(PE2B-3,NaN/Inf 整条拒,绝不进比较器)**;非法 want/budget/option fail-closed(空计划,绝不伪造 spawn)。
- FC-7:纯函数,不碰任何 store/序列化格式(无旧记录导入问题)。
