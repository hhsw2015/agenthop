# submit-tag — design (one page, for coordinator approval before implement)

owner f32a0507 · 2026-10-09 · 协调者派单(闭合 T5-2 在册 DEFERRED seam:chat-room/inbox 二级产出源未接)· branch `feat/submit-tag` off main `bdd93d7` · design-first, 批后再实现

## Problem (from the T5-2 contract's documented seam)

The dual-bandwidth gauge's B_prod counts ONLY decision-batch items. A 呈批/立项 that enters as a raw chat-room post or inbox
message is invisible until the coordinator compresses it into a batch — so the gauge sees produce LATE. It was deferred because
(a) a `RoomPost` is bare `{seq,from,fromLabel,text,ts}` with no marker, and (b) naively counting raw posts would **double-count**
the decision-batch item they are later folded into. This closes both: a tag convention + a de-dup rule.

## Ruling ① — tag convention (chose by implementation cost)

**Recommend: a new OPTIONAL typed field `intent?: "submit" | "report" | "fyi"`** on the S11 envelope (`InboxMsg`) AND on
`RoomPost`/`RoomPostDraft`. NOT overloading transport `via` (it carries local/relay/durable-inbox and other logic reads it),
NOT a `taskRef` prefix (stringly-typed + collision-prone, and `RoomPost` has no `taskRef` so chat-room needs a new field
anyway — so the prefix route is NOT cheaper). Cost: ~3 additive edits in `inbox.ts` (type + `validInboxMsg` + `composeInboxMsg`,
all optional like the existing `taskRef`/`title`) + ~3 in `chat-room.ts` (type + draft + `appendPost` passthrough). Only
`intent === "submit"` is a verdict-needing produce; `report`/`fyi` are communication and are IGNORED by the gauge (mirrors
T5-2 ruling (3): chat-room sign-offs are communication, never counted). An absent `intent` ⇒ untagged ⇒ not counted (today's
behavior; fully backward-compatible).

## Ruling ② — de-dup (no double-count with decision-batch items)

Count each LOGICAL submission **once**, keyed by a stable content digest, at its EARLIEST timestamp (submit time = the early
signal we want). Mechanism:
- A tagged `submit` contributes `submitDigest = digestOf({from, text})` (or a caller-supplied id) at its post/msg `ts`.
- A decision-batch item that was folded from submit(s) records `foldedFrom?: string[]` (those submit digests). The gauge then
  treats that batch item as ALREADY counted (via the submits) and adds no new produce for it; a batch item with no `foldedFrom`
  counts as today. So: `B_prod = { all submit digests } ∪ { batch-item produce for items with empty foldedFrom }`, each digest
  once. Cost: one optional additive field on the decision-batch item + the coordinator's fold path stamps it.
- **Alternative (no decision-batch change):** a side submit-ledger marks a submit "folded" when compressed; gauge reads both.
  Rejected as the default — the fold knowledge lives at the fold site (the batch item), so `foldedFrom` is the honest home.

## Consumer (pure core + dormant)

`collectBandwidthEvents` gains a tagged-submit scan (chat-room log + inbox) → produce events filtered to `intent==="submit"`,
merged with the existing decision-batch produce through the digest de-dup above. Pure core stays pure (the scan is IO, injected
like the existing decision-batch scan). Gated behind a dormant flag `SWARM_SUBMIT_TAG` (default OFF, dormant-ahead-of-use like
SWARM_BOARD_ADMIT) so wiring lands dark; the gauge's current decision-batch-only behavior is unchanged when off.

## RESOLVED (coordinator ruling 2026-10-09) — B_prod = N

APPROVED all three points; the N-vs-1 question is ruled **B_prod = N** (the recommended case): B_prod's semantics = demand
arrival rate, N logical items are N units of demand; compression is a CONSUME-side efficiency whose benefit must surface as a
higher B_cons + shorter T_drain, NOT as a smaller demand count — recording 1 would false-green the gauge during a high-fold
window, hiding exactly the moment it should warn (Little's-law input distortion). `mergeProduceEvents` implements N.

## IMPLEMENTED (feat/submit-tag)

`intent?` on `inbox.ts` InboxMsg + `swarm/chat-room.ts` RoomPost/Draft (shared `SubmitIntent` in a new pure core
`submit-intent.ts`); `foldedFrom?: string[]` on the decision item; pure `mergeProduceEvents` + `submitDigest` in
`dual-bandwidth.ts`; `submitTagEnabled` + a chat-room/inbox submit scan + foldedFrom de-dup in `dual-bandwidth-store.ts`
(dormant, OFF ⇒ v0 behavior byte-for-byte). Tests: `submit-tag.test.ts` (12) + 5 store-integration cases.

## Scope / non-goals

v1 = tag field + gauge de-dup + dormant flag + heavy selftests. NOT: changing the gauge's zones/thresholds, a UI for intent,
retro-tagging old posts, or auto-compression. No push/merge/enable (coordinator + user gate).
