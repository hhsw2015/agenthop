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
const kinds = (c: ReturnType<typeof buildControlCut>): string[] => c.responsibilities.map((r) => r.kind).sort();

describe("buildControlCut — §1 six-state responsibility map", () => {
  test("a ready node (no attempt) ⇒ READY; job non-terminal", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    const cut = buildControlCut(p, s, 1000);
    expect(cut.jobTerminal).toBe(false);
    expect(cut.responsibilities).toEqual([{ kind: "READY", subjectId: "build" }]);
  });

  test("a PENDING intent ⇒ ALLOC_RECOVERING; a CONFIRMED intent ⇒ BUSINESS_EXEC (executorInstance=launchId)", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ specDigest: p.nodes[0]!.specDigest }) }]);
    s = stamp(s, [intentBody({ status: "pending" })]);
    expect(buildControlCut(p, s, 1000).responsibilities).toContainEqual({ kind: "ALLOC_RECOVERING", subjectId: "job-x/build/a1", executorInstance: "rw1" });
    let s2 = initialLogState(); s2 = stamp(s2, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s2 = stamp(s2, [{ put: "attempt", attempt: attempt({ specDigest: p.nodes[0]!.specDigest }) }]);
    s2 = stamp(s2, [intentBody({ status: "confirmed" })]);
    expect(buildControlCut(p, s2, 1000).responsibilities).toContainEqual({ kind: "BUSINESS_EXEC", subjectId: "job-x/build/a1", executorInstance: "rw1" });
  });

  test("an abandoned intent holds nothing (E empty); a RETRY_WAIT (backoff not due) ⇒ RETRY_WAIT_BACKOFF", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ status: "RETRY_WAIT", retryAt: 5000, specDigest: p.nodes[0]!.specDigest }) }]);
    s = stamp(s, [intentBody({ status: "abandoned" })]);
    expect(kinds(buildControlCut(p, s, 1000))).toEqual(["RETRY_WAIT_BACKOFF"]); // abandoned intent excluded
  });

  test("a running ValidationRun ⇒ VALIDATION; a non-validation wait ⇒ AWAITING_GATE; a validation-wait is NOT double-counted", () => {
    const p = planOf("job-x", "build");
    let s = initialLogState(); s = stamp(s, [{ put: "plan", plan: p } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "validationRun", validationRun: { validationRunId: "vr1", attemptId: "job-x/build/a1", candidateRef: { observedResultId: "o", observedWorkCommit: "c", resultClosureDigest: "cd" }, generation: 0, validatorLocation: "codex:v", state: "running", openedAtSeq: 1 } }]);
    s = stamp(s, [{ put: "wait", wait: { waitId: "vw1", kind: "wait", subject: { jobId: "job-x", validationRunId: "vr1" }, state: "open", deadlineSec: 5000, owner: "codex:v", timeoutPolicy: "escalate" } }]); // validation-wait
    s = stamp(s, [{ put: "wait", wait: { waitId: "gate1", kind: "approval", subject: { jobId: "job-x" }, state: "open", deadlineSec: 5000, owner: "claude:o", timeoutPolicy: "escalate", decision: "pending" } }]); // gate
    expect(kinds(buildControlCut(p, s, 1000)).filter((k) => k === "VALIDATION" || k === "AWAITING_GATE")).toEqual(["AWAITING_GATE", "VALIDATION"]); // vw1 not a 3rd
  });

  test("per-job isolation: job A's cut excludes job B's attempts / intents / waits", () => {
    const a = planOf("jobA", "build"); const b = planOf("jobB", "build");
    let s = initialLogState();
    s = stamp(s, [{ put: "plan", plan: a } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "plan", plan: b } as unknown as ChangeBody]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ jobId: "jobB", attemptId: "jobB/build/a1", status: "RETRY_WAIT", retryAt: 5000, specDigest: b.nodes[0]!.specDigest }) }]);
    s = stamp(s, [{ put: "wait", wait: { waitId: "gateB", kind: "wait", subject: { jobId: "jobB" }, state: "open", deadlineSec: 5000, owner: "x", timeoutPolicy: "bypass" } }]);
    const cutA = buildControlCut(a, s, 1000);
    expect(cutA.responsibilities).toEqual([{ kind: "READY", subjectId: "build" }]); // only A's ready node; none of B's
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
    const cut = buildControlCut(p, readyState(), 1000);
    const obs = heartbeatObservations({ instance: "disp-1", pid: 1, pass: { lastTickSec: 990, inFlight: null }, sweep: { lastTickSec: 990, inFlight: null } }, 60);
    const v = assertLiveness({ controlCut: cut, observations: obs, modes: modes() }, 1000);
    expect(v.verdict).toBe("OK");
  });

  test("READY but dispatcher mode OFF ⇒ STALL (verified-dead holder, non-terminal job)", () => {
    const cut = buildControlCut(p, readyState(), 1000);
    const v = assertLiveness({ controlCut: cut, observations: [], modes: modes({ taskExecOn: false }) }, 1000);
    expect(v.verdict).toBe("STALL");
  });

  test("READY, mode on, but NO heartbeat observation ⇒ UNVERIFIABLE (never guess)", () => {
    const cut = buildControlCut(p, readyState(), 1000);
    const v = assertLiveness({ controlCut: cut, observations: [], modes: modes() }, 1000);
    expect(v.verdict).toBe("UNVERIFIABLE");
  });
});
