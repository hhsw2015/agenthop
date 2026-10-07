import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRoom, closeRoom, appendPost, postToRoom, readPosts, readPostsSince, readMeta, putMeta, listRooms } from "../src/swarm/chat-room-store.js";
import { addMember } from "../src/swarm/chat-room.js";
import { RoomRateLimiter } from "../src/swarm/chat-room-rate.js";
import { claimInbox } from "../src/inbox.js";

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-room-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const draft = (from: string, text: string) => ({ from, fromLabel: from.toUpperCase(), text });

describe("chat-room store (IO)", () => {
  test("openRoom is idempotent; closeRoom flips state; both survive a reread", () => {
    const m = openRoom(HOME, { roomId: "r1", topic: "deploy", owner: "own", roster: ["a", "b"], nowSec: 100 });
    expect(m).toMatchObject({ roomId: "r1", topic: "deploy", state: "open" });
    expect(openRoom(HOME, { roomId: "r1", topic: "CHANGED", owner: "own", nowSec: 999 })).toMatchObject({ topic: "deploy" }); // idempotent, no reset
    expect(closeRoom(HOME, "r1")!.state).toBe("closed");
    expect(readMeta(HOME, "r1")!.state).toBe("closed");
    expect(closeRoom(HOME, "nope")).toBeNull();
  });

  test("appendPost assigns gap-free monotonic seq and persists in order", () => {
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", nowSec: 1 });
    expect(appendPost(HOME, "r", draft("a", "one"), 10).seq).toBe(1);
    expect(appendPost(HOME, "r", draft("b", "two"), 11).seq).toBe(2);
    expect(appendPost(HOME, "r", draft("a", "three"), 12).seq).toBe(3);
    expect(readPosts(HOME, "r").map((p) => [p.seq, p.text])).toEqual([[1, "one"], [2, "two"], [3, "three"]]);
  });

  test("readPosts SKIPS a torn/garbage line (crash mid-append) and still sequences the rest", () => {
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", nowSec: 1 });
    appendPost(HOME, "r", draft("a", "good1"), 10);
    appendFileSync(path.join(HOME, ".agenthop", "rooms", "r", "log.jsonl"), '{"seq":2,"from":"a"\n'); // torn line (no newline-complete JSON)
    appendPost(HOME, "r", draft("a", "good2"), 11); // next append still computes seq from the max VALID (1) -> 2
    const posts = readPosts(HOME, "r");
    expect(posts.map((p) => p.text)).toEqual(["good1", "good2"]);
    expect(posts.map((p) => p.seq)).toEqual([1, 2]); // torn line ignored, no gap, no crash
  });

  test("readPostsSince is the incremental console tail", () => {
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", nowSec: 1 });
    for (const t of ["a", "b", "c"]) appendPost(HOME, "r", draft("x", t), 1);
    expect(readPostsSince(HOME, "r", 0).map((p) => p.text)).toEqual(["a", "b", "c"]);
    expect(readPostsSince(HOME, "r", 2).map((p) => p.text)).toEqual(["c"]);
  });

  test("postToRoom appends to the log AND fans a durable-inbox copy to every other roster member", () => {
    openRoom(HOME, { roomId: "r", topic: "deploy chat", owner: "own", roster: ["alice", "bob"], nowSec: 1 });
    const res = postToRoom(HOME, "r", draft("alice", "status?"), 50);
    if (!("post" in res)) throw new Error("unexpected throttle (no limiter)");
    expect(res.post).toMatchObject({ seq: 1, from: "alice", text: "status?" });
    expect(res.fannedOut).toEqual(["bob"]); // roster minus the author AND minus the owner
    // bob's durable inbox got a valid copy, keyed by its stableId, tagged room:<id>
    const c = claimInbox(HOME, ["bob"], "probe");
    expect(c).toHaveLength(1);
    expect(c[0].msg).toMatchObject({ from: "alice", text: "status?", via: "room", taskRef: "room:r", title: "deploy chat" });
    expect(claimInbox(HOME, ["alice"], "probe")).toHaveLength(0); // author NOT fanned to itself
    expect(claimInbox(HOME, ["own"], "probe")).toHaveLength(0);   // owner NOT fanned (holds the log; inbox stays low-traffic)
    // and the post is in the shared log for the console tail
    expect(readPostsSince(HOME, "r", 0).map((p) => p.text)).toEqual(["status?"]);
  });

  test("postToRoom refuses a missing or closed room (never silently drops)", () => {
    expect(() => postToRoom(HOME, "ghost", draft("a", "x"), 1)).toThrow(/no such room/);
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", roster: ["a"], nowSec: 1 });
    closeRoom(HOME, "r");
    expect(() => postToRoom(HOME, "r", draft("a", "x"), 1)).toThrow(/closed/);
  });

  test("a late-added member receives fan-out of subsequent posts", () => {
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", roster: ["a"], nowSec: 1 });
    putMeta(HOME, addMember(readMeta(HOME, "r")!, "carol"));
    postToRoom(HOME, "r", draft("a", "hello carol"), 2);
    expect(claimInbox(HOME, ["carol"], "probe").map((c) => c.msg.text)).toEqual(["hello carol"]);
  });

  test("listRooms indexes rooms that have meta", () => {
    openRoom(HOME, { roomId: "r1", topic: "t", owner: "o", nowSec: 1 });
    openRoom(HOME, { roomId: "r2", topic: "t", owner: "o", nowSec: 1 });
    mkdirSync(path.join(HOME, ".agenthop", "rooms", "nometa"), { recursive: true }); // a dir with no meta is not a room
    expect(listRooms(HOME).sort()).toEqual(["r1", "r2"]);
  });
});

