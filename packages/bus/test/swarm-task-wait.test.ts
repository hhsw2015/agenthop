import { describe, expect, test } from "vitest";
import { initialLogState, commit } from "../src/swarm/control-log.js";
import type { WaitRecord, PendingAction, WaitResolution, Change } from "../src/swarm/control-log.js";
import { openWait, openQueryWait, applyDefaultOnTimeout, advanceWait, isLive, isGranted, type NewWait } from "../src/swarm/task-wait.js";

const subj = { jobId: "job", attemptId: "job/P/a1" };
const res = (outcome: string): WaitResolution => ({ outcome, reason: "r", sourceOperationId: "op" });
const notice: PendingAction = { actionId: "n1", actionKind: "escalation-notice", target: "claude:agenthop-fe0376cd", expectedSubjectVersion: 1 };
const bypass: PendingAction = { actionId: "b1", actionKind: "bypass", target: "job/P/a1", expectedSubjectVersion: 1 };

function mkWait(p: Partial<NewWait> = {}): WaitRecord {
  return openWait({ waitId: "w1", kind: "wait", subject: subj, deadlineSec: 100, owner: "disp", timeoutPolicy: "bypass", ...p });
}
function mkApproval(p: Partial<NewWait> = {}): WaitRecord {
  return openWait({ waitId: "a1", kind: "approval", subject: { ...subj, approvalRequestId: "ar1" }, deadlineSec: 100, owner: "disp", timeoutPolicy: "escalate", actionRef: "push", paramsDigest: "pd1", approvalAuthority: "human", approvalReason: "irreversible", ...p });
}

describe("openWait", () => {
  test("wait has no decision; approval starts decision=pending with its fields", () => {
    expect(mkWait().decision).toBeUndefined();
    const a = mkApproval();
    expect(a.decision).toBe("pending");
    expect(a.paramsDigest).toBe("pd1");
    expect(a.approvalAuthority).toBe("human");
    expect(a.state).toBe("open");
  });
});

describe("three-phase decide->execute->confirm (P1-1 crash windows)", () => {
  test("reversible wait: action_done RE-ARMS (open + new deadline + escalatedAt), it does NOT resolve (§0b erratum 94284fc2)", () => {
    const o = mkWait();
    const p = advanceWait(o, { type: "begin_action", pendingAction: bypass });
    expect(p.ok && p.wait.state === "action_pending" && p.wait.pendingAction?.actionId === "b1").toBe(true);
    const rearmed = advanceWait(p.ok ? p.wait : o, { type: "action_done", newDeadlineSec: 300, nowSec: 150 });
    expect(rearmed.ok).toBe(true);
    if (rearmed.ok) {
      expect(rearmed.wait.state).toBe("open"); // NOT resolved — a bypass delivery is not completion evidence
      expect(rearmed.wait.deadlineSec).toBe(300);
      expect(rearmed.wait.escalatedAt).toBe(150);
      expect(rearmed.wait.pendingAction).toBeUndefined();
    }
    // a reversible wait resolves ONLY when the subject completes (close).
    const resolved = advanceWait(rearmed.ok ? rearmed.wait : o, { type: "close", resolution: res("subject-completed") });
    expect(resolved.ok && resolved.wait.state === "resolved").toBe(true);
  });
  test("cannot confirm without a committed intent: action_done only from action_pending; begin_action only from open", () => {
    expect(advanceWait(mkWait(), { type: "action_done", newDeadlineSec: 200 }).ok).toBe(false); // open -> action_done is illegal
    const ap = advanceWait(mkWait(), { type: "begin_action", pendingAction: bypass });
    expect(ap.ok && advanceWait(ap.wait, { type: "begin_action", pendingAction: bypass }).ok === false).toBe(true); // double begin
  });
});

describe("approval: resolved != granted; escalation notice does NOT end the approval (P1-2 / P2-A)", () => {
  test("action_done on a still-pending approval goes BACK to open with a fresh deadline + escalatedAt (supervision transfers)", () => {
    const o = mkApproval();
    const p = advanceWait(o, { type: "begin_action", pendingAction: notice });
    expect(p.ok).toBe(true);
    const done = advanceWait(p.ok ? p.wait : o, { type: "action_done", newDeadlineSec: 500, nowSec: 200 });
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(done.wait.state).toBe("open"); // NOT resolved
      expect(done.wait.decision).toBe("pending"); // notice done != approval done
      expect(done.wait.deadlineSec).toBe(500); // re-supervised with a new deadline
      expect(done.wait.escalatedAt).toBe(200);
      expect(done.wait.pendingAction).toBeUndefined();
      expect(done.wait.grantRef).toBeUndefined(); // escalation never grants
    }
  });
  test("only a real terminal decision resolves an approval; granted records the grant", () => {
    const granted = advanceWait(mkApproval(), { type: "decide", decision: "granted", grantRef: "g1", resolution: res("approved") });
    expect(granted.ok && granted.wait.state === "resolved" && granted.wait.decision === "granted" && granted.wait.grantRef === "g1").toBe(true);
    const denied = advanceWait(mkApproval(), { type: "decide", decision: "denied" });
    expect(denied.ok && denied.wait.state === "resolved" && denied.wait.decision === "denied" && denied.wait.grantRef === undefined).toBe(true);
    // decide works whether the human replies while open OR while a notice is in flight (action_pending)
    const pending = advanceWait(mkApproval(), { type: "begin_action", pendingAction: notice });
    const decidedMidNotice = pending.ok ? advanceWait(pending.wait, { type: "decide", decision: "granted", grantRef: "g2" }) : { ok: false as const };
    expect(decidedMidNotice.ok && decidedMidNotice.wait.state === "resolved").toBe(true);
  });
  test("decide is approval-only and single-shot", () => {
    expect(advanceWait(mkWait(), { type: "decide", decision: "granted" }).ok).toBe(false);
    const g = advanceWait(mkApproval(), { type: "decide", decision: "granted", grantRef: "g1" });
    expect(g.ok && advanceWait(g.wait, { type: "decide", decision: "denied" }).ok === false).toBe(true);
  });
});

