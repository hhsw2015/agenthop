// Standalone FC-6 (deterministic decision + 先占后发 claim) / FC-7 (hook unset = byte-for-byte v0 delivery) selftest for the inbox
// real-time wake. Run: tsx packages/bus/src/swarm/inbox-wake.selftest.mts
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
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

// 先占后发 — the atomic filesystem claim as a monotonic GENERATION chain (cross-process cooldown; admit and occupy share one anchor).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakeclaim-"));
  const w = (n: number) => n * COOL; // exact window-n timestamp
  try {
    ok(claimWakeSlot(HOME, "c", w(8), COOL) === true, "claimWakeSlot: first claim wins (gen0, ts 8)");
    ok(claimWakeSlot(HOME, "c", w(8) + 1, COOL) === false, "claimWakeSlot: a 2nd claim within the cooldown (another process) loses");
    ok(claimWakeSlot(HOME, "c", w(9), COOL) === true, "claimWakeSlot: a full cooldown later claims again (gen1, advances high-water)");
    ok(claimWakeSlot(HOME, "c", w(8) + 2, COOL) === false, "claimWakeSlot: a late ts-8 re-claim is rejected by the gen1 timestamp");
    // IW-P2-1: simulate GC/cleanup removing the older generation's marker, then a LATE ts-8 request resuming.
    const safe = createHash("sha256").update("c").digest("hex");
    rmSync(path.join(HOME, ".agenthop/console/inbox-wake", `${safe}.gen0`), { force: true });
    ok(claimWakeSlot(HOME, "c", w(8) + 3, COOL) === false, "IW-P2-1: a GC'd old generation does not re-admit — the gen1 timestamp is still the authority");
    ok(claimWakeSlot(HOME, "c", w(10), COOL) === true, "claimWakeSlot: a genuinely newer claim still wins (new generation)");
    ok(claimWakeSlot(HOME, "..", w(8), COOL) === true, "claimWakeSlot: a reserved-dot sid is a safe hashed filename (no traversal)");
    ok(claimWakeSlot(HOME, "c", NaN, COOL) === false, "claimWakeSlot: bad clock ⇒ fail-safe, no claim");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}
// IW-P2-1 three holes closed at the root: the generation markers ARE the high-water (no mutable hw file, no stealable gate).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakehole-"));
  const w = (n: number) => n * COOL;
  const dir = path.join(HOME, ".agenthop/console/inbox-wake");
  try {
    // ① concurrent-regression CONSEQUENCE: advance far, let GC drop old generation markers, then a late GC'd slot must NOT re-admit.
    for (const n of [8, 9, 10, 11, 12]) ok(claimWakeSlot(HOME, "c", w(n), COOL) === true, `sequential claim generation at ts ${n}`);
    ok(claimWakeSlot(HOME, "c", w(10) + 1, COOL) === false, "① a late request at ts 10 is rejected by the high-water MAX — no regression re-admits it");
    ok(claimWakeSlot(HOME, "c", w(9) + 1, COOL) === false, "① a late request at ts 9 is rejected by the high-water MAX");
    // ② read fault ≠ absent: an unreadable marker dir ⇒ UNKNOWN ⇒ fail-closed (reject), never treated as initial.
    chmodSync(dir, 0o000);
    try { ok(claimWakeSlot(HOME, "c", w(13), COOL) === false, "② readdir EACCES ⇒ UNKNOWN ⇒ reject (not treated as empty/initial)"); }
    finally { chmodSync(dir, 0o700); }
    // ③ persist fault: a read-only marker dir ⇒ the O_EXCL create fails ⇒ no authorize (no marker, no GC).
    chmodSync(dir, 0o500);
    let created = true;
    try { created = claimWakeSlot(HOME, "c", w(14), COOL); } finally { chmodSync(dir, 0o700); }
    ok(created === false, "③ create/persist fault ⇒ not authorized (publish-after-fact: no marker ⇒ no inject)");
    ok(claimWakeSlot(HOME, "c", w(15), COOL) === true, "after faults clear, a genuinely new window still claims (max intact)");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}
// IW-R4-P2-1: a cooldown PARAMETER change must not let old window numbers block new wakes (interval-family scoping).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakeparam-"));
  const C60 = 60_000, C120 = 120_000;
  try {
    // 60s cooldown: claim at t=1_000_000 (60s window 16).
    ok(claimWakeSlot(HOME, "c", 1_000_000, C60) === true, "param: 60s claim at t=1,000,000 (window 16) wins");
    // restart to 120s, clock +240s (t=1,240,000; 120s window 10). Under a shared window sequence 10<=16 would FALSELY reject.
    ok(claimWakeSlot(HOME, "c", 1_240_000, C120) === true, "IW-R4-P2-1: 60→120 then +240s ⇒ NEW interval family admits (old window 16 does not block window 10)");
    // reverse: another target, 120s then 60s.
    ok(claimWakeSlot(HOME, "d", 1_000_000, C120) === true, "param: 120s claim (window 8) wins");
    ok(claimWakeSlot(HOME, "d", 1_240_000, C60) === true, "IW-R4-P2-1 reverse: 120→60 then +240s ⇒ new family admits (window 20)");
    // same-interval cooldown still holds within a family: a re-send in the SAME 60s window is rejected.
    ok(claimWakeSlot(HOME, "d", 1_245_000, C60) === false, "within the new 60s family, a re-send in the same window (20) is still rejected");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}

