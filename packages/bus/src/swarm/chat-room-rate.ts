/**
 * Per-sender room rate limit (S14 chat-entry throttle). A high-frequency chat flood would hammer the roster's durable inboxes
 * (and, via a room, the coordinator), so a post into a room is throttled per (room, sender) with a SLIDING window (per-hit
 * timestamps pruned to the last `windowMs`), rejecting over-send. Normal conversation, INCLUDING the human, is never the target: 30 posts/min/sender is
 * generous; the cap only bites a storm. A rejected post is NOT silently dropped — postToRoom returns a throttled result and
 * writes ONE throttled receipt to the sender (the "undelivered, never silent" rule).
 *
 * Deterministic given the injected `nowMs`, so it unit-tests without a real clock. Held in-memory by the single owner process
 * (same lifetime/scope as PostCounter in a relay); v1 does not persist the window across a restart (a restart resets the cap —
 * acceptable: the flood protection is per live owner, and a restart is not a flood).
 */
export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number; notify: boolean };
export type RateOpts = { limit?: number; windowMs?: number };

export function rateKey(roomId: string, from: string): string { return `${roomId}\u0000${from}`; }

export class RoomRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();     // key -> admitted timestamps still inside the window
  private readonly notifiedAt = new Map<string, number>(); // key -> last throttled-receipt time (one receipt per window)

  constructor(opts: RateOpts = {}) {
    this.limit = opts.limit ?? 30;          // posts per window per (room, sender) — tunable
    this.windowMs = opts.windowMs ?? 60_000; // 1 minute
    // CR-R2-P2-2: reject an invalid config LOUDLY — never return a NaN retryAfterMs, never silently disable the cap.
    if (!Number.isInteger(this.limit) || this.limit < 1) throw new Error(`RoomRateLimiter: limit must be a positive integer (got ${String(opts.limit)})`);
    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) throw new Error(`RoomRateLimiter: windowMs must be a positive finite number (got ${String(opts.windowMs)})`);
  }

  /**
   * Record an attempt at `nowMs`. ok ⇒ admitted (counted). !ok ⇒ over the window limit: `retryAfterMs` = until the oldest hit
   * in the sliding window ages out; `notify` ⇒ a throttled receipt is DUE (not yet sent this window). The slot is NOT consumed
   * here (CR-R2-P2-1) — the caller calls markNotified() only AFTER it actually delivers the receipt, so a failed write can be
   * retried on a later denial and a storm still yields at most one receipt per window.
   */
  admit(key: string, nowMs: number): RateDecision {
    const cutoff = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length < this.limit) {
      recent.push(nowMs);
      this.hits.set(key, recent);
      return { ok: true };
    }
    this.hits.set(key, recent); // persist the pruned window even on denial (bounds memory)
    const retryAfterMs = Math.max(0, recent[0]! + this.windowMs - nowMs);
    const last = this.notifiedAt.get(key);
    const notify = last === undefined || last <= cutoff; // a receipt is due if none delivered within the current window
    return { ok: false, retryAfterMs, notify };
  }

  /** Record a throttled receipt as DELIVERED for this window (CR-R2-P2-1). Called by the caller ONLY after a successful write,
   *  so a failed receipt never consumes the once-per-window slot. */
  markNotified(key: string, nowMs: number): void { this.notifiedAt.set(key, nowMs); }
}
