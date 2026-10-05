import { describe, expect, test } from "vitest";
import { initialLogState, commit } from "../src/swarm/control-log.js";
import type { WaitRecord, PendingAction, WaitResolution, Change } from "../src/swarm/control-log.js";
import { openWait, openQueryWait, applyDefaultOnTimeout, advanceWait, isLive, isGranted, isRenewable, failureReopensIncident, type NewWait } from "../src/swarm/task-wait.js";

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

// §2c-b evidence renewal (coordinator-routed boundary with 20cab0a5): the pure `renew` event + isRenewable predicate.
describe("renew (§2c-b evidence renewal)", () => {
  const renewable = (p: Partial<NewWait> = {}): WaitRecord => openWait({ waitId: "sup1", kind: "wait", subject: { jobId: "job" }, deadlineSec: 100, owner: "disp", timeoutPolicy: "escalate", ...p });

  test("isRenewable: only an escalate liveness wait (no defaultOnTimeout / validationRunId / approval / bypass)", () => {
    expect(isRenewable(renewable())).toBe(true);
    expect(isRenewable(mkWait({ timeoutPolicy: "bypass" }))).toBe(false); // bypass = semantic
    expect(isRenewable(mkApproval())).toBe(false); // approval
    expect(isRenewable(openQueryWait({ waitId: "q", subject: { jobId: "job" }, deadlineSec: 100, owner: "d", defaultOnTimeout: res("default-applied") }))).toBe(false); // query-wait
    expect(isRenewable(renewable({ subject: { jobId: "job", validationRunId: "v1" } }))).toBe(false); // validation
  });

  test("renew on a renewable OPEN wait re-arms (open + fresh deadline + escalatedAt), never resolves", () => {
    const r = advanceWait(renewable(), { type: "renew", newDeadlineSec: 500, nowSec: 42 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wait.state).toBe("open");
    expect(r.wait.deadlineSec).toBe(500);
    expect(r.wait.escalatedAt).toBe(42);
    expect(isLive(r.wait)).toBe(true);
  });

  test("renew is rejected on a semantic-deadline wait", () => {
    expect(advanceWait(mkWait({ timeoutPolicy: "bypass" }), { type: "renew", newDeadlineSec: 500 }).ok).toBe(false);
    expect(advanceWait(mkApproval(), { type: "renew", newDeadlineSec: 500 }).ok).toBe(false);
  });

  test("renew is rejected from a non-open state and without a new deadline", () => {
    const pending = advanceWait(renewable(), { type: "begin_action", pendingAction: notice });
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(advanceWait(pending.wait, { type: "renew", newDeadlineSec: 500 }).ok).toBe(false); // action_pending
    expect(advanceWait(renewable(), { type: "renew" } as never).ok).toBe(false); // missing newDeadlineSec
  });
});

// dead-letter R5-B (routing-recovery boundary; coordinator-routed with 20cab0a5): occurredAtSec is the ONLY datum that
// separates a pre-recovery burst from a post-recovery one when both are observed at the same later tick.
describe("occurredAtSec + failureReopensIncident (R5-B incident boundary)", () => {
  const t0 = 1_000_000;

  test("occurredAtSec flows through a plain close verbatim (pure layer only stores it)", () => {
    const r = advanceWait(mkWait({ timeoutPolicy: "escalate" }), { type: "close", resolution: { outcome: "recovered", reason: "routing healthy", sourceOperationId: "op", occurredAtSec: t0 + 2000 } });
    expect(r.ok && r.wait.resolution?.occurredAtSec).toBe(t0 + 2000);
  });

  test("applyDefaultOnTimeout stamps the injected nowSec as occurredAtSec; absent nowSec leaves it off (current behavior)", () => {
    const q = () => openQueryWait({ waitId: "q", subject: { jobId: "job" }, deadlineSec: 100, owner: "d", defaultOnTimeout: res("default-applied") });
    const stamped = applyDefaultOnTimeout(q(), t0 + 5);
    expect(stamped.ok && stamped.wait.resolution?.occurredAtSec).toBe(t0 + 5);
    const bare = applyDefaultOnTimeout(q());
    expect(bare.ok && bare.wait.resolution?.occurredAtSec).toBeUndefined();
  });

  // The two counterexamples (codex acd6c23): same observation tick, failure ts both < observation; only the recovery
  // occurrence separates them.
  test("A: failure (t0+1000) BEFORE recovery (t0+2000) -> stale, does NOT reopen", () => {
    const recovery: WaitResolution = { outcome: "recovered", reason: "r", sourceOperationId: "op", occurredAtSec: t0 + 2000 };
    expect(failureReopensIncident(t0 + 1000, recovery)).toBe(false);
  });
  test("B: failure (t0+2000) AFTER recovery (t0+1000) -> fresh, DOES reopen", () => {
    const recovery: WaitResolution = { outcome: "recovered", reason: "r", sourceOperationId: "op", occurredAtSec: t0 + 1000 };
    expect(failureReopensIncident(t0 + 2000, recovery)).toBe(true);
  });

  test("failure exactly AT the recovery moment is stale (strict >) — the same-tick triggering burst does not re-flap", () => {
    expect(failureReopensIncident(t0 + 1000, { outcome: "recovered", reason: "r", sourceOperationId: "op", occurredAtSec: t0 + 1000 })).toBe(false);
  });

  test("no / non-finite boundary -> fail toward noticing (reopen), never a NaN-swallow", () => {
    expect(failureReopensIncident(t0, res("recovered"))).toBe(true); // bare close, no occurredAtSec
    expect(failureReopensIncident(t0, { outcome: "r", reason: "r", sourceOperationId: "op", occurredAtSec: Number.NaN })).toBe(true);
    expect(failureReopensIncident(t0, { outcome: "r", reason: "r", sourceOperationId: "op", occurredAtSec: Number.POSITIVE_INFINITY })).toBe(true);
    expect(failureReopensIncident(Number.NaN, { outcome: "r", reason: "r", sourceOperationId: "op", occurredAtSec: t0 })).toBe(true);
  });
});