// IW-P2-1 r5-regression: a cross-family GC must not re-open a used window — the GLOBAL max timestamp is the authority.
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakexfam-"));
  const C60 = 60_000, C120 = 120_000;
  try {
    ok(claimWakeSlot(HOME, "x", 1_000_000, C120) === true, "xfam: 120s family injects at t=1,000,000 (window 8)");
    ok(claimWakeSlot(HOME, "x", 1_061_000, C60) === true, "xfam: 60s family injects at t=1,061,000 (its GC may drop the 120s marker)");
    ok(claimWakeSlot(HOME, "x", 1_062_000, C120) === false, "IW-P2-1: 120s re-claim at t=1,062,000 is rejected by the 60s inject's timestamp (global MAX) — no window-8 revival");
    ok(claimWakeSlot(HOME, "x", 1_181_001, C120) === true, "xfam: once 120s has truly elapsed since the last inject, the 120s family admits again");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}
// IW-R5-P2-1: a still-valid marker in a DIFFERENT/legacy/unknown schema is EVIDENCE (blocks), never ignored.
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakelegacy-"));
  const C120 = 120_000;
  const dir = path.join(HOME, ".agenthop/console/inbox-wake"); mkdirSync(dir, { recursive: true });
  const safe = createHash("sha256").update("c").digest("hex");
  try {
    // a legacy r4-style marker: bare "<sid>.<window>" whose CONTENT is the claim timestamp.
    writeFileSync(path.join(dir, `${safe}.8`), String(1_000_000));
    ok(claimWakeSlot(HOME, "c", 1_001_000, C120) === false, "IW-R5-P2-1: a legacy (no-interval) marker still within cooldown BLOCKS the upgraded claim (not ignored)");
    ok(claimWakeSlot(HOME, "c", 1_120_001, C120) === true, "legacy marker past the cooldown no longer blocks (time-based, parameter-independent)");
    // an UNRECOGNIZED file with non-numeric content: counts as evidence via its mtime (conservative), still within cooldown ⇒ blocks.
    const HOME2 = mkdtempSync(path.join(os.tmpdir(), "ah-wakeunk-"));
    const dir2 = path.join(HOME2, ".agenthop/console/inbox-wake"); mkdirSync(dir2, { recursive: true });
    writeFileSync(path.join(dir2, `${safe}.v99.weird`), "not-a-timestamp");
    ok(claimWakeSlot(HOME2, "c", Date.now(), C120) === false, "IW-R5-P2-1: an unrecognized file (non-numeric content) is EVIDENCE via mtime ⇒ a fresh claim is blocked (fail-closed recognition)");
    rmSync(HOME2, { recursive: true, force: true });
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}
// IW-P2-1 (r8): the GENERATION chain replaces the stealable gate. The admit TEST and the occupy are the SAME anchor — the next
// generation file (`<sha>.gen<N>`), so two claimers that observe the same state target the same file and O_EXCL admits exactly one; a
// claimer that observes a newer generation also reads its recent timestamp and fails the admit. There is NO lock to steal, NO lease to
// expire, NO recycle — so the r7 gate-recovery holes (paused-holder-stolen, late-recycler-deletes-fresh-gate, read-error-authorizes-steal)
// vanish by construction. A crashed holder leaves a valid gen marker that just enforces the cooldown and is superseded next generation.
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakegen-"));
  const dir = path.join(HOME, ".agenthop/console/inbox-wake"); mkdirSync(dir, { recursive: true });
  const safe = createHash("sha256").update("c").digest("hex");
  const w = (n: number) => n * COOL;
  try {
    // a concurrent claimer already advanced the chain: gen0 (old) + gen1 (recent). A claim the time-admit would pass on gen0 alone still
    // yields — the newest generation's recent timestamp is the high-water, so no interleaving injects twice and there is no lock to steal.
    writeFileSync(path.join(dir, `${safe}.gen0`), String(w(0)));
    writeFileSync(path.join(dir, `${safe}.gen1`), String(w(9)));
    ok(claimWakeSlot(HOME, "c", w(9) + 1, COOL) === false, "IW-P2-1 r8: a newer generation's recent timestamp blocks a claim the time-admit would pass on the old generation alone");
    ok(claimWakeSlot(HOME, "c", w(10), COOL) === true, "IW-P2-1 r8: a full cooldown past the newest generation admits (new generation)");
    // a crashed holder left only OLD generation markers: no gate to steal, no age to wait out — the next past-cooldown claim simply wins.
    ok(claimWakeSlot(HOME, "c", w(200), COOL) === true, "IW-P2-1 r8: a stalled/crashed holder's old generation never permanently blocks — a far-later claim admits");
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
