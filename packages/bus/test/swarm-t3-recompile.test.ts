import { describe, expect, test } from "vitest";
import { translateDraft, type Draft, type DraftTask, type FrozenContext } from "../src/swarm/task-translate.js";
import { clarifyTargets, canonicalAnswerSet, mintPlanOperationId, projectAnswers, recompilePlan, type ClarificationAnswer } from "../src/swarm/plan-recompile.js";

// T3b recompile loop + deterministic operationId (design 1d0a1ffc §1; coordinator points 3+4).

function fc(over: Partial<FrozenContext> = {}): FrozenContext {
  return {
    checkRegistry: { version: "cr1", checks: { testsPass: {} } },
    ownerDomainPolicy: { version: "op1", ownerByPrefix: [{ prefix: "packages/bus/src/swarm/", domain: "pure" }, { prefix: "scripts/", domain: "io" }], frozenScopePrefixes: ["docs/swarm/"] },
    // two undecidable subtrees, each UNDER a role fileDomain so a resolved answer can reach loadable (not needsRole):
    riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: ["packages/bus/src/swarm/exp/", "scripts/exp/"] },
    roleCatalog: { version: "rc1", roles: { "pure-layer-impl": { floor: "standard", fileDomain: ["packages/bus/src/swarm/"] }, "io-impl": { floor: "standard", fileDomain: ["scripts/"] } } },
    budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
    r4ThresholdPolicy: { version: "tp1", maxTotalComplexity: 1000 },
    sourceBaselineDigest: "base-abc",
    planningRequestId: "req-1",
    ...over,
  };
}
function task(over: Partial<DraftTask> = {}): DraftTask {
  return { nodeId: "M", kind: "work", goal: "g", dependsOn: [], structuredChecks: [{ check: "testsPass" }], freeTextNotes: [], complexity: 5, requiredOutputs: [{ logicalName: "o", kind: "report" }], artifactScope: ["out/"], ...over };
}
const draft = (tasks: DraftTask[], jobId = "job1"): Draft => ({ jobId, tasks });

// a single critical unknown-risk node whose scope sits under a role fileDomain (so clarifying can reach loadable)
const critNode = task({ nodeId: "A", sourceWriteScope: ["packages/bus/src/swarm/exp/a.ts"], criticalPath: true });
const twoCrit = draft([
  task({ nodeId: "A", sourceWriteScope: ["packages/bus/src/swarm/exp/a.ts"], criticalPath: true }),
  task({ nodeId: "B", sourceWriteScope: ["scripts/exp/b.ts"], criticalPath: true, dependsOn: [] }),
]);

describe("clarifyTargets pins translateDraft's questionIds (no drift)", () => {
  test("single critical unknown node", () => {
    const d = draft([critNode]);
    const base = translateDraft(d, fc());
    expect(base.outcome).toBe("needsClarification");
    const emitted = base.outcome === "needsClarification" ? base.questions.map((q) => q.questionId) : [];
    expect(clarifyTargets(d, fc()).map((t) => t.questionId)).toEqual(emitted);
  });
  test("multiple critical unknown nodes — order + global counter match", () => {
    const base = translateDraft(twoCrit, fc());
    const emitted = base.outcome === "needsClarification" ? base.questions.map((q) => q.questionId) : [];
    const mine = clarifyTargets(twoCrit, fc());
    expect(mine.map((t) => t.questionId)).toEqual(emitted);
    expect(mine.map((t) => t.nodeId)).toEqual(["A", "B"]);
  });
});

