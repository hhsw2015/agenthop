import { describe, expect, test } from "vitest";
import { translateDraft, type Draft, type DraftTask, type FrozenContext } from "../src/swarm/task-translate.js";
import { loadPlan, type TaskPlan, type FrozenRefs } from "../src/swarm/task-plan.js";
import { auditCoverage, reconcile, type ReqBaseline } from "../scripts/coverage-audit.js";

// T3b acceptance B + F (design 1d0a1ffc §3), offline + deterministic. A1 (real-LLM live-fire) + the real F reconciliation
// artifact are the separate gated script scripts/t3-draft-live.ts — its evidence rides with the review packet.

function fc(over: Partial<FrozenContext> = {}): FrozenContext {
  return {
    checkRegistry: { version: "cr1", checks: { testsPass: {}, fileExists: { args: { path: { type: "string", required: true } } } } },
    ownerDomainPolicy: { version: "op1", ownerByPrefix: [{ prefix: "packages/bus/src/swarm/", domain: "pure" }, { prefix: "scripts/", domain: "io" }], frozenScopePrefixes: ["docs/swarm/"] },
    riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: [] },
    roleCatalog: { version: "rc1", roles: { "pure-layer-impl": { floor: "standard", fileDomain: ["packages/bus/src/swarm/"] }, "io-impl": { floor: "standard", fileDomain: ["scripts/"] } } },
    budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
    r4ThresholdPolicy: { version: "tp1", maxTotalComplexity: 1000 },
    sourceBaselineDigest: "base",
    planningRequestId: "req-acc",
    ...over,
  };
}
const task = (over: Partial<DraftTask>): DraftTask => ({ nodeId: "N", kind: "work", goal: "g", dependsOn: [], structuredChecks: [{ check: "testsPass" }], freeTextNotes: [], complexity: 4, requiredOutputs: [{ logicalName: "o", kind: "report" }], artifactScope: ["out/"], ...over });
const refsOf = (f: FrozenContext): FrozenRefs => ({ checkRegistry: f.checkRegistry.version, ownerDomainPolicy: f.ownerDomainPolicy.version, riskPolicy: f.riskPolicy.version, roleCatalog: f.roleCatalog.version, budgetPolicy: f.budgetPolicy.version, r4ThresholdPolicy: f.r4ThresholdPolicy.version, sourceBaselineDigest: f.sourceBaselineDigest, ...(f.planningRequestId !== undefined ? { planningRequestId: f.planningRequestId } : {}) });

