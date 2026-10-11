# Board Admission Map (§2d-b) — read-only scratch, uncommitted

Scope: map the path by which a PLAN-NODE becomes a swarm work-board item and is admitted to
execution. Repo `/Users/wowdd1/Dev/agenthop`, branch `main`, HEAD `b5fde65`. No code changed.

> Terminology note: the literal strings "§2d-b", "board admission", "板准入",
> "plan-node board", and "dormant-ahead-of-use" do NOT appear anywhere in the repo
> (grep of docs/ packages/ scripts/ returned nothing). They are the task's shorthand.
> The governing spec is **`docs/swarm/cluster-liveness-design.md` §2d "拉式领活"**
> (pull-based claiming), whose item **b** (line 97) is the admission contract. "§2d-b"
> in this doc = that item.

---

## 1. Work-board mechanism end to end

### Directory + naming
- Board dir: `~/.agenthop/swarm/board/` — `BOARD_DIR` at `scripts/swarm-dispatch.ts:107`;
  independently re-derived in `scripts/projection.ts:366-367` (`swarmRoot(home)/board`).
- Two file-name parsers exist, with a **subtle convention mismatch** (flag this):
  - `parseBoardFile` — `packages/bus/src/swarm/delegation-observer.ts:58-65`.
    Convention `<item>.<state>.<who>.json` or `<item>.json` (posted/unclaimed). The LAST
    two dot-segments are `state`+`who`; items are kebab-case (dashes survive, dots split).
    A 3+-segment name is ALWAYS parsed as `item.state.who` regardless of what `state` is.
  - `parseBoardFileName` — `scripts/projection.ts:356-364`. Only treats the SECOND token
    as a status when it is exactly `claimed` or `done`; any other multi-dot name is a
    single open `itemId`. So e.g. `a.posted.json` parses as item=`a`,state=`posted` under
    the observer but item=`a.posted`,status=`open` under projection. Harmless today
    (states in use are only posted/claimed/done) but the two parsers are NOT identical.
- `BoardItemStatus = "open" | "claimed" | "done"` (`projection.ts:284`); observer uses
  `state ∈ posted|claimed|done` (`delegation-observer.ts:56-57,62`).

### POSTED (produced)
- **No production producer exists.** Grep for writes to `BOARD_DIR` / `board/` finds only
  TEST FIXTURES: `scripts/projection.selftest.mts:161-164` and `:207-210`
  (`writeFileSync(.../board/<id>.json, ...)`). `BOARD_DIR` is never `mkdirSync`'d or written
  in `scripts/swarm-dispatch.ts`.
- Spec intent (§2d-a, `cluster-liveness-design.md:96`): the coordinator's job shrinks from
  "dispatch" to "上板 (curate)"; posting an item = responsibility discharged; the item
  "carries its own supervision (claim deadline + no-claimant → sweep escalation)".

### CLAIMED (reserved)
- Spec §2d-b (`cluster-liveness-design.md:97`): claiming is an **atomic rename**
  `<item>.json` → `<item>.claimed.<who>.json`, which is ONLY a reservation application
  ("防两人同时填表"), NOT execution authority. The atomic primitive the spec names
  ("单飞锁同款原子操作", line 107) already exists: `acquireSingleFlight` via hard-link +
  rename-aside in `packages/bus/src/swarm/single-flight.ts:36-65`.
- **No production code performs a claim** (member side) or **consumes a claim** (dispatcher
  side). See GAP §4.

### DONE
- `<item>.done.<who>.json` (observer `state="done"`; projection `status="done"`). No
  production writer; recognized only on the READ side.

