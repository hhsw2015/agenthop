import { describe, expect, test } from "vitest";
import {
  initialLogState,
  commit,
  replayLog,
  liveEntities,
  entityKeyOf,
  reconcilePush,
  type Change,
  type ChangeBody,
  type DispatchIntent,
  type CommittedBatch,
} from "../src/swarm/control-log.js";
import type { ControlRecord } from "../src/swarm/control.js";
import type { AcceptedResult } from "../src/swarm/task-result.js";
import { loadPlan } from "../src/swarm/task-plan.js";
import { createAttempt } from "../src/swarm/task-state.js";
import { currentAccepted } from "../src/swarm/task-ready.js";

function ch(body: ChangeBody, operationId: string, expectedEntityRevision = 0): Change {
  return { ...body, operationId, expectedEntityRevision } as Change;
}
const scan = (branch: string, cursor: string | null): ChangeBody => ({ put: "scan", branch, cursor });
const rec = (launchId: string): ControlRecord => ({ launchId, state: "RUNNING", generation: 0, allocStart: 0, budgetSec: 3480, updatedAt: 0 });
const intent: DispatchIntent = { intentId: "as1", attemptId: "job/P/a1", nodeId: "P", launchId: "rw-1", bindingId: "job/P/a1/b0", assignmentDigest: "ad", allocRequestStartSec: 100, workDeadlineSec: 200, allocOutcome: "pending", status: "pending" };

describe("commit — basics", () => {
  test("empty batch rejected", () => {
    expect(commit(initialLogState(), 0, []).result).toEqual({ ok: false, reason: "batch", detail: "empty batch" });
  });
  test("a new change applies: seq +1, entity revision 1, projected", () => {
    const { result, state } = commit(initialLogState(), 0, [ch(scan("b1", null), "op1")]);
    expect(result).toEqual({ ok: true, newSeq: 1, replay: false });
    expect(state.seq).toBe(1);
    expect(state.revisions["scan:b1"]).toBe(1);
    expect(state.entities["scan:b1"]).toEqual(scan("b1", null));
  });
  test("intent change keys to intent:<id> and projects", () => {
    const { state } = commit(initialLogState(), 0, [ch({ put: "intent", intent }, "opI")]);
    expect(state.entities["intent:as1"]).toBeDefined();
    expect(entityKeyOf({ put: "intent", intent })).toBe("intent:as1");
  });
  test("F53 opsReceipt keys to opsReceipt:<opId>, projects, and advances by revision (no latest-wins)", () => {
    const pending: ChangeBody = { put: "opsReceipt", ops: { opId: "spawn:L1", kind: "spawn", target: "m1", firedAtSec: 100, status: "pending" } };
    expect(entityKeyOf(pending)).toBe("opsReceipt:spawn:L1");
    const s1 = commit(initialLogState(), 0, [ch(pending, "op-ops-1")]).state;
    expect(s1.revisions["opsReceipt:spawn:L1"]).toBe(1);
    expect((s1.entities["opsReceipt:spawn:L1"] as Extract<ChangeBody, { put: "opsReceipt" }>).ops.status).toBe("pending");
    // a status transition is a NEW revision of the SAME entity (FC-6 explicit transition)
    const confirmed: ChangeBody = { put: "opsReceipt", ops: { opId: "spawn:L1", kind: "spawn", target: "m1", firedAtSec: 100, status: "confirmed", verdict: "confirmed", checkedAtSec: 200 } };
    const s2 = commit(s1, 1, [ch(confirmed, "op-ops-2", 1)]).state;
    expect(s2.revisions["opsReceipt:spawn:L1"]).toBe(2);
    expect((liveEntities(s2)["opsReceipt:spawn:L1"] as Extract<ChangeBody, { put: "opsReceipt" }>).ops.status).toBe("confirmed");
  });
});

