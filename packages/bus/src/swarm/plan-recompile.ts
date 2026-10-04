/**
 * T3b recompile loop + deterministic operationId (frozen design 1d0a1ffc §1 "答复物化与重编译环" + "铸号" — formerly
 * 60c9ffa7 §7; coordinator dispatch 2026-10-04 points 3+4) — PURE, zero IO, zero LLM. Builds ON the signed-off T3a
 * translateDraft/evaluateR4 without touching them (narrow-review discipline).
 *
 * The problem it solves: translateDraft is a pure deterministic function, so re-running the SAME (draft, frozenContext)
 * after a needsClarification necessarily yields needsClarification again. An answer must therefore be MATERIALIZED into
 * a new input version — a projected draft D' and/or a new frozenContext version C' — and the recompile is T(D', C'). The
 * original snapshot is content-addressed and never rewritten (projectAnswers only spread-copies).
 *
 * Minting (design "铸号"): operationId = digest(planningRequestId, entityKey, actionKind, snapshotDigest,
 * canonicalAnswerSetDigest). planningRequestId pins the id to a REQUEST ROUND so two independent requests that happen to
 * copy the same PRD+answers mint DIFFERENT ids (the op-conflict-freeze trap: the operations table is global, so same
 * content + different request must not collide). Same request + same round + same answer set re-mints the SAME id => a
 * benign replay no-op in control-log (guard 2). translateDraft (T3a) still mints nothing; this is the only minter.
 */

import { translateDraft, type Draft, type FrozenContext, type ClarificationQuestion } from "./task-translate.js";
import type { TaskPlan } from "./task-plan.js";
import { evaluateR4, overlaps, overlapsAny } from "./task-r4.js";
import { digestOf } from "./digest.js";

/** A requester's answer to one clarification question. STRUCTURED (no NL parsing, consistent with translateDraft):
 *  reversible resolves the unknown-risk the question asked about; owner is advisory this batch. casSeq is the optional
 *  compare-and-swap ordinal — the highest wins when a questionId is answered more than once (canonical set keeps winners). */
export type ClarificationAnswer = { questionId: string; reversible: boolean; owner?: string; casSeq?: number };

/** The (questionId -> nodeId, path) the needsClarification branch of translateDraft emits, reconstructed from the SAME
 *  deterministic derivation (NOT by parsing question text). A test pins that these questionIds equal translateDraft's,
 *  so a T3a format change breaks the test rather than silently drifting. Only meaningful for a needsClarification input. */
export type ClarifyTarget = { questionId: string; nodeId: string; path: string };
export function clarifyTargets(draft: Draft, fc: FrozenContext): ClarifyTarget[] {
  const critical = new Set<string>(draft.tasks.filter((t) => t?.criticalPath === true && typeof t?.nodeId === "string").map((t) => t.nodeId));
  const assess = evaluateR4(draft.tasks.map((t) => ({ nodeId: t?.nodeId, sourceWriteScope: t?.sourceWriteScope })), fc.ownerDomainPolicy, fc.riskPolicy);
  const criticalUnknown = assess.unknownRiskNodeIds.filter((id) => critical.has(id)); // preserves evaluateR4 node order
  const out: ClarifyTarget[] = [];
  for (const id of criticalUnknown) {
    const node = draft.tasks.find((t) => t?.nodeId === id);
    for (const p of node?.sourceWriteScope ?? []) if (overlapsAny(p, fc.riskPolicy.undecidablePrefixes)) out.push({ questionId: `q-risk-${id}-${out.length}`, nodeId: id, path: p });
  }
  return out;
}

export type CanonicalAnswer = { questionId: string; reversible: boolean; owner?: string };
export type AnswerSetResult = { ok: true; set: CanonicalAnswer[] } | { ok: false; reason: string };

/** The canonical, CAS-winning answer set (design: "按 questionId 排序、只含 CAS 获胜答复"). A VALID answer needs a
 *  non-empty questionId and a STRICT boolean reversible — anything else (undefined/null/"false"/0) is dropped (not an
 *  answer at a trust boundary; its question stays unanswered). The CAS winner must be UNIQUE and PROVABLE: among the
 *  answers at the HIGHEST casSeq for a questionId, a disagreement on reversible has no winner => REJECT (never let array
 *  order decide). Order-independent. */
