// taskPass orchestration regression (run: `node --test` is NOT used — this is vitest, in packages/bus's runner via a
// relative import). It injects fake IO ops and drives the REAL pure deciders + control-log engine, so the ordering that
// matters is locked: CAS-then-IO (commit the intent+attempt BEFORE startTask), clean-fail revokes the never-run attempt
// and frees the slot, an observed success is accepted, and the cap bounds concurrent dispatches.
import { describe, expect, test } from "vitest";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import { commit, entityKeyOf, initialLogState, liveEntities, type ChangeBody, type LogState } from "../src/swarm/control-log.js";
import { jobStatus } from "../src/swarm/task-ready.js";
import { createAttempt, type TaskAttempt } from "../src/swarm/task-state.js";
import { taskPass, buildSched, isForeignResult, requiredFilesPresent, type TaskOps, type GitFacts } from "../src/swarm/task-pass.js";

/** Find the single DispatchIntent in the projection (tests have one job/one node). */
function theIntent(state: LogState): { status: string; allocOutcome: string } | undefined {
  for (const b of Object.values(liveEntities(state))) if (b.put === "intent") return b.intent;
  return undefined;
}
function attemptsOf(plan: TaskPlan, state: LogState): TaskAttempt[] { return buildSched(plan, state).attempts; }

function plan1(): TaskPlan {
  const res = loadPlan({
    jobId: "job", planRevision: 1,
    nodes: [{ nodeId: "build", kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }],
    jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
  });
  if (!res.ok) throw new Error(res.reason);
  return res.plan;
}

/** The commit stamping the real shell uses: operationId = entityKey#targetRev, expectedEntityRevision = current rev. */
function stampCommit(state: LogState, bodies: ChangeBody[]): { state: LogState; result: ReturnType<typeof commit>["result"] } {
  const changes = bodies.map((b) => {
    const key = entityKeyOf(b);
    const rev = state.revisions[key] ?? 0;
    return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev };
  });
  const r = commit(state, state.seq, changes);
  return { state: r.state, result: r.result };
}

function mkOps(over: Partial<TaskOps> & { stateRef: { s: LogState }; order: string[] }): TaskOps {
  const { stateRef, order } = over;
  let lid = 0;
  return {
    nowSec: () => 1000, cap: 3, budgetSec: 3480, planCommittedAtSec: 1000, remainingLifeSec: 3000, checkpointBudgetSec: 300, handoffMarginSec: 180,
    tokenMarginSec: 600, jitterSec: () => 0,
    newLaunchId: () => `rw-t${++lid}`,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { order.push(`commit:${bodies.map((b) => b.put).join("+")}`); const r = stampCommit(state, bodies); stateRef.s = r.state; return r; },
    observeGit: async () => null,
    startTask: async () => { order.push("startTask"); return { alloc: "created", delivered: true }; },
    log: () => {},
    ...over,
  };
}

describe("taskPass dispatch — CAS-then-IO ordering", () => {
  test("commits intent+attempt BEFORE startTask, then commits the confirmed outcome", async () => {
    const stateRef = { s: initialLogState() };
    const order: string[] = [];
    await taskPass(plan1(), mkOps({ stateRef, order }));
    expect(order).toEqual(["commit:intent+attempt", "startTask", "commit:intent"]);
    const sched = buildSched(plan1(), stateRef.s);
    expect(sched.attempts).toHaveLength(1);
    expect(sched.attempts[0]!.status).toBe("RUNNING");
  });
});

describe("taskPass dispatch — clean-fail revokes the attempt + frees the slot", async () => {
  test("a provider refusal abandons the never-run attempt (intent-revoked)", async () => {
    const stateRef = { s: initialLogState() };
    const order: string[] = [];
    await taskPass(plan1(), mkOps({ stateRef, order, startTask: async () => { order.push("startTask"); return { alloc: "clean-fail", delivered: false }; } }));
    const a = buildSched(plan1(), stateRef.s).attempts[0]!;
    expect(a.status).toBe("ABANDONED");
    expect(a.abandonReason).toBe("intent-revoked");
    expect(order).toEqual(["commit:intent+attempt", "startTask", "commit:intent+attempt"]);
  });
});

