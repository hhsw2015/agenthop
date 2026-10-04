import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { storeBundle, loadBundle, bundleDigest, prdDigestOf, storeFrozenContext, loadFrozenContext, frozenRefsOf, type ResumeBundle } from "../src/swarm/plan-bundle.js";
import { translateDraft, type Draft, type FrozenContext } from "../src/swarm/task-translate.js";
import type { FrozenRefs } from "../src/swarm/task-plan.js";

// T3b resume-bundle + policy-version IO (design 1d0a1ffc §1; coordinator point 2): content-addressed, idempotent,
// integrity-checked, crash-safe (atomic).

const draft: Draft = { jobId: "job1", tasks: [{ nodeId: "A", kind: "work", goal: "g", dependsOn: [], structuredChecks: [{ check: "testsPass" }], freeTextNotes: [], complexity: 3, requiredOutputs: [{ logicalName: "o", kind: "report" }], artifactScope: ["out/"] }] };
const frozenRefs: FrozenRefs = { checkRegistry: "cr1", ownerDomainPolicy: "op1", riskPolicy: "rp1", roleCatalog: "rc1", budgetPolicy: "bp1", r4ThresholdPolicy: "tp1", sourceBaselineDigest: "base-abc", planningRequestId: "req-1" };
const bundle: ResumeBundle = { draft, prdDigest: prdDigestOf("build X"), frozenRefs, frozenContextDigest: "a".repeat(64), planningRequestId: "req-1" };

const sampleFc: FrozenContext = {
  checkRegistry: { version: "cr1", checks: { testsPass: {} } },
  ownerDomainPolicy: { version: "op1", ownerByPrefix: [], frozenScopePrefixes: [] },
  riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: [] },
  roleCatalog: { version: "rc1", roles: {} },
  budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
  r4ThresholdPolicy: { version: "tp1", maxTotalComplexity: 1000 },
  sourceBaselineDigest: "base-abc",
  planningRequestId: "req-1",
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "t3-bundle-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("store + load round-trip", () => {
  test("payloadRef is the content digest and round-trips", () => {
    const ref = storeBundle(bundle, dir);
    expect(ref).toBe(bundleDigest(bundle));
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(loadBundle(ref, dir)).toEqual(bundle);
  });
  test("storing is idempotent (same content => same ref, one file)", () => {
    const a = storeBundle(bundle, dir);
    const b = storeBundle({ ...bundle }, dir);
    expect(a).toBe(b);
    expect(readdirSync(dir).length).toBe(1);
  });
  test("different content => different ref", () => {
    const r1 = storeBundle(bundle, dir);
    const r2 = storeBundle({ ...bundle, planningRequestId: "req-2" }, dir);
    expect(r1).not.toBe(r2);
  });
});

describe("integrity", () => {
  test("a tampered snapshot fails the digest check on load", () => {
    const ref = storeBundle(bundle, dir);
    writeFileSync(path.join(dir, `${ref}.json`), JSON.stringify({ ...bundle, planningRequestId: "evil" }));
    expect(() => loadBundle(ref, dir)).toThrow(/integrity/);
  });
  test("a non-digest payloadRef is rejected", () => {
    expect(() => loadBundle("../etc/passwd", dir)).toThrow(/64-hex/);
  });
  test("a missing bundle throws", () => {
    expect(() => loadBundle("a".repeat(64), dir)).toThrow(/cannot read/);
  });
  test("P2-3: a half-written file at the ref is repaired by a re-store (never a false-success unreadable ref)", () => {
    const ref = storeBundle(bundle, dir);
    writeFileSync(path.join(dir, `${ref}.json`), "{"); // simulate an interrupted write
    const again = storeBundle(bundle, dir); // atomic re-store overwrites the partial
    expect(again).toBe(ref);
    expect(loadBundle(ref, dir)).toEqual(bundle); // now loads cleanly
  });
});

describe("policy-version store (durable version retention, line 20)", () => {
  test("storeFrozenContext round-trips by content digest", () => {
    const d = storeFrozenContext(sampleFc, dir);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(loadFrozenContext(d, dir)).toEqual(sampleFc);
  });
  test("a tampered policy snapshot fails the digest check", () => {
    const d = storeFrozenContext(sampleFc, dir);
    writeFileSync(path.join(dir, `${d}.json`), JSON.stringify({ ...sampleFc, sourceBaselineDigest: "evil" }));
    expect(() => loadFrozenContext(d, dir)).toThrow(/integrity/);
  });
  test("frozenRefsOf equals the frozenRefs translateDraft stamps on a plan (no drift)", () => {
    const r = translateDraft({ jobId: "jp", tasks: [{ nodeId: "A", kind: "work", goal: "g", dependsOn: [], structuredChecks: [{ check: "testsPass" }], freeTextNotes: [], complexity: 3, requiredOutputs: [{ logicalName: "o", kind: "report" }], artifactScope: ["out/"] }] }, sampleFc);
    expect(r.outcome).toBe("loadable");
    if (r.outcome !== "loadable") return;
    expect(frozenRefsOf(sampleFc)).toEqual(r.plan.frozenRefs);
  });
});
