import { describe, expect, test } from "vitest";
import {
  type InputBinding,
  type ExecutionBinding,
  type TaskAttempt,
  type NewAttempt,
  computeInputBindingDigest,
  bindingState,
  candidateEligibility,
  activateBinding,
  beginClosing,
  finishClosing,
  createAttempt,
  advanceAttempt,
  makeSuccessionAttempt,
  attemptIdOf,
  bindingIdOf,
} from "../src/swarm/task-state.js";

const SEQ = 100;
function ib(p: Partial<InputBinding> = {}): InputBinding {
  return { depNodeId: "C", acceptedResultId: "job/C/a1/r1", workCommit: "wc0", resultPath: "out/results/job/C/a1/result.json", ...p };
}
function bind(p: Partial<ExecutionBinding> = {}): ExecutionBinding {
  return { bindingId: "job/P/a1/b0", assignmentId: "as0", launchId: "rw-1", publishGeneration: 0, openedAtSeq: SEQ, ...p };
}
function mkAttempt(p: Partial<NewAttempt> = {}): TaskAttempt {
  return createAttempt({ jobId: "job", nodeId: "P", n: 1, planRevision: 1, specDigest: "sd", inputBindings: [ib()], firstBinding: bind(), createdAtSeq: SEQ, ...p });
}

describe("ids", () => {
  test("attemptId / bindingId formats (§2.2, §2.3)", () => {
    expect(attemptIdOf("job", "P", 2)).toBe("job/P/a2");
    expect(bindingIdOf("job/P/a2", 0)).toBe("job/P/a2/b0");
  });
});

describe("computeInputBindingDigest", () => {
  test("order-independent (sorted before hashing, §2.2)", () => {
    const a = ib({ depNodeId: "A", acceptedResultId: "job/A/a1/r1" });
    const b = ib({ depNodeId: "B", acceptedResultId: "job/B/a1/r1" });
    expect(computeInputBindingDigest([a, b])).toBe(computeInputBindingDigest([b, a]));
  });
  test("changes when a bound acceptedResultId changes (stale-input detectable)", () => {
    expect(computeInputBindingDigest([ib({ acceptedResultId: "job/C/a1/r1" })]))
      .not.toBe(computeInputBindingDigest([ib({ acceptedResultId: "job/C/a2/r1" })]));
  });
});

describe("binding tri-state (§2.3)", () => {
  test("open / closing / closed derived from fields", () => {
    expect(bindingState(bind())).toBe("open");
    expect(bindingState(bind({ closing: { cutoffTip: "tip1" } }))).toBe("closing");
    expect(bindingState(bind({ closing: { cutoffTip: "tip1" }, closedAtSeq: SEQ + 5 }))).toBe("closed");
  });
  test("open: any candidate on this branch is eligible", () => {
    expect(candidateEligibility(bind(), false).eligible).toBe(true);
  });
  test("closing: within cutoffTip ancestry eligible, beyond is peer-late", () => {
    const b = bind({ closing: { cutoffTip: "cut1" } });
    expect(candidateEligibility(b, true).eligible).toBe(true);
    const out = candidateEligibility(b, false);
    expect(out.eligible).toBe(false);
    expect(/peer-late/.test(out.reason)).toBe(true);
  });
  test("closing empty: nothing eligible (clean-fail / branch confirmed absent)", () => {
    const b = bind({ closing: { cutoffTip: "empty" } });
    expect(candidateEligibility(b, true).eligible).toBe(false); // even if caller miscomputes ancestry, empty wins
  });
  test("closed: only candidates registered before close (within cutoffTip ancestry) count", () => {
    const b = bind({ closing: { cutoffTip: "cut1" }, closedAtSeq: SEQ + 5 });
    expect(candidateEligibility(b, true).eligible).toBe(true);
    expect(candidateEligibility(b, false).eligible).toBe(false);
  });
});

describe("binding record transitions (pure, immutable)", () => {
  test("activateBinding sets activatedAtSeq without mutating input", () => {
    const b = bind();
    const a = activateBinding(b, SEQ + 1);
    expect(a.activatedAtSeq).toBe(SEQ + 1);
    expect(b.activatedAtSeq).toBeUndefined();
  });
  test("beginClosing sets cutoffTip; finishClosing sets closedAtSeq", () => {
    const closing = beginClosing(bind(), "cut1");
    expect(closing.closing?.cutoffTip).toBe("cut1");
    expect(closing.closedAtSeq).toBeUndefined();
    const closed = finishClosing(closing, SEQ + 9);
    expect(closed.closedAtSeq).toBe(SEQ + 9);
  });
  test("finishClosing on a binding that never entered closing throws (cutoffTip must be pinned first)", () => {
    expect(() => finishClosing(bind(), SEQ + 9)).toThrow();
  });
});

describe("createAttempt", () => {
  test("starts RUNNING, retriesUsed 0, one binding, digest set", () => {
    const a = mkAttempt();
    expect(a.status).toBe("RUNNING");
    expect(a.retriesUsed).toBe(0);
    expect(a.executionBindings).toHaveLength(1);
    expect(a.attemptId).toBe("job/P/a1");
    expect(a.inputBindingDigest).toBe(computeInputBindingDigest([ib()]));
  });
});

