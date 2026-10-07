---
contract: decision-batch
version: 1
status: accepted
authority: backend owner f32a0507
last_updated: 2026-10-07
---

# decision-batch v1 — file + API contract (frozen for the console/front-end)

R22-P1① backend — the **event→decision compression** layer from the DHH eval (`docs/research/dhh-16thread-eval.md`). The
coordinator aggregates N items that each need a human verdict (呈批件 / 并库候选 / 签收确认 / 立项请求) into ONE batch the
user clears on a single screen — DHH's "which of these 12 PRs to merge or close" email, generalized. One line per item,
binary-mostly (approve / reject) + defer.

**Design law (DHH 18:51/19:37):** the bottleneck is human bandwidth; you "cannot intermediate that bandwidth with another
human." So this layer must SHRINK the user's decision load (one ping, one screen, one line/item) and MUST NOT become a
latency-adding approval hop. The coordinator is a compression layer, not a gatekeeper that slows the user.

Frozen so `3e097dfe` (console render) can consume the files directly. Code: `packages/bus/src/swarm/decision-batch.ts` (pure)
+ `decision-batch-store.ts` (IO).

## Files (under `$HOME/.agenthop/console/decision-batches/<batchId>/`)

- `batch.json` — the coordinator-written batch (schema below). Atomic (temp+rename).
- `decisions.json` — the USER-written verdicts (console/CLI writes it). Atomic.
- `decisions-consumed-<ts>-<rand>.json` — a consumed verdicts file, moved aside by consumeDecisions (claim-once).

`batchId` is an opaque locator: `^[A-Za-z0-9_-]{1,64}$`, REJECTED otherwise (never sanitized). Generated form `batch-<16 hex>`.

## `batch.json` schema

```
{ "batchId": string, "owner": string(coordinator stableId), "createdAtSec": number,
  "items": [ { "id": string(unique in batch), "kind": string, "summary": string(ONE line),
               "suggestedAction": string(recommended default), "evidenceRef"?: string(POINTER, never inlined content) } ] }
```
Duplicate item ids ⇒ the whole batch is rejected at the write boundary (a verdict would be ambiguous).

## `decisions.json` schema

```
{ "batchId": string, "decidedAtSec": number,
  "decisions": [ { "id": string, "verdict": "approve"|"reject"|"defer", "reason"?: string(one line) } ] }
```

## Flow

1. Coordinator `openBatch(home, {owner, items, nowSec, notifyTo?})` → writes `batch.json`; if `notifyTo` (a stableId) is set,
   writes ONE durable-inbox ping (`via:"decision-batch"`, `taskRef:"decision-batch:<id>"`, text "N decision(s) pending").
2. Console/CLI renders the one-screen list; the user decides each item; the console writes `decisions.json` via `writeDecisions`.
3. Coordinator `consumeDecisions(home, batchId)` → matches decisions to items and CLAIMS them once (atomic rename of
   `decisions.json` aside). Returns `{ resolved, undecided, unknownIds, consumed }`.
4. Coordinator executes `resolved` where `verdict≠defer` (`actionable(resolved)`), and re-batches `undecided` + deferred.

## Consume-once

`consumeDecisions` renames `decisions.json` aside before returning the resolution. Only the winner (rename succeeds) gets
`consumed:true` + the verdicts; a loser / already-consumed call gets `consumed:false` + all items as `undecided` — so the
coordinator never executes the same verdict set twice (the inbox claim discipline).

## resolve semantics (pure, `resolveBatch`)

- `resolved`: items with a verdict (first decision per id wins; a duplicate is ignored). A `defer` is in `resolved` but is NOT
  actionable (it is an explicit "ask again").
- `undecided`: batch items with no decision yet → re-batch next round.
- `unknownIds`: decision ids matching no item → reported, never acted on (a stale/foreign verdict triggers nothing).

## API

- `openBatch(home, {batchId?, owner, items, nowSec, notifyTo?}) → DecisionBatch` (idempotent on batchId)
- `readBatch` / `readDecisions` / `listBatches`
- `writeDecisions(home, DecisionsDoc)` (console/CLI write boundary; validates)
- `consumeDecisions(home, batchId) → {resolved, undecided, unknownIds, consumed}` (claim-once)
- pure: `resolveBatch(batch, doc)`, `actionable(resolved)`, validators.

Read-failure discipline: ENOENT = absent (`null`); any other read error (EACCES/…) THROWS — a read failure is never treated as
empty, so a writer never overwrites an unreadable batch.

## Integration seam (NOT in this slice)

Which real events feed items (呈批 queue, merge candidates, sign-off confirms, project-launch requests), and the coordinator
executing each resolved verdict, is the owner's dispatcher integration — not this backend. Frontend render = `3e097dfe`.

## DEFERRED (not v1)

Per-item threaded discussion · rich actions beyond approve/reject/defer · multi-decider · auto-execute wiring · priority/sort.
