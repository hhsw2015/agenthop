// Inbox real-time wake (SWARM_INBOX_WAKE, live by default). The coordinator's pain: durable-inbox mail sat 0-8 min waiting for the
// next poll/cron. User ruling (same shape as flags-default-on): don't lean on a manual member step — bake the ping INTO the delivery
// primitive. writeInbox fires an injected hook AFTER a genuinely new message lands (see inbox.ts setInboxWakeHook); this module is
// that hook, installed once per writer PROCESS in the library-init path (startBusCore, covering MCP/presence/CLI; the dispatcher
// installs too). It resolves the target session's herdr pane and injects a one-line wake prompt, best-effort + fail-soft (a wake
// fault never touches the already-established delivery). The anti-storm cooldown is a 先占后发 (claim-before-send) ATOMIC slot held on
// the FILESYSTEM, so a same-batch burst AND independent writer processes all collapse to one inject per window. The dispatcher watch
// is demoted to a BACKSTOP: re-inject only for items that have lain unclaimed past a window (a write-side wake that missed).

import { mkdirSync, writeFileSync, readdirSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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

/** 先占后发 — atomically claim the per-target wake slot BEFORE any send, as a monotonic GENERATION chain. There is NO lock to steal and
 *  NO lease to expire — the two mechanisms a gate foundered on (a paused-not-dead holder gets its gate stolen then resumes ⇒ two
 *  injects; recycle is not generation-bound ⇒ a late recycler deletes a new holder's fresh gate; a read error wrongly authorizes a
 *  steal). Instead the generation is bound to the inject MARKER itself: the admit TEST and the occupy are the SAME anchor — the next
 *  generation file. Each inject appends `console/inbox-wake/<sha256(sid)>.gen<N>` (N = prevMaxGen + 1, content = claim timestamp) with
 *  O_EXCL. Two claimers that observe the same state target the SAME `gen<N+1>` and O_EXCL admits exactly ONE; a claimer that observes a
 *  NEWER generation necessarily also reads its recent timestamp and fails the admit — so no interleaving injects twice. (A fencing gate
 *  can never tighten this: herdr cannot validate a token, so a steal between a "still-my-generation" re-check and the inject itself
 *  would still double-inject; the ONLY fs-atomic serialization point is the O_EXCL create, so that IS the claim.) The rejection
 *  AUTHORITY is the GLOBAL high-water TIMESTAMP: MAX effective-ts over EVERY `<sha256(sid)>.*` marker (gen / legacy / unrecognized), so
 *  the admit is purely time-based (`now - maxTs >= cooldownMs`) — parameter-independent (IW-R4-P2-1) and FC-7-aware (any file is
 *  evidence: parseable content else mtime, never ignored, never Number("") ⇒ 0). A crashed holder simply leaves a valid gen marker that
 *  enforces the cooldown and is superseded by the next generation — no permanent block, no recovery race, no steal, so the three
 *  IW-P2-1 gate-recycle holes vanish by construction. A readdir FAULT (non-ENOENT) ⇒ UNKNOWN ⇒ reject (fail-closed, FC-2 r3); a create
 *  fault (incl. EEXIST: a concurrent same-gen winner) ⇒ reject (publish-after-fact). The age-GC retires only markers older than one
 *  cooldown, never our own fresh generation, so the high-water is preserved exactly while it is the live rejection authority. Returns
 *  true iff THIS caller won a fresh, confirmed claim. Never throws. */
export function claimWakeSlot(home: string, sid: string, now: number, cooldownMs: number): boolean {
  if (!sid || !Number.isFinite(now) || !(cooldownMs > 0)) return false;
  const dir = path.join(home, ".agenthop", "console", "inbox-wake");
  const safe = createHash("sha256").update(sid).digest("hex");
  const sidPrefix = `${safe}.`;                      // EVERY marker of this sid — gen chain, legacy format, and anything unrecognized
  const genPrefix = `${safe}.gen`;                   // only the generation chain (parsed for the next slot number)
  // EFFECTIVE timestamp of a marker (FC-7 fail-closed recognition): ENOENT ⇒ null (the entry truly vanished ⇒ not evidence). Any OTHER
  // read fault (EACCES / EIO / ...) ⇒ `now`, so a present-but-unreadable marker counts as a just-happened inject and BLOCKS this claim
  // (a read error NEVER authorizes a fresh claim — FC-2 r3). Empty or non-numeric content ⇒ fall back to MTIME (never Number("") ⇒ 0);
  // mtime unreadable ⇒ `now`.
  const effTs = (name: string): number | null => {
    const p = path.join(dir, name);
    let raw: string;
    try { raw = readFileSync(p, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; try { return lstatSync(p).mtimeMs; } catch { return now; } }
    const t = raw.trim();
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
    try { return lstatSync(p).mtimeMs; } catch { return now; }
  };
  // Scan every marker of this sid ONCE: the GLOBAL high-water timestamp (admit authority) and the MAX generation number (next slot).
  // null on a dir read FAULT (non-ENOENT) ⇒ caller fails closed; a confirmed-empty dir ⇒ { -Infinity, -1 }.
  const scan = (): { maxTs: number; maxGen: number; names: string[] } | null => {
    let names: string[];
    try { names = readdirSync(dir); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { maxTs: -Infinity, maxGen: -1, names: [] } : null; }
    let maxTs = -Infinity, maxGen = -1;
    for (const n of names) {
      if (!n.startsWith(sidPrefix)) continue;
      const ts = effTs(n); if (ts !== null && ts > maxTs) maxTs = ts;
      if (n.startsWith(genPrefix)) { const g = n.slice(genPrefix.length); if (/^\d+$/.test(g)) { const num = Number(g); if (Number.isSafeInteger(num) && num > maxGen) maxGen = num; } }
    }
    return { maxTs, maxGen, names };
  };
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  const s = scan();
  if (s === null) return false;                       // dir read fault ⇒ UNKNOWN ⇒ fail-closed
  if (now - s.maxTs < cooldownMs) return false;       // within cooldown of the last inject (any gen / legacy / unrecognized) ⇒ reject
  const slotName = `${safe}.gen${s.maxGen + 1}`;      // admit and occupy share ONE anchor: the next generation
  const slot = path.join(dir, slotName);
  try { writeFileSync(slot, String(now), { flag: "wx", mode: 0o600 }); } catch { return false; } // O_EXCL: a concurrent same-gen claimer gets EEXIST ⇒ yields; a store fault ⇒ no authorize (publish-after-fact)
  // GC: retire only markers whose effective-ts is older than one cooldown (never our own fresh generation). The high-water is preserved
  // exactly while within the cooldown (its live rejection duty); legacy / unrecognized files self-retire the same way (FC-7).
  for (const n of s.names) { if (n === slotName || !n.startsWith(sidPrefix)) continue; const ts = effTs(n); if (ts !== null && ts < now - cooldownMs) { try { unlinkSync(path.join(dir, n)); } catch { /* ignore */ } } }
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
  if (!inboxWakeEnabled(env) || !herdrSpawnable(env)) { setInboxWakeHook(null); return false; }
  const deps = defaultWakeDeps(log);
  setInboxWakeHook((home, sid) => { void wakeSession(home, sid, deps).catch(() => undefined); }); // fire-and-forget, fully fail-soft
  return true;
}

/** Dispatcher-sweep backstop entry: re-ping a session's box if an item has lain unclaimed past the window. No-op when off / no herdr. */
export async function backstopWake(home: string, sid: string, log?: (s: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome | "fresh" | "off"> {
  if (!sid || !inboxWakeEnabled(env) || !herdrSpawnable(env)) return "off";
  return runWakeBackstop(home, sid, defaultWakeDeps(log));
}
