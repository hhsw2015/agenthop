/**
 * idle-subscription — one-shot "tell me when that session next goes idle or exits" (S14 absorb #1).
 *
 * Absorbed from the official cross-session-messaging `notify_when_idle`: instead of polling a long-running peer, a
 * subscriber registers once and gets exactly ONE durable notice when the target next goes idle (finished a turn, nothing
 * queued) or exits, with a 12h expiry. We already have the dead-wait SENTINEL (detect a stalled inbox); this adds the
 * positive, opt-in idle-subscribe it was missing — directly serving the self-driving north star (hear when a member
 * finishes, don't poll).
 *
 * Pure core below (selftested): the subscription record + the one-shot fire predicate + expiry/prune. IO (persist the
 * ledger, watch presence, deliver the notice over the durable inbox) is dormant (`SWARM_IDLE_SUB` off) in the caller.
 */

// ============================================================================================================
// Pure core (selftested in idle-subscription.selftest.mts)
// ============================================================================================================

/** 12h expiry — matches the official notify_when_idle lifetime; a never-idle target drops the subscription. */
export const IDLE_SUB_TTL_SEC = 12 * 3600;

export interface IdleSub {
  id: string;
  subscriber: string; // who to notify (an inbox key)
  target: string; // whose idle/exit we watch (a session identity)
  createdSec: number;
  expireSec: number;
  fired: boolean; // one-shot: set once the notice is delivered
}

/** Create a subscription. `ttlSec` clamps to a positive finite value; default 12h. Pure. */
export function makeSub(id: string, subscriber: string, target: string, nowSec: number, ttlSec: number = IDLE_SUB_TTL_SEC): IdleSub {
  if (!id || !subscriber || !target) throw new Error("makeSub: id/subscriber/target required");
  const now = Math.floor(nowSec);
  const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : IDLE_SUB_TTL_SEC;
  return { id, subscriber, target, createdSec: now, expireSec: now + ttl, fired: false };
}

export function isExpired(sub: IdleSub, nowSec: number): boolean {
  return Number.isFinite(nowSec) ? nowSec >= sub.expireSec : false;
}

export interface TargetState {
  idle: boolean;
  exited: boolean;
}

/**
 * The one-shot fire decision: notify when the target is idle OR exited, AND the subscription has not already fired, AND
 * it is not expired. Fail-closed on a non-finite clock (don't fire). Pure — the IO caller flips `fired` on delivery. */
export function shouldFire(sub: IdleSub, state: TargetState, nowSec: number): boolean {
  if (sub.fired) return false;
  if (!Number.isFinite(nowSec)) return false;
  if (isExpired(sub, nowSec)) return false;
  return state.idle === true || state.exited === true;
}

/** Mark a subscription fired, returning a NEW record (coding-style: never mutate). Pure. */
export function markFired(sub: IdleSub): IdleSub {
  return { ...sub, fired: true };
}

/** Drop fired or expired subscriptions. Pure. */
export function pruneSubs(subs: readonly IdleSub[], nowSec: number): IdleSub[] {
  return subs.filter((s) => !s.fired && !isExpired(s, nowSec));
}

/** The set of distinct targets still being watched (live subscriptions only) — what the IO presence-watch must poll. Pure. */
export function watchedTargets(subs: readonly IdleSub[], nowSec: number): Set<string> {
  const out = new Set<string>();
  for (const s of subs) if (!s.fired && !isExpired(s, nowSec)) out.add(s.target);
  return out;
}

// ============================================================================================================
// IO shell — ledger + presence-watch + delivery (dormant: SWARM_IDLE_SUB off; exercised by live runs)
// ============================================================================================================

/** idle-subscription wiring flip, default OFF (dormant-ahead-of-use, like SWARM_VM_CTL / SWARM_PLACEMENT). */
export function idleSubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_IDLE_SUB ?? "");
}
