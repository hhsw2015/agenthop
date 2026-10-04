/**
 * T3b draftPlan (design 1d0a1ffc §1 "draftPlan(prompt 资产,LLM 调用)" + §4 + coordinator point 1) — the ONE impure step
 * of the T3 pipeline: PRD -> a structured Draft (translateDraft's input). The LLM transport is INJECTED (callModel), so
 * the module stays testable offline and the live-fire A1 just wires a real CPA-routed call. draftPlan does NOT translate
 * — it only produces/validates the Draft; the orchestrator feeds it to the pure translateDraft (and threads the
 * planningRequestId into frozenContext for minting).
 *
 * Tier discipline (既有档位纪律 / PLANNER-HEAVY): the draft (and expand) call is ALWAYS plannerOperationTier()=heavy; a
 * caller cannot drive it from a lower tier. Strong schema: the model's text is JSON.parse'd strictly (one surrounding code
 * fence tolerated, nothing more) and shape-checked at the top level; a parse/shape failure is a REJECT, never a repair —
 * deep per-field validation stays with translateDraft, the sole authority.
 *
 * planningRequestId is the REQUEST-ROUND identity: caller-supplied, else a fresh uuid. It is NOT content-derived — two
 * independent requests that copy the same PRD must get DIFFERENT ids (the op-conflict-freeze trap). draftPlan surfaces it;
 * the caller threads it into frozenContext.planningRequestId so recompilePlan can mint deterministically.
 */

import { randomUUID } from "node:crypto";
import { plannerOperationTier, type Draft, type DraftTask } from "./task-translate.js";
import type { ModelTier } from "./task-plan.js";
import { PROMPT_ASSETS, fillPrompt } from "./plan-prompts.js";
import { sha256Hex } from "./digest.js";

export type ModelRequest = { system: string; user: string; tier: ModelTier };
export type CallModel = (req: ModelRequest) => Promise<string>;

export type DraftPlanInput = {
  prd: string;
  jobId: string;
  /** Request-round identity; a fresh uuid if omitted. Never content-derived. */
  planningRequestId?: string;
  planRevision?: number;
  /** The frozenContext checkRegistry's known check names — injected into the prompt so the model stays in-registry. */
  allowedChecks: string[];
  /** Run the independent complexity re-score step (fills independentScore). Default false. */
  rescore?: boolean;
};
export type DraftPlanDeps = { callModel: CallModel };
export type DraftPlanResult =
  | { ok: true; draft: Draft; planningRequestId: string; prdDigest: string }
  | { ok: false; reason: string };

/** Strip at most one surrounding ```...``` / ```json fence, then JSON.parse strictly. Anything else that fails to parse
 *  is a reject (no free-text tolerance beyond unwrapping the one well-known envelope models emit). */
function parseStrict(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let s = text.trim();
  const fence = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(s);
  if (fence) s = fence[1]!.trim();
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, reason: `model output is not valid JSON: ${(e as Error).message}` };
  }
}

export async function draftPlan(input: DraftPlanInput, deps: DraftPlanDeps): Promise<DraftPlanResult> {
  if (typeof input.prd !== "string" || input.prd.trim().length === 0) return { ok: false, reason: "prd must be a non-empty string" };
  if (typeof input.jobId !== "string" || input.jobId.length === 0) return { ok: false, reason: "jobId must be a non-empty string" };
  const planningRequestId = input.planningRequestId && input.planningRequestId.length > 0 ? input.planningRequestId : randomUUID();
  const tier = plannerOperationTier(); // always heavy

  const { system, user } = fillPrompt(PROMPT_ASSETS["plan-draft"]!, { jobId: input.jobId, prd: input.prd, allowedChecks: input.allowedChecks.join(", ") });
  let raw: string;
  try {
    raw = await deps.callModel({ system, user, tier });
  } catch (e) {
    return { ok: false, reason: `draftPlan model call failed: ${(e as Error).message}` };
  }
  const parsed = parseStrict(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const obj = parsed.value;
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, reason: "draft must be a JSON object" };
  const tasks = (obj as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, reason: "draft.tasks must be a non-empty array" };

  // jobId is the CALLER's identity, not the model's echo; planRevision from the caller. Deep validation is translateDraft's.
  const draft: Draft = { jobId: input.jobId, ...(input.planRevision !== undefined ? { planRevision: input.planRevision } : {}), tasks: tasks as DraftTask[] };

  if (input.rescore) {
    const scored = await rescoreComplexity(draft, input, deps, tier);
    if (!scored.ok) return scored;
    return { ok: true, draft: scored.draft, planningRequestId, prdDigest: sha256Hex(input.prd) };
  }
  return { ok: true, draft, planningRequestId, prdDigest: sha256Hex(input.prd) };
}

/** Independent per-task re-score (anti-bias). Strict: a non-parseable or wrong-shaped response rejects — we do not quietly
 *  proceed with the possibly-biased self-scores. Merges independentScore onto matching nodeIds; translateDraft then takes
 *  max(self, independent) (SCORE-DISAGREES). */
async function rescoreComplexity(draft: Draft, input: DraftPlanInput, deps: DraftPlanDeps, tier: ModelTier): Promise<{ ok: true; draft: Draft } | { ok: false; reason: string }> {
  const { system, user } = fillPrompt(PROMPT_ASSETS["complexity"]!, { jobId: input.jobId, tasks: JSON.stringify(draft.tasks.map((t) => ({ nodeId: t.nodeId, goal: t.goal, complexity: t.complexity }))) });
  let raw: string;
  try {
    raw = await deps.callModel({ system, user, tier });
  } catch (e) {
    return { ok: false, reason: `complexity re-score call failed: ${(e as Error).message}` };
  }
  const parsed = parseStrict(raw);
  if (!parsed.ok) return { ok: false, reason: `complexity re-score: ${parsed.reason}` };
  if (!Array.isArray(parsed.value)) return { ok: false, reason: "complexity re-score must be a JSON array of {nodeId, independentScore}" };
  const byId = new Map<string, number>();
  for (const e of parsed.value as unknown[]) {
    if (typeof e !== "object" || e === null) return { ok: false, reason: "complexity re-score entry must be an object" };
    const nodeId = (e as Record<string, unknown>).nodeId;
    const score = (e as Record<string, unknown>).independentScore;
    if (typeof nodeId !== "string" || typeof score !== "number") return { ok: false, reason: "complexity re-score entry needs {nodeId:string, independentScore:number}" };
    byId.set(nodeId, score);
  }
  const tasks = draft.tasks.map((t) => (byId.has(t.nodeId) ? { ...t, independentScore: byId.get(t.nodeId)! } : t));
  return { ok: true, draft: { ...draft, tasks } };
}