describe("close (P2-1 race) + terminal guards", () => {
  test("a normal subject completion/cancel closes the wait from open OR action_pending", () => {
    expect(advanceWait(mkWait(), { type: "close", resolution: res("subject-completed") }).ok).toBe(true);
    const ap = advanceWait(mkWait(), { type: "begin_action", pendingAction: bypass });
    expect(ap.ok && advanceWait(ap.wait, { type: "close", resolution: res("subject-completed") }).ok).toBe(true);
  });
  test("no transition out of resolved (a late action completion is a no-op for the caller)", () => {
    const r = advanceWait(mkWait(), { type: "close", resolution: res("done") });
    const resolved = r.ok ? r.wait : mkWait();
    for (const ev of [{ type: "begin_action", pendingAction: bypass }, { type: "action_done", newDeadlineSec: 200 }, { type: "decide", decision: "granted" }, { type: "close", resolution: res("x") }] as const) {
      expect(advanceWait(resolved, ev).ok).toBe(false);
    }
  });
});

describe("isLive / isGranted (admission is a matching grant, not 'no unresolved wait')", () => {
  test("isLive true until resolved", () => {
    expect(isLive(mkWait())).toBe(true);
    const r = advanceWait(mkWait(), { type: "close", resolution: res("done") });
    expect(r.ok && isLive(r.wait)).toBe(false);
  });
  test("isGranted only for a granted approval with a matching paramsDigest", () => {
    const g = advanceWait(mkApproval(), { type: "decide", decision: "granted", grantRef: "g1" });
    expect(g.ok && isGranted(g.wait, "pd1")).toBe(true);
    expect(g.ok && isGranted(g.wait, "WRONG")).toBe(false); // params must match
    const d = advanceWait(mkApproval(), { type: "decide", decision: "denied" });
    expect(d.ok && isGranted(d.wait, "pd1")).toBe(false); // denied != granted
    expect(isGranted(mkApproval(), "pd1")).toBe(false); // pending != granted
  });
});

describe("R3-b query-wait (问询不裸等): a query carries a default, applied on timeout via close", () => {
  const q = () => openQueryWait({ waitId: "q1", subject: { jobId: "job", attemptId: "job/P/a1" }, deadlineSec: 100, owner: "disp", defaultOnTimeout: { outcome: "proceed-c", reason: "no reply -> proceed with C", sourceOperationId: "op1" } });
  test("built as a bypass wait carrying its default (not a bare wait)", () => {
    const w = q();
    expect(w.kind === "wait" && w.timeoutPolicy === "bypass" && w.defaultOnTimeout?.outcome === "proceed-c").toBe(true);
  });
  test("timeout applies the pre-stored default via close -> resolved(default-applied)", () => {
    const applied = applyDefaultOnTimeout(q());
    expect(applied.ok && applied.wait.state === "resolved" && applied.wait.resolution?.outcome === "default-applied").toBe(true);
  });
  test("early human answer wins; a later timeout default is rejected (two closes race, CAS arbitrates)", () => {
    const answered = advanceWait(q(), { type: "close", resolution: { outcome: "answered", reason: "human chose A", sourceOperationId: "h1" } });
    expect(answered.ok && answered.wait.state === "resolved" && answered.wait.resolution?.outcome === "answered").toBe(true);
    const late = applyDefaultOnTimeout(answered.ok ? answered.wait : q()); // the timeout default arrives late
    expect(late.ok).toBe(false); // close on an already-resolved wait is rejected — the human answer won
  });
  test("applyDefaultOnTimeout on a non-query wait (no default) is rejected — never fabricate a resolution", () => {
    expect(applyDefaultOnTimeout(openWait({ waitId: "w1", kind: "wait", subject: { jobId: "job" }, deadlineSec: 100, owner: "disp", timeoutPolicy: "bypass" })).ok).toBe(false);
  });
  test("revision is monotonic after the default is applied (control-log)", () => {
    const ch = (wait: WaitRecord, n: number): Change => ({ put: "wait", wait, operationId: `wait:${wait.waitId}#${n}`, expectedEntityRevision: n - 1 } as Change);
    const w = q();
    let s = commit(initialLogState(), 0, [ch(w, 1)]).state;
    expect(s.revisions["wait:q1"]).toBe(1);
    const applied = applyDefaultOnTimeout(w);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      s = commit(s, 1, [ch(applied.wait, 2)]).state;
      expect(s.revisions["wait:q1"]).toBe(2);
      const body = s.entities["wait:q1"];
      expect(body?.put === "wait" && body.wait.state === "resolved").toBe(true);
    }
  });
  test("type invariant: an approval cannot carry a default (does not compile)", () => {
    // @ts-expect-error — NewWait (openWait, used for approvals) has no defaultOnTimeout; a default is set ONLY via
    // openQueryWait, which is always kind="wait". "问询不裸等 vs 门控才裸等" separated at the type layer.
    openWait({ waitId: "a1", kind: "approval", subject: { jobId: "job" }, deadlineSec: 100, owner: "disp", timeoutPolicy: "escalate", defaultOnTimeout: { outcome: "x", reason: "y", sourceOperationId: "z" } });
  });
});
