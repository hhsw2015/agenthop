import { describe, expect, test } from "vitest";
import { commit, entityKeyOf, initialLogState, type ChangeBody, type LogState } from "../src/swarm/control-log.js";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import type { TaskAttempt } from "../src/swarm/task-state.js";
import { buildControlCut, heartbeatObservations } from "../src/swarm/liveness-review.js";
import { assertLiveness } from "../src/swarm/task-liveness-inv1.js";
import type { Heartbeat } from "../src/swarm/heartbeat.js";

/** L1a reviewCut assembler (cluster-liveness §1): control-log → ControlCut (six-state responsibility map, per-job) +
 *  heartbeat → ObservationFacts, folded by the pure INV-1 kernel assertLiveness into OK / UNVERIFIABLE / STALL. */

function planOf(jobId: string, nodeId: string): TaskPlan {
  const r = loadPlan({ jobId, planRevision: 1, nodes: [{ nodeId, kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }], jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 3600 } });
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}
function stamp(state: LogState, bodies: ChangeBody[]): LogState {
  const changes = bodies.map((b) => { const k = entityKeyOf(b); const rev = state.revisions[k] ?? 0; return { ...b, operationId: `${k}#${rev + 1}`, expectedEntityRevision: rev }; });
  return commit(state, state.seq, changes).state;
}
const attempt = (over: Partial<TaskAttempt>): TaskAttempt => ({ attemptId: "job-x/build/a1", jobId: "job-x", planRevision: 1, nodeId: "build", status: "RUNNING", inputBindings: [], inputBindingDigest: "d", specDigest: "s", executionBindings: [], retriesUsed: 0, createdAtSeq: 1, ...over });
const intentBody = (over: Record<string, unknown> = {}): ChangeBody => ({ put: "intent", intent: { intentId: "rw1@build", attemptId: "job-x/build/a1", nodeId: "build", launchId: "rw1", bindingId: "job-x/build/a1/b0", assignmentDigest: "d", allocRequestStartSec: 100, workDeadlineSec: 3580, allocOutcome: "created", status: "pending", ...over } } as unknown as ChangeBody);
const kinds = (c: NonNullable<ReturnType<typeof buildControlCut>>): string[] => c.responsibilities.map((r) => r.kind).sort();

