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
  test("sorts by questionId and the HIGHEST casSeq wins (order-independent)", () => {
    const r = canonicalAnswerSet([
      { questionId: "q-b", reversible: true },
      { questionId: "q-a", reversible: false, casSeq: 1 },
      { questionId: "q-a", reversible: true, casSeq: 2 }, // higher CAS wins regardless of array position
    ]);
    expect(r.ok && r.set).toEqual([{ questionId: "q-a", reversible: true }, { questionId: "q-b", reversible: true }]);
  });
  test("a tie at the top casSeq with opposing answers is REJECTED (no order-picked winner) [P1-3]", () => {
    const r = canonicalAnswerSet([{ questionId: "q", reversible: true, casSeq: 5 }, { questionId: "q", reversible: false, casSeq: 5 }]);
    expect(r.ok).toBe(false);
  });
  test("invalid answers (missing/null/string/number reversible) are dropped, not treated as answered [P1-3]", () => {
    const r = canonicalAnswerSet([
      { questionId: "q1", reversible: "false" as unknown as boolean },
      { questionId: "q2", reversible: 0 as unknown as boolean },
      { questionId: "q3", reversible: undefined as unknown as boolean },
      { questionId: "q4", reversible: true },
    ]);
    expect(r.ok && r.set.map((a) => a.questionId)).toEqual(["q4"]); // only the strict-boolean one survives
  });
});

describe("reviewer counterexamples (bccf629 round)", () => {
  function riskFc(over: Partial<FrozenContext> = {}): FrozenContext {
    return fc({ riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: ["src/exp/"] }, roleCatalog: { version: "rc1", roles: { impl: { floor: "standard", fileDomain: ["src/"] } } }, ownerDomainPolicy: { version: "op1", ownerByPrefix: [{ prefix: "src/", domain: "d" }], frozenScopePrefixes: [] }, ...over });
  }
  const ab = (): Draft => draft([
    task({ nodeId: "A", sourceWriteScope: ["src/exp/shared.ts"], criticalPath: true }),
    task({ nodeId: "B", sourceWriteScope: ["src/exp/shared.ts"], criticalPath: true }),
  ]);
  const answersFor = (d: Draft, f: FrozenContext, rev: (nodeId: string) => boolean): ClarificationAnswer[] =>
    clarifyTargets(d, f).map((t) => ({ questionId: t.questionId, reversible: rev(t.nodeId) }));

  test("P1-1: same-path, A=irreversible B=reversible -> GATE both orders (no order-dependent downgrade)", () => {
    const d = ab(), f = riskFc();
    const forward = recompilePlan({ draft: d, fc: f, answers: answersFor(d, f, (n) => n !== "A"), snapshotDigest: "s" });
    const reverse = recompilePlan({ draft: d, fc: f, answers: [...answersFor(d, f, (n) => n !== "A")].reverse(), snapshotDigest: "s" });
    expect(forward.outcome === "loadable" && forward.plan.nodes.some((n) => n.kind === "design")).toBe(true);
    expect(reverse.outcome === "loadable" && reverse.plan.nodes.some((n) => n.kind === "design")).toBe(true);
  });
  test("P1-1 control: same-path both reversible -> loadable, no gate", () => {
    const d = ab(), f = riskFc();
    const r = recompilePlan({ draft: d, fc: f, answers: answersFor(d, f, () => true), snapshotDigest: "s" });
    expect(r.outcome === "loadable" && !r.plan.nodes.some((n) => n.kind === "design")).toBe(true);
  });
  test("P2-1: an answered critical node keeps its criticalPath; an unanswered non-critical sibling keeps the gate", () => {
    const d = draft([
      task({ nodeId: "A", sourceWriteScope: ["src/exp/a.ts"], criticalPath: true }),
      task({ nodeId: "B", sourceWriteScope: ["src/exp/b.ts"] }), // non-critical => not asked
    ]);
    const f = riskFc();
    const r = recompilePlan({ draft: d, fc: f, answers: answersFor(d, f, () => true), snapshotDigest: "s" });
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const a = r.plan.nodes.find((n) => n.nodeId === "A");
    expect(a?.criticalPath).toBe(true); // declaration preserved, NOT forged to false
    expect(r.plan.nodes.some((n) => n.kind === "design")).toBe(true); // B keeps the gate
    expect(r.projectedDraft.tasks.find((t) => t.nodeId === "A")?.criticalPath).toBe(true);
  });
  test("P1-2: two drafts, same answer, different paths -> DIFFERENT projected C' version (no content aliasing)", () => {
    const f = riskFc();
    const da = draft([task({ nodeId: "A", sourceWriteScope: ["src/exp/a.ts"], criticalPath: true })]);
    const db = draft([task({ nodeId: "A", sourceWriteScope: ["src/exp/b.ts"], criticalPath: true })]);
    const ra = recompilePlan({ draft: da, fc: f, answers: answersFor(da, f, () => false), snapshotDigest: "s" });
    const rb = recompilePlan({ draft: db, fc: f, answers: answersFor(db, f, () => false), snapshotDigest: "s" });
    expect(ra.outcome === "loadable" && rb.outcome === "loadable").toBe(true);
    if (ra.outcome !== "loadable" || rb.outcome !== "loadable") return;
    expect(ra.projectedFc.riskPolicy.version).not.toBe(rb.projectedFc.riskPolicy.version);
  });
  test("P1-3 at the recompile boundary: a conflicting answer set -> rejected", () => {
    const d = ab(), f = riskFc();
    const ts = clarifyTargets(d, f);
    const answers: ClarificationAnswer[] = [{ questionId: ts[0]!.questionId, reversible: true, casSeq: 1 }, { questionId: ts[0]!.questionId, reversible: false, casSeq: 1 }, ...ts.slice(1).map((t) => ({ questionId: t.questionId, reversible: true }))];
    expect(recompilePlan({ draft: d, fc: f, answers, snapshotDigest: "s" }).outcome).toBe("rejected");
  });
});