export function canonicalAnswerSet(answers: ClarificationAnswer[]): AnswerSetResult {
  const groups = new Map<string, ClarificationAnswer[]>();
  for (const a of answers) {
    if (a === null || typeof a !== "object" || typeof a.questionId !== "string" || a.questionId.length === 0 || typeof a.reversible !== "boolean") continue;
    const g = groups.get(a.questionId);
    if (g) g.push(a); else groups.set(a.questionId, [a]);
  }
  const set: CanonicalAnswer[] = [];
  for (const [qid, g] of groups) {
    const maxCas = Math.max(...g.map((a) => a.casSeq ?? 0));
    const top = g.filter((a) => (a.casSeq ?? 0) === maxCas);
    if (new Set(top.map((a) => a.reversible)).size > 1) return { ok: false, reason: `conflicting answers for ${qid} at the same CAS seq ${maxCas} (no provable winner)` };
    const owners = new Set(top.map((a) => a.owner));
    set.push({ questionId: qid, reversible: top[0]!.reversible, ...(owners.size === 1 && top[0]!.owner !== undefined ? { owner: top[0]!.owner } : {}) });
  }
  set.sort((x, y) => (x.questionId < y.questionId ? -1 : x.questionId > y.questionId ? 1 : 0));
  return { ok: true, set };
}

export const PLAN_OP_NAMESPACE = "swarm-plan-op/1";
export type PlanOpInput = { planningRequestId: string; entityKey: string; actionKind: string; snapshotDigest: string; canonicalAnswerSetDigest: string };
/** The sole plan operationId minter. Deterministic in all five inputs; planningRequestId is REQUIRED (op identity must be
 *  pinned to a request round — without it two copies of the same content would collide into a frozen op-conflict). */
export function mintPlanOperationId(i: PlanOpInput): string {
  if (!i.planningRequestId) throw new Error("mintPlanOperationId: planningRequestId is required (operationId must be pinned to a request round)");
  return digestOf({ ns: PLAN_OP_NAMESPACE, planningRequestId: i.planningRequestId, entityKey: i.entityKey, actionKind: i.actionKind, snapshotDigest: i.snapshotDigest, canonicalAnswerSetDigest: i.canonicalAnswerSetDigest });
}

export type ProjectResult =
  | { ok: true; draft: Draft; fc: FrozenContext; canonAnswers: CanonicalAnswer[] }
  | { ok: false; reason: string }
  | { incomplete: true; unanswered: string[] };

/** Fold answers into a new (D', C'). Never mutates the originals (content-addressed snapshot stays immutable) and NEVER
 *  rewrites the requester's criticalPath declaration — an answer about reversibility is not a new criticality fact.
 *  Resolution is PATH-EXACT: each answer binds to its own node path, so a sibling path on an unanswered node keeps its
 *  unknown status.
 *   - Per path, conservatively: reversible only if every answer touching it agrees (any irreversible wins => gate).
 *   - C'.undecidablePrefixes: a prefix an answer TOUCHES is replaced by the still-UNANSWERED node paths under it
 *     (siblings stay unknown => design gate); a prefix no answer touches is kept verbatim. So the answered path leaves
 *     the unknown set exactly, without de-classifying siblings and without touching criticalPath.
 *   - C'.irreversiblePrefixes gains every answered-irreversible path.
 *   - C'.version is CONTENT-addressed over the RESULTING policy, so two different projected policies never share a version
 *     (a managed reload cannot accept a swapped policy).
 *  Returns {ok:false} on a conflicting (no-provable-winner) answer set; incomplete when any emitted question is unanswered
 *  (=> caller keeps needsClarification, the safe default). */
