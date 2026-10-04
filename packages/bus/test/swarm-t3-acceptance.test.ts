import { describe, expect, test } from "vitest";
import { draftPlan, type CallModel } from "../src/swarm/plan-draft.js";
import { translateDraft, type Draft, type DraftTask, type FrozenContext } from "../src/swarm/task-translate.js";
import { loadPlan, type TaskPlan, type FrozenRefs } from "../src/swarm/task-plan.js";

// T3b acceptance B + F (design 1d0a1ffc §3), offline + deterministic. A1 (real-LLM live-fire) is the separate gated
// script scripts/t3-draft-live.ts — its evidence rides with the review packet.

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

// ---- Acceptance F: independent requirement-coverage audit. It reads ONLY the plan (there is no model "covers" field to
// trust) and classifies each requirement; a silently dropped requirement must surface as uncovered. ----

type Req = { id: string; marker: string; expect: "implemented" | "constrained-review" | "deferred" };
type Disposition = "implemented" | "constrained-review" | "deferred" | "UNCOVERED";

/** Independent audit: for each requirement, scan the plan's nodes for its marker and classify by WHERE it appears —
 *  not by any field the drafter claimed. A design/review node => constrained-review; a goal marked DEFER => deferred; a
 *  plain impl node => implemented; nowhere => UNCOVERED (a drop). Never consults a covers field (there is none). */
function auditCoverage(plan: TaskPlan, reqs: Req[]): Record<string, Disposition> {
  const out: Record<string, Disposition> = {};
  for (const req of reqs) {
    let deferred = false, review = false, impl = false;
    for (const n of plan.nodes) {
      const hay = [n.goal, JSON.stringify(n.acceptance)].join(" ");
      if (!hay.includes(req.marker)) continue;
      if (/\bDEFER\b/.test(n.goal)) deferred = true;
      else if (n.kind === "design" || n.kind === "review") review = true;
      else impl = true;
    }
    // precedence: an explicit deferral, else a review/design gate, else a plain impl node, else a drop
    out[req.id] = deferred ? "deferred" : review ? "constrained-review" : impl ? "implemented" : "UNCOVERED";
  }
  return out;
}

describe("acceptance F: independent coverage audit (no model-covers trust; catches drops)", () => {
  const reqs: Req[] = [
    { id: "I1", marker: "[I1]", expect: "implemented" },
    { id: "I2", marker: "[I2]", expect: "implemented" },
    { id: "I3", marker: "[I3]", expect: "implemented" },
    { id: "I4", marker: "[I4]", expect: "implemented" },
    { id: "I5", marker: "[I5]", expect: "implemented" },
    { id: "I6", marker: "[I6]", expect: "constrained-review" },
    { id: "I7", marker: "[I7]", expect: "deferred" },
  ];
  const tasks: DraftTask[] = [
    task({ nodeId: "t1", goal: "handle [I1]", sourceWriteScope: ["packages/bus/src/swarm/i1.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t2", goal: "handle [I2]", sourceWriteScope: ["packages/bus/src/swarm/i2.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t3", goal: "handle [I3]", sourceWriteScope: ["packages/bus/src/swarm/i3.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t4", goal: "handle [I4]", sourceWriteScope: ["packages/bus/src/swarm/i4.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t5", goal: "handle [I5]", sourceWriteScope: ["packages/bus/src/swarm/i5.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t6", goal: "handle [I6] (needs expert judgement)", freeTextNotes: ["[I6] must be reviewed for correctness"], sourceWriteScope: ["packages/bus/src/swarm/i6.ts"], roleProfile: "pure-layer-impl" }),
    task({ nodeId: "t7", goal: "DEFER [I7] to vNext (out of scope this milestone)", sourceWriteScope: ["packages/bus/src/swarm/i7.ts"], roleProfile: "pure-layer-impl" }),
  ];

  test("every requirement is independently traceable and classified per the baseline", () => {
    const r = translateDraft({ jobId: "jobF", tasks }, fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const audit = auditCoverage(r.plan, reqs);
    for (const req of reqs) expect(audit[req.id]).toBe(req.expect);
  });

  test("NEGATIVE: dropping a requirement's node makes the audit report it UNCOVERED (the audit is real)", () => {
    const r = translateDraft({ jobId: "jobF2", tasks: tasks.filter((t) => t.nodeId !== "t3") }, fc());
    if (r.outcome !== "loadable") throw new Error("setup");
    expect(auditCoverage(r.plan, reqs)["I3"]).toBe("UNCOVERED");
  });

  test("end-to-end through draftPlan (fake model) -> translateDraft -> audit", async () => {
    const model: CallModel = async () => JSON.stringify({ jobId: "echo", tasks });
    const dr = await draftPlan({ prd: "deliver I1..I7", jobId: "jobF3", allowedChecks: ["testsPass", "fileExists"] }, { callModel: model });
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    const r = translateDraft(dr.draft, fc({ planningRequestId: dr.planningRequestId }));
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const audit = auditCoverage(r.plan, reqs);
    expect(Object.values(audit).every((d) => d !== "UNCOVERED")).toBe(true);
  });
});
