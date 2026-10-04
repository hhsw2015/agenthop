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
import { evaluateR4, overlapsAny, type NodeRisk } from "./task-r4.js";
import { digestOf } from "./digest.js";
import type { WaitRecord, WaitResolution } from "./control-log.js";

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
    // casSeq must be absent or a finite number — a string/NaN casSeq would poison Math.max and the top-group filter.
    if (a.casSeq !== undefined && (typeof a.casSeq !== "number" || !Number.isFinite(a.casSeq))) continue;
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

/** The per-node resolution a projection yields: the risk plus the exact paths that were answered for that node. */
export type NodeResolution = { risk: NodeRisk; answeredPaths: string[] };
export type ProjectResult =
  | { ok: true; resolvedRisk: Record<string, NodeResolution>; canonAnswers: CanonicalAnswer[] }
  | { ok: false; reason: string }
  | { incomplete: true; unanswered: string[] };

/** Fold answers into a per-NODE risk map (design §3 "节点显式标记") — nodeId+path bound, NOT a global path set. Never
 *  mutates the originals and NEVER touches criticalPath (a reversibility answer is not a criticality fact). A node is
 *  resolved only from ITS OWN answered paths: irreversible if ANY of its answers is irreversible, else reversible. Because
 *  clarifyTargets asks every (critical node, undecidable path) and recompile requires all answered, a resolved node has ALL
 *  its undecidable paths adjudicated — a partial answer never clears a node. An UNANSWERED (e.g. non-critical) node writing
 *  the same or an overlapping path gets NO entry, so it keeps its policy unknown-risk (and thus its design gate).
 *  Returns {ok:false} on a conflicting answer set; incomplete when any emitted question is unanswered (=> needsClarification). */
export function projectAnswers(draft: Draft, fc: FrozenContext, answers: ClarificationAnswer[]): ProjectResult {
  const targets = clarifyTargets(draft, fc);
  if (targets.length === 0) return { ok: false, reason: "no open clarification for this (draft, frozenContext)" };
  const canonR = canonicalAnswerSet(answers);
  if (!canonR.ok) return { ok: false, reason: canonR.reason };
  const canon = canonR.set;
  const byId = new Map(canon.map((a) => [a.questionId, a]));
  const unanswered = targets.filter((t) => !byId.has(t.questionId)).map((t) => t.questionId);
  if (unanswered.length > 0) return { incomplete: true, unanswered };

  // Per-node aggregate (conservative): any irreversible answer => irreversible; else reversible. Track the answered paths so
  // the evidence can be checked against the loader's current unknown-path set.
  const perNode = new Map<string, NodeResolution>();
  for (const t of targets) {
    const rev = byId.get(t.questionId)!.reversible;
    const prev = perNode.get(t.nodeId);
    const paths = prev ? (prev.answeredPaths.includes(t.path) ? prev.answeredPaths : [...prev.answeredPaths, t.path]) : [t.path];
    perNode.set(t.nodeId, { risk: prev?.risk === "irreversible" || !rev ? "irreversible" : "reversible", answeredPaths: paths });
  }
  return { ok: true, resolvedRisk: Object.fromEntries(perNode), canonAnswers: canon };
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
/** Trusted per-node risk EVIDENCE for the managed loader. Bound to BOTH (a) the node's TASK IDENTITY (specDigest) — so a
 *  tampered scope no longer matches — AND (b) the exact ANSWERED paths — so the override is honored only when every path
 *  that is unknown under the LOADER'S CURRENT policy was actually answered. A policy that adds a new unknown path to the
 *  same node (specDigest unchanged) is therefore NOT cleared by stale evidence (reviewer ①). */
export type RiskEvidence = Record<string, { risk: NodeRisk; specDigest: string; answeredPaths: string[] }>;

export type RecompileResult =
  | { outcome: "loadable"; plan: TaskPlan; operationId: string; snapshotDigest: string; answerSetDigest: string; resolvedRisk: RiskEvidence; projectedDraft: Draft; projectedFc: FrozenContext }
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

  // Re-translate the ORIGINAL draft/fc with the trusted per-node resolvedRisk map (design §3): resolved critical nodes stop
  // being unknown-risk; unanswered nodes keep policy risk (and their gate). criticalPath declarations are untouched.
  const res = translateDraft(i.draft, i.fc, { resolvedRisk: proj.resolvedRisk });
  // All questions were answered, so a re-translate that STILL needs clarification is a safety-net defect — reject, never loop.
  if (res.outcome === "needsClarification") return { outcome: "rejected", reason: "projected plan unexpectedly still needs clarification after a complete, trusted answer set" };
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
  // Build evidence from the PRODUCED plan (each resolved node's specDigest) + the answered paths, so a consumer can managed-reload.
  const resolvedRisk: RiskEvidence = {};
  for (const n of res.plan.nodes) if (n.resolvedRisk !== undefined) resolvedRisk[n.nodeId] = { risk: n.resolvedRisk, specDigest: n.specDigest, answeredPaths: proj.resolvedRisk[n.nodeId]?.answeredPaths ?? [] };
  return { outcome: "loadable", plan: res.plan, operationId, snapshotDigest: i.snapshotDigest, answerSetDigest, resolvedRisk, projectedDraft: i.draft, projectedFc: i.fc };
}

