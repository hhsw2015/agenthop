/**
 * T3b recompile ORCHESTRATION (design 1d0a1ffc §1 line 21 "bundle 存储+重编译编排落 T3b"; coordinator points 2+3) — the
 * single entry the reviewer correctly flagged as missing: it ties the IO pieces (plan-bundle) to the pure recompile
 * (plan-recompile) so a needsClarification can be durably snapshotted and later resumed from just a payloadRef + answers.
 *
 *   storeResumeState(draft, prd, fc) -> { payloadRef }:  persist the exact policy (storeFrozenContext) + the immutable
 *     bundle, so the needsClarification wait's payloadRef points at everything a resume needs.
 *   resumeClarification(payloadRef, answers) -> recompile result (+ projectedFcDigest on loadable):
 *     loadBundle (integrity) -> loadFrozenContext by digest (the EXACT original policy) -> verify its version refs match the
 *     bundle (policy drift/swap guard) -> recompilePlan -> on loadable, persist the projected C' as a new durable version.
 *
 * This is NOT A2: it produces a loadable plan + a minted operationId; real dispatch / V8 execution stay separate.
 */

import { loadBundle, loadFrozenContext, storeBundle, storeFrozenContext, prdDigestOf, frozenRefsOf, type ResumeBundle } from "./plan-bundle.js";
import { recompilePlan, type ClarificationAnswer, type RecompileResult } from "./plan-recompile.js";
import { digestOf } from "./digest.js";
import type { Draft, FrozenContext } from "./task-translate.js";

export type ResumeDirs = { bundleDir?: string; policyDir?: string };

export type StoreResumeInput = { draft: Draft; prd: string; fc: FrozenContext };
/** Persist the resumable snapshot for a needsClarification. Requires planningRequestId (the request-round identity that
 *  operationId minting is pinned to). Returns the payloadRef to store on the query-wait. */
export function storeResumeState(i: StoreResumeInput, dirs: ResumeDirs = {}): { payloadRef: string; frozenContextDigest: string } {
  if (!i.fc.planningRequestId) throw new Error("storeResumeState: frozenContext.planningRequestId is required (request-round identity)");
  const frozenContextDigest = storeFrozenContext(i.fc, dirs.policyDir);
  const bundle: ResumeBundle = {
    draft: i.draft,
    prdDigest: prdDigestOf(i.prd),
    frozenRefs: frozenRefsOf(i.fc),
    frozenContextDigest,
    planningRequestId: i.fc.planningRequestId,
  };
  const payloadRef = storeBundle(bundle, dirs.bundleDir);
  return { payloadRef, frozenContextDigest };
}

export type ResumeInput = { payloadRef: string; answers: ClarificationAnswer[]; actionKind?: string };
export type ResumeResult =
  | (Extract<RecompileResult, { outcome: "loadable" }> & { projectedFcDigest: string })
  | Exclude<RecompileResult, { outcome: "loadable" }>;

export function resumeClarification(i: ResumeInput, dirs: ResumeDirs = {}): ResumeResult {
  const bundle = loadBundle(i.payloadRef, dirs.bundleDir); // integrity-checked (digest == payloadRef)
  const fc = loadFrozenContext(bundle.frozenContextDigest, dirs.policyDir); // the EXACT original policy content (integrity-checked)
  // Drift/swap guard: the resolved policy's version refs must match what the bundle (and thus the plan) recorded. Closes
  // the "feed B's policy to A's resume" collision at the orchestration layer, on top of the content-addressed C' version.
  if (digestOf(frozenRefsOf(fc)) !== digestOf(bundle.frozenRefs)) {
    return { outcome: "rejected", reason: "resolved frozenContext version refs do not match the bundle (policy drift/swap)" };
  }
  const withId: FrozenContext = { ...fc, planningRequestId: bundle.planningRequestId };
  const res = recompilePlan({ draft: bundle.draft, fc: withId, answers: i.answers, snapshotDigest: i.payloadRef, ...(i.actionKind !== undefined ? { actionKind: i.actionKind } : {}) });
  if (res.outcome !== "loadable") return res;
  const projectedFcDigest = storeFrozenContext(res.projectedFc, dirs.policyDir); // persist C' as a new durable version
  return { ...res, projectedFcDigest };
}