describe("decision order (Codex §2.6 v2; fe0376cd traps)", () => {
  test("REPLAY (same opId, same digest) is a no-op — and precedes the seq check", () => {
    const s1 = commit(initialLogState(), 0, [ch(scan("b1", null), "op1")]).state;
    // Re-submit the SAME op with a STALE expectedSeq (0, but state.seq is 1): still a replay, not a seq conflict.
    const again = commit(s1, 0, [ch(scan("b1", null), "op1")]);
    expect(again.result).toEqual({ ok: true, newSeq: 1, replay: true });
    expect(again.state.seq).toBe(1); // no double-apply
    expect(again.state.revisions["scan:b1"]).toBe(1);
  });
  test("REPLAY precedes the expectedEntityRevision check (crash-recovery resend after the entity advanced)", () => {
    let s = commit(initialLogState(), 0, [ch(scan("b1", null), "op1", 0)]).state; // rev 1
    s = commit(s, 1, [ch(scan("b1", "c1"), "op2", 1)]).state; // scan:b1 now rev 2
    // Re-submit op1 (expectedEntityRevision 0) — revision is now 2, but replay must win, NOT stale-entity.
    const replay = commit(s, 99, [ch(scan("b1", null), "op1", 0)]);
    expect(replay.result).toEqual({ ok: true, newSeq: 2, replay: true });
  });
  test("OP-CONFLICT (same opId, different digest) freezes the entity; no latest-wins", () => {
    const s1 = commit(initialLogState(), 0, [ch(scan("b1", null), "op1")]).state;
    const conflict = commit(s1, 1, [ch(scan("b1", "DIFFERENT"), "op1")]);
    expect(conflict.result).toEqual({ ok: false, reason: "op-conflict", operationId: "op1", entityKey: "scan:b1" });
    expect(conflict.state.frozen).toContain("scan:b1");
    // a subsequent new op on the frozen entity is refused
    const after = commit(conflict.state, conflict.state.seq, [ch(scan("b1", "c2"), "op9", 1)]);
    expect(after.result.ok).toBe(false);
    expect(after.result.ok === false && after.result.reason === "batch").toBe(true);
  });
  test("stale expectedEntityRevision (new op) is NOT a conflict — caller recomputes", () => {
    const s1 = commit(initialLogState(), 0, [ch(scan("b1", null), "op1", 0)]).state; // rev 1
    const stale = commit(s1, 1, [ch(scan("b1", "c2"), "op2", 0)]); // expected 0 but current 1
    expect(stale.result).toEqual({ ok: false, reason: "stale-entity", entityKey: "scan:b1", currentRevision: 1 });
    expect(stale.state).toBe(s1); // unchanged
  });
  test("expectedSeq mismatch (all-new batch) returns the current seq", () => {
    const s1 = commit(initialLogState(), 0, [ch(scan("b1", null), "op1")]).state; // seq 1
    const bad = commit(s1, 0, [ch(scan("b2", null), "op2")]);
    expect(bad.result).toEqual({ ok: false, reason: "seq", currentSeq: 1 });
  });
});

describe("batch group-atomicity", () => {
  test("same entity put twice in one batch rejected (caller bug)", () => {
    const bad = commit(initialLogState(), 0, [ch(scan("b1", null), "op1"), ch(scan("b1", "c"), "op2")]);
    expect(bad.result.ok).toBe(false);
    expect(bad.result.ok === false && /twice/.test((bad.result as { detail?: string }).detail ?? "")).toBe(true);
  });
  test("a batch where any change fails applies NOTHING", () => {
    const batch = [ch(scan("b2", null), "op2", 0), ch(scan("b3", null), "op3", 5)]; // op3 expects rev 5, actual 0
    const out = commit(initialLogState(), 0, batch);
    expect(out.result.ok === false && out.result.reason === "stale-entity").toBe(true);
    expect(out.state.entities["scan:b2"]).toBeUndefined(); // first change NOT applied
    expect(out.state.seq).toBe(0);
  });
});

describe("replayLog (projection rebuild / crash recovery)", () => {
  test("folds an ordered log back into the same state as sequential commits", () => {
    let s = initialLogState();
    const batches: CommittedBatch[] = [];
    const b1 = [ch(scan("b1", null), "op1")];
    s = commit(s, 0, b1).state; batches.push({ seq: 1, changes: b1 });
    const b2 = [ch(scan("b1", "c1"), "op2", 1), ch({ put: "lifecycle", record: rec("L") }, "op3", 0)];
    s = commit(s, 1, b2).state; batches.push({ seq: 2, changes: b2 });
    const rebuilt = replayLog(batches);
    expect(rebuilt.seq).toBe(s.seq);
    expect(rebuilt.revisions).toEqual(s.revisions);
    expect(rebuilt.entities).toEqual(s.entities);
  });
  test("a seq gap throws", () => {
    expect(() => replayLog([{ seq: 2, changes: [ch(scan("b1", null), "op1")] }])).toThrow();
  });
});

