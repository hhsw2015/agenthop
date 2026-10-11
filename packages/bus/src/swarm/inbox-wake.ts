// Inbox real-time wake (SWARM_INBOX_WAKE, live by default). The coordinator's pain: durable-inbox mail sat 0-8 min waiting for the
// next poll/cron. User ruling (same shape as flags-default-on): don't lean on a manual member step — bake the ping INTO the delivery
// primitive. writeInbox fires an injected hook AFTER a genuinely new message lands (see inbox.ts setInboxWakeHook); this module is
// that hook, installed once per writer PROCESS in the library-init path (startBusCore, covering MCP/presence/CLI; the dispatcher
// installs too). It resolves the target session's herdr pane and injects a one-line wake prompt, best-effort + fail-soft (a wake
// fault never touches the already-established delivery). The anti-storm cooldown is a 先占后发 (claim-before-send) ATOMIC slot held on
// the FILESYSTEM, so a same-batch burst AND independent writer processes all collapse to one inject per window. The dispatcher watch
// is demoted to a BACKSTOP: re-inject only for items that have lain unclaimed past a window (a write-side wake that missed).

import { mkdirSync, writeFileSync, readdirSync, readFileSync, lstatSync, renameSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { flagDefaultOn } from "./flag-default.js";
import { setInboxWakeHook, scanUnclaimedInbox } from "../inbox.js";
import { herdrSpawnable, herdrPaneInfoForSession, herdrPrompt, type AgentState } from "./herdr.js";

/** SWARM_INBOX_WAKE — live by default (opt-out; kill with =0), same opt-out family as the other swarm flags. */
export function inboxWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_INBOX_WAKE);
}

const envSec = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
/** Cooldown / claim window: a same-batch burst (N messages ⇒ N writeInbox ⇒ N hook fires) injects at most once per window. */
const COOLDOWN_MS = envSec(process.env.SWARM_INBOX_WAKE_COOLDOWN_SEC, 120) * 1000;
/** Backstop window: the dispatcher only re-pings for an unclaimed item that has lain this long (a write-side wake that was missed). */
const BACKSTOP_MS = envSec(process.env.SWARM_INBOX_WAKE_BACKSTOP_SEC, 60) * 1000;

/** The fixed wake line (same format/semantics as a cron self-wake). */
export function wakeText(count: number): string { return `[唤醒:箱内有 ${count} 件未认领]`; }

/** PURE wakeable-situation decision: a wake is warranted iff the clock is usable, there is unclaimed mail, and the pane is NOT working
 *  (never interrupt mid-run) and NOT "unknown" (a herdr read that can't confirm not-working ⇒ err safe, the FC fail-safe direction).
 *  `last`/cooldownMs let it also express the cooldown for the standalone contract; in production the cooldown is ENFORCED by the atomic
 *  claim (claimWakeSlot) and this is called with last=-Infinity for the state+count gate only. No clock/IO inside. */
export function shouldInjectWake(now: number, last: number, paneState: string, count: number, cooldownMs: number = COOLDOWN_MS): boolean {
  if (!Number.isFinite(now)) return false;
  if (!(count > 0)) return false;
  if (paneState === "working" || paneState === "unknown") return false;
  if (Number.isFinite(last) && now - last < cooldownMs) return false;
  return true;
}

/** 先占后发 — atomically claim the per-target wake slot BEFORE any send, via a SINGLE monotonic head advanced by a rename CAS. The chain
 *  head is one file `console/inbox-wake/<sha256(sid)>.head.<gen>.<ts>` (generation and last-inject timestamp both in the NAME, so they
 *  advance together atomically). To claim, rename the CURRENT head forward to `<...>.head.<gen+1>.<now>`. rename is the whole guarantee:
 *  it is atomic, and it renames FROM the exact current head name — so if another claimer already advanced the head, that name is GONE and
 *  our rename fails with ENOENT. This is the ABA fix the gen-chain lacked: O_EXCL *create* succeeds on a name a GC freed, letting a stale
 *  snapshot re-use a consumed generation; rename *from* a vanished name cannot — a used generation is never reusable, with no GC, no
 *  tombstone, and exactly one head file. The REJECTION AUTHORITY for the cooldown is the GLOBAL high-water TIMESTAMP: MAX over the head's
 *  ts AND the effective-ts of every other `<sha256(sid)>.*` marker (legacy / unrecognized), so the admit is purely time-based
 *  (`now - maxTs >= cooldownMs`) — parameter-independent (IW-R4-P2-1) and FC-7-aware (any file is evidence: parseable content else mtime,
 *  never ignored, never Number("") ⇒ 0). The epoch head itself has a constant name, so it is gated by a PERMANENT `<sha256(sid)>.genesis`
 *  sentinel (O_EXCL once, never deleted): only the genesis winner creates `<sha>.head.0.0`, and once genesis exists a no-head state is
 *  UNKNOWN ⇒ never re-created — so a consumed epoch source name can never be O_EXCL-revived by a late no-head snapshot (BOOTSTRAP-ABA).
 *  A readdir/stat FAULT ⇒ UNKNOWN ⇒ reject (fail-closed, FC-2 r3); an unparseable head with no valid head present ⇒ reject (never
 *  bootstrap over corruption); a genesis/bootstrap/rename fault ⇒ reject (publish-after-fact). `onAfterScan` is a TEST-ONLY concurrency
 *  seam (undefined in production). Returns true iff THIS caller won the advance. Never throws. */
