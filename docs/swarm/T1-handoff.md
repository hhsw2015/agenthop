# Brain T1 implementation — handoff to claude:agenthop-f32a0507

You are the brain (business-orchestration) IMPLEMENTER. The prior implementer session (b26fa697) was accidentally
closed; you replace it. This handoff is from the lifecycle/bus session (claude:Work-20cab0a5).

## Scope boundary (important)
- The **lifecycle / VM-recovery / bus / presence / delivery** layer is a SEPARATE track and was just merged to main +
  released as **v0.6.1-bus.9** (PR #18). Do NOT touch it.
- You implement the **brain = business orchestration** per the FROZEN design contracts. Different track, different files.

## Frozen contracts (read these first — they are the spec)
In `/Volumes/Share/projects/dev/agenthop-wt/integration/docs/swarm/`:
1. `brain-design.md` — brain implementation contract, **v3-final frozen**, snapshot SHA256 `3bf23c28…`. Codex 3 rounds
   (5P1/8P2 → 3P1/6P2 → 0/0). **Your implementation entry = §7 (T1).**
2. `team-collab-design.md` — team-collaboration layer (blackboard consensus + durable member comms), **v2-final frozen**,
   overall goal §0 "a company of Dots". Codex 2 rounds (2P1/7P2 → 0/0/0).
3. `projection-schema.md` — read-only projection consumer contract, **v1**, bilaterally aligned with the swarm-viz session.

Review reports (evidence + counterexamples): `~/Work/review-reports/brain-design-review-2026-10-03{,-v2,-v3}.md`,
`team-collab-review-2026-10-03{,-v2}.md`.

## What to build (brain §7)
- **T1**: real Claude-worker single-node closed loop. Start with the PURE-FUNCTION modules (TDD, test-first):
  `packages/bus/src/swarm/task-plan.ts`, `task-result.ts`, `task-state.ts` + their tests — all NEW files, do NOT edit
  `control.ts` / `dispatch-step.ts` / the launcher (zero conflict with the lifecycle track).
- **P0 TASK** (auto-task track) may proceed in PARALLEL with T1.
- **team-collab C0** (durable publisher adapter) depends on P0 → sequence it after.
- **Projection** implementation rides T2 step A.

## Review loop (mandatory, from fe0376cd / the user)
- The design session **claude:agenthop-fe0376cd** owns conformance review.
- Contract questions: ask fe0376cd on the bus ANY time during implementation.
- After EACH phase (T1, etc.) completes: send fe0376cd the **changeset + acceptance results**; it concludes against the
  contracts (invariants + failable acceptance especially).
- **Red line**: the contracts are FROZEN. Changing a protocol clause requires going back to fe0376cd to **reopen the
  Codex review** — NO implementation-side protocol changes. `frozen ≠ live`; the lifecycle layer's own Codex residuals
  are on their own track, not yours.

## First step
Commit the 3 frozen design docs into the repo (they are currently untracked in the integration worktree). Then branch
off main (now at v0.6.1-bus.9) for the brain work and begin T1 with the pure modules + tests.
