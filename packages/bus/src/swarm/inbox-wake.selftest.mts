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

// 先占后发 — the atomic filesystem claim as a SINGLE monotonic head advanced by a rename CAS (cross-process cooldown; one file, no GC).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakeclaim-"));
  const w = (n: number) => n * COOL; // exact cooldown-n timestamp
  try {
    ok(claimWakeSlot(HOME, "c", w(8), COOL) === true, "claimWakeSlot: bootstrap + first claim wins (head.1.<w8>)");
    ok(claimWakeSlot(HOME, "c", w(8) + 1, COOL) === false, "claimWakeSlot: a 2nd claim within the cooldown (another process) loses");
    ok(claimWakeSlot(HOME, "c", w(9), COOL) === true, "claimWakeSlot: a full cooldown later advances the head");
    ok(claimWakeSlot(HOME, "c", w(8) + 2, COOL) === false, "claimWakeSlot: a late ts-8 re-claim is rejected by the head timestamp");
    ok(claimWakeSlot(HOME, "..", w(8), COOL) === true, "claimWakeSlot: a reserved-dot sid is a safe hashed filename (no traversal)");
    ok(claimWakeSlot(HOME, "c", NaN, COOL) === false, "claimWakeSlot: bad clock ⇒ fail-safe, no claim");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}
// IW-P2-1 (r9 ABA): rename-CAS makes a consumed generation un-reusable. A stale snapshot whose head advanced under it renames FROM a name
// that is gone ⇒ ENOENT ⇒ yields — unlike O_EXCL create, which (r8) succeeded on a GC-freed name and double-injected.
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakeaba-"));
  const w = (n: number) => n * COOL;
  try {
    ok(claimWakeSlot(HOME, "c", w(8), COOL) === true, "ABA: bootstrap + first inject (head.1.<w8>)");
    let advanced = false;
    const advance = (): void => { if (!advanced) { advanced = true; ok(claimWakeSlot(HOME, "c", w(20), COOL) === true, "ABA: concurrent B advances the head under A"); } };
    ok(claimWakeSlot(HOME, "c", w(20), COOL, advance) === false, "IW-P2-1 r9: A scanned the old head; it advanced under A ⇒ rename-CAS ENOENT ⇒ A yields (no GC-enabled reuse)");
    ok(claimWakeSlot(HOME, "c", w(20) + 1, COOL) === false, "ABA: still within cooldown of B's inject ⇒ yield");
    ok(claimWakeSlot(HOME, "c", w(21), COOL) === true, "ABA: a full cooldown past B ⇒ a genuine new claim advances");
    ok(claimWakeSlot(HOME, "c", w(200), COOL, () => { /* no interference */ }) === true, "ABA control: no concurrent advance ⇒ the admitted claim's rename-CAS succeeds");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}
// Fail-closed: a late lower-ts claim is rejected by the high-water MAX; a dir read fault and a persist fault never admit.
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakehole-"));
  const w = (n: number) => n * COOL;
  const dir = path.join(HOME, ".agenthop/console/inbox-wake");
  try {
    // advance the head several cooldowns, then a late lower-ts request must NOT re-admit (the head timestamp is the authority).
    for (const n of [8, 9, 10, 11, 12]) ok(claimWakeSlot(HOME, "c", w(n), COOL) === true, `sequential claim at ts ${n}`);
    ok(claimWakeSlot(HOME, "c", w(10) + 1, COOL) === false, "① a late request at ts 10 is rejected by the high-water MAX");
    ok(claimWakeSlot(HOME, "c", w(9) + 1, COOL) === false, "① a late request at ts 9 is rejected by the high-water MAX");
    // ② read fault != absent: an unreadable marker dir ⇒ UNKNOWN ⇒ fail-closed (reject), never treated as initial.
    chmodSync(dir, 0o000);
    try { ok(claimWakeSlot(HOME, "c", w(13), COOL) === false, "② readdir EACCES ⇒ UNKNOWN ⇒ reject (not treated as empty/initial)"); }
    finally { chmodSync(dir, 0o700); }
    // ③ persist fault: a read-only marker dir ⇒ the bootstrap/rename fails ⇒ no authorize.
    chmodSync(dir, 0o500);
    let created = true;
    try { created = claimWakeSlot(HOME, "c", w(14), COOL); } finally { chmodSync(dir, 0o700); }
    ok(created === false, "③ create/persist fault ⇒ not authorized (publish-after-fact: no advance ⇒ no inject)");
    ok(claimWakeSlot(HOME, "c", w(15), COOL) === true, "after faults clear, a genuinely new claim still advances (head intact)");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}
