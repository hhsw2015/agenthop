# Railway CLI 逻辑提取 — 最大化零花钱 Free VM（S14，owner 90b58f9c，2026-10-08）

源：`github.com/railwayapp/cli`（Rust，semble 索引精读 `railway ca` 族）+ `docs.railway.com/cloud-agents/herdr`（行为参照）。目标：不买产品、拆逻辑、收益落零花钱 Free VM（vm-ssh + 远程视图单）。纯研究零花钱：**未起任何 VM**。

## 结论先行
三块可直接借：① 凭证经 **stdin→0600 文件**（永不进 argv）——补我远程视图④安全面的成熟参照；② 编排顺序 `known_host → wait_until_ready（就绪探测）→ machine_add` + 通用退避重试 + ssh `ConnectTimeout` 防黑洞挂死——补我 bootstrap 容错；③ `ca bootstrap`=「捕获运行中 VM 配置供新 VM 复用」+ sleep=「留盘弃进程」——我 Free VM 留不住盘，等价=**状态外置+重建**（穷人版睡眠，拼 vm-ssh 账本+fanout 断点+继任）。

## ① 凭证自动布置（→ 远程视图④安全面）
- **Codex**（`CODEX_SEED` code.rs:863）：`mkdir -p ~/.codex; cat > ~/.codex/auth.json`——凭证**走 stdin 进 0600 文件、绝不作 argv**（argv 会泄进 ps/进程表）。这是我④缺的关键纪律。
- **Claude**（`ca start` 注「Claude can mint a setup token」）：用**铸一次性 setup token**、非拷原始凭证（token 可短命，泄露面小）；`claude_credentials_cheap(refresh_auth)` 走凭证面。
- **配置开机 reconcile**：Codex 的 folder-trust/approval_policy/sandbox_mode/MCP 由 express-agent **每次开机 reconcile** 进 `~/.codex/config.toml`（幂等收敛、非一次拷），hooks 来自镜像 `/etc/codex/requirements.toml`。
- **SSH 配置自动写**（`ca desktop`）：写 OpenSSH block + Claude `sshConfigs` + Codex 声明式 import；relay 目标 `agent:<env>:<name>@ssh.railway.com` **按名解析、VM 重建后仍有效**。
- 借（落 boot-template/④）：stdin→0600 凭证纪律、Claude setup-token 替原始拷、config 开机 reconcile（幂等）、name-resolved ssh 别名（抗 VM 重建、胜我 addrFile 存原址）。

## ② 远端 herdr 编排 + 容错（对我 bootstrap 逐步对表）
顺序（`herdr/new.rs:129`）：`ensure_relay_known_host()` → spinner → `relay::wait_until_ready(agent)`（**就绪探测**）→ `herdr.machine_add(target,label)`。
- 容错：`util/retry.rs retry_with_backoff(RetryConfig{max_attempts,on_retry,delay_ms})` 通用退避；`code.rs:2082 BACKOFF_SECS[attempt-1]` 分级退避；**host-key 漂移 → heal 不等待**（wait=0）；`ssh/native.rs` 初次连接 **ConnectTimeout 有界**（「黑洞连接永挂；ServerAliveInterval 只管已建会话」）。
- 对表我 bootstrap：我现序=curl 安装 + probe，**缺**：machine_add 前的显式就绪闸、初连 ConnectTimeout、退避重试。三者直接借。
- 判：我强=boot-template 纯函数可测 + ephemeral-linkage 账本；他强=就绪探测/退避/连接超时三件容错 → 借入 remote-recycle/bootstrap 的 IO 层。

## ③ 睡眠-唤醒 + 穷人版睡眠（供立项）
他：`sleep`=留盘弃进程，`wake/connect` 续；`ca bootstrap save/default`=捕获 VM 配置（含 repo 配置）供新 VM 复用（**配置级、非全盘镜像、便宜**）。

**我 Free VM 约束**：一小时自毁、不可改、无持久盘 → 留不住盘，只能**状态外置+重建**。

**穷人版睡眠（拼现成三件）**：
- 到期前（`vm-ssh ls` remainingSec 低于阈）→ **快照外置**：工作区推 git 分支（或本机 tar）+ 写断点（fanout 断点续：做到哪步/下一步/依赖）。
- 下次 → `vm-ssh up` 新免费机 + boot-template（含 railway 式配置捕获免重配）+ 拉回快照（git clone 分支/untar）+ **继任协议**把活交给重建机的 agent、按断点续。
- 件：vm-ssh 账本（VM+remainingSec 触发）、fanout 断点续（resume-point）、继任协议（交棒）、railway bootstrap-capture（配置级快速重建）。
- 等价对照：他 sleep 留盘=我 git 外置；他 wake 续=我新机+快照还原；他 bootstrap-capture=我 boot-template+配置清单。**穷人版用「外置+重建」换「留盘」，免费机足够**。

## ④ 其他可榨（逐条 借/不借 + 落点）
| 件 | 官方 | 借/不借 + 落点 |
|---|---|---|
| 就绪探测 | `relay::wait_until_ready` + `probe_native_ssh` | 借 → vm-ssh/bootstrap，machine_add 前闸 |
| 退避重试 | `retry_with_backoff` | 借 → vm-ssh up / ssh 包一层 |
| 连接超时 | ssh `ConnectTimeout` 有界 | 借 → ssh-bridge Host 加 ConnectTimeout |
| 端口转发 | `PortForward`/`run_native_ssh_forward` | 借（需时）→ 远端服务/日志取 |
| 会话 resume over ssh | `ca ssh --session/--resume` | 已有（swarm-resume）；互补 |
| name 解析目标 | `agent:<env>:<name>@ssh` 抗重建 | 借 → vm-ssh 名别名胜存原址 |
| 日志流 | 未见显式 | 不借（herdr read 已覆） |
| 项目/env 管理 | `with_default_variables`（SHELL 等） | 不借（我信封已带 env） |

## Free VM 增强方案（立项建议）
立一单：`vm-ssh snapshot/restore` 原语（git 外置工作区 + 断点）+ 到期触发（remainingSec 阈值）+ 继任交棒 = 穷人版睡眠。并把①②四件借入强化远程视图 boot-template：stdin-0600 凭证纪律、Claude setup-token、就绪探测、退避 + ConnectTimeout。全部零花钱（免费机 + 外置存储）。

跨家：凭证纪律/就绪探测/退避/超时落 vm-ssh + bootstrap IO 层，不绑 claude——Codex 走 stdin-0600、Claude 走 setup-token，**family-aware 但不绑单家**（同 remote-bootstrap 的 exec-a-claude 分支处理）。杠杆序：① stdin-0600 凭证（安全硬需，小）② 就绪探测+退避+ConnectTimeout（容错，小）③ 穷人版睡眠立单（中，解 Free VM 一小时墙）。
