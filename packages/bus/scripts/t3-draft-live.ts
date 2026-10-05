/**
 * T3b acceptance A1 (design 1d0a1ffc §3) — the REAL-LLM live-fire: a real PRD -> draftPlan (a real model call routed
 * through CPA, OpenAI-compatible) -> translateDraft -> loadPlan round-trip. Prints the evidence (outcome, node/gate count,
 * planDigest) for the review packet. NOT a unit test (it spends a real model call); run it by hand:
 *
 *   CPA_BASE_URL=http://127.0.0.1:8318/v1 CPA_API_KEY=... \
 *     [CPA_MODEL=<self-select> CPA_MODEL_WHY="reason"] node --import tsx packages/bus/scripts/t3-draft-live.ts
 *
 * The planner model is RESOLVED from the model-tier table against the live CPA catalog (fail-closed — NO gpt-4o default).
 * With no CPA_MODEL it picks the strongest available planning-recommended model; CPA_MODEL self-selects (must be
 * same-or-stronger + CPA_MODEL_WHY). Offline/no-CPA: prints a clear error and exits non-zero (can't masquerade as a pass).
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftPlan, type CallModel } from "../src/swarm/plan-draft.js";
import { translateDraft, type FrozenContext } from "../src/swarm/task-translate.js";
import { loadPlan, type FrozenRefs } from "../src/swarm/task-plan.js";
import { resolvePlannerModel, type ModelSelection } from "../src/swarm/model-tier.js";
import { reconcile, type ReqBaseline } from "./coverage-audit.js";

/** The CPA API base is NOT hardcoded (it may move to a cloud URL): env CPA_BASE_URL first, then ~/.agenthop/cpa.json's
 *  baseUrl, then the local default. Change the endpoint via env or that config — never a code edit. */
function cpaBaseUrl(): string {
  if (process.env.CPA_BASE_URL) return process.env.CPA_BASE_URL;
  try {
    const cfg = JSON.parse(readFileSync(path.join(homedir(), ".agenthop", "cpa.json"), "utf8")) as { baseUrl?: string };
    if (typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0) return cfg.baseUrl;
  } catch { /* no config file -> local default */ }
  return "http://127.0.0.1:8787/v1";
}
const BASE = cpaBaseUrl();
const KEY = process.env.CPA_API_KEY ?? "";

async function fetchCatalog(): Promise<string[]> {
  const res = await fetch(`${BASE}/models`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} });
  if (!res.ok) throw new Error(`CPA catalog ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

// All models go through CPA's OpenAI-compatible /chat/completions. Reasoning effort (e.g. xhigh) comes from the model-tier
// table. Claude models on CPA require ADAPTIVE thinking (thinking.type=adaptive + output_config.effort) instead of a plain
// reasoning_effort field; everything else takes reasoning_effort directly.
function reasoningBody(model: string, effort?: string): Record<string, unknown> {
  if (!effort) return { temperature: 0 };
  if (/(^|\/)claude/i.test(model)) return { thinking: { type: "adaptive" }, output_config: { effort } }; // Claude adaptive path (no temperature)
  return { temperature: 0, reasoning_effort: effort };
}
function makeCallModel(model: string, reasoningEffort?: string): CallModel {
  return async ({ system, user }) => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ model, ...reasoningBody(model, reasoningEffort), messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`CPA ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`CPA returned no message content: ${JSON.stringify(json).slice(0, 300)}`);
    return content;
  };
}

const fc: FrozenContext = {
  checkRegistry: { version: "cr-live-1", checks: { testsPass: {}, typecheckPasses: {}, fileExists: { args: { path: { type: "string", required: true } } } } },
  ownerDomainPolicy: { version: "op-live-1", ownerByPrefix: [{ prefix: "packages/bus/src/swarm/", domain: "pure" }, { prefix: "packages/bus/test/", domain: "pure" }, { prefix: "scripts/", domain: "io" }], frozenScopePrefixes: ["docs/swarm/"] },
  riskPolicy: { version: "rp-live-1", irreversiblePrefixes: ["ops/prod/"], undecidablePrefixes: [] },
  roleCatalog: { version: "rc-live-1", roles: { "pure-layer-impl": { floor: "standard", fileDomain: ["packages/bus/src/swarm/"] }, "test-impl": { floor: "standard", fileDomain: ["packages/bus/test/"] }, "io-impl": { floor: "standard", fileDomain: ["scripts/"] } } },
  budgetPolicy: { version: "bp-live-1", coefficientUsdPerPoint: 0.5, maxModelUsd: 1000, maxTotalAttempts: 20, maxWallClockSec: 72000 },
  r4ThresholdPolicy: { version: "tp-live-1", maxTotalComplexity: 1000 },
  sourceBaselineDigest: "live-base",
};

