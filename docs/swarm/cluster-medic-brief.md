# 集群医生(cluster-medic)设计简报:基础设施故障的专职修复角色(user 定调 2026-10-04)

状态:**rev3**(round-2 判 0P1+1P2,唯一残留本版修;round-1 3P1+2P2,报告 cluster-medic-codex-review-495230a7;本版逐条修,标 [R1-x])。user 原话:集群故障最好有一个修复 Agent——发消息失败它就知道哪坏了、去修、再通知;确保核心机制得到实施+实时修复能力。
公司对齐表定位:**IT 运维/设施维修部**——此前空缺,修复等待的 owner 全挂协调者(协调者又成瓶颈,F23 同病)。

## 角色定义(roleProfile: cluster-medic)

**管什么(基础设施面,白名单)**:路由故障(死信堆积→诊断通道→经耐久收件箱代投→通知双方)、进程故障(dispatcher/sweep/idle-watch 死→按单活纪律+票据重启)、名册失明(I5 形态→两证据面核实→出权威判定给受影响方)、文件设施(锁残留/陈旧 tmp/presence 尸体→按 runbook 清理)、成员复活(pid 死但有在途单→按出生证 resume,接 swarm-resume 件)。
**绝不管(硬边界)**:业务判断(验收/裁定/改派决策)、契约与代码修改、成员工作内容;不可逆动作(删数据/杀有在途单的活进程)→ 三类裁决升级,照旧。
**修复纪律 [R1-P2-2 补执行绑定]**:每单修复=消费 incident → runbook 诊断(两证据面,F17)→ **先提交 repair-execution 记录**{runbook 版本,actionKind,目标,参数 digest,票据扣减}**再 IO**(R2 同款;unknown IO 结局沿同 execution 记录 reconcile 不重复执行;额度随记录扣,崩溃不重复扣不绕过)→ 恢复证据 close episode → 通知(耐久通道)。**修不了=如实升级**,不无限重试(A2 失败指纹同款:同指纹两次停)。

## 修复动作模型 [R1-P1-2]

runbook 修复步≠自由 shell:每步引用**白名单 actionKind**(restart-dispatcher/redeliver-message/clean-lock/spawn-incumbent…),由版本化 adapter 实现;执行时绑定{当前目标(messageId/pid/锁路径),参数(schema 校验),授权票据}。「按设施类别放任」不存在——routing 类不能删任意锁;歧义目标(多候选收件人等)=拒绝执行并升协调者,绝不猜。actionKind 清单+adapter 版本随注册表冻结。

## Runbook 注册表(版本化,免疫联动)

~/.agenthop/swarm/runbooks/<category>.json:{诊断步(命令/证据面), 修复步(白名单动作), 验证步(恢复证据定义)}。
**首批 runbook 直接从 F 账提炼**:F16/F18(路由/双ID)、F21/F22(消费断链)、F23(台账漏写)、F25(报备断路)、F26(死信)——**每条基础设施类 F 的「机制归宿」从此多一个标准选项:写成 runbook**。免疫流水线闭环:坑→F 账→runbook→medic 自动修→复发零人工。

## 接线(全用现成零件,一条新泛化)