export function claimWakeSlot(home: string, sid: string, now: number, cooldownMs: number, onAfterScan?: () => void): boolean {
  if (!sid || !Number.isFinite(now) || !(cooldownMs > 0)) return false;
  const dir = path.join(home, ".agenthop", "console", "inbox-wake");
  const safe = createHash("sha256").update(sid).digest("hex");
  const sidPrefix = `${safe}.`;
  const headPrefix = `${safe}.head.`;
  const genesisName = `${safe}.genesis`;             // permanent "this sid was bootstrapped" sentinel (O_EXCL once, never deleted)
  const genesisPath = path.join(dir, genesisName);
  // EFFECTIVE timestamp of a NON-head marker (FC-7 fail-closed recognition): ENOENT ⇒ null (vanished ⇒ not evidence); any OTHER read
  // fault (EACCES / EIO / ...) ⇒ `now` (conservative: a present-but-unreadable marker blocks); empty / non-numeric content ⇒ MTIME
  // (never Number("") ⇒ 0); mtime unreadable ⇒ `now`.
  const effTs = (name: string): number | null => {
    const p = path.join(dir, name);
    let raw: string;
    try { raw = readFileSync(p, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; try { return lstatSync(p).mtimeMs; } catch { return now; } }
    const t = raw.trim();
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
    try { return lstatSync(p).mtimeMs; } catch { return now; }
  };
  // Parse a head NAME `<sha>.head.<gen>.<ts>` ⇒ { gen, ts } (both the generation and the inject timestamp live in the name so a rename
  // advances them atomically). null when it is not a well-formed head name.
  const parseHead = (name: string): { gen: number; ts: number } | null => {
    if (!name.startsWith(headPrefix)) return null;
    const rest = name.slice(headPrefix.length);
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot >= rest.length - 1) return null;
    const g = rest.slice(0, dot), t = rest.slice(dot + 1);
    if (!/^\d+$/.test(g) || !/^\d+$/.test(t)) return null;
    const gen = Number(g), ts = Number(t);
    if (!Number.isSafeInteger(gen) || !Number.isFinite(ts)) return null;
    return { gen, ts };
  };
  // Scan ONCE: the GLOBAL high-water ts (admit authority: head ts + every legacy/unrecognized effTs, FC-7), the current head (the
  // MAX-generation well-formed head file), and whether an unparseable head-like file is present. null on a dir read FAULT (non-ENOENT).
  const scan = (): { maxTs: number; head: { gen: number; ts: number } | null; headName: string | null; corruptHead: boolean } | null => {
    let names: string[];
    try { names = readdirSync(dir); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { maxTs: -Infinity, head: null, headName: null, corruptHead: false } : null; }
    let maxTs = -Infinity, head: { gen: number; ts: number } | null = null, headName: string | null = null, corruptHead = false;
    for (const n of names) {
      if (!n.startsWith(sidPrefix) || n === genesisName) continue; // the genesis sentinel is not an inject marker ⇒ never counts toward the high-water
      if (n.startsWith(headPrefix)) {
        const h = parseHead(n);
        if (h === null) { corruptHead = true; const t = effTs(n); if (t !== null && t > maxTs) maxTs = t; continue; }
        if (h.ts > maxTs) maxTs = h.ts;
        if (head === null || h.gen > head.gen) { head = h; headName = n; }
      } else {
        const t = effTs(n); if (t !== null && t > maxTs) maxTs = t; // legacy / unrecognized evidence (FC-7)
      }
    }
    return { maxTs, head, headName, corruptHead };
  };
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  let s = scan();
  if (s === null) return false;                              // dir read fault ⇒ UNKNOWN ⇒ fail-closed
  if (s.corruptHead && s.head === null) return false;        // an unparseable head and no valid one ⇒ fail-closed (never bootstrap over corruption)
  if (onAfterScan) { try { onAfterScan(); } catch { /* test seam only */ } } // TEST-ONLY: simulate another process advancing the head between our scan and our CAS (undefined in production ⇒ no effect)
  if (s.head === null) {
    // Bootstrap. The epoch head name is a constant, so a LATE no-head snapshot could O_EXCL-recreate it after it was consumed and renamed
    // away (BOOTSTRAP-ABA), reviving a consumed source for a stale claimer's cached rename. Gate the epoch on a PERMANENT genesis sentinel
    // (O_EXCL once, never deleted ⇒ it can never itself ABA): ONLY the genesis winner — the genuine first-ever bootstrapper — may create
    // the epoch head. Once genesis exists, a no-head state is UNKNOWN (the epoch was already consumed, or a bootstrap crashed) ⇒ we NEVER
    // recreate the epoch, so a consumed source name can never be revived. A head lost while genesis persists is a manual / migration path
    // (remove the genesis sentinel to re-bootstrap) — the fail-closed cost of never reasoning a consumed source back to life.
    let wonGenesis = false;
    try { writeFileSync(genesisPath, randomBytes(8).toString("hex"), { flag: "wx", mode: 0o600 }); wonGenesis = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false; } // genesis already exists (not first) or a store fault
    if (wonGenesis) {
      try { writeFileSync(path.join(dir, `${headPrefix}0.0`), "", { flag: "wx", mode: 0o600 }); } // the SOLE place the epoch head is ever created
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false; }
    }
    s = scan();
    if (s === null || s.head === null || s.headName === null) return false; // genesis present but still no head ⇒ UNKNOWN ⇒ yield (never resurrect)
  }
  if (now - s.maxTs < cooldownMs) return false;              // within cooldown of the last inject (head ts or any legacy/unrecognized) ⇒ reject
  // CAS ADVANCE: rename the current head forward. rename FROM the exact current head name fails (ENOENT) if another claimer already
  // advanced it ⇒ a stale snapshot can NEVER re-commit a consumed generation (the old head name is gone; you cannot rename from it).
  // Exactly the single rename winner injects.
  try { renameSync(path.join(dir, s.headName as string), path.join(dir, `${headPrefix}${(s.head as { gen: number }).gen + 1}.${now}`)); } catch { return false; }
  return true;
}

