import { describe, expect, test } from "vitest";
import { translateDraft, plannerOperationTier, REQUIRED_REVIEW_CHECK, type Draft, type DraftTask, type FrozenContext } from "../src/swarm/task-translate.js";
import { loadPlan, type FrozenRefs } from "../src/swarm/task-plan.js";

// T3a translateDraft (frozen design 60c9ffa7 + risk errata c790ff1d): the fixture spec mapped to C/D/E/G + the
// 3-state-risk decision table + the adversarial-probe hardening (prototype chain / args schema / broad scope / throw).

function fc(over: Partial<FrozenContext> = {}): FrozenContext {
  return {
    checkRegistry: { version: "cr1", checks: { fileExists: { args: { path: { type: "string", required: true } } }, testsPass: {} } },
    ownerDomainPolicy: {
      version: "op1",
      ownerByPrefix: [
        { prefix: "packages/bus/src/swarm/", domain: "pure" },
        { prefix: "scripts/", domain: "io" },
      ],
      frozenScopePrefixes: ["docs/swarm/"],
    },
    riskPolicy: { version: "rp1", irreversiblePrefixes: ["ops/prod/"], undecidablePrefixes: ["experimental/"] },
    roleCatalog: { version: "rc1", roles: {
      "pure-layer-impl": { floor: "standard", fileDomain: ["packages/bus/src/swarm/"] },
      "io-impl": { floor: "standard", fileDomain: ["scripts/"] },
      reviewer: { floor: "heavy" },
      doc: {},
    } },
    budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
    r4ThresholdPolicy: { version: "tp1", maxTotalComplexity: 1000 },
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

describe("C — draft degradation defense (reject whole, never throw, no silent repair)", () => {
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
  test("never throws on malformed shapes — returns rejected (string artifactScope, bad requiredOutputs)", () => {
    expect(translateDraft(draft([task({ artifactScope: "out/" as unknown as string[] })]), fc()).outcome).toBe("rejected"); // not char-split
    expect(translateDraft(draft([task({ requiredOutputs: "nope" as unknown as [] })]), fc()).outcome).toBe("rejected");
    expect(translateDraft(draft([task({ requiredOutputs: [{ logicalName: "", kind: "report" }] })]), fc()).outcome).toBe("rejected");
    expect(translateDraft(draft([task({ sourceWriteScope: "scripts/x" as unknown as string[] })]), fc()).outcome).toBe("rejected");
  });
});

describe("G — acceptance matrix (registry authority, prototype-safe, obligations never evaporate)", () => {
  test("AC-UNKNOWN: a check not in the registry is refused", () => {
    const r = translateDraft(draft([task({ structuredChecks: [{ check: "looksGood", args: {} }] })]), fc());
    expect(r.outcome === "rejected" && /looksGood|unknown/.test(r.reason)).toBe(true);
  });
  test("AC-PROSE: prose smuggled into structuredChecks (a non-{check} element) is rejected", () => {
    const r = translateDraft(draft([task({ structuredChecks: ["Reviewer judges nothing omitted" as unknown as { check: string }] })]), fc());
    expect(r.outcome === "rejected").toBe(true);
  });
  test("prototype-chain: constructor/toString are NOT registered checks", () => {
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "constructor" }] })]), fc()).outcome).toBe("rejected");
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "toString" }] })]), fc()).outcome).toBe("rejected");
  });
  test("ARGS-INHERITED-REQUIRED: a required arg named like a prototype key isn't satisfied by inheritance", () => {
    const proto = fc({ checkRegistry: { version: "cr", checks: { needsCtor: { args: { ["constructor"]: { type: "string" as const, required: true } } } } } });
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "needsCtor", args: {} }] })]), proto).outcome).toBe("rejected");
  });
  test("args schema: wrong-typed / null / undeclared args are rejected (not just presence)", () => {
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "fileExists", args: { path: null } }] })]), fc()).outcome).toBe("rejected");
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "fileExists", args: { path: 5 } }] })]), fc()).outcome).toBe("rejected");
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "fileExists", args: {} }] })]), fc()).outcome).toBe("rejected"); // missing required
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "fileExists", args: { path: "x", extra: 1 } }] })]), fc()).outcome).toBe("rejected"); // undeclared
  });
  test("AC-REGISTRY-DOWNGRADE: a registry missing a once-valid check rejects and names it", () => {
    const downgraded = fc({ checkRegistry: { version: "cr0", checks: { fileExists: { args: { path: { type: "string", required: true } } } } } });
    const r = translateDraft(draft([task({ structuredChecks: [{ check: "testsPass" }] })]), downgraded);
    expect(r.outcome === "rejected" && /testsPass/.test(r.reason)).toBe(true);
  });
  test("AC-OBLIGATION-DROP: fileExists + prose -> work keeps fileExists, prose becomes a SEPARATE required review node", () => {
    const r = translateDraft(draft([task({ nodeId: "M", structuredChecks: [{ check: "fileExists", args: { path: "out/r.md" } }], freeTextNotes: ["an independent reviewer confirms I1-I7"] })]), fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(r.plan.nodes.find((n) => n.nodeId === "M")!.acceptance.map((a) => a.check)).toEqual(["fileExists"]);
    const review = r.plan.nodes.find((n) => n.nodeId === "M::review")!;
    expect(review.kind === "review" && review.required === true && review.dependsOn.includes("M")).toBe(true);
    expect(review.acceptance[0]!.check).toBe(REQUIRED_REVIEW_CHECK);
    expect(review.modelTier).toBe("heavy");
  });
  test("ROLE-UNKNOWN: a hallucinated role (and a prototype name) is needsRole, never default-dispatched", () => {
    expect(translateDraft(draft([task({ roleProfile: "all-purpose-super-owner" })]), fc()).outcome).toBe("needsRole");
    expect(translateDraft(draft([task({ roleProfile: "hasOwnProperty" })]), fc()).outcome).toBe("needsRole");
  });
  test("BUDGET-INVALID: out-of-range complexity, non-positive coefficient, and over-cap all reject", () => {
    expect(translateDraft(draft([task({ complexity: 11 })]), fc()).outcome).toBe("rejected");
    expect(translateDraft(draft([task()]), fc({ budgetPolicy: { version: "bp0", coefficientUsdPerPoint: -1, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 } })).outcome).toBe("rejected");
    const cap = translateDraft(draft([task({ complexity: 10 })]), fc({ budgetPolicy: { version: "tiny", coefficientUsdPerPoint: 1, maxModelUsd: 1, maxTotalAttempts: 20, maxWallClockSec: 72000 } }));
    expect(cap.outcome === "rejected" && /cap/.test(cap.reason)).toBe(true);
  });
});

