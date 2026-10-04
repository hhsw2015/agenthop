import { describe, expect, test } from "vitest";
import { translateDraft, plannerOperationTier, REQUIRED_REVIEW_CHECK, type Draft, type DraftTask, type FrozenContext } from "../src/swarm/task-translate.js";

// T3a translateDraft (frozen design 60c9ffa7): the 30-fixture behavioral spec mapped to C/D/E/G + the rejection matrix.

function fc(over: Partial<FrozenContext> = {}): FrozenContext {
  return {
    checkRegistry: { version: "cr1", checks: { fileExists: { requiredArgs: ["path"] }, testsPass: {} } },
    ownerDomainPolicy: {
      version: "op1",
      ownerByPrefix: [
        { prefix: "packages/bus/src/swarm/", domain: "pure" },
        { prefix: "scripts/", domain: "io" },
      ],
      frozenScopePrefixes: ["docs/swarm/"],
      irreversiblePrefixes: ["ops/prod/"],
    },
    roleCatalog: { version: "rc1", roles: { "pure-layer-impl": { floor: "standard" }, reviewer: { floor: "heavy" }, doc: {} } },
    budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
    sourceBaselineDigest: "base-abc",
    ...over,
  };
}
function task(over: Partial<DraftTask> = {}): DraftTask {
  return {
    nodeId: "M",
    kind: "work",
    goal: "do a thing",
    dependsOn: [],
    structuredChecks: [{ check: "testsPass" }],
    freeTextNotes: [],
    complexity: 5,
    requiredOutputs: [{ logicalName: "out", kind: "report" }],
    artifactScope: ["out/"],
    ...over,
  };
}
const draft = (tasks: DraftTask[], jobId = "job1"): Draft => ({ jobId, tasks });
const designOf = (r: Extract<ReturnType<typeof translateDraft>, { outcome: "loadable" }>) => r.plan.nodes.find((n) => n.kind === "design");

describe("C — draft degradation defense (reject whole, readable reason, no silent repair)", () => {
  test("missing jobId / empty tasks", () => {
    expect(translateDraft(draft([]), fc()).outcome).toBe("rejected");
    expect(translateDraft({ jobId: "", tasks: [task()] }, fc()).outcome).toBe("rejected");
  });
  test("a dependency cycle is rejected (loadPlan is the graph authority)", () => {
    const r = translateDraft(draft([task({ nodeId: "A", dependsOn: ["B"] }), task({ nodeId: "B", dependsOn: ["A"] })]), fc());
    expect(r.outcome === "rejected" && /cycle|loadPlan/.test(r.reason)).toBe(true);
  });
  test("empty acceptance (no structuredChecks AND no freeTextNotes) is rejected", () => {
    expect(translateDraft(draft([task({ structuredChecks: [], freeTextNotes: [] })]), fc()).outcome).toBe("rejected");
  });
});