export function projectAnswers(draft: Draft, fc: FrozenContext, answers: ClarificationAnswer[]): ProjectResult {
  const targets = clarifyTargets(draft, fc);
  if (targets.length === 0) return { ok: false, reason: "no open clarification for this (draft, frozenContext)" };
  const canonR = canonicalAnswerSet(answers);
  if (!canonR.ok) return { ok: false, reason: canonR.reason };
  const canon = canonR.set;
  const byId = new Map(canon.map((a) => [a.questionId, a]));
  const unanswered = targets.filter((t) => !byId.has(t.questionId)).map((t) => t.questionId);
  if (unanswered.length > 0) return { incomplete: true, unanswered };

  // Conservative per-path aggregate: reversible only if every answer for that path agrees. Any irreversible wins (=> gate).
  const reversibleByPath = new Map<string, boolean>();
  for (const t of targets) reversibleByPath.set(t.path, (reversibleByPath.get(t.path) ?? true) && byId.get(t.questionId)!.reversible);
  const answeredPathSet = new Set(reversibleByPath.keys());
  const allNodePaths = new Set<string>();
  for (const t of draft.tasks) for (const p of t.sourceWriteScope ?? []) allNodePaths.add(p);

  const risk = fc.riskPolicy;
  // Path-exact undecidable resolution: replace a touched prefix with the UNANSWERED node paths still under it.
  const newUndecidableSet = new Set<string>();
  for (const Q of risk.undecidablePrefixes) {
    if (![...answeredPathSet].some((p) => overlaps(p, Q))) { newUndecidableSet.add(Q); continue; } // untouched prefix kept verbatim
    for (const p of allNodePaths) if (overlaps(p, Q) && !answeredPathSet.has(p)) newUndecidableSet.add(p); // siblings stay unknown
  }
  const addIrreversible = [...reversibleByPath.entries()].filter(([, rev]) => rev === false).map(([p]) => p);
  const newIrreversible = [...new Set([...risk.irreversiblePrefixes, ...addIrreversible])].sort();
  const newUndecidable = [...newUndecidableSet].sort();
  const contentDigest = digestOf({ base: risk.version, irreversiblePrefixes: newIrreversible, undecidablePrefixes: newUndecidable, answers: canon });
  const fcPrime: FrozenContext = {
    ...fc,
    riskPolicy: { version: `${risk.version}+clar-${contentDigest.slice(0, 16)}`, irreversiblePrefixes: newIrreversible, undecidablePrefixes: newUndecidable },
  };
  // D' = draft unchanged: criticalPath is the requester's declaration and is never forged away by a reversibility answer.
  return { ok: true, draft, fc: fcPrime, canonAnswers: canon };
}

export type RecompileInput = {
  /** The ORIGINAL draft, from the immutable resume bundle. */
  draft: Draft;
  /** The ORIGINAL frozenContext (resolved from the bundle's version refs). MUST carry planningRequestId (op identity). */
  fc: FrozenContext;
  answers: ClarificationAnswer[];
  /** The resume bundle's payloadRef (content-addressed digest of the immutable snapshot). */
  snapshotDigest: string;
  /** The control action kind this commit will carry (default "plan"). */
  actionKind?: string;
};
export type RecompileResult =
  | { outcome: "loadable"; plan: TaskPlan; operationId: string; snapshotDigest: string; answerSetDigest: string; projectedDraft: Draft; projectedFc: FrozenContext }
  | { outcome: "needsClarification"; questions: ClarificationQuestion[]; unanswered: string[] }
  | { outcome: "needsRole"; missingRoles: string[]; reason: string }
  | { outcome: "rejected"; reason: string };

/** The recompile environment: materialize answers -> (D', C'), re-translate, and (only on loadable) mint the deterministic
 *  operationId for the commit. Incomplete answers keep needsClarification; a re-ask / role / reject passes through. */
export function recompilePlan(i: RecompileInput): RecompileResult {
  if (!i.fc.planningRequestId) return { outcome: "rejected", reason: "recompile requires frozenContext.planningRequestId (operationId identity); translateDraft does not mint" };
  const proj = projectAnswers(i.draft, i.fc, i.answers);
  if ("incomplete" in proj) {
    const base = translateDraft(i.draft, i.fc);
    return { outcome: "needsClarification", questions: base.outcome === "needsClarification" ? base.questions : [], unanswered: proj.unanswered };
  }
  if (!proj.ok) return { outcome: "rejected", reason: proj.reason };

  const res = translateDraft(proj.draft, proj.fc);
  if (res.outcome === "needsClarification") return { outcome: "needsClarification", questions: res.questions, unanswered: [] };
  if (res.outcome === "needsRole") return { outcome: "needsRole", missingRoles: res.missingRoles, reason: res.reason };
  if (res.outcome === "rejected") return { outcome: "rejected", reason: res.reason };

  const answerSetDigest = digestOf(proj.canonAnswers); // the SAME validated/canonical set the projection used
  const operationId = mintPlanOperationId({
    planningRequestId: i.fc.planningRequestId,
    entityKey: i.draft.jobId,
    actionKind: i.actionKind ?? "plan",
    snapshotDigest: i.snapshotDigest,
    canonicalAnswerSetDigest: answerSetDigest,
  });
  return { outcome: "loadable", plan: res.plan, operationId, snapshotDigest: i.snapshotDigest, answerSetDigest, projectedDraft: proj.draft, projectedFc: proj.fc };
}
