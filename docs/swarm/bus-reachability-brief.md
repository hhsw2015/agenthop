# bus-reachability:通信问题的代码级根治(F30 机制化简报)

来源:user 2026-10-04 "通信的问题要从根本上解决"。今晚三个同根症状:
①协调者 MCP 断连后永不重连(总线聋哑整晚);②20cab0a5 出站降级,send 报 No session matches,
只能问"要不要重启";③Codex 重启后换地址+懒注册,全网找不到它(F30)。
共同根:**可达性靠会话自觉与人工重启维持,不在代码里。**

## 四个机制,全部落在 agenthop 代码层

### 1. send 失败自动降级:三层树(最重要;F31 修订)
降级树=总线→**Claude Code 原生直发**(目标是本机 Claude 成员时;F31:该通道一直可用却从未入盘)
→耐久收件箱。逐层自动、单次调用、返回值如实标注实际通道。原生直发只提速不承载独占信息,
语义仍以收件箱内容为准。
"消息=加速器,永不唯一通道"今天是**纪律**:每个 agent 手工判断 send 失败再手写 inbox 文件。
根治=把兜底放进发送路径本身:agenthop_send/push 对已知 sid 的目标失败时,**自动**写入
`~/.agenthop/inbox/<sid>/`(S11 全字段),返回值如实报 `delivered:"durable-fallback"`。
调用方永远一次调用;快慢由代码选,不由自觉选。
前提:send 的目标要能携带/解析 sid(见 3)。

### 2. 重连循环:MCP server 与总线的连接永不放弃
断连后指数退避重连(上限持续),重连成功即重新注册 presence。
"断一次聋到会话死"必须成为不可能。复用 CLAUDE.md 既有教训:每个 WebSocket 常挂 error 监听,
重连靠 close;host recover 已有同款模式,扩到 MCP 的总线注册面。

### 3. 稳定地址:sid 是身份,handle 是影子
总线 handle 内嵌 threadId,重启即换——不可修,接受它。
修的是映射:presence 注册时携带 sid(耐久收件箱 key),peers() 返回 handle+sid;
发送方可用 sid 寻址,路由层解析到当前 handle,解析不到走 1 的耐久兜底。
角色层绑定(roleId→sid)仍按 §3b 走档案,不进总线。

### 4. 开机即报到,代码做,不靠提示词
F30 报到铁律现在写在 promptTemplate(靠 LLM 自觉)。下沉:MCP server 启动/resume 完成注册后,
**自动**向协调者收件箱写报到行 {sid, handle, pid, startedAt}。提示词条款保留作双保险,
但缺它不再致盲。

## 验收(F28 同款毒丸标准)
- 拔掉中继/杀掉总线进程,send 不丢:落耐久箱,对端轮询可读,返回值如实。
- MCP 存活期间中继恢复,重连+重注册自动发生,无人工步骤。
- 重启任一会话,协调者收件箱 10s 内出现报到行;peers() 中 sid 可解析。
- 全程不新增除收件箱外的持久面;不改 S11 schema(加字段走可选位)。

## 归属与排期
bus core(core.ts/push.ts/inbox.ts)= 20cab0a5 在改面(F28 链),单编辑者纪律(F24)⇒ 归它,
排 F28 CLOSE 后、3b 之前或并轮(协调者视其负载裁)。窄审另轮。
