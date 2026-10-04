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

import { draftPlan, type CallModel } from "../src/swarm/plan-draft.js";
import { translateDraft, type FrozenContext } from "../src/swarm/task-translate.js";
import { loadPlan, type FrozenRefs } from "../src/swarm/task-plan.js";

const BASE = process.env.CPA_BASE_URL ?? "http://127.0.0.1:10808/v1";
const MODEL = process.env.CPA_MODEL ?? "gpt-4o";
const KEY = process.env.CPA_API_KEY ?? "";

const callModel: CallModel = async ({ system, user }) => {
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

const PRD = `Add a pure helper module to the swarm brain that computes a stable "plan summary" string for a TaskPlan
(node count, total complexity, whether a design gate is present). It must be deterministic and have unit tests.
Put the module under packages/bus/src/swarm/ and its tests under packages/bus/test/. Acceptance: tests pass and
typecheck passes.`;

async function main(): Promise<void> {
  console.log(`[A1] CPA ${BASE} model=${MODEL}`);
  const dr = await draftPlan({ prd: PRD, jobId: "live-job-1", allowedChecks: Object.keys(fc.checkRegistry.checks), rescore: true }, { callModel });
  if (!dr.ok) { console.error(`[A1] draftPlan REJECTED: ${dr.reason}`); process.exit(2); }
  console.log(`[A1] draftPlan ok: ${dr.draft.tasks.length} task(s), planningRequestId=${dr.planningRequestId.slice(0, 8)}…`);

  const tr = translateDraft(dr.draft, { ...fc, planningRequestId: dr.planningRequestId });
  console.log(`[A1] translateDraft -> ${tr.outcome}`);
  if (tr.outcome !== "loadable") { console.error(`[A1] not loadable: ${JSON.stringify(tr).slice(0, 400)}`); process.exit(3); }

  const gate = tr.plan.nodes.find((n) => n.kind === "design");
  console.log(`[A1] plan: ${tr.plan.nodes.length} node(s), designGate=${gate ? "yes" : "no"}, planDigest=${tr.plan.planDigest.slice(0, 16)}…`);

  // LOAD-ROUNDTRIP: the produced plan re-loads through the sole legality/digest authority (managed-t3), byte-stable.
  const refs: FrozenRefs = tr.plan.frozenRefs;
  const again = loadPlan(tr.plan, { mode: "managed-t3", ownerDomainPolicy: fc.ownerDomainPolicy, riskPolicy: fc.riskPolicy, expectedFrozenRefs: refs });
  if (!again.ok) { console.error(`[A1] LOAD-ROUNDTRIP FAILED: ${again.reason}`); process.exit(4); }
  if (again.plan.planDigest !== tr.plan.planDigest) { console.error(`[A1] planDigest drift on reload`); process.exit(5); }
  console.log(`[A1] LOAD-ROUNDTRIP ok (planDigest stable). PASS.`);
}

main().catch((e) => { console.error(`[A1] CPA unreachable / error: ${(e as Error).message}`); process.exit(1); });
