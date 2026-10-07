import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRoom, closeRoom, appendPost, postToRoom, readPosts, readPostsSince, readMeta, putMeta, listRooms } from "../src/swarm/chat-room-store.js";
import { addMember } from "../src/swarm/chat-room.js";
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
