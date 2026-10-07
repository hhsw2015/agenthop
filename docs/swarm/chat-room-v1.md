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

`roomId`: opaque locator (not an auth token). Constrained to `^[A-Za-z0-9_-]{1,64}$`, REJECTED otherwise (never sanitized —
no `.` so no `..` traversal; no remap so no `a/b`↔`a_b` collision). Generated form `room-<16 hex>`.

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

`from`/`fromLabel` reuse the bus envelope (both non-empty). `text` may be empty. Addressing is the STABLE id (F40), never a
run id. `ts` is epoch **ms**: the API clock arg is SECONDS (`nowSec`, same unit as `meta.createdAtSec`), and the default `ts`
CONVERTS `nowSec * 1000`; an explicit `draft.ts` is already ms and is kept verbatim. The fan-out inbox copy carries the SAME
`ts` as the log post. A post is validated at the write boundary (from/fromLabel non-empty, ts finite); invalid input is
rejected, never persisted.

## seq semantics

- `seq` is per-room, monotonic, gap-free, assigned by the owner at append (`maxSeq(existing)+1`).
- appendPost is SYNCHRONOUS ⇒ in-process appends are serialized; seq never duplicates or gaps.
- SINGLE-OWNER invariant (v1): exactly one owner process writes (the coordinator, already single-active). A second
  concurrent writer process is out of scope for v1.
- An unterminated last line (crash mid-append) is never concatenated onto: the owner writes a separating LF first, so every
  returned post is re-readable on its own line and no seq is reused.
- A READ failure (EACCES, not ENOENT) is NOT an empty log: the owner refuses to append (no seq rollback) and refuses to
  overwrite meta. ENOENT = genuinely absent ⇒ a fresh room.

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
- `postToRoom(home, roomId, draft, nowSec, limiter?) → {post, fannedOut} | {throttled, retryAfterMs}` (append + fan-out; throws if room missing/closed; throttles if a limiter is supplied and over-limit)
- `readPosts` / `readPostsSince(home, roomId, sinceSeq)` / `readMeta` / `listRooms` / `putMeta` (membership edits)

## Rate limit (S14 chat-entry throttle)

Per-`(room, sender)` fixed-window cap, protecting the roster's inboxes + the coordinator from a chat flood (mirrors tunnel's
PostCounter). Default **30 posts / 60s / sender / room**, tunable via `new RoomRateLimiter({limit, windowMs})`. The limit caps
a STORM; normal conversation — including the human (highest priority, not exempt) — never reaches it. Applies to sender traffic
through `postToRoom`; the owner's own `appendPost` is unlimited. Over-limit behavior (chosen of the two options): **explicit
reject**, NOT queue-delay — the post is not appended or fanned, `{throttled, retryAfterMs}` is returned, and ONE throttled
receipt (`via:"room-throttled"`) is written to the sender's inbox per window (deduped — a storm is never mirrored into a
receipt storm). Never a silent drop. The limiter is in-memory in the owner process (a restart resets the window).

## Integration seam (NOT in this slice)

A member posts by unicast DM to the owner; the owner calls `postToRoom`. Wiring that recognition into the dispatcher is the
owner's integration, not this backend. Dispatch + check-in stay point-to-point (meeting-room, not office).

## DEFERRED (explicitly NOT in v1)

Turn/fairness fences · in-room approvals · attachments-as-room-objects · reply trees · cross-process concurrent writers.