### CONSUMERS (read side — all present; none is admission)
1. **Dispatcher change-watch** (notification only):
   - sample: `snapshotBoardProgress` `scripts/swarm-dispatch.ts:747-755`
     (`readdirSync(BOARD_DIR)` filtered to `.json`, plus `PROGRESS.md` mtime).
   - diff: `detectWatchEvents` `delegation-observer.ts:78-88` — a newly-seen board file ⇒
     one `{kind:"board",item,state,who}` event (a rename lands as a new name).
   - push: `runObserver` board/PROGRESS half `swarm-dispatch.ts:810-829` → `notifyCoordinator`
     (`:760-775`) writes a `"board: <item> → <state> ... (durable change — reconcile)"`
     line to the coordinator inbox. Snapshot persisted by `readWatchSnapshot`/
     `writeWatchSnapshot` `delegation-observer.ts:317-333`; file `OBSERVER_SNAPSHOT_FILE`
     `swarm-dispatch.ts:106`. This only NOTIFIES on change — it never reconciles or admits.
2. **Projection / viz** (read-only facts):
   - `BoardItem` type `projection.ts:285-300`; `readBoard` `projection.ts:366-402`;
     `readBoardView` `:489-495`; kanban view `:553+`; `stallVerdict` counts
     `openBoardItems` `:472-487`; `artifactGaps` `:444-453`.

---

## 2. Spec text (verbatim) — `docs/swarm/cluster-liveness-design.md`

### §2d header (`:91`)
> ## 2d. 拉式领活(rev2 增补,user 定调 2026-10-04):空闲成员主动领任务,任何外部力量(user/协调者)都不是风箱

### §2d-a — the board (`:96`)
> - a. **耐久活板(work board)**:无主活以可认领条目存在于耐久位置(v1=~/.agenthop/swarm/board/<itemId>.json,含 spec 摘要/适配域/优先级;与 brain 的 readyTasks 同构——DAG 对 ephemeral worker 本就是拉式板,本条把同一语义给 durable 成员)。协调者的职责从「派活」收缩为「上板」(curate),上板即卸责(board 条目自带监督:认领期限+无人领→sweep 升级)。

### §2d-b — THE ADMISSION CONTRACT (`:97`)
> - b. **认领=申请,执行权唯一来自 dispatcher admission [R2-P1-3 重写]**:板条目的原子改名只是**预留申请**(防两人同时填表),不是执行授权。申请被 dispatcher 下一 tick 消费:在**当前 CONTROL** 上跑既有 admission(spec/输入在当前版、依赖 accepted、节点级单活、预算/容量、授权)→ 通过则原子提交 intent+binding+信封 wait 并回 receipt(写申请者 inbox+板条目标 granted),**拿到 receipt 才开工**;拒绝则板条目标 rejected+理由。两个条目指同一 node ⇒ admission 的节点单活挡第二个;文件预留后 CONTROL 提交失败/崩溃 ⇒ 预留是无权力的孤文件,dispatcher 重放时按申请重审或过期清除——跨存储原子性不被假设,board 是申请队列与事实投影,**绝不是第二执行账本**(冻结 team 的 claim/lease 边界不被触碰,Stage B 另审立场保留)。远端成员的申请通道=同一 dispatcher 的收件面,不同主机 ~/.agenthop 不默认同一板。

### §2d-c — sweep R8-idle (adjacent; the "5th rule") (`:98`)
> - c. **sweep 补一条 R8-idle 规则**(即此前延期的第五规则,现在有了明确形态):检测「成员 idle × 板上有其适配域的未领条目」⇒ ping **成员本人**... 成员收 ping 后自己决定领不领...

### §2d enforcement tags (`:107`)
> 强制点:a=[新,薄](目录+条目 schema);b=[接线](单飞锁同款原子操作);c=[接线](sweep 第五规则,roster idle 信号已有);成员义务=[契约]...

### Supporting / reinforcing refs
- `cluster-liveness-design.md:38` — "b. [已有] R 的武装:readyTasks 纯函数 + dispatcher 派发循环。"
- `docs/swarm/t3-planner-design.md:9` — "**不新增执行权**:规划器是「产出耐久事实的又一成员」;派发仍唯一经 dispatcher admission(rev4 R2-P1-3 立场)。"
- `docs/swarm/dynamic-capacity-brief.md:38` — "执行权仍唯一来自 dispatcher admission ... spawn 出来的成员照样走板申请/信封收据。"
- `docs/swarm/team-collab-design.md:44,118,194` — admission = matching grant (isGranted by paramsDigest), not "no unresolved wait".
- `packages/bus/src/swarm/task-wait.ts:193` — code statement of the same: admission = a matching granted approval.
- `docs/research/shared-blackboard-stigmergy.md:480-547` — PRIOR-ART blackboard design (`agenthop_board_post/claim` MCP tools). Different artifact from the swarm board; context only.
- `docs/roadmap.md:61` — Stage A passive note-board (also distinct from the swarm work board).