describe("recompile: answers materialize into a fresh translate", () => {
  test("all reversible -> loadable, no design gate, with a minted operationId", () => {
    const d = draft([critNode]);
    const targets = clarifyTargets(d, fc());
    const answers: ClarificationAnswer[] = targets.map((t) => ({ questionId: t.questionId, reversible: true }));
    const r = recompilePlan({ draft: d, fc: fc(), answers, snapshotDigest: "snap-1" });
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(r.plan.nodes.some((n) => n.kind === "design")).toBe(false); // reversible => no gate
    expect(r.operationId).toMatch(/^[0-9a-f]{64}$/);
  });
  test("an irreversible answer -> loadable WITH a design gate (safe)", () => {
    const d = draft([critNode]);
    const targets = clarifyTargets(d, fc());
    const answers: ClarificationAnswer[] = targets.map((t) => ({ questionId: t.questionId, reversible: false }));
    const r = recompilePlan({ draft: d, fc: fc(), answers, snapshotDigest: "snap-1" });
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(r.plan.nodes.some((n) => n.kind === "design")).toBe(true);
  });
  test("incomplete answer set -> stays needsClarification, lists the unanswered (safe default)", () => {
    const targets = clarifyTargets(twoCrit, fc());
    const answers: ClarificationAnswer[] = [{ questionId: targets[0]!.questionId, reversible: true }]; // answer only A
    const r = recompilePlan({ draft: twoCrit, fc: fc(), answers, snapshotDigest: "snap-2" });
    expect(r.outcome).toBe("needsClarification");
    if (r.outcome !== "needsClarification") return;
    expect(r.unanswered).toEqual([targets[1]!.questionId]);
  });
  test("recompiling something not awaiting clarification -> rejected", () => {
    const d = draft([task({ nodeId: "A", sourceWriteScope: ["packages/bus/src/swarm/plain.ts"], roleProfile: "pure-layer-impl" })]);
    const r = recompilePlan({ draft: d, fc: fc(), answers: [], snapshotDigest: "s" });
    expect(r.outcome).toBe("rejected");
  });
  test("missing planningRequestId -> rejected (cannot mint)", () => {
    const d = draft([critNode]);
    const answers = clarifyTargets(d, fc()).map((t) => ({ questionId: t.questionId, reversible: true }));
    const r = recompilePlan({ draft: d, fc: fc({ planningRequestId: undefined }), answers, snapshotDigest: "s" });
    expect(r.outcome).toBe("rejected");
  });
  test("projectAnswers never mutates the original frozenContext", () => {
    const base = fc();
    const d = draft([critNode]);
    const answers = clarifyTargets(d, base).map((t) => ({ questionId: t.questionId, reversible: true }));
    const before = JSON.stringify(base.riskPolicy);
    projectAnswers(d, base, answers);
    expect(JSON.stringify(base.riskPolicy)).toBe(before); // immutable snapshot
  });
});

describe("operationId minting is deterministic + request-scoped (op-conflict trap)", () => {
  const d = draft([critNode]);
  const answers = () => clarifyTargets(d, fc()).map((t) => ({ questionId: t.questionId, reversible: true }));
  const op = (over: Partial<FrozenContext>, snap = "snap", ans = answers()) => {
    const r = recompilePlan({ draft: d, fc: fc(over), answers: ans, snapshotDigest: snap });
    return r.outcome === "loadable" ? r.operationId : "N/A";
  };
  test("same request + same answers + same snapshot => same id (benign replay)", () => {
    expect(op({})).toBe(op({}));
  });
  test("different planningRequestId => different id (same content must not collide)", () => {
    expect(op({ planningRequestId: "req-1" })).not.toBe(op({ planningRequestId: "req-2" }));
  });
  test("different snapshot => different id", () => {
    expect(op({}, "snap-a")).not.toBe(op({}, "snap-b"));
  });
  test("different answer set => different id", () => {
    const a1 = clarifyTargets(d, fc()).map((t) => ({ questionId: t.questionId, reversible: true }));
    const a2 = clarifyTargets(d, fc()).map((t) => ({ questionId: t.questionId, reversible: false }));
    // a2 produces a gate but is still loadable; its answer digest differs => different op id
    expect(op({}, "snap", a1)).not.toBe(op({}, "snap", a2));
  });
  test("mintPlanOperationId throws without a planningRequestId", () => {
    expect(() => mintPlanOperationId({ planningRequestId: "", entityKey: "e", actionKind: "plan", snapshotDigest: "s", canonicalAnswerSetDigest: "a" })).toThrow();
  });
});

describe("canonicalAnswerSet", () => {
  test("sorts by questionId and keeps the highest-casSeq winner", () => {
    const set = canonicalAnswerSet([
      { questionId: "q-b", reversible: true },
      { questionId: "q-a", reversible: false, casSeq: 1 },
      { questionId: "q-a", reversible: true, casSeq: 2 }, // later CAS wins
    ]);
    expect(set).toEqual([{ questionId: "q-a", reversible: true }, { questionId: "q-b", reversible: true }]);
  });
});
