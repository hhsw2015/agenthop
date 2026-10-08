/**
 * resume-compact — decide whether to compact a member's history when resuming it (S14 absorb #6).
 *
 * Absorbed from the official sessions resume-from-summary (docs-sweep eval item #6): when a long-idle member is brought
 * back (swarm-resume / F36), optionally resume from a COMPACTED summary instead of the full transcript to save tokens.
 * Our swarm-resume already restores the roster; this adds the cheap gate for WHEN compaction is worth it.
 *
 * Fail-CLOSED bias: compaction is lossy, so an unusable MEASUREMENT (idleSec/tokens) ⇒ do NOT compact (keep the full
 * history). An unusable THRESHOLD (idleFloorSec/tokenFloor) is different: it falls back to the default floor — a bad
 * knob must not force-disable compaction. Both thresholds must be strictly exceeded — a long-but-small or large-but-
 * recent member resumes in full. Family-neutral (reads an idle duration and a token count, not a vendor event).
 *
 * Pure core below (selftested); wiring into swarm-resume is dormant (`SWARM_RESUME_COMPACT` off).
 */

// ============================================================================================================
// Pure core (selftested in resume-compact.selftest.mts)
// ============================================================================================================

export const RESUME_IDLE_SEC = 3600; // inactive longer than 1h …
export const RESUME_TOKEN_FLOOR = 100_000; // … AND heavier than 100k tokens ⇒ compaction pays off

/**
 * Should a resuming member be compacted first? True only when BOTH the member has been idle past `idleFloorSec` AND its
 * transcript exceeds `tokenFloor` (strictly greater on both). A non-finite MEASUREMENT (idleSec/tokens) ⇒ false
 * (fail-closed: never compact — i.e. never drop history — on an unusable measurement). A non-finite THRESHOLD
 * (idleFloorSec/tokenFloor) ⇒ fall back to the default floor (a bad knob must not disable compaction). Pure. */
export function shouldResumeCompact(opts: { idleSec: number; tokens: number; idleFloorSec?: number; tokenFloor?: number }): boolean {
  const idleFloor = Number.isFinite(opts.idleFloorSec as number) && (opts.idleFloorSec as number) >= 0 ? (opts.idleFloorSec as number) : RESUME_IDLE_SEC;
  const tokenFloor = Number.isFinite(opts.tokenFloor as number) && (opts.tokenFloor as number) >= 0 ? (opts.tokenFloor as number) : RESUME_TOKEN_FLOOR;
  if (!Number.isFinite(opts.idleSec) || !Number.isFinite(opts.tokens)) return false; // fail-closed: keep full history
  return opts.idleSec > idleFloor && opts.tokens > tokenFloor;
}

// ============================================================================================================
// IO shell — wiring into swarm-resume (dormant: SWARM_RESUME_COMPACT off; exercised by live runs)
// ============================================================================================================

/** resume-compact wiring flip, default OFF (dormant-ahead-of-use). */
export function resumeCompactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_RESUME_COMPACT ?? "");
}
