import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { shouldInjectWake, wakeSession, runWakeBackstop, inboxWakeEnabled, installInboxWake, claimWakeSlot, wakeText, type WakeDeps } from "../src/swarm/inbox-wake.js";
import { writeInbox, setInboxWakeHook, scanUnclaimedInbox } from "../src/inbox.js";

const COOL = 120_000;

describe("inbox-wake — shouldInjectWake (pure wakeable decision)", () => {
  test("wakeable only when idle + unclaimed; working/unknown/empty/cooldown/non-finite ⇒ no", () => {
    expect(shouldInjectWake(1e6, -Infinity, "idle", 1, COOL)).toBe(true);
    expect(shouldInjectWake(1e6, -Infinity, "working", 9, COOL)).toBe(false);
    expect(shouldInjectWake(1e6, -Infinity, "unknown", 9, COOL)).toBe(false);
    expect(shouldInjectWake(1e6, -Infinity, "idle", 0, COOL)).toBe(false);
    expect(shouldInjectWake(1e6, 1e6 - 1, "idle", 3, COOL)).toBe(false);
    expect(shouldInjectWake(1e6, 1e6 - COOL, "idle", 3, COOL)).toBe(true);
    expect(shouldInjectWake(NaN, -Infinity, "idle", 1, COOL)).toBe(false);
  });
});

describe("inbox-wake — claimWakeSlot (先占后发, cross-process atomic)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wake-")); });
  afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
  const w = (n: number) => n * COOL;
  test("one winner per window; same-window loses; newer window wins; bad clock ⇒ no claim; dot-sid safe", () => {
    expect(claimWakeSlot(HOME, "c", w(8), COOL)).toBe(true);       // window 8 wins
    expect(claimWakeSlot(HOME, "c", w(8) + 1, COOL)).toBe(false);  // same window, another process ⇒ loses
    expect(claimWakeSlot(HOME, "c", w(9), COOL)).toBe(true);       // next window (advances high-water)
    expect(claimWakeSlot(HOME, "..", w(8), COOL)).toBe(true);      // reserved-dot sid hashed to a safe filename (no traversal)
    expect(claimWakeSlot(HOME, "c", NaN, COOL)).toBe(false);       // fail-safe
  });
  test("IW-P2-1: a GC'd old window re-claimed late is rejected by the monotonic high-water (cleanup never re-admits)", () => {
    expect(claimWakeSlot(HOME, "c", w(8), COOL)).toBe(true);
    expect(claimWakeSlot(HOME, "c", w(9), COOL)).toBe(true);       // hw ⇒ 9
    const safe = createHash("sha256").update("c").digest("hex");
    rmSync(path.join(HOME, ".agenthop/console/inbox-wake", `${safe}.8`), { force: true }); // simulate cleanup removing window 8
    expect(claimWakeSlot(HOME, "c", w(8) + 5, COOL)).toBe(false);  // late window-8 request: reopened marker, but hw=9 rejects it
    expect(claimWakeSlot(HOME, "c", w(10), COOL)).toBe(true);      // a genuinely newer window still claims
  });
});