// IW-R4-P2-1: a cooldown PARAMETER change must not let a stale interpretation block new wakes (the admit is purely time-based).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakeparam-"));
  const C60 = 60_000, C120 = 120_000;
  try {
    ok(claimWakeSlot(HOME, "c", 1_000_000, C60) === true, "param: a 60s-cooldown claim at t=1,000,000 wins");
    // switch to a 120s cooldown, clock +240s: the admit is now - headTs >= cooldown, parameter-independent ⇒ admits.
    ok(claimWakeSlot(HOME, "c", 1_240_000, C120) === true, "IW-R4-P2-1: 60→120 then +240s ⇒ admits (time-based, not blocked by the old cooldown)");
    // reverse: another target, 120s then 60s.
    ok(claimWakeSlot(HOME, "d", 1_000_000, C120) === true, "param: a 120s-cooldown claim wins");
    ok(claimWakeSlot(HOME, "d", 1_240_000, C60) === true, "IW-R4-P2-1 reverse: 120→60 then +240s ⇒ admits");
    ok(claimWakeSlot(HOME, "d", 1_245_000, C60) === false, "only 5s since the last inject ⇒ rejected (the new 60s cooldown holds)");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
}

// IW-P2-1 r5-regression: the GLOBAL max timestamp is the authority across cooldown-parameter changes (no revival).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakexfam-"));
  const C60 = 60_000, C120 = 120_000;
  try {
    ok(claimWakeSlot(HOME, "x", 1_000_000, C120) === true, "xfam: inject at a 120s cooldown (t=1,000,000)");
    ok(claimWakeSlot(HOME, "x", 1_061_000, C60) === true, "xfam: inject at a 60s cooldown (t=1,061,000, advances the head)");
    ok(claimWakeSlot(HOME, "x", 1_062_000, C120) === false, "IW-P2-1: a 120s re-claim at t=1,062,000 is rejected by the last inject's timestamp (global MAX) — no revival");
    ok(claimWakeSlot(HOME, "x", 1_181_001, C120) === true, "xfam: once 120s has truly elapsed since the last inject, the claim admits again");
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
// IW-P2-1 (r9): a SINGLE head file advanced by rename — one file (never accumulates), no GC, no permanent block; an unparseable head with
// no valid head present fails closed (never bootstrap a fresh epoch over corruption).
{
  const HOME = mkdtempSync(path.join(os.tmpdir(), "ah-wakehead-"));
  const dir = path.join(HOME, ".agenthop/console/inbox-wake");
  const safe = createHash("sha256").update("c").digest("hex");
  const w = (n: number) => n * COOL;
  const heads = (): string[] => readdirSync(dir).filter((n) => n.startsWith(`${safe}.head.`));
  try {
    ok(claimWakeSlot(HOME, "c", w(8), COOL) === true, "r9: bootstrap + advance (head.0.0 ⇒ head.1.<w8>)");
    ok(heads().length === 1, "r9: exactly ONE head file (renamed in place, never accumulates)");
    ok(claimWakeSlot(HOME, "c", w(9), COOL) === true, "r9: advance");
    ok(heads().length === 1, "r9: still exactly one head file");
    ok(claimWakeSlot(HOME, "c", w(500), COOL) === true, "r9: a far-later claim advances — a stalled/crashed holder's head never permanently blocks");
  } finally { rmSync(HOME, { recursive: true, force: true }); }
  const HOME2 = mkdtempSync(path.join(os.tmpdir(), "ah-wakecorrupt-"));
  const dir2 = path.join(HOME2, ".agenthop/console/inbox-wake"); mkdirSync(dir2, { recursive: true });
  const safe2 = createHash("sha256").update("c").digest("hex");
  try {
    writeFileSync(path.join(dir2, `${safe2}.head.notanumber`), "");
    ok(claimWakeSlot(HOME2, "c", Date.now(), COOL) === false, "IW-P2-1 r9: an unparseable head with no valid head ⇒ fail-closed (never bootstrap over corruption)");
  } finally { rmSync(HOME2, { recursive: true, force: true }); }
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
