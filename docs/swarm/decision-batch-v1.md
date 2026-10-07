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

> **round-2 (review @b242d34 → fixes @390a61b):** verdicts bound to batch+dir; consume claims-before-read; `consumed.json` /
> `notified.json` durable markers added; `openBatch` propagates a notify failure; `writeDecisions` refuses a consumed batch.
> The console/coordinator surface is unchanged except these two throw cases and the two new backend-internal marker files.

## Files (under `$HOME/.agenthop/console/decision-batches/<batchId>/`)

- `batch.json` — the coordinator-written batch (schema below). Atomic (temp+rename).
- `decisions.json` — the USER-written verdicts (console/CLI writes it). Atomic.
- `decisions-consumed-<ts>-<rand>.json` — a consumed verdicts file, moved aside by consumeDecisions (claim-once).
- `consumed.json` — a durable marker written after a successful consume; its existence means the batch is DONE (remaining
  items were re-asked under a NEW batchId). While present, `writeDecisions` and `consumeDecisions` refuse this batch.
- `notified.json` — a durable marker written after the compression ping lands; its existence means the user was pinged, so a
  repeat `openBatch` does not re-ping.

A decisions doc whose `batchId` ≠ the directory it sits in is IGNORED (a misbound/foreign drop, never resolved here). Markers
are backend-internal; the console does not write them.

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
   writes EXACTLY ONE durable-inbox ping (`via:"decision-batch"`, `taskRef:"decision-batch:<id>"`, text "N decision(s)
   pending") and records `notified.json`. The ping is NOT best-effort: if the inbox write fails, `openBatch` THROWS (no
   `notified.json` written) so the caller knows the user was not pinged; an idempotent retry (same batchId) re-sends it. A
   repeat open after a successful ping does not re-ping.
2. Console/CLI renders the one-screen list; the user decides each item; the console writes `decisions.json` via `writeDecisions`.
3. Coordinator `consumeDecisions(home, batchId)` → CLAIMS `decisions.json` first (atomic rename aside), then reads exactly the
   claimed bytes, matches them, and records `consumed.json`. Returns `{ resolved, undecided, unknownIds, consumed }`.
4. Coordinator executes `resolved` where `verdict≠defer` (`actionable(resolved)`), and re-batches `undecided` + deferred under a
   NEW batchId. The old batch is now `consumed.json`-marked and never re-decided.

## Consume-once (and consumed-forever)

`consumeDecisions` CLAIMS `decisions.json` by atomic rename BEFORE reading it, then reads the claimed file — so a producer that
swaps `decisions.json` after the claim lands on a different file, never on the returned verdicts (no read-then-claim stale
window). Only the claim winner gets `consumed:true` + the verdicts; a loser / "no decisions yet" call gets `consumed:false` +
all items `undecided`. After a successful consume, `consumed.json` is written: a decisions.json re-written afterwards is refused
by `writeDecisions` and ignored by `consumeDecisions` (`consumed:false`), so a verdict is never actionable twice. A
misbound/corrupt claimed doc yields no actionable verdict and does NOT mark the batch consumed (a foreign drop cannot strand the
user's real decisions).

## resolve semantics (pure, `resolveBatch`)

- batch binding: a doc whose `batchId` ≠ `batch.batchId` resolves to NOTHING (empty `resolved`, all items `undecided`, the
  doc's ids reported as `unknownIds`) — a same-id item can never borrow a verdict meant for another batch.
- `resolved`: items with a verdict (first decision per id wins; a duplicate is ignored). A `defer` is in `resolved` but is NOT
  actionable (it is an explicit "ask again").
- `undecided`: batch items with no decision yet → re-batch next round.
- `unknownIds`: decision ids matching no item (or any id from a batch-mismatched doc) → reported, never acted on.

## API

- `openBatch(home, {batchId?, owner, items, nowSec, notifyTo?}) → DecisionBatch` (idempotent on batchId; THROWS if the notify
  write fails — the batch is persisted, retry re-notifies)
- `readBatch` / `readDecisions` (a batch-mismatched doc reads as `null`) / `listBatches`
- `writeDecisions(home, DecisionsDoc)` (console/CLI write boundary; validates; THROWS if the batch is already consumed)
- `consumeDecisions(home, batchId) → {resolved, undecided, unknownIds, consumed}` (claim-before-read; consumed-forever)
- pure: `resolveBatch(batch, doc)` (batch-bound), `actionable(resolved)`, validators.

Read-failure discipline: ENOENT = absent (`null`); any other read error (EACCES/…) THROWS — a read failure is never treated as
empty, so a writer never overwrites an unreadable batch.

## Integration seam (NOT in this slice)

Which real events feed items (呈批 queue, merge candidates, sign-off confirms, project-launch requests), and the coordinator
executing each resolved verdict, is the owner's dispatcher integration — not this backend. Frontend render = `3e097dfe`.

## DEFERRED (not v1)

Per-item threaded discussion · rich actions beyond approve/reject/defer · multi-decider · auto-execute wiring · priority/sort.