describe("inbox-wake — wakeSession (injected deps, fail-soft, claim-before-send)", () => {
  const mk = (over: Partial<WakeDeps> = {}) => {
    const injects: string[] = []; const clock = { t: 1e6 }; const claimed = new Set<string>();
    const d: WakeDeps = {
      now: () => clock.t, cooldownMs: COOL,
      claim: (_h, sid, now, cd) => { const w = `${sid}.${Math.floor(now / cd)}`; if (claimed.has(w)) return false; claimed.add(w); return true; },
      paneInfo: async () => ({ paneId: "w1:p1", state: "idle" }), scan: () => ({ count: 2, oldestMtimeMs: 1 }), inject: async (_p, t) => { injects.push(t); return true; }, ...over,
    };
    return { d, injects, clock };
  };
  test("idle ⇒ injects the fixed line once", async () => {
    const { d, injects } = mk();
    expect(await wakeSession("/h", "s", d)).toBe("injected");
    expect(injects).toEqual([wakeText(2)]);
  });
  test("a same-window burst injects at most once (claim lost)", async () => {
    const { d, injects } = mk();
    await wakeSession("/h", "s", d);
    expect(await wakeSession("/h", "s", d)).toBe("cooldown");
    expect(injects).toHaveLength(1);
  });
  test("next window ⇒ injects again", async () => {
    const { d, injects, clock } = mk();
    await wakeSession("/h", "s", d); clock.t += COOL;
    expect(await wakeSession("/h", "s", d)).toBe("injected");
    expect(injects).toHaveLength(2);
  });
  test("working ⇒ no inject (claim burned); no-pane ⇒ no-op; inject throw ⇒ isolated; lost claim ⇒ no inject", async () => {
    expect(await wakeSession("/h", "s", mk({ paneInfo: async () => ({ paneId: "w1:p1", state: "working" }) }).d)).toBe("state");
    expect(await wakeSession("/h", "s", mk({ paneInfo: async () => null }).d)).toBe("no-pane");
    expect(await wakeSession("/h", "s", mk({ inject: async () => { throw new Error("down"); } }).d)).toBe("error");
    const lost = mk({ claim: () => false });
    expect(await wakeSession("/h", "s", lost.d)).toBe("cooldown");
    expect(lost.injects).toHaveLength(0);
  });
  test("backstop re-pings only an item lain past the window", async () => {
    expect(await runWakeBackstop("/h", "s", mk({ scan: () => ({ count: 1, oldestMtimeMs: 1e6 }) }).d, 60_000)).toBe("fresh");
    const aged = mk({ scan: () => ({ count: 1, oldestMtimeMs: 1e6 - 61_000 }) });
    expect(await runWakeBackstop("/h", "s", aged.d, 60_000)).toBe("injected");
    expect(aged.injects).toHaveLength(1);
  });
});

describe("inbox-wake — flag + install gate (library-init path) + hook on the primitive", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wake-")); });
  afterEach(() => { setInboxWakeHook(null); try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

  test("SWARM_INBOX_WAKE live by default, opt-out with 0", () => {
    expect(inboxWakeEnabled({})).toBe(true);
    expect(inboxWakeEnabled({ SWARM_INBOX_WAKE: "0" })).toBe(false);
  });

  test("installInboxWake: on only when enabled AND herdr reachable here (else silently skip)", () => {
    expect(installInboxWake(undefined, { SWARM_INBOX_WAKE: "0", HERDR_ENV: "1", HERDR_PANE_ID: "p1" })).toBe(false); // flag off
    expect(installInboxWake(undefined, { HERDR_ENV: "", HERDR_PANE_ID: "" })).toBe(false);                            // no herdr in this process
    expect(installInboxWake(undefined, { HERDR_ENV: "1", HERDR_PANE_ID: "p1" })).toBe(true);                          // on + herdr ⇒ installed
    setInboxWakeHook(null);
  });

  test("hook fires on a NEW published delivery, not on a no-op re-send; a throwing hook never breaks delivery", () => {
    const seen: string[] = [];
    setInboxWakeHook((_h, sid) => { seen.push(sid); if (sid === "boom") throw new Error("hook blew"); });
    expect(writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "one", via: "local", ts: 1 })).toBe("published");
    expect(writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 2 }, "evt")).toBe("published");
    expect(writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 3 }, "evt")).toBe("already"); // re-send ⇒ no fire
    expect(seen).toEqual(["s1", "s2"]);
    expect(writeInbox(HOME, "boom", { from: "a", fromLabel: "a", text: "z", via: "local", ts: 4 })).toBe("published");
    expect(scanUnclaimedInbox(HOME, "boom").count).toBe(1);
  });

  test("scanUnclaimedInbox counts only top-level .json and reports the oldest mtime", () => {
    const dir = path.join(HOME, ".agenthop", "inbox", "s1"); mkdirSync(path.join(dir, "quarantine"), { recursive: true });
    writeFileSync(path.join(dir, "a.json"), "{}"); writeFileSync(path.join(dir, "b.json.claim-9"), "{}"); writeFileSync(path.join(dir, "quarantine", "q.json"), "{}");
    const old = new Date(Date.now() - 90_000); utimesSync(path.join(dir, "a.json"), old, old);
    const s = scanUnclaimedInbox(HOME, "s1");
    expect(s.count).toBe(1);
    expect(Date.now() - s.oldestMtimeMs).toBeGreaterThan(60_000);
  });
});
