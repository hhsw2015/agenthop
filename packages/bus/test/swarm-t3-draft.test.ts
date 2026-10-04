import { describe, expect, test } from "vitest";
import { draftPlan, type CallModel } from "../src/swarm/plan-draft.js";
import { PROMPT_ASSETS, fillPrompt, writePromptAssets } from "../src/swarm/plan-prompts.js";
import { translateDraft, type FrozenContext } from "../src/swarm/task-translate.js";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// T3b draftPlan (the injected-LLM boundary) + prompt assets.

const goodDraftJson = JSON.stringify({
  jobId: "IGNORED-echo",
  tasks: [{ nodeId: "A", kind: "work", goal: "g", dependsOn: [], structuredChecks: [{ check: "testsPass" }], freeTextNotes: [], complexity: 4, requiredOutputs: [{ logicalName: "o", kind: "report" }], artifactScope: ["out/"] }],
});
const fakeModel = (text: string): CallModel => async () => text;

describe("draftPlan", () => {
  test("parses a good draft; jobId is the caller's (not the model's echo); surfaces a planningRequestId", async () => {
    const r = await draftPlan({ prd: "build a thing", jobId: "job1", allowedChecks: ["testsPass"] }, { callModel: fakeModel(goodDraftJson) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.jobId).toBe("job1"); // caller authoritative, overrides the model's "IGNORED-echo"
    expect(r.draft.tasks).toHaveLength(1);
    expect(r.planningRequestId.length).toBeGreaterThan(0);
    expect(r.prdDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  test("a caller-supplied planningRequestId is kept (request-round identity threads through)", async () => {
    const r = await draftPlan({ prd: "x", jobId: "j", planningRequestId: "req-42", allowedChecks: [] }, { callModel: fakeModel(goodDraftJson) });
    expect(r.ok && r.planningRequestId).toBe("req-42");
  });
  test("two calls without an id get DIFFERENT ids (independent request rounds never collide)", async () => {
    const a = await draftPlan({ prd: "x", jobId: "j", allowedChecks: [] }, { callModel: fakeModel(goodDraftJson) });
    const b = await draftPlan({ prd: "x", jobId: "j", allowedChecks: [] }, { callModel: fakeModel(goodDraftJson) });
    expect(a.ok && b.ok && a.planningRequestId !== b.planningRequestId).toBe(true);
  });
  test("tolerates one surrounding code fence", async () => {
    const r = await draftPlan({ prd: "x", jobId: "j", allowedChecks: [] }, { callModel: fakeModel("```json\n" + goodDraftJson + "\n```") });
    expect(r.ok).toBe(true);
  });
  test("non-JSON output is rejected (strong schema, no free-text tolerance)", async () => {
    const r = await draftPlan({ prd: "x", jobId: "j", allowedChecks: [] }, { callModel: fakeModel("Sure! Here is your plan: ...") });
    expect(r.ok).toBe(false);
  });
  test("missing tasks array is rejected", async () => {
    const r = await draftPlan({ prd: "x", jobId: "j", allowedChecks: [] }, { callModel: fakeModel('{"jobId":"j"}') });
    expect(r.ok).toBe(false);
  });
  test("a model call that throws is a reject, not a throw", async () => {
    const r = await draftPlan({ prd: "x", jobId: "j", allowedChecks: [] }, { callModel: async () => { throw new Error("502 from CPA"); } });
    expect(r.ok && "no").toBe(false);
  });
  test("empty prd is rejected", async () => {
    const r = await draftPlan({ prd: "   ", jobId: "j", allowedChecks: [] }, { callModel: fakeModel(goodDraftJson) });
    expect(r.ok).toBe(false);
  });
  test("rescore merges independentScore; a bad rescore response rejects", async () => {
    let call = 0;
    const twoStep: CallModel = async () => (call++ === 0 ? goodDraftJson : '[{"nodeId":"A","independentScore":9}]');
    const r = await draftPlan({ prd: "x", jobId: "j", allowedChecks: ["testsPass"], rescore: true }, { callModel: twoStep });
    expect(r.ok && r.draft.tasks[0]!.independentScore).toBe(9);

    let c2 = 0;
    const badRescore: CallModel = async () => (c2++ === 0 ? goodDraftJson : "not json");
    const r2 = await draftPlan({ prd: "x", jobId: "j", allowedChecks: ["testsPass"], rescore: true }, { callModel: badRescore });
    expect(r2.ok).toBe(false);
  });
  test("the produced draft actually feeds translateDraft (pipeline fit)", async () => {
    const r = await draftPlan({ prd: "x", jobId: "job1", allowedChecks: ["testsPass"] }, { callModel: fakeModel(goodDraftJson) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fc: FrozenContext = {
      checkRegistry: { version: "cr1", checks: { testsPass: {} } },
      ownerDomainPolicy: { version: "op1", ownerByPrefix: [], frozenScopePrefixes: [] },
      riskPolicy: { version: "rp1", irreversiblePrefixes: [], undecidablePrefixes: [] },
      roleCatalog: { version: "rc1", roles: {} },
      budgetPolicy: { version: "bp1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
      r4ThresholdPolicy: { version: "tp1", maxTotalComplexity: 1000 },
      sourceBaselineDigest: "base",
      planningRequestId: r.planningRequestId,
    };
    expect(translateDraft(r.draft, fc).outcome).toBe("loadable");
  });
});

describe("prompt assets", () => {
  test("three versioned assets exist", () => {
    expect(Object.keys(PROMPT_ASSETS).sort()).toEqual(["complexity", "expand-node", "plan-draft"]);
    for (const a of Object.values(PROMPT_ASSETS)) expect(a.version).toBe("1");
  });
  test("fillPrompt substitutes vars and throws on a missing one", () => {
    const { user } = fillPrompt(PROMPT_ASSETS["plan-draft"]!, { jobId: "j", prd: "p", allowedChecks: "testsPass" });
    expect(user).toContain("jobId=j");
    expect(user).toContain("testsPass");
    expect(() => fillPrompt(PROMPT_ASSETS["plan-draft"]!, { jobId: "j" })).toThrow(/missing var/);
  });
  test("writePromptAssets materializes the JSON files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t3-prompts-"));
    try {
      const files = writePromptAssets(dir);
      expect(files).toHaveLength(3);
      expect(readdirSync(dir).sort()).toEqual(["complexity.json", "expand-node.json", "plan-draft.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