describe("G — rejection matrix (reject vs conservative exit; original 18-fixture semantics preserved)", () => {
  test("AC-UNKNOWN: a check not in the registry is refused, not downgraded", () => {
    const r = translateDraft(draft([task({ structuredChecks: [{ check: "looksGood", args: {} }] })]), fc());
    expect(r.outcome === "rejected" && /looksGood|unknown/.test(r.reason)).toBe(true);
  });
  test("AC-PROSE: prose smuggled into structuredChecks (a non-{check} element) is rejected", () => {
    const r = translateDraft(draft([task({ structuredChecks: ["Reviewer judges nothing omitted" as unknown as { check: string }] })]), fc());
    expect(r.outcome === "rejected" && /structuredCheck|prose/.test(r.reason)).toBe(true);
  });
  test("AC-OBLIGATION-DROP: fileExists + prose keeps BOTH — the prose becomes a required review gate, not dropped", () => {
    const r = translateDraft(draft([task({ structuredChecks: [{ check: "fileExists", args: { path: "out/r.md" } }], freeTextNotes: ["an independent reviewer confirms I1-I7"] })]), fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const checks = r.plan.nodes[0]!.acceptance.map((a) => a.check);
    expect(checks).toContain("fileExists");
    expect(checks).toContain(REQUIRED_REVIEW_CHECK);
  });
  test("AC-REGISTRY-DOWNGRADE: a registry missing a once-valid check rejects and names it", () => {
    const downgraded = fc({ checkRegistry: { version: "cr0", checks: { fileExists: { requiredArgs: ["path"] } } } }); // testsPass removed
    const r = translateDraft(draft([task({ structuredChecks: [{ check: "testsPass" }] })]), downgraded);
    expect(r.outcome === "rejected" && /testsPass/.test(r.reason)).toBe(true);
  });
  test("a check missing a required arg is rejected", () => {
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "fileExists", args: {} }] })]), fc()).outcome).toBe("rejected");
  });
  test("R4-OWNER-SPOOF: two TRUSTED domains trigger a design gate even if the model would collapse them", () => {
    const r = translateDraft(draft([
      task({ nodeId: "A", sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome === "loadable") expect(designOf(r)).toBeDefined();
  });
  test("R4-FROZEN: a frozen-contract write forces design regardless of (ignored) model risk", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["docs/swarm/brain-design.md"] })]), fc());
    expect(r.outcome === "loadable" && designOf(r) !== undefined).toBe(true);
  });
  test("R4-UNKNOWN (risk known): unknown ownership, not irreversible -> conservative design gate (never bypass)", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["new/unmapped-module.ts"] })]), fc());
    expect(r.outcome === "loadable" && designOf(r) !== undefined).toBe(true);
  });
  test("R4-UNKNOWN (risk undecidable): unknown ownership on an irreversible path -> needsClarification, no plan", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["ops/prod/migrate.ts"] })]), fc());
    expect(r.outcome === "needsClarification" && r.questions.length > 0).toBe(true);
  });
  test("single trusted domain, nothing frozen/irreversible -> NO design gate (reverse positive)", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] })]), fc());
    expect(r.outcome === "loadable" && designOf(r) === undefined).toBe(true);
  });
  test("ROLE-UNKNOWN: a hallucinated role is needsRole, never silently default-dispatched", () => {
    const r = translateDraft(draft([task({ roleProfile: "all-purpose-super-owner" })]), fc());
    expect(r.outcome === "needsRole" && r.missingRoles.includes("all-purpose-super-owner")).toBe(true);
  });
  test("BUDGET-INVALID: out-of-range complexity and a non-positive coefficient both reject", () => {
    expect(translateDraft(draft([task({ complexity: 11 })]), fc()).outcome).toBe("rejected");
    expect(translateDraft(draft([task()]), fc({ budgetPolicy: { version: "bp0", coefficientUsdPerPoint: -1, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 } })).outcome).toBe("rejected");
  });
  test("budget estimate over the policy cap rejects (no silent over-cap plan)", () => {
    const r = translateDraft(draft([task({ complexity: 10 })]), fc({ budgetPolicy: { version: "tiny", coefficientUsdPerPoint: 1, maxModelUsd: 1, maxTotalAttempts: 20, maxWallClockSec: 72000 } }));
    expect(r.outcome === "rejected" && /cap/.test(r.reason)).toBe(true);
  });
});

