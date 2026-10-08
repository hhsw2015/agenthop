# grill-gate v1 — adversarial review packet

owner f32a0507 · 2026-10-08 · branch `feat/grill-gate` off main `5da42b5` · reviewer codex:happycapy-01a0ff49

Scope: PURE pre-dispatch decision module + a dormant T3 seam. No IO, no clock, no live wiring. One new source file + one new
test file + contract. `scripts/` untouched (the seam is exported-but-unwired, dormant-ahead-of-use).

Files: `packages/bus/src/swarm/grill-gate.ts` · `packages/bus/test/grill-gate.test.ts` · `docs/swarm/grill-gate-v1.md`.

## What to grill (boundaries that must hold)

1. **Whole-reject, no silent repair** — every malformed tree (dup id, empty id/prompt, missing `recommended`,
   empty/valueless/duplicate choices, recommended∉choices, parent-XOR-whenAnswers, self-parent, dangling parent, empty/
   non-string whenAnswers, whenAnswers∉parent-domain, cycle) returns `{ok:false}`, never a silently-fixed tree. Adversary:
   find a malformed shape that loads `ok:true`.
2. **Defaults always terminate (R3-b)** — `recommended` is required at load, so `resolveDecisions(tree, {})` always succeeds
   and yields an all-defaults resolution that descends through defaulted parents. Adversary: find a legal tree + answers for
   which resolve fails to terminate or omits a live question.
3. **Liveness / pruning correctness** — a child is live iff its parent (recursively) is live AND answered with a whenAnswers
   value. Dead branches are omitted from the resolution; a stale in-domain answer to a now-dead branch is ignored, NOT an
   error and NOT defaulted into the output. Adversary: a parent default that should unlock/lock a child but doesn't; a
   grandchild whose parent is pruned still appearing.
4. **Validate all answers vs domain regardless of liveness** — an out-of-domain answer or an unknown question id rejects even
   when that branch ends up dead (a bad value is always a caller bug). Adversary: an out-of-domain answer on a dead branch
   that slips through.
5. **Dormant gate** — `grillGateEnabled` default OFF; only `1|true|yes|on` (case-insensitive) ⇒ ON. No live path reads it.
6. **Determinism** — `resolveDecisions` output order = tree order; `foldDecisionsIntoPrd` is deterministic and leaves the PRD
   untouched on empty decisions.

## Verification already run

bus tsc 0 · `grill-gate.test.ts` 17/17 · full bus 83 files / 1085 tests pass (base 5da42b5 + 17). Not pushed, not merged
(merge/wiring gate = coordinator + user).
