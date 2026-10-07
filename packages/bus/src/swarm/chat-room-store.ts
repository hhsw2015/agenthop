/**
 * Chat-room IO store (Rovai-eval §⑤ minimal slice). The filesystem half of chat-room.ts: it persists each room as an
 * append-only JSONL log + a meta.json under ~/.agenthop/rooms/<roomId>/, assigns the monotonic per-room seq as the SINGLE
 * writer, and fans each post out to the roster's existing durable inboxes (reusing composeInboxMsg/writeInbox).
 *
 * SINGLE-OWNER invariant (v1, honest ceiling): exactly ONE owner process appends (the coordinator/dispatcher, already
 * single-active via its own lock). appendPost is fully SYNCHRONOUS — read-last-seq → stamp → append happen with no `await`
 * between them, so concurrent in-process appends are serialized by the event loop and seq stays monotonic with no gap.
 * A second concurrent WRITER process is out of scope for v1 (would need a per-room single-flight lock, same shape as the
 * dispatcher's); readers (the console tail, offline members) are unrestricted and need no lock.
 *
 * The FILE CONTRACT (log line schema, meta schema, paths, read protocol) is frozen in docs/contracts/chat-room-v1.md so the
 * console/front-end (a separate process) can tail the log directly without importing this module.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { writeInbox, composeInboxMsg } from "../inbox.js";
import {
  type RoomMeta, type RoomPost, type RoomPostDraft,
  validRoomMeta, validRoomPost, openRoomMeta, closeRoomMeta, maxSeq, stampPost, postsSince, fanoutTargets,
} from "./chat-room.js";
import { type RoomRateLimiter, rateKey } from "./chat-room-rate.js";

function roomsDir(home: string): string { return path.join(home, ".agenthop", "rooms"); }
function roomDir(home: string, roomId: string): string { assertSafeRoomId(roomId); return path.join(roomsDir(home), roomId); }
function metaPath(home: string, roomId: string): string { return path.join(roomDir(home, roomId), "meta.json"); }
function logPath(home: string, roomId: string): string { return path.join(roomDir(home, roomId), "log.jsonl"); }

/** roomIds name a directory, so they are constrained to a safe, NON-LOSSY charset — `[A-Za-z0-9_-]`, 1-64 chars — and
 *  REJECTED (never sanitized) otherwise (CR-P1-1). A lossy remap let `a/b` and `a_b` collide into ONE room, and `.`/`..`
 *  escaped the rooms root. No `.` at all ⇒ no `..` traversal; no remap ⇒ distinct ids stay distinct. `room-<hex>` passes. */
const SAFE_ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
function assertSafeRoomId(id: string): void {
  if (typeof id !== "string" || !SAFE_ROOM_ID.test(id)) throw new Error(`chat-room: unsafe roomId ${JSON.stringify(id)} — allowed [A-Za-z0-9_-], 1-64 chars`);
}

/** Generate a fresh room locator: `room-<16 hex>` (opaque, unguessable-enough, directory-safe). */
export function newRoomId(): string { return `room-${randomBytes(8).toString("hex")}`; }

