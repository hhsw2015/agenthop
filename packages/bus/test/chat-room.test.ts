import { describe, expect, test } from "vitest";
import {
  validRoomPost, validRoomMeta, openRoomMeta, closeRoomMeta, addMember, removeMember,
  maxSeq, stampPost, postsSince, fanoutTargets, type RoomMeta,
} from "../src/swarm/chat-room.js";

const meta = (p: Partial<RoomMeta> = {}): RoomMeta =>
  openRoomMeta({ roomId: "room-1", topic: "t", owner: "own", roster: ["a", "b"], nowSec: 100, ...p });

describe("chat-room pure core", () => {
  test("openRoomMeta: owner auto-joins the roster, deduped, state open", () => {
    const m = openRoomMeta({ roomId: "r", topic: "topic", owner: "own", roster: ["a", "own", "a"], nowSec: 5 });
    expect(m).toMatchObject({ roomId: "r", topic: "topic", owner: "own", state: "open", createdAtSec: 5 });
    expect([...m.roster].sort()).toEqual(["a", "own"]); // deduped, owner present once
  });

  test("lifecycle + membership are immutable transitions", () => {
    const m = meta();
    expect(closeRoomMeta(m).state).toBe("closed");
    expect(m.state).toBe("open"); // original untouched
    expect(addMember(m, "c").roster).toContain("c");
    expect(addMember(m, "a").roster.filter((x) => x === "a")).toHaveLength(1); // dedup
    expect(removeMember(m, "a").roster).not.toContain("a");
    expect(removeMember(m, "own").roster).toContain("own"); // owner (sequencer) cannot be removed
  });

  test("seq: maxSeq + stampPost give gap-free monotonic seq from the authoritative last", () => {
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([{ seq: 3, from: "x", fromLabel: "l", text: "", ts: 1 }, { seq: 7, from: "x", fromLabel: "l", text: "", ts: 1 }])).toBe(7);
    expect(stampPost({ from: "a", fromLabel: "A", text: "hi" }, 7, 200)).toEqual({ seq: 8, from: "a", fromLabel: "A", text: "hi", ts: 200_000 }); // nowSec 200 → ms
    expect(stampPost({ from: "a", fromLabel: "A", text: "hi", ts: 5 }, 0, 200).ts).toBe(5); // explicit ms ts kept
  });

  test("postsSince returns seq-ordered posts strictly after the cursor; 0 = whole log", () => {
    const posts = [
      { seq: 2, from: "a", fromLabel: "A", text: "two", ts: 1 },
      { seq: 1, from: "b", fromLabel: "B", text: "one", ts: 1 },
      { seq: 3, from: "a", fromLabel: "A", text: "three", ts: 1 },
    ];
    expect(postsSince(posts, 0).map((p) => p.text)).toEqual(["one", "two", "three"]);
    expect(postsSince(posts, 1).map((p) => p.seq)).toEqual([2, 3]);
    expect(postsSince(posts, 3)).toEqual([]);
  });

  test("fanoutTargets = roster minus the author AND minus the owner (owner holds the log; its inbox stays low-traffic, S27)", () => {
    const m = meta({ owner: "own", roster: ["a", "b"] }); // roster becomes [own,a,b]
    expect(fanoutTargets(m, "a")).toEqual(["b"]);            // not a (author), not own (owner)
    expect(fanoutTargets(m, "own").sort()).toEqual(["a", "b"]); // owner is the author ⇒ fan to the rest
  });

  test("validRoomPost: good ⇒ typed; torn/garbage ⇒ null (never poisons the ordered read)", () => {
    expect(validRoomPost({ seq: 1, from: "a", fromLabel: "A", text: "hi", ts: 10 })).toMatchObject({ seq: 1, text: "hi" });
    expect(validRoomPost({ seq: 1, from: "a", fromLabel: "A", text: "", ts: 10 })).not.toBeNull(); // empty text allowed
    expect(validRoomPost({ seq: 0, from: "a", fromLabel: "A", text: "x", ts: 1 })).toBeNull();   // seq must be >0
    expect(validRoomPost({ seq: 1.5, from: "a", fromLabel: "A", text: "x", ts: 1 })).toBeNull(); // integer seq
    expect(validRoomPost({ seq: 1, fromLabel: "A", text: "x", ts: 1 })).toBeNull();              // no from
    expect(validRoomPost({ seq: 1, from: "a", fromLabel: "A", text: "x" })).toBeNull();          // no ts
    expect(validRoomPost("{bad")).toBeNull();
  });

  test("validRoomMeta: good ⇒ normalized (owner in roster); bad ⇒ null", () => {
    expect(validRoomMeta({ roomId: "r", topic: "t", owner: "o", roster: ["a"], state: "open", createdAtSec: 1 })!.roster.sort()).toEqual(["a", "o"]);
    expect(validRoomMeta({ roomId: "r", topic: "t", owner: "o", roster: ["a"], state: "paused", createdAtSec: 1 })).toBeNull(); // bad state
    expect(validRoomMeta({ roomId: "r", topic: "t", owner: "o", roster: "a", state: "open", createdAtSec: 1 })).toBeNull();     // roster not array
    expect(validRoomMeta(null)).toBeNull();
  });
});