/** The clarification answer rides on the query-wait's CLOSE resolution (no new WaitRecord field): the outcome string encodes
 *  reversibility. advanceWait already enforces first-close-wins (a close on a resolved wait is rejected), so the resolved
 *  wait carries the single trusted winner — never a transport-order or caller-casSeq pick. */
export const CLARIFY_OUTCOME = { reversible: "clarified:reversible", irreversible: "clarified:irreversible" } as const;
export function clarificationResolution(reversible: boolean, sourceOperationId: string): WaitResolution {
  return { outcome: reversible ? CLARIFY_OUTCOME.reversible : CLARIFY_OUTCOME.irreversible, reason: `requester clarified: ${reversible ? "reversible" : "irreversible"}`, sourceOperationId };
}

/** The DURABLE per-question binding a query-wait carries as its payloadRef: a COMPOSITE "<bundlePayloadRef>:<questionId>".
 *  It binds the wait to ONE question of ONE snapshot (so a single close cannot be re-pasted onto another question — reviewer
 *  round-4 ①) AND keeps the bundle payloadRef RECOVERABLE from the wait alone (so a restart can loadBundle it — reviewer
 *  round-5 ②; the bundle-ref-only contract of design line 21 is preserved, just with a question suffix). The bundle ref is
 *  64-hex (no ':'), so the FIRST ':' splits it from the questionId. */
export function questionWaitRef(payloadRef: string, questionId: string): string {
  return `${payloadRef}:${questionId}`;
}
export function parseQuestionWaitRef(ref: string | undefined): { payloadRef: string; questionId: string } | null {
  if (typeof ref !== "string") return null;
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { payloadRef: ref.slice(0, idx), questionId: ref.slice(idx + 1) };
}

const CLARIFY_OUTCOMES: ReadonlySet<string> = new Set([CLARIFY_OUTCOME.reversible, CLARIFY_OUTCOME.irreversible]);
const reversibleOf = (outcome: string): boolean => outcome === CLARIFY_OUTCOME.reversible;

/** Derive the answer set from CLOSED query-waits — the trusted-winner source (reviewer P2-4/seam-3). The winner is the
 *  close FACT (advanceWait enforces first-close-wins), never a caller casSeq. A wait resolved by its pre-stored default on
 *  timeout (outcome "default-applied") is honored ONLY when that default was itself a clarification (reviewer ③ — recover
 *  via the default). A cancel/supersede/other terminal reason is NOT an answer -> rejected (never guessed). */
export function answersFromClosedWaits(entries: Array<{ questionId: string; wait: WaitRecord }>): { ok: true; answers: ClarificationAnswer[] } | { ok: false; reason: string } {
  const answers: ClarificationAnswer[] = [];
  for (const { questionId, wait } of entries) {
    if (typeof questionId !== "string" || questionId.length === 0) return { ok: false, reason: "a closed-wait entry needs a non-empty questionId" };
    if (wait.state !== "resolved") return { ok: false, reason: `wait for ${questionId} is not closed (state=${wait.state}) — only a closed-wait fact is a trusted answer` };
    const outcome = wait.resolution?.outcome ?? "";
    if (CLARIFY_OUTCOMES.has(outcome)) { answers.push({ questionId, reversible: reversibleOf(outcome) }); continue; }
    // timeout default: recover ONLY if the pre-stored default was itself a clarification resolution.
    const dflt = wait.defaultOnTimeout?.outcome;
    if (outcome === "default-applied" && dflt !== undefined && CLARIFY_OUTCOMES.has(dflt)) { answers.push({ questionId, reversible: reversibleOf(dflt) }); continue; }
    return { ok: false, reason: `wait for ${questionId} is not a clarification close (outcome=${String(wait.resolution?.outcome)}) — cancel/supersede/other is not an answer` };
  }
  return { ok: true, answers };
}