---

## 3. Plan-node / TaskPlan data model

File `packages/bus/src/swarm/task-plan.ts`.
- `TaskSpec` (`:44-94`) — a plan node. Fields: `nodeId`, `kind`
  (`work|integration|synthesis|review|repair|design`, `:24`), `goal`, `dependsOn: string[]`,
  `outputContract` (`:35-40`, requiredOutputs + optional `baseSourceCommit`),
  `acceptance: AcceptanceCheck[]`, `artifactScope: string[]`, `sourceWriteScope?`,
  `estimatedRuntimeSec`, `retryBudget`, and the role annotations `required` (default true),
  `runtime` (`ephemeral|durable`, default ephemeral), `visibility?` (durable-only),
  `modelTier?`, `roleProfile?`, `coveredSpecDigests?`, `criticalPath?`, `resolvedRisk?`,
  `specDigest` (identity hash).
- `TaskPlan` (`:116-128`) — `jobId`, `planRevision`, `nodes: TaskSpec[]`, `jobBudget`,
  `frozenRefs?`, `notImplemented?`, `planDigest`.
- `loadPlan` (`:373-455`) — the trust boundary: untrusted JSON → legal plan or whole reject;
  recomputes digests authoritatively; `managed-t3` mode re-enforces R4.
- Eligibility engine = `readyTasks` (`packages/bus/src/swarm/task-ready.ts:140-154`): returns
  `ReadyTask {nodeId, proposedBindings: InputBinding[], inputBindingDigest}` (`:31`) for every
  node that is not complete (step1), has no active attempt (step2), is not budget-gone /
  terminally-failed (step3), and whose deps all have a current accepted (step4). §2d-a
  states the board is "与 brain 的 readyTasks 同构" — so `readyTasks` IS the natural source of
  board-admittable nodes.
- Node → board-item mapping (target shape = `BoardItem`, `projection.ts:285-300`):
  - `itemId` ← `nodeId`; `dependsOn` ← `spec.dependsOn`; `spec` (summary) ← `goal`;
    `conflictsWith` ← (none on TaskSpec — would be derived from overlapping artifact/source
    scopes); `fileDomain` ← `artifactScope`/`sourceWriteScope`; `fitProfile` ←
    `roleProfile` (role inference from `RoleCatalog.fileDomain` lives in
    `packages/bus/src/swarm/task-translate.ts:204-262`); `priority` ← NOT in TaskSpec
    (planner/coordinator supplied; §2d-a lists "优先级" as a board-item field, so admission
    must source it externally). `modelTier` also available as a hint.
- `task-translate.ts` (draft → plan translation) and `plan-draft.ts` are where
  `roleProfile`/role resolution originate (translate `:46,58,204-262`); relevant only as the
  SOURCE of the fit metadata a board item would carry, not to admission itself.

---

## 4. The GAP — what "enabling board admission" must add

**Today dispatch is pure PUSH and the board is a read-only observed surface.** Confirmed:
- No production write to `BOARD_DIR` (grep: only `projection.selftest.mts` fixtures).
- No claim-consumer: nothing reads `*.claimed.*` and runs admission; the only board reads are
  the change-watch (`swarm-dispatch.ts:747-755, 810-829`) and projection (`projection.ts:366`).
- The live dispatch path never touches the board: `taskPass`
  (`packages/bus/src/swarm/task-pass.ts:190-243`) computes `readyTasks` (`:193`) and directly
  `prepareDispatch` → commit `intent`+`attempt` (CAS, `:218-225`) → `startTask` (`:227`).

So BOTH halves of §2d are missing. Enabling board admission requires:

