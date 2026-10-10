// Standalone FC-6 (deterministic decision + 先占后发 claim) / FC-7 (hook unset = byte-for-byte v0 delivery) selftest for the inbox
// real-time wake. Run: tsx packages/bus/src/swarm/inbox-wake.selftest.mts
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { shouldInjectWake, wakeSession, runWakeBackstop, inboxWakeEnabled, installInboxWake, claimWakeSlot, wakeText, type WakeDeps, type PaneInfo } from "./inbox-wake.js";
import { writeInbox, setInboxWakeHook, scanUnclaimedInbox } from "../inbox.js";

let pass = 0;
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); } pass++; console.log(`ok  ${msg}`); };

const COOL = 120_000;
// FC-6 — shouldInjectWake is a PURE, deterministic decision (state + count + optional cooldown contract).
ok(shouldInjectWake(1e6, -Infinity, "idle", 1, COOL) === true, "idle + unclaimed ⇒ wakeable");
ok(shouldInjectWake(1e6, -Infinity, "working", 9, COOL) === false, "working pane ⇒ never interrupt");
ok(shouldInjectWake(1e6, -Infinity, "unknown", 9, COOL) === false, "unknown state ⇒ can't confirm not-working ⇒ safe no");
ok(shouldInjectWake(1e6, -Infinity, "idle", 0, COOL) === false, "nothing unclaimed ⇒ no");
ok(shouldInjectWake(1e6, 1e6 - 1, "idle", 3, COOL) === false, "within cooldown ⇒ no");
ok(shouldInjectWake(1e6, 1e6 - COOL, "idle", 3, COOL) === true, "at cooldown boundary ⇒ yes");
ok(shouldInjectWake(NaN, -Infinity, "idle", 1, COOL) === false, "non-finite clock ⇒ fail-safe no");
{ let same = true; for (let i = 0; i < 1000; i++) if (shouldInjectWake(5e6, 4e6, "idle", 2, COOL) !== true) same = false; ok(same, "FC-6: 1000x same inputs ⇒ identical output (no clock/IO inside)"); }

// 先占后发 — the atomic filesystem claim (cross-process cooldown + monotonic stale-window gate).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakeclaim-"));
  const w = (n: number) => n * COOL; // exact window-n timestamp
  try {
    ok(claimWakeSlot(HOME, "c", w(8), COOL) === true, "claimWakeSlot: first claim of window 8 wins");
    ok(claimWakeSlot(HOME, "c", w(8) + 1, COOL) === false, "claimWakeSlot: a 2nd claim of the SAME window (another process) loses");
    ok(claimWakeSlot(HOME, "c", w(9), COOL) === true, "claimWakeSlot: the next window (9) claims again (advances high-water)");
    ok(claimWakeSlot(HOME, "c", w(8) + 2, COOL) === false, "claimWakeSlot: a late window-8 re-claim with the marker still present ⇒ EEXIST reject");
    // IW-P2-1 cross-window interleave: simulate GC/cleanup removing window 8's marker, then a LATE window-8 request resuming.
    const safe = createHash("sha256").update("c").digest("hex");
    rmSync(path.join(HOME, ".agenthop/console/inbox-wake", `${safe}.8`), { force: true });
    ok(claimWakeSlot(HOME, "c", w(8) + 3, COOL) === false, "IW-P2-1: a REOPENED (GC'd) old window is rejected by the monotonic high-water — cleanup cannot re-admit");
    ok(claimWakeSlot(HOME, "c", w(10), COOL) === true, "claimWakeSlot: a genuinely newer window (10 > hw 9) still claims");
    ok(claimWakeSlot(HOME, "..", w(8), COOL) === true, "claimWakeSlot: a reserved-dot sid is a safe hashed filename (no traversal)");
    ok(claimWakeSlot(HOME, "c", NaN, COOL) === false, "claimWakeSlot: bad clock ⇒ fail-safe, no claim");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}

// wakeSession with INJECTED deps (claim mimics the per-window O_EXCL; no herdr subprocess).
const makeDeps = (over: Partial<WakeDeps> = {}): { d: WakeDeps; injects: string[]; clock: { t: number } } => {
  const injects: string[] = []; const clock = { t: 1e6 }; const claimed = new Set<string>();
  const d: WakeDeps = {
    now: () => clock.t,
    cooldownMs: COOL,
    claim: (_h, sid, now, cd) => { const w = `${sid}.${Math.floor(now / cd)}`; if (claimed.has(w)) return false; claimed.add(w); return true; },
    paneInfo: async (): Promise<PaneInfo | null> => ({ paneId: "w1:p1", state: "idle" }),
    scan: () => ({ count: 2, oldestMtimeMs: 1 }),
    inject: async (_p, text) => { injects.push(text); return true; },
    ...over,
  };
  return { d, injects, clock };
};

