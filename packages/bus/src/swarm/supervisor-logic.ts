/**
 * Box-side supervisor timing logic (pure). Codex pass-2 P1-2 killed the `sleep N; elapsed += N` accumulator
 * (it under-counts scheduling/IO/suspend — probed 0.05s vs 0.282s real, so it judged a passed deadline as not
 * passed). The deadline is safety-critical: UNDER-counting means we scrub/hand off too late and lose the box.
 *
 * Resolution without assuming a specific clock is available on the box: track BOTH clocks and take whichever says
 * LESS time remains (conservative = fire earlier, which is always safe for a deadline):
 *   - a MONOTONIC source (node process.hrtime.bigint() within the single long-lived supervisor process — immune to
 *     wall-clock steps/rollback; on Linux this is CLOCK_MONOTONIC, which does NOT advance during VM suspend), and
 *   - the WALL clock vs an absolute deadline (Date.now()); wall DOES advance across a suspend, so it catches the
 *     case the monotonic clock misses, and the monotonic clock catches a backward wall step that would otherwise
 *     extend the box's life.
 * Taking the min of the two remaining estimates covers a suspend (monotonic stalls -> wall catches it) OR a wall
 * rollback (wall stalls -> monotonic catches it) INDIVIDUALLY. It is NOT safe against BOTH at once: a VM suspend
 * during which the wall clock also steps backward can still over-report remaining time (Codex P3-1). This helper is
 * therefore best-effort; the dispatcher's authoritative OFF-box clock is the real deadline backstop. CLOCK_BOOTTIME
 * would fold both into one monotonic-across-suspend source; prefer it IF verified on the target VM.
 */

export type RemainingInput = {
  /** Lifetime budget in seconds (remaining at injection: alloc-request-start + budget - prep/transfer). */
  budgetSec: number;
  /** Monotonic seconds elapsed since the supervisor recorded its start (hrtime-based; never resets, never steps). */
  monotonicElapsedSec: number;
  /** Current wall-clock seconds (Date.now()/1000). */
  wallNowSec: number;
  /** Absolute wall-clock deadline seconds, bound to THIS incarnation (persisted; reuse must not extend it). */
  wallDeadlineSec: number;
};

/**
 * Conservative remaining seconds = min(budget - monotonicElapsed, wallDeadline - wallNow). Can go negative (past
 * due). Whichever clock reports less time wins, covering a suspend OR a wall rollback individually — but NOT both at
 * once (best-effort; the dispatcher's authoritative time is the backstop). See the header note (Codex P3-1).
 */
export function conservativeRemainingSec(i: RemainingInput): number {
  const byMonotonic = i.budgetSec - i.monotonicElapsedSec;
  const byWall = i.wallDeadlineSec - i.wallNowSec;
  return Math.min(byMonotonic, byWall);
}

/** Past the deadline by EITHER clock -> time to scrub (conservative). */
export function pastDeadline(i: RemainingInput): boolean {
  return conservativeRemainingSec(i) <= 0;
}
