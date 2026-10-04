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

/** CAS-winning, questionId-sorted answer set — the canonical form the operationId digests over (design: "按 questionId
 *  排序、只含 CAS 获胜答复"). Duplicate answers for one questionId collapse to the highest casSeq (tie: last seen). */
export function canonicalAnswerSet(answers: ClarificationAnswer[]): Array<{ questionId: string; reversible: boolean; owner?: string }> {
  const win = new Map<string, ClarificationAnswer>();
  for (const a of answers) {
    const prev = win.get(a.questionId);
    if (prev === undefined || (a.casSeq ?? 0) >= (prev.casSeq ?? 0)) win.set(a.questionId, a);
  }
  return [...win.values()]
    .sort((x, y) => (x.questionId < y.questionId ? -1 : x.questionId > y.questionId ? 1 : 0))
    .map((a) => ({ questionId: a.questionId, reversible: a.reversible, ...(a.owner !== undefined ? { owner: a.owner } : {}) }));
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
  | { ok: true; draft: Draft; fc: FrozenContext }
  | { ok: false; reason: string }
  | { incomplete: true; unanswered: string[] };

/** Fold answers into a new (D', C'). Never mutates the originals (content-addressed snapshot stays immutable):
 *   C'.undecidablePrefixes drops a prefix only once EVERY node path overlapping it has been answered (a sibling path on
 *     an unanswered, non-critical node keeps the prefix — no silent widening of its gate to reversible);
 *   C'.irreversiblePrefixes gains every answered-irreversible path (=> that node now hits the design gate, safe);
 *   D' clears criticalPath on an answered node whose path still overlaps a kept prefix (sibling conflict) so it GATES
 *     instead of re-asking — a safe fallback. ponytail: a per-node explicit risk marker (design §3 "节点显式标记") would
 *     make the reversible case exact even under sibling conflict; deferred to the CPA-ledger batch.
 *  Returns incomplete (=> caller keeps needsClarification, the safe default) when any emitted question is unanswered. */
export function projectAnswers(draft: Draft, fc: FrozenContext, answers: ClarificationAnswer[]): ProjectResult {
  const targets = clarifyTargets(draft, fc);
  if (targets.length === 0) return { ok: false, reason: "no open clarification for this (draft, frozenContext)" };
  const canon = canonicalAnswerSet(answers);
  const byId = new Map(canon.map((a) => [a.questionId, a]));
  const unanswered = targets.filter((t) => !byId.has(t.questionId)).map((t) => t.questionId);
  if (unanswered.length > 0) return { incomplete: true, unanswered };

  const answeredPaths = new Map<string, boolean>(); // path -> reversible
  for (const t of targets) answeredPaths.set(t.path, byId.get(t.questionId)!.reversible);
  const allNodePaths = new Set<string>();
  for (const t of draft.tasks) for (const p of t.sourceWriteScope ?? []) allNodePaths.add(p);

  const risk = fc.riskPolicy;
  const keptUndecidable = risk.undecidablePrefixes.filter((Q) => [...allNodePaths].some((p) => overlaps(p, Q) && !answeredPaths.has(p)));
  const addIrreversible = [...answeredPaths.entries()].filter(([, rev]) => rev === false).map(([p]) => p);
  const newIrreversible = [...new Set([...risk.irreversiblePrefixes, ...addIrreversible])].sort();
  const answerDigest = digestOf(canon);
  const fcPrime: FrozenContext = {
    ...fc,
    riskPolicy: { version: `${risk.version}+clar-${answerDigest.slice(0, 8)}`, irreversiblePrefixes: newIrreversible, undecidablePrefixes: keptUndecidable.slice().sort() },
  };

  const stillUnknownNodes = new Set<string>();
  for (const t of targets) if (overlapsAny(t.path, keptUndecidable)) stillUnknownNodes.add(t.nodeId);
  const draftPrime: Draft = stillUnknownNodes.size === 0 ? draft : { ...draft, tasks: draft.tasks.map((t) => (stillUnknownNodes.has(t.nodeId) ? { ...t, criticalPath: false } : t)) };
  return { ok: true, draft: draftPrime, fc: fcPrime };
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
  | { outcome: "loadable"; plan: TaskPlan; operationId: string; snapshotDigest: string; answerSetDigest: string }
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

  const answerSetDigest = digestOf(canonicalAnswerSet(i.answers));
  const operationId = mintPlanOperationId({
    planningRequestId: i.fc.planningRequestId,
    entityKey: i.draft.jobId,
    actionKind: i.actionKind ?? "plan",
    snapshotDigest: i.snapshotDigest,
    canonicalAnswerSetDigest: answerSetDigest,
  });
  return { outcome: "loadable", plan: res.plan, operationId, snapshotDigest: i.snapshotDigest, answerSetDigest };
}
