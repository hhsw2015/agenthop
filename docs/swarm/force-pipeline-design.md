# force-pipeline — design (half page) + implementation (DA4)

owner f32a0507 · 2026-10-09 · 协调者派单(docker-agent 吸收批末件,user 已批立项)· 借 force_handoff 概念(非机制),参考 docs/research/docker-agent-eval.md Q2 + 立项④ · branch `feat/force-pipeline` off main `bdd93d7` · design + impl 一并交付

## Problem

Our dispatch is LLM-judgment + pull-based (R6/R7 decentralized). It has no declarative way to say "when A finishes, B MUST
receive A's output — no LLM decides". docker-agent's `force_handoff` bypasses the LLM for a strict pipeline (extractor →
summarizer), with cycle-check + no-self-ref. Borrow the CONCEPT: a `force-pipeline` field = a set of forced edges A→B.

## Design

`ForcePipeline = { schema:"force-pipeline/v1", stages: { from, to }[] }`. Each stage is a forced hand-off edge (A→B: when A is
accepted, B is force-dispatched, deterministically). The forced graph must be a DAG.

Pure core (`packages/bus/src/swarm/force-pipeline.ts`, no IO/clock):
- `validateForcePipeline(input, knownNodes?)` — trust boundary, whole-reject: bad schema; non-array stages; a non-object stage;
  a non-string from/to; a SELF-reference (from===to); a DUPLICATE edge; a DANGLING endpoint (not in `knownNodes`, when the
  plan's node set is supplied); a CYCLE (iterative Kahn topological sweep — a cycle = infinite forced hand-off). Reads own data
  only, captured once; walks stages by index; no recursion, no input methods (same discipline as roleProfile v2 / grill-gate).
- `forcedSuccessors(pipeline, from)` — the deterministic forced targets of A (edge order; fan-out allowed); `pipelineOrder` — a
  deterministic topological order (the strict execution sequence).
- `forcePipelineEnabled` (SWARM_FORCE_PIPELINE, default OFF).

Distinct from task-plan `dependsOn`: that is a DATA-flow DAG the scheduler reasons over (readiness/acceptance); a force-pipeline
is a DISPATCH directive — the LLM does not choose the hand-off, it is fixed. The two can coexist (a force edge is a stricter
promise than a dependency).

## Seam (documented, NOT wired)

The attach point is the T3 planner / dispatcher: a plan carries an optional force-pipeline; `validateForcePipeline(pipe,
plan.nodes.map(n=>n.nodeId))` rejects a dangling/cyclic/self-ref pipeline at plan load; after node A is accepted, the dispatcher
force-dispatches each `forcedSuccessors(A)` WITHOUT an LLM/board round. This module is pure + selftested + dormant; no T3 change
here (independent file, flag OFF).

## What to grill (reviewer)

1. Whole-reject — self-ref, duplicate edge, dangling (with knownNodes), and a cycle (2-node, 3-node; a diamond is NOT a cycle)
   all reject; a bad schema/shape rejects.
2. Cycle detection is iterative Kahn (BFS), no recursion; a hijacked `stages` iterator cannot hide a back-edge (index walk).
3. Own-data reads, captured once — a getter from/to is treated as absent ⇒ reject (never invoked); an inherited stage field rejects.
4. Determinism — `forcedSuccessors` is edge-order; `pipelineOrder` is a deterministic topological order.
5. Dormant + non-invasive — `SWARM_FORCE_PIPELINE` default OFF; independent file, no T3/task-plan change.

## Round-1 fixes (0P1/2P2/0P3 @89b3116 → this SHA)

- **FP-P2-1** (dedup key collision): the edge key `from + NUL + to` collided `("a\0b","c")` with `("a","b\0c")` (NUL is a legal
  endpoint char). De-dup now uses a NESTED `Map<from, Set<to>>` — a structural key that cannot collide; true duplicates still reject.
- **FP-P2-2** (knownNodes iterator): `new Set(knownNodes)` ran the input array's (hijackable) iterator. The set is now built from
  the actual slots by index (with an Array.isArray guard); existence checks use the real node list.

## Verification

force-pipeline.test.ts 13/13 (2 new round-1 regressions) · reviewer probe `pipeline-boundaries.test.ts` 7/7 (was 5/7) · bus tsc
0 · full bus 87 files / 1160 pass. Not pushed, not merged (merge/enable gate = coordinator + user).
