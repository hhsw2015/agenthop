# claude-task-master 评估:能否补「需求→任务计划」短板(user 问,2026-10-04)

对象:github.com/eyaltoledano/claude-task-master(npm task-master-ai,MIT+Commons Clause,高star 活跃)。
它做什么:parse-prd(PRD→tasks.json:id/依赖/优先级/实现细节/**testStrategy**/子任务)+ analyze-complexity(每任务 1-10 复杂度评分+推荐拆分数+定制扩展提示)+ next-task/expand 等 CLI/MCP 工具。

## 判断:解一半——前半(需求→结构化草案)可借,后半(草案→可执行契约)它没有,且其运行时与我们不兼容

**它有且对口的**(≈ T3 规划器的前半):
- PRD→带依赖的任务 DAG:正是「目标→计划」的自动化,prompt 资产成熟(高使用量淬炼过);
- testStrategy 字段 = 我们 acceptance 的雏形(每任务生成时就带验证思路——与我们「验收先行」同构);
- 复杂度 1-10 评分 = modelTier 难度标注的现成实现(user 的分档定调直接有了数据源);
- 依赖显式 + 阻塞可视 = loadPlan 校验的输入形状。

**它没有而我们必需的**:owner/roleProfile/fitProfile(谁来做)、specDigest 身份与冻结语义、两层验收(它的 done=自报改状态,零验证链)、预算、R4 design-first 门。
**不兼容处(硬)**:其 tasks.json 是**可变单文件任务账本**——直接采用=引入第二执行账本,恰是 rev3 R2-P1-3 刚拔掉的东西;其工作模型是「单 agent 在 Cursor 里顺序做任务」,无多成员协作概念。

## 建议接法:借前半,产出进翻译层,不采用其运行时

T3 规划器 = **parse-prd 思想(或直接调用其 CLI 作草案生成器)→ 翻译层**:草案任务→TaskPlan 节点(补 specDigest/acceptance 机械化/rolePro­file/modelTier←复杂度分/预算),**loadPlan 校验是唯一入口**,R4 重大计划自动前置 design 节点。tasks.json 只作为中间产物即焚,事实仍唯一在 control-log。
性价比:prompt+复杂度评分直接抄或调用,省掉 T3 一半的发明;翻译层是我们自己的活(本就无人能代写,契约在我们手里)。

---
# 附:unterm 评估(user 问「会不会更适合这种自动化」,2026-10-04)

对象:github.com/zhitongblog/unterm——「AI agent 能驾驶的终端」:每窗口起本机 MCP server(152 个认证方法),外部 agent 可 spawn shell/读 pane/截屏;Agent Cockpit(每 pane agent 状态引擎/等待优先 Inbox/Fleet=一任务×N agent×N worktree/Review 页 diff-verify-rank-merge);v0.68 加治理层(能力清单+危险度、会过期不可重放的 lease、workspace 隔离、可第三方核验的 evidence bundle)。Rust,体量大,活跃。

## 判断:不是替代,是互补的「驾驶舱层」——我们缺的壳,它缺我们的脑

**它解决的是我们没做的层**:
- 人的驾驶舱:等待优先 Inbox(谁在等你,最久优先,回车跳过去)——比我们 viz 的只读看板多了「一键介入」;
- 成员的物理宿主:我们的常驻会话现在是裸 ghostty/手工 spawn;unterm 给每个 agent 固定 pane+状态引擎(OSC+进程指纹+官方 hooks),等于「考勤机+工位」产品化;
- Fleet/Review:同任务 N agent 赛马+验证排名+门控合并——现成的「多实现对比验收」形态。

**它不解决我们的核心**(所以不是「更适合」而是「另一层」):
- 无业务编排:无 DAG/依赖/验收契约/预算——它的 Review verify 是跑一条验证命令,不是两层验收+对抗审查;
- 无耐久任务轴:状态在终端进程里,崩了重启=cockpit 记忆清零(我们的 control-log 正是为此);
- 无停摆监督/免疫:它看得见「谁在等人」,看不见「事情没人推」。

**真正诱人的接点(按性价比)**:
1. agent.status/cockpit.inbox 作为 roster 观测源:比我们 presence+status 双文件更丰(working/waiting-for-you/idle/done 四态+等待时长),恰是 L2-roster 与 R8-idle 的理想输入——且是本机 JSON-RPC,isAlive 的 ObservationFact 直接多一个 source;
2. 等待优先 Inbox ≈ 我们 approval-wait 的人侧 UI:呈批件匣子有了现成壳;
3. lease+evidence bundle(v0.68)与我们的门禁缺口(公司对齐表第 12 行)同方向,可观望其成熟度;
4. Fleet 赛马可作为「重大件多实现对比」的执行形态(R6 同角色多实例的产品化)。

**建议**:不迁移、不依赖;L2-roster 落地时把 unterm 的 agent.status 列为可选观测源之一(接口上只是多一种 ObservationFact 来源,isAlive 语义不变);user 若日常用 unterm 作终端,Inbox 天然成为「谁在等你」的驾驶舱——零集成成本的增益。深度集成(Fleet/Review)等蜂群日常运行后按需评估。
