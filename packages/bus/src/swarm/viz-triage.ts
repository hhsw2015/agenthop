/**
 * viz-triage — needs-input-first ordering + a cheap per-member activity line (S14 absorb #2).
 *
 * Absorbed from the official agent-view: (a) group/order members so the ones NEEDING THE USER sit at the top (triage
 * ordering — directly serves the "user one screen" goal / T5-2 / the console), and (b) a cheap one-line activity
 * summary written by a Haiku-class model from a member's recent output, refreshed at most every ~15s and WITHOUT
 * spending a model request on every tick. Lands on the swarm-viz projection + status-digest planes; family-neutral.
 *
 * Pure core below (selftested): the triage sort + the re-summarize throttle + the summary-request builder. IO (reading
 * member rows from the projection, calling the small model, writing the line back) is dormant (`SWARM_VIZ_TRIAGE` off).
 */

// ============================================================================================================
// Pure core (selftested in viz-triage.selftest.mts)
// ============================================================================================================

export type MemberState = "needs-input" | "working" | "idle" | "completed" | "failed";

/** Triage order: the user's attention goes to NEEDS-INPUT first, then active work, then quiet, then terminal. */
export const TRIAGE_ORDER: readonly MemberState[] = ["needs-input", "working", "idle", "completed", "failed"];

export function triageRank(s: MemberState): number {
  const i = TRIAGE_ORDER.indexOf(s);
  return i === -1 ? TRIAGE_ORDER.length : i; // unknown states sort last
}

export interface MemberRow {
  id: string;
  state: MemberState;
}

/** Stable sort by triage rank (needs-input first). Pure — returns a NEW array, input untouched. */
export function sortForTriage<T extends MemberRow>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => triageRank(a.r.state) - triageRank(b.r.state) || a.i - b.i)
    .map((x) => x.r);
}

/** Cheapest refresh cadence: re-summarize a member at most once per interval (default 15s), so the per-member line does
 *  not spend a model request every tick. Pure. */
export const SUMMARY_MIN_INTERVAL_SEC = 15;
export function shouldResummarize(lastSummarySec: number | null, nowSec: number, intervalSec: number = SUMMARY_MIN_INTERVAL_SEC): boolean {
  if (!Number.isFinite(nowSec)) return false;
  if (lastSummarySec == null || !Number.isFinite(lastSummarySec)) return true; // never summarized yet
  return nowSec - lastSummarySec >= intervalSec;
}

export interface SummaryRequest {
  system: string;
  user: string;
  tier: "light"; // a Haiku-class / light model — the line is cheap by construction
}

/** Build the one-line activity-summary request from a member's recent output (truncated). Pure (prompt builder; the
 *  model call is the IO caller's job, gated by shouldResummarize). */
export function buildSummaryRequest(recentOutput: string, maxChars: number = 2000): SummaryRequest {
  const clipped = (recentOutput ?? "").slice(-Math.max(0, Math.floor(maxChars)));
  return {
    system: "Summarize this agent's current activity in ONE short line (<=12 words). State what it is doing now; no preamble.",
    user: clipped,
    tier: "light",
  };
}

// ============================================================================================================
// IO shell — projection read + model call + write-back (dormant: SWARM_VIZ_TRIAGE off; exercised by live runs)
// ============================================================================================================

/** viz-triage wiring flip, default OFF (dormant-ahead-of-use). */
export function vizTriageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_VIZ_TRIAGE ?? "");
}