// A multi-requirement PRD so there is a real plan to reconcile. Each requirement is tagged [Ik]; the model is asked to
// tag the task(s) that address each. The F audit is INDEPENDENT of any model "covers" claim (there is none) — it checks
// structured acceptance evidence + omission, against the hand-made baseline below.
const PRD = `Build a pure "plan metrics" module for the swarm brain. Requirements (tag each task's goal with the IDs it addresses):
[I1] a function nodeCount(plan) returning the number of nodes — verified by tests.
[I2] a function totalComplexity(plan) summing node complexity — verified by tests.
[I3] a function hasDesignGate(plan) returning whether a design node exists — verified by tests.
[I4] a function summary(plan) returning a stable one-line string — verified by tests.
[I5] the module must typecheck.
Put the module under packages/bus/src/swarm/ and the tests under packages/bus/test/.
Produce ONE separate task per requirement I1..I5, and put that requirement's exact marker (e.g. [I1]) in that task's goal text.
Each of those five tasks must list "testsPass" in its structuredChecks (I5 also "typecheckPasses"); requiredOutputs kind MUST be
"files" or "report" (NOT "patch"); keep tasks independent (no dependsOn) where possible.
Also include ONE dedicated task whose sourceWriteScope is ["packages/bus/test/"] that writes the unit tests (tag it [TESTS]);
this task must ALSO list "testsPass" in its structuredChecks (every task needs at least one structuredCheck).
Use ONLY the checks "testsPass" and "typecheckPasses" (do NOT use fileExists).`;

const F_BASELINE: ReqBaseline[] = [
  { id: "I1", marker: "[I1]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I2", marker: "[I2]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I3", marker: "[I3]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I4", marker: "[I4]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I5", marker: "[I5]", requiredCheck: "typecheckPasses", expect: "implemented" },
  // UNTAGGED obligation from the PRD prose ("tests under packages/bus/test/"): verified by write scope, not a tag.
  { id: "TESTS-DIR", requiredScopePrefix: "packages/bus/test/", expect: "implemented" },
];

function dump(name: string, data: unknown): void {
  const dir = process.env.A1_EVIDENCE_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "swarm", "t3b-a1-evidence");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`[A1] wrote evidence ${file}`);
}

async function main(): Promise<void> {
  // Resolve the planner model from the tier table against the live catalog — FAIL-CLOSED, no gpt-4o default.
  const catalog = await fetchCatalog();
  const sel = resolvePlannerModel({ catalog, ...(process.env.CPA_MODEL ? { chosen: process.env.CPA_MODEL } : {}), ...(process.env.CPA_MODEL_WHY ? { why: process.env.CPA_MODEL_WHY } : {}) });
  if (!sel.ok) { console.error(`[A1] planner-model resolution FAILED (fail-closed): ${sel.reason}`); process.exit(6); }
  const selection: ModelSelection = sel.selection;
  console.log(`[A1] CPA ${BASE} | planner model=${sel.model} | reasoning_effort=${selection.reasoningEffort ?? "(default)"} | selection=${JSON.stringify(selection)}`);
  const callModel = makeCallModel(sel.model, selection.reasoningEffort);
  const rescore = process.env.A1_RESCORE !== "0"; // the second (complexity) model call; set A1_RESCORE=0 for a single call
  const dr = await draftPlan({ prd: PRD, jobId: "live-job-1", allowedChecks: Object.keys(fc.checkRegistry.checks), rescore }, { callModel });
  if (!dr.ok) { console.error(`[A1] draftPlan REJECTED: ${dr.reason}`); process.exit(2); }
  console.log(`[A1] draftPlan ok: ${dr.draft.tasks.length} task(s), planningRequestId=${dr.planningRequestId.slice(0, 8)}…`);

  const tr = translateDraft(dr.draft, { ...fc, planningRequestId: dr.planningRequestId });
  console.log(`[A1] translateDraft -> ${tr.outcome}`);
  if (tr.outcome !== "loadable") { dump("a1-not-loadable.json", { prd: PRD, draft: dr.draft, result: tr }); console.error(`[A1] not loadable: ${JSON.stringify(tr).slice(0, 400)}`); process.exit(3); }

  const gate = tr.plan.nodes.find((n) => n.kind === "design");
  console.log(`[A1] plan: ${tr.plan.nodes.length} node(s), designGate=${gate ? "yes" : "no"}, planDigest=${tr.plan.planDigest.slice(0, 16)}…`);

  // LOAD-ROUNDTRIP: the produced plan re-loads through the sole legality/digest authority (managed-t3), byte-stable.
  const refs: FrozenRefs = tr.plan.frozenRefs!;
  const again = loadPlan(tr.plan, { mode: "managed-t3", ownerDomainPolicy: fc.ownerDomainPolicy, riskPolicy: fc.riskPolicy, expectedFrozenRefs: refs });
  if (!again.ok) { console.error(`[A1] LOAD-ROUNDTRIP FAILED: ${again.reason}`); process.exit(4); }
  if (again.plan.planDigest !== tr.plan.planDigest) { console.error(`[A1] planDigest drift on reload`); process.exit(5); }
  console.log(`[A1] LOAD-ROUNDTRIP ok (planDigest stable).`);

  // F reconciliation over the REAL produced plan (independent of any model covers claim).
  const f = reconcile(tr.plan, F_BASELINE);
  console.log(`[A1][F] audit=${JSON.stringify(f.audit)} pass=${f.pass} mismatches=${JSON.stringify(f.mismatches)}`);
  dump("a1-evidence.json", { model: sel.model, selection, prd: PRD, rawDraft: dr.draft, plan: tr.plan, fBaseline: F_BASELINE, fAudit: f });
  console.log(`[A1] PASS (compile+roundtrip). F artifact saved${f.pass ? ", F reconciliation matched baseline" : " (see mismatches above)"}.`);
}

main().catch((e) => { console.error(`[A1] CPA unreachable / error: ${(e as Error).message}`); process.exit(1); });
