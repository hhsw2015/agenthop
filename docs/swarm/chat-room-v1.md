---
contract: chat-room
version: 1
status: accepted
authority: backend owner f32a0507
last_updated: 2026-10-07
---

# chat-room v1 — file + API contract (frozen for the console/front-end)

Backend of the Rovai-eval §⑤ group-chat borrow. A **room = meeting room**: opened per topic, closed when done, minimal
roster. ONE owner holds an append-only ordered log; every post gets a monotonic per-room `seq` from that single writer (the
cross-sender sequencer our unicast bus lacks). Members receive a durable-inbox copy; the console renders by tailing the log.

Frozen so `3e097dfe` (console render) can consume files directly without importing the backend. Code: `packages/bus/src/swarm/chat-room.ts` (pure) + `chat-room-store.ts` (IO).

## Files (all under `$HOME/.agenthop/rooms/<roomId>/`)

- `meta.json` — one JSON object, the room's roster + lifecycle (schema below). Atomic (temp+rename).
- `log.jsonl` — append-only; ONE `RoomPost` JSON object per line, `\n`-terminated, in ascending `seq`.

`roomId` is an opaque locator (not an auth token), `^room-[0-9a-f]{16}$` when generated; dir-name chars only.

## `meta.json` schema

```
{ "roomId": string, "topic": string, "owner": string(stableId),
  "roster": string[](stableIds, deduped, owner always included),
  "state": "open" | "closed", "createdAtSec": number }
```

## `log.jsonl` line schema (`RoomPost`)

```
{ "seq": integer >0, "from": string(author stableId), "fromLabel": string, "text": string, "ts": number(epoch ms) }
```

`from`/`fromLabel` reuse the bus envelope. `text` may be empty. Addressing is the STABLE id (F40), never a run id.

## seq semantics

- `seq` is per-room, monotonic, gap-free, assigned by the owner at append (`maxSeq(existing)+1`).
- appendPost is SYNCHRONOUS ⇒ in-process appends are serialized; seq never duplicates or gaps.
- SINGLE-OWNER invariant (v1): exactly one owner process writes (the coordinator, already single-active). A second
  concurrent writer process is out of scope for v1.

## Read protocol (console tail)

1. Read `log.jsonl`, split on `\n`, `JSON.parse` each non-empty line, drop any line that fails parse/validation
   (a torn last line from a crash mid-append is SKIPPED, never fatal).
2. Sort by `seq`; keep a cursor; show `seq > cursor` incrementally (`readPostsSince(home, roomId, cursor)`).
3. Poll or fs-watch `log.jsonl`; `meta.json` for roster/state. Reader needs no lock.

## Fan-out (offline members)

Each `postToRoom` also writes a durable-inbox copy to every roster member except the author AND except the owner (the owner
holds the log directly, and its inbox is the swarm's low-traffic coordination channel — S27), via the existing inbox:
`composeInboxMsg({from, fromLabel, text, via:"room", ts, taskRef:"room:<roomId>", title:<topic≤48>})` → `writeInbox(home, memberStableId, …)`.
So an offline member surfaces the post through its normal flush; the canonical ordered view is still the log.

## Backend API (same-process TS consumers, e.g. the dispatcher)

- `openRoom(home,{roomId?,topic,owner,roster?,nowSec}) → RoomMeta` (idempotent; generates roomId when omitted)
- `closeRoom(home, roomId) → RoomMeta|null`
- `appendPost(home, roomId, {from,fromLabel,text,ts?}, nowSec) → RoomPost` (log only, owner's own posts)
- `postToRoom(home, roomId, draft, nowSec) → {post, fannedOut}` (append + fan-out; throws if room missing/closed)
- `readPosts` / `readPostsSince(home, roomId, sinceSeq)` / `readMeta` / `listRooms` / `putMeta` (membership edits)

## Integration seam (NOT in this slice)

A member posts by unicast DM to the owner; the owner calls `postToRoom`. Wiring that recognition into the dispatcher is the
owner's integration, not this backend. Dispatch + check-in stay point-to-point (meeting-room, not office).

## DEFERRED (explicitly NOT in v1)

Turn/fairness fences · in-room approvals · attachments-as-room-objects · reply trees · cross-process concurrent writers.