1. **Producer / §2d-a ("上板")** — a step that posts eligible nodes as `<itemId>.json`
   board files carrying the `BoardItem` fields (`itemId`, `dependsOn`, `spec` summary,
   `fileDomain`, `fitProfile`, `priority`, `postedBy`, `postedAtSec`). Source = `readyTasks`
   output filtered to durable-eligible nodes (§2d-a gives readyTasks' pull semantics to
   durable members). Needs:
   - **Idempotency**: never re-post a node already posted/claimed/done or with an active
     attempt. Key the item by `nodeId` (open file = already posted); mirror the "write no
     file when nothing to track" dormancy of the dead-letter watch
     (`delegation-observer.ts:189-191`, `swarm-dispatch.ts:1002`).
   - **Atomic write**: temp + rename (same discipline as `writeWatchSnapshot`
     `delegation-observer.ts:328-333` / `atomicWrite` `swarm-dispatch.ts:155-158`).

2. **Consumer / §2d-b (admission)** — a step that reads `<item>.claimed.<who>.json`, and on
   the NEXT tick re-runs admission on the CURRENT CONTROL, reusing the existing primitive:
   `prepareDispatch` (`packages/bus/src/swarm/task-dispatch.ts:54`) which already enforces
   §3.1 node single-active (`:122-125`), plus the budget/cap re-checks in
   `task-pass.ts:194-224`. On pass → commit `intent`+`binding`+envelope `wait`, write a
   receipt to the applicant inbox, rename item → `*.granted.*`; on reject → `*.rejected.*`
   + reason. Needs:
   - **Node single-active guard**: two items → same node, the second is blocked by
     `prepareDispatch`'s single-active retire (`task-dispatch.ts:122-125`).
   - **Orphan-reservation reaping**: a `*.claimed.*` whose CONTROL commit failed/crashed is a
     "powerless orphan" — re-review on replay or expire (spec §2d-b). No cross-storage
     atomicity assumed; board is application-queue + projection, never a second ledger.
   - **Member-side atomic claim**: reuse `acquireSingleFlight` (`single-flight.ts:36-65`) for
     the reservation rename.

3. **Dormancy flag / env gate ("dormant-ahead-of-use")** — follow the established pattern:
   a new `/^(1|true|yes|on)$/i`-tested `SWARM_*` var, default-off, exactly like
   `EXEC_ENABLED` (`swarm-dispatch.ts:80`), `TASK_EXEC` (`:144`), `SWEEP_ENABLED` (`:150`).
   Plus data-driven dormancy (act only when the board dir has items/claims), like the
   dead-letter watch "dormant until the ledger exists" (`:115, :835, :1068`). A suggested
   name (none exists yet): `SWARM_BOARD_ADMIT`.

---

## 5. Dispatcher wiring — `scripts/swarm-dispatch.ts`

- Board constants: `BOARD_DIR` `:107`, `PROGRESS_FILE` `:108`, `OBSERVER_SNAPSHOT_FILE` `:106`.
- Board READS (only): `snapshotBoardProgress` `:747-755`; `runObserver` board/PROGRESS half
  `:810-829` → `notifyCoordinator` `:760-775`.
- Env-gate / dormancy patterns (the template for a new gate):
  - `EXEC_ENABLED` `:80` (`SWARM_EXEC`); `TASK_EXEC` `:144` (`SWARM_TASK_EXEC`);
    `SWEEP_ENABLED` `:150` (`SWARM_SWEEP`); `taskOn = plan !== null && TASK_EXEC` `:600`.
  - "dormant until it exists" (data-driven): dead-letter watch `:115`, `:835`, `:1068`.
  - `envInt` safe numeric-env helper `:121-124`.
- Pass loop (where an admission step would wire in): `runDispatchLoops` `:1040-1086`.
  - `passTick` `:1044-1050`: runs `pass(...)` then, gated, the push task pass —
    `if (plan && taskOn && taskOps) { ...; await taskPass(plan, taskOps); }` at **`:1046`**.
    A board PRODUCER (post readyTasks → board) and a board CONSUMER (claims → admission) would
    both attach here, gated by the new flag, alongside or replacing the direct `taskPass`.
  - `sweepTick` `:1053-1070` runs `runObserver()` `:1067` (board change-watch) and
    `runDeadLetterWatch()` `:1069` on the independent sweep loop — the §2d-c sweep R8-idle
    rule would attach here.
