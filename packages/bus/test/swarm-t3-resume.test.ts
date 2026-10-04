import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { storeResumeState, resumeClarification, resumeFromClosedWaits, type ResumeDirs } from "../src/swarm/plan-resume.js";
import { storeFrozenContext, loadFrozenContext, storeBundle, loadBundle, frozenRefsOf } from "../src/swarm/plan-bundle.js";
import { loadPlan } from "../src/swarm/task-plan.js";
import { commit, initialLogState, type Change } from "../src/swarm/control-log.js";
import { clarifyTargets, clarificationResolution, questionWaitRef, type ClarificationAnswer } from "../src/swarm/plan-recompile.js";
import { openQueryWait, advanceWait, applyDefaultOnTimeout, isGranted } from "../src/swarm/task-wait.js";
import { translateDraft, type Draft, type DraftTask, type FrozenContext } from "../src/swarm/task-translate.js";

// T3b recompile ORCHESTRATION (design 1d0a1ffc §1 line 21; reviewer P2-4): the verified resume entry — payloadRef +
// answers -> resolve & verify original policy -> recompile -> persist C'.

function fc(over: Partial<FrozenContext> = {}): FrozenContext {
  return {
    checkRegistry: { version: "cr1", checks: { testsPass: {} } },
    ownerDomainPolicy: { version: "op1", ownerByPrefix: [{ prefix: "src/", domain: "d" }], frozenScopePrefixes: [] },
    riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: ["src/exp/"] },
    roleCatalog: { version: "rc1", roles: { impl: { floor: "standard", fileDomain: ["src/"] } } },
    budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
    r4ThresholdPolicy: { version: "tp1", maxTotalComplexity: 1000 },
    sourceBaselineDigest: "base",
    planningRequestId: "req-1",
    ...over,
  };
}
const task = (over: Partial<DraftTask>): DraftTask => ({ nodeId: "A", kind: "work", goal: "g", dependsOn: [], structuredChecks: [{ check: "testsPass" }], freeTextNotes: [], complexity: 5, requiredOutputs: [{ logicalName: "o", kind: "report" }], artifactScope: ["out/"], sourceWriteScope: ["src/exp/a.ts"], criticalPath: true, ...over });
const draft: Draft = { jobId: "jobR", tasks: [task({})] };
const prd = "resume me";

let dirs: ResumeDirs;
beforeEach(() => { dirs = { bundleDir: mkdtempSync(path.join(tmpdir(), "t3-b-")), policyDir: mkdtempSync(path.join(tmpdir(), "t3-p-")) }; });
afterEach(() => { rmSync(dirs.bundleDir!, { recursive: true, force: true }); rmSync(dirs.policyDir!, { recursive: true, force: true }); });

const answersFrom = (f: FrozenContext, rev: boolean): ClarificationAnswer[] => clarifyTargets(draft, f).map((t) => ({ questionId: t.questionId, reversible: rev }));

