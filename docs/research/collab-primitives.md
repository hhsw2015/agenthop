# Collaboration Primitives for agenthop

Status: DESIGN (research + recommendation; no code changed)
Date: 2026-10-01
Scope: the COLLABORATION PRIMITIVES layer - turning multi-agent collaboration PATTERNS
(committee, debate, map-reduce, review panel) into a minimal set of small composable tools on
the agenthop bus. Sibling docs: `acp-integration.md` (headless auto-task backends + the
task/result verdict in its section 5bis), `herdr-study.md` / `blocked-detection-study.md`
(the status plane that shipped as bus.6).

Prerequisite flag (section 5): everything below that collects or judges a worker's OUTPUT
depends on the "first brick" - auto-task returning a RESULT over the bus (request/reply with a
task id). That design lives in the sibling auto-task work (acp-integration.md 5bis.4 sketched
it: taskId on the handoff envelope + a `task-result` reply convention). This doc does NOT
design it; it names the exact surface it consumes.

---

TL;DR: agenthop is the distributed SUBSTRATE (discovery, messaging, handoff, status, spawn,
cross-tool, cross-machine, no central controller). Collective intelligence is NOT a property of
the substrate; it needs STRUCTURE: division of labor, diversity, aggregation, and adversarial
cross-checking. The literature and the shipped frameworks agree on a surprisingly small core.
After mapping five frameworks and four research lines onto agenthop's existing tools, the
irreducible NEW surface is exactly two things plus one parameter plus one convention:

- P0 TASK (prerequisite, sibling doc): dispatch work, get a correlated result back.
- P1 ROLE: a `role` (+ `expect`) field on task/spawn - prompt text, not a role registry.
- P2 GATHER: collect N task results with quorum + timeout - the barrier generalized from
  the already-shipped `agenthop_wait_peer`.
- P3 VERDICT convention: a structured pass/fail head on review-type results, so critic
  output is branchable. Documentation + envelope hint, near-zero code.
- (P4 FAN-OUT batch wrapper: a thin convenience over N TASK calls; defer until composing
  by hand proves annoying.)

Everything else - debate, committee, map-reduce, review panel, MoA-style layering - is the
ORCHESTRATING AGENT composing those per task. No workflow engine, no group chat, no speaker
selection, no graph compiler. The intelligence lives in the agent that wires the calls, which
is the only place it can live on a decentralized bus where any node may be the orchestrator.

---

## 0. Framing: substrate vs structure

What agenthop already is (verified in-repo, packages/bus/src/mcp.ts + spawn.ts, v0.6.0-bus.6):

| Layer | Tool(s) | What it gives collaboration |
|---|---|---|
| Discovery | `agenthop_peers` | live roster, stable handles, [status] badges |
| Messaging | `agenthop_send` / `agenthop_recv` | point-to-point DMs, auto-surface, cross-tool |
| Task passing | `agenthop_handoff` | author-written summary + git snapshot envelope (fire-and-forget) |
| Status plane | `agenthop_report_status` / `agenthop_wait_peer` | working/idle/blocked, pinned-run wait = a 1-peer barrier |
| Dispatch | `agenthop_spawn` / `agenthop_despawn` / `agenthop_spawned` | create/destroy visible workers (headless mode = bus.7 direction) |
| Arrangement | `agenthop_wm` | window placement (operator UX, not collaboration semantics) |

That substrate is genuinely distributed: local unix-socket broker + cross-machine relay, any
node can discover/dispatch/wait, no central orchestrator process, and - the property no single
framework has - HETEROGENEOUS nodes (Claude Code, Codex, OpenCode today; different models,
different accounts, different machines).