/** Read + validate a room's meta, or null if absent/unreadable/corrupt. */
export function readMeta(home: string, roomId: string): RoomMeta | null {
  let raw: string;
  try { raw = readFileSync(metaPath(home, roomId), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } // CR-P1-3: a READ failure (EACCES/…) is NOT "absent" — propagate so a writer refuses to overwrite (an unsafe-id throw from roomDir propagates too)
  try { return validRoomMeta(JSON.parse(raw)); } catch { return null; } // readable-but-corrupt ⇒ null (recreatable), distinct from a read failure
}

/** Atomically persist meta (temp + rename, 0600). Validates at the write boundary (CR-P2-1): never persist a meta the read
 *  side would reject (e.g. empty topic ⇒ readMeta null). */
function writeMeta(home: string, meta: RoomMeta): void {
  // CR-P2-1: persist the NORMALIZED result (owner forced into the roster, deduped), not the caller's raw object — else the
  // file could violate the frozen invariant (dupes / missing owner) while reads masked it via validRoomMeta's normalization.
  const valid = validRoomMeta(meta);
  if (!valid) throw new Error("writeMeta: refusing to persist invalid room meta (roomId/topic/owner must be non-empty)");
  const dir = roomDir(home, valid.roomId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = metaPath(home, valid.roomId);
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(valid), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Open a room (meeting-room: per topic, minimal roster). Idempotent: if the roomId already has meta, the existing meta is
 *  returned unchanged (re-opening the same topic is a no-op, never a reset). Generates a roomId when omitted. */
export function openRoom(home: string, i: { roomId?: string; topic: string; owner: string; roster?: string[]; nowSec: number }): RoomMeta {
  const roomId = i.roomId ?? newRoomId();
  const existing = readMeta(home, roomId);
  if (existing) return existing;
  const meta = openRoomMeta({ roomId, topic: i.topic, owner: i.owner, roster: i.roster, nowSec: i.nowSec });
  writeMeta(home, meta);
  return meta;
}

/** Close a room (meeting adjourned). Returns the updated meta, or null if the room does not exist. Idempotent. */
export function closeRoom(home: string, roomId: string): RoomMeta | null {
  const meta = readMeta(home, roomId);
  if (!meta) return null;
  const closed = closeRoomMeta(meta);
  writeMeta(home, closed);
  return closed;
}

/** Replace a room's meta (for membership edits via chat-room.ts addMember/removeMember); no-op-safe. */
export function putMeta(home: string, meta: RoomMeta): void { writeMeta(home, meta); }

/** Read every committed post in seq order. A torn/garbage last line (crash mid-append) is SKIPPED, never crashes the read
 *  (the same poison-pill discipline as the inbox): one bad line can't poison the ordered log. */
/** Read the raw log bytes. ENOENT ⇒ "" (a genuinely empty/new room). Any OTHER error (EACCES/EIO, or an unsafe-id throw from
 *  roomDir) PROPAGATES — a read failure must never be mistaken for an empty log (CR-P1-3), which would roll the seq back. */
function readLogRaw(home: string, roomId: string): string {
  try { return readFileSync(logPath(home, roomId), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw e; }
}

/** Parse raw log bytes into valid posts (seq-ordered); a torn/garbage line is SKIPPED (a crash mid-append never poisons the
 *  read). A complete-but-unterminated last line is still parsed — appendPost guarantees the next post is not concatenated onto
 *  it (CR-P1-2). */
function parsePosts(raw: string): RoomPost[] {
  const out: RoomPost[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    let post: RoomPost | null;
    try { post = validRoomPost(JSON.parse(line)); } catch { post = null; }
    if (post) out.push(post);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export function readPosts(home: string, roomId: string): RoomPost[] {
  return parsePosts(readLogRaw(home, roomId));
}

/** The console tail read: posts with seq strictly greater than `sinceSeq` (0 = whole log), in seq order. */
export function readPostsSince(home: string, roomId: string, sinceSeq: number): RoomPost[] {
  return postsSince(readPosts(home, roomId), sinceSeq);
}

/**
 * Append one post as the SINGLE WRITER: read the current max seq, stamp the next seq, append one JSON line. SYNCHRONOUS (no
 * await between read and append) ⇒ in-process appends are serialized and seq is gap-free monotonic. Returns the committed
 * RoomPost. Does NOT fan out — postToRoom does that; appendPost is the pure-persistence primitive (and the room-owner's own
 * posts path). Creates the room dir if missing.
 */
export function appendPost(home: string, roomId: string, draft: RoomPostDraft, nowSec: number): RoomPost {
  const dir = roomDir(home, roomId); // asserts a safe roomId
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const raw = readLogRaw(home, roomId); // CR-P1-3: EACCES throws here — no seq rollback onto an unreadable log
  const post = stampPost(draft, maxSeq(parsePosts(raw)), nowSec); // post.ts = nowSec*1000 (ms) unless draft.ts is set (CR-P2-2)
  const valid = validRoomPost(post); // CR-P2-1: validate+normalize BEFORE writing — never persist what the read side would drop
  if (!valid) throw new Error("appendPost: refusing to write an invalid post (from/fromLabel non-empty strings, ts finite)");
  // CR-P1-2: never concatenate onto an unterminated tail. If the file does not end in LF, write a separating LF first, so a
  // torn/complete-unterminated last line stays its own line and THIS post is always re-readable on its own line.
  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  appendFileSync(logPath(home, roomId), `${prefix}${JSON.stringify(valid)}\n`, { mode: 0o600 });
  return valid;
}

export type PostResult =
  | { post: RoomPost; fannedOut: string[]; throttled?: false }
  | { throttled: true; retryAfterMs: number };

/**
 * Post to a room: append to the ordered log (assign seq) AND fan a durable-inbox copy to every other roster member, so an
 * offline member surfaces it through its existing flush. The room must be OPEN. Fan-out reuses composeInboxMsg (via="room",
 * taskRef=`room:<id>`, title=topic) so each copy is a valid inbox envelope keyed by the member's stableId (F40). A single
 * fan-out write that throws is isolated (best-effort per target) — the log append already succeeded and is the source of
 * truth; a missed inbox copy is recovered when the member tails the log. Returns the post + the stableIds actually written.
 *
 * S14 rate limit: if a `limiter` is supplied and the (room, sender) is over its window, the post is REJECTED (not appended,
 * not fanned) and `{ throttled, retryAfterMs }` is returned — never silently dropped. The first denial in a window also writes
 * ONE throttled receipt to the sender's own inbox (so the sender sees it), deduped so a storm is not mirrored into a receipt
 * storm. The owner's own posts go through appendPost (unlimited); only sender traffic through postToRoom is throttled.
 */
export function postToRoom(home: string, roomId: string, draft: RoomPostDraft, nowSec: number, limiter?: RoomRateLimiter): PostResult {
  const meta = readMeta(home, roomId); // throws on a read failure (CR-P1-3) + on an unsafe roomId (CR-P1-1)
  if (!meta) throw new Error(`postToRoom: no such room ${roomId}`);
  if (meta.state !== "open") throw new Error(`postToRoom: room ${roomId} is closed`);
  if (limiter) {
    const key = rateKey(roomId, draft.from);
    const d = limiter.admit(key, nowSec * 1000); // the limiter window is in ms
    if (!d.ok) {
      if (d.notify) { // one throttled receipt per window, to the sender's own inbox — not silent, not a receipt storm
        // CR-R2-P2-1: consume the once-per-window slot ONLY after the receipt is actually written. A failed write leaves the
        // slot open (a later denial re-sends) yet STILL returns throttled (never a silent drop, never a throw to the caller).
        let delivered = false;
        try {
          writeInbox(home, draft.from, composeInboxMsg({
            from: draft.from, fromLabel: draft.fromLabel,
            text: `throttled: room ${roomId} rate limit exceeded; retry in ~${Math.ceil(d.retryAfterMs / 1000)}s`,
            via: "room-throttled", ts: nowSec * 1000, taskRef: `room:${roomId}`, title: meta.topic.slice(0, 48),
          }));
          delivered = true;
        } catch { /* receipt write failed — leave the slot open; the throttled RESULT is still returned */ }
        if (delivered) limiter.markNotified(key, nowSec * 1000);
      }
      return { throttled: true, retryAfterMs: d.retryAfterMs };
    }
  }
  const post = appendPost(home, roomId, draft, nowSec);
  const fannedOut: string[] = [];
  for (const target of fanoutTargets(meta, post.from)) {
    try {
      writeInbox(home, target, composeInboxMsg({
        from: post.from, fromLabel: post.fromLabel, text: post.text,
        via: "room", ts: post.ts, taskRef: `room:${roomId}`, title: meta.topic.slice(0, 48),
      }));
      fannedOut.push(target);
    } catch { /* best-effort: the log is the source of truth; the member recovers the post by tailing the log */ }
  }
  return { post, fannedOut };
}

/** List the roomIds that have a meta on disk (for a roster/console index). Best-effort; unreadable ⇒ []. */
export function listRooms(home: string): string[] {
  try {
    return readdirSync(roomsDir(home), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(metaPath(home, d.name)))
      .map((d) => d.name);
  } catch { return []; }
}