describe("buildControlCut — §1 six-state responsibility map", () => {
  test("a ready node (no attempt) ⇒ READY; job non-terminal", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    const cut = buildControlCut("job-x", s, 1000)!;
    expect(cut.jobTerminal).toBe(false);
    expect(cut.responsibilities).toEqual([{ kind: "READY", subjectId: "build" }]);
  });

  test("a PENDING intent ⇒ ALLOC_RECOVERING; a CONFIRMED intent ⇒ BUSINESS_EXEC (executorInstance=launchId)", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ specDigest: p.nodes[0]!.specDigest }) }]);
    s = stamp(s, [intentBody({ status: "pending" })]);
    expect(buildControlCut("job-x", s, 1000)!.responsibilities).toContainEqual({ kind: "ALLOC_RECOVERING", subjectId: "job-x/build/a1", executorInstance: "rw1" });
    let s2 = initialLogState(); s2 = stamp(s2, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s2 = stamp(s2, [{ put: "attempt", attempt: attempt({ specDigest: p.nodes[0]!.specDigest }) }]);
    s2 = stamp(s2, [intentBody({ status: "confirmed" })]);
    expect(buildControlCut("job-x", s2, 1000)!.responsibilities).toContainEqual({ kind: "BUSINESS_EXEC", subjectId: "job-x/build/a1", executorInstance: "rw1" });
  });

  test("an abandoned intent holds nothing (E empty); a RETRY_WAIT (backoff not due) ⇒ RETRY_WAIT_BACKOFF", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ status: "RETRY_WAIT", retryAt: 5000, specDigest: p.nodes[0]!.specDigest }) }]);
    s = stamp(s, [intentBody({ status: "abandoned" })]);
    expect(kinds(buildControlCut("job-x", s, 1000)!)).toEqual(["RETRY_WAIT_BACKOFF"]); // abandoned intent excluded
  });

  test("a running ValidationRun ⇒ VALIDATION; a non-validation wait ⇒ AWAITING_GATE; a validation-wait is NOT double-counted", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "validationRun", validationRun: { validationRunId: "vr1", attemptId: "job-x/build/a1", candidateRef: { observedResultId: "o", observedWorkCommit: "c", resultClosureDigest: "cd" }, generation: 0, validatorLocation: "codex:v", state: "running", openedAtSeq: 1 } }]);
    s = stamp(s, [{ put: "wait", wait: { waitId: "vw1", kind: "wait", subject: { jobId: "job-x", validationRunId: "vr1" }, state: "open", deadlineSec: 5000, owner: "codex:v", timeoutPolicy: "escalate" } }]); // validation-wait
    s = stamp(s, [{ put: "wait", wait: { waitId: "gate1", kind: "approval", subject: { jobId: "job-x" }, state: "open", deadlineSec: 5000, owner: "claude:o", timeoutPolicy: "escalate", decision: "pending" } }]); // gate
    expect(kinds(buildControlCut("job-x", s, 1000)!).filter((k) => k === "VALIDATION" || k === "AWAITING_GATE")).toEqual(["AWAITING_GATE", "VALIDATION"]); // vw1 not a 3rd
  });

  test("L1-tail P1-1: a repair-wait is EXCLUDED from responsibilities (it must not self-certify the stall it tracks)", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ status: "SUCCEEDED", specDigest: p.nodes[0]!.specDigest }) }]); // node has an attempt ⇒ not READY
    s = stamp(s, [{ put: "accepted", accepted: { acceptedResultId: "job-x/build/a1/r1", attemptId: "job-x/build/a1", nodeId: "build", jobId: "job-x", planRevision: 1, observedWorkCommit: "c", resultPath: "p", resultBlobOid: "b", resultClosureDigest: "cd", inputBindingDigest: "d", validatorVersion: "v1", decision: "accepted", decidedAtSeq: 3 } }]);
    s = stamp(s, [{ put: "wait", wait: { waitId: "repair-job-x-ep1", kind: "wait", subject: { jobId: "job-x" }, state: "open", deadlineSec: 5000, owner: "disp-1", timeoutPolicy: "escalate" } }]);
    const cut = buildControlCut("job-x", s, 1000)!;
    expect(cut.responsibilities.some((r) => r.subjectId === "repair-job-x-ep1")).toBe(false); // the repair-wait is NOT a holder
    // a NORMAL gate wait IS still counted (the exclusion is specific to the repair- namespace).
    let s2 = stamp(s, [{ put: "wait", wait: { waitId: "gate-x", kind: "wait", subject: { jobId: "job-x" }, state: "open", deadlineSec: 5000, owner: "o", timeoutPolicy: "escalate" } }]);
    expect(buildControlCut("job-x", s2, 1000)!.responsibilities).toContainEqual({ kind: "AWAITING_GATE", subjectId: "gate-x" });
  });

  test("per-job isolation: job A's cut excludes job B's attempts / intents / waits", () => {
    const a = planOf("jobA", "build"); const b = planOf("jobB", "build");
    let s = initialLogState();
    s = stamp(s, [{ put: "plan", plan: a } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "plan", plan: b } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ jobId: "jobB", attemptId: "jobB/build/a1", status: "RETRY_WAIT", retryAt: 5000, specDigest: b.nodes[0]!.specDigest }) }]);
    s = stamp(s, [{ put: "wait", wait: { waitId: "gateB", kind: "wait", subject: { jobId: "jobB" }, state: "open", deadlineSec: 5000, owner: "x", timeoutPolicy: "bypass" } }]);
    const cutA = buildControlCut("jobA", s, 1000)!;
    expect(cutA.responsibilities).toEqual([{ kind: "READY", subjectId: "build" }]); // only A's ready node; none of B's
  });

  test("P1-1: a terminated (SUCCEEDED) attempt's lingering pending intent does NOT manufacture an E responsibility", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ status: "SUCCEEDED", specDigest: p.nodes[0]!.specDigest, executionBindings: [{ bindingId: "job-x/build/a1/b0", assignmentId: "rw1@build", launchId: "rw1", publishGeneration: 1, openedAtSeq: 1, closedAtSeq: 3 }] }) }]);
    s = stamp(s, [intentBody({ status: "pending" })]); // the done attempt still carries a stale pending intent (not auto-rewritten)
    const cut = buildControlCut("job-x", s, 1000)!;
    expect(cut.responsibilities.some((r) => r.kind === "ALLOC_RECOVERING" || r.kind === "BUSINESS_EXEC")).toBe(false); // no phantom live holder
  });

  test("P1-1: an open business binding with NO intent ⇒ BUSINESS_EXEC (the open binding is the §1 carrier, not omitted)", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ status: "RUNNING", specDigest: p.nodes[0]!.specDigest, executionBindings: [{ bindingId: "job-x/build/a1/b0", assignmentId: "rw9@build", launchId: "rw9", publishGeneration: 1, openedAtSeq: 1 }] }) }]); // open binding, no DispatchIntent
    const cut = buildControlCut("job-x", s, 1000)!;
    expect(cut.responsibilities).toContainEqual({ kind: "BUSINESS_EXEC", subjectId: "job-x/build/a1", executorInstance: "rw9" });
  });

  test("59e7328-P1: a superseded prior binding's stale intent does NOT govern the successor OPEN binding (stays BUSINESS_EXEC/successor)", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    // one RUNNING attempt: prior binding b0 CLOSED (its pending intent lingers), successor binding b1 OPEN (continuationOf b0), no intent for b1.
    s = stamp(s, [{ put: "attempt", attempt: attempt({ status: "RUNNING", specDigest: p.nodes[0]!.specDigest, executionBindings: [
      { bindingId: "job-x/build/a1/b0", assignmentId: "rw-old@build", launchId: "rw-old", publishGeneration: 1, openedAtSeq: 1, closedAtSeq: 4 },
      { bindingId: "job-x/build/a1/b1", assignmentId: "rw-successor@build", launchId: "rw-successor", publishGeneration: 2, openedAtSeq: 5, continuationOf: "job-x/build/a1/b0" },
    ] }) }]);
    s = stamp(s, [intentBody({ status: "pending", bindingId: "job-x/build/a1/b0", launchId: "rw-old" })]); // stale intent for the CLOSED prior binding
    const cut = buildControlCut("job-x", s, 1000)!;
    expect(cut.responsibilities).toContainEqual({ kind: "BUSINESS_EXEC", subjectId: "job-x/build/a1", executorInstance: "rw-successor" }); // open successor is the carrier
    expect(cut.responsibilities.some((r) => r.kind === "ALLOC_RECOVERING")).toBe(false); // the b0 intent must NOT leak onto b1
  });

  test("P1-2: no authoritative PlanPut for the job in this state ⇒ null (caller emits UNVERIFIABLE, never judges off a stale startup plan)", () => {
    const s = stamp(initialLogState(), [{ put: "plan", plan: planOf("other-job", "build") } as unknown as ChangeBody]);
    expect(buildControlCut("job-x", s, 1000)).toBeNull();          // job-x has no plan in this cut
    expect(buildControlCut("other-job", s, 1000)).not.toBeNull();  // the plan that IS present resolves
  });
});