describe("R4 decision table (two orthogonal axes + 3-state risk, c790ff1d)", () => {
  test("R4-OWNER-SPOOF: two TRUSTED domains trigger a design gate", () => {
    const r = translateDraft(draft([
      task({ nodeId: "A", sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), fc());
    expect(r.outcome === "loadable" && designOf(r) !== undefined).toBe(true);
  });
  test("broad scope fans out to nested domains/frozen (not read as a single point)", () => {
    // single covering role so the role resolves cleanly and the outcome isolates the OWNER fan-out -> design
    const wide = fc({
      ownerDomainPolicy: { version: "w", ownerByPrefix: [{ prefix: "src/", domain: "core" }, { prefix: "src/io/", domain: "io" }], frozenScopePrefixes: ["src/protocol/"] },
      roleCatalog: { version: "wr", roles: { fullstack: { floor: "standard", fileDomain: ["src/"] } } },
    });
    const r = translateDraft(draft([task({ sourceWriteScope: ["src/"] })]), wide);
    expect(r.outcome === "loadable" && designOf(r) !== undefined).toBe(true); // touches core+io (2) AND frozen
    const narrow = translateDraft(draft([task({ sourceWriteScope: ["src/core/x.ts"] })]), wide);
    expect(narrow.outcome === "loadable" && designOf(narrow) === undefined).toBe(true); // single domain, no fan-out
  });
  // these isolate the R4 OWNER/RISK behavior, so they give an explicit resolvable role (roleProfile:"doc") — an
  // unresolved role would correctly short-circuit to needsRole (R4-P2-1) and mask the design outcome under test.
  test("R4-FROZEN: a frozen-contract write forces design regardless of (ignored) model risk", () => {
    expect(designOf(translateDraft(draft([task({ sourceWriteScope: ["docs/swarm/brain-design.md"], roleProfile: "doc" })]), fc()) as never)).toBeDefined();
  });
  test("known-irreversible path -> DESIGN (条件4, 风险可判即便不可逆), NOT needsClarification", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["ops/prod/migrate.ts"], roleProfile: "doc" })]), fc());
    expect(r.outcome === "loadable" && designOf(r) !== undefined).toBe(true);
  });
  test("unknown-risk + criticalPath -> needsClarification (ask the requester)", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["experimental/x.ts"], criticalPath: true, roleProfile: "doc" })]), fc());
    expect(r.outcome === "needsClarification" && r.questions.length > 0).toBe(true);
  });
  test("unknown-risk + non-critical -> conservative design gate (门吸收)", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["experimental/x.ts"], roleProfile: "doc" })]), fc());
    expect(r.outcome === "loadable" && designOf(r) !== undefined).toBe(true);
  });
  test("unknown ownership (non-irreversible) -> conservative design (never silent bypass)", () => {
    expect(designOf(translateDraft(draft([task({ sourceWriteScope: ["new/unmapped-module.ts"], roleProfile: "doc" })]), fc()) as never)).toBeDefined();
  });
  test("threshold is PHASED (notImplemented) — a high complexity sum alone does not trigger design", () => {
    const r = translateDraft(draft([task({ nodeId: "A", complexity: 10, sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] })]), fc({ r4ThresholdPolicy: { version: "t", maxTotalComplexity: 1 } }));
    expect(r.outcome === "loadable" && designOf(r) === undefined).toBe(true);
    if (r.outcome === "loadable") expect(r.plan.notImplemented).toEqual(["r4-threshold"]);
  });
  test("owner attribution: a specific nested path has ONE owner (longest prefix), not false cross-domain", () => {
    const wide = fc({
      ownerDomainPolicy: { version: "w", ownerByPrefix: [{ prefix: "src/", domain: "core" }, { prefix: "src/io/", domain: "io" }], frozenScopePrefixes: [] },
      roleCatalog: { version: "wr", roles: { core: { floor: "standard", fileDomain: ["src/"] }, io: { floor: "standard", fileDomain: ["src/io/"] } } },
    });
    const r = translateDraft(draft([task({ sourceWriteScope: ["src/io/a.ts"] })]), wide);
    expect(r.outcome === "loadable" && designOf(r) === undefined).toBe(true); // {io} only
  });
  test("single trusted domain, nothing frozen/irreversible -> NO design gate (reverse positive)", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] })]), fc());
    expect(r.outcome === "loadable" && designOf(r) === undefined).toBe(true);
  });
  test("seam#1: a broad scope over partially-mapped area flags unknown ownership -> design", () => {
    const partial = fc({
      ownerDomainPolicy: { version: "p", ownerByPrefix: [{ prefix: "src/known/", domain: "core" }], frozenScopePrefixes: [] },
      roleCatalog: { version: "r", roles: { core: { floor: "standard", fileDomain: ["src/"] } } }, // covering role -> resolves; isolates owner behavior
    });
    const r = translateDraft(draft([task({ sourceWriteScope: ["src/"] })]), partial); // src/ touches src/known/ (core) AND unmapped area
    expect(r.outcome === "loadable" && designOf(r) !== undefined).toBe(true);
  });
  test("3b corrected: an unresolved role is needsRole EVEN WHEN design is required (gate does not backfill the role)", () => {
    const wide = fc({
      ownerDomainPolicy: { version: "w", ownerByPrefix: [{ prefix: "src/", domain: "core" }, { prefix: "src/io/", domain: "io" }], frozenScopePrefixes: [] },
      roleCatalog: { version: "wr", roles: { core: { floor: "standard", fileDomain: ["src/"] }, io: { floor: "standard", fileDomain: ["src/io/"] } } },
    });
    // scope src/ spans core+io -> designRequired, AND spans role subdomains -> role ambiguous -> needsRole wins (not loadable+design)
    expect(translateDraft(draft([task({ sourceWriteScope: ["src/"] })]), wide).outcome).toBe("needsRole");
  });
  test("seam#2: a broad scope hitting BOTH irreversible and undecidable keeps the unknown fact", () => {
    const both = fc({
      riskPolicy: { version: "b", irreversiblePrefixes: ["zone/irr/"], undecidablePrefixes: ["zone/unk/"] },
      ownerDomainPolicy: { version: "o", ownerByPrefix: [{ prefix: "zone/", domain: "z" }], frozenScopePrefixes: [] },
      roleCatalog: { version: "r", roles: { z: { floor: "standard", fileDomain: ["zone/"] } } },
    });
    expect(translateDraft(draft([task({ sourceWriteScope: ["zone/"], criticalPath: true })]), both).outcome).toBe("needsClarification"); // unknown not swallowed by irreversible
    const noncrit = translateDraft(draft([task({ sourceWriteScope: ["zone/"] })]), both);
    expect(noncrit.outcome === "loadable" && designOf(noncrit) !== undefined).toBe(true);
  });
});

