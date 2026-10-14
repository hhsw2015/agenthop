# tern-adoption 并行四线:契约先行(开发前定稿)

- 日期: 2026-10-14;协调者 fe0376cd;user 令「前期设计好,不返工」
- 教训依据: TG 桥 15 轮复盘=契约漂移+共享文件碰撞;对策=contract-first+early-split(本页即两对策的执行)
- 效力: 本页四节各为一线的**冻结契约**;实现偏离契约=返修;改契约=先回协调者

## 0. 全局互斥表(early-split,先钉死谁碰什么)

| 线 | 可写路径 | 禁区 |
|---|---|---|
| ① A4/A5 | tern/board/**(新)+~/.agenthop/carly/review-board.md、runbook-board.md | tern/bridge/** tern/patrol/** |
| ② A6/A8 | tern/exports/**(新)+~/.agenthop/carly/canvas-snapshot.md | 同上+board 文件 |
| ③ B3/B4 | tern/ledger-proj/**(新)+~/.agenthop/carly/ledger.db、notebook/** | 一切 tern/ 其他子目录 |
| ④ B1 | 只写 ~/Work/acp-verify/**(实验证据);零产品文件 | 全部产品树 |
- 公共只读:PROTOCOL.md(@5be85ea 定稿,任何线不改);durable 全家(inbox/PROGRESS/rulings/review-reports)只读
- alerts 目录唯一写者=A2 哨兵(已交付);四线只读

## 1. 线①契约:board 两卡(A4+A5)

**数据流向(单向)**: durable(review-reports/ACTIVE-QUEUE+merge-pool 事实)→ 生成器(纯函数)→ board md 文件。board=投影,**绝不是事实源**;人工在 Tern 里拖卡不回写蜂群账(v1 明确不做反向同步,防双写)。
**泳道**: Queued/Reviewing/Needs-human/Merged(Carly 实验③形态)。卡题=`<件名> @<SHA7> [<席>]`;卡 id 由生成器按内容哈希稳定派生——**规避 Carly 实验④发现的「删卡重建 id 变」**:生成器全量重写文件,不做增量编辑。
**A5 runbook 卡**: 五子任务(merge-pool/regen-presence/gates/arch-review/ff-main-install);每步勾选条件=artifact 存在且 mtime 晚于上步(check 纯 Lua,A2 哨兵同款模式);artifact 路径表进卡片备注。
**验收**: 三夹具(生成器幂等重跑字节同/半写崩溃重启不坏/两实例并发单赢)+与真实 review-reports 快照对拍。

## 2. 线②契约:冷启动画布+导出四组(A6+A8)

**A6**: canvas 内容=摘要+指路(每条带 durable 文件路径),**事实永远在文件**(Carly 问⑥原话采纳);Markdown 快照 canvas-snapshot.md 与 canvas 同步双写,**快照为准**(画布跨重启未证=V3);更新=A2 同款 1m check 或显式刷新命令。
**A8 v1 只做观测组**(信使/账本/呈批组后续批):
```
swarm_status() -> {seats:[{id,title,herdrState,inboxDepth,task}],ts}
swarm_queue() -> {reviews:[{item,sha,seat,round,state}],ts}
swarm_progress(n) -> {cycles:[{num,title,lines}],ts}   n<=20
swarm_flags() -> {flags:{name:on|off|dormant},ts}
```
- 全只读;数据源=herdr CLI+durable 文件;**16KiB JSON 上限**(文档限制)⇒每函数带截断字段 truncated:true
- 签名冻结:改签名=回协调者。tern.carly.export 注册,sig/doc 齐全
**验收**: 导出经 Carly 真调一次(人话问答截图/transcript 留证)+16KiB 边界夹具。

**§2 增补(#869 缺口审计,协调者修约)**:
- **A8+context**: `tern.carly.context(fn)` 注册一行蜂群状态(「在审N|候裁M|告警K」,≤400 字符,4ms 预算,读 kv 缓存不现算——由巡检/导出写 kv,context 只读);
- **A6+route**: `tern.route.link` 接管 `swarm://` 链接:v1 只做两型 `swarm://pane/<herdr-pane-id>`(cx.layout:focus 跳席)与 `swarm://file/<path>`(cx:open 打开 durable 文件);board/canvas 产出的引用一律写成 swarm:// 链接。未知型显 toast 不吞错。
两项签名即此,实现偏离=返修。

## 3. 线③契约:账本投影+notebook 晨报(B3+B4)

**B3**: 方向=verification-ledger(已上线 dormant)JSON→SQLite **单向导出**;表 schema:
```sql
reviews(sha TEXT, item TEXT, seat TEXT, rounds INT, outcome TEXT, usd REAL, ts INT);
-- v1: outcome/usd 恒 NULL(无结构化源,不伪造 join;候 review-current 索引/tasklog 账接入)
batches(batch TEXT, shas TEXT, merged_ts INT);
-- v1: batches 源=git 派生(批次 merge 提交+工件提交)或空表,实现者择一并声明
```
- **并发写未验(Carly 警告 WAL/锁)⇒v1 规避而非解决**: 唯一写者=导出脚本(cron/手动),Tern 的 sqlite 块只读打开;文件写完 rename 原子换
**B4**: notebook 单元=读 db+morning-digest 产物,输出表格;**不引入新事实计算**,晨报数字以 morning-digest 为准,notebook 只呈现
**验收**: 导出幂等(重跑同字节)+db 只读打开验证+notebook run(all) 两次结果一致。

## 4. 线④契约:B1 ACP 三门验证(纯实验)

**三门逐条**: ①Codex ACP 块=Claude 同款实验(权限请求→state/surface 三态表);②wait() 实调:ACP 块跑短任务,cx.agents:wait 真调记返回值与耗时;③ACP 形态下会话恢复(resume 历史在不在)+CC hooks 触发否+/命令可用否。
**方法约束**: 全程不批权限(挂起即测量,deny 收尾);每门给「测得/未测得+原始值」;与 Carly #848 实验对照表并排。
**产出**: 实验报告 ~/Work/acp-verify/report.md,S11 投协调者。**此线结果决定 omp 席/ACP 席形态,是第三批的门**。

## 5. 审查序(吞吐独木桥,定死)

A1 双声(最急,已在审)→①→②→③轻审(投影件)→④实验报告轻审。各线错峰交付;审查席过载时后交的线等,不并发挤。
