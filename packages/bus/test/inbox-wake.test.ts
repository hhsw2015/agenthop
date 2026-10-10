import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldInjectWake, wakeSession, runWakeBackstop, inboxWakeEnabled, installInboxWake, wakeText, resetInboxWakeState, type WakeDeps } from "../src/swarm/inbox-wake.js";
import { writeInbox, setInboxWakeHook, scanUnclaimedInbox } from "../src/inbox.js";

const COOL = 120_000;

describe("inbox-wake — shouldInjectWake (pure anti-storm trio)", () => {
  test("inject only when idle + unclaimed + past cooldown; working/unknown/empty/cooldown/non-finite ⇒ no", () => {
    expect(shouldInjectWake(1e6, -Infinity, "idle", 1, COOL)).toBe(true);
    expect(shouldInjectWake(1e6, -Infinity, "working", 9, COOL)).toBe(false); // never interrupt a working pane
    expect(shouldInjectWake(1e6, -Infinity, "unknown", 9, COOL)).toBe(false); // can't confirm not-working ⇒ safe no
    expect(shouldInjectWake(1e6, -Infinity, "idle", 0, COOL)).toBe(false);    // nothing unclaimed
    expect(shouldInjectWake(1e6, 1e6 - 1, "idle", 3, COOL)).toBe(false);      // within cooldown
    expect(shouldInjectWake(1e6, 1e6 - COOL, "idle", 3, COOL)).toBe(true);    // at the cooldown boundary
    expect(shouldInjectWake(NaN, -Infinity, "idle", 1, COOL)).toBe(false);    // fail-safe clock
  });
});

describe("inbox-wake — wakeSession (injected deps, fail-soft)", () => {
  const mk = (over: Partial<WakeDeps> = {}) => {
    const injects: string[] = []; const clock = { t: 1e6 };
    const d: WakeDeps = { now: () => clock.t, cooldownMs: COOL, last: new Map(), paneInfo: async () => ({ paneId: "w1:p1", state: "idle" }), scan: () => ({ count: 2, oldestMtimeMs: 1 }), inject: async (_p, t) => { injects.push(t); return true; }, ...over };
    return { d, injects, clock };
  };
  test("idle ⇒ injects the fixed line once and records cooldown", async () => {
    const { d, injects } = mk();
    expect(await wakeSession("/h", "s", d)).toBe("injected");
    expect(injects).toEqual([wakeText(2)]);
    expect(d.last.get("s")).toBe(1e6);
  });
  test("a same-burst 2nd fire within cooldown injects at most once", async () => {
    const { d, injects } = mk();
    await wakeSession("/h", "s", d);
    expect(await wakeSession("/h", "s", d)).toBe("cooldown");
    expect(injects).toHaveLength(1);
  });
  test("past cooldown ⇒ injects again", async () => {
    const { d, injects, clock } = mk();
    await wakeSession("/h", "s", d); clock.t += COOL;
    expect(await wakeSession("/h", "s", d)).toBe("injected");
    expect(injects).toHaveLength(2);
  });
  test("working pane ⇒ no inject, no cooldown burned", async () => {
    const { d, injects } = mk({ paneInfo: async () => ({ paneId: "w1:p1", state: "working" }) });
    expect(await wakeSession("/h", "s", d)).toBe("state");
    expect(injects).toHaveLength(0);
    expect(d.last.get("s")).toBeUndefined();
  });
  test("no herdr pane ⇒ no-op (codex-queue seam); inject throw ⇒ isolated error", async () => {
    expect(await wakeSession("/h", "s", mk({ paneInfo: async () => null }).d)).toBe("no-pane");
    expect(await wakeSession("/h", "s", mk({ inject: async () => { throw new Error("down"); } }).d)).toBe("error");
  });
  test("backstop re-pings only an item lain past the window", async () => {
    expect(await runWakeBackstop("/h", "s", mk({ scan: () => ({ count: 1, oldestMtimeMs: 1e6 }) }).d, 60_000)).toBe("fresh");
    const aged = mk({ scan: () => ({ count: 1, oldestMtimeMs: 1e6 - 61_000 }) });
    expect(await runWakeBackstop("/h", "s", aged.d, 60_000)).toBe("injected");
    expect(aged.injects).toHaveLength(1);
  });
});

describe("inbox-wake — flag + install (baked into the delivery primitive)", () => {
  let HOME: string;
  beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wake-")); resetInboxWakeState(); });
  afterEach(() => { setInboxWakeHook(null); try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

  test("SWARM_INBOX_WAKE live by default, opt-out with 0", () => {
    expect(inboxWakeEnabled({})).toBe(true);
    expect(inboxWakeEnabled({ SWARM_INBOX_WAKE: "0" })).toBe(false);
  });

  test("installInboxWake installs only when enabled; off ⇒ false + delivery stays at v0", () => {
    expect(installInboxWake(() => undefined, { SWARM_INBOX_WAKE: "0" })).toBe(false); // flag off ⇒ hook left unset
    expect(writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "one", via: "local", ts: 1 })).toBe("published");
    expect(scanUnclaimedInbox(HOME, "s1").count).toBe(1); // delivered with no wake machinery
    expect(installInboxWake(() => undefined, {})).toBe(true); // enabled ⇒ installs real hook (herdrSpawnable gate ⇒ off-pane no-op)
    expect(writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "two", via: "local", ts: 2 })).toBe("published"); // still delivers
    setInboxWakeHook(null);
  });

  test("hook fires on a NEW published delivery, not on a no-op re-send; a throwing hook never breaks delivery", () => {
    const seen: string[] = [];
    setInboxWakeHook((_h, sid) => { seen.push(sid); if (sid === "boom") throw new Error("hook blew"); });
    expect(writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "one", via: "local", ts: 1 })).toBe("published");
    expect(writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 2 }, "evt")).toBe("published");
    expect(writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 3 }, "evt")).toBe("already"); // re-send ⇒ no fire
    expect(seen).toEqual(["s1", "s2"]);
    expect(writeInbox(HOME, "boom", { from: "a", fromLabel: "a", text: "z", via: "local", ts: 4 })).toBe("published"); // throwing hook
    expect(scanUnclaimedInbox(HOME, "boom").count).toBe(1); // delivery stood despite the hook throw
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
