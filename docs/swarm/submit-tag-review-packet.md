# submit-tag — review packet

owner f32a0507 · 2026-10-09 · branch `feat/submit-tag` off main `bdd93d7` · reviewer codex:happycapy-01a0ff49

Closes the T5-2 DEFERRED seam: chat-room/inbox 呈批 are now a SECONDARY produce source for the dual-bandwidth gauge, de-duped
against the decision-batch items they fold into. Design APPROVED (docs/swarm/submit-tag-design.md); coordinator ruled B_prod=N.

Files (`git diff --stat bdd93d7..HEAD`):
- `packages/bus/src/submit-intent.ts` — NEW pure core vocabulary (`SubmitIntent` + `isSubmitIntent`).
- `packages/bus/src/inbox.ts` — `intent?: SubmitIntent` on InboxMsg + `validInboxMsg` + `composeInboxMsg`.
- `packages/bus/src/swarm/chat-room.ts` — `intent?` on RoomPost/RoomPostDraft + `validRoomPost` + `stampPost`.
- `packages/bus/src/swarm/decision-batch.ts` — `foldedFrom?: string[]` on DecisionItem + `validDecisionItem`.
- `packages/bus/src/swarm/dual-bandwidth.ts` — PURE `submitDigest` + `mergeProduceEvents`.
- `packages/bus/src/swarm/dual-bandwidth-store.ts` — `submitTagEnabled` gate + `scanSubmits` (chat-room+inbox) + foldedFrom-aware produce.
- tests: `test/submit-tag.test.ts` (12) + 5 cases appended to `test/dual-bandwidth-store.test.ts`. Design + this packet.

## What to grill

1. **Dormant / backward-compatible** — `submitTagEnabled` (SWARM_SUBMIT_TAG) default OFF; OFF ⇒ `collectBandwidthEvents` is the
   v0 decision-batch-only path byte-for-byte (one produce per item, no scan). An absent `intent`/`foldedFrom` is always legal.
2. **B_prod = N (no double-count, no under-count)** — `mergeProduceEvents`: a submit folded into a batch item counts ONCE; N
   submits folded into one item = N; a native item (no fold) counts as its own digest; an un-observed folded submit still
   counts once at the item's createdAtSec; earliest timestamp wins. Adversary: a shape that double-counts or drops a submit.
3. **De-dup key integrity** — `submitDigest(from,text)` is content-addressed + time-independent, shared by the raw scan AND the
   `foldedFrom` stamp (so a submit and its fold resolve to the same key); a native item's digest (`{batchId,itemId}`) can never
   collide with a submitDigest (different key shape).
4. **Only `submit` counts** — `report`/`fyi`/untagged are ignored by the gauge (communication, not demand).
5. **Read-fault discipline** — the inbox submit scan propagates an ACCESS fault (never a silent "no events" → false green),
   mirroring the decision-batch scan's design law; a corrupt line/file is skipped. Chat-room uses its existing best-effort readers.
6. **Validation whole-reject** — a present-but-unknown `intent`, or a `foldedFrom` that is not a string[] of non-empty strings,
   rejects the whole envelope/post/item (no silent coercion).

## Known boundaries (carried)

Inbox messages are ephemeral (best-effort early signal; `foldedFrom` is the durable count after a fold). Scanning all inbox
boxes each gauge read is O(messages) — acceptable for a dormant periodic reader. Two byte-identical submissions by one author
de-dup to one (benign resend collapse).

## Verification already run

submit-tag.test.ts 12/12 · dual-bandwidth-store.test.ts 21/21 (5 new) · bus tsc 0 · scripts tsc 0 · full bus 87 files / 1164
tests pass. Not pushed, not merged (merge/enable gate = coordinator + user).