describe("advanceAttempt (§3.1)", () => {
  test("observed: RUNNING -> RESULT_PENDING_VALIDATION; idempotent from RPV; illegal from terminal", () => {
    const r = advanceAttempt(mkAttempt(), { type: "observed" }, 1000);
    expect(r.ok && r.attempt.status === "RESULT_PENDING_VALIDATION").toBe(true);
    const rpv = r.ok ? r.attempt : mkAttempt();
    expect(advanceAttempt(rpv, { type: "observed" }, 1000).ok).toBe(true); // another candidate observed, no change
    const done = { ...rpv, status: "SUCCEEDED" as const };
    expect(advanceAttempt(done, { type: "observed" }, 1000).ok).toBe(false);
  });
  test("accepted: RPV -> SUCCEEDED (clears failureClass); illegal from RUNNING", () => {
    const rpv = { ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" as const, failureClass: "inconsistent-snapshot" as const };
    const r = advanceAttempt(rpv, { type: "accepted" }, 1000);
    expect(r.ok && r.attempt.status === "SUCCEEDED" && r.attempt.failureClass === undefined).toBe(true);
    expect(advanceAttempt(mkAttempt(), { type: "accepted" }, 1000).ok).toBe(false);
  });
  test("business_fail under budget -> RETRY_WAIT, retriesUsed+1 (THE single count point), retryAt = now+min(60*2^n,1800)+jitter", () => {
    const rpv = { ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" as const, retriesUsed: 0 };
    const r = advanceAttempt(rpv, { type: "business_fail", retryBudget: 2, jitterSec: 7 }, 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempt.status).toBe("RETRY_WAIT");
      expect(r.attempt.retriesUsed).toBe(1);
      expect(r.attempt.failureClass).toBe("business-fail");
      expect(r.attempt.retryAt).toBe(1000 + 120 + 7); // 60*2^1
    }
  });
  test("business_fail over budget -> FAILED (terminal), retriesUsed incremented for audit", () => {
    const rpv = { ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" as const, retriesUsed: 2 };
    const r = advanceAttempt(rpv, { type: "business_fail", retryBudget: 2 }, 1000);
    expect(r.ok && r.attempt.status === "FAILED" && r.attempt.retriesUsed === 3 && r.attempt.failureClass === "business-fail").toBe(true);
  });
  test("transient_infra: RUNNING -> RETRY_WAIT, retriesUsed UNCHANGED, retryAt = now+60+jitter", () => {
    const r = advanceAttempt(mkAttempt(), { type: "transient_infra", jitterSec: 5 }, 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempt.status).toBe("RETRY_WAIT");
      expect(r.attempt.retriesUsed).toBe(0); // NOT charged
      expect(r.attempt.failureClass).toBe("transient-infra");
      expect(r.attempt.retryAt).toBe(1000 + 60 + 5);
    }
    expect(advanceAttempt({ ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" }, { type: "transient_infra" }, 1000).ok).toBe(false);
  });
  test("stale (V4/V5): RPV -> ABANDONED, retriesUsed UNCHANGED, abandonReason records which", () => {
    const rpv = { ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" as const, retriesUsed: 1 };
    const si = advanceAttempt(rpv, { type: "stale", which: "input" }, 1000);
    expect(si.ok && si.attempt.status === "ABANDONED" && si.attempt.retriesUsed === 1 && si.attempt.failureClass === "stale" && si.attempt.abandonReason === "stale-input").toBe(true);
    const sp = advanceAttempt(rpv, { type: "stale", which: "plan" }, 1000);
    expect(sp.ok && sp.attempt.abandonReason === "stale-plan").toBe(true);
  });
  test("inconsistent_snapshot: RPV -> RUNNING (wait for a consistent snapshot), retriesUsed UNCHANGED", () => {
    const rpv = { ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" as const, retriesUsed: 1 };
    const r = advanceAttempt(rpv, { type: "inconsistent_snapshot" }, 1000);
    expect(r.ok && r.attempt.status === "RUNNING" && r.attempt.retriesUsed === 1).toBe(true);
  });
  test("permanent: RPV -> FAILED", () => {
    const rpv = { ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" as const };
    const r = advanceAttempt(rpv, { type: "permanent" }, 1000);
    expect(r.ok && r.attempt.status === "FAILED" && r.attempt.failureClass === "permanent").toBe(true);
  });
  test("revoke (F1 / supersede-cascade #2): RUNNING + never-activated binding -> ABANDONED, retriesUsed unchanged", () => {
    const a = mkAttempt(); // firstBinding has no activatedAtSeq
    const f1 = advanceAttempt(a, { type: "revoke", reason: "intent-revoked" }, 1000);
    expect(f1.ok && f1.attempt.status === "ABANDONED" && f1.attempt.abandonReason === "intent-revoked" && f1.attempt.retriesUsed === 0).toBe(true);
    const si = advanceAttempt(a, { type: "revoke", reason: "stale-input" }, 1000);
    expect(si.ok && si.attempt.abandonReason === "stale-input").toBe(true);
  });
  test("revoke rejected once a binding has been activated (live execution goes the closing route, not revoke)", () => {
    const a = createAttempt({ jobId: "job", nodeId: "P", n: 1, planRevision: 1, specDigest: "sd", inputBindings: [ib()], firstBinding: activateBinding(bind(), SEQ + 1), createdAtSeq: SEQ });
    expect(advanceAttempt(a, { type: "revoke", reason: "intent-revoked" }, 1000).ok).toBe(false);
  });
  test("revoke illegal from RPV (that is the stale route)", () => {
    expect(advanceAttempt({ ...mkAttempt(), status: "RESULT_PENDING_VALIDATION" }, { type: "revoke", reason: "stale-input" }, 1000).ok).toBe(false);
  });
});

describe("handoff continuation (X2, §3.2) — T1 acceptance", () => {
  test("add_binding keeps attemptId, status, retriesUsed; appends to the binding chain", () => {
    const a = mkAttempt();
    const b1 = bind({ bindingId: bindingIdOf(a.attemptId, 1), launchId: "rw-2", publishGeneration: 1, continuationOf: a.executionBindings[0]!.bindingId, openedAtSeq: SEQ + 10 });
    const r = advanceAttempt(a, { type: "add_binding", binding: b1 }, 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempt.attemptId).toBe(a.attemptId);           // attemptId UNCHANGED across VM continuation
      expect(r.attempt.status).toBe("RUNNING");
      expect(r.attempt.retriesUsed).toBe(0);                   // normal handoff is NOT a business failure
      expect(r.attempt.executionBindings).toHaveLength(2);     // chain +1
      expect(r.attempt.executionBindings[1]!.continuationOf).toBe(a.executionBindings[0]!.bindingId);
    }
  });
  test("add_binding illegal once the attempt has left active states", () => {
    expect(advanceAttempt({ ...mkAttempt(), status: "RETRY_WAIT" }, { type: "add_binding", binding: bind() }, 1000).ok).toBe(false);
  });
});

describe("retry succession — ABANDONED(retry-succession), NOT FAILED; no double-count (v2-P2-3)", () => {
  test("succession inherits retriesUsed as-is and abandons the old attempt as retry-succession", () => {
    const old = { ...mkAttempt(), status: "RETRY_WAIT" as const, retriesUsed: 1 };
    const out = makeSuccessionAttempt(old, { n: 2, specDigest: "sd", inputBindings: [ib()], firstBinding: bind({ bindingId: "job/P/a2/b0" }), createdAtSeq: SEQ + 20 });
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(out.next.attemptId).toBe("job/P/a2");
      expect(out.next.status).toBe("RUNNING");
      expect(out.next.retriesUsed).toBe(1);                  // inherited, NOT +1
      expect(out.abandonedOld.status).toBe("ABANDONED");     // NOT FAILED (FAILED is terminal only)
      expect(out.abandonedOld.abandonReason).toBe("retry-succession");
    }
  });
  test("succession only from RETRY_WAIT", () => {
    const out = makeSuccessionAttempt(mkAttempt(), { n: 2, specDigest: "sd", inputBindings: [ib()], firstBinding: bind(), createdAtSeq: SEQ + 20 });
    expect("error" in out).toBe(true);
  });
  test("retryBudget=2 yields exactly initial + 2 business retries, FAILED on the 3rd business-fail (single count point)", () => {
    const budget = 2;
    let n = 1;
    let a = mkAttempt({ n });
    const ranAttempts: string[] = [a.attemptId];
    const sequence: number[] = [];
    for (let i = 0; i < 5; i++) {
      a = { ...a, status: "RESULT_PENDING_VALIDATION" };
      const bf = advanceAttempt(a, { type: "business_fail", retryBudget: budget }, 1000);
      expect(bf.ok).toBe(true);
      if (!bf.ok) break;
      a = bf.attempt;
      sequence.push(a.retriesUsed);
      if (a.status === "FAILED") break;
      // RETRY_WAIT -> succession
      n += 1;
      const succ = makeSuccessionAttempt(a, { n, specDigest: "sd", inputBindings: [ib()], firstBinding: bind({ bindingId: `job/P/a${n}/b0` }), createdAtSeq: SEQ + n });
      expect("error" in succ).toBe(false);
      if ("error" in succ) break;
      a = succ.next;
      ranAttempts.push(a.attemptId);
      expect(a.retriesUsed).toBe(sequence[sequence.length - 1]); // succession inherits, no extra charge
    }
    expect(ranAttempts).toEqual(["job/P/a1", "job/P/a2", "job/P/a3"]); // initial + 2 retries
    expect(a.status).toBe("FAILED");
    expect(sequence).toEqual([1, 2, 3]); // charged once per business-fail, FAILED when it would exceed budget
  });
});
