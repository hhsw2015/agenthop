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

/** 先占后发 — atomically claim the per-target wake slot BEFORE any send. The rejection AUTHORITY is the GLOBAL high-water TIMESTAMP:
 *  MAX over the CONTENT (claim timestamp) of ALL this sid's markers, regardless of interval family or legacy format. The admit is purely
 *  time-based — `now - maxTs >= cooldownMs` — so it is parameter-independent (a cooldown change just compares against the new width,
 *  IW-R4-P2-1), legacy-aware (an r4 `<sid>.<window>` marker also stores a timestamp ⇒ still blocks, IW-R5-P2-1), and cross-family-safe
 *  (a GC that drops one family's marker cannot re-open a used window, because a MORE-RECENT marker's timestamp remains the authority,
 *  IW-P2-1). Atomicity is a per-cooldown-window O_EXCL marker `console/inbox-wake/<sha256(sid)>.w<cooldownMs>.<window>` (window =
 *  floor(now/cooldownMs)) — 20 concurrent / 8-in-a-row / cross-process within one cooldown period ⇒ exactly one winner. The marker
 *  create is the sole durable evidence (a create fault ⇒ reject; FC-2 publish-after-fact). A readdir FAULT (non-ENOENT) ⇒ UNKNOWN ⇒
 *  reject (fail-closed, FC-2 r3). After creating we RE-READ the max: a concurrent LATER inject ⇒ yield. The age-GC deletes markers whose
 *  timestamp is older than one cooldown — so it preserves the high-water EXACTLY while it is still within the cooldown (its rejection
 *  duty) and only retires expired evidence (where the admit would pass anyway). Returns true iff THIS caller won a fresh, confirmed
 *  claim. Never throws. */
export function claimWakeSlot(home: string, sid: string, now: number, cooldownMs: number): boolean {
  if (!sid || !Number.isFinite(now) || !(cooldownMs > 0)) return false;
  const dir = path.join(home, ".agenthop", "console", "inbox-wake");
  const safe = createHash("sha256").update(sid).digest("hex");
  const sidPrefix = `${safe}.`;                      // EVERY marker of this sid — every interval family, legacy format, and future schema
  const famPrefix = `${safe}.w${cooldownMs}.`;       // only THIS interval family (what this process is allowed to GC)
  const window = Math.floor(now / cooldownMs);
  const slotName = `${safe}.w${cooldownMs}.${window}`;
  const slot = path.join(dir, slotName);
  // EFFECTIVE timestamp of a marker (fail-closed recognition, coordinator's "any unknown file is EVIDENCE, not garbage"): its parseable
  // CONTENT (the claim timestamp) if finite; else — an unrecognized / future-schema / corrupt file — its MTIME, so it STILL counts as
  // recent evidence and STILL ages out. null only when the entry truly vanished (gone ⇒ not evidence).
  const effTs = (name: string): number | null => {
    const p = path.join(dir, name);
    try { const c = Number(readFileSync(p, "utf8").trim()); if (Number.isFinite(c)) return c; } catch { return null; } // vanished mid-scan
    try { return lstatSync(p).mtimeMs; } catch { return null; }
  };
  // GLOBAL high-water = MAX effective-timestamp over EVERY marker of this sid (any family / legacy / unrecognized). -Infinity when
  // confirmed-empty (ENOENT dir / none); null on a dir read FAULT (non-ENOENT) ⇒ caller fails closed.
  const readMaxTs = (): number | null => {
    let names: string[];
    try { names = readdirSync(dir); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? -Infinity : null; }
    let max = -Infinity;
    for (const n of names) { if (!n.startsWith(sidPrefix)) continue; const ts = effTs(n); if (ts !== null && ts > max) max = ts; }
    return max;
  };
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  const max0 = readMaxTs();
  if (max0 === null) return false;                   // read fault ⇒ UNKNOWN ⇒ fail-closed
  if (now - max0 < cooldownMs) return false;         // within cooldown of the last inject (ANY family / legacy / unrecognized) ⇒ reject
  try { writeFileSync(slot, String(now), { flag: "wx", mode: 0o600 }); } catch { return false; } // O_EXCL same-window gate + persist(timestamp); fault ⇒ no authorize
  const max1 = readMaxTs();
  if (max1 === null || max1 > now) { try { unlinkSync(slot); } catch { /* ignore */ } return false; } // a concurrent LATER inject won ⇒ yield
  // GC ONLY this process's OWN interval family, and only its EXPIRED windows (effective-ts older than one cooldown). Other families,
  // legacy files and anything unrecognized are EVIDENCE, never this process's garbage (IW-P2-1 / IW-R5-P2-1) — they are left untouched
  // (each family self-cleans) and stay in readMaxTs. A within-cooldown marker (the live rejection authority) is never removed.
  try { for (const n of readdirSync(dir)) { if (!n.startsWith(famPrefix) || n === slotName) continue; const ts = effTs(n); if (ts !== null && ts < now - cooldownMs) { try { unlinkSync(path.join(dir, n)); } catch { /* ignore */ } } } } catch { /* GC best-effort */ }
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
