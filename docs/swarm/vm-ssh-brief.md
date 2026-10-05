# vm-ssh:一条命令拿到可 tailcat-ssh 的 VM(独立原语简报)

## 为什么是独立原语而不是 swarm 内部件

来源:user 2026-10-04 —— "不仅我们这个项目可以用,其他项目、或者我自己的脚本也能用,
从而快速得到一台可以通过 tailcat ssh 访问的 VM。"

这是解耦审计(CORE.md)里 project↔swarm 那行 ✗ 的一次具体偿还:VM 供给流程不属于蜂群,
蜂群只是它的第一个客户。切割判据:**原语的交付物 = 一台能 `tailcat ssh <addr>` 进去的裸机,
到此为止**。仓库克隆、worker 引导、supervisor,全是调用方的事,与原语无关。

## 契约(冻结面)

一个自包含脚本 `vm-ssh`(单文件,零 swarm import,可直接拷去任何项目):

| 动词 | 行为 | 输出 |
|---|---|---|
| `vm-ssh up [--init <script>] [--key <pubkey-file>]` | 分配 Railway VM → 装 tailcat 静态二进制 → `tailcat serve --ssh-authorized-keys=<pubkey> ssh` → 捕获 tc 地址 | stdout 一行 JSON `{"id":…,"addrFile":…,"mode":"keyed"}`;地址本体只进 0600 文件,不进 stdout |
| `vm-ssh up --open` | 同上但 serve 不带 authorized-keys:**拿到地址即 shell** | 同上,`"mode":"open"` |
| `vm-ssh up --name <别名>` | 任一档都可起人话别名(唯一,重名拒绝) | id=别名;不起则自动生成短 id |
| `vm-ssh ssh [id] [-- <cmd>]` | 读地址文件并 exec `tailcat ssh <addr>`;只有一台时 id 可省 | 交互 shell 或远端命令输出 |
| `vm-ssh ls [--json]` | 列活 VM(id、档位、创建时间、TTL 余量、addrFile) | 表;--json 给脚本,逐台循环的原料 |

- `--key` 缺省用 `~/.ssh/id_*.pub` 里第一个;一个都没有就首跑自动生成 `~/.vm-ssh/key` 并 `ssh-add`——
  **keyed 档也是零操作**,"快"不需要以掉认证为代价。身份走 ssh-agent(tailcat ssh 是 exec 系统 ssh,`-i` 被拒,90b58f9c 实测)。
