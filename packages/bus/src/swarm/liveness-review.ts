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
import { jobStatus, readyTasks, currentAccepted, type JobUsage } from "./task-ready.js";
import type { ControlCut, LivenessResponsibility, ObservationFact } from "./task-liveness-inv1.js";
import { isRepairWaitId } from "./repair-wait-id.js";
import type { Heartbeat } from "./heartbeat.js";

/** An attempt is terminal (holds no current execution carrier) once SUCCEEDED/FAILED/ABANDONED. */
const TERMINAL_ATTEMPT: ReadonlySet<TaskAttempt["status"]> = new Set(["SUCCEEDED", "FAILED", "ABANDONED"]);

/** The authoritative current plan for a job = the live PlanPut in THIS LogState — never a stale startup/SWARM_PLAN copy
 *  (review P1-2). A consistent §1c cut must read the plan from the same control slice as the attempts/intents it judges. */
export function currentPlan(state: LogState, jobId: string): TaskPlan | undefined {
  for (const body of Object.values(liveEntities(state))) {
    if (body.put === "plan" && (body.plan as unknown as TaskPlan).jobId === jobId) return body.plan as unknown as TaskPlan;
  }
  return undefined;
}

/** Build the per-job ControlCut: jobTerminal + the §1 responsibility map, isolated to THIS job's entities. The plan is
 *  resolved from `state` (NOT passed in) so the cut is a consistent control slice (review P1-2) — returns null when the job
 *  has no authoritative PlanPut in this state, so the caller emits UNVERIFIABLE instead of judging off a stale plan.
 *  openIncidentEpisode is the IO layer's (passed in from persisted episode state) for a stable STALL incidentId (C3). */
export function buildControlCut(
  jobId: string, state: LogState, nowSec: number,
  opts: { jobStartSec?: number; openIncidentEpisode?: number } = {},
): ControlCut | null {
  const plan = currentPlan(state, jobId);
  if (plan === undefined) return null; // no authoritative plan in this cut ⇒ caller emits UNVERIFIABLE (don't guess, P1-2)
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

  // Live (non-abandoned) intents GROUPED by attempt, each keeping its bindingId — a DispatchIntent governs a SPECIFIC binding,
  // not the whole attempt (review 59e7328-P1) — + the W responsibilities (validation runs, non-validation gates), one pass.
  const liveIntents = new Map<string, Array<{ bindingId: string; launchId: string; status: string }>>();
  for (const body of Object.values(liveEntities(state))) {
    if (body.put === "intent") {
      const i = body.intent;
      if (inJob(i.attemptId) && i.status !== "abandoned") {
        const arr = liveIntents.get(i.attemptId) ?? [];
        arr.push({ bindingId: i.bindingId, launchId: i.launchId, status: i.status });
        liveIntents.set(i.attemptId, arr);
      }
    } else if (body.put === "validationRun") {
      const v = body.validationRun;
      if (inJob(v.attemptId) && v.state !== "closed") responsibilities.push({ kind: "VALIDATION", subjectId: v.validationRunId });
    } else if (body.put === "wait") {
      const w = body.wait;
      // a validation-wait is covered by its VALIDATION run; here only the non-validation gates for THIS job. A repair-wait is
      // EXCLUDED (review P1-1): it is the incident's own repair obligation, not a business holder — counting it would let the
      // repair-wait opened FOR a stall satisfy INV-1 and self-certify the stall's recovery. (Prefix marker ⇒ restart-safe.)
      if (w.subject.jobId === jobId && w.state !== "resolved" && w.subject.validationRunId === undefined && !isRepairWaitId(w.waitId)) responsibilities.push({ kind: "AWAITING_GATE", subjectId: w.waitId });
    }
  }

  // E — executing work, derived from the CURRENT non-terminal attempt + its OPEN execution binding (the §1 durable carriers:
  // ALLOC_RECOVERING = DispatchIntent/binding(open); BUSINESS_EXEC = binding(open)+WORK). NOT raw historical intents (review
  // P1-1): a done/terminal node's stale pending intent is not current work, and an open business binding with NO intent is
  // still executing (the binding is the carrier). The GOVERNING intent for an open binding is the one targeting THAT binding
  // (matched by bindingId) — a superseded prior binding's stale intent must not leak onto a successor open binding (review
  // 59e7328-P1); with no open binding, the attempt's live allocation intent governs. A confirmed governing intent or a bare
  // open binding ⇒ BUSINESS_EXEC; a still-pending intent ⇒ ALLOC_RECOVERING. Roster/WORK absent ⇒ the kernel is UNVERIFIABLE.
  for (const a of jobAttempts) {
    if (TERMINAL_ATTEMPT.has(a.status) || a.status === "RETRY_WAIT") continue;   // terminal holds no carrier; RETRY_WAIT is W
    if (currentAccepted(a.nodeId, sched) !== null) continue;                     // node already accepted ⇒ not current work
    const openBinding = a.executionBindings.find((b) => b.closedAtSeq === undefined);
    const intents = liveIntents.get(a.attemptId) ?? [];
    const governing = openBinding !== undefined
      ? intents.find((i) => i.bindingId === openBinding.bindingId)               // ONLY the intent for the open binding (P1)
      : (intents.find((i) => i.status !== "confirmed") ?? intents[0]);          // no binding yet ⇒ the live allocation intent
    if (openBinding === undefined && governing === undefined) continue;          // no durable carrier ⇒ not an E responsibility
    const executorInstance = governing?.launchId ?? openBinding?.launchId;
    const kind = governing === undefined || governing.status === "confirmed" ? "BUSINESS_EXEC" : "ALLOC_RECOVERING";
    responsibilities.push({ kind, subjectId: a.attemptId, ...(executorInstance !== undefined ? { executorInstance } : {}) });
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
