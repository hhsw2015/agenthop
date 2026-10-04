/**
 * INV-1 non-emptiness checker (cluster-liveness design §1) — PURE decision, like acceptance.ts/tipToEvent. The stall
 * theorem's executable form: while a job is non-terminal, E ∪ W ∪ R ≠ ∅ — some binding is executing (E), some wait is
 * armed (W), or some node is ready with a live dispatcher (R). This module decides that over an ALREADY-GATHERED
 * consistent slice + an independent observation plane + a mode declaration; all IO (sampling heartbeats/roster/WORK
 * progress, building the cut) is the sweep's (20cab0a5), injected here as plain facts. Output is three-valued:
 *   OK | UNVERIFIABLE{missing} | STALL{why, incidentKey, lastObservedSeq}.
 *
 * Semantics the reviewer's countermodels attack (each pinned by a test):
 *  ① legitimate backoff (a RETRY_WAIT whose retryAt isn't due) is a SUPERVISED wait — it counts in W, never STALL.
 *  ② a missing/stale observation ⇒ UNVERIFIABLE listing what's missing — never guess (no evidence ≠ dead ≠ alive;
 *     "a roster-absent RUNNING" is UNVERIFIABLE, not STALL and not healthy).
 *  ③ the SAME controlCut with DIFFERENT observations can yield a different verdict — health is an input, not a table
 *     lookup over the cut alone.
 *  ④ incidentKey is STABLE: (affected subject + gap category), independent of seq, so re-detecting the same ongoing
 *     stall yields the same key (dedup no-op — writing the incident must not change next-dedup). lastObservedSeq updates
 *     separately, it is NOT part of the key.
 *  ⑤ coverage ≠ progress: OK only proves responsibility HAS a live holder; business progress is each loop's own
 *     evidence, reported separately — the OK verdict carries a `coverage` breakdown, never a progress claim.
 */

export type WitnessSet = "E" | "W" | "R";
export type ResponsibilityKind = "READY" | "RETRY_WAIT_BACKOFF" | "ALLOC_RECOVERING" | "BUSINESS_EXEC" | "VALIDATION" | "AWAITING_GATE";

/** A non-terminal responsibility extracted from the cut by the caller, tagged with its six-state kind. */
export type LivenessResponsibility = { kind: ResponsibilityKind; subjectId: string; executorInstance?: string };

export type ObservationSource = "pass-heartbeat" | "sweep-heartbeat" | "roster" | "work-progress";
/** An independent observation (ring-split heartbeat / roster snapshot / WORK progress sample) with its own validity
 *  window — fresh iff nowSec <= validUntilSec. `instance` scopes roster/per-executor facts. */
export type ObservationFact = { source: ObservationSource; instance?: string; sampledAtSec: number; validUntilSec: number };

/** Admission declaration: a closed loop is not a promise, so a mode-off witness is a VERIFIED absence, not UNVERIFIABLE. */
export type Modes = { sweepOn: boolean; taskExecOn: boolean };

export type ControlCut = { jobId: string; seq: number; jobTerminal: boolean; responsibilities: LivenessResponsibility[] };
export type ReviewCut = { controlCut: ControlCut; observations: ObservationFact[]; modes: Modes };

export type Coverage = { e: string[]; w: string[]; r: string[] };
export type LivenessVerdict =
  | { verdict: "OK"; coverage: Coverage }
  | { verdict: "UNVERIFIABLE"; missing: string[] }
  | { verdict: "STALL"; why: string; incidentKey: string; lastObservedSeq: number };

// The §1 responsibility coverage table: each non-terminal state -> which loop witnesses it (mode + heartbeat), which
// non-emptiness set it joins, and whether it additionally needs a roster presence (executor actually there).
const TABLE: Record<ResponsibilityKind, { mode: keyof Modes; obs: ObservationSource; set: WitnessSet; needsRoster?: boolean }> = {
  READY: { mode: "taskExecOn", obs: "pass-heartbeat", set: "R" },
  RETRY_WAIT_BACKOFF: { mode: "sweepOn", obs: "sweep-heartbeat", set: "W" },
  ALLOC_RECOVERING: { mode: "taskExecOn", obs: "pass-heartbeat", set: "E" },
  BUSINESS_EXEC: { mode: "taskExecOn", obs: "work-progress", set: "E", needsRoster: true },
  VALIDATION: { mode: "sweepOn", obs: "sweep-heartbeat", set: "W" },
  AWAITING_GATE: { mode: "sweepOn", obs: "sweep-heartbeat", set: "W" },
};
const SET_KEY: Record<WitnessSet, keyof Coverage> = { E: "e", W: "w", R: "r" };

export function assertLiveness(cut: ReviewCut, nowSec: number): LivenessVerdict {
  const { controlCut, observations, modes } = cut;
  // INV-1 only binds a non-terminal job; a finished job needs no holder.
  if (controlCut.jobTerminal) return { verdict: "OK", coverage: { e: [], w: [], r: [] } };

  const has = (src: ObservationSource, inst: string | undefined, requireFresh: boolean): boolean =>
    observations.some((o) => o.source === src && (inst === undefined || o.instance === inst) && (!requireFresh || nowSec <= o.validUntilSec));

  const coverage: Coverage = { e: [], w: [], r: [] };
  const missing: string[] = [];
  let anyVerified = false;

  for (const r of controlCut.responsibilities) {
    const t = TABLE[r.kind];
    // Mode off = a VERIFIED dead holder (we KNOW the loop isn't running) — not a witness, not unverifiable.
    if (!modes[t.mode]) continue;
    // The loop's heartbeat must be present AND fresh, else we cannot confirm it is alive -> UNVERIFIABLE.
    if (!has(t.obs, undefined, false)) { missing.push(`${t.obs} (for ${r.kind} ${r.subjectId})`); continue; }
    if (!has(t.obs, undefined, true)) { missing.push(`stale ${t.obs} (for ${r.kind} ${r.subjectId})`); continue; }
    if (t.needsRoster) {
      if (!has("roster", r.executorInstance, false)) { missing.push(`roster@${r.executorInstance ?? "?"} (for ${r.subjectId})`); continue; }
      if (!has("roster", r.executorInstance, true)) { missing.push(`stale roster@${r.executorInstance ?? "?"} (for ${r.subjectId})`); continue; }
    }
    coverage[SET_KEY[t.set]].push(r.subjectId);
    anyVerified = true;
  }

  // One verified holder satisfies INV-1 (E∪W∪R ≠ ∅) -> OK, regardless of other unverifiable ones.
  if (anyVerified) return { verdict: "OK", coverage };
  // No verified holder, but something we cannot confirm -> don't convict; ask for the missing evidence.
  if (missing.length > 0) return { verdict: "UNVERIFIABLE", missing };
  // No verified holder and nothing unverifiable (no responsibilities, or all holders verified-dead) -> STALL.
  const why = controlCut.responsibilities.length === 0
    ? "non-terminal job with no E/W/R responsibility at all"
    : "every responsibility holder is down (its loop mode is off)";
  return { verdict: "STALL", why, incidentKey: `${controlCut.jobId}:no-live-holder`, lastObservedSeq: controlCut.seq };
}
