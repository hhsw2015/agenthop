// Standalone FC-6 (deterministic decision) / FC-7 (hook unset = byte-for-byte v0 delivery) selftest for the inbox real-time wake.
// Run: tsx packages/bus/src/swarm/inbox-wake.selftest.mts
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldInjectWake, wakeSession, runWakeBackstop, inboxWakeEnabled, wakeText, type WakeDeps, type PaneInfo } from "./inbox-wake.js";
import { writeInbox, setInboxWakeHook, scanUnclaimedInbox } from "../inbox.js";

let pass = 0;
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); } pass++; console.log(`ok  ${msg}`); };

const COOL = 120_000;
// FC-6 — shouldInjectWake is a PURE, deterministic decision.
ok(shouldInjectWake(1_000_000, -Infinity, "idle", 1, COOL) === true, "idle + unclaimed + past-cooldown ⇒ inject");
ok(shouldInjectWake(1_000_000, -Infinity, "working", 1, COOL) === false, "working pane ⇒ never interrupt");
ok(shouldInjectWake(1_000_000, -Infinity, "unknown", 1, COOL) === false, "unknown state ⇒ can't confirm not-working ⇒ safe no");
ok(shouldInjectWake(1_000_000, -Infinity, "idle", 0, COOL) === false, "nothing unclaimed ⇒ no");
ok(shouldInjectWake(1_000_000, 1_000_000 - 1, "idle", 3, COOL) === false, "within cooldown of last inject ⇒ no (anti-storm)");
ok(shouldInjectWake(1_000_000, 1_000_000 - COOL, "idle", 3, COOL) === true, "exactly at cooldown boundary ⇒ inject");
ok(shouldInjectWake(NaN, -Infinity, "idle", 1, COOL) === false, "non-finite clock ⇒ fail-safe no");
ok(shouldInjectWake(Infinity, -Infinity, "idle", 1, COOL) === false, "infinite clock ⇒ fail-safe no");
// determinism: same inputs, many calls, identical output.
{ let same = true; for (let i = 0; i < 1000; i++) if (shouldInjectWake(5_000_000, 4_000_000, "idle", 2, COOL) !== true) same = false; ok(same, "FC-6: 1000x same inputs ⇒ identical output (no clock/IO inside)"); }

// wakeSession with INJECTED deps (no herdr subprocess).
const makeDeps = (over: Partial<WakeDeps> = {}): { d: WakeDeps; injects: string[]; clock: { t: number } } => {
  const injects: string[] = []; const clock = { t: 1_000_000 };
  const d: WakeDeps = {
    now: () => clock.t,
    cooldownMs: COOL,
    last: new Map(),
    paneInfo: async (_sid): Promise<PaneInfo | null> => ({ paneId: "w1:p1", state: "idle" }),
    scan: (_h, _s) => ({ count: 2, oldestMtimeMs: 1 }),
    inject: async (_p, text) => { injects.push(text); return true; },
    ...over,
  };
  return { d, injects, clock };
};

await (async () => {
  { const { d, injects } = makeDeps(); const r = await wakeSession("/h", "sid", d); ok(r === "injected" && injects.length === 1 && injects[0] === wakeText(2), "wakeSession: idle ⇒ injects the fixed wake line once"); ok(d.last.get("sid") === 1_000_000, "wakeSession: records last-inject for cooldown"); }
  { const { d, injects } = makeDeps(); await wakeSession("/h", "sid", d); const r2 = await wakeSession("/h", "sid", d); ok(r2 === "cooldown" && injects.length === 1, "wakeSession: a 2nd fire within cooldown (same burst) ⇒ one inject only"); }
  { const { d, injects, clock } = makeDeps(); await wakeSession("/h", "sid", d); clock.t += COOL; const r2 = await wakeSession("/h", "sid", d); ok(r2 === "injected" && injects.length === 2, "wakeSession: past cooldown ⇒ injects again"); }
  { const { d, injects } = makeDeps({ paneInfo: async () => ({ paneId: "w1:p1", state: "working" }) }); const r = await wakeSession("/h", "sid", d); ok(r === "state" && injects.length === 0 && d.last.get("sid") === undefined, "wakeSession: working pane ⇒ no inject, no cooldown burned (re-checks next trigger)"); }
  { const { d, injects } = makeDeps({ paneInfo: async () => null }); const r = await wakeSession("/h", "sid", d); ok(r === "no-pane" && injects.length === 0, "wakeSession: sid not a herdr pane ⇒ no-op (codex-queue seam)"); }
  { const { d } = makeDeps({ inject: async () => { throw new Error("herdr down"); } }); const r = await wakeSession("/h", "sid", d); ok(r === "error", "wakeSession: an inject throw is isolated (fail-soft)"); }
  { const { d, injects } = makeDeps({ scan: () => ({ count: 0, oldestMtimeMs: 0 }) }); const r = await wakeSession("/h", "sid", d); ok(r === "empty" && injects.length === 0, "wakeSession: empty box ⇒ no inject"); }

  // backstop: only re-pings when an item has lain past the window.
  { const { d, injects } = makeDeps({ scan: () => ({ count: 1, oldestMtimeMs: 1_000_000 }) }); const r = await runWakeBackstop("/h", "sid", d, 60_000); ok(r === "fresh" && injects.length === 0, "backstop: item within the window (age 0) ⇒ no re-ping"); }
  { const { d, injects } = makeDeps({ scan: () => ({ count: 1, oldestMtimeMs: 1_000_000 - 61_000 }) }); const r = await runWakeBackstop("/h", "sid", d, 60_000); ok(r === "injected" && injects.length === 1, "backstop: item lain past the window ⇒ re-ping"); }
  { const { d, injects } = makeDeps({ scan: () => ({ count: 0, oldestMtimeMs: 0 }) }); const r = await runWakeBackstop("/h", "sid", d, 60_000); ok(r === "empty" && injects.length === 0, "backstop: empty box ⇒ no re-ping"); }
})();

// flag
ok(inboxWakeEnabled({}) === true, "SWARM_INBOX_WAKE live by default");
ok(inboxWakeEnabled({ SWARM_INBOX_WAKE: "0" }) === false, "SWARM_INBOX_WAKE=0 ⇒ off");

// FC-7 — the delivery primitive with the hook UNSET is byte-for-byte v0 (and a throwing hook never breaks delivery).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wake-"));
  try {
    setInboxWakeHook(null);
    writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "one", via: "local", ts: 1 });
    ok(scanUnclaimedInbox(HOME, "s1").count === 1, "FC-7: hook unset ⇒ writeInbox writes normally (v0)");
    let fired = 0;
    setInboxWakeHook((_h, sid) => { fired++; if (sid === "boom") throw new Error("hook blew up"); });
    const r = writeInbox(HOME, "s1", { from: "a", fromLabel: "a", text: "two", via: "local", ts: 2 });
    ok(r === "published" && fired === 1, "hook fires on a new (published) delivery");
    const r2 = writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 3 }, "evt");
    const r3 = writeInbox(HOME, "s2", { from: "a", fromLabel: "a", text: "x", via: "local", ts: 4 }, "evt"); // re-send ⇒ "already", no fire
    ok(r2 === "published" && r3 === "already" && fired === 2, "hook fires only on the FIRST (published) keyed write, not the no-op re-send");
    const before = scanUnclaimedInbox(HOME, "boom").count;
    const rb = writeInbox(HOME, "boom", { from: "a", fromLabel: "a", text: "z", via: "local", ts: 5 });
    ok(rb === "published" && scanUnclaimedInbox(HOME, "boom").count === before + 1, "a THROWING hook never breaks the delivery (fail-soft)");
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