describe("supersede mutates the AcceptedResult, never replaces the entity (fe0376cd T2 review #2 P1)", () => {
  const accepted: AcceptedResult = {
    acceptedResultId: "job/C/a1/r1", attemptId: "job/C/a1", nodeId: "C", jobId: "job", planRevision: 1,
    observedWorkCommit: "wc-C", resultPath: "out/results/job/C/a1/result.json", resultBlobOid: "b",
    resultClosureDigest: "cd", inputBindingDigest: "d", validatorVersion: "brain-v1", decision: "accepted", decidedAtSeq: 5,
  };
  test("flips superseded:true and PRESERVES the original content", () => {
    const s1 = commit(initialLogState(), 0, [ch({ put: "accepted", accepted }, "op1")]).state;
    const sup = commit(s1, 1, [ch({ put: "supersede", acceptedResultId: accepted.acceptedResultId }, "op2", 1)]);
    expect(sup.result.ok).toBe(true);
    const body = sup.state.entities["accepted:job/C/a1/r1"];
    expect(body?.put).toBe("accepted");
    if (body?.put === "accepted") {
      expect(body.accepted.superseded).toBe(true);
      expect(body.accepted.observedWorkCommit).toBe("wc-C"); // original NOT lost
      expect(body.accepted.decidedAtSeq).toBe(5);
    }
  });
  test("superseding a nonexistent accepted is rejected (caller bug)", () => {
    const bad = commit(initialLogState(), 0, [ch({ put: "supersede", acceptedResultId: "ghost/r1" }, "op1")]);
    expect(bad.result.ok === false && bad.result.reason === "batch").toBe(true);
  });
  test("end-to-end: the projected superseded AcceptedResult makes currentAccepted(C) null", () => {
    const plan = loadPlan({ jobId: "job", planRevision: 1, nodes: [{ nodeId: "C", kind: "work", goal: "c", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 60, retryBudget: 2 }], jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 1000 } });
    if (!plan.ok) throw new Error(plan.reason);
    const attempt = { ...createAttempt({ jobId: "job", nodeId: "C", n: 1, planRevision: 1, specDigest: plan.plan.nodes[0]!.specDigest, inputBindings: [], firstBinding: { bindingId: "job/C/a1/b0", assignmentId: "as", launchId: "rw-1", publishGeneration: 0, openedAtSeq: 1 }, createdAtSeq: 1 }), status: "SUCCEEDED" as const };
    const acc1: AcceptedResult = { ...accepted, inputBindingDigest: attempt.inputBindingDigest };
    let s = commit(initialLogState(), 0, [ch({ put: "accepted", accepted: acc1 }, "op1")]).state;
    // Before supersede: C is current.
    const projected = (st: typeof s): AcceptedResult[] => Object.values(liveEntities(st)).flatMap((b) => (b.put === "accepted" ? [b.accepted] : []));
    expect(currentAccepted("C", { plan: plan.plan, attempts: [attempt], acceptedResults: projected(s) })?.acceptedResultId).toBe(acc1.acceptedResultId);
    // After supersede: projected accepted has superseded:true -> currentAccepted null.
    s = commit(s, 1, [ch({ put: "supersede", acceptedResultId: acc1.acceptedResultId }, "op2", 1)]).state;
    expect(currentAccepted("C", { plan: plan.plan, attempts: [attempt], acceptedResults: projected(s) })).toBeNull();
  });
});

describe("wait Change (team-collab §0b)", () => {
  const wait = { waitId: "w1", kind: "approval" as const, subject: { jobId: "job", approvalRequestId: "ar1" }, state: "open" as const, deadlineSec: 100, owner: "disp", timeoutPolicy: "escalate" as const, decision: "pending" as const };
  test("a wait Change keys to wait:<waitId> and projects", () => {
    expect(entityKeyOf({ put: "wait", wait })).toBe("wait:w1");
    const { state } = commit(initialLogState(), 0, [ch({ put: "wait", wait }, "op1")]);
    expect(state.entities["wait:w1"]?.put).toBe("wait");
    expect(state.revisions["wait:w1"]).toBe(1);
  });
  test("a state transition is a new revision on the same entity", () => {
    let s = commit(initialLogState(), 0, [ch({ put: "wait", wait }, "op1")]).state;
    s = commit(s, 1, [ch({ put: "wait", wait: { ...wait, state: "resolved", decision: "granted" } }, "op2", 1)]).state;
    expect(s.revisions["wait:w1"]).toBe(2);
    const body = s.entities["wait:w1"];
    expect(body?.put === "wait" && body.wait.decision === "granted").toBe(true);
  });
});

describe("reconcilePush (F17, §4.3 step B)", () => {
  test("same operation identities on-chain => advance (idempotent, whoever wrote it)", () => {
    const intended = [ch(scan("b1", null), "op1", 0), ch({ put: "intent", intent }, "op2", 0)];
    const onChain = [ch({ put: "intent", intent }, "op2", 0), ch(scan("b1", null), "op1", 0)]; // different array order, same ops
    expect(reconcilePush(intended, onChain)).toBe("advance");
  });
  test("different content on-chain => halt (second active dispatcher = split-brain)", () => {
    const intended = [ch(scan("b1", null), "op1", 0)];
    const onChain = [ch(scan("b1", "DIFFERENT"), "op1", 0)];
    expect(reconcilePush(intended, onChain)).toBe("halt");
    expect(reconcilePush(intended, [ch(scan("b2", null), "op9", 0)])).toBe("halt");
  });
});

describe("tombstone (§4.3)", () => {
  test("liveEntities drops a tombstoned lifecycle record and the tombstone marker", () => {
    let s = commit(initialLogState(), 0, [ch({ put: "lifecycle", record: rec("L") }, "op1")]).state;
    s = commit(s, 1, [ch({ put: "tombstone", launchId: "L" }, "op2")]).state;
    const live = liveEntities(s);
    expect(live["lifecycle:L"]).toBeUndefined();
    expect(live["tombstone:L"]).toBeUndefined();
  });
  test("a non-tombstoned lifecycle record stays live", () => {
    const s = commit(initialLogState(), 0, [ch({ put: "lifecycle", record: rec("M") }, "op1")]).state;
    expect(liveEntities(s)["lifecycle:M"]).toBeDefined();
  });
});
