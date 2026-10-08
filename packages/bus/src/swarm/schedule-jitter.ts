/**
 * schedule-jitter — deterministic per-id jitter so a fleet of dispatchers/loops doesn't hit the API at the same
 * wall-clock instant (S14 absorb #4).
 *
 * Absorbed from the official scheduled-tasks jitter: a recurring task's fire time gets a deterministic offset derived
 * from its id (same id → same offset), capped at a fraction of the period (and an absolute cap). Our dispatcher/sweep
 * ticks fire on fixed intervals across machines; adding this offset spreads them. Pure; the caller adds the offset to
 * its next-fire time. Family/transport-neutral (just arithmetic on an id string).
 */

// ============================================================================================================
// Pure core (selftested in schedule-jitter.selftest.mts)
// ============================================================================================================

/** FNV-1a → a stable fraction in [0,1) from a string. Deterministic, dependency-free. Pure. */
export function hashFraction(id: string): number {
  let h = 0x811c9dc5;
  const s = id ?? "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000; // [0,1)
}

export const JITTER_MAX_FRACTION = 0.1; // up to 10% of the period
export const JITTER_ABS_CAP_SEC = 1800; // never more than 30 min (matches the official ceiling)

/**
 * Deterministic jitter offset in seconds for `id`, in `[0, min(periodSec*maxFraction, capSec)]`. Same id ⇒ same offset
 * (so a task's cadence stays stable); different ids spread across the window. Non-finite/≤0 period ⇒ 0. Pure. */
export function scheduleJitterSec(id: string, periodSec: number, maxFraction: number = JITTER_MAX_FRACTION, capSec: number = JITTER_ABS_CAP_SEC): number {
  if (!Number.isFinite(periodSec) || periodSec <= 0) return 0;
  const frac = Number.isFinite(maxFraction) && maxFraction > 0 ? maxFraction : JITTER_MAX_FRACTION;
  const cap = Number.isFinite(capSec) && capSec > 0 ? capSec : JITTER_ABS_CAP_SEC;
  const span = Math.min(periodSec * frac, cap);
  return Math.floor(hashFraction(id) * span);
}

// ============================================================================================================
// IO shell — dormant flag (the caller adds the offset to its fire schedule when enabled)
// ============================================================================================================

/** schedule-jitter wiring flip, default OFF (dormant-ahead-of-use). */
export function scheduleJitterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_SCHEDULE_JITTER ?? "");
}
