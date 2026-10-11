# agenthop roadmap — toward distributed collective intelligence

Status: draft v1 (synthesizes the four research docs below; under multi-round review).

Research this consolidates (read these for the detail; this file is the executable plan):
- `docs/research/auto-task-result-return.md` — the "first brick"
- `docs/research/collab-primitives.md` — the collaboration primitives layer
- `docs/research/shared-blackboard-stigmergy.md` — the emergence layer
- `docs/research/acp-integration.md` — an optional worker-execution backend

## North star

agenthop is **not** another centralized agent-orchestration framework. It is a **distributed substrate for collective intelligence**: heterogeneous agent sessions (any CLI/tool, any model), across machines, autonomous and peer-equal, coordinating **without a central brain**.

Operating principle: **connectivity is necessary but not sufficient.** Networking smart agents can produce collective intelligence *or* collective noise (groupthink, error amplification, cost blow-up). Intelligence is an emergent property of good coordination built on top — so this roadmap is mostly about the *coordination primitives*, built as small composable tools, not a rigid framework.

## The architectural through-line (why this is not a new architecture)

Everything below is the **same pattern agenthop already runs**: a team-derived sealed room + a monotonic / deterministic merge + keeper election. agenthop already ships two de-facto CRDTs — the roster (`directory.ts`, an LWW-Map) and the status file (`statusfile.ts`, a lock-free monotonic max-register). `status → task → board` all generalize that. New code stays thin; the substrate is reused.

## Build order (dependency-ordered)

### Layer 0 — Foundation — DONE / in review
`agenthop_spawn` (visible + headless), `agenthop_handoff`, the peer-status plane (Slice A/B), cross-machine status, status hygiene. Shipping as **bus.7** (`feat/bus7-integration`, tests green, under Codex review).

### Layer 1 — THE FIRST BRICK: auto-task result-return
*Prerequisite for everything downstream — you cannot aggregate or verify without "get a result back."*

Three tools, a framed envelope (`[[agenthop:task]]` / `[[agenthop:task-result]]`) over the existing send path:
- `agenthop_task(to, summary, next?)` → dispatcher-minted `taskId` (reuses `formatHandoff`).
- `agenthop_task_result(task_id, status: done|failed, result, artifacts?)` — worker side.
- `agenthop_task_await(task_ids?, timeout)` — **new primitive** (not a `wait_peer` overload: "idle" ≠ "done with THIS task"; they compose).

Design rules (all code-verified in the research):
- **No store-and-forward**: the broker drops DMs to absent peers; relay mailboxes are recipient-hosted under ephemeral keys. A result is delivered only to a **live run** of the requester, resolved via the restart-stable identity ladder (`stableId → exact title`; no prefix fallback for results) **at send time**.
- Worker **retries** result delivery (receive is idempotent by `taskId`); **task** delivery is NOT auto-retried (a duplicate task = a duplicate instruction).
- **Wire-vs-observer**: `done`/`failed` are worker-asserted wire states; `worker-gone`/`pending` are dispatcher knowledge kept OFF the wire — so a timeout says **"unknown"**, never "failed".
- Dispatcher intercepts result frames by `taskId` before auto-surface; unmatched ("orphan") results render legibly into the TUI (= the restart-recovery path).

MVP ≈ 350 lines (`task.ts` + a core pending table + inbound interception + the three tools + OpenCode wiring). No `spawn.ts` change — `spawn → task → await` composes; headless stdout-synthesis feeds the same completion function. A2A / ACP rejected for this brick (A2A needs holding a task open across a turn + drags the 2.1 MB express layer + `InMemoryTaskStore` has zero durability).

### Layer 2 — Collaboration primitives (built on Layer 1)

The minimal composable set — small tools an orchestrating agent wires together per task, **not** a hardcoded pipeline:
- **GATHER** — `agenthop_gather(task_ids, {quorum?, timeout?})`. The one genuinely-new mechanism: a bounded N-result barrier (`wait_peer` generalized 1→N, status→result). Returns **attributed verbatim** bundles; it **never synthesizes** — the reduce step is always an aggregator TASK.
- **ROLE** — not a tool: `role` + `expect` fields on spawn/task (role/goal + expected-output as prompt text; **no role registry** — that would be central state on a decentralized bus).
- **VERDICT** — a convention: verify/critic = a role + a structured `{verdict: pass|fail}` result head. Generalizes the manual Codex review loop; near-zero code.
- (Fan-out batch wrapper deferred until hand-composition is annoying twice.)