describe("chat-room store — review round-1 fixes (CR-P1-1..P2-2)", () => {
  test("CR-P1-1: an unsafe roomId is REJECTED (no escape, no alias collision)", () => {
    expect(() => openRoom(HOME, { roomId: "..", topic: "t", owner: "o", nowSec: 1 })).toThrow(/unsafe/);
    expect(() => openRoom(HOME, { roomId: "a/b", topic: "t", owner: "o", nowSec: 1 })).toThrow(/unsafe/);
    expect(() => openRoom(HOME, { roomId: "../../etc", topic: "t", owner: "o", nowSec: 1 })).toThrow(/unsafe/);
    expect(() => postToRoom(HOME, "..", draft("a", "x"), 1)).toThrow(/unsafe/);
    expect(() => readPostsSince(HOME, "a/b", 0)).toThrow(/unsafe/);
    // distinct safe ids never collide; the lossy form that used to collide is now rejected outright
    openRoom(HOME, { roomId: "alpha_beta", topic: "t", owner: "o", nowSec: 1 });
    expect(() => openRoom(HOME, { roomId: "alpha/beta", topic: "t", owner: "o", nowSec: 1 })).toThrow(/unsafe/);
    expect(existsSync(path.join(HOME, ".agenthop", "rooms", "alpha_beta"))).toBe(true);
  });

  test("CR-P1-2: an unterminated tail never swallows the next post (complete-missing-LF AND fragment)", () => {
    const lf = (id: string) => path.join(HOME, ".agenthop", "rooms", id, "log.jsonl");
    // (a) a COMPLETE post with no trailing LF
    openRoom(HOME, { roomId: "ra", topic: "t", owner: "own", nowSec: 1 });
    appendPost(HOME, "ra", draft("a", "one"), 10);
    appendFileSync(lf("ra"), JSON.stringify({ seq: 2, from: "a", fromLabel: "A", text: "two-unterminated", ts: 11 })); // NO "\n"
    const p = appendPost(HOME, "ra", draft("a", "three"), 12);
    expect(p.seq).toBe(3); // seq not reused
    expect(readPostsSince(HOME, "ra", 0).map((x) => x.text)).toEqual(["one", "two-unterminated", "three"]); // the returned post IS re-readable; nothing swallowed
    // (b) an INCOMPLETE fragment with no LF
    openRoom(HOME, { roomId: "rb", topic: "t", owner: "own", nowSec: 1 });
    appendPost(HOME, "rb", draft("a", "g1"), 10);
    appendFileSync(lf("rb"), '{"seq":2,"from":"a","fr'); // torn fragment, no LF
    const q = appendPost(HOME, "rb", draft("a", "g2"), 11);
    expect(q.seq).toBe(2); // fragment never got a valid seq
    expect(readPostsSince(HOME, "rb", 0).map((x) => x.text)).toEqual(["g1", "g2"]); // fragment skipped, returned post re-readable
  });

  test("CR-P2-1: invalid input is REJECTED at the write boundary (never persisted); empty text stays legal", () => {
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", nowSec: 1 });
    expect(() => appendPost(HOME, "r", { from: "a", fromLabel: "", text: "x" }, 1)).toThrow(); // empty fromLabel
    expect(() => appendPost(HOME, "r", { from: "a", fromLabel: "A", text: "x", ts: NaN }, 1)).toThrow(); // NaN ts
    expect(() => openRoom(HOME, { roomId: "r2", topic: "", owner: "o", nowSec: 1 })).toThrow(); // empty topic
    expect(readPosts(HOME, "r")).toHaveLength(0); // nothing from the rejected appends was persisted
    expect(appendPost(HOME, "r", { from: "a", fromLabel: "A", text: "" }, 1).text).toBe(""); // empty text is still valid
  });

  test("CR-P2-2: default ts converts nowSec→ms; explicit draft ts (ms) is kept; fan-out copy ts == post ts", () => {
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", roster: ["bob"], nowSec: 1 });
    expect(appendPost(HOME, "r", draft("a", "x"), 1791324000).ts).toBe(1791324000000); // seconds clock → ms ts
    expect(appendPost(HOME, "r", { from: "a", fromLabel: "A", text: "y", ts: 12345 }, 999).ts).toBe(12345); // explicit ms kept
    const res = postToRoom(HOME, "r", draft("alice", "z"), 1791324001) as { post: { ts: number } };
    expect(res.post.ts).toBe(1791324001000);
    expect(claimInbox(HOME, ["bob"], "probe")[0].msg.ts).toBe(1791324001000); // inbox copy carries the same ms ts
  });

  test("S14 rate limit: over-limit posts are REJECTED (not appended/fanned) with ONE throttled receipt, deduped", () => {
    const rl = new RoomRateLimiter({ limit: 2, windowMs: 60_000 }); // postToRoom feeds the limiter nowSec*1000 (ms)
    openRoom(HOME, { roomId: "r", topic: "deploy", owner: "own", roster: ["alice", "bob"], nowSec: 1 });
    expect("post" in postToRoom(HOME, "r", draft("alice", "m1"), 0, rl)).toBe(true);
    expect("post" in postToRoom(HOME, "r", draft("alice", "m2"), 10, rl)).toBe(true);
    const r3 = postToRoom(HOME, "r", draft("alice", "m3"), 20, rl);
    const r4 = postToRoom(HOME, "r", draft("alice", "m4"), 30, rl);
    expect(r3.throttled).toBe(true);
    if (r3.throttled) expect(r3.retryAfterMs).toBeGreaterThan(0);
    expect(r4.throttled).toBe(true);
    expect(readPostsSince(HOME, "r", 0).map((p) => p.text)).toEqual(["m1", "m2"]); // rejected posts never hit the log
    expect(claimInbox(HOME, ["bob"], "p").map((c) => c.msg.text)).toEqual(["m1", "m2"]); // only admitted posts fanned
    const receipts = claimInbox(HOME, ["alice"], "p"); // sender got ONE throttled receipt for the two rejections (deduped)
    expect(receipts).toHaveLength(1);
    expect(receipts[0].msg).toMatchObject({ via: "room-throttled", taskRef: "room:r" });
    expect(receipts[0].msg.text).toMatch(/throttled/);
  });

  test("CR-P1-3: a read failure (EACCES) is NOT an empty log — refuse to append/overwrite (non-root)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses chmod 0
    openRoom(HOME, { roomId: "r", topic: "t", owner: "own", roster: ["a"], nowSec: 1 });
    appendPost(HOME, "r", draft("a", "one"), 10); // seq 1
    const lf = path.join(HOME, ".agenthop", "rooms", "r", "log.jsonl");
    const mode = statSync(lf).mode & 0o777;
    chmodSync(lf, 0o000);
    let blind = false; try { readFileSync(lf); } catch { blind = true; }
    try {
      if (!blind) return; // environment can still read (root-ish) — cannot exercise EACCES
      expect(() => appendPost(HOME, "r", draft("a", "two"), 11)).toThrow(); // no seq rollback onto an unreadable log
    } finally { chmodSync(lf, mode); }
    expect(appendPost(HOME, "r", draft("a", "two"), 12).seq).toBe(2); // after restore, resumes at 2 (no reuse)
  });
});