describe("acceptance B: R4 auto-triggers a design gate covering every impl node; a tampered coverage is rejected", () => {
  const crossDomain: Draft = {
    jobId: "jobB",
    tasks: [
      task({ nodeId: "pure1", sourceWriteScope: ["packages/bus/src/swarm/a.ts"], roleProfile: "pure-layer-impl" }),
      task({ nodeId: "io1", sourceWriteScope: ["scripts/b.ts"], roleProfile: "io-impl" }),
    ],
  };

  test("cross-two-domain requirement -> plan has a prepended design gate covering all impl nodes", () => {
    const r = translateDraft(crossDomain, fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const gate = r.plan.nodes.find((n) => n.kind === "design");
    expect(gate).toBeDefined();
    const implDigests = r.plan.nodes.filter((n) => n.kind !== "design").map((n) => n.specDigest).sort();
    expect(gate!.coveredSpecDigests).toEqual(implDigests); // COVERAGE: every impl node is covered
  });

  test("missing coverage mapping -> the whole plan is rejected on (re)load", () => {
    const r = translateDraft(crossDomain, fc());
    if (r.outcome !== "loadable") throw new Error("setup");
    const broken: TaskPlan = {
      ...r.plan,
      nodes: r.plan.nodes.map((n) => (n.kind === "design" ? { ...n, coveredSpecDigests: (n.coveredSpecDigests ?? []).slice(0, 1) } : n)),
    };
    const loaded = loadPlan(broken, { mode: "managed-t3", ownerDomainPolicy: fc().ownerDomainPolicy, riskPolicy: fc().riskPolicy, expectedFrozenRefs: refsOf(fc()) });
    expect(loaded.ok).toBe(false);
  });

  test("a structurally illegal draft (dependency cycle) is rejected, not gated", () => {
    const cyclic: Draft = { jobId: "jobC", tasks: [task({ nodeId: "x", dependsOn: ["y"] }), task({ nodeId: "y", dependsOn: ["x"] })] };
    expect(translateDraft(cyclic, fc()).outcome).toBe("rejected");
  });
});

// ---- Acceptance F: independent requirement-coverage audit (shared helper scripts/coverage-audit.ts). It reads ONLY the
// plan (no model "covers" field), requires STRUCTURED acceptance evidence for "implemented", and treats a marker in an
// omission clause as NOT implemented. A dropped requirement (node removed, or obligation dropped while the marker stays)
// surfaces as UNCOVERED. ----

describe("acceptance F: independent coverage audit (structured evidence, omission-aware, catches drops)", () => {
  const reqs: ReqBaseline[] = [
    { id: "I1", marker: "[I1]", requiredCheck: "testsPass", expect: "implemented" },
    { id: "I2", marker: "[I2]", requiredCheck: "testsPass", expect: "implemented" },
    { id: "I3", marker: "[I3]", requiredCheck: "testsPass", expect: "implemented" },
    { id: "I6", marker: "[I6]", expect: "constrained-review" },
    { id: "I7", marker: "[I7]", expect: "deferred" },
  ];
  const tasks: DraftTask[] = [
    task({ nodeId: "t1", goal: "implement [I1] crash-safe storage", structuredChecks: [{ check: "testsPass" }], sourceWriteScope: ["packages/bus/src/swarm/i1.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t2", goal: "implement [I2]", structuredChecks: [{ check: "testsPass" }], sourceWriteScope: ["packages/bus/src/swarm/i2.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t3", goal: "implement [I3]", structuredChecks: [{ check: "testsPass" }], sourceWriteScope: ["packages/bus/src/swarm/i3.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t6", goal: "handle [I6] (needs expert judgement)", freeTextNotes: ["[I6] must be reviewed for correctness"], sourceWriteScope: ["packages/bus/src/swarm/i6.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t7", goal: "DEFER [I7] to vNext (out of scope this milestone)", structuredChecks: [{ check: "testsPass" }], sourceWriteScope: ["packages/bus/src/swarm/i7.ts"], roleProfile: "pure-layer-impl" }),
  ];

  test("every requirement is independently classified per the hand-made baseline", () => {
    const r = translateDraft({ jobId: "jobF", tasks }, fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(reconcile(r.plan, reqs).pass).toBe(true);
  });

  test("NEGATIVE: a dropped node surfaces UNCOVERED", () => {
    const r = translateDraft({ jobId: "jobF2", tasks: tasks.filter((t) => t.nodeId !== "t3") }, fc());
    if (r.outcome !== "loadable") throw new Error("setup");
    expect(auditCoverage(r.plan, reqs)["I3"]).toBe("UNCOVERED");
  });

  test("NEGATIVE: marker kept but obligation (required check) dropped => NOT implemented (UNCOVERED)", () => {
    // t3 keeps [I3] in its goal but its only acceptance is an unrelated check — the obligation is gone.
    const dropped = tasks.map((t) => (t.nodeId === "t3" ? { ...t, goal: "mention [I3] only", structuredChecks: [{ check: "fileExists", args: { path: "x" } }] } : t));
    const r = translateDraft({ jobId: "jobF3", tasks: dropped }, fc());
    if (r.outcome !== "loadable") throw new Error("setup");
    expect(auditCoverage(r.plan, reqs)["I3"]).toBe("UNCOVERED");
  });

  test("NEGATIVE: a marker inside an explicit-omission clause is NOT counted implemented", () => {
    const omit = tasks.map((t) => (t.nodeId === "t1" ? { ...t, goal: "Do NOT implement crash-safe storage [I1]; only print a greeting" } : t));
    const r = translateDraft({ jobId: "jobF4", tasks: omit }, fc());
    if (r.outcome !== "loadable") throw new Error("setup");
    expect(auditCoverage(r.plan, reqs)["I1"]).not.toBe("implemented"); // the reviewer's MARKER-WITH-EXPLICIT-OMISSION
  });

  test("R2-P2-3: an UNTAGGED scope obligation (tests under a dir) is UNCOVERED when no node writes there, implemented when one does", () => {
    const scopeReq: ReqBaseline[] = [{ id: "TESTS-DIR", requiredScopePrefix: "packages/bus/test/", expect: "implemented" }];
    const noTests = translateDraft({ jobId: "jobS1", tasks: [task({ nodeId: "src1", sourceWriteScope: ["packages/bus/src/swarm/x.ts"], roleProfile: "pure-layer-impl" })] }, fc());
    if (noTests.outcome !== "loadable") throw new Error("setup");
    expect(auditCoverage(noTests.plan, scopeReq)["TESTS-DIR"]).toBe("UNCOVERED"); // prose obligation silently dropped -> caught

    const withTests = translateDraft({ jobId: "jobS2", tasks: [
      task({ nodeId: "src1", sourceWriteScope: ["packages/bus/src/swarm/x.ts"], roleProfile: "pure-layer-impl" }),
      task({ nodeId: "tests1", artifactScope: ["packages/bus/test/"], sourceWriteScope: ["packages/bus/test/"], roleProfile: "pure-layer-impl" }),
    ] }, fc());
    if (withTests.outcome !== "loadable") throw new Error("setup2");
    expect(auditCoverage(withTests.plan, scopeReq)["TESTS-DIR"]).toBe("implemented");
  });
});
