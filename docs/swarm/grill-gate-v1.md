---
contract: grill-gate
version: 1
status: proposed
authority: backend owner f32a0507
last_updated: 2026-10-08
---

# grill-gate (烤问门) v1 — pre-dispatch decision tree (pure core + dormant T3 seam)

立项件 (coordinator dispatch, planning-frameworks-eval 头号借项). Before the T3 planner drafts a plan and dispatches N agents,
the design decisions a human should settle are extracted ADVERSARIALLY — one question at a time, down the branches of a
design tree (grill-me's method, self-built, zero telemetry, no upstream tool installed). Every question carries a
RECOMMENDED default, so the gate always terminates without bare-waiting on a human (R3-b 问询带默认, the same 问询不裸等
invariant as `task-wait.ts` openQueryWait). The output is a resolved-decisions list that augments the PRD fed to
`draftPlan` (plan-draft.ts) — DHH's "protect the user's judgment bandwidth" applied pre-hoc (decision-batch is the post-hoc
dual).

Code: `packages/bus/src/swarm/grill-gate.ts` (pure, no IO, no clock). Review packet: `docs/swarm/grill-gate-review-packet.md`.

## Design laws (ported from the house trust boundary)

- **NO silent repair** (mirrors `task-plan.ts` loadPlan): an illegal tree rejects WHOLE with a reason — a silently "fixed"
  tree extracts the wrong decisions. Faults: duplicate id; empty id/prompt; a question with no `recommended`; empty/valueless/
  duplicate `choices`; a `recommended` outside its choices; a half-specified branch edge (parent XOR whenAnswers); self-parent;
  dangling parent; empty/non-string `whenAnswers`; a whenAnswers value outside a constrained parent's domain; a cycle.
- **Defaults are REQUIRED, never fabricated** (mirrors R3-b): `recommended` is mandatory, so `resolveDecisions` can ALWAYS
  terminate by applying defaults to the unanswered live questions. The gate never blocks dispatch.

## Data model

- `GrillQuestion` = `{ id, prompt, recommended, choices?: {value,label?}[], rationale?, parent?, whenAnswers? }`. A branch edge
  (`parent` + `whenAnswers`) makes a question LIVE only when its parent is itself live, answered, and answered with a value in
  `whenAnswers`. A root (no parent) is always live.
- `GrillTree` = `{ questions: GrillQuestion[] }` (empty array = a legal no-op gate).
- `GrillAnswers` = `Record<id, answer>` (human answers only; defaults are NOT stored here).
- `ResolvedDecision` = `{ id, prompt, answer, source: "user"|"default", rationale? }`; `ResolvedDecisions` = `{ decisions: [] }`.

## API (pure)

- `loadGrillTree(input) → {ok,tree} | {ok:false,reason}` — the trust boundary.
- `nextQuestion(tree, answers) → GrillQuestion | null` — the first live-by-user-answers unanswered question in tree order
  (one at a time). `isGrillComplete` = `nextQuestion === null`.
- `resolveDecisions(tree, answers) → {ok,resolved} | {ok:false,reason}` — the termination move: validate answers (reject an
  unknown id or an out-of-domain answer, EVEN on a branch that ends up dead), then descend parents-first taking the user
  answer where present and `recommended` otherwise, computing each child's liveness against the RESOLVED (possibly-defaulted)
  parent answer. Dead branches are omitted; a stale answer to a pruned branch is ignored. Zero answers ⇒ the pure all-defaults
  resolution. Output is in tree order.
- `foldDecisionsIntoPrd(prd, resolved) → string` — the seam output: a deterministic, human-readable `## Resolved decisions
  (grill-gate)` appendix; empty decisions ⇒ PRD unchanged.

## Seam / DORMANT-AHEAD-OF-USE

`grillGateEnabled(env)` = `/^(1|true|yes|on)$/i.test(SWARM_GRILL_GATE)`, default **OFF** — same discipline as
`SWARM_BOARD_ADMIT` / review-seat-autoscale / seat-identity-caps. grill-gate has **no runtime caller**: the live T3
orchestrator that would call `grillGateEnabled()` → interactive `nextQuestion` loop → `resolveDecisions` →
`foldDecisionsIntoPrd(prd, …)` → `draftPlan` is not wired. (The manual A1 live-fire script `packages/bus/scripts/t3-draft-live.ts`
calls `draftPlan` DIRECTLY, not through this gate.) The exported gate + fold ARE the seam, ready to attach when the flag is
flipped. Nothing here is wired into a running path.

## NON-GOALS (not this slice)

Persistence of a tree+answers (the IO half, like plan-bundle) · the LLM that AUTHORS a tree from a PRD · the actual dispatch ·
durable query-wait integration (grill questions could later open `task-wait` query-waits so a timed-out human answer applies
the same default through the sweep — a documented future seam, not wired).
