import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectStalledInboxes, scanInboxes, type InboxStat } from "../src/swarm/inbox-sentinel.js";
import { writeInbox, claimInbox } from "../src/inbox.js";

const NOW = 10_000; // seconds
const stat = (p: Partial<InboxStat> & { key: string }): InboxStat => ({ unclaimedCount: 1, oldestUnclaimedAtMs: (NOW - 700) * 1000, ...p });

describe("F40 detectStalledInboxes — pure stall decision", () => {
  const none = () => false; // nothing is owned by a live session

  test("unclaimed mail older than the threshold with NO live owner ⇒ alert", () => {
    const a = detectStalledInboxes([stat({ key: "dead-box", unclaimedCount: 3 })], none, 600, NOW);
    expect(a).toEqual([{ key: "dead-box", unclaimedCount: 3, staleSec: 700 }]);
  });

  test("a live owner ⇒ never alerted, however old the backlog looks", () => {
    expect(detectStalledInboxes([stat({ key: "owned" })], (k) => k === "owned", 600, NOW)).toEqual([]);
  });

  test("fresh backlog (younger than the threshold) ⇒ no alert (a drainer may just not have run its flush yet)", () => {
    expect(detectStalledInboxes([stat({ key: "fresh", oldestUnclaimedAtMs: (NOW - 100) * 1000 })], none, 600, NOW)).toEqual([]);
  });

  test("empty box (count 0) ⇒ no alert", () => {
    expect(detectStalledInboxes([stat({ key: "empty", unclaimedCount: 0 })], none, 600, NOW)).toEqual([]);
  });
});

describe("F40 scanInboxes — fail-soft fs scan", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-sentinel-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

  // Real inbox keys are swarm stableIds (UUID form); the F44-② scanInboxes filter only scans those, so these tests use UUID keys.
  const BOX = "11111111-1111-4111-8111-111111111111";
  const LIVE = "22222222-2222-4222-8222-222222222222";
  const DEAD = "33333333-3333-4333-8333-333333333333";
  const ORPHAN = "44444444-4444-4444-8444-444444444444";
  test("counts DELIVERABLE (.json) messages and reports the oldest ts from the filename", () => {
    writeInbox(HOME, BOX, { from: "x", fromLabel: "p", text: "old", via: "local", ts: 1000 });
    writeInbox(HOME, BOX, { from: "x", fromLabel: "p", text: "new", via: "local", ts: 5000 });
    const [s] = scanInboxes(HOME);
    expect(s).toMatchObject({ key: BOX, unclaimedCount: 2, oldestUnclaimedAtMs: 1000 });
  });

  test("F40-3: a LIVE-pid claim is in-flight (not counted); a DEAD-pid orphan claim is stranded (counted)", () => {
    writeInbox(HOME, LIVE, { from: "x", fromLabel: "p", text: "a", via: "local", ts: 1000 });
    claimInbox(HOME, [LIVE], "111"); // .json -> .json.claim-111
    writeInbox(HOME, DEAD, { from: "x", fromLabel: "p", text: "b", via: "local", ts: 2000 });
    claimInbox(HOME, [DEAD], "222"); // .json -> .json.claim-222
    const stats = scanInboxes(HOME, (pid) => pid === 111); // 111 alive, 222 dead (injected)
    expect(stats.find((s) => s.key === LIVE)).toBeUndefined();                              // live claim ⇒ in flight ⇒ skipped
    expect(stats.find((s) => s.key === DEAD)).toMatchObject({ key: DEAD, unclaimedCount: 1, oldestUnclaimedAtMs: 2000 }); // dead orphan ⇒ stranded
  });

  test("F40-3: a dead-pid orphan ALERTS when past threshold with no owner (end-to-end with detectStalledInboxes)", () => {
    writeInbox(HOME, ORPHAN, { from: "x", fromLabel: "p", text: "stuck", via: "local", ts: (NOW - 700) * 1000 });
    claimInbox(HOME, [ORPHAN], "222");
    const stats = scanInboxes(HOME, () => false); // holder dead
    expect(detectStalledInboxes(stats, () => false, 600, NOW)).toEqual([{ key: ORPHAN, unclaimedCount: 1, staleSec: 700 }]);
  });

  test("a missing inbox root ⇒ [] (never throws)", () => {
    expect(scanInboxes(path.join(HOME, "does-not-exist"))).toEqual([]);
  });
});
