import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { capStatusText, mergePresence, nextInstanceEpoch, type RemotePeer } from "../src/directory.js";

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

test("a different identity is adopted ONLY when strictly newer by ts — a late/same-ts cross-identity announce keeps prev (P2-6 ext)", () => {
  const b = peer({ stableId: "thread-B", ts: 1_010_000, status: "working", statusSeq: 1 });
  const olderA = peer({ stableId: "thread-A", ts: 1_000_000, status: "idle", statusSeq: 5 });
  expect(mergePresence(b, olderA)).toBe(b); // older cross-identity announce must NOT replace the newer entry...
  const sameTsA = peer({ stableId: "thread-A", ts: 1_010_000, status: "idle", statusSeq: 5 });
  expect(mergePresence(b, sameTsA)).toBe(b); // ...nor a same-ms one (can't be ordered → keep prev, no flip-flop)
});

test("per-run revision adopts a legitimate same-ms identity switch (by rev, not rejected by equal ts), rejects an older-rev replay (P2-6 rev)", () => {
  const a = peer({ stableId: "thread-A", ts: 1000, rev: 5, status: "idle", statusSeq: 2 });
  const bSwitch = peer({ stableId: "thread-B", ts: 1000, rev: 6, status: "working", statusSeq: 1 }); // same ms, NEXT revision
  expect(mergePresence(a, bSwitch).stableId).toBe("thread-B"); // the real switch is adopted by rev, despite the equal ts
  const lateA = peer({ stableId: "thread-A", ts: 1000, rev: 5, status: "idle", statusSeq: 2 }); // an older-rev replay
  expect(mergePresence(bSwitch, lateA)).toBe(bSwitch); // lower rev ⇒ keep B (no regression to the prior identity)
});

test("a new relay INSTANCE (higher epoch) is adopted wholesale despite a reset rev — reconnect switches to the live pub; an old-epoch replay cannot reclaim (P2 reconnect)", () => {
  const oldInst = peer({ ts: 1000, epoch: 100, rev: 10, pub: "pubA", status: "idle", statusSeq: 5 });
  const newInst = peer({ ts: 1001, epoch: 200, rev: 1, pub: "pubB", status: "working", statusSeq: 1 }); // reconnect: new epoch, rev reset, NEW pub
  const merged = mergePresence(oldInst, newInst);
  expect(merged.pub).toBe("pubB"); // adopt the live mailbox at once, even though rev went 10 → 1
  expect(merged.epoch).toBe(200);
  expect(merged.statusSeq).toBe(1); // the fresh instance's status is taken too (not gated by the old seq)
  expect(mergePresence(newInst, oldInst)).toBe(newInst); // the closed old instance's replay can't reclaim
});

test("identity falls back to the run id when no stableId was adopted", () => {
  const prev = peer({ stableId: undefined, status: "working", statusSeq: 8 });
  const replay = peer({ stableId: undefined, ts: 2000, status: "idle", statusSeq: 2 });
  expect(mergePresence(prev, replay).statusSeq).toBe(8); // same run-id identity: guard applies
});

test("a previous entry without any seq is simply replaced", () => {
  const prev = peer(); // never reported
  const next = peer({ ts: 2000, status: "working", statusSeq: 1 });
  expect(mergePresence(prev, next)).toEqual(next); // value-equal (merge builds a fresh object)
});

test("a clock rollback (lower ts) never discards a higher statusSeq (P2-5)", () => {
  const prev = peer({ ts: 1000, status: "working", statusSeq: 1 });
  const next = peer({ ts: 500, status: "idle", statusSeq: 2 }); // sender's wall clock went backwards
  const merged = mergePresence(prev, next);
  expect(merged.status).toBe("idle"); // status advances by seq, NOT gated by the lower ts
  expect(merged.statusSeq).toBe(2);
  expect(merged.ts).toBe(1000); // presence keeps the fresher (higher) ts
});

test("a late lower-seq announce at the same ts keeps the status watermark (P2-6)", () => {
  const prev = peer({ ts: 1000, status: "idle", statusSeq: 2 });
  const late = peer({ ts: 1000, status: "working", statusSeq: 1 }); // same ms, lower seq, arrives after
  const merged = mergePresence(prev, late);
  expect(merged.status).toBe("idle"); // the higher per-identity seq (2) wins regardless of the equal ts
  expect(merged.statusSeq).toBe(2);
});

test("nextInstanceEpoch is strictly increasing even for restarts within the same ms (filename max-register)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-epoch-"));
  const e1 = nextInstanceEpoch(home)!;
  const e2 = nextInstanceEpoch(home)!;
  const e3 = nextInstanceEpoch(home)!;
  expect(e2).toBeGreaterThan(e1); // max(now, maxSeen+1) advances even when the clock does not
  expect(e3).toBeGreaterThan(e2);
});

test("nextInstanceEpoch never allocates at/below a published high-water mark — a stale low file or clock rollback can't strand a restart (P2 concurrent)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-epoch-"));
  const dir = path.join(home, ".agenthop", "epoch");
  mkdirSync(dir, { recursive: true });
  const high = Date.now() + 5_000_000; // a prior instance whose (skewed) clock ran far ahead
  writeFileSync(path.join(dir, String(high)), "");
  writeFileSync(path.join(dir, String(high - 1000)), ""); // a stale LOW create landing after the high mark
  // Reads the true max over filenames, so neither the lower file nor a now-regressed clock can produce a
  // value <= high (which the epoch gate would reject forever).
  expect(nextInstanceEpoch(home)!).toBeGreaterThan(high);
});

test("nextInstanceEpoch OMITS the epoch (undefined) instead of publishing a possibly-low value when it can't establish the on-disk max (P2 degrade)", () => {
  // home is a FILE, so creating/reading <home>/.agenthop/epoch fails — the allocator must NOT fall back to a bare
  // clock (which could sit below a prior instance's epoch and strand it); it returns undefined so the announce
  // omits the epoch and mergePresence falls back to rev/ts (bounded, never a permanent strand).
  const fileHome = path.join(mkdtempSync(path.join(tmpdir(), "ah-epoch-")), "not-a-dir");
  writeFileSync(fileHome, "x");
  expect(nextInstanceEpoch(fileHome)).toBeUndefined();
});

test("nextInstanceEpoch omits at the numeric ceiling rather than create an unsafe-integer name that would drop the real max (P3)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-epoch-"));
  const dir = path.join(home, ".agenthop", "epoch");
  mkdirSync(dir, { recursive: true });
  const ceiling = String(Number.MAX_SAFE_INTEGER); // an adversarial pre-placed ceiling value
  writeFileSync(path.join(dir, ceiling), "");
  expect(nextInstanceEpoch(home)).toBeUndefined(); // candidate = seen+1 is unsafe → omit, never create/prune
  expect(existsSync(path.join(dir, ceiling))).toBe(true); // the real max is untouched (returned before any create)
});

test("capStatusText truncates an oversized note so a sealed presence can't exceed the relay limit (P3)", () => {
  expect(capStatusText(undefined)).toBeUndefined();
  expect(capStatusText("short")).toBe("short");
  const capped = capStatusText("x".repeat(50_000))!;
  expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(2 * 1024 + 4); // ≤ cap (+ the "…" marker's bytes)
  expect(capped.endsWith("…")).toBe(true);
});