describe("E — tier mapping (max of complexity / kind floor / role floor; 存疑向上)", () => {
  test("TIER-FLOOR: work + complexity 1 + role floor standard => effective tier >= standard", () => {
    const r = translateDraft(draft([task({ complexity: 1, roleProfile: "pure-layer-impl" })]), fc());
    expect(r.outcome === "loadable" && r.plan.nodes[0]!.modelTier === "standard").toBe(true);
  });
  test("SCORE-DISAGREES: complexity 2 + independentScore 9 => heavy (high score never silently ignored)", () => {
    const r = translateDraft(draft([task({ complexity: 2, independentScore: 9 })]), fc());
    expect(r.outcome === "loadable" && r.plan.nodes[0]!.modelTier === "heavy").toBe(true);
  });
  test("complexity boundaries 3->light, 4->standard, 7->standard, 8->heavy", () => {
    const tierAt = (c: number) => { const r = translateDraft(draft([task({ complexity: c })]), fc()); return r.outcome === "loadable" ? r.plan.nodes[0]!.modelTier : "ERR"; };
    expect([tierAt(3), tierAt(4), tierAt(7), tierAt(8)]).toEqual(["light", "standard", "standard", "heavy"]);
  });
  test("review kind floor = heavy even at low complexity; design gate is heavy", () => {
    const rev = translateDraft(draft([task({ kind: "review", complexity: 1 })]), fc());
    expect(rev.outcome === "loadable" && rev.plan.nodes[0]!.modelTier === "heavy").toBe(true);
    const d = translateDraft(draft([task({ sourceWriteScope: ["docs/swarm/brain-design.md"] })]), fc());
    expect(d.outcome === "loadable" && designOf(d)!.modelTier === "heavy").toBe(true);
  });
  test("PLANNER-HEAVY: direction-setting planner operations are always heavy", () => {
    expect(plannerOperationTier()).toBe("heavy");
  });
});

describe("D — identity stability (same normalized draft + frozenContext => same specDigest)", () => {
  test("DIGEST-EXACT + PURE-SNAPSHOT: two independent runs give identical node specDigests (no ambient reads)", () => {
    const d = draft([task({ nodeId: "A" }), task({ nodeId: "B", dependsOn: ["A"] })]);
    const a = translateDraft(d, fc());
    const b = translateDraft(draft([task({ nodeId: "A" }), task({ nodeId: "B", dependsOn: ["A"] })]), fc());
    expect(a.outcome === "loadable" && b.outcome === "loadable").toBe(true);
    if (a.outcome === "loadable" && b.outcome === "loadable") {
      expect(a.plan.nodes.map((n) => n.specDigest)).toEqual(b.plan.nodes.map((n) => n.specDigest));
      expect(a.plan.planDigest).toBe(b.plan.planDigest);
    }
  });
  test("DIGEST-SEMANTIC: a different goal yields a different specDigest (no guessed equivalence)", () => {
    const a = translateDraft(draft([task({ goal: "alias lookup" })]), fc());
    const b = translateDraft(draft([task({ goal: "identity alias resolution" })]), fc());
    if (a.outcome === "loadable" && b.outcome === "loadable") expect(a.plan.nodes[0]!.specDigest).not.toBe(b.plan.nodes[0]!.specDigest);
  });
  test("COVERAGE-FINAL: design gate covers the impl nodes' FINAL digests; changing an impl node changes coverage", () => {
    const mk = (goal: string) => translateDraft(draft([
      task({ nodeId: "A", goal, sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), fc());
    const r1 = mk("impl v1");
    const r2 = mk("impl v2");
    expect(r1.outcome === "loadable" && r2.outcome === "loadable").toBe(true);
    if (r1.outcome !== "loadable" || r2.outcome !== "loadable") return;
    const d1 = designOf(r1)!;
    const implDigests1 = r1.plan.nodes.filter((n) => n.kind !== "design").map((n) => n.specDigest).sort();
    expect(d1.coveredSpecDigests!.slice().sort()).toEqual(implDigests1); // coverage == impl final digests
    expect(designOf(r2)!.coveredSpecDigests).not.toEqual(d1.coveredSpecDigests); // a revised impl invalidates old coverage
  });
});

describe("LOAD-ROUNDTRIP at the translate layer: role/modelTier/design/coverage all present in the output plan", () => {
  test("a translated plan carries the annotations and loads clean", () => {
    const r = translateDraft(draft([
      task({ nodeId: "A", roleProfile: "pure-layer-impl", complexity: 9, sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const a = r.plan.nodes.find((n) => n.nodeId === "A")!;
    expect(a.roleProfile).toBe("pure-layer-impl");
    expect(a.modelTier).toBe("heavy");
    expect(designOf(r)!.coveredSpecDigests!.length).toBe(2);
  });
});
