import { describe, expect, test } from "vitest";
import { commit, initialLogState, type Change } from "../src/swarm/control-log.js";
import { openWait, openQueryWait, applyDefaultOnTimeout, advanceWait, isGranted } from "../src/swarm/task-wait.js";
import { translateDraft, type Draft, type DraftTask, type FrozenContext } from "../src/swarm/task-translate.js";
import { clarifyTargets, recompilePlan, type ClarificationAnswer } from "../src/swarm/plan-recompile.js";

// T3b structural guards (design 1d0a1ffc §1 "两条既有守卫 ... 实施测试钉住" + coordinator point 5). These guards already
// exist (T3a/bus); this file pins them to the T3b minting/recompile so a future change that weakens either breaks here.

// ---- Guard 1: default-close != gate grant. isGranted admits ONLY a matching granted approval; a query-wait never. ----
describe("guard 1: a closed/timed-out query-wait is NOT admission", () => {
  const subject = { jobId: "job1" };
  const def = { outcome: "default-applied", reason: "no answer in time", sourceOperationId: "op-default" };

  test("a query-wait (kind=wait) is never granted — even after the default is applied on timeout", () => {
    const w = openQueryWait({ waitId: "w1", subject, deadlineSec: 100, owner: "coord", defaultOnTimeout: def, payloadRef: "a".repeat(64) });
    expect(isGranted(w, "any-digest")).toBe(false); // open query-wait
    const closed = applyDefaultOnTimeout(w);
    expect(closed.ok).toBe(true);
    if (closed.ok) expect(isGranted(closed.wait, "any-digest")).toBe(false); // resolved-by-default is STILL not a grant
  });

  test("only a granted approval with a matching paramsDigest admits", () => {
    const a = openWait({ waitId: "w2", kind: "approval", subject, deadlineSec: 100, owner: "coord", timeoutPolicy: "escalate", actionRef: "act1", paramsDigest: "digestX" });
    expect(isGranted(a, "digestX")).toBe(false); // pending
    const granted = advanceWait(a, { type: "decide", decision: "granted", grantRef: "g1" });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(isGranted(granted.wait, "digestX")).toBe(true); // granted + matching digest
    expect(isGranted(granted.wait, "OTHER")).toBe(false); // granted but wrong params => not admission
    const denied = advanceWait(a, { type: "decide", decision: "denied" });
    if (denied.ok) expect(isGranted(denied.wait, "digestX")).toBe(false);
  });
});

// ---- Guard 2: a re-submitted recompile is a REPLAY no-op, not an op-conflict (the minted operationId makes this safe). ----
describe("guard 2: deterministic operationId => replay no-op (never a duplicate commit)", () => {
  function fc(over: Partial<FrozenContext> = {}): FrozenContext {
    return {
      checkRegistry: { version: "cr1", checks: { testsPass: {} } },
      ownerDomainPolicy: { version: "op1", ownerByPrefix: [{ prefix: "packages/bus/src/swarm/", domain: "pure" }], frozenScopePrefixes: [] },
      riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: ["packages/bus/src/swarm/exp/"] },
      roleCatalog: { version: "rc1", roles: { "pure-layer-impl": { floor: "standard", fileDomain: ["packages/bus/src/swarm/"] } } },
      budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
      r4ThresholdPolicy: { version: "tp1", maxTotalComplexity: 1000 },
      sourceBaselineDigest: "base",
      planningRequestId: "req-1",
      ...over,
    };
  }
  const critTask: DraftTask = { nodeId: "A", kind: "work", goal: "g", dependsOn: [], structuredChecks: [{ check: "testsPass" }], freeTextNotes: [], complexity: 5, requiredOutputs: [{ logicalName: "o", kind: "report" }], artifactScope: ["out/"], sourceWriteScope: ["packages/bus/src/swarm/exp/a.ts"], criticalPath: true };
  const d: Draft = { jobId: "job1", tasks: [critTask] };
  const answers = (): ClarificationAnswer[] => clarifyTargets(d, fc()).map((t) => ({ questionId: t.questionId, reversible: true }));
  const planOf = (over: Partial<FrozenContext> = {}) => {
    const r = recompilePlan({ draft: d, fc: fc(over), answers: answers(), snapshotDigest: "snap-1" });
    if (r.outcome !== "loadable") throw new Error("expected loadable: " + JSON.stringify(r));
    return r;
  };
  const change = (p: ReturnType<typeof planOf>): Change => ({ put: "plan", plan: p.plan, operationId: p.operationId, expectedEntityRevision: 0 });

  test("first commit applies; the identical recompile re-commits as a replay no-op", () => {
    const p = planOf();
    const first = commit(initialLogState(), 0, [change(p)]);
    expect(first.result.ok && first.result.replay).toBe(false);
    // identical recompile => identical operationId + identical plan => replay
    const p2 = planOf();
    expect(p2.operationId).toBe(p.operationId);
    const second = commit(first.state, first.result.ok ? first.result.newSeq : 0, [change(p2)]);
    expect(second.result.ok && second.result.replay).toBe(true);
  });

  test("same operationId with a DIFFERENT payload => op-conflict (freeze), not a silent overwrite", () => {
    const p = planOf();
    const first = commit(initialLogState(), 0, [change(p)]);
    const tampered: Change = { put: "plan", plan: { ...p.plan, planRevision: p.plan.planRevision + 1 }, operationId: p.operationId, expectedEntityRevision: 0 };
    const conflict = commit(first.state, first.result.ok ? first.result.newSeq : 0, [tampered]);
    expect(conflict.result.ok).toBe(false);
    if (!conflict.result.ok) expect(conflict.result.reason).toBe("op-conflict");
  });

  test("a different request round mints a different id => a NEW op, not a replay/conflict", () => {
    const p1 = planOf({ planningRequestId: "req-1" });
    const p2 = planOf({ planningRequestId: "req-2" });
    expect(p2.operationId).not.toBe(p1.operationId);
    const first = commit(initialLogState(), 0, [change(p1)]);
    const second = commit(first.state, first.result.ok ? first.result.newSeq : 0, [change(p2)]);
    expect(second.result.ok && second.result.replay).toBe(false); // new op applies cleanly
  });
});
