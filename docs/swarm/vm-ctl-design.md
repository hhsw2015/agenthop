# vm-ctl 机器管理原语 — 设计一页（S14，owner 90b58f9c，协调者已裁 + user 定位拍板）

**宪法句（user 原话拍板）**：Railway 的命令默认绑**其账号/其云**；vm-ctl 的命令只绑 **SSH 可达性**——一台机器只要 `{addr + key}` 即是合法 `Machine`，不问出身（Railway Free/GHA/任意 VPS/家里旧电脑/客户机房）。他们的逻辑，我们的主权。

目标：把 vm-ssh 升格为**后端无关**的原生机器管理命令族，承 Railway 提取（`docs/research/railway-cli-extraction.md`）落地+抽象。

## ⓪ 架构分层（终稿，user 拍板：「用户看到 agent 在跑，不知也不需知在云还是本地；分配 VM/建环境封装起来」）
- **上层=placement 引擎（user/协调者面）**：唯一动词=「要一个成员干活」（派单带 placement 偏好或全自动）；user 只见「成员出现→在干活→交付了」，**位置是账本里一个字段、不是交互里一个步骤**。位置透明：boot 完成的远程成员与本地成员在 herdr 面板/总线/派单路径上**零差别**（底=已建的 machine add + workspace-per-machine）。
- **下层=vm-ctl 命令族（封装层）**：up/ready/creds/boot/snapshot/adopt 全内化为 placement 引擎内部步骤（容量不足→自动开机装机挂载；机器到期→自动快照接棒；全程零呈面）。命令保留 CLI 形态**仅供运维/调试直呼**，日常路径不暴露。
- 一句话：vm-ctl 命令族=工程师的扳手；placement 引擎=user 的「它就是能跑」。
- **分期**：**phase-1=命令族（本单，扳手）**；**phase-2=placement 引擎**（接板准入的容量喂活 + fanout 的机器需求，届时另单）。

## ① 统一 shape + 后端接口（解耦三硬条）
- `Machine = {id, addr, backend, lifetimeSec|null, capacity, createdSec, remainingSec}`（`lifetimeSec=null`=不自毁）。
- **硬条①**：`Backend` 接口仅 `up(opts)→Machine` / `reclaim(id)` 可有供应商实现；其余命令（ready/creds/boot/snapshot/restore/forward/ssh）**一律纯 SSH 原语、零供应商 API 调用**。
- **硬条②**：`adopt <addr> [--key]`——收编任何已存在 SSH 可达机器为 `Machine`（无 up 过程、`lifetimeSec=null`、容量探测照跑）。这是「任何 VM」的字面落地。
- **硬条③**：账号只在 `up`（开新机）按 backend 需要；`adopt` 路径全程无账号。

## ② 命令族（除 up/down 全后端无关、纯 SSH）
| verb | 新/收编 | 借 / 咬合 |
|---|---|---|
| `up [--backend]` / `down <id>` | 收编 | backend 专属（仅此二者碰供应商 API） |
| `adopt <addr> [--key]` | 新 | 收编任意 SSH 机为 Machine（零账号，`lifetimeSec=null`） |
| `ls`（+就绪态列） / `ssh <id>` | 收编+ | `remainingSec` 已有 / tailcat 桥 |
| `ready <id>` | 新 | Railway `wait_until_ready`：有界超时+退避+`ConnectTimeout` |
| `creds <id> [--family]` | 新 | stdin→0600、永不 argv；Claude setup-token（硬门③） |
| `boot <id>` | 新 | 幂等 reconcile（herdr/工作区/`exec -a claude`/hook，断点可重跑）；复用 remote-bootstrap |
| `snapshot`/`restore` / `forward <id> <port>` | 新 | 穷人版睡眠 + 快照谱系（④） / Railway PortForward |
| `code [--family]` | 新 | 门面一键（借 `railway code`）：up/adopt→ready→creds→boot→machine-add 串成一条，位置透明挂载 |

## ③ 凭证硬门（审查席安全重点）
凭证经 **stdin 进 0600 文件、绝不作 argv**（argv 泄 ps）；Codex=`cat > ~/.codex/auth.json`，Claude=铸**一次性 setup token**。argv 传凭证=拒（fail-closed）；布置不回显、不入日志。

## ④ 穷人版睡眠 + 快照谱系（snapshot/restore/fork，借 sandbox template/checkpoint/fork，守宪法纯 SSH+外置零账号）
`snapshot <id>`：到期前（`remainingSec` 阈）工作区推 git 分支（或 tar）+ 写断点件（fanout resume-point）。三态：**checkpoint**=命名外置存档（穷人版睡眠）；**template**=「金」存档，新机 `restore` 还原文件系统、**跳过 bootstrap**（秒装）；**fork**=一份快照孵化 N 机（fan-out，一次装机摊到 N）。`restore <new-id> <snap>`：template 跳 boot、否则 `up`/`adopt` 新机 → `boot` → 拉回快照 → **继任协议**交棒。拼件=vm-ssh 账本+fanout 断点续+继任。快照=git 分支/tar，绝非供应商镜像。

## ⑤ 咬合 + 纪律 + 零花钱 + 解耦检验
`boot` 完成 → herdr `machine add` + ephemeral-linkage 账本；`down`/回收 → remote-recycle `sweepRecycled` 清 workspace（已签收件复用）。纯核（Machine shape / `readyVerdict` / cred-seed / boot-plan / snapshot-ref / adopt-normalize builder）+ selftest；IO（ssh/git/herdr）dormant（`SWARM_VM_CTL` 默认关）。**解耦检验（selftest 硬条）**：一个纯 sshd 容器（无任何云元数据）走全命令族（adopt→ready→creds→boot→snapshot→restore→forward→ssh）通过。零花钱可测（Free+GHA+本机 sshd）。跨家 family-aware 不绑单家。

## ⑥ 命令域全景与取舍（user 供四张 help：ca herdr 六 / ca 九 / code 门面 / sandbox 七 → vm-ctl 取舍）
- **已借**：`ca up/ssh/sleep/bootstrap/desktop`（凭证）/`forward` → vm-ctl up/ssh/snapshot/boot/creds/forward/ready；**`code` 门面**（一键新机+起家+连接）→ vm-ctl `code`；**sandbox `template/checkpoint/fork`** → 快照谱系（④，纯 SSH+外置重铸，非镜像）。
- **本期不借 + 理由**：`logs`（herdr read 已覆）、`variables/environment`（我信封已带 env、无多服务模型）、`volume`（无持久盘产品概念，穷人版睡眠用 git 外置替代）、`service/redeploy/up(deploy)/deploy(template)`（我们不部署 app，管的是 agent VM）、`domain/certificate`（无对外域名服务概念）、`connect`（无托管 DB）。
- **永不适用（宪法所排）**：`login/logout/whoami`（vm-ctl 不绑账号=解耦核心）、`link/unlink/init`（绑其项目模型）、`functions/starship/completion`（其云/CLI 糖）。
