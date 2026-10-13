# pstack-claude 深评(镜二十三)

- 对象: michael-denyer/pstack-claude(~1.9k star,Lauren Tan pstack 的多 harness 移植;MIT+两附加许可)
- 日期: 2026-10-13;评者: 协调者 fe0376cd(第一手: 克隆 @HEAD,通读 61 技能+TLA 规约+mutation 文件)
- 我方基线: main @dceaa98(批-22)
- 结论先行: **单会话技能栈,与 gstack(镜十六)同轴,整体不采用;但它带来了前 22 面镜子都没有的一件东西——对自家锁协议的 TLA+ 模型检查+对规约本身的变异测试。这是「牙」的规约级版本,直接命中我方 holder-lock/single-flight,头号借点立项级。**

## 1. 它是什么

61 个 markdown 技能组成的工作流栈: 1 个路由入口(poteto-mode)+ 8 类 playbook + 24 条 principle-* + 验证族。
多 harness(Claude Code/Codex/Copilot/Pi/OpenCode/Gemini),零服务器零遥测,Bun 工具链。
与我方相反轴(同 gstack): 单会话单机、技能=建议性文本;我方=分布式 peer 蜂群、协议=耐久字节+SHA 封存。

## 2. 头号发现: 规约级的牙(TLA+ + mutations)

[源: tla/OrchStoreLock.tla 331 行 + OrchStoreLock.mutations;第一手读过]

它对自己 orch store 的 pid 锁(store.ts 1748 行中的 acquireLock 族)做了:
1. **逐行映射的 TLA+ 模型**: 规约头注把每个 action 对到 store.ts 的行号(create 406-419/takeOver 481-504…),假设显式列出(EACCES/ENOSPC 不在协议内、UUID 不碰撞、弱公平排除 SIGSTOP 持有者)。
2. **对规约本身的变异测试**: mutations 文件每条=一个「似真 bug」(如 create 无 EEXIST 门会覆写既有锁/takeOver 跳过持有者比对),并点名**必须失败的那条性质**(OneHolder/LockNamesHolder);每条带 `only` 行钉住一个在未变异规约上通过的配置——DETECTED 来自变异而非预期 FAIL 的跑法。**这就是我方「负例必 RED」的牙纪律,打到了规约层。**
3. ghost 变量(stolen)建模被接管者的上报义务——连「被偷锁的人必须被告知」都是检查的性质。

**对照我方**: holder-lock 的正确性靠 62 进程 harness+11 门+双声人审。经验强度高,但状态空间枚举是零——ABA 单赢/rmdir-if-empty 无活锁这些,我们是「跑出来没死」,他们那套是「所有交错都数过」。锁语义战争(SUCC-1 七轮+DA2 livelock 发现)如果当时有模型检查,livelock 在规约上一步就现形。

## 3. 其余借点(按值排序)

- **arena**(N 候选同题并行→交叉评审→选基底→嫁接败者强处): 我方只有「单作者+事后对抗审」,没有**生成侧多样性**。对设计敏感件(brief/契约)一次成型锁死错形状的风险真实存在(TG 桥 15 轮返工的一半是形状问题)。候选: dispatch 增加可选 arena shape。
- **swarm 技能的三条纪律**(与我方独立收敛,可直接对表): 不记录钉住 SHA+方法的结果直接作废重拉一次,二次缺=gap;**「gap 不算 pass」**=我方 残缺≠已完成;race 选择规则(first-pass/rank-all/best-of)必须 spawn 前声明=我方「判据先于证据」。
- **unslop 稳定规则号**: 文风规则带稳定 id,其他技能按号引用,删号留洞。我方 rulings 已有 id,文风/交付规范尚无——低成本补。
- **reflect**(转录→3 并行审→每条教训路由到具体技能的具体编辑): 与 retro-learn 同族;**差异=它直接自改技能,我方 polydao 红线(草稿投箱绝不自编辑)是刻意的,不改**。可借的只有「每条教训必须落到一个具体文件的具体编辑」这个收敛性要求。
- **effort-agents**(按角色派 reasoning effort): CC 专属机制,我方 model-staffing 已覆盖模型维度,effort 维度可作其 v2 输入,不急。

## 4. 独立收敛(互证,无需动作)

- principle-never-block-on-the-human ≈ 我方 R3-b(可逆推进+不可逆确认)。
- interrogate 的「对抗信号来自模型多样性而非人设」= 我方跨家族双声(claude+GPT 席)的设计理由,逐字同构。
- principle-prove-it-works / test-behavior-not-implementation = 牙纪律/行为门。

## 5. 我有他无(轴差,不展开)

分布式 peer/耐久 inbox/SHA 封存双声/成本账本/继任/fleet-recovery/毒信 DLQ——同 gstack 对照结论,不重复。

## 6. 建议

1. **立项(P1 候选): formal-lock-model**——给 holder-lock.ts + single-flight.ts 写逐行映射 TLA+ 规约+mutation 文件(每条=我们真打过的 bug: ABA/livelock/EEXIST≠published/双 token EACCES),TLC 进 CI 可选跑。千级 agent 北极星下,锁协议是全蜂群的单点正确性假设,值得状态空间级保证。工作量中(他们的规约 331 行是现成范本,许可 MIT)。
2. arena shape 入 dispatch(设计敏感件 opt-in)——中值,候裁。
3. unslop 式稳定规则号给交付规范——低值低成本,顺手件。
4. 不采用: 整栈安装/reflect 自改技能/effort-agents(现阶段)。

状态: 纯研究,未提交代码。候 user 裁。
