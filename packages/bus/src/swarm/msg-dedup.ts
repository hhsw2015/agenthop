/**
 * msg-dedup — drop identical message repeats within a window + queue-cap self-stop (S14 absorb #5).
 *
 * Absorbed from the official cross-session-messaging loop-throttle: a message ring de-duplicates identical content
 * (same sender + same text seen again inside a short window is dropped) and a queue that reaches its cap STOPS the ring
 * rather than growing unbounded. This hardens our durable inbox against a peer (or a looping dispatcher) that re-sends
 * the same line: the ring absorbs the repeat instead of waking a member for each copy.
 *
 * Fail-SAFE bias (not fail-closed): when the clock is unusable we never DROP a message as a duplicate — silently losing
 * a line is the one thing this project won't do (CLAUDE.md: 送不出去的话要留痕/静默丢话最不能退). So a bad clock ⇒ deliver.
 * The queue cap is the opposite kind of guard (a protective upper bound) and fires on a full queue regardless.
 *
 * Pure core below (selftested); wiring into the durable inbox is dormant (`SWARM_MSG_DEDUP` off).
 */

// ============================================================================================================
// Pure core (selftested in msg-dedup.selftest.mts)
// ============================================================================================================

export const DEDUP_WINDOW_SEC = 60; // a repeat of the same line inside this window is a duplicate
export const RING_QUEUE_CAP = 50; // queue at/over this ⇒ stop the ring (matches the official ≤50 self-stop)

/** FNV-1a over `sender\0text` → stable 8-hex fingerprint. Same (sender,text) ⇒ same fp. Pure, dependency-free. */
export function msgFingerprint(sender: string, text: string): string {
  let h = 0x811c9dc5;
  const s = (sender ?? "") + "\u0000" + (text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** fingerprint → last-seen epoch seconds. Immutable; treat as read-only. */
export type SeenMap = Readonly<Record<string, number>>;

/** Drop fingerprints older than the window. Bad clock ⇒ unchanged (can't age anything safely). Pure. */
export function pruneSeen(seen: SeenMap, nowSec: number, windowSec: number = DEDUP_WINDOW_SEC): SeenMap {
  if (!Number.isFinite(nowSec)) return seen;
  const out: Record<string, number> = {};
  for (const [fp, ts] of Object.entries(seen)) if (Number.isFinite(ts) && nowSec - ts < windowSec) out[fp] = ts;
  return out;
}

/** Has this fingerprint been seen inside the window? Bad clock ⇒ false (never drop on an unusable clock). Pure. */
export function isDuplicate(seen: SeenMap, fp: string, nowSec: number, windowSec: number = DEDUP_WINDOW_SEC): boolean {
  if (!Number.isFinite(nowSec)) return false; // fail-safe: unsure ⇒ not a duplicate ⇒ deliver
  const ts = seen[fp];
  return ts !== undefined && Number.isFinite(ts) && nowSec - ts < windowSec;
}

/** Record a fingerprint as just-seen, pruning expired entries. Returns a NEW map; input untouched. Bad clock ⇒ prune only. Pure. */
export function recordSeen(seen: SeenMap, fp: string, nowSec: number, windowSec: number = DEDUP_WINDOW_SEC): SeenMap {
  const pruned = pruneSeen(seen, nowSec, windowSec);
  if (!Number.isFinite(nowSec)) return pruned;
  return { ...pruned, [fp]: nowSec };
}

export type RingResult = "deliver" | "drop-duplicate" | "stop-ring";

/**
 * Decide an incoming ring message's fate and return the next seen-map.
 *  - queue at/over cap ⇒ stop-ring (protective bound; seen unchanged).
 *  - else fingerprint seen inside the window ⇒ drop-duplicate (seen unchanged).
 *  - else ⇒ deliver (fingerprint recorded in the returned seen-map).
 * Pure. */
export function ringAdmit(opts: { queueLen: number; seen: SeenMap; fp: string; nowSec: number; windowSec?: number; cap?: number }): { action: RingResult; seen: SeenMap } {
  const windowSec = Number.isFinite(opts.windowSec as number) && (opts.windowSec as number) > 0 ? (opts.windowSec as number) : DEDUP_WINDOW_SEC;
  const cap = Number.isFinite(opts.cap as number) && (opts.cap as number) > 0 ? (opts.cap as number) : RING_QUEUE_CAP;
  if (Number.isFinite(opts.queueLen) && opts.queueLen >= cap) return { action: "stop-ring", seen: opts.seen };
  if (isDuplicate(opts.seen, opts.fp, opts.nowSec, windowSec)) return { action: "drop-duplicate", seen: opts.seen };
  return { action: "deliver", seen: recordSeen(opts.seen, opts.fp, opts.nowSec, windowSec) };
}

// ============================================================================================================
// IO shell — wiring into the durable inbox ring (dormant: SWARM_MSG_DEDUP off; exercised by live runs)
// ============================================================================================================

/** msg-dedup wiring flip, default OFF (dormant-ahead-of-use). */
export function msgDedupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_MSG_DEDUP ?? "");
}
