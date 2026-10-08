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

> **rounds 2-3 (review @b242d34 → @390a61b → @85089a7 → @e06d98a):** verdicts bound to batch+dir — INCLUDING `batch.json`
> itself (a planted foreign batch.json reads as "no such batch"); consume CLAIMS before reading, under ONE STABLE claim name so
> a newer claim overwrites an older (latest decision wins, no wall-clock ordering); the terminal `consumed.json` is committed via
> temp+link so it appears ONLY complete (a half-written marker never seals) AND is the atomic single winner; a faulted claim is
> RESUMABLE; the notify uses an exclusive lock + a separate sent-proof (at most one ping under concurrency/faults; an intent
> marker is never "sent"); `openBatch` propagates a notify failure; `writeDecisions` refuses a consumed batch. The
> console/coordinator surface is unchanged except these throw cases and the backend-internal files below.
>
> **round-6 (R24, @d18fb9f):** `consumeDecisions` now runs its WHOLE critical section (claim / recover / read / commit) under a
> per-batch exclusive lock `consume.lock`, so the terminal marker is created once and FINAL (no retract), and the claim can't be
> replaced mid-consume. A consumer that cannot take the lock returns `{ consumed:false, contended:true }` (explicit receipt); a
> lock left by a dead/own pid is reclaimable. `writeDecisions` stays UNLOCKED (a concurrent newer decision is accepted), and the
> consume re-claims the LATEST `decisions.json` right before commit so the newer decision wins.
>
> **round-7 (R25, @ca0d7ba):** ORPHAN RECOVERY is now a formal contract (below). The terminal commit checks `createExclusiveAtomic`
> — a lost race (`"exists"`) returns `consumed:false` (never an executable verdict for a lost commit).
>
> **round-8 (R25, @aa0bea5):** orphan identity is by CONTENT DIGEST (not a clock) and deduped PER-UPDATE (`orphan-<digest>.signaled`,
> exclusive-claimed) — a same-second update is signaled, a later different update is never blocked, concurrent emitters never
> double-send. The consume lock is ported to the vm-ssh named-identity DIRECTORY lock (`consume.lockd/<pid>.<nonce>`): reclaim
> removes only a dead holder's exact-named file (never a successor's), release removes only our own named file and never throws
> (a cleanup fault can't mask a committed result).
>
> **round-9 (R25, @47287fa):** two recovery gaps closed. (1) The orphan signal now DELIVERS FIRST and records its proof
> (`orphan-<digest>.sent`) only AFTER the inbox write succeeds — a failed delivery leaves no proof and PROPAGATES, so a retry
> re-sends exactly one (the old pre-send `orphan-<digest>.signaled` claim wrongly made a send-and-rollback fault look done).
> Concurrent double-send is prevented by running every emit (including the terminal-path one) UNDER the consume lock, not by a
> marker; the per-update `.sent` proof dedups across retries. (2) A faulted lock release/publish now leaves a RECOGNIZABLE
> pid-bearing credential, never an identity-less empty dir: release RESTORES its own named file if the final rmdir faults, and a
> failed identity-publish drops the empty dir it just made — so a faulted holder is reclaimed by own/dead pid on retry, while a
> LIVE in-flight (genuinely empty) dir still stays `contended`.

## Orphan recovery (R25) — formal boundary

A decision can be ACCEPTED (written to `decisions.json`) but never consumed into this batch, because the batch became terminal
first (a write that landed during the winning consumer's commit, or after it). Identity is by **content digest** (a sha256 of the
decisions doc), NOT a second-granularity clock — two re-decisions in the same `decidedAtSec` must still be distinguished. When the
current `decisions.json` is valid, bound to this batch, and **digests to a value different from the consumed verdict's digest**
(stored in `consumed.json`), it is an **orphan** (a distinct, un-fulfilled update). The backend emits EXACTLY ONE durable inbox
signal to the batch **owner** (the coordinator): `via:"decision-batch"`, `taskRef:"decision-batch:<id>"`, title
`"orphan decision — re-batch"`. This signal is part of THIS slice and reaches the owner's inbox (not deferred to a seam). The owner
RE-BATCHES the orphan under a NEW batchId (that execution is the coordinator's seam). Delivery is **deliver-first, prove-after**:
the emit writes the inbox message, then records `orphan-<digest>.sent` as the proof-of-sent ONLY on success — a delivery that
FAULTS leaves no proof and PROPAGATES, so a retry re-sends exactly one (a pre-send claim must never make a failed send look done).
Concurrent double-send is prevented by running every emit UNDER the consume lock (the terminal path takes it too), NOT by a marker;
the per-update `.sent` proof then dedups across retries, so a later DIFFERENT update (new digest) is never blocked by an earlier
one, and the consumed verdict never re-signals. A decision whose digest EQUALS the consumed verdict's is already fulfilled ⇒ no
signal.

## Files (under `$HOME/.agenthop/console/decision-batches/<batchId>/`)

- `batch.json` — the coordinator-written batch (schema below). Atomic (temp+rename). Its `batchId` MUST equal the directory
  name; a `batch.json` whose `batchId` ≠ its dir reads as absent (never resolved, never sealed).
- `decisions.json` — the USER-written verdicts (console/CLI writes it). Atomic.
- `decisions-consumed-claim.json` — the CLAIM (ONE stable name): consume renames decisions.json here (claim-before-read) and
  reads THAT. A newer claim atomically OVERWRITES an older one (latest decision wins, no wall-clock ordering). If consume faults
  before the terminal marker, this file is a RECOVERABLE claim a retry resumes.
- `decisions-rejected-claim.json` — a claim set aside: a genuinely-foreign doc (batchId ≠ dir) stays here forever (never
  resolved, never resumed); but a VALID (bound) doc stranded here by a mis-archive or a faulted archive-restore is RECOVERED as
  the claim on the next consume (resume-fallback) — a valid decision is never lost to the rejected slot.
- `consumed.json` — the TERMINAL marker, committed via temp+link: appears ONLY with complete content (a half-written marker
  never seals) and is the single-winner (a second creator gets EEXIST, executes nothing). While present, `writeDecisions` and
  `consumeDecisions` refuse this batch (remaining items were re-asked under a NEW batchId).
- `notified.sent` — the ONLY proof-of-sent (written AFTER the ping). While present, a repeat `openBatch` does not re-ping.
- `notified.lock` — an exclusive link-lock serializing concurrent notifiers; `notified.json` — a pre-send intent record (NOT
  proof of sent). A lock held with no `notified.sent` ⇒ `openBatch` returns UNCERTAIN (throws) rather than re-ping or silently skip.
- `consume.lockd/` — the per-batch exclusive consume lock (a DIRECTORY, atomic mkdir), holder identity = the single file inside
  named `<pid>.<nonce>` (vm-ssh `withIdLock` pattern). Reclaim removes ONLY a dead holder's exact-named file (never a successor's);
  release removes ONLY our own named file and never throws. If release cannot drop the now-empty dir (parent unwritable), it
  RESTORES its own named file so the leftover carries a recognizable pid — reclaimed by own/dead pid on a later consume; a failed
  identity-publish likewise drops the empty dir it made. A genuinely EMPTY (identity-less) dir is a LIVE in-flight acquisition and
  is never reclaimed ⇒ an explicit `contended` receipt (so a faulted holder recovers, a live one is never stolen).
- `orphan-<digest>.sent` — per-update proof-of-sent, written only AFTER the orphan re-batch signal is delivered. Dedups re-emits of
  the same content digest across retries; its absence after a faulted send is what lets a retry re-send exactly one.

A decisions doc OR a batch.json whose `batchId` ≠ its directory is IGNORED (a misbound/foreign drop). Marker/claim/lock files are
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
   sends EXACTLY ONE durable-inbox ping (`via:"decision-batch"`, `taskRef:"decision-batch:<id>"`, text "N decision(s) pending").
   The ping is NOT best-effort and is at-most-once under concurrency/faults: a pre-send intent (`notified.json`) is recorded,
   the ping is sent, then `notified.sent` (the only proof-of-sent) is written; an exclusive `notified.lock` serializes
   notifiers. If the inbox write fails, `openBatch` THROWS and a retry re-sends exactly one; if the send landed but the proof
   could not be recorded (or a concurrent notifier is mid-flight), `openBatch` THROWS DELIVERY-UNCONFIRMED rather than
   re-pinging. A repeat open after a recorded send does not re-ping.
2. Console/CLI renders the one-screen list; the user decides each item; the console writes `decisions.json` via `writeDecisions`.
3. Coordinator `consumeDecisions(home, batchId)` → CLAIMS `decisions.json` first (rename → the stable `decisions-consumed-claim.json`),
   captures that claim's inode, reads exactly the claimed bytes, matches them, then commits `consumed.json` (temp+link) ONLY if
   the claim is still that same instance. Returns `{ resolved, undecided, unknownIds, consumed }`.
4. Coordinator executes `resolved` where `verdict≠defer` (`actionable(resolved)`), and re-batches `undecided` + deferred under a
   NEW batchId. The old batch is now `consumed.json`-marked and never re-decided.

## Consume-once (and consumed-forever), fault-recoverable

`consumeDecisions` CLAIMS `decisions.json` by renaming it to the STABLE `decisions-consumed-claim.json` BEFORE reading, then
reads the CLAIMED file — so a producer that swaps `decisions.json` after the claim lands on a different write, never on the
returned verdicts (no read-then-claim stale window). The stable claim name means a newer claim atomically OVERWRITES an older
one, so the latest decision always wins WITHOUT any wall-clock or random ordering (same-ms and backward-clock both resolve to the
later submission). The batch's single winner is whoever creates `consumed.json` (NOT merely whoever renamed a file): a loser gets
`consumed:false` and executes nothing, so two consumers that both hold a claim still produce at most one actionable result. A "no
decisions yet" call gets `consumed:false` + all `undecided`.

Fault recovery: `consumed.json` is committed via temp+link, so it appears ONLY with complete content — a write interrupted
mid-way (EFBIG, a crash) never leaves a half-written marker that falsely seals the batch. If a consume faults AFTER claiming but
BEFORE the terminal marker (a read EACCES, a commit EACCES/EFBIG), the claim file persists and a retry RESUMES it — one consume
completes with no user resubmit, and the result is never "undecided". A FRESH `decisions.json` supersedes a stale claim (a newer
decision is never overwritten by a failed older one).

After `consumed.json` exists, a re-written `decisions.json` is refused by `writeDecisions` and ignored by `consumeDecisions`
(`consumed:false`) — a verdict is never actionable twice. A misbound/corrupt claim (its `batchId` ≠ dir, or unparseable) yields
no actionable verdict, is set aside as `decisions-rejected-claim.json`, and does NOT mark the batch consumed (a foreign/garbled
drop can neither strand nor starve the user's real decisions).

Notify exactly-once: `notifyOnce` sends at most one ping across concurrency and faults. `notified.sent` (written after the send)
is the only proof-of-sent; a pre-send `notified.json` intent marker is NEVER treated as sent. An exclusive `notified.lock`
serializes concurrent notifiers; a loser re-checks `notified.sent` and otherwise returns UNCERTAIN (throws) rather than
re-sending. A send failure releases the lock so a retry re-sends exactly one; if that release also fails, a retry returns
UNCERTAIN — never a silent zero-ping success, never a duplicate.

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
