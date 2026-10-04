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
 *  ② a missing/stale/FUTURE observation ⇒ UNVERIFIABLE listing what's missing — never guess (no evidence ≠ dead ≠
 *     alive; a roster-absent RUNNING is UNVERIFIABLE). Observations match by responsibility IDENTITY+instance (C1): a
 *     shared loop (pass/sweep) is scoped to the declared current instance, business WORK/roster to the executor — a
 *     missing anchor stays UNVERIFIABLE, never wildcards another record. A valid window is sampledAtSec<=nowSec<=validUntil (C2).
 *  ③ the SAME controlCut with DIFFERENT observations can yield a different verdict — health is an input, not a table
 *     lookup over the cut alone.
 *  ④ the STALL output separates a stable groupKey (affected subject + gap category — seq- AND episode-independent, so
 *     re-detecting the same ongoing stall yields the same fingerprint, a dedup no-op) from the full incidentId
 *     (groupKey + episode), built only when the IO layer supplies the episode it owns (C3). lastObservedSeq updates apart.
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

/** Admission declaration: a closed loop is not a promise, so a mode-off witness is a VERIFIED absence, not UNVERIFIABLE.
 *  passInstance/sweepInstance name the CURRENT dispatcher/sweep loop instance (C1): a shared-loop heartbeat witnesses
 *  only if it is from THAT instance — an arbitrary same-source record (a stale/other dispatcher's heartbeat) cannot
 *  stand in. Undefined while the mode is on ⇒ the current instance is undeclared ⇒ UNVERIFIABLE (never wildcard). */
export type Modes = { sweepOn: boolean; taskExecOn: boolean; passInstance?: string; sweepInstance?: string };

/** openIncidentEpisode (C3): the episode the IO layer is currently tracking for this group, if any. The pure function
 *  outputs a stable groupKey (fingerprint); only when an episode is supplied does it also build the full incidentId.
 *  Episode assignment/persistence (bump on recurrence after close) is the IO layer's job, not this function's. */
export type ControlCut = { jobId: string; seq: number; jobTerminal: boolean; responsibilities: LivenessResponsibility[]; openIncidentEpisode?: number };
export type ReviewCut = { controlCut: ControlCut; observations: ObservationFact[]; modes: Modes };

export type Coverage = { e: string[]; w: string[]; r: string[] };
export type LivenessVerdict =
  | { verdict: "OK"; coverage: Coverage }
  | { verdict: "UNVERIFIABLE"; missing: string[] }
  | { verdict: "STALL"; why: string; groupKey: string; incidentId?: string; lastObservedSeq: number };

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

  // C2: a valid observation window is sampledAtSec <= nowSec <= validUntilSec — a FUTURE sample proves nothing and an
  // expired one is stale; both are not-yet/not-anymore evidence, treated as unverifiable, never as health or death.
  const match = (src: ObservationSource, inst: string): ObservationFact | undefined =>
    observations.find((o) => o.source === src && o.instance === inst && o.sampledAtSec <= nowSec && nowSec <= o.validUntilSec);

  const coverage: Coverage = { e: [], w: [], r: [] };
  const missing: string[] = [];
  let anyVerified = false;

  for (const r of controlCut.responsibilities) {
    const t = TABLE[r.kind];
    // Mode off = a VERIFIED dead holder (we KNOW the loop isn't running) — not a witness, not unverifiable.
    if (!modes[t.mode]) continue;
    // C1: the witness observation must match the responsibility's identity+instance — never wildcard a missing anchor.
    // A shared loop (pass/sweep) is scoped to the declared current instance; business WORK/roster to the executor.
    const inst = t.obs === "pass-heartbeat" ? modes.passInstance : t.obs === "sweep-heartbeat" ? modes.sweepInstance : r.executorInstance;
    if (inst === undefined) { missing.push(`${t.obs} instance not declared (for ${r.kind} ${r.subjectId})`); continue; }
    if (!match(t.obs, inst)) { missing.push(`${t.obs}@${inst} missing/stale/future (for ${r.kind} ${r.subjectId})`); continue; }
    if (t.needsRoster) {
      if (r.executorInstance === undefined) { missing.push(`roster instance not set (for ${r.subjectId})`); continue; }
      if (!match("roster", r.executorInstance)) { missing.push(`roster@${r.executorInstance} missing/stale/future (for ${r.subjectId})`); continue; }
    }
    coverage[SET_KEY[t.set]].push(r.subjectId);
    anyVerified = true;
  }

  // One verified holder satisfies INV-1 (E∪W∪R ≠ ∅) -> OK, regardless of other unverifiable ones.
  if (anyVerified) return { verdict: "OK", coverage };
  // No verified holder, but something we cannot confirm -> don't convict; ask for the missing evidence.
  if (missing.length > 0) return { verdict: "UNVERIFIABLE", missing };
  // No verified holder and nothing unverifiable (no responsibilities, or all holders verified-dead) -> STALL.
  // C3: groupKey is the stable dedup fingerprint (subject + category), seq- AND episode-independent. The full incident
  // identity is groupKey + episode; episode is the IO layer's to assign/persist, so we only build incidentId when it is
  // supplied — otherwise we emit the fingerprint alone and never fold seq/now into it.
  const why = controlCut.responsibilities.length === 0
    ? "non-terminal job with no E/W/R responsibility at all"
    : "every responsibility holder is down (its loop mode is off)";
  const groupKey = `${controlCut.jobId}:no-live-holder`;
  return {
    verdict: "STALL",
    why,
    groupKey,
    ...(controlCut.openIncidentEpisode !== undefined ? { incidentId: `${groupKey}:episode-${controlCut.openIncidentEpisode}` } : {}),
    lastObservedSeq: controlCut.seq,
  };
}
