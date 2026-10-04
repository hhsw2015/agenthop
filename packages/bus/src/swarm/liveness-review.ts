/**
 * ReviewCut assembler (cluster-liveness L1 IO half — the sweep's/dispatcher's job per task-liveness-inv1.ts's header). The
 * INV-1 kernel assertLiveness(reviewCut, nowSec) is PURE and f32a0507's (437504c, 0/0); THIS module gathers the three
 * inputs it folds — a per-job ControlCut (the §1 six-state responsibility map over a consistent control-log slice) and the
 * heartbeat ObservationFacts (the independent observation plane). Roster / WORK-progress facts + modes + the assertLiveness
 * call + writing the verdict into projection meta + incident-episode management are the dispatcher wiring (L1b); kept out of
 * here so this stays pure + offline-testable. Per-job isolation mirrors the projection (review P1-2): the cut for one job is
 * built ONLY from that job's entities, never the global pool.
 */

import { liveEntities, type LogState } from "./control-log.js";
import type { TaskPlan } from "./task-plan.js";
import type { TaskAttempt } from "./task-state.js";
import type { AcceptedResult } from "./task-result.js";
import { buildSched } from "./task-pass.js";
import { jobStatus, readyTasks, type JobUsage } from "./task-ready.js";
import type { ControlCut, LivenessResponsibility, ObservationFact } from "./task-liveness-inv1.js";
import type { Heartbeat } from "./heartbeat.js";

/** Build the per-job ControlCut: jobTerminal + the §1 responsibility map, isolated to THIS job's entities. openIncidentEpisode
 *  is the IO layer's (passed in from persisted episode state), so a STALL verdict can carry a stable incidentId (C3). */
export function buildControlCut(
  plan: TaskPlan, state: LogState, nowSec: number,
  opts: { jobStartSec?: number; openIncidentEpisode?: number } = {},
): ControlCut {
  const jobId = plan.jobId;
  // Per-job isolation (attemptId convention `${jobId}/${nodeId}/a${n}` isolates intents/runs that lack a jobId field).
  const inJob = (attemptId: string): boolean => attemptId.startsWith(`${jobId}/`);
  const jobAttempts: TaskAttempt[] = [];
  const jobAccepted: AcceptedResult[] = [];
  const schedAll = buildSched(plan, state);
  for (const a of schedAll.attempts) if (a.jobId === jobId) jobAttempts.push(a);
  for (const r of schedAll.acceptedResults) if (r.jobId === jobId) jobAccepted.push(r);
  const sched = { plan, attempts: jobAttempts, acceptedResults: jobAccepted };

  const wallClockSec = opts.jobStartSec !== undefined ? Math.max(0, nowSec - opts.jobStartSec) : 0;
  const usage: JobUsage = { totalAttempts: jobAttempts.length, wallClockSec };
  const status = jobStatus({ ...sched, now: nowSec, jobUsage: usage });
  const jobTerminal = status.status === "succeeded" || status.status === "failed";

  const responsibilities: LivenessResponsibility[] = [];
  // R — ready nodes: a plan node ready to dispatch, witnessed by the dispatcher (pass) loop.
  for (const r of readyTasks({ ...sched, now: nowSec, jobUsage: usage })) responsibilities.push({ kind: "READY", subjectId: r.nodeId });
  // W — RETRY_WAIT backoff (a supervised wait, counts in W — legitimate backoff is NOT a stall, §1/R1).
  for (const a of jobAttempts) if (a.status === "RETRY_WAIT" && (a.retryAt === undefined || a.retryAt > nowSec)) responsibilities.push({ kind: "RETRY_WAIT_BACKOFF", subjectId: a.attemptId });

  // E (intents/binding) + W (validation runs + non-validation waits), from the live entities for this job.
  for (const body of Object.values(liveEntities(state))) {
    if (body.put === "intent") {
      const i = body.intent;
      if (!inJob(i.attemptId) || i.status === "abandoned") continue; // abandoned = terminal, holds nothing
      // confirmed = worker delivered + running (business exec, needs roster presence); pending = still allocating/recovering.
      if (i.status === "confirmed") responsibilities.push({ kind: "BUSINESS_EXEC", subjectId: i.attemptId, executorInstance: i.launchId });
      else responsibilities.push({ kind: "ALLOC_RECOVERING", subjectId: i.attemptId, executorInstance: i.launchId });
    } else if (body.put === "validationRun") {
      const v = body.validationRun;
      if (inJob(v.attemptId) && v.state !== "closed") responsibilities.push({ kind: "VALIDATION", subjectId: v.validationRunId });
    } else if (body.put === "wait") {
      const w = body.wait;
      // a validation-wait is covered by its VALIDATION run; here only the non-validation gates for THIS job.
      if (w.subject.jobId === jobId && w.state !== "resolved" && w.subject.validationRunId === undefined) responsibilities.push({ kind: "AWAITING_GATE", subjectId: w.waitId });
    }
  }

  return {
    jobId, seq: state.seq, jobTerminal, responsibilities,
    ...(opts.openIncidentEpisode !== undefined ? { openIncidentEpisode: opts.openIncidentEpisode } : {}),
  };
}

/** Heartbeat → ObservationFacts for the shared pass/sweep loops. The most recent sign of life is max(lastTickSec,
 *  inFlight.startedSec) — a loop mid-tick (a long but live action) is fresh via its inFlight start, a wedged one goes
 *  stale and the kernel returns UNVERIFIABLE (never false-OK). The window is sampledAtSec..sampledAtSec+validMs. instance
 *  is the loop's declared instance (the kernel matches observation identity+instance to the responsibility, C1). */
export function heartbeatObservations(hb: Heartbeat, validForSec: number): ObservationFact[] {
  const out: ObservationFact[] = [];
  const loop = (name: "pass" | "sweep", source: "pass-heartbeat" | "sweep-heartbeat") => {
    const b = hb[name];
    const sampledAtSec = Math.max(b.lastTickSec ?? 0, b.inFlight?.startedSec ?? 0);
    if (sampledAtSec <= 0) return; // never ticked — no observation (⇒ UNVERIFIABLE, not a false witness)
    out.push({ source, instance: hb.instance, sampledAtSec, validUntilSec: sampledAtSec + validForSec });
  };
  loop("pass", "pass-heartbeat");
  loop("sweep", "sweep-heartbeat");
  return out;
}