Why connectivity alone does not produce collective intelligence: the classic conditions for a
crowd outperforming its members (Surowiecki, The Wisdom of Crowds, 2004 - diversity of
opinion, independence, decentralization, and a working AGGREGATION mechanism) are structural,
not infrastructural. The empirical MAS-failure study MAST ("Why Do Multi-Agent LLM Systems
Fail?", arXiv:2503.13657, Cemri et al., UC Berkeley) analyzed 7 frameworks over 200+ traces and
found failures concentrated in exactly the structural gaps: poor task/role specification,
inter-agent misalignment (ignored input, information withholding, derailment), and missing or
wrong VERIFICATION - i.e. a connected mob fails without roles, independence, aggregation, and
cross-checking. Anthropic's production multi-agent research system reached the same shape from
the engineering side: an orchestrator that writes detailed task descriptions for parallel
subagents, then synthesizes - and it costs about 15x chat tokens, so the structure must earn
its spend (anthropic.com/engineering/built-multi-agent-research-system).

Design stance for this doc (ponytail discipline):

1. Primitives are TOOLS ON EVERY NODE, caller-side. Any session can be the orchestrator for
   one task and a worker for the next. No coordinator role is baked in anywhere.
2. The PATTERN lives in the orchestrating agent's context, per task - never in config, YAML,
   or a compiled graph. A pattern is a paragraph of agent reasoning plus 3-6 tool calls.
3. The bus never synthesizes, votes, or judges. Aggregation intelligence is an AGENT (a
   TASK call with an aggregator role), because synthesis quality is exactly the thing that
   needs a model, and hardcoding it would freeze the worst layer.
4. Smallest set that composes the four target patterns (committee, debate, map-reduce,
   review panel). Anything needed by only one pattern is not a primitive.

---

## 1. Prior art: what to borrow, what is over-engineered

Each entry: how it does roles / aggregation / critique, the 20% worth stealing, and the 80%
to leave behind. Research lines first, then frameworks.

### 1.1 Multi-agent debate (Du et al., arXiv:2305.14325, ICML 2024)

- Mechanism: N model instances answer independently, then for R rounds each agent sees the
  others' answers and revises; converge to a common answer ("society of minds"). Improves
  math/reasoning/factuality; black-box access only.
- Counter-evidence (important): "Should we be going MAD?" (Smit et al., arXiv:2311.17371,
  ICML 2024) benchmarked debate protocols under fixed inference budgets and found MAD does
  NOT reliably beat SELF-CONSISTENCY (sample N, majority vote - Wang et al. 2022) despite
  much higher cost; debate quality is sensitive to how much agents agree (too much agreement
  = no signal).
- BORROW: (a) round-2-sees-round-1 is just a second TASK call whose prompt embeds gathered
  results - no new primitive; (b) the INDEPENDENCE of round 1 is the load-bearing part -
  workers must not see each other's drafts before answering; (c) the cheap baseline first:
  fan-out + majority/synthesis (self-consistency shape) before paying for debate rounds.
- OVER-ENGINEERED for us: fixed R-round debate loops as a framework feature. Round count is
  a per-task judgment call by the orchestrating agent ("answers disagree -> run one revision
  round"), not a parameter of the bus.

### 1.2 Mixture-of-Agents (Wang et al., arXiv:2406.04692, ICLR 2025, Together AI)

- Mechanism: layers of PROPOSERS (diverse models produce candidates) feeding an AGGREGATOR
  (a model good at synthesis) which takes ALL previous-layer outputs as auxiliary context;
  3 layers of 6 open models beat GPT-4o on AlpacaEval 2.0. Key empirical finding
  ("collaborativeness"): an LLM answers better when shown other models' outputs, EVEN when
  those outputs are worse than its own would be.
- Counter-evidence: Self-MoA (arXiv:2502.00674) shows that when one model is clearly
  strongest, aggregating N samples of THAT model can beat mixing weaker ones - diversity
  helps only when the mix's quality spread is not too large.
- BORROW: the two-role shape IS our core pipeline: proposers = FAN-OUT over heterogeneous
  tools (agenthop natively has what MoA simulates with API calls - genuinely different
  models/harnesses per node), aggregator = one TASK with role=aggregator whose prompt embeds
  the gathered candidates. Also: aggregator choice matters more than proposer count - put
  the strongest model on synthesis.
- OVER-ENGINEERED: fixed multi-layer stacks. One proposer layer + one aggregator covers the
  pattern; a second layer is just the agent calling GATHER->TASK again. Layering is
  composition, not a primitive.

### 1.3 LLM ensembles / self-consistency (Wang et al. 2022; ensemble literature)

- Mechanism: sample the same model N times (or N different models once), take a majority /
  consensus / judge pick. The cheapest aggregation that works; the Smit result above makes
  it the mandatory baseline.
- BORROW: GATHER must deliver results in a form that makes "just vote/compare" a trivial
  prompt for the aggregator - labeled, attributed, verbatim candidates. Also quorum: N-of-M
  (first 3 of 5) captures most of the value when stragglers are slow - ensembles degrade
  gracefully, so the barrier must too.
- OVER-ENGINEERED: numeric vote-counting machinery in the bus. The aggregator agent can
  count. (If a pattern ever needs exact mechanical voting, that is one worker tool, not bus
  code.)

### 1.4 Map-reduce for agents (LangGraph Send API; Anthropic orchestrator-worker)

- Mechanism (LangGraph): a conditional edge returns a list of `Send(node, per_item_state)`
  objects for dynamic fan-out; all branches run in one Pregel-style superstep; writes merge
  via a REDUCER annotation on the shared state key; the next node is the fan-in barrier.
  (Mechanism (Anthropic): lead agent decomposes, spawns parallel searchers, synthesizes.)
- BORROW: (a) per-item payloads - fan-out is N DIFFERENT task payloads from one template,
  not one broadcast; (b) the implicit barrier: "the step after the map runs once, when all
  branches are done" = our GATHER; (c) reducer-as-declared-merge -> in our world the merge
  is the aggregator TASK, and GATHER's job is only to deliver a complete, attributed bundle.
- OVER-ENGINEERED: the graph compiler, shared typed state, supersteps, checkpointing. Those
  exist because LangGraph is a single-process runtime that must serialize state between
  nodes. Our nodes are full agents with their own context and filesystems; the bus only
  moves messages. A distributed Pregel on the bus would be rebuilding LangGraph badly.

### 1.5 AutoGen (Wu et al., arXiv:2308.08155, Microsoft)

- Mechanism: everything is a ConversableAgent (send/receive/generate_reply); GroupChat +
  GroupChatManager orchestrate: manager SELECTS A SPEAKER (LLM role-play prompt / round
  robin / random), collects the reply, BROADCASTS to all agents, repeats. Critique happens
  by putting a critic agent in the chat.
- BORROW: the unified conversable interface - our bus already has it (send/recv/handoff are
  tool-agnostic). Also the lesson that a critic is just another agent with a different
  prompt, not a special mechanism.
- OVER-ENGINEERED: GroupChat itself. Centralized speaker selection is a sequential
  bottleneck (one speaker at a time - no parallelism), the broadcast floods every agent's
  context with everything (the opposite of MetaGPT's subscribe filter and of independence
  for debate), and the manager is exactly the central controller agenthop rejects. MAST's
  trace analysis (which included AG2/AutoGen) catalogs the resulting failure modes:
  derailment, ignored input, conversation resets.

### 1.6 CrewAI

- Mechanism: Agent = role + goal + backstory (persona grounding in the system prompt);
  Task = description + expected_output (+ context = other tasks' outputs); Process =
  sequential (task N's output feeds task N+1) or hierarchical (a manager_llm delegates and
  validates).
- BORROW: two genuinely good prompt-level ideas. (1) ROLE AS PROMPT TEXT, not as code:
  role/goal/backstory are just a composed system prompt - that is the whole ROLE primitive,
  and it is why we do not need a role registry. (2) `expected_output` on every task: telling
  the worker what DONE looks like is cheap and directly attacks MAST's "disobey task
  specification" / "premature termination" classes - we adopt it as the `expect` field.
- OVER-ENGINEERED: Crew/Process as objects. Sequential process = the orchestrator calling
  TASK twice with the first result pasted into the second prompt. Hierarchical process = the
  orchestrating agent itself (ours is a live agent with judgment, no manager_llm wrapper
  needed). Backstory theatrics beyond one line rarely pay for their tokens.

### 1.7 LangGraph (as a framework, beyond the Send API)

- Mechanism: explicit state graph (nodes, edges, conditional edges), compiled; typed shared
  state with reducers; checkpointing/time-travel; human-in-the-loop interrupts.
- BORROW: already taken in 1.4 (Send/barrier/reducer shapes). Also the honesty that
  DETERMINISTIC control flow should be explicit - in our design the explicitness lives in
  the orchestrator's visible tool-call sequence, which the user can watch on the bus.
- OVER-ENGINEERED (for us): the entire graph runtime. agenthop's unit of composition is a
  live agent session, not a Python function; a compiled graph would centralize control in
  one process and exclude cross-tool/cross-machine workers - the two things agenthop exists
  to provide.

### 1.8 OpenAI Swarm (archived; successor: Agents SDK)

- Mechanism: two primitives only - Agent (instructions + tools) and HANDOFF (a function
  returns the next agent, which takes over the conversation). Stateless client-side loop.
  Explicitly educational; replaced by the Agents SDK (adds tracing, guardrails).
- BORROW: the minimalism thesis itself - OpenAI's own demonstration that agents+handoffs
  cover a large pattern space is the strongest external validation of agenthop's shape
  (we already shipped the handoff; theirs transfers a whole conversation, ours transfers an
  authored summary + git state because cross-tool hidden context cannot transfer - see
  agenthop_handoff design). Swarm's "routine" = plain-language steps in a prompt = exactly
  "the pattern lives in the orchestrator's context".
- OVER-ENGINEERED: nothing - the opposite failure. Swarm has no fan-out, no gather, no
  result correlation; it is sequential baton-passing only. It marks the FLOOR: primitives
  below ours, insufficient for committee/map-reduce. Useful as a lower bound.

### 1.9 MetaGPT (Hong et al., arXiv:2308.00352, ICLR 2024 oral)

- Mechanism: "Code = SOP(Team)" - a fixed software-company assembly line (PM -> Architect
  -> Project Manager -> Engineer -> QA), agents exchange STRUCTURED artifacts (PRDs, design
  docs, interface specs) through a shared PUBLISH-SUBSCRIBE MESSAGE POOL; agents subscribe
  by role profile; executable feedback (run the code, feed errors back).
- BORROW: (1) structured artifacts over free-form chat - the strongest anti-"telephone
  game" result in the lot; for us this lands as the VERDICT/result-envelope convention
  (structured head + attributed body), not as document schemas. (2) Subscribe-by-relevance
  = do NOT broadcast everything to everyone; our point-to-point TASK/GATHER already embodies
  this (workers never see each other unless the orchestrator pastes it). (3) Executable
  feedback prefigures critic-with-tools: the best critics RUN things (tests, builds) rather
  than only reading - cheap for us since every worker is a full CLI agent.
- OVER-ENGINEERED: the fixed SOP pipeline. Hardcoding one domain's division of labor into
  the platform is the mega-framework anti-pattern this doc exists to avoid; roles must stay
  per-task prompt text.

### 1.10 Borrow table (the 20% that delivers 80%)

| Source | The one thing we take | Lands in |
|---|---|---|
| Debate (Du et al.) | independent first round; rounds = repeated TASK+GATHER | composition recipe (6.3) |
| MAD critique (Smit et al.) | fan-out+aggregate baseline before debate; budget-fix comparisons | composition guidance, cost notes (4) |
| MoA | proposer/aggregator split; heterogeneity is the asset; strong model on synthesis | FAN-OUT + aggregator TASK (2.3, 6.4) |
| Self-consistency | quorum N-of-M; attributed verbatim candidates | GATHER semantics (2.4) |
| LangGraph Send | per-item payloads; barrier-after-map; merge is a declared step | FAN-OUT/GATHER shapes (2.3-2.4) |
| AutoGen | critic = ordinary agent with a different prompt | VERIFY as role, not mechanism (2.5) |
| CrewAI | role/goal as composed prompt; `expected_output` per task | ROLE + `expect` field (2.2) |
| Swarm | two-primitive minimalism; handoff validated | floor/validation; no new code |
| MetaGPT | structured artifacts; no broadcast; critics that execute | VERDICT convention (2.5), reviewer guidance |
| Anthropic research system | orchestrator writes DETAILED subtask specs; 15x token economics | TASK prompt discipline + cost gate (4) |
| MAST | failure taxonomy = checklist the primitives must answer | section 4 mapping |

---

## 2. The primitive set: exact shapes, mapped onto existing tools

Notation: shapes are given as MCP tool signatures in the style of packages/bus/src/mcp.ts
(zod-ish). P0 is the prerequisite from the sibling auto-task design; P1-P3 are this doc's
proposals; P4 is deliberately deferred. All are caller-side tools present on EVERY node -
whoever calls them is the orchestrator for that call, which is the decentralization invariant.

### 2.1 P0 - TASK (prerequisite; designed in the sibling auto-task doc, consumed here)

What the collaboration layer NEEDS from it (the contract, not the design):

```
agenthop_task(to, task, { role?, expect?, timeout_s? }) -> { task_id }
  - dispatches a correlated unit of work to a peer (live session, or one freshly spawned);
  - the worker's eventual reply is a RESULT addressed to this task_id (structured frame or
    the `[task-result <task_id>]` convention from acp-integration.md 5bis.4);
  - results carry: task_id, from (handle), status (done|failed|unknown), body text,
    optionally file paths/artifacts.
```

Mapping: TASK = `agenthop_handoff` + a task_id + the reply convention. Today handoff is
fire-and-forget (no id, no result channel); `wait_peer(to, until:idle)` approximates "done"
but "idle" is not "done WITH THIS TASK" and carries no payload (acp-integration.md 5bis.3).
That gap is the first brick. Everything below assumes it is laid.

### 2.2 P1 - ROLE: spawn/task with a role

Proposal: NOT a new tool. A `role` string (+ `expect`) on the two existing dispatch surfaces:

```
agenthop_spawn(tool, { cwd?, workspace?, visible?,
  role?:   string,   // system-prompt-level framing: who this agent is for this job
  task?:   string,   // optional immediate first task (else idle worker, task later)
  expect?: string }) // what DONE looks like (CrewAI expected_output; MAST spec-failure fix)

agenthop_task(to, task, { role?, expect?, ... })  // same fields when tasking a LIVE peer
```

What it does: prepends the role framing to the task text in the delivered envelope (visible
spawn: the handoff/task message the new session receives; headless spawn: the prompt given to
`claude -p` / `codex exec` / `opencode run` - all three accept a prompt argument, and the bus.7
direction already plans per-launch prompt delivery). A role is PROMPT TEXT COMPOSED PER TASK
by the orchestrator - proposer, critic, synthesizer, researcher-of-subtopic-X - exactly
CrewAI's role/goal and MetaGPT's role profile, with none of their registry/class machinery.

Why not a role registry or per-role config: (a) roles that matter are task-specific ("critic
focusing on concurrency bugs in broker.ts"), unforecastable at config time; (b) a registry is
central state on a decentralized bus; (c) the orchestrating model writes better role prompts
per task than any frozen template (Anthropic's lesson: the orchestrator's detailed task
descriptions are the quality lever). The envelope just needs a standard place for the text.

Implementation cost: tens of lines - thread two optional strings through spawnAgent/handoff
formatting. Delivery channel differences per tool are already solved by the handoff path.

Non-goal: enforcing roles. A role is advice to a full agent; MAST's "disobey role
specification" is mitigated by `expect` + VERIFY (check the output), not by sandboxing the
worker's persona - enforcement machinery would be speculative.

### 2.3 P2a - FAN-OUT / DIVERSITY: N tasks from one template (thin wrapper; see P4 deferral)

The pattern: dispatch the same subtask (or per-item variants) to N workers which SHOULD
differ - different tools (claude/codex/opencode), different models, different machines,
different roles. agenthop is the rare system where the diversity is REAL (MoA simulates
heterogeneity with API calls to different vendors; our nodes natively ARE different harnesses
with different system prompts, tools, and even file-system vantage points).

Composable form (available the moment P0+P1 exist - NO new tool required):

```
for each target in [codex:Work, claude:Work, opencode:Work @mac2]:
    agenthop_task(target, render(template, target), { role, expect })
# or spawn fresh workers first: agenthop_spawn(tool_i, { role, task }) x N
```

Optional convenience wrapper (P4, build only when hand-rolling proves annoying):

```
agenthop_fanout(targets: string[], task: string, { role?, expect?, per_target?: string[] })
  -> { task_ids: Record<target, task_id> }
```

Semantics if built: pure batching - N independent TASK dispatches, one result map, partial
failures reported per target (one unreachable peer must NOT fail the batch). It owns no
retry/scheduling policy; that stays with the orchestrator.

Two load-bearing rules (from debate/self-consistency, section 1.1/1.3):
- INDEPENDENCE: fan-out workers never see each other's output in round 1. Our point-to-point
  envelopes give this by default (no broadcast exists to leak through) - preserve that; do
  not add a "shared context" feature.
- Per-item payloads (LangGraph Send): the wrapper must allow N different prompts from one
  template, not only one broadcast string.

### 2.4 P2 - GATHER / REDUCE: collect N results, then hand to a synthesizer

The one genuinely NEW mechanism this doc proposes:

```
agenthop_gather(task_ids: string[], {
  quorum?:    number,   // return once this many results arrived (default: all)
  timeout_s?: number,   // cap the wait (default 30, max 290 like wait_peer)
}) -> {
  results:  { task_id, from, status: done|failed, body }[],  // attributed, verbatim
  pending:  task_id[],       // not yet arrived (quorum return or timeout)
  complete: boolean          // all arrived?
}
```

What it does: a BARRIER over task results. Blocks until quorum/all/timeout; returns an
attributed bundle formatted so the next step is one TASK call to an aggregator whose prompt
embeds the bundle. Re-callable with the pending ids to keep waiting (same ergonomic as
`agenthop_recv` / `wait_peer` timeouts - MCP calls are bounded, so long waits are loops).

Mapping onto existing tools: this is `agenthop_wait_peer` generalized along two axes - from
1 peer to N, and from STATUS (idle/blocked) to RESULT (the task_id-correlated payload). It
inherits wait_peer's hard-won semantics verbatim:
- PINNING: a wait is satisfied only by the dispatched run (wait_peer already pins the exact
  run so a restarted session cannot satisfy it); gather pins on task_id, which is stronger.
- GONE detection: a worker that leaves the bus before replying is reported as failed-gone,
  not waited on forever (wait_peer's `gone` branch).
- Bounded calls + explicit "call again" continuation text.

What it deliberately does NOT do: synthesize, vote, rank, or summarize. The REDUCE step is an
agent: `agenthop_task(aggregator, "Synthesize/pick best:\n" + bundle, { role: "aggregator" })`.
Rationale in section 0 stance 3; evidence in 1.2 (aggregator model choice is the quality
lever - never freeze it in bus code) and 1.3 (bundle format should make voting a trivial
prompt). This is also LangGraph's reducer lesson translated: the merge is a DECLARED STEP,
but on a bus of agents the declared step is a task, not a function.

Storage note (unverified design detail, flag for implementation): results arriving before
gather is called must be held - the natural home is the same per-node inbox that
`agenthop_recv` drains, with task_id-tagged frames filtered out of the normal surface flow so
a result does not double-appear as a chat message. Needs a decision in the auto-task design.

### 2.5 P3 - VERIFY / CRITIC: adversarial review as a role + a VERDICT convention

Generalizing what the project already does by hand (the Codex adversarial review loop that has
gated every merge since Phase 2 - 12 rounds on spawn alone): VERIFY is NOT a new tool. It is:

1. a TASK with role=critic, where the critic reviews a REFERENCE to the work (branch/commit/
   paths - workers share a filesystem or a git remote; envelopes stay small, MetaGPT's
   structured-artifact lesson), and crucially may EXECUTE (run tests, build, grep) because
   every bus worker is a full CLI agent (MetaGPT's executable feedback, 1.9);
2. a RESULT whose body leads with a machine-branchable VERDICT HEAD:

```
verdict: pass | fail | unknown
findings:
  - [P1] <file:line> <claim>   # severity-tagged, location-anchored
  - [P2] ...
<free-form body>
```

The convention is documentation (busInstructions + the role prompt the orchestrator writes)
plus, at most, a `kind: "review"` hint on the task envelope so tooling can surface verdicts.
Zero to tens of lines of code. The orchestrator branches on the verdict: fail -> hand findings
back to the worker (another TASK), pass -> proceed; repeat - exactly the shipped Codex loop,
now expressible by any node over the bus with correlation instead of eyeballing a chat.

Adversarial independence rules (MAST "incorrect verification" + groupthink, section 4):
- DIFFERENT NODE than the author - ideally a different TOOL/model (cross-tool is agenthop's
  native strength; the in-house precedent - Codex reviewing Claude's code - is exactly this).
- The critic gets the ARTIFACT and the SPEC (`expect`), not the author's reasoning, so it
  cannot be anchored by the author's own narrative.
- The critic's incentive framing is to FIND problems (role text), not to approve.

### 2.6 P2b - BARRIER / WAIT: already shipped

`agenthop_wait_peer(to, until, timeout_s)` (bus.6) IS the status-barrier primitive: wait for a
peer to reach idle (done-ish) or blocked (needs input), pinned to the exact run, gone-aware.
It remains the right tool for watching a LIVE LONG-RUNNING peer (babysitting a visible worker,
noticing a blocked approval prompt). GATHER supersedes it only for RESULT collection; it is
not replaced. A multi-peer `wait_peers([...])` is NOT needed once gather exists - status
babysitting is per-peer by nature, and the orchestrator can loop.

### 2.7 Explicit non-primitives (rejected, with the reason each earns its rejection)

| Candidate | Why rejected |
|---|---|
| Group chat / broadcast channel | Sequential bottleneck + context flooding + central speaker selection (1.5); breaks round-1 independence (1.1). Point-to-point covers the patterns. |
| Workflow/graph engine on the bus | Rebuilds LangGraph without its single-process justification (1.7); freezes patterns that must stay per-task; central state. |
| Role registry / persona config | Roles are per-task prompt text (2.2); registry = central state + stale templates. |
| Built-in voting/scoring | Aggregation quality needs a model; the aggregator agent counts fine (1.3); mechanical vote = one worker script if ever needed. |
| Debate manager (R rounds) | Rounds = repeated TASK+GATHER; round count is a judgment call; fixed-R loops are the MAD over-spend (1.1). |
| Shared blackboard/state store | MetaGPT's pool works inside one process; on a distributed bus it becomes a consistency project; git + filesystems already are the shared artifact store. |
| Hierarchy/supervisor objects | The orchestrating agent IS the supervisor for its task; any node can be one (CrewAI manager_llm rejected, 1.6). |

---

## 3. Irreducible core vs nice-to-have

The test: can committee, debate, map-reduce, and review-panel ALL be composed? Remove any
core item and at least one pattern breaks; every nice-to-have is expressible (more verbosely)
with the core alone.

IRREDUCIBLE CORE (order = build order):

1. P0 TASK (request/reply with task_id) - without a correlated result, nothing downstream
   exists: gather has nothing to gather, verify has nothing to return a verdict to. This is
   the first brick (section 5).
2. P2 GATHER (N-result barrier, quorum+timeout, attributed bundle) - the only new mechanism.
   Without it, collecting N results means N hand-rolled recv/wait loops with manual
   correlation - possible but so error-prone (lost results on surface flow, no quorum, no
   gone-detection) that patterns stay one-off stunts.
3. P1 ROLE (`role`/`expect` fields) - without it, division of labor and `expect`-checking
   still work by pasting text into task bodies; it is "core" not for mechanism but because
   standardizing WHERE the role text lives is what makes critic/aggregator/proposer prompts
   reusable across orchestrators and tools, at near-zero cost. (Honest ranking: the weakest
   "core" member - it is 90% convention - but it costs so little that excluding it to prove
   minimalism would be theater.)

Sanity check against the patterns:
- committee: TASK xN (roles) + GATHER + TASK(aggregator). Needs 1,2,3.
- debate: round 1 = committee; round r+1 = TASK xN with gathered bundle embedded + GATHER.
  Needs 1,2 (3 for role framing).
- map-reduce: TASK xN per-item + GATHER(quorum) + TASK(reducer). Needs 1,2.
- review panel: TASK(worker) -> TASK xM(critics, verdict convention) + GATHER +
  branch on verdicts. Needs 1,2,3 + the P3 convention.

NICE-TO-HAVE (defer; build on demand):

- P3 VERDICT convention - needed only by review-shaped patterns, and it is documentation,
  not mechanism; ship it WITH the first review-panel recipe (it is in the recommended list
  because its cost is near-zero and the review loop is this project's proven daily pattern).
- P4 `agenthop_fanout` batch wrapper - saves N-1 tool calls and gives a tidy task_id map;
  pure convenience over TASK in a loop. Build after composing by hand twice.
- Headless/invisible spawn (bus.7, already user-directed) - makes 5-worker fan-outs
  practical without 5 Ghostty windows; orthogonal to the primitive semantics (visible
  workers compose identically).
- wait_peers (multi-peer status barrier) - covered by per-peer wait_peer loops; gather
  removes the main need.
- Result artifacts beyond text (file manifests on results) - start with "body text +
  paths by convention"; structure it when a real pattern chokes on prose.

SMALLEST SET, stated flat: TASK + GATHER (+ role/expect fields). Two mechanisms, two fields,
one convention. Everything else in the multi-agent literature - MoA layers, debate rounds,
SOP pipelines, hierarchical crews - is an orchestrating agent calling those in a loop with
good prompts.

---

## 4. Collective dumbness: failure modes -> primitive-design mitigations

The inverse question (per MAST: most MAS failures are structural, not model-quality). Each
failure mode maps to specific design choices above - and to what we deliberately did NOT build.

### 4.1 Groupthink / correlated errors (diversity collapse)

- What happens: N agents converge on the same wrong answer; aggregation then LAUNDERS the
  error into false confidence. Debate amplifies it when agents see each other too early and
  anchor (1.1: agreement sensitivity; Surowiecki's independence condition).
- Mitigations baked in: point-to-point envelopes = round-1 independence BY DEFAULT (no
  broadcast primitive exists to leak drafts); FAN-OUT guidance prefers heterogeneous targets
  (different tool/model/machine - agenthop's native asset, 2.3); VERIFY requires a different
  node than the author, given artifact+spec not the author's reasoning (2.5); no shared
  blackboard (2.7) so there is no ambient channel for premature consensus.
- Residual: heterogeneous harnesses on similar frontier models still correlate (same training
  data). Unverified how much cross-tool diversity decorrelates errors in practice - worth a
  dogfood measurement once the primitives exist.

### 4.2 Error amplification / telephone game

- What happens: multi-hop summarization distorts (MetaGPT's motivation, 1.9); an aggregator
  trusts a confident wrong proposer; MAST's "information withholding" / "ignored input".
- Mitigations: GATHER returns ATTRIBUTED, VERBATIM bodies - the aggregator sees originals,
  never bus-made summaries (the bus never paraphrases, stance 3); `expect` on every task
  gives each hop a spec to check against (1.6); VERDICT heads make critic output
  machine-branchable instead of prose that gets skimmed (2.5); artifact-by-reference (review
  the branch, not a pasted diff) keeps the ground truth in git, not in lossy message bodies.
- Residual: the aggregator itself can still be wrong; the only structural answer is a VERIFY
  pass on the aggregate (review panel on the synthesis - composable, not mandatory).

### 4.3 Cost blowup

- What happens: multi-agent = ~15x chat tokens (Anthropic, 1.10); debate rounds multiply it
  (Smit: often for no gain over self-consistency); idle workers burn attention; retry storms.
- Mitigations: primitives are PAY-PER-CALL - no resident framework, no standing crew; the
  composition guidance orders escalation cheapest-first (single agent -> fan-out+aggregate ->
  +1 debate round -> review loop), echoing budget-fixed comparisons (1.1); GATHER
  quorum returns early (first-3-of-5) so stragglers do not extend the spend; `expect` cuts
  rework (the biggest hidden cost per MAST spec failures); spawn stays explicit - the
  orchestrator decides worker count per task, nothing auto-scales.
- Residual: nothing stops an agent from composing an expensive pattern for a cheap question;
  that judgment stays with the orchestrating model (and busInstructions should say so: "one
  agent is the right ensemble size for most tasks").

### 4.4 Deadlock / lost work / zombie waits

- What happens: orchestrator waits forever on a dead worker; worker finishes but the result
  never correlates; two agents wait on each other; a restarted session satisfies the wrong
  wait.
- Mitigations (inherited from the shipped status plane, 2.6): every wait is BOUNDED
  (timeout + explicit re-call continuation, the recv/wait_peer ergonomic); GATHER reports
  GONE workers as failed instead of blocking (wait_peer's gone branch); task_id correlation
  + run pinning means a restarted/replaced session can never satisfy another run's wait
  (bus.6's pin, strengthened by ids); results persist in the inbox until gathered (2.4
  storage note) so "finished before gather was called" is not a loss; quorum lets patterns
  complete around a hung minority. Cycles: structurally possible (any node can task any
  node) but every edge times out, so a cycle degrades to timeouts, not a hang - and the
  visible-window + peers-roster design keeps a human able to see and break it.
- Residual: "unknown" outcomes (bridge send timeout semantics, P2-7 lesson) must propagate
  into gather results honestly - a result marked unknown must not invite a blind duplicate
  re-dispatch of side-effectful work; same wording discipline as the bridge.

### 4.5 Spec drift / role disobedience (MAST category 1)

- What happens: workers solve the wrong problem; critics rubber-stamp ("no or incomplete
  verification"); premature termination.
- Mitigations: `expect` makes DONE explicit per task; VERIFY checks output against `expect`
  (not against the author's narrative); the orchestrator remains a full agent that reads
  results rather than a state machine that pattern-matches "COMPLETED" (MAST's premature
  termination usually hides behind mechanical success signals).
- Residual: a lazy orchestrator prompt produces lazy specs; Anthropic's lesson (detailed
  task descriptions are the lever) belongs in busInstructions as guidance, not in code.

---

## 5. Dependency: the first brick (auto-task result return)

Hard dependency, stated once and precisely: GATHER and VERIFY both consume a RESULT that is
CORRELATED to a dispatched task. Today's bus cannot express that:

- `agenthop_handoff` is fire-and-forget: no task id, no completion signal, no result payload
  (verified against mcp.ts/handoff.ts; analysis in acp-integration.md 5bis.3).
- `agenthop_wait_peer(until: idle)` signals the PEER went quiet, not that THIS task finished,
  and carries no payload (ditto).
- A worker CAN voluntarily `agenthop_send` its findings back (the manual Codex review loop
  does exactly this), but without an id the orchestrator correlates by reading prose - fine
  for 1 worker, unusable for 5.

So the prerequisite is the request/reply brick sketched in acp-integration.md 5bis.4 and the
bus.7 direction: a task id on the dispatch envelope + a result frame (or `[task-result <id>]`
convention) the worker emits, delivered over the existing send path, surviving in the inbox
until collected. That brick is designed in the sibling auto-task doc - THIS doc only pins the
contract it must satisfy for the collaboration layer (section 2.1):

1. task_id unique per dispatch, present on the result;
2. result carries from-handle + status (done|failed|unknown) + body text;
3. results are retrievable after the fact (not lost if they arrive before gather is called,
   not double-surfaced as chat);
4. works for BOTH live-peer tasking (handoff-style) and spawned workers (visible Ghostty or
   bus.7 headless exec), same envelope either way;
5. worker side stays a CONVENTION a full agent follows (the task envelope tells it how to
   reply) - headless exec backends may mechanize it (parent captures stdout as the result,
   acp-integration.md 6), but the bus must not require a special worker runtime.

Build order consequence: P0 first (sibling doc), then GATHER is a small superset of
wait_peer's loop over the result store; ROLE/`expect` can land with P0 itself (fields on the
same envelope).

---

## 6. Recommendation

### 6.1 Ordered build list (each a thin slice; no framework)

1. P0 TASK - the first brick (sibling auto-task design; fields: role?, expect?, task_id).
   Acceptance: dispatch to a live peer and to a spawned worker; result auto-correlates.
2. P2 GATHER - `agenthop_gather(task_ids, {quorum?, timeout_s?})` as a wait_peer-style
   bounded barrier over the result store; attributed verbatim bundle; gone/failed honesty.
   Acceptance: 3-worker fan-out composed by hand completes with quorum=2 while one worker
   is killed mid-task.
3. P1 ROLE polish - ensure role/expect render well in every delivery channel (visible
   handoff envelope, headless prompt arg); document the standard role vocabulary
   (proposer/critic/aggregator/worker) in busInstructions as GUIDANCE text.
4. P3 VERDICT convention - busInstructions + review-recipe doc; optional `kind:"review"`
   envelope hint. Ship together with the first review-panel dogfood run.
5. P4 `agenthop_fanout` - only after step 2's acceptance test has been hand-composed at
   least twice and the loop is demonstrably annoying. (Prediction to check, not a promise.)

Dogfood gate (same discipline as every prior phase): replace THIS project's manual Codex
review loop with the composed review panel (6.2) before calling the layer done - the project
is its own first user.

### 6.2 Worked example: review panel (generalizing the shipped Codex loop)

Orchestrator = any session holding finished work on branch B.

```
1. peers = agenthop_peers()                      # pick 2 critics on DIFFERENT tools
2. t1 = agenthop_task("codex:Work",  "Review branch B against spec S. Run the tests.",
        { role: "adversarial critic: find real defects, severity-tag P1/P2/P3; \
                 approval is failure if a defect exists", 
          expect: "verdict head (pass|fail) + findings list, file:line anchored" })
3. t2 = agenthop_task("opencode:Work@mac2", <same, security focus>, { role: ..., expect: ... })
4. g  = agenthop_gather([t1, t2], { timeout_s: 290 })      # re-call if pending
5. branch: any verdict=fail -> agenthop_task(author-or-self, "Fix findings:\n"+g.results...)
           all pass        -> merge; done.
   disagreement (pass+fail) -> treat as fail, or task a third critic as tiebreaker.
```

6 tool calls, two heterogeneous critics, machine-branchable verdicts - the 12-round spawn
review, expressible by any node without a human relaying findings.

### 6.3 Worked example: debate (cheap first, escalate only on disagreement)

```
1. t[i] = agenthop_task(peer_i, Q, { role: "independent solver; commit to an answer; \
          show working", expect: "final answer on last line" })   for 3 HETEROGENEOUS peers
2. g = agenthop_gather(t, { timeout_s: 120 })
3. if answers agree -> done (self-consistency got it; no debate spend - Smit et al.)
4. else ONE revision round: t2[i] = agenthop_task(peer_i,
        "Your answer: <own>. Others answered:\n<attributed others>\n
         Revise or defend; address the strongest disagreement.", { role: "debater" })
5. g2 = agenthop_gather(t2); then agenthop_task(strongest_peer,
        "Pick the best-supported final answer:\n" + g2bundle, { role: "judge/aggregator" })
```

The debate "loop" is 2 gathers and a judge - no debate manager, round count decided by the
orchestrating agent from observed disagreement.

### 6.4 Worked example: map-reduce research (MoA/Anthropic shape)

```
1. subtopics = orchestrator decomposes the question (its own reasoning, per-item payloads)
2. for s in subtopics: t[s] = agenthop_task(spawn-or-live worker,
        "Research: " + s + " ... cite sources, write findings to docs/research/frag-<s>.md",
        { role: "researcher on exactly this subtopic", expect: "file + 10-line summary" })
   # heterogeneous: spread across claude/codex/opencode, machines via @relay peers
3. g = agenthop_gather(values(t), { quorum: ceil(0.8 * N), timeout_s: 290 })  # stragglers dropped
4. agenthop_task(strongest_model_peer, "Synthesize into one doc; flag conflicts between \
        fragments explicitly:\n" + g summaries + file paths, { role: "aggregator" })
5. optional: feed the synthesis to the review panel (6.2). Patterns compose.
```

Map = TASK xN with per-item prompts; the barrier = GATHER with quorum; reduce = an aggregator
TASK; artifacts travel by file reference, summaries by verbatim attributed text.

### 6.5 What stays out, permanently-until-proven

Group chat, graph engine, role registry, built-in voting, debate manager, shared blackboard,
supervisor objects (2.7). Revisit any of them only when a composed pattern FAILS for the lack
of one - a failure trace, not an architecture appetite, reopens the question.

---

## 7. Sources

Research:
- Du et al., "Improving Factuality and Reasoning in LMs through Multiagent Debate",
  arXiv:2305.14325 (ICML 2024).
- Smit et al., "Should we be going MAD? A Look at Multi-Agent Debate Strategies for LLMs",
  arXiv:2311.17371 (ICML 2024).
- Wang et al., "Mixture-of-Agents Enhances Large Language Model Capabilities",
  arXiv:2406.04692 (ICLR 2025); Self-MoA follow-up arXiv:2502.00674.
- Wang et al., "Self-Consistency Improves Chain of Thought Reasoning", arXiv:2203.11171.
- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST), arXiv:2503.13657.
- Surowiecki, The Wisdom of Crowds (2004) - diversity/independence/decentralization/
  aggregation conditions. (Book; conditions as popularly summarized.)

Frameworks / engineering:
- AutoGen: Wu et al., arXiv:2308.08155; GroupChat/GroupChatManager docs
  (microsoft.github.io/autogen).
- CrewAI: docs.crewai.com (agents: role/goal/backstory; tasks: expected_output; processes:
  sequential/hierarchical).
- LangGraph: Send API / map-reduce branches + Pregel superstep/reducer docs
  (langchain-ai.github.io/langgraph).
- OpenAI Swarm: github.com/openai/swarm (archived; educational) + OpenAI Cookbook
  "Orchestrating Agents: Routines and Handoffs"; successor Agents SDK.
- MetaGPT: Hong et al., arXiv:2308.00352 (ICLR 2024 oral) - SOP assembly line,
  publish-subscribe message pool, structured artifacts, executable feedback.
- Anthropic, "How we built our multi-agent research system"
  (anthropic.com/engineering/built-multi-agent-research-system) - orchestrator-worker,
  ~15x token economics, detailed-task-description lesson.

In-repo (verified 2026-10-01):
- packages/bus/src/mcp.ts (bus tools + busInstructions), spawn.ts (agenthop_spawn/despawn),
  handoff.ts (envelope), core/resolve/statusfile (status plane).
- docs/research/acp-integration.md (A2A vs ACP vs handoff; auto-task verdict in 5bis).
- docs/research/herdr-study.md, blocked-detection-study.md (status/wait design lineage).

Verification note: all paper/framework claims above were re-checked against web sources on
2026-10-01 at the summary level (mechanisms, findings, IDs); exact benchmark numbers quoted
from secondary summaries (e.g. MoA's 65.1% AlpacaEval, MetaGPT's 85.9% HumanEval) were not
re-derived from the papers. Claims marked "unverified" inline (4.1 decorrelation, 2.4 storage
home, 6.1 step-5 prediction) are design judgments to be tested, not established facts.
