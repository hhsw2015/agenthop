import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync, chmodSync } from "node:fs";
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
  test("one winner per cooldown; within-cooldown loses; a cooldown later wins; bad clock ⇒ no claim; dot-sid safe", () => {
    expect(claimWakeSlot(HOME, "c", w(8), COOL)).toBe(true);       // bootstrap + first claim wins (head.1.<w8>)
    expect(claimWakeSlot(HOME, "c", w(8) + 1, COOL)).toBe(false);  // within the cooldown, another process ⇒ loses
    expect(claimWakeSlot(HOME, "c", w(9), COOL)).toBe(true);       // a full cooldown later ⇒ advances the head
    expect(claimWakeSlot(HOME, "..", w(8), COOL)).toBe(true);      // reserved-dot sid hashed to a safe filename (no traversal)
    expect(claimWakeSlot(HOME, "c", NaN, COOL)).toBe(false);       // fail-safe
  });
  test("IW-P2-1 (r9): rename-CAS closes the ABA — a stale snapshot cannot re-commit after the head advanced (no GC-enabled reuse)", () => {
    expect(claimWakeSlot(HOME, "c", w(8), COOL)).toBe(true);        // bootstrap + first inject ⇒ head.1.<w8>
    // A scans the head at w(20); the seam fires BEFORE A's rename-CAS, advancing the head (a concurrent claimer B). A's rename is FROM
    // the old head name, which is now gone ⇒ ENOENT ⇒ A yields. Under the r8 gen-chain, A's O_EXCL create of the freed number succeeded
    // and double-injected; the rename-CAS cannot (you cannot rename from a vanished name), so the ABA is closed by construction.
    let advanced = false;
    const advance = () => { if (!advanced) { advanced = true; expect(claimWakeSlot(HOME, "c", w(20), COOL)).toBe(true); } }; // B advances head.1→head.2
    expect(claimWakeSlot(HOME, "c", w(20), COOL, advance)).toBe(false); // A: scanned head.1, head advanced under it ⇒ CAS rename ENOENT ⇒ yield
    expect(claimWakeSlot(HOME, "c", w(20) + 1, COOL)).toBe(false);  // still within cooldown of B's inject (w20) ⇒ yield
    expect(claimWakeSlot(HOME, "c", w(21), COOL)).toBe(true);       // a full cooldown past B ⇒ a genuine new claim advances (head.3)
  });

  test("IW-P2-1 (r9) control: with no concurrent advance, the admitted claim wins (rename-CAS succeeds)", () => {
    expect(claimWakeSlot(HOME, "c", w(8), COOL)).toBe(true);        // head.1.<w8>
    expect(claimWakeSlot(HOME, "c", w(20), COOL, () => { /* no interference */ })).toBe(true); // head.1→head.2, CAS succeeds
  });

  test("IW-R4-P2-1: a cooldown parameter change does not let old window numbers block new wakes", () => {
    const C60 = 60_000, C120 = 120_000;
    expect(claimWakeSlot(HOME, "c", 1_000_000, C60)).toBe(true);   // inject at a 60s cooldown
    expect(claimWakeSlot(HOME, "c", 1_240_000, C120)).toBe(true);  // 60→120 +240s: admits (time-based, not blocked by old number)
    expect(claimWakeSlot(HOME, "d", 1_000_000, C120)).toBe(true);  // reverse
    expect(claimWakeSlot(HOME, "d", 1_240_000, C60)).toBe(true);   // 120→60 +240s: admits
    expect(claimWakeSlot(HOME, "d", 1_245_000, C60)).toBe(false);  // only 5s since last inject ⇒ rejected
  });

  test("IW-P2-1 (r5 regression): the global max timestamp is the authority across cooldown-parameter changes (no revival)", () => {
    const C60 = 60_000, C120 = 120_000;
    expect(claimWakeSlot(HOME, "x", 1_000_000, C120)).toBe(true);  // inject at a 120s cooldown
    expect(claimWakeSlot(HOME, "x", 1_061_000, C60)).toBe(true);   // inject at a 60s cooldown (advances the head)
    expect(claimWakeSlot(HOME, "x", 1_062_000, C120)).toBe(false); // a 120s re-claim blocked by the last inject's timestamp — no revival
  });

  test("IW-R5-P2-1: a still-valid legacy / unrecognized marker is evidence (blocks), never ignored", () => {
    const C120 = 120_000;
    const dir = path.join(HOME, ".agenthop/console/inbox-wake"); mkdirSync(dir, { recursive: true });
    const safe = createHash("sha256").update("c").digest("hex");
    writeFileSync(path.join(dir, `${safe}.8`), String(1_000_000));            // legacy r4-style (no interval), content = timestamp
    expect(claimWakeSlot(HOME, "c", 1_001_000, C120)).toBe(false);            // within cooldown ⇒ blocked (not ignored)
    expect(claimWakeSlot(HOME, "c", 1_120_001, C120)).toBe(true);             // past cooldown ⇒ admits
    const safeU = createHash("sha256").update("u").digest("hex");
    writeFileSync(path.join(dir, `${safeU}.v99.weird`), "not-a-timestamp");   // unrecognized schema, non-numeric content
    expect(claimWakeSlot(HOME, "u", Date.now(), C120)).toBe(false);           // evidence via mtime ⇒ blocked (fail-closed recognition)
  });

  test("fail-closed: a late lower-ts claim / read-fault / persist-fault never admit", () => {
    const dir = path.join(HOME, ".agenthop/console/inbox-wake");
    for (const n of [8, 9, 10, 11, 12]) expect(claimWakeSlot(HOME, "c", w(n), COOL)).toBe(true);
    expect(claimWakeSlot(HOME, "c", w(10) + 1, COOL)).toBe(false); // ① a late lower-ts claim rejected by the high-water MAX
    chmodSync(dir, 0o000);
    try { expect(claimWakeSlot(HOME, "c", w(13), COOL)).toBe(false); } finally { chmodSync(dir, 0o700); } // ② read fault ⇒ fail-closed
    chmodSync(dir, 0o500);
    let ok3 = true;
    try { ok3 = claimWakeSlot(HOME, "c", w(14), COOL); } finally { chmodSync(dir, 0o700); }
    expect(ok3).toBe(false);                                        // ③ persist fault ⇒ not authorized
    expect(claimWakeSlot(HOME, "c", w(15), COOL)).toBe(true);       // recovers after the faults clear
  });

  test("IW-P2-1 (r9): a single head file advances by rename (one file, no GC, no permanent block); a crashed holder's head is just superseded", () => {
    const dir = path.join(HOME, ".agenthop/console/inbox-wake");
    expect(claimWakeSlot(HOME, "c", w(8), COOL)).toBe(true);        // bootstrap + advance ⇒ head.2? no: head.0.0 → head.1.<w8>
    const safe = createHash("sha256").update("c").digest("hex");
    const heads = () => readdirSync(dir).filter((n) => n.startsWith(`${safe}.head.`));
    expect(heads().length).toBe(1);                                // exactly ONE head file (renamed in place, never accumulates)
    expect(claimWakeSlot(HOME, "c", w(9), COOL)).toBe(true);        // advance
    expect(heads().length).toBe(1);                                // still one
    // a stalled/crashed holder leaves the head where it was: a far-later claim simply advances it (no lease to wait out, no permanent block).
    expect(claimWakeSlot(HOME, "c", w(500), COOL)).toBe(true);
  });

  test("IW-P2-1 (r9): an unparseable head with no valid head present ⇒ fail-closed (never bootstrap over corruption)", () => {
    const dir = path.join(HOME, ".agenthop/console/inbox-wake"); mkdirSync(dir, { recursive: true });
    const safe = createHash("sha256").update("c").digest("hex");
    writeFileSync(path.join(dir, `${safe}.head.notanumber`), "");  // a head-like but unparseable name, no valid head alongside
    expect(claimWakeSlot(HOME, "c", Date.now(), COOL)).toBe(false); // fail-closed: do not bootstrap a fresh epoch over a corrupt head
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
