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
 * Taking the min of the two remaining estimates means neither a suspend (monotonic under-count) nor a wall
 * rollback (wall over-count) can make us believe we have more time than we do. CLOCK_BOOTTIME would fold both into
 * one source; prefer it IF verified on the target VM, but this min-of-two is correct without it.
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
 * due). Whichever clock reports less time wins, so suspend (monotonic stalls) and wall rollback (wall stalls) are
 * both covered.
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
