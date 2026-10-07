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

> **round-2 (review @b242d34 → @390a61b → @85089a7):** verdicts bound to batch+dir — INCLUDING `batch.json` itself (a planted
> foreign batch.json reads as "no such batch"); consume CLAIMS before reading; the terminal `consumed.json` is an EXCLUSIVE
> create (the atomic batch winner) and a faulted claim is RESUMABLE (a fresh decision supersedes a stale claim); `notified.json`
> is recorded BEFORE the send and rolled back on failure (marker⟺sent, no duplicate ping); `openBatch` propagates a notify
> failure; `writeDecisions` refuses a consumed batch. The console/coordinator surface is unchanged except these throw cases and
> the backend-internal marker/claim files below.

## Files (under `$HOME/.agenthop/console/decision-batches/<batchId>/`)

- `batch.json` — the coordinator-written batch (schema below). Atomic (temp+rename). Its `batchId` MUST equal the directory
  name; a `batch.json` whose `batchId` ≠ its dir reads as absent (never resolved, never sealed).
- `decisions.json` — the USER-written verdicts (console/CLI writes it). Atomic.
- `decisions-consumed-<ts>-<rand>.json` — a CLAIM: consume renames decisions.json here (claim-before-read) and reads THAT. If
  consume faults before the terminal marker, this file is a RECOVERABLE claim a retry resumes; after success it is the archive.
- `decisions-rejected-<ts>-<rand>.json` — a misbound/corrupt claim set aside (never resolved, never resumed).
- `consumed.json` — the TERMINAL marker, EXCLUSIVE-created: the single consumer that creates it closes the batch (others get
  EEXIST and execute nothing). While present, `writeDecisions` and `consumeDecisions` refuse this batch (remaining items were
  re-asked under a NEW batchId).
- `notified.json` — recorded BEFORE the compression ping and rolled back if the send fails (so it exists ⟺ the ping was sent);
  while present, a repeat `openBatch` does not re-ping.

A decisions doc OR a batch.json whose `batchId` ≠ its directory is IGNORED (a misbound/foreign drop). Markers/claim files are
backend-internal; the console writes only `decisions.json`.

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
3. Coordinator `consumeDecisions(home, batchId)` → CLAIMS `decisions.json` first (rename → `decisions-consumed-<ts>`), reads
   exactly the claimed bytes, matches them, then EXCLUSIVE-creates `consumed.json`. Returns `{ resolved, undecided, unknownIds,
   consumed }`.
4. Coordinator executes `resolved` where `verdict≠defer` (`actionable(resolved)`), and re-batches `undecided` + deferred under a
   NEW batchId. The old batch is now `consumed.json`-marked and never re-decided.

## Consume-once (and consumed-forever), fault-recoverable

`consumeDecisions` CLAIMS `decisions.json` by atomic rename BEFORE reading it, then reads the CLAIMED file — so a producer that
swaps `decisions.json` after the claim lands on a different file, never on the returned verdicts (no read-then-claim stale
window). The batch's single winner is whoever EXCLUSIVE-creates `consumed.json` (NOT merely whoever renamed a file): a loser
gets `consumed:false` and executes nothing, so two consumers that both hold a claim still produce at most one actionable result.
A "no decisions yet" call gets `consumed:false` + all `undecided`.

Fault recovery: if a consume faults AFTER claiming but BEFORE the terminal marker (a read EACCES, a marker-write EACCES), the
claim file persists and a retry RESUMES it — one consume completes with no user resubmit, and the result is never "undecided".
A FRESH `decisions.json` supersedes a stale claim (a newer decision is never overwritten by a failed older one).

After `consumed.json` exists, a re-written `decisions.json` is refused by `writeDecisions` and ignored by `consumeDecisions`
(`consumed:false`) — a verdict is never actionable twice. A misbound/corrupt claim (its `batchId` ≠ dir, or unparseable) yields
no actionable verdict, is set aside as `decisions-rejected-*`, and does NOT mark the batch consumed (a foreign/garbled drop can
neither strand nor starve the user's real decisions).

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