describe("taskPass dispatch — cap bounds concurrency", () => {
  test("two ready nodes, cap 1 ⇒ only one dispatched this pass", async () => {
    const res = loadPlan({
      jobId: "job", planRevision: 1,
      nodes: [
        { nodeId: "a", kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" },
        { nodeId: "b", kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" },
      ],
      jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
    });
    if (!res.ok) throw new Error(res.reason);
    const plan = res.plan;
    const stateRef = { s: initialLogState() };
    const order: string[] = [];
    await taskPass(plan, mkOps({ stateRef, order, cap: 1 }));
    expect(buildSched(plan, stateRef.s).attempts).toHaveLength(1); // only one box allocated
  });
});

describe("taskPass — job wall-clock budget (fix A: wallClockSec from planCommittedAtSec)", () => {
  test("once elapsed >= maxWallClockSec, nothing is dispatched and jobStatus is failed(budget)", async () => {
    const plan = plan1(); // maxWallClockSec 36000
    const stateRef = { s: initialLogState() };
    const order: string[] = [];
    // plan committed 36001s before now (nowSec 1000) ⇒ wallClockSec 36001 >= 36000 ⇒ budget exhausted.
    await taskPass(plan, mkOps({ stateRef, order, planCommittedAtSec: 1000 - 36001 }));
    expect(buildSched(plan, stateRef.s).attempts).toHaveLength(0); // readyTasks empty ⇒ no startTask
    expect(order).not.toContain("startTask");
    const s = jobStatus({ ...buildSched(plan, stateRef.s), now: 1000, jobUsage: { totalAttempts: 0, wallClockSec: 36001 } });
    expect(s.status).toBe("failed");
    expect(s.note).toContain("budget");
  });
});

describe("taskPass dispatch — job maxTotalAttempts bounds the loop (Codex P1-4)", () => {
  test("3 ready, cap 3, maxTotalAttempts 1 ⇒ only ONE allocated (budget re-checked per dispatch)", async () => {
    const res = loadPlan({
      jobId: "job", planRevision: 1,
      nodes: ["a", "b", "c"].map((nodeId) => ({ nodeId, kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" })),
      jobBudget: { maxTotalAttempts: 1, maxWallClockSec: 36000 },
    });
    if (!res.ok) throw new Error(res.reason);
    const stateRef = { s: initialLogState() };
    await taskPass(res.plan, mkOps({ stateRef, order: [], cap: 3 }));
    expect(attemptsOf(res.plan, stateRef.s)).toHaveLength(1);
  });
});

describe("taskPass dispatch — alloc created but worker not delivered (Codex P2)", () => {
  test("created+!delivered ⇒ box occupies but intent is NOT confirmed", async () => {
    const stateRef = { s: initialLogState() };
    await taskPass(plan1(), mkOps({ stateRef, order: [], startTask: async () => ({ alloc: "created", delivered: false }) }));
    const intent = theIntent(stateRef.s);
    expect(intent?.allocOutcome).toBe("created"); // box exists (creation-bound occupancy)
    expect(intent?.status).toBe("pending"); // but NOT confirmed — the worker never started
    expect(attemptsOf(plan1(), stateRef.s)[0]!.status).toBe("RUNNING"); // slot held; observation/expiry reconciles
  });
});

describe("taskPass dispatch — retry lineage survives clean-fail + unknown (Codex P1-1 round-2)", () => {
  function seedRetryWait(stateRef: { s: LogState }, plan: TaskPlan, retriesUsed: number): void {
    const a0: TaskAttempt = {
      ...createAttempt({ jobId: "job", nodeId: "build", n: 0, planRevision: 1, specDigest: plan.nodes[0]!.specDigest, inputBindings: [], firstBinding: { bindingId: "job/build/a0/b0", assignmentId: "as0", launchId: "rw-old", publishGeneration: 0, openedAtSeq: 1 }, createdAtSeq: 1 }),
      status: "RETRY_WAIT", retriesUsed, retryAt: 500,
    };
    stateRef.s = stampCommit(stateRef.s, [{ put: "attempt", attempt: a0 }]).state;
  }

  test("clean-fail: old retired in the SAME batch (§3.1), count preserved via durable max — not a lingering RETRY_WAIT", async () => {
    const plan = plan1();
    const stateRef = { s: initialLogState() };
    seedRetryWait(stateRef, plan, 1);
    await taskPass(plan, mkOps({ stateRef, order: [], startTask: async () => ({ alloc: "clean-fail", delivered: false }) }));
    const after1 = Object.fromEntries(attemptsOf(plan, stateRef.s).map((a) => [a.attemptId, a]));
    expect(after1["job/build/a0"]!.status).toBe("ABANDONED"); // retired atomically with a1 — no coexistence window
    expect(after1["job/build/a1"]!.status).toBe("ABANDONED");
    await taskPass(plan, mkOps({ stateRef, order: [] })); // alloc created
    const a2 = attemptsOf(plan, stateRef.s).find((a) => a.attemptId === "job/build/a2");
    expect(a2?.retriesUsed).toBe(1); // resurrected from max(retriesUsed) over the node's attempts, not a live RETRY_WAIT
    expect(a2?.status).toBe("RUNNING");
  });

  test("unknown then business-fail: succession inherits the HIGHER count, never the stale a0 (the fixed regression)", async () => {
    const plan = plan1();
    const stateRef = { s: initialLogState() };
    seedRetryWait(stateRef, plan, 1);
    // pass 1: alloc=unknown ⇒ a0 retired same-batch, a1 RUNNING (not two live attempts).
    await taskPass(plan, mkOps({ stateRef, order: [], startTask: async () => ({ alloc: "unknown", delivered: false }) }));
    const m = Object.fromEntries(attemptsOf(plan, stateRef.s).map((a) => [a.attemptId, a]));
    expect(m["job/build/a0"]!.status).toBe("ABANDONED");
    expect(m["job/build/a1"]!.status).toBe("RUNNING");
    // the worker then business-fails a1 to RETRY_WAIT(2).
    stateRef.s = stampCommit(stateRef.s, [{ put: "attempt", attempt: { ...m["job/build/a1"]!, status: "RETRY_WAIT", retriesUsed: 2, retryAt: 600 } }]).state;
    // pass 2: created ⇒ succession picks a1(2), NOT the stale a0(1); a2 inherits 2 (the bug gave 1 ⇒ an extra retry).
    await taskPass(plan, mkOps({ stateRef, order: [] }));
    const a2 = attemptsOf(plan, stateRef.s).find((a) => a.attemptId === "job/build/a2");
    expect(a2?.retriesUsed).toBe(2);
  });
});

describe("observeGit pure helpers (Codex P1-3 / P2-2 / P2-6 round-3)", () => {
  test("isForeignResult: confirmed-foreign only; unparseable + schema-invalid surface to V1", () => {
    expect(isForeignResult(JSON.stringify({ assignmentId: "A", attemptId: "T" }), "A", "T")).toBe(false); // ours
    expect(isForeignResult(JSON.stringify({ assignmentId: "B", attemptId: "T" }), "A", "T")).toBe(true); // wrong assignment
    expect(isForeignResult(JSON.stringify({ assignmentId: "A", attemptId: "X" }), "A", "T")).toBe(true); // wrong attempt (P1-3 B)
    expect(isForeignResult("{not json", "A", "T")).toBe(false); // unparseable ⇒ surface to V1 (P2-2)
    expect(isForeignResult(JSON.stringify({ attemptId: "T" }), "A", "T")).toBe(false); // missing assignmentId ⇒ schema-invalid ⇒ V1 (P2-2)
    expect(isForeignResult("null", "A", "T")).toBe(false); // non-object ⇒ surface to V1
  });
  test("requiredFilesPresent: a declared output OR evidence file missing ⇒ false (missing is detectable)", () => {
    const outputs = [{ path: "out/r.md" }];
    const evidence = [{ summaryPath: "out/e.txt" }];
    expect(requiredFilesPresent(outputs, evidence, [{ path: "out/r.md" }, { path: "out/e.txt" }])).toBe(true);
    expect(requiredFilesPresent(outputs, evidence, [{ path: "out/r.md" }])).toBe(false); // evidence file missing/errored
    expect(requiredFilesPresent(outputs, evidence, [{ path: "out/e.txt" }])).toBe(false); // output missing
    expect(requiredFilesPresent([], [], [])).toBe(true); // nothing declared
    expect(requiredFilesPresent([null as unknown as { path?: unknown }], [], [])).toBe(true); // null entry ignored (V1 handles)
  });
});

describe("taskPass accept — an observed success is accepted", () => {
  test("after dispatch, an observed valid result ⇒ attempt SUCCEEDED + accepted recorded", async () => {
    const plan = plan1();
    const stateRef = { s: initialLogState() };
    const order: string[] = [];
    // pass 1: dispatch (creates the RUNNING attempt bound to rw-t1).
    await taskPass(plan, mkOps({ stateRef, order }));
    const att = buildSched(plan, stateRef.s).attempts[0]!;
    const asgId = att.executionBindings[0]!.assignmentId;
    const resultText = JSON.stringify({
      schemaVersion: 1, jobId: "job", planRevision: 1, nodeId: "build", attemptId: att.attemptId, assignmentId: asgId,
      inputBindingDigest: att.inputBindingDigest, outcome: "success", outputs: [{ logicalName: "o", kind: "report", path: "out/report.md" }], validationEvidence: [],
    });
    const facts: GitFacts = {
      observedWorkCommit: "wc1", resultText, resultBlobOid: "blob1", closureFiles: [{ path: "out/report.md", blobOid: "b2" }],
      cumulativeChangedPaths: ["out/results/" + att.attemptId + "/result.json", "out/report.md"],
      contract: { requiredOutputsPresent: true, patchAppliesClean: true }, acceptancePassed: true, withinCutoffAncestry: true,
    };
    // pass 2: accept.
    await taskPass(plan, mkOps({ stateRef, order, observeGit: async () => facts }));
    const sched = buildSched(plan, stateRef.s);
    expect(sched.attempts[0]!.status).toBe("SUCCEEDED");
    expect(sched.acceptedResults).toHaveLength(1);
  });
});