export type PaneInfo = { paneId: string; state: AgentState };
/** Injectable IO surface so wakeSession is unit-testable without spawning herdr subprocesses or touching the real clock/filesystem. */
export interface WakeDeps {
  now: () => number;
  cooldownMs: number;
  claim: (home: string, sid: string, now: number, cooldownMs: number) => boolean; // 先占后发: atomic cross-process slot claim
  paneInfo: (sid: string) => Promise<PaneInfo | null>;                            // resolve sid -> {paneId,state}; null = not a herdr pane
  scan: (home: string, sid: string) => { count: number; oldestMtimeMs: number };
  inject: (paneId: string, text: string) => Promise<boolean>;
  log?: (s: string) => void;
}
export type WakeOutcome = "injected" | "cooldown" | "state" | "empty" | "no-pane" | "error";

/** Fire a best-effort wake at `sid`. Fully fail-soft (any fault ⇒ "error", logged, never thrown). The slot is CLAIMED synchronously
 *  before any await, so a burst / concurrent fires / independent processes collapse to one inject per window. */
export async function wakeSession(home: string, sid: string, d: WakeDeps): Promise<WakeOutcome> {
  if (!sid) return "error";
  if (!d.claim(home, sid, d.now(), d.cooldownMs)) return "cooldown"; // 先占: atomic, synchronous, cross-process — before any await
  try {
    const info = await d.paneInfo(sid);
    if (!info) return "no-pane"; // not a herdr pane (cloud / codex-queue session) ⇒ by-type seam; nothing to inject on this channel
    const { count } = d.scan(home, sid);
    if (!shouldInjectWake(d.now(), -Infinity, info.state, count, d.cooldownMs)) return count > 0 ? "state" : "empty"; // cooldown already held by the claim
    const ok = await d.inject(info.paneId, wakeText(count));
    d.log?.(`[inbox-wake] ${sid}: wake injected (${count} unclaimed, pane ${info.paneId}, state ${info.state}, ok=${ok})`);
    return "injected";
  } catch (e) { d.log?.(`[inbox-wake] ${sid}: wake failed (isolated): ${e instanceof Error ? e.message : e}`); return "error"; }
}