describe("88e6a44 re-verify seams (role determinism, non-finite, planRevision)", () => {
  test("3a: an equal-length fileDomain tie is ambiguous -> needsRole (deterministic, not key-order pick-first)", () => {
    const tie = fc({
      roleCatalog: { version: "t", roles: { ra: { floor: "light", fileDomain: ["a/"] }, rb: { floor: "heavy", fileDomain: ["a/"] } } },
      ownerDomainPolicy: { version: "o", ownerByPrefix: [{ prefix: "a/", domain: "d" }], frozenScopePrefixes: [] },
    });
    expect(translateDraft(draft([task({ sourceWriteScope: ["a/x.ts"] })]), tie).outcome).toBe("needsRole");
  });
  test("3b: a single owner domain spanning multiple role subdomains -> needsRole (not silent unconstrained)", () => {
    const multi = fc({
      ownerDomainPolicy: { version: "o", ownerByPrefix: [{ prefix: "d/", domain: "d" }], frozenScopePrefixes: [] },
      roleCatalog: { version: "r", roles: { da: { floor: "standard", fileDomain: ["d/a/"] }, db: { floor: "standard", fileDomain: ["d/b/"] } } },
    });
    expect(translateDraft(draft([task({ sourceWriteScope: ["d/"] })]), multi).outcome).toBe("needsRole");
  });
  test("4a: a non-finite nested arg does not throw at the gate pre-hash — rejected", () => {
    const reg = fc({ checkRegistry: { version: "cr", checks: { blob: { args: { data: { type: "object" } } }, testsPass: {} } } });
    const r = translateDraft(draft([
      task({ nodeId: "A", structuredChecks: [{ check: "blob", args: { data: { x: Infinity } } }], sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), reg);
    expect(r.outcome).toBe("rejected");
  });
  test("4b: planRevision:null is rejected, not silently defaulted to 1", () => {
    expect(translateDraft({ jobId: "j", planRevision: null as unknown as number, tasks: [task()] }, fc()).outcome).toBe("rejected");
  });
});

describe("R4-P2-1 missing-role registration: non-empty scope + no matching role -> needsRole at ANY owner count", () => {
  const nomatch = fc({ roleCatalog: { version: "nm", roles: { other: { floor: "heavy", fileDomain: ["totally/elsewhere/"] } } } });
  test("NO-MATCH-ONE-OWNER -> needsRole", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["packages/bus/src/swarm/x.ts"] })]), nomatch).outcome).toBe("needsRole");
  });
  test("NO-MATCH-TWO-OWNERS -> needsRole (not loadable+design)", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["packages/bus/src/swarm/x.ts", "scripts/y.ts"] })]), nomatch).outcome).toBe("needsRole");
  });
  test("NO-MATCH-ZERO-OWNERS (unknown owner) -> needsRole (not loadable+design)", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["unmapped/a.ts"] })]), nomatch).outcome).toBe("needsRole");
  });
  test("empty scope + no role -> loadable (no role needed; existing policy unchanged)", () => {
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "testsPass" }] })]), nomatch).outcome).toBe("loadable");
  });
  test("CTRL-MATCHED-CROSS-DOMAIN: roles DO match -> resolved role + floor, design", () => {
    const r = translateDraft(draft([
      task({ nodeId: "A", sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome === "loadable") expect(r.plan.nodes.find((n) => n.nodeId === "A")!.roleProfile).toBe("pure-layer-impl");
  });
});

describe("R5-P2-1 partial-match: one matched path must not mask another unmatched path", () => {
  const pfc = fc({
    ownerDomainPolicy: { version: "o", ownerByPrefix: [{ prefix: "src/", domain: "core" }, { prefix: "scripts/", domain: "io" }], frozenScopePrefixes: [] },
    riskPolicy: { version: "r", irreversiblePrefixes: [], undecidablePrefixes: [] },
    roleCatalog: { version: "rc", roles: { partial: { floor: "light", fileDomain: ["src/covered/"] } } },
  });
  test("PARTIAL-MATCH-SAME-OWNER -> needsRole", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["src/covered/a.ts", "src/unmatched/b.ts"] })]), pfc).outcome).toBe("needsRole");
  });
  test("PARTIAL-MATCH-TWO-OWNERS -> needsRole", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["src/covered/a.ts", "scripts/b.ts"] })]), pfc).outcome).toBe("needsRole");
  });
  test("PARTIAL-MATCH-UNKNOWN-OWNER -> needsRole (a design gate can't fill the missing role)", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["src/covered/a.ts", "unmapped/b.ts"] })]), pfc).outcome).toBe("needsRole");
  });
  test("PARTIAL-MATCH-REVERSED -> needsRole (order-independent)", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["scripts/b.ts", "src/covered/a.ts"] })]), pfc).outcome).toBe("needsRole");
  });
  test("CTRL-UNMATCHED-PATH-ALONE -> needsRole", () => {
    expect(translateDraft(draft([task({ sourceWriteScope: ["scripts/b.ts"] })]), pfc).outcome).toBe("needsRole");
  });
  test("CTRL-ALL-COVERED -> loadable with the inferred role", () => {
    const r = translateDraft(draft([task({ sourceWriteScope: ["src/covered/a.ts", "src/covered/c.ts"] })]), pfc);
    expect(r.outcome === "loadable" && r.plan.nodes[0]!.roleProfile === "partial").toBe(true);
  });
  test("CTRL-MULTIPLE-ROLES: paths match different roles -> needsRole", () => {
    const two = fc({
      ownerDomainPolicy: { version: "o", ownerByPrefix: [{ prefix: "a/", domain: "da" }, { prefix: "b/", domain: "db" }], frozenScopePrefixes: [] },
      roleCatalog: { version: "rc", roles: { ra: { floor: "light", fileDomain: ["a/"] }, rb: { floor: "light", fileDomain: ["b/"] } } },
    });
    expect(translateDraft(draft([task({ sourceWriteScope: ["a/x.ts", "b/y.ts"] })]), two).outcome).toBe("needsRole");
  });
});

