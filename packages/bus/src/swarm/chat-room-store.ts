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

function roomsDir(home: string): string { return path.join(home, ".agenthop", "rooms"); }
function roomDir(home: string, roomId: string): string { return path.join(roomsDir(home), sanitize(roomId)); }
function metaPath(home: string, roomId: string): string { return path.join(roomDir(home, roomId), "meta.json"); }
function logPath(home: string, roomId: string): string { return path.join(roomDir(home, roomId), "log.jsonl"); }

/** roomIds are locators, not auth tokens — but they name a directory, so constrain them to safe chars (same rule as the
 *  inbox dir). A caller-supplied id is sanitized; a generated one is already safe. */
function sanitize(id: string): string { return id.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown"; }

/** Generate a fresh room locator: `room-<16 hex>` (opaque, unguessable-enough, directory-safe). */
export function newRoomId(): string { return `room-${randomBytes(8).toString("hex")}`; }

/** Read + validate a room's meta, or null if absent/unreadable/corrupt. */
export function readMeta(home: string, roomId: string): RoomMeta | null {
  let raw: string;
  try { raw = readFileSync(metaPath(home, roomId), "utf8"); } catch { return null; }
  try { return validRoomMeta(JSON.parse(raw)); } catch { return null; }
}

/** Atomically persist meta (temp + rename, 0600). */
function writeMeta(home: string, meta: RoomMeta): void {
  const dir = roomDir(home, meta.roomId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = metaPath(home, meta.roomId);
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
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
export function readPosts(home: string, roomId: string): RoomPost[] {
  let raw: string;
  try { raw = readFileSync(logPath(home, roomId), "utf8"); } catch { return []; }
  const out: RoomPost[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    let post: RoomPost | null;
    try { post = validRoomPost(JSON.parse(line)); } catch { post = null; }
    if (post) out.push(post);
  }
  return out.sort((a, b) => a.seq - b.seq);
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
  const dir = roomDir(home, roomId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const last = maxSeq(readPosts(home, roomId));
  const post = stampPost(draft, last, nowSec);
  appendFileSync(logPath(home, roomId), `${JSON.stringify(post)}\n`, { mode: 0o600 });
  return post;
}

export type PostResult = { post: RoomPost; fannedOut: string[] };

/**
 * Post to a room: append to the ordered log (assign seq) AND fan a durable-inbox copy to every other roster member, so an
 * offline member surfaces it through its existing flush. The room must be OPEN. Fan-out reuses composeInboxMsg (via="room",
 * taskRef=`room:<id>`, title=topic) so each copy is a valid inbox envelope keyed by the member's stableId (F40). A single
 * fan-out write that throws is isolated (best-effort per target) — the log append already succeeded and is the source of
 * truth; a missed inbox copy is recovered when the member tails the log. Returns the post + the stableIds actually written.
 */
export function postToRoom(home: string, roomId: string, draft: RoomPostDraft, nowSec: number): PostResult {
  const meta = readMeta(home, roomId);
  if (!meta) throw new Error(`postToRoom: no such room ${roomId}`);
  if (meta.state !== "open") throw new Error(`postToRoom: room ${roomId} is closed`);
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