/** BACKSTOP (dispatcher sweep): re-ping `sid` only when an unclaimed item has lain past the backstop window — the write-side wake for
 *  it was missed (herdr briefly down). Shares the SAME filesystem claim as the hook, so it never double-fires a just-pinged box. */
export async function runWakeBackstop(home: string, sid: string, d: WakeDeps, backstopMs: number = BACKSTOP_MS): Promise<WakeOutcome | "fresh"> {
  const { count, oldestMtimeMs } = d.scan(home, sid);
  if (count <= 0) return "empty";
  const now = d.now();
  if (!(Number.isFinite(now) && oldestMtimeMs > 0 && now - oldestMtimeMs > backstopMs)) return "fresh"; // nothing aged past the window
  return wakeSession(home, sid, d);
}

// --- production wiring (real herdr + filesystem claim) ----------------------------------------------------------------------------
function defaultWakeDeps(log?: (s: string) => void): WakeDeps {
  return {
    now: () => Date.now(),
    cooldownMs: COOLDOWN_MS,
    claim: claimWakeSlot,
    paneInfo: async (sid) => herdrPaneInfoForSession(sid),
    scan: scanUnclaimedInbox,
    inject: async (paneId, text) => (await herdrPrompt(paneId, text)).submitted === "yes",
    log,
  };
}

/** Install the real-time wake into the delivery primitive (called from the library-init path, startBusCore, + the dispatcher): once
 *  set, writeInbox fires it on every new message in THIS process — any caller, zero discipline. Gated on the flag AND herdr being
 *  reachable from this process (herdrSpawnable): herdr-not-detected ⇒ leave the hook unset (silently skip, fail-soft) so a non-herdr
 *  process adds no cost and the unit suite is byte-for-byte v0. Idempotent (overwrites). Returns whether the hook was installed. */
export function installInboxWake(log?: (s: string) => void, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!inboxWakeEnabled(env)) { setInboxWakeHook(null); return false; } // OFF: intentional + honestly shown by the flags line
  // F54: SWARM_INBOX_WAKE is ON but this process cannot reach herdr (HERDR_ENV/HERDR_PANE_ID unset) ⇒ the real-time hook stays
  // UNSET. This used to be a SILENT skip while the flags line still said "on" — a bare-env dispatcher restart left wake dead for
  // 20 min with no trace. Log the reason so the inert state is never silent (the flags line also reports it as on(inert:no-herdr)).
  if (!herdrSpawnable(env)) {
    setInboxWakeHook(null);
    log?.("inbox-wake: SWARM_INBOX_WAKE on but herdr is NOT reachable from this process (HERDR_ENV/HERDR_PANE_ID unset) — real-time wake INERT; writeInbox still delivers DURABLY and the target's own inbox poll still applies. NOTE: this process's dispatcher backstop shares the SAME herdr gate, so it is ALSO inert here — re-pings need a herdr-reachable dispatcher");
    return false;
  }
  const deps = defaultWakeDeps(log);
  setInboxWakeHook((home, sid) => { void wakeSession(home, sid, deps).catch(() => undefined); }); // fire-and-forget, fully fail-soft
  return true;
}

/** F54: the honest tri-state for the dispatcher flags line. `inboxWakeEnabled` alone reports only the FLAG; the real-time hook is
 *  additionally gated on herdr being reachable from THIS process, so "flag on + no herdr" is live-but-INERT, not "on". Pure. */
export function inboxWakeStatus(env: NodeJS.ProcessEnv = process.env): "off" | "on" | "on(inert:no-herdr)" {
  if (!inboxWakeEnabled(env)) return "off";
  return herdrSpawnable(env) ? "on" : "on(inert:no-herdr)";
}

/** Dispatcher-sweep backstop entry: re-ping a session's box if an item has lain unclaimed past the window. No-op when off / no herdr. */
export async function backstopWake(home: string, sid: string, log?: (s: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome | "fresh" | "off"> {
  if (!sid || !inboxWakeEnabled(env) || !herdrSpawnable(env)) return "off";
  return runWakeBackstop(home, sid, defaultWakeDeps(log));
}