describe("heartbeatObservations", () => {
  const hb = (over: Partial<Heartbeat>): Heartbeat => ({ instance: "disp-1", pid: 1, pass: { lastTickSec: null, inFlight: null }, sweep: { lastTickSec: null, inFlight: null }, ...over });
  test("lastTickSec ⇒ a fact with instance + window; inFlight.startedSec newer wins (mid-tick is fresh)", () => {
    const o = heartbeatObservations(hb({ pass: { lastTickSec: 100, inFlight: { step: "x", startedSec: 140 } }, sweep: { lastTickSec: 90, inFlight: null } }), 60);
    expect(o).toContainEqual({ source: "pass-heartbeat", instance: "disp-1", sampledAtSec: 140, validUntilSec: 200 }); // inFlight newer
    expect(o).toContainEqual({ source: "sweep-heartbeat", instance: "disp-1", sampledAtSec: 90, validUntilSec: 150 });
  });
  test("a never-ticked loop yields NO observation (⇒ UNVERIFIABLE, never a false witness)", () => {
    expect(heartbeatObservations(hb({}), 60)).toEqual([]);
  });
});

describe("end-to-end: assembler → assertLiveness", () => {
  const p = planOf("job-x", "build");
  const readyState = (): LogState => stamp(initialLogState(), [{ put: "plan", plan: p } as unknown as ChangeBody]);
  const modes = (over = {}) => ({ sweepOn: true, taskExecOn: true, passInstance: "disp-1", sweepInstance: "disp-1", ...over });

  test("READY + fresh pass-heartbeat ⇒ OK (coverage.r has the node)", () => {
    const cut = buildControlCut("job-x", readyState(), 1000)!;
    const obs = heartbeatObservations({ instance: "disp-1", pid: 1, pass: { lastTickSec: 990, inFlight: null }, sweep: { lastTickSec: 990, inFlight: null } }, 60);
    const v = assertLiveness({ controlCut: cut, observations: obs, modes: modes() }, 1000);
    expect(v.verdict).toBe("OK");
  });

  test("READY but dispatcher mode OFF ⇒ STALL (verified-dead holder, non-terminal job)", () => {
    const cut = buildControlCut("job-x", readyState(), 1000)!;
    const v = assertLiveness({ controlCut: cut, observations: [], modes: modes({ taskExecOn: false }) }, 1000);
    expect(v.verdict).toBe("STALL");
  });

  test("READY, mode on, but NO heartbeat observation ⇒ UNVERIFIABLE (never guess)", () => {
    const cut = buildControlCut("job-x", readyState(), 1000)!;
    const v = assertLiveness({ controlCut: cut, observations: [], modes: modes() }, 1000);
    expect(v.verdict).toBe("UNVERIFIABLE");
  });
});
