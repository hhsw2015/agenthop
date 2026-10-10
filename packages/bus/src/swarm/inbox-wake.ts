// Inbox real-time wake (SWARM_INBOX_WAKE, live by default). The coordinator's pain: durable-inbox mail sat 0-8 min waiting for the
// next poll/cron. User ruling (same shape as flags-default-on): don't lean on a manual member step — bake the ping INTO the delivery
// primitive. writeInbox fires an injected hook AFTER a genuinely new message lands (see inbox.ts setInboxWakeHook); this module is
// that hook: it resolves the target session's herdr pane and injects a one-line wake prompt, best-effort + fail-soft (a wake fault
// never touches the already-established delivery). The anti-storm trio (one inject per burst / cooldown / never interrupt a working
// pane) is a PURE decision (shouldInjectWake). The dispatcher watch is demoted to a BACKSTOP: only re-inject for items that have lain
// unclaimed past a window (catching a write-side wake that failed because herdr was briefly down).

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
/** Cooldown: a same-batch burst (N messages ⇒ N writeInbox ⇒ N hook fires) injects at most once, then stays quiet this long. */
const COOLDOWN_MS = envSec(process.env.SWARM_INBOX_WAKE_COOLDOWN_SEC, 120) * 1000;
/** Backstop window: the dispatcher only re-pings for an unclaimed item that has lain this long (a write-side wake that was missed). */
const BACKSTOP_MS = envSec(process.env.SWARM_INBOX_WAKE_BACKSTOP_SEC, 60) * 1000;

/** The fixed wake line (same format/semantics as a cron self-wake). */
export function wakeText(count: number): string { return `[唤醒:箱内有 ${count} 件未认领]`; }

/** PURE anti-storm decision (the spec's shouldInjectWake). Inject a wake iff: the clock is usable; there is at least one unclaimed
 *  item; the pane is NOT working (don't interrupt mid-run) and NOT "unknown" (a herdr read that can't confirm not-working ⇒ err safe,
 *  the FC fail-safe direction); and we are past the cooldown since the last inject to this session. No clock/IO inside. */
export function shouldInjectWake(now: number, last: number, paneState: string, count: number, cooldownMs: number = COOLDOWN_MS): boolean {
  if (!Number.isFinite(now)) return false;
  if (!(count > 0)) return false;
  if (paneState === "working" || paneState === "unknown") return false;
  if (Number.isFinite(last) && now - last < cooldownMs) return false;
  return true;
}

export type PaneInfo = { paneId: string; state: AgentState };
/** Injectable IO surface so wakeSession is unit-testable without spawning herdr subprocesses. */
export interface WakeDeps {
  now: () => number;
  cooldownMs: number;
  last: Map<string, number>;                                            // per-sid last-inject ms (anti-storm, shared across hook + backstop)
  paneInfo: (sid: string) => Promise<PaneInfo | null>;                  // resolve sid -> {paneId,state}; null = not a herdr pane
  scan: (home: string, sid: string) => { count: number; oldestMtimeMs: number };
  inject: (paneId: string, text: string) => Promise<boolean>;          // inject the wake line; true = submit confirmed
  log?: (s: string) => void;
}
export type WakeOutcome = "injected" | "cooldown" | "state" | "empty" | "no-pane" | "error";

/** Fire a best-effort wake at `sid`. Fully fail-soft: ANY fault resolves to "error" and is logged, never thrown (the delivery that
 *  triggered this already succeeded). Cheap cooldown short-circuit runs BEFORE any herdr call so a burst resolves the pane at most
 *  once. The `last` map is updated only on an actual inject attempt, so a working-pane skip re-checks on the next trigger (no cooldown
 *  burned on a non-inject). */
export async function wakeSession(home: string, sid: string, d: WakeDeps): Promise<WakeOutcome> {
  if (!sid) return "error";
  try {
    const now = d.now();
    const last = d.last.get(sid) ?? -Infinity;
    if (Number.isFinite(now) && Number.isFinite(last) && now - last < d.cooldownMs) return "cooldown";
    const info = await d.paneInfo(sid);
    if (!info) return "no-pane"; // not a herdr pane (cloud / codex-queue session) ⇒ by-type seam; nothing to inject on this channel
    const { count } = d.scan(home, sid);
    if (!shouldInjectWake(now, last, info.state, count, d.cooldownMs)) return count > 0 ? "state" : "empty";
    const ok = await d.inject(info.paneId, wakeText(count));
    d.last.set(sid, now); // record the attempt even if submit was unconfirmed ⇒ a flaky inject cannot storm within the cooldown
    d.log?.(`[inbox-wake] ${sid}: wake injected (${count} unclaimed, pane ${info.paneId}, state ${info.state}, ok=${ok})`);
    return "injected";
  } catch (e) { d.log?.(`[inbox-wake] ${sid}: wake failed (isolated): ${e instanceof Error ? e.message : e}`); return "error"; }
}

/** BACKSTOP (dispatcher sweep): re-ping `sid` only when an unclaimed item has lain past the backstop window — the write-side wake
 *  for it was missed (herdr briefly down). Shares the same cooldown map as the hook, so it never double-fires a just-pinged box. */
export async function runWakeBackstop(home: string, sid: string, d: WakeDeps, backstopMs: number = BACKSTOP_MS): Promise<WakeOutcome | "fresh"> {
  const { count, oldestMtimeMs } = d.scan(home, sid);
  if (count <= 0) return "empty";
  const now = d.now();
  if (!(Number.isFinite(now) && oldestMtimeMs > 0 && now - oldestMtimeMs > backstopMs)) return "fresh"; // nothing aged past the window
  return wakeSession(home, sid, d);
}

// --- production wiring (real herdr) -----------------------------------------------------------------------------------------------
const wakeLast = new Map<string, number>(); // process-wide per-sid cooldown ledger, shared by the write-side hook + the backstop
/** Clear the cooldown ledger (tests only). */
export function resetInboxWakeState(): void { wakeLast.clear(); }

function defaultWakeDeps(log?: (s: string) => void): WakeDeps {
  return {
    now: () => Date.now(),
    cooldownMs: COOLDOWN_MS,
    last: wakeLast,
    // herdrSpawnable gate: outside a herdr pane there is nothing to inject into ⇒ skip the subprocess entirely (fail-soft no-op).
    paneInfo: async (sid) => (herdrSpawnable() ? herdrPaneInfoForSession(sid) : null),
    scan: scanUnclaimedInbox,
    inject: async (paneId, text) => (await herdrPrompt(paneId, text)).submitted === "yes",
    log,
  };
}

/** Install the real-time wake into the delivery primitive: writeInbox will fire it on every new message (any caller, zero discipline).
 *  No-op + leaves the hook unset when the flag is off (byte-for-byte v0 delivery). Returns whether the hook was installed. */
export function installInboxWake(log?: (s: string) => void, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!inboxWakeEnabled(env)) { setInboxWakeHook(null); return false; }
  const deps = defaultWakeDeps(log);
  setInboxWakeHook((home, sid) => { void wakeSession(home, sid, deps).catch(() => undefined); }); // fire-and-forget, fully fail-soft
  return true;
}

/** Dispatcher-sweep backstop entry: re-ping a session's box if an item has lain unclaimed past the window. No-op when the flag is off. */
export async function backstopWake(home: string, sid: string, log?: (s: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<WakeOutcome | "fresh" | "off"> {
  if (!sid || !inboxWakeEnabled(env)) return "off";
  return runWakeBackstop(home, sid, defaultWakeDeps(log));
}