- Supporting handles: `loadPlanFile` `:398-401`; `taskStateRef` `:604`; `taskOps =`
  `buildTaskOps(...)` `:605`; plan/taskOn log line `:601`.
- No existing admission/posting hook for the board anywhere in this file.

---

## 6. Existing tests touching the board / plan-nodes — `packages/bus/test/`

- `swarm-delegation-observer.test.ts` — board WATCH only:
  `parseBoardFile` (`:67-73`, kebab items, claimed/done/posted), `detectWatchEvents`
  (`:76-91`, new file ⇒ event, unchanged ⇒ none, first-run no spurious progress),
  `readWatchSnapshot`/`writeWatchSnapshot` (`:134-139`, atomic round-trip; missing ⇒ empty;
  corrupt ⇒ throws). NO post/claim/admission coverage.
- `swarm-task-plan.test.ts` — `loadPlan` valid (`:33`), illegal-graph whole-reject (`:53`),
  shape validation (`:89`), digest identity incl. role-annotation exclusion (`:124-177`),
  Codex re-review fixes (`:179-199`).
- `swarm-task-ready.test.ts` — `readyTasks` diamond progression (`:45`), recursive
  `currentAccepted` (`:73`), un-expired RETRY_WAIT active (`:103`), `jobStatus` (`:123`).
- `swarm-task-dispatch.test.ts` — exercises `prepareDispatch` (the admission primitive a
  board consumer reuses).
- `swarm-task-pass.test.ts` — the current PUSH dispatch pass (readyTasks → dispatch).
- `swarm-projection.test.ts` + `scripts/projection.selftest.mts` (board fixtures `:161-164`,
  `:207-210`) — `readBoard`/`BoardItem`/kanban/stall over board filenames.
- **No test exercises a board-admission producer or a claim-consumer — because neither
  exists yet.**

---

## 7. §2d / §2d-b acceptance contract (for implementation acceptance)

Drawn from §2d-b prose (`cluster-liveness-design.md:97`), the enforcement tags (`:107`), and
the §6 acceptance list (`:131-137`):
1. An atomic rename is a RESERVATION only — never execution authority.
2. A grant is issued ONLY by running existing admission on the CURRENT CONTROL (spec/inputs at
   current revision, deps accepted, node-level single-active, budget/capacity, authorization).
3. Two items → same node: admission's node single-active blocks the second.
4. A reservation whose CONTROL commit failed/crashed is a powerless orphan — re-reviewed or
   expired on replay; no cross-storage atomicity assumed.
5. The board is an application-queue + fact-projection, NOT a second execution ledger (the
   frozen team claim/lease boundary is untouched).
6. Receipt-before-work: a member starts only after the dispatcher writes the receipt
   (inbox + board item → granted).
7. The general invariant it must not break: "派发即登记" — every dispatch is registered as a
   wait (`cluster-liveness-design.md:128`, `:132-134`); and admission = a matching grant, not
   "no unresolved wait" (`task-wait.ts:193`).

### Ambiguities / absent items (stated, not guessed)
- No `§2d-b` / "board admission" literal in-repo; mapping to §2d item b is inferred from the
  user's description + the directory/claim convention match.
- `priority` and `conflictsWith` have no TaskSpec source — a producer must derive them
  (conflictsWith from overlapping scopes; priority from planner/coordinator input).
- The two board-filename parsers (`delegation-observer.ts:58` vs `projection.ts:356`) are not
  byte-identical; a producer/consumer should pick one convention and verify both readers agree
  on the states it emits (`granted`/`rejected` are NEW states neither reader classifies today —
  projection would treat `x.granted.who` as open-item `x.granted.who`).
- §2d-c (sweep R8-idle) is also unimplemented (`swarm-dispatch.ts:530` notes "no idle-same-role
  picker yet (that is the R8 overload rule, next)"); out of scope for §2d-b but adjacent.
