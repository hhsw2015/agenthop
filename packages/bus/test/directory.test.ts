import { expect, test } from "vitest";
import { mergePresence, type RemotePeer } from "../src/directory.js";

/**
 * The no-regress rule for cross-machine status, tested pure: the directory room's log REPLAYS old
 * presence announces (cursor resets re-read it from the start), so accepting an entry by sender
 * clock alone could roll a fresher work-status back. mergePresence must apply the same monotonic
 * statusSeq guard core.ts applies locally.
 */

function peer(over: Partial<RemotePeer> = {}): RemotePeer {
  return {
    id: "run-1",
    stableId: "session-1",
    tool: "claude",
    cwd: "/tmp/proj",
    title: "claude:proj-session1",
    machine: "mac-a",
    pub: "pubkey",
    ts: 1000,
    ...over,
  };
}

test("first sighting (no previous entry) is taken as-is", () => {
  const next = peer({ status: "working", statusSeq: 3 });
  expect(mergePresence(undefined, next)).toBe(next);
});

test("a strictly newer statusSeq wins", () => {
  const prev = peer({ status: "working", statusSeq: 5, statusText: "old", statusAt: 1 });
  const next = peer({ ts: 2000, status: "idle", statusSeq: 6, statusAt: 2 });
  const merged = mergePresence(prev, next);
  expect(merged.status).toBe("idle");
  expect(merged.statusSeq).toBe(6);
  expect(merged.statusText).toBeUndefined();
});

test("a stale (lower seq) replay keeps the newer status but refreshes presence", () => {
  const prev = peer({ status: "idle", statusSeq: 10, statusText: "done", statusAt: 50 });
  const replay = peer({ ts: 3000, title: "claude:proj-renamed", status: "working", statusSeq: 4, statusText: "stale", statusAt: 40 });
  const merged = mergePresence(prev, replay);
  // Presence fields come from the accepted (newer-by-clock) entry...
  expect(merged.ts).toBe(3000);
  expect(merged.title).toBe("claude:proj-renamed");
  // ...but the status never regresses past the monotonic seq.
  expect(merged.status).toBe("idle");
  expect(merged.statusSeq).toBe(10);
  expect(merged.statusText).toBe("done");
  expect(merged.statusAt).toBe(50);
});

test("an equal seq does not replace (same guard as core: not-newer is dropped)", () => {
  const prev = peer({ status: "idle", statusSeq: 7, statusAt: 70 });
  const merged = mergePresence(prev, peer({ ts: 2000, status: "blocked", statusSeq: 7, statusAt: 60 }));
  expect(merged.status).toBe("idle");
  expect(merged.statusAt).toBe(70);
});

test("a status-less announce (plain presence beat) keeps the known status", () => {
  const prev = peer({ status: "blocked", statusSeq: 9, statusText: "needs approval", statusAt: 90 });
  const merged = mergePresence(prev, peer({ ts: 5000 }));
  expect(merged.ts).toBe(5000);
  expect(merged.status).toBe("blocked");
  expect(merged.statusSeq).toBe(9);
  expect(merged.statusText).toBe("needs approval");
});

test("a different identity starts fresh: no status (or seq gate) leaks across a thread switch", () => {
  const prev = peer({ stableId: "thread-A", status: "idle", statusSeq: 100 });
  const next = peer({ ts: 2000, stableId: "thread-B", status: "working", statusSeq: 1 });
  const merged = mergePresence(prev, next);
  expect(merged.status).toBe("working");
  expect(merged.statusSeq).toBe(1); // thread A's seq 100 must not gate thread B's low seq
});

test("identity falls back to the run id when no stableId was adopted", () => {
  const prev = peer({ stableId: undefined, status: "working", statusSeq: 8 });
  const replay = peer({ stableId: undefined, ts: 2000, status: "idle", statusSeq: 2 });
  expect(mergePresence(prev, replay).statusSeq).toBe(8); // same run-id identity: guard applies
});

test("a previous entry without any seq is simply replaced", () => {
  const prev = peer(); // never reported
  const next = peer({ ts: 2000, status: "working", statusSeq: 1 });
  expect(mergePresence(prev, next)).toBe(next);
});