- `--init` 可选开机脚本,swarm 用它注入 worker 引导;别人不传就是裸机。
- 地址文件目录缺省 `~/.vm-ssh/`,环境变量可改;**swarm 调用时指到 ~/.agenthop/swarm/tailcat/**,
  消费端 node-introspect.ts(swarm-viz e533f48)契约不变。

## 寿命(平台事实,不是我们的旋钮)

**所有 VM 分配后约 1 小时被平台自动销毁,生命周期不受我们控制(user 2026-10-04 钉死)。**
两档同命;没有 `--ttl`,没有续期,没有例外。

- 没有 down:销毁全由平台自动管理(user 定)。本机侧只做账面清理——地址文件悬空后在 `ls`/`ssh` 探测时删掉。
- `ls` 按创建时间显示估算余命;到点后地址文件悬空,下次 `ls`/`ssh` 探测清理。`refresh` 救不了已销毁的 VM,只救容器内 serve 重启。
- **对调用方的硬约束:超过 1 小时的活必须按"一小时一箱"设计**——状态放 VM 外(git/对象存储),
  断点续跑,新箱 `up` 接着干。swarm 的 git 通道本来就是这个模型;你自己的脚本也照此办理。
- open 档的安全模型顺势成立:地址=钥匙,但钥匙最多活一小时。

## 连接与重连语义

- 多台点名:id 可用前缀(唯一即中),歧义时报错并列全部候选,**绝不默认选一台**;零台/多台时省 id 同样报错列清单。
- 批量:不内置 each/广播。`ls --json` 就是循环原料:`vm-ssh ls --json | jq -r '.[].id' | xargs -I{} vm-ssh ssh {} -- uptime`。
- 连:`vm-ssh ssh`(一台时免 id)。等价于 `tailcat ssh $(cat <addrFile>)`,keyed 档身份由 ssh-agent 供给,open 档无需任何东西。
- 重连同一台:**地址在 serve 进程存活期内恒定**,addrFile 不变,同一条命令连到老死。`ls` 看有哪些台。
- VM 内 serve 重启(容器重启)会生成新地址 ⇒ 旧 addrFile 失效。v1 处置:`vm-ssh ssh` 连不上时提示跑
  `vm-ssh refresh <id>` 从 Railway 日志重抓地址更新文件;不做地址跨重启固定(需要在 VM 内持久化
  tailcat 状态,等真实痛了再加)。

## 凭证与披露纪律

- tc 地址内嵌 PSK:0600 落盘、不进日志、不进命令行参数(ps 面)。
- 地址必经 Railway 日志流出 VM(捕获路径),即对 Railway 可见 ⇒ keyed 档里 **authorized-keys 门是真正的认证层**,
  地址泄露降级为"暴露了主机名",不是"暴露了钥匙"。
- **open 档(user 2026-10-04 要求,显式 `--open` 才启用)**:地址就是唯一钥匙,且它对 Railway/日志面可见。
  风险由三件事圈住:①必须显式传 `--open`,永不是默认;②平台约 1 小时强制销毁(非我们可调可免);③ `ls` 输出用醒目标记区分 open VM。适用:一次性调试/短平快实验;
  放任何有价值数据或长时间跑的活,用 keyed 档。
- 悬空地址文件在探测到 VM 已销毁时删除(ls/ssh 顺手做);凭证寿命=平台 1 小时上限。
- 观测级通道:公共 DERP 无 SLA,失联=unknown ≠ failed;正确性仍在 git 通道+dispatcher(沿用 e533f48 定位)。

## 代理层(user 2026-10-04 追加并裁定纳入冻结面)

出口自包含:用户无需手启代理、无需外部配置。新动词 `proxy up|down|status`(后台 SOCKS5,
内联 CF-Worker WS 隧道池)。`up` 的出口决策链固定为:

1. 调用方已设 AGENTHOP_SSH_PROXY ⇒ 尊重之;
2. 否则复用已在跑的内联代理;
3. 否则有 token 就自动起内联代理;
4. 否则直连。

唯一 secret(共享 worker token)不入库:读自 CF_PROXY_TOKEN 或 `~/.vm-ssh/token`(0600)。
实现基线 7e1aca4(feat/vm-ssh-primitive)。

## 不做

- 多 provider 抽象:Railway 写死,接缝只是"分配/销毁/日志捕获"三个函数在文件顶部。第二个 provider 出现那天再谈接口。
- 控制通道/键击注入:原语只交付 ssh 可达性。
- 新仓库:先住 scripts/,被第二个项目用走的那天再独立。

## 与现有件的关系

- 替代原 tailcat-box-side 板项的实现形态(范围等价,切割线外移)。
- swarm-task.sh 收口后改为调用 `vm-ssh up --init <worker-bootstrap>`,删除自己将要写的同款逻辑。
- 消费端零改动。

## v2:GHA 后端(user 2026-10-05 裁定接入;参考 ~/Work/ghostish/IMPLEMENTATION.md)

「第二个 provider 出现那天」到了。ghostish 方案=GitHub Actions runner 上起 tailcat serve ssh,
与 vm-ssh 架构同构(访问层逐字相同),差异只在供给层。按原契约启用 provider 接缝:

### 接缝形态(维持单文件)
`--backend railway|gha`(缺省 railway 不变)。provider 三函数(分配/销毁感知/日志捕获)按 backend 分派:
- railway=现行实现,零改动;
- gha=`gh workflow run` 派发 → `gh run list` 按 dispatch 前时间戳锁定 run id(防抓旧 run)→
  轮询 `gh run view --log` 捕获 `GHOSTISH_ADDR=tc...` 行(约 90s 内)。

### GHA 后端事实表(与 Railway 的关键差异)

| 维度 | railway | gha |
|---|---|---|
| 寿命 | 平台 ~1h,不可控 | **6h 上限**(runner 硬顶),TTL 可配≤360min;sentinel 文件可提前结束 |
| 费用 | 平台计费 | **user 自己的 Actions 分钟数**(私仓计额度,公仓免费) |
| OS | 平台镜像 | ubuntu/macos/windows 三选(workflow input) |
| 前置 | CPA/railway key | 一个 user 仓库装 workflow 文件(`init` 动词一次性) |
| 销毁 | 平台自动 | job 结束即灭;提前停=sentinel 或 `gh run cancel` |

### 纪律沿用+两条新增
- keyed 缺省:GHA 侧 serve 带 `--ssh-authorized-keys=<user>@github`(平台拉公钥,零 secret 传递
  ——比 Railway 侧更干净);--open 同样显式+短命警示。地址 0600 落盘、不进 stdout/argv 不变。
- **新:工作流文件入 user 仓库=持久外部写入,`vm-ssh init` 只在显式调用时做且打印将写入什么**(三门之外的透明义务)。
- **新:公共仓库禁用 --open**(Actions 日志公开可读,地址=钥匙会直接泄露;keyed 档地址泄露仅等于暴露主机名,可用但警示)。
- ghostish 文档的激进项不纳入 v2:cloudflared 公网预览(独立诉求另议)、多 OS 矩阵验收
  (先 ubuntu,macos/windows 标注未验)、agent 转发细节(ssh-agent 已是我们的既定路径)。

### 后端选型指南(user 定位 2026-10-05,写给调用方与未来的派单判断)

| 场景 | 选 | 理由 |
|---|---|---|
| 短任务/要得急/要开一群 | railway | 拿机快;配额可无限,并发不受账号顶 |
| 长任务(1h 不够用) | gha | 6h 上限;但**单账号配额有顶**(并发 runner 数+Actions 分钟池) |

- gha 并发纪律:多开吃同一账号配额,先按单账号用;**多账号支持=显式后续项**(见下),
  调用方派长任务群时要么排队要么等多账号落地,不许默认假设 gha 可无限开。
- railway 并发纪律:无账号顶,但每台仍 ~1h——长任务别硬塞 railway 靠续命,那是对抗平台语义。
- 选型自动化不做:v2 由调用方显式 --backend;"按任务时长自动选后端"等 swarm 侧有真实长任务画像再议。

### 后续项(不在 v2)
- **gha 多账号**:多 token 轮转/多 home 仓,解单账号配额顶。等真实"长任务群"需求出现再设计
  (需要谁:配额账本+token 管理纪律,涉密钥面须单独审)。

### 验收(勘误 2026-10-05:agent-forward 项撤出,见 known-gap)
- `vm-ssh init <repo>` 幂等落 workflow;`vm-ssh up --backend gha` 90s 内拿到 addrFile;
  `vm-ssh ssh` 进 shell;sentinel 提前结束;6h 自灭留档说明。
- ~~agent 转发下 clone 私仓成功~~ → **known-gap(裁定 (a),2026-10-05)**:tailcat 内置 SSH server
  不支持 agent 转发(真跑实证:auth-agent-req 发出但远端 SSH_AUTH_SOCK 恒 unset,两条路径同果)。
  该验收项与切割线(克隆=调用方的事)和排除面(不做 agent 转发细节)本有张力,系派单时从 ghostish
  文档照抄带入——撞上事实后按切割线裁决:盒要 clone 私仓时,凭证走**受支持的 secret 引用**
  (gha=`gh secret set VMSSH_SECRET -R <home-repo>`→workflow 映射为 masked env `$VMSSH_SECRET` 供 --init 读,
  零明文过 input/argv/日志;railway=既有密钥目录模式),
  属调用方领域。**--init 收窄为非敏感引导脚本**(裁定#R3:--init 内容经 workflow input 对 repo
  读者可见,"短命"不是保密传递的替代;敏感内容一律 secret 引用)。不造 socket-bridge。
- Railway 路径回归:现有 selftest 全绿(接缝改动不碰其行为)。
- 真跑一次=花钱动作(Actions 分钟),授权随本派单(user 已裁接入)。