describe("loadPlan managed-t3 (loader ruling f06894b8): policy-driven R4 enforcement, catches structural bypasses", () => {
  const f = fc();
  const refs: FrozenRefs = { checkRegistry: "cr1", ownerDomainPolicy: "op1", riskPolicy: "rp1", roleCatalog: "rc1", budgetPolicy: "bp1", r4ThresholdPolicy: "tp1", sourceBaselineDigest: "base-abc" };
  const opts = { mode: "managed-t3" as const, ownerDomainPolicy: f.ownerDomainPolicy, riskPolicy: f.riskPolicy, expectedFrozenRefs: refs };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const built = (): any => {
    const r = translateDraft(draft([
      task({ nodeId: "A", sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), f);
    if (r.outcome !== "loadable") throw new Error("setup: expected loadable");
    return structuredClone(r.plan);
  };
  test("a valid cross-domain plan loads in managed mode", () => {
    expect(loadPlan(built(), opts).ok).toBe(true);
  });
  test("bypass ①: delete the design gate -> rejected (job still cross-domain)", () => {
    const p = built();
    p.nodes = p.nodes.filter((n: { kind: string }) => n.kind !== "design").map((n: { dependsOn: string[] }) => ({ ...n, dependsOn: n.dependsOn.filter((d: string) => d !== "design-gate") }));
    expect(loadPlan(p, opts).ok).toBe(false);
  });
  test("bypass ②: design covers only one impl node -> rejected", () => {
    const p = built();
    const d = p.nodes.find((n: { kind: string }) => n.kind === "design");
    d.coveredSpecDigests = [d.coveredSpecDigests[0]];
    const r = loadPlan(p, opts);
    expect(r.ok === false && /uncovered|covering every/.test(r.reason)).toBe(true);
  });
  test("frozenRefs mismatch -> rejected", () => {
    expect(loadPlan(built(), { ...opts, expectedFrozenRefs: { ...refs, ownerDomainPolicy: "WRONG" } }).ok).toBe(false);
  });
  test("legacy mode (no opts) still loads the same plan (managed is opt-in)", () => {
    expect(loadPlan(built()).ok).toBe(true);
  });
  test("5a: a policy snapshot whose version != plan ref is rejected (no weak-policy bypass)", () => {
    const weak = { ...opts, ownerDomainPolicy: { version: "WEAK", ownerByPrefix: [], frozenScopePrefixes: [] } };
    expect(loadPlan(built(), weak).ok).toBe(false);
  });
  test("5b: missing ownerDomainPolicy in managed opts -> clean reject, not TypeError", () => {
    const bad = { mode: "managed-t3" as const, riskPolicy: f.riskPolicy, expectedFrozenRefs: refs } as unknown as Parameters<typeof loadPlan>[1];
    expect(loadPlan(built(), bad).ok).toBe(false);
  });
});

describe("P2-5 role inference / #5 no-impersonation / P2-1 planDigest sensitivity", () => {
  test("ROLE-NO-INFERENCE: an omitted role is INFERRED from fileDomain, floor applied (not silent light)", () => {
    const r = translateDraft(draft([task({ complexity: 1, sourceWriteScope: ["packages/bus/src/swarm/x.ts"] })]), fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const n = r.plan.nodes.find((x) => x.nodeId === "M")!;
    expect(n.roleProfile).toBe("pure-layer-impl");
    expect(n.modelTier).toBe("standard");
  });
  test("single known domain with NO matching role -> needsRole (never unconstrained light)", () => {
    const noRole = fc({ roleCatalog: { version: "empty", roles: { reviewer: { floor: "heavy" } } } });
    expect(translateDraft(draft([task({ complexity: 1, sourceWriteScope: ["packages/bus/src/swarm/x.ts"] })]), noRole).outcome).toBe("needsRole");
  });
  test("#5: a draft cannot impersonate the compiler check — required-review-pass in structuredChecks is rejected", () => {
    expect(translateDraft(draft([task({ structuredChecks: [{ check: "required-review-pass" }] })]), fc()).outcome).toBe("rejected");
  });
  test("P2-1: planDigest is sensitive to a frozenContext version ref (same nodes, different registry version)", () => {
    const a = translateDraft(draft([task()]), fc());
    const b = translateDraft(draft([task()]), fc({ checkRegistry: { version: "crX", checks: { fileExists: { args: { path: { type: "string", required: true } } }, testsPass: {} } } }));
    if (a.outcome === "loadable" && b.outcome === "loadable") expect(a.plan.planDigest).not.toBe(b.plan.planDigest);
    else throw new Error("expected loadable");
  });
});

describe("E — tier mapping (max of complexity / kind floor / role floor; 存疑向上)", () => {
  test("TIER-FLOOR: work + complexity 1 + role floor standard => standard", () => {
    const r = translateDraft(draft([task({ complexity: 1, roleProfile: "pure-layer-impl" })]), fc());
    expect(r.outcome === "loadable" && r.plan.nodes[0]!.modelTier === "standard").toBe(true);
  });
  test("SCORE-DISAGREES: complexity 2 + independentScore 9 => heavy", () => {
    const r = translateDraft(draft([task({ complexity: 2, independentScore: 9 })]), fc());
    expect(r.outcome === "loadable" && r.plan.nodes[0]!.modelTier === "heavy").toBe(true);
  });
  test("complexity boundaries 3->light, 4->standard, 7->standard, 8->heavy", () => {
    const tierAt = (c: number) => { const r = translateDraft(draft([task({ complexity: c })]), fc()); return r.outcome === "loadable" ? r.plan.nodes[0]!.modelTier : "ERR"; };
    expect([tierAt(3), tierAt(4), tierAt(7), tierAt(8)]).toEqual(["light", "standard", "standard", "heavy"]);
  });
  test("review kind floor = heavy at low complexity; design gate heavy", () => {
    const rev = translateDraft(draft([task({ kind: "review", complexity: 1 })]), fc());
    expect(rev.outcome === "loadable" && rev.plan.nodes[0]!.modelTier === "heavy").toBe(true);
    const d = translateDraft(draft([task({ sourceWriteScope: ["docs/swarm/brain-design.md"], roleProfile: "doc" })]), fc());
    expect(d.outcome === "loadable" && designOf(d)!.modelTier === "heavy").toBe(true);
  });
  test("PLANNER-HEAVY: direction-setting planner operations are always heavy", () => {
    expect(plannerOperationTier()).toBe("heavy");
  });
});

describe("D — identity stability + frozenRefs round-trip", () => {
  test("DIGEST-EXACT + PURE-SNAPSHOT: two independent runs give identical node specDigests", () => {
    const a = translateDraft(draft([task({ nodeId: "A" }), task({ nodeId: "B", dependsOn: ["A"] })]), fc());
    const b = translateDraft(draft([task({ nodeId: "A" }), task({ nodeId: "B", dependsOn: ["A"] })]), fc());
    if (a.outcome === "loadable" && b.outcome === "loadable") {
      expect(a.plan.nodes.map((n) => n.specDigest)).toEqual(b.plan.nodes.map((n) => n.specDigest));
      expect(a.plan.planDigest).toBe(b.plan.planDigest);
    } else { throw new Error("expected loadable"); }
  });
  test("DIGEST-SEMANTIC: a different goal yields a different specDigest", () => {
    const a = translateDraft(draft([task({ goal: "alias lookup" })]), fc());
    const b = translateDraft(draft([task({ goal: "identity alias resolution" })]), fc());
    if (a.outcome === "loadable" && b.outcome === "loadable") expect(a.plan.nodes[0]!.specDigest).not.toBe(b.plan.nodes[0]!.specDigest);
  });
  test("COVERAGE-FINAL: design gate covers impl FINAL digests; a changed impl changes coverage", () => {
    const mk = (goal: string) => translateDraft(draft([
      task({ nodeId: "A", goal, sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), fc());
    const r1 = mk("impl v1"); const r2 = mk("impl v2");
    if (r1.outcome !== "loadable" || r2.outcome !== "loadable") throw new Error("expected loadable");
    const implDigests1 = r1.plan.nodes.filter((n) => n.kind !== "design").map((n) => n.specDigest).sort();
    expect(designOf(r1)!.coveredSpecDigests!.slice().sort()).toEqual(implDigests1);
    expect(designOf(r2)!.coveredSpecDigests).not.toEqual(designOf(r1)!.coveredSpecDigests);
  });
  test("frozenRefs: the compiled plan pins every frozenContext version ref", () => {
    const r = translateDraft(draft([task()]), fc({ planningRequestId: "req-7" }));
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(r.plan.frozenRefs).toEqual({
      checkRegistry: "cr1", ownerDomainPolicy: "op1", riskPolicy: "rp1", roleCatalog: "rc1",
      budgetPolicy: "bp1", r4ThresholdPolicy: "tp1", sourceBaselineDigest: "base-abc", planningRequestId: "req-7",
    });
  });
});

describe("LOAD-ROUNDTRIP at the translate layer", () => {
  test("role/modelTier/design/coverage present + loads clean", () => {
    const r = translateDraft(draft([
      task({ nodeId: "A", roleProfile: "pure-layer-impl", complexity: 9, sourceWriteScope: ["packages/bus/src/swarm/task-plan.ts"] }),
      task({ nodeId: "B", sourceWriteScope: ["scripts/swarm-dispatch.ts"] }),
    ]), fc());
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    const a = r.plan.nodes.find((n) => n.nodeId === "A")!;
    expect(a.roleProfile === "pure-layer-impl" && a.modelTier === "heavy").toBe(true);
    expect(designOf(r)!.coveredSpecDigests!.length).toBe(2);
  });
});