Guardrails from prior art (MoA, "Should we be going MAD?", Du et al., MetaGPT, MAST, Anthropic's multi-agent post):
- **Fan-out + aggregate is the mandatory cheap baseline**; debate often loses to self-consistency at a fixed budget, so debate is a judgment call, not a default.
- **Round-1 independence is load-bearing** → point-to-point envelopes (agenthop has this natively); **do not add broadcast**.
- **Critics should EXECUTE** (run tests/builds), not merely opine.
- Multi-agent costs ~15×; **"one agent is the right ensemble size for most tasks"** — do not multi-agent by default.

Rejected as over-engineering: group chat/broadcast, a graph engine, a role registry, built-in voting, a debate manager, supervisor objects.

### Layer 3 — Shared blackboard (ONLY for emergence; staged, experimental)

**Honest tension:** `collab-primitives.md` lists a shared blackboard as over-engineering; `shared-blackboard-stigmergy.md` designs one. **Resolution:** explicit orchestration (Layers 1–2) does **not** need a blackboard — build those first. The blackboard is the substrate for **emergent self-organization** (the frontier), pursued only as a *measured experiment*, and only from the passive end:
- **Stage A — passive note-board**: a team-wide shared context/learnings board (reuses the `directory.ts` sealed-room CRDT trick; 2 tools `board_post/read`). Real value alone, zero coordination risk, derisks the transport. **Highest-leverage first step if we pursue Layer 3 at all.**
- **Stage B — claimable task-board**: contract-net announce→claim→award, soft lease + deterministic winner fold (lowest `(seq, actor)` wins; losers self-release), manager verdict for termination, idle-pull.
- **Stage C — standing-rule self-organization**: run as a **measured experiment against an orchestrated baseline**, never a promised feature.

Biggest risk is **not** claim races (bounded to ~one gossip round, same class as keeper election) but **silent cost explosion + trust-amplified wrong traces**. Mitigations: event-driven watch (no LLM polling), size caps, mandatory task goals, verdict checkpoints, a human-readable board, and an always-armed fallback to explicit orchestration.

### Cross-cutting — ACP as an optional worker backend
Different axis (client→agent, not agent↔agent). Deferred to **bus.8** as an opt-in `backend: "acp"` for headless/tasked workers, behind a backend seam kept in the CLI binary (never the OpenCode plugin). Native-exec (`claude -p` / `codex exec` / `opencode run`) stays the default. Adopt ACP when we need: multi-turn headless control, policy-level permissions (vs all-or-nothing bypass flags), in-band ordered status, or protocol-level cancel. (Empirically verified working on this machine for OpenCode/Claude/Codex; Gemini blocked by account.)

## Dogfood gate (the proof it's real)
Replace the **manual Codex review loop** we run by hand with the **composed review-panel** (spawn critics as a role → task → gather → verdict). When the composed primitives reproduce our hand-run adversarial review, the collective-intelligence layer is real — not before.

## Honest posture (applies to every layer)
- Each layer earns its place or is cut (YAGNI). Ship the smallest correct version first.
- Collective output must beat single-agent quality **and** its ~15× cost, or don't do it.
- Distributed reality is assumed everywhere: eventual delivery, partial failure, restart. Every primitive is designed for it (timeout = "unknown", identity-ladder delivery, idempotent receive, monotonic merge).
- Emergence (Layer 3C) is a research bet — measured, with a fallback — not a promise.

## Sequence
bus.7 (ship) → **Layer 1** task brick → **Layer 2** gather/role/verdict → [measure value vs single-agent + cost] → **Layer 3A** passive board → 3B claim-board → [experiment] 3C. ACP = bus.8 optional backend, slotted in when a trigger above appears.
