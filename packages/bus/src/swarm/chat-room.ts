/**
 * Chat-room pure core (Rovai-eval §⑤ minimal first slice; borrow of Rovai's "Camp"). A room is a MEETING ROOM, not an
 * office: opened per topic, closed when the topic is done, with a minimal roster. It gives the swarm the one shape our
 * unicast bus lacks — "several members + the human around ONE topic, on one screen" — as a thin read-mostly projection over
 * the existing primitives (durable inbox for fan-out, S18 pointer discipline for the log-as-artifact), NOT a new transport.
 *
 * The model (deliberately small; see the DEFERRED list): ONE owner holds an append-only ordered log; every post gets a
 * monotonic per-room `seq` assigned by that single writer (the cross-sender sequencer our point-to-point bus cannot
 * provide — settled by making ONE process the sequencer, exactly as a room "belongs to its owner"). Reads are `postsSince`.
 * Fan-out copies each post to the roster's existing durable inboxes so an offline member still surfaces it.
 *
 * DEFERRED to a later slice (NOT here): turn/fairness fences, in-room approvals, attachments-as-room-objects, reply trees.
 * Addressing reuses the swarm's STABLE identity (F40): roster entries + `from` are stableIds, never a rotating run id.
 *
 * This file is PURE (no fs / no clock beyond an injected `nowSec`), so the ordering + membership + validation decisions are
 * unit-tested without a disk or a broker. The IO half (append/read/fan-out) lives in chat-room-store.ts.
 */

export type RoomState = "open" | "closed";

/** Room metadata: the roster + lifecycle. `owner` is the single writer that assigns `seq` (the sequencer). `roster` are the
 *  stableIds that see the room + receive fan-out (the human is a roster entry too, addressed by its stable id). */
export type RoomMeta = {
  roomId: string;
  topic: string;
  owner: string;      // stableId of the single-writer owner (the sequencer)
  roster: string[];   // stableIds (deduped; owner always included)
  state: RoomState;
  createdAtSec: number;
};

/** One ordered post in a room's append-only log. `seq` is the per-room monotonic sequence assigned by the owner at append
 *  time; `from`/`fromLabel` reuse the bus-delivered envelope shape so a fan-out copy maps 1:1 to a durable inbox message. */
export type RoomPost = { seq: number; from: string; fromLabel: string; text: string; ts: number };

/** A post as handed in before the owner assigns a seq (the input to appendPost). */
export type RoomPostDraft = { from: string; fromLabel: string; text: string; ts?: number };

const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Validate a parsed room-log line (schema guard, same discipline as validInboxMsg): seq a positive finite integer,
 *  from/fromLabel/text non-empty-or-present strings, ts finite. A torn/garbage line ⇒ null ⇒ the reader SKIPS it (never
 *  derefs undefined, never lets one bad line poison the ordered read). `text` may be empty (a post can carry only a pointer
 *  later), but from/fromLabel identify the author and must be present. */
export function validRoomPost(raw: unknown): RoomPost | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq <= 0) return null;
  if (!isNonEmptyStr(r.from) || !isNonEmptyStr(r.fromLabel) || typeof r.text !== "string") return null;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
  return { seq: r.seq, from: r.from, fromLabel: r.fromLabel, text: r.text, ts: r.ts };
}

/** Validate parsed room metadata. roomId/topic/owner non-empty strings, roster a string[] (deduped on read), state a known
 *  value, createdAtSec finite. Returns a normalized meta (owner forced into the roster) or null. */
export function validRoomMeta(raw: unknown): RoomMeta | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyStr(r.roomId) || !isNonEmptyStr(r.topic) || !isNonEmptyStr(r.owner)) return null;
  if (!Array.isArray(r.roster) || !r.roster.every((m) => isNonEmptyStr(m))) return null;
  if (r.state !== "open" && r.state !== "closed") return null;
  if (typeof r.createdAtSec !== "number" || !Number.isFinite(r.createdAtSec)) return null;
  return normalizeMeta({ roomId: r.roomId, topic: r.topic, owner: r.owner, roster: r.roster as string[], state: r.state, createdAtSec: r.createdAtSec });
}

/** Dedup the roster and guarantee the owner is a member (the sequencer is always in its own room). */
function normalizeMeta(m: RoomMeta): RoomMeta {
  const roster = [...new Set([m.owner, ...m.roster])];
  return { ...m, roster };
}

/** Build a fresh OPEN room meta. owner is auto-added to the roster. */
export function openRoomMeta(i: { roomId: string; topic: string; owner: string; roster?: string[]; nowSec: number }): RoomMeta {
  return normalizeMeta({ roomId: i.roomId, topic: i.topic, owner: i.owner, roster: i.roster ?? [], state: "open", createdAtSec: i.nowSec });
}

/** Immutable lifecycle/membership transitions (return a NEW meta; never mutate). */
export function closeRoomMeta(meta: RoomMeta): RoomMeta {
  return { ...meta, state: "closed" };
}
export function addMember(meta: RoomMeta, stableId: string): RoomMeta {
  return normalizeMeta({ ...meta, roster: [...meta.roster, stableId] });
}
export function removeMember(meta: RoomMeta, stableId: string): RoomMeta {
  // the owner cannot be removed (it is the sequencer); everyone else can leave.
  if (stableId === meta.owner) return meta;
  return { ...meta, roster: meta.roster.filter((m) => m !== stableId) };
}

/** The highest seq among committed posts (0 if none) — the pure basis for assigning the next seq. Robust to out-of-order
 *  input: takes the max, not the last element. */
export function maxSeq(posts: RoomPost[]): number {
  let m = 0;
  for (const p of posts) if (p.seq > m) m = p.seq;
  return m;
}

/** Stamp a draft with the next monotonic seq after `lastSeq`. Pure: the caller (store) supplies the authoritative lastSeq
 *  and the clock. `nowSec` is epoch SECONDS (the swarm's clock unit, same as meta.createdAtSec); the post `ts` is epoch
 *  MILLISECONDS (matching the inbox envelope + the frozen contract), so the default CONVERTS `nowSec * 1000`. An explicit
 *  `draft.ts` is already ms and is kept verbatim. */
export function stampPost(draft: RoomPostDraft, lastSeq: number, nowSec: number): RoomPost {
  return { seq: lastSeq + 1, from: draft.from, fromLabel: draft.fromLabel, text: draft.text, ts: draft.ts ?? nowSec * 1000 };
}

/** The incremental read the console tail uses: posts with seq STRICTLY greater than `sinceSeq`, in seq order. `sinceSeq=0`
 *  returns the whole log. Sorted defensively so a reader never depends on file line order. */
export function postsSince(posts: RoomPost[], sinceSeq: number): RoomPost[] {
  return posts.filter((p) => p.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
}

/** Who gets a durable-inbox fan-out copy of a post: every roster member EXCEPT the author (already has it) and EXCEPT the
 *  OWNER. The owner holds the log itself (reads it directly), and — crucially — the owner is the coordinator, whose durable
 *  inbox is the swarm's low-traffic coordination channel (S27: only rulings/blocks/summaries); flooding it with every room
 *  post would defeat that. Members who are not watching the log live still surface the post via their own inbox. */
export function fanoutTargets(meta: RoomMeta, authorStableId: string): string[] {
  return meta.roster.filter((m) => m !== authorStableId && m !== meta.owner);
}
