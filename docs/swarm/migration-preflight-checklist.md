# 迁移前检查单 v1(ACP 试点放行条件)

2026-10-14 协调者汇编。源:Carly 五门判定(handover-verdict.md)+迁移五问答卷(migration-plan-reply.md)+我方四项。放行=user。

## A. 试点席验收(单席,完整工作周期含一次真实权限弹窗)
我方四项:
- [x] Approve 点击可靠(试点实测 PASS 2026-10-15:user 带外点→态转换+门控文件真创建)
- [x] 三态检测可信(试点实测 PASS:全周期干净,waiting_input 门控期文件恒 absent)
- [x] 会话 resume 通(试点实测 PASS:Tern 内+裸 claude 双形态都记得全史=宿主无关)
- [x] 定向 Esc 拒绝通(Carly 实测 2026-10-14,见上)
Carly 侧五项(她的 Q1,[tested] 项为准):
- [ ] cx.agents:list() 可见+模型+状态轮转
- [ ] 权限路径:write 工具→waiting_input+surface 节点可见
- [ ] exited 恒空+无假忙(busy+尾哈希冻结)
- [x] **deny 路径已由 Carly 实测定论(2026-10-14 22:31,ACP 适配层 0.90.0)**:cx.session:event action-click deny 节点 ok=true 但**不解除**(12s+ 仍 waiting_input)=不可用;**Escape via send_input(pane 聚焦)实测解除**(transcript 现 refused,state 回 idle,文件未创建)。程序化 deny 标准=聚焦+Esc;后台席位需先 focus。Approve 路径她按边界不测,留试点我方项
- [ ] 席位 idle-explainer+beat 文件按节奏更新

## B. 重建配方钉死项(她的 Q2)
- [ ] 席位清单=唯一事实源;重建后对账 cx.agents:list(),不信 Tern 布局记忆
- [ ] 钉:**二进制精确路径**(zsh claude() wrapper 会藏 ACP 包装,必须显式 ACP 路径)、model、effort、cwd、resume session id、env
- [ ] 注入纪律:start 队列的 prompt 等 composer sendable,不假设即时送达
- [ ] 不依赖 daemon 重启后块自动重跑([unknown]),复活永远从清单驱动

## C. 静默失败监测位(她的 Q3,六条全要有信号源)
1. 她的巡检被悄停→carly-patrol.beat 停更(哨兵读,A2 r3 修读端合同中)
2. 席位卡权限没人应→waiting_input 驻留时长(观测台指标)
3. 假忙→哈希对比巡检(A2 已有)
4. 席位静默退出→exited 非空
5. auto_update 换件(G3 已接受风险)→装机报告行+bridge 健康+强制冒烟
6. 投影停更→她报文件过期(她的半边)

## D. 回滚程序(她的 Q4)
- [ ] 回滚前:枚举并停掉我方建的 Tern 席块(cx.agents:stop),herdr 干净起
- [ ] daemon.state 跨重启留旧 pane/块=已证泄漏面,孤儿按席位清单对账杀
- [ ] 试点前演练一次完整往返:Tern 块停→同 resume 命令回 herdr 起→上下文连续

## E. 节奏与顺序(她的 Q5+我方序)
- [ ] 渐进,一席一周期(含真实权限弹窗+一次 auto-compaction)
- [ ] 顺序:读/规划型 ACP 席先(爆炸半径小)→写重席→批量;审查席最后(会话最长)
- [ ] 自动化席与她的聊天窗**不同 session/window**(她今天被并发实验打断多次,明确要求)
- [ ] 互盯 watchdog 双向活(两 beat 都流动)后才加第二席

## F. 前置依赖(当前状态)
- [x] 桥插件装净(她侧 READY)
- [x] beat 路径双向确认(她已在写;读端合同修复=A2 r3,在修)
- [ ] A2 r3 过审(互盯读端+CPA 探针)
- [ ] 复活脚本成稿(G4 票,候写;她愿假席 dry-run)
- [ ] 席位清单全量核对(我方作业)
- [ ] 数据面:八席 resume 命令逐一验活(我方作业)

## 设计确认(她的重要发现,非缺陷)
她的 VM 调不到 bridge 四导出(plugins 表空)=**符合设计**:她的 omp 跑 --no-tools/--no-extensions,cx 导出面向窗口 VM(notebook/其他插件);她的消费路径从来是文件+snippets(§2 契约 carly.context 走 kv,boards 走文件)。已回函确认「file output 是设计,不是退化」。她的 L0 文件消费继续为正道。

## G. 冷启动协议(user 增补 2026-10-14:重启后 Tern 睁眼要会接客+恢复)

Carly 每次会话开始自动读 memory(她的原生机制)——冷启动协议=把「睁眼三问」做进她读的文件:

**G-1 睁眼读序(她的 HEARTBEAT.md 托管区=入口,M2-a 投影写)**
1. HEARTBEAT.md 四字段(蜂群状态/在途/待裁/更新时刻)→ 她 10 秒内知道大局;
2. coordinator.beat 新鲜度 → 蜂群活着?(新鲜=一切照常;过期>20min=进 G-3);
3. projects.json 注册表 → 有哪些项目、各自协调者、resume 命令。

**G-2 接客协议(用户开 Tern 先问她)**
- 「现在什么情况」→ 答 HEARTBEAT 四字段+boards(她已在看 review-board.md);
- 「X 项目怎么样了」→ 查注册表路由;冷 SID → 给 resume 命令供用户执行;
- 超出投影的deep问题 → 代发蜂群箱(她的总机职责,M2-a sender),告知用户「已递协调者」;
- 不知道=说不知道+指出哪个文件该有而没有(她的证据纪律本就如此)。

**G-3 恢复协议(发现蜂群死了)**
- coordinator.beat 过期 → 她的第一提醒职责:告知在场用户「蜂群心跳停了,恢复命令是 X」(从注册表读 resumeCmd,她不自动执行——执行权=用户或 fleet-recovery);
- 她自检:巡检任务还在吗(她被重启后 schedule 是否存活[unknown 待验])→ 不在则提醒用户重装巡检;
- TG 兜底:她停摆时 L0 告警文件路径照旧,TG 不依赖她(G5)。

**G-4 实装清单**
- [ ] 她的 MEMORY.md 写入「睁眼读序+接客协议」固定段(知识包的一部分,M2-a 合并后随知识包交付,user 亲口确认她的角色时一并生效)
- [ ] HEARTBEAT.md 托管区投影接线(M2-a 已清零候并,sweep 接线=后续单)
- [ ] 注册表生成接线(同上)
- [ ] 她重启后 schedule 存活性实验(一次 Tern 重启验证巡检任务是否还在[unknown])

## H. 试点首单结论与修订(2026-10-15,报告 ~/Work/acp-pilot-run/pilot-report.md)
- 我方四项全 tested PASS;Carly 五项 pending 她在线补跑(独立来源纪律,不代跑)。
- D 节回滚增补(FINDING-4+daemon.state 实证):**拆除顺序=①先 unlink bridge(防 link-reload 重 arm)②再 cancel 耐久任务③kill 空壳 session(关块留壳)④对账删试点造物**。
- B 节增补(F3):ACP seat 的 --model 必须用 CC 合法 model 名;非法名被 0.90.0 适配层**静默回退**——清单钉死值≠实际生效值,起席后须回读实际 model 断言。
- 工程另单:F1 CPA 探针鉴权(非-200≠DOWN,改带 key 或健康路由);F2 自治观测走 scheduled 通道(窗口循环仅前台推进)。
- 保留 Herdr 判决不变:门③多机未测+auto-compaction 未覆盖。