await (async () => {
  { const { d, injects } = makeDeps(); ok((await wakeSession("/h", "s", d)) === "injected" && injects[0] === wakeText(2), "wakeSession: idle ⇒ injects the fixed line once"); }
  { const { d, injects } = makeDeps(); await wakeSession("/h", "s", d); ok((await wakeSession("/h", "s", d)) === "cooldown" && injects.length === 1, "wakeSession: a 2nd fire in the window (same burst) ⇒ claim lost ⇒ one inject"); }
  { const { d, injects, clock } = makeDeps(); await wakeSession("/h", "s", d); clock.t += COOL; ok((await wakeSession("/h", "s", d)) === "injected" && injects.length === 2, "wakeSession: next window ⇒ injects again"); }
  { const { d, injects } = makeDeps({ paneInfo: async () => ({ paneId: "w1:p1", state: "working" }) }); ok((await wakeSession("/h", "s", d)) === "state" && injects.length === 0, "wakeSession: working pane ⇒ no inject (claim burned = 先占后发)"); }
  { const { d, injects } = makeDeps({ paneInfo: async () => null }); ok((await wakeSession("/h", "s", d)) === "no-pane" && injects.length === 0, "wakeSession: sid not a herdr pane ⇒ no-op (codex-queue seam)"); }
  { const { d } = makeDeps({ inject: async () => { throw new Error("herdr down"); } }); ok((await wakeSession("/h", "s", d)) === "error", "wakeSession: an inject throw is isolated (fail-soft)"); }
  { const { d, injects } = makeDeps({ claim: () => false }); ok((await wakeSession("/h", "s", d)) === "cooldown" && injects.length === 0, "wakeSession: a lost claim (another process won) ⇒ no inject"); }
  { const { d, injects } = makeDeps({ scan: () => ({ count: 0, oldestMtimeMs: 0 }) }); ok((await wakeSession("/h", "s", d)) === "empty" && injects.length === 0, "wakeSession: empty box ⇒ no inject"); }
  // backstop: re-pings only when an item has lain past the window.
  { const { d, injects } = makeDeps({ scan: () => ({ count: 1, oldestMtimeMs: 1e6 }) }); ok((await runWakeBackstop("/h", "s", d, 60_000)) === "fresh" && injects.length === 0, "backstop: item within window (age 0) ⇒ no re-ping"); }
  { const { d, injects } = makeDeps({ scan: () => ({ count: 1, oldestMtimeMs: 1e6 - 61_000 }) }); ok((await runWakeBackstop("/h", "s", d, 60_000)) === "injected" && injects.length === 1, "backstop: item lain past the window ⇒ re-ping"); }
  { const { d } = makeDeps({ scan: () => ({ count: 0, oldestMtimeMs: 0 }) }); ok((await runWakeBackstop("/h", "s", d, 60_000)) === "empty", "backstop: empty box ⇒ no re-ping"); }
})();

// flag + install gate (library-init path).
ok(inboxWakeEnabled({}) === true, "SWARM_INBOX_WAKE live by default");
ok(inboxWakeEnabled({ SWARM_INBOX_WAKE: "0" }) === false, "SWARM_INBOX_WAKE=0 ⇒ off");
ok(installInboxWake(undefined, { SWARM_INBOX_WAKE: "0", HERDR_ENV: "1", HERDR_PANE_ID: "p1" }) === false, "install: flag off ⇒ not installed");
ok(installInboxWake(undefined, { HERDR_ENV: "", HERDR_PANE_ID: "" }) === false, "install: no herdr in this process ⇒ silently skip (fail-soft, no cost off-pane)");
ok(installInboxWake(undefined, { HERDR_ENV: "1", HERDR_PANE_ID: "p1" }) === true, "install: flag on + herdr reachable ⇒ installed (library-init path)");
setInboxWakeHook(null);

// FC-7 — the delivery primitive with the hook UNSET is byte-for-byte v0; a throwing hook never breaks delivery; only "published" fires.
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wake-"));
  try {
    setInboxWakeHook(null);
    writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "one", via: "local", ts: 1 });
    ok(scanUnclaimedInbox(HOME, "s1").count === 1, "FC-7: hook unset ⇒ writeInbox writes normally (v0)");
    let fired = 0;
    setInboxWakeHook((_h, sid) => { fired++; if (sid === "boom") throw new Error("hook blew up"); });
    ok(writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "two", via: "local", ts: 2 }) === "published" && fired === 1, "hook fires on a new (published) delivery");
    const r2 = writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 3 }, "evt");
    const r3 = writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 4 }, "evt");
    ok(r2 === "published" && r3 === "already" && fired === 2, "hook fires only on the FIRST (published) keyed write, not the no-op re-send");
    const before = scanUnclaimedInbox(HOME, "boom").count;
    ok(writeInbox(HOME, "boom", { from: "a", fromLabel: "a", text: "z", via: "local", ts: 5 }) === "published" && scanUnclaimedInbox(HOME, "boom").count === before + 1, "a THROWING hook never breaks the delivery (fail-soft)");
  } finally { setInboxWakeHook(null); rmSync(HOME, { recursive: true, force: true }); }
}

// scanUnclaimedInbox: ignores claimed + sidecars.
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wake-"));
  try {
    const dir = path.join(HOME, ".agenthop", "inbox", "s1"); mkdirSync(path.join(dir, "quarantine"), { recursive: true });
    writeFileSync(path.join(dir, "a.json"), "{}"); writeFileSync(path.join(dir, "b.json.claim-99"), "{}"); writeFileSync(path.join(dir, "quarantine", "q.json"), "{}");
    ok(scanUnclaimedInbox(HOME, "s1").count === 1, "scanUnclaimedInbox: counts only top-level .json (not .claim-*, not sidecar dirs)");
    ok(readdirSync(dir).length >= 3, "scan did not mutate the dir");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}

console.log(`\nall inbox-wake selftests passed (${pass})`);