- 事故源:L2 observer(死信 watch/心跳陈旧/板失联)产 incident——**依赖 20cab0a5 已更正的 incident 通用入口泛化**(groupKey+category,routing/liveness 共用 episode 生命周期;其 3/n 在做);
- 派单:incident(category∈infra 白名单)的 repair-wait **owner=medic**(不再默认协调者——协调者只收「修不了」的升级);
- **bootstrap 三接缝 [round-2 核询裁定]**:① 事故源接线:引导根的触发事实=open infra incident,其生产者**两路**——主路=L2 observer;**独立路=cluster-liveness §3 的 L2 看守**(L0 坏时直接写耐久事故记录,已有能力)——引导根读的是耐久事故面(文件),不关心谁写的,两路任一落账即触发;「dispatcher 先死且无 incident」由 L2 看守的心跳陈旧检测补位(它不依赖 L0)。② **bootstrap 准入票据**:medic 任期开工不走 dispatcher admission(那正是待修对象)——改为**预授权 bootstrap 票据**(随 runbook 注册表冻结:{允许的 actionKind 子集=修复类白名单, 额度, 有效期},引导根 spawn 时附在出生证里;medic 凭票执行修复动作,**票内动作不需要 admission,票外一律不许**——「常驻外根例外」据此扩展为「bootstrap 票据例外」,显式写明豁免的是修复白名单的 admission 而非一切准入,欠条同步);修完后若 dispatcher 已复活,后续常规工作照走 admission。③ 换任期前置保留 §3 原语义:心跳陈旧⇒先确认旧任期退出或 fencing,再 spawn 新任期——不偷锁不双活,引导根遵守与 L2 看守同款恢复权纪律。
- 宿主与 bootstrap 根 [R1-P1-3]:medic 按需 spawn——但 spawn 依赖的恰是可能坏的 dispatcher/observer(死锁)。解:**最小引导根**=系统级薄看守(launchd/cron 级几行逻辑:存在 open infra incident 且无活 medic 任期 ⇒ 按出生证直接 spawn;不依赖 bus/dispatcher/observer)。它是唯一允许的常驻外根(「谁救救火队」的显式例外,记欠条+理由);medic 自身挂死=任期心跳陈旧 ⇒ 引导根换任期(角色-任期解耦直接应用);**modelTier=standard 起步**(runbook 执行是确定性主导,诊断需一点判断;复杂事故升级协调者=变相 heavy);
- 权限:修复动作白名单+票据(重启次数/窗口),超票=升级,不自扩权。

## 核询裁定(审查期,2026-10-04)

- **① 投递恢复≠线路恢复,两事故分列**:medic 的耐久收件箱代投只 close **消息投递** incident(该条消息已达,证据=收件箱写入+消费);**原线路(bus-routing)incident 独立存续**,其恢复证据=同路由对的后续直达成功(可由 medic 主动发探测消息验证,或下一条自然流量成功)——旁路成功绝不冒充线路修复。episode 机制天然支持:同 subject(路由对)不同 category(delivery vs routing)两条 episode,各自生命周期。
- **② 死信载荷契约 [R1-P1-1 升级:messageId 贯穿 + R1-P2-1 落盘次序]**:投递事故身份=**messageId**(发送者铸造,稳定唯一),不是路由对——同路由对两条消息=两条独立 delivery incident(路由对归组会让完成 m1 清掉 m2 义务;<ts>-<to> 文件名同刻碰撞同病)。死信行={ts,**messageId**,from,to,error,preview,payloadPath};载荷文件=<messageId>.payload.json(不可变)。**次序与孤载荷语义 [R2-P2-1 rev3]**:先写载荷(fsync)再追加死信行(行存在⇒载荷必可读)。**孤载荷不是垃圾——载荷/outbox 目录本身是可扫描的权威 pending 来源**:崩溃窗口里它可能是未投递原单的唯一恢复凭据;observer/medic 扫描孤载荷(有载荷无死信行)⇒ 补索引(按 messageId 补死信行)后进正常处置;**清理只凭耐久消费证据**(已投递确认/发送者显式取消/原任务终态),绝不凭「无索引」清理。delivery incident subject=messageId;routing incident subject=路由对——两层身份两类事故,medic 重放/close 均按 messageId 对账。随本简报冻结;bus-identity v1.5 自动化。

## 验收(北极星对账)

F26 场景全自动:成员发消息失败→死信落账→observer 开 routing incident→medic 领单→诊断(目标活着但路由断)→经耐久收件箱代投→验证送达→close+通知。全程零协调者零 user;协调者只在晨报里看到「昨夜 3 起路由事故,均自愈」。
