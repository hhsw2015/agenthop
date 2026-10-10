// Inbox real-time wake (SWARM_INBOX_WAKE, live by default). The coordinator's pain: durable-inbox mail sat 0-8 min waiting for the
// next poll/cron. User ruling (same shape as flags-default-on): don't lean on a manual member step — bake the ping INTO the delivery
// primitive. writeInbox fires an injected hook AFTER a genuinely new message lands (see inbox.ts setInboxWakeHook); this module is
// that hook, installed once per writer PROCESS in the library-init path (startBusCore, covering MCP/presence/CLI; the dispatcher
// installs too). It resolves the target session's herdr pane and injects a one-line wake prompt, best-effort + fail-soft (a wake
// fault never touches the already-established delivery). The anti-storm cooldown is a 先占后发 (claim-before-send) ATOMIC slot held on
// the FILESYSTEM, so a same-batch burst AND independent writer processes all collapse to one inject per window. The dispatcher watch
// is demoted to a BACKSTOP: re-inject only for items that have lain unclaimed past a window (a write-side wake that missed).

import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
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

/** 先占后发 — atomically claim the per-target wake slot for the current window BEFORE any send. Two durable guards, both ONLY-GROWING
 *  (FC-6 family: cleanup never re-opens a used window, IW-P2-1):
 *   1. a per-window O_EXCL marker `console/inbox-wake/<sha256(sid)>.<window>` — 20 concurrent fires, an 8-in-a-row burst, and
 *      independent writer processes all resolve to exactly ONE winner per window (the rest get EEXIST). This is the SAME-window gate.
 *   2. a monotonic high-water `<sha256(sid)>.hw` holding the highest window ever claimed — a late request that re-wins a window whose
 *      marker was already garbage-collected is still REJECTED here (its window <= hw), so a cleanup can never re-admit a used window,
 *      no matter how long the late request paused. This is the STALE-window gate.
 *  A won slot is never rolled back, so a withheld or failed inject is throttled too (expires at the next window). Old window markers
 *  are GC'd two windows back — safe because the high-water, not the marker, is the authority for staleness. The sid is hashed to a
 *  safe single filename segment (any sid). Returns true iff THIS caller won a FRESH window. Fail-safe: a bad clock / unwritable store
 *  ⇒ false (never inject uncoordinated). Never throws. */
export function claimWakeSlot(home: string, sid: string, now: number, cooldownMs: number): boolean {
  if (!sid || !Number.isFinite(now) || !(cooldownMs > 0)) return false;
  const dir = path.join(home, ".agenthop", "console", "inbox-wake");
  const safe = createHash("sha256").update(sid).digest("hex");
  const window = Math.floor(now / cooldownMs);
  const slot = path.join(dir, `${safe}.${window}`);
  const hwPath = path.join(dir, `${safe}.hw`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(slot, String(now), { flag: "wx", mode: 0o600 }); // O_EXCL same-window gate: EEXIST ⇒ this window already claimed
  } catch { return false; }
  // Stale-window gate: reject any window at or below the highest ever claimed — so a cleaned-then-re-created old window can never
  // re-admit (the reviewer's cross-window interleave). The high-water only ever advances; it is never deleted.
  let hw = -1;
  try { const r = Number(readFileSync(hwPath, "utf8").trim()); if (Number.isFinite(r)) hw = r; } catch { /* absent ⇒ -1 */ }
  if (window <= hw) { try { unlinkSync(slot); } catch { /* ignore */ } return false; }
  try { const tmp = `${hwPath}.tmp-${randomBytes(4).toString("hex")}`; writeFileSync(tmp, String(window), { mode: 0o600 }); renameSync(tmp, hwPath); } catch { /* best-effort advance */ }
  try { unlinkSync(path.join(dir, `${safe}.${window - 2}`)); } catch { /* bounded GC; the window may not exist */ }
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
