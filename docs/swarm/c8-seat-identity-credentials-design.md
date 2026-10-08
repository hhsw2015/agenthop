# C8 席位身份铸造 + 能力凭证 — 设计一页（S14，owner 90b58f9c，设计先行待裁）

目标：在代码层关死 F40 漂移族（身份=CLI 自报线程 ID，重启即变）+ R16 转述洗白族（peer 转述≠授权）。复用现成两件，不另造第二套身份：`mint.ts`（HS256 HMAC 凭证，已在 CPA eph-token 轨证）+ `bus-identity.ts`（entityId/别名表/legacyInboxKeys）。参照 Paseo agent-manager（协调者铸 agent ID）/ Hermes subagent_lifecycle（出生即发凭证）同构。

## ① 铸造席位身份（协调者铸造 UUID，非自报）
- 出生证/spawn 信封新增 `mintedId`（dispatcher 侧 randomUUID,**非 CLI thread ID**）+ `idToken`=`HMAC(secret){iss:"id",sub:mintedId,iat}`。spawn 即随信封发放，节点持 idToken **自证**（持签名凭证证明「我确是协调者铸的 mintedId」，非裸声称 UUID）。
- 节点 announce 带 mintedId 作 `form:"minted"` 的 **hard** claim（源头=铸造事件，非自造/猜测）。bus-identity 的 entityId **优先锚定 mintedId**（有则用，无则退回现有 （run,generation） 自造键=未铸造常驻成员向后兼容）。
- F40 根治：mintedId 跨重启/新线程**不变**（铸一次、随信封持久）；句柄与回信 from 都归并到它；legacyInboxKeys/resolvePeer 的 native 锚用 mintedId 替易漂移 thread-ID。

## ② 能力凭证（HMAC,dispatcher 持密钥）
- 泛化 `mint.ts`：`cap`=`HMAC(DISPATCHER_SECRET){iss:"cap",sub:mintedId,act,exp,nonce}`。act 枚举：vm-spawn / three-gate-proxy / board-admit / seat-spawn。
- 授权动作执行点（vm-ssh up / 代行三门 / spawn / 板准入）**先验凭证**：alg=HS256 + HMAC 核验 + iss=cap + sub==调用者 mintedId + act 匹配 + exp>now；缺/错/过期=拒。
- **结构性防洗白（R16）**：凭证仅 dispatcher（持密钥）签发；peer 转述「user 批了」**天然不带 cap**=验不过=拒。密钥绝不下发节点（同 eph-secret 纪律：dispatcher 侧 readEphSecret,never inject）。
- **三门硬界不变（我方立场）**：cap 只证 **dispatcher 授权，非 user 授权**。钱/外发/不可逆三门，dispatcher 仅在**真 user 门过后**才签对应 cap;cap 是执行层强制，user 门仍是签发前置，cap≠绕过 user。

## ③ 与寻址栈融合（不另造身份）
- mintedId 作 bus-identity 一等 claim form,entityId 锚它；legacyInboxKeys/resolveInboxTarget **接口不变**,native 锚换 mintedId（有则）。alias-log 记 minted claim（hard/源头=mint 事件）。cap 的 sub=mintedId=同一身份；whois 可展「minted 身份 + 近期 cap 签发」。

## 边界/诚实
- cap 验证是**静态 HMAC**,v1 无在线吊销；吊销=短 exp 兜回收 + 轮换密钥（同 eph-token TTL），不做 CRL。
- 跨机：minted claim 先作本机 envelope（同 bus-identity round-2 边界，不扩网络帧），跨机身份归后续。
- **纯库 + selftest 先行，接线 dormant 默认关**（签发点 + 验证点两处接线是后续翻转，同 SWARM_BOARD_ADMIT）；接线前不改既有运行时。
