/**
 * T3b acceptance A1 (design 1d0a1ffc §3) — the REAL-LLM live-fire: a real PRD -> draftPlan (a real model call routed
 * through CPA, OpenAI-compatible) -> translateDraft -> loadPlan round-trip. Prints the evidence (outcome, node/gate count,
 * planDigest) for the review packet. NOT a unit test (it spends a real model call); run it by hand:
 *
 *   CPA_BASE_URL=http://127.0.0.1:10808/v1 CPA_MODEL=<model> [CPA_API_KEY=...] \
 *     node --import tsx packages/bus/scripts/t3-draft-live.ts
 *
 * Offline/no-CPA: it prints a clear "CPA unreachable" line and exits non-zero, so it can't masquerade as a pass.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftPlan, type CallModel } from "../src/swarm/plan-draft.js";
import { translateDraft, type FrozenContext } from "../src/swarm/task-translate.js";
import { loadPlan, type FrozenRefs } from "../src/swarm/task-plan.js";
import { reconcile, type ReqBaseline } from "./coverage-audit.js";

const BASE = process.env.CPA_BASE_URL ?? "http://127.0.0.1:10808/v1";
const MODEL = process.env.CPA_MODEL ?? "gpt-4o";
const KEY = process.env.CPA_API_KEY ?? "";

// Claude models speak the Anthropic /v1/messages API; everything else speaks OpenAI /v1/chat/completions.
const isClaude = /(^|\/)claude/i.test(MODEL);

const callModel: CallModel = async ({ system, user }) => {
  if (isClaude) {
    const res = await fetch(`${BASE}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(KEY ? { authorization: `Bearer ${KEY}`, "x-api-key": KEY } : {}) },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, temperature: 0, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`CPA ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (!text) throw new Error(`CPA returned no text content: ${JSON.stringify(json).slice(0, 300)}`);
    return text;
  }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model: MODEL, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`CPA ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`CPA returned no message content: ${JSON.stringify(json).slice(0, 300)}`);
  return content;
};

const fc: FrozenContext = {
  checkRegistry: { version: "cr-live-1", checks: { testsPass: {}, typecheckPasses: {}, fileExists: { args: { path: { type: "string", required: true } } } } },
  ownerDomainPolicy: { version: "op-live-1", ownerByPrefix: [{ prefix: "packages/bus/src/swarm/", domain: "pure" }, { prefix: "scripts/", domain: "io" }], frozenScopePrefixes: ["docs/swarm/"] },
  riskPolicy: { version: "rp-live-1", irreversiblePrefixes: ["ops/prod/"], undecidablePrefixes: [] },
  roleCatalog: { version: "rc-live-1", roles: { "pure-layer-impl": { floor: "standard", fileDomain: ["packages/bus/src/swarm/"] }, "io-impl": { floor: "standard", fileDomain: ["scripts/"] } } },
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
Put the module under packages/bus/src/swarm/ and tests under packages/bus/test/. Use the allowed checks for acceptance.
Each task's requiredOutputs kind MUST be "files" or "report" (NOT "patch"). Keep tasks independent (no dependsOn) where possible.`;

const F_BASELINE: ReqBaseline[] = [
  { id: "I1", marker: "[I1]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I2", marker: "[I2]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I3", marker: "[I3]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I4", marker: "[I4]", requiredCheck: "testsPass", expect: "implemented" },
  { id: "I5", marker: "[I5]", requiredCheck: "typecheckPasses", expect: "implemented" },
];

function dump(name: string, data: unknown): void {
  const dir = process.env.A1_EVIDENCE_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "swarm", "t3b-a1-evidence");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`[A1] wrote evidence ${file}`);
}

async function main(): Promise<void> {
  console.log(`[A1] CPA ${BASE} model=${MODEL}`);
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
  dump("a1-evidence.json", { model: MODEL, prd: PRD, rawDraft: dr.draft, plan: tr.plan, fBaseline: F_BASELINE, fAudit: f });
  console.log(`[A1] PASS (compile+roundtrip). F artifact saved${f.pass ? ", F reconciliation matched baseline" : " (see mismatches above)"}.`);
}

main().catch((e) => { console.error(`[A1] CPA unreachable / error: ${(e as Error).message}`); process.exit(1); });