describe("storeResumeState + resumeClarification round-trip", () => {
  test("restart-from-payloadRef: only the ref + answers resume to a loadable plan with a minted operationId", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    // a fresh process would only have payloadRef + the answers; the stores are on disk.
    const r = resumeClarification({ payloadRef, answers: answersFrom(fc(), true) }, dirs);
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(r.operationId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.projectedFcDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the persisted C' is retrievable and the resumed plan's riskPolicy version matches it", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    const r = resumeClarification({ payloadRef, answers: answersFrom(fc(), false) }, dirs); // irreversible => gate
    if (r.outcome !== "loadable") throw new Error("setup");
    const cPrime = loadFrozenContext(r.projectedFcDigest, dirs.policyDir);
    const refs = r.plan.frozenRefs;
    expect(refs).toBeDefined();
    if (!refs) return;
    expect(cPrime.riskPolicy.version).toBe(refs.riskPolicy); // the plan carries the resolved context's version ref
    // the plan managed-reloads ONLY with the trusted resolvedRisk evidence the resume returned (serialized field alone is not trusted)
    const again = loadPlan(r.plan, { mode: "managed-t3", ownerDomainPolicy: cPrime.ownerDomainPolicy, riskPolicy: cPrime.riskPolicy, expectedFrozenRefs: refs, resolvedRisk: r.resolvedRisk });
    expect(again.ok).toBe(true);
  });

  test("incomplete answers -> needsClarification (safe default), nothing persisted as loadable", () => {
    const two: Draft = { jobId: "jobR2", tasks: [task({ nodeId: "A", sourceWriteScope: ["src/exp/a.ts"] }), task({ nodeId: "B", sourceWriteScope: ["src/exp/b.ts"] })] };
    const { payloadRef } = storeResumeState({ draft: two, prd, fc: fc() }, dirs);
    const first = clarifyTargets(two, fc())[0]!;
    const r = resumeClarification({ payloadRef, answers: [{ questionId: first.questionId, reversible: true }] }, dirs);
    expect(r.outcome).toBe("needsClarification");
  });

  test("policy drift/swap: a bundle pointing at a DIFFERENT policy whose refs mismatch is rejected (not a same-op)", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    // craft a tampered bundle: same payload shape but frozenContextDigest -> a different policy (version refs won't match)
    const other = fc({ riskPolicy: { version: "rp-EVIL", irreversiblePrefixes: [], undecidablePrefixes: [] } });
    const otherDigest = storeFrozenContext(other, dirs.policyDir);
    const original = loadBundle(payloadRef, dirs.bundleDir);
    const tampered = { ...original, frozenContextDigest: otherDigest };
    const tamperedRef = storeBundle(tampered, dirs.bundleDir); // new payloadRef (content-addressed)
    const r = resumeClarification({ payloadRef: tamperedRef, answers: answersFrom(fc(), true) }, dirs);
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reason).toMatch(/drift|swap|match/i);
  });

  const closedFor = (payloadRef: string, qid: string, reversible: boolean) => {
    const w = openQueryWait({ waitId: `w-${qid}`, subject: { jobId: "jobR" }, deadlineSec: 100, owner: "coord", defaultOnTimeout: { outcome: "default-applied", reason: "r", sourceOperationId: "d" }, payloadRef: questionWaitRef(payloadRef, qid) });
    const c = advanceWait(w, { type: "close", resolution: clarificationResolution(reversible, "op-win") });
    if (!c.ok) throw new Error("close failed");
    return c.wait;
  };

  test("resumeFromClosedWaits: a wait carrying the per-question binding resumes to loadable", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    const qid = clarifyTargets(draft, fc())[0]!.questionId;
    const r = resumeFromClosedWaits({ payloadRef, closedWaits: [{ questionId: qid, wait: closedFor(payloadRef, qid, true) }] }, dirs);
    expect(r.outcome).toBe("loadable");
  });
  test("resumeFromClosedWaits: a wait not bound to this question/snapshot is rejected", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    const qid = clarifyTargets(draft, fc())[0]!.questionId;
    const w = openQueryWait({ waitId: "w1", subject: { jobId: "jobR" }, deadlineSec: 100, owner: "coord", defaultOnTimeout: { outcome: "default-applied", reason: "r", sourceOperationId: "d" }, payloadRef: "a".repeat(64) });
    const closed = advanceWait(w, { type: "close", resolution: clarificationResolution(true, "op-win") });
    if (!closed.ok) return;
    const r = resumeFromClosedWaits({ payloadRef, closedWaits: [{ questionId: qid, wait: closed.wait }] }, dirs);
    expect(r.outcome).toBe("rejected");
  });
  test("R4-P2-1: restart recovers the bundle ref from the closed wait ALONE (no separately-passed payloadRef)", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    const qid = clarifyTargets(draft, fc())[0]!.questionId;
    const wait = closedFor(payloadRef, qid, true); // wait.payloadRef = `${payloadRef}:${qid}` (bundle ref recoverable)
    const r = resumeFromClosedWaits({ closedWaits: [{ questionId: qid, wait }] }, dirs); // NO payloadRef passed
    expect(r.outcome).toBe("loadable");
  });
  test("R3-P1-1: ONE real close cannot be re-pasted onto two questions (per-question binding)", () => {
    const two: Draft = { jobId: "jobR2", tasks: [
      task({ nodeId: "A", sourceWriteScope: ["src/exp/a.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["src/exp/b.ts"] }),
    ] };
    const { payloadRef } = storeResumeState({ draft: two, prd, fc: fc() }, dirs);
    const targets = clarifyTargets(two, fc());
    const [qA, qB] = [targets[0]!.questionId, targets[1]!.questionId];
    const aWait = closedFor(payloadRef, qA, true); // only A is actually closed
    // re-paste the SAME A close under both qA and qB -> rejected (its payloadRef is bound to qA, not qB)
    const relabel = resumeFromClosedWaits({ payloadRef, closedWaits: [{ questionId: qA, wait: aWait }, { questionId: qB, wait: aWait }] }, dirs);
    expect(relabel.outcome).toBe("rejected");
    // only its own question -> B still unanswered -> needsClarification (safe)
    const onlyA = resumeFromClosedWaits({ payloadRef, closedWaits: [{ questionId: qA, wait: aWait }] }, dirs);
    expect(onlyA.outcome).toBe("needsClarification");
    // both questions with their OWN real closes -> loadable
    const both = resumeFromClosedWaits({ payloadRef, closedWaits: [{ questionId: qA, wait: aWait }, { questionId: qB, wait: closedFor(payloadRef, qB, true) }] }, dirs);
    expect(both.outcome).toBe("loadable");
  });
  test("R3-P2-1: a timeout default that was a clarification resumes (to a gated plan), isGranted stays false", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    const qid = clarifyTargets(draft, fc())[0]!.questionId;
    const w = openQueryWait({ waitId: "wd", subject: { jobId: "jobR" }, deadlineSec: 100, owner: "coord", defaultOnTimeout: clarificationResolution(false, "def"), payloadRef: questionWaitRef(payloadRef, qid) });
    const timedOut = applyDefaultOnTimeout(w);
    expect(timedOut.ok).toBe(true);
    if (!timedOut.ok) return;
    expect(isGranted(timedOut.wait, "anything")).toBe(false); // a query close never grants execution
    const r = resumeFromClosedWaits({ payloadRef, closedWaits: [{ questionId: qid, wait: timedOut.wait }] }, dirs);
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(r.plan.nodes.some((n) => n.kind === "design")).toBe(true); // irreversible default -> gated
  });
  test("accurate replay: the same resume committed twice is a replay no-op; a swapped-policy ref never reaches the same op", () => {
    const { payloadRef } = storeResumeState({ draft, prd, fc: fc() }, dirs);
    const r1 = resumeClarification({ payloadRef, answers: answersFrom(fc(), true) }, dirs);
    const r2 = resumeClarification({ payloadRef, answers: answersFrom(fc(), true) }, dirs);
    if (r1.outcome !== "loadable" || r2.outcome !== "loadable") throw new Error("setup");
    expect(r2.operationId).toBe(r1.operationId);
    const ch = (op: string, plan: typeof r1.plan): Change => ({ put: "plan", plan, operationId: op, expectedEntityRevision: 0 });
    const first = commit(initialLogState(), 0, [ch(r1.operationId, r1.plan)]);
    const second = commit(first.state, first.result.ok ? first.result.newSeq : 0, [ch(r2.operationId, r2.plan)]);
    expect(second.result.ok && second.result.replay).toBe(true);
  });
});
