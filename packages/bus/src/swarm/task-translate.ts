/**
 * translateDraft (T3 planner; frozen design 60c9ffa7 + risk errata c790ff1d + loader-interface ruling f06894b8) —
 * PURE, zero-LLM. The "晚上交代" entry: a structured DRAFT (the LLM draftPlan step, T3b) + a versioned, explicit
 * frozenContext -> a legal TaskPlan or an explicit non-dispatchable outcome. No natural-language parsing, no ambient IO
 * (PURE-SNAPSHOT), and — being pure — it NEVER throws on a malformed draft: every bad shape returns `rejected`.
 *
 * Four explicit output classes — the last three NEVER masquerade as dispatchable:
 *   loadable{plan} | rejected{reason} | needsRole{missingRoles} | needsClarification{questions}
 *
 * R4 gate uses the SHARED evaluateR4 (task-r4.ts) so planner and loader cannot drift. Outcome precedence:
 *   - needsClarification: unknown-risk on a requester-declared criticalPath node (c790ff1d ③ — ask first, costly).
 *   - needsRole: a role is required but unresolved (hallucinated, or a single known domain with no catalog role).
 *   - loadable + one auto-prepended design gate if evaluateR4 says designRequired (covering ALL impl nodes — the
 *     conservative whole-job coverage the loader also enforces); the threshold condition (3) is phased (notImplemented).
 *
 * Other frozen clauses (G/C/D/E): checkRegistry is authority (unknown check / bad-typed / undeclared / prose / inherited
 * all reject; Object.hasOwn so constructor/toString never count); freeTextNotes spawns a SEPARATE required review node
 * (Q1/§26); role INFERENCE from catalog fileDomain, never a silent light default (P2-5); effective complexity =
 * max(self, independent re-score); tier = max(complexityTier, kind floor, role floor); loadPlan is the sole legality +
 * digest + coverage authority (and, in managed-t3 mode, re-runs evaluateR4 against the trusted policy snapshot).
 *
 * Scope: T3a = this + the §1b schema extensions + loadPlan R4-coverage/frozenRefs/notImplemented round-trip + shared
 * evaluateR4. T3b owns draftPlan (LLM), the resume bundle, the answer->D'/C' loop, deterministic operationId. A2 (real
 * dispatch + V8 execution of required-review-pass + the real cost-based threshold) is separate — loadable is NOT A2.
 */

import { loadPlan, computeSpecDigest, type TaskPlan, type TaskSpec, type TaskKind, type ModelTier, type OutputKind, type RequiredOutput, type AcceptanceCheck, type FrozenRefs } from "./task-plan.js";
import { evaluateR4, overlapsAny, type OwnerDomainPolicy, type RiskPolicy, type NodeRisk } from "./task-r4.js";

export type { OwnerDomainPolicy, RiskPolicy } from "./task-r4.js";

export type DraftCheck = { check: string; args?: Record<string, unknown> };
export type DraftTask = {
  nodeId: string;
  kind: Exclude<TaskKind, "design">;
  goal: string;
  dependsOn: string[];
  structuredChecks: DraftCheck[];
  freeTextNotes: string[];
  complexity: number;
  independentScore?: number;
  requiredOutputs: RequiredOutput[];
  baseSourceCommit?: string;
  artifactScope: string[];
  sourceWriteScope?: string[];
  roleProfile?: string;
  estimatedRuntimeSec?: number;
  /** Requester-declared (c790ff1d ③): only a critical node makes unknown-risk worth ASKING; else the gate absorbs it.
   *  Default false (门便宜问人贵). vNext may derive it from the DAG; this batch takes the requester's declaration. */
  criticalPath?: boolean;
};
export type Draft = { jobId: string; planRevision?: number; tasks: DraftTask[] };

export type ArgType = "string" | "number" | "boolean" | "object" | "array";
export type CheckArgSchema = { type: ArgType; required?: boolean };
/** Versioned registry: check name -> its args schema (a real per-arg type schema, not just required names, §20). */
export type CheckRegistry = { version: string; checks: Record<string, { args?: Record<string, CheckArgSchema> }> };
export type RoleCatalog = { version: string; roles: Record<string, { floor?: ModelTier; fileDomain?: string[] }> };
export type BudgetPolicy = { version: string; coefficientUsdPerPoint: number; maxModelUsd: number; maxTotalAttempts: number; maxWallClockSec: number };
/** R4 "超阈值" (condition 3). PHASED this batch (notImplemented marker on the plan): the real cost-based threshold lands
 *  with the CPA ledger. This member is the frozenContext seam — pinned in frozenRefs, not yet evaluated. */
export type R4ThresholdPolicy = { version: string; maxTotalComplexity: number };
export type FrozenContext = {
  checkRegistry: CheckRegistry;
  ownerDomainPolicy: OwnerDomainPolicy;
  riskPolicy: RiskPolicy;
  roleCatalog: RoleCatalog;
  budgetPolicy: BudgetPolicy;
  r4ThresholdPolicy: R4ThresholdPolicy;
  sourceBaselineDigest: string;
  planningRequestId?: string;
};

export type ClarificationQuestion = { questionId: string; question: string; context: string };
export type TranslateResult =
  | { outcome: "loadable"; plan: TaskPlan }
  | { outcome: "rejected"; reason: string }
  | { outcome: "needsRole"; missingRoles: string[]; reason: string }
  | { outcome: "needsClarification"; questions: ClarificationQuestion[]; reason: string };

/** V8 interprets this (at A2 time) as "a candidate-version-bound review with verdict ∈ {pass, approved-exception}
 *  exists" (Q1). translateDraft EMITS it (trusted, fixed, versioned); a draft naming it is rejected (not in the
 *  registry) — no same-name bypass. */
export const REQUIRED_REVIEW_CHECK = "required-review-pass";
export const REQUIRED_REVIEW_CHECK_VERSION = "1";
/** Plan annotation for R4 condition 3 (threshold), phased this batch; round-trips through loadPlan. */
export const R4_THRESHOLD_NOT_IMPLEMENTED = "r4-threshold";
const DESIGN_GATE_ID = "design-gate";

const TIER_RANK: Record<ModelTier, number> = { light: 0, standard: 1, heavy: 2 };
const RANK_TIER: readonly ModelTier[] = ["light", "standard", "heavy"];
const complexityTier = (score: number): ModelTier => (score <= 3 ? "light" : score <= 7 ? "standard" : "heavy");
const kindFloor = (kind: TaskKind): ModelTier => (kind === "design" || kind === "review" ? "heavy" : "light");
const maxTier = (...ts: ModelTier[]): ModelTier => RANK_TIER[Math.max(...ts.map((t) => TIER_RANK[t]))]!;

/** Direction-setting planner operations are always heavy (PLANNER-HEAVY): a low-tier caller cannot drive a draft/
 *  expand/plan-revision. T3b calls this to route its own LLM step. */
export function plannerOperationTier(): ModelTier {
  return "heavy";
}

const DRAFT_KINDS: ReadonlySet<string> = new Set(["work", "integration", "synthesis", "review", "repair"]);
const OUTPUT_KINDS: ReadonlySet<string> = new Set(["patch", "files", "report", "notes"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isIntInRange = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const R = (reason: string): TranslateResult => ({ outcome: "rejected", reason });

function argMatchesType(v: unknown, type: ArgType): boolean {
  switch (type) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "object": return isObj(v);
    case "array": return Array.isArray(v);
  }
}

/** Validate one drafted check against the registry schema. Object.hasOwn everywhere so inherited props
 *  (constructor/toString as a check name; `constructor` as a required arg) never resolve. */
function checkFromRegistry(c: unknown, registry: CheckRegistry, where: string): { reason: string } | { check: AcceptanceCheck } {
  if (!isObj(c) || !isNonEmptyStr(c.check)) return { reason: `${where}: a structuredCheck must be {check:string} (prose belongs in freeTextNotes)` };
  if (!has(registry.checks, c.check)) return { reason: `${where}: unknown check "${c.check}" (registry ${registry.version}) — not supported` };
  const schema = registry.checks[c.check]!.args ?? {};
  if (c.args !== undefined && !isObj(c.args)) return { reason: `${where}: check "${c.check}" args must be an object` };
  const provided = (c.args ?? {}) as Record<string, unknown>;
  for (const [name, spec] of Object.entries(schema)) {
    const present = has(provided, name); // own-key, not `in` (ARGS-INHERITED-REQUIRED)
    if (spec.required && !present) return { reason: `${where}: check "${c.check}" missing required arg "${name}"` };
    if (present && !argMatchesType(provided[name], spec.type)) return { reason: `${where}: check "${c.check}" arg "${name}" must be ${spec.type}` };
  }
  for (const name of Object.keys(provided)) if (!has(schema, name)) return { reason: `${where}: check "${c.check}" has undeclared arg "${name}"` };
  return { check: { check: c.check, ...(c.args !== undefined ? { args: c.args as Record<string, unknown> } : {}) } };
}

/** Validate the output contract shape BEFORE constructing (never throw on a malformed draft). */
function outputContractOf(t: Record<string, unknown>, at: string): { reason: string } | { outputContract: TaskSpec["outputContract"] } {
  if (!Array.isArray(t.requiredOutputs)) return { reason: `${at}: requiredOutputs must be an array` };
  const outs: RequiredOutput[] = [];
  for (let i = 0; i < t.requiredOutputs.length; i++) {
    const o = t.requiredOutputs[i];
    if (!isObj(o) || !isNonEmptyStr(o.logicalName)) return { reason: `${at}.requiredOutputs[${i}].logicalName` };
    if (!isStr(o.kind) || !OUTPUT_KINDS.has(o.kind)) return { reason: `${at}.requiredOutputs[${i}].kind` };
    if (o.pathHint !== undefined && !isStr(o.pathHint)) return { reason: `${at}.requiredOutputs[${i}].pathHint` };
    outs.push({ logicalName: o.logicalName, kind: o.kind as OutputKind, ...(o.pathHint !== undefined ? { pathHint: o.pathHint as string } : {}) });
  }
  if (t.baseSourceCommit !== undefined && !isStr(t.baseSourceCommit)) return { reason: `${at}.baseSourceCommit` };
  return { outputContract: { requiredOutputs: outs, ...(t.baseSourceCommit !== undefined ? { baseSourceCommit: t.baseSourceCommit as string } : {}) } };
}

/** opts.resolvedRisk: a TRUSTED per-node risk map (nodeId -> reversible|irreversible) supplied ONLY by the recompile after
 *  a requester clarification (design §3 "节点显式标记"). A raw draftPlan call omits it — the LLM draft cannot self-declare
 *  risk. It is stamped onto nodes AND passed as evidence to the self-check loadPlan so the gate decision stays consistent. */
export type TranslateOpts = { resolvedRisk?: Record<string, { risk: NodeRisk; answeredPaths: string[] }> };

export function translateDraft(draft: Draft, fc: FrozenContext, opts: TranslateOpts = {}): TranslateResult {
  if (!isObj(draft) || !isNonEmptyStr(draft.jobId)) return R("draft.jobId must be a non-empty string");
  if (!Array.isArray(draft.tasks) || draft.tasks.length === 0) return R("draft.tasks must be a non-empty array");
  if (draft.planRevision !== undefined && !(typeof draft.planRevision === "number" && Number.isInteger(draft.planRevision) && draft.planRevision >= 0)) return R("draft.planRevision must be a non-negative integer"); // null is not silently ?? 1'd

  const bp = fc.budgetPolicy;
  if (!(typeof bp.coefficientUsdPerPoint === "number" && Number.isFinite(bp.coefficientUsdPerPoint) && bp.coefficientUsdPerPoint > 0)) return R(`budget coefficient must be a finite positive number (policy ${bp.version})`);
  if (!(typeof bp.maxModelUsd === "number" && Number.isFinite(bp.maxModelUsd) && bp.maxModelUsd > 0)) return R(`budget maxModelUsd cap must be a finite positive number (policy ${bp.version})`);

  const missingRoles: string[] = []; // hallucinated explicit roles -> always needsRole
  const unresolvedInferredRoleNodes: string[] = []; // ambiguous/no-role inference -> ALWAYS needsRole (a design gate does not backfill a role; reviewer 3b)
  const nodes: TaskSpec[] = [];
  const criticalNodeIds = new Set<string>();
  let complexitySum = 0;

  for (let i = 0; i < draft.tasks.length; i++) {
    const t = draft.tasks[i] as unknown as Record<string, unknown>;
    const at = `task[${i}] ${isObj(t) && isStr(t.nodeId) ? t.nodeId : "?"}`;
    if (!isObj(t) || !isNonEmptyStr(t.nodeId)) return R(`${at}: nodeId must be a non-empty string`);
    if (!isStr(t.kind) || !DRAFT_KINDS.has(t.kind)) return R(`${at}: kind must be work|integration|synthesis|review|repair ("design" gates are auto-prepended)`);
    const kind = t.kind as Exclude<TaskKind, "design">;
    if (!isStr(t.goal)) return R(`${at}: goal must be a string`);
    if (!isStrArr(t.dependsOn)) return R(`${at}: dependsOn must be a string[]`);
    if (!Array.isArray(t.structuredChecks) || !Array.isArray(t.freeTextNotes)) return R(`${at}: structuredChecks and freeTextNotes must both be arrays`);
    if (!isIntInRange(t.complexity, 1, 10)) return R(`${at}: complexity must be an integer 1-10`);
    if (t.independentScore !== undefined && !isIntInRange(t.independentScore, 1, 10)) return R(`${at}: independentScore must be an integer 1-10`);
    if (!isStrArr(t.artifactScope)) return R(`${at}: artifactScope must be a string[]`);
    if (t.sourceWriteScope !== undefined && !isStrArr(t.sourceWriteScope)) return R(`${at}: sourceWriteScope must be a string[]`);
    if (t.estimatedRuntimeSec !== undefined && !(typeof t.estimatedRuntimeSec === "number" && Number.isFinite(t.estimatedRuntimeSec) && t.estimatedRuntimeSec >= 0)) return R(`${at}: estimatedRuntimeSec must be a finite number >= 0`);
    if (t.criticalPath !== undefined && typeof t.criticalPath !== "boolean") return R(`${at}: criticalPath must be a boolean`);
    if (t.roleProfile !== undefined && !isNonEmptyStr(t.roleProfile)) return R(`${at}: roleProfile must be a non-empty string`);

    const oc = outputContractOf(t, at);
    if ("reason" in oc) return R(oc.reason);

    if (t.structuredChecks.length === 0 && t.freeTextNotes.length === 0) return R(`${at}: empty acceptance (no structuredChecks and no freeTextNotes)`);
    const acceptance: AcceptanceCheck[] = [];
    for (let j = 0; j < t.structuredChecks.length; j++) {
      const r = checkFromRegistry(t.structuredChecks[j], fc.checkRegistry, `${at}.structuredChecks[${j}]`);
      if ("reason" in r) return R(r.reason);
      acceptance.push(r.check);
    }
    if (t.freeTextNotes.length > 0 && !t.freeTextNotes.every(isNonEmptyStr)) return R(`${at}: freeTextNotes entries must be non-empty strings`);

    // role (P2-5): explicit -> validate against catalog; absent -> INFER from sourceWriteScope via catalog fileDomain.
    // A default role must never become silent unconstrained-light. Object.hasOwn so constructor/toString aren't "known".
    const scope = (t.sourceWriteScope as string[] | undefined) ?? [];
    let resolvedRole: string | undefined;
    let roleFloor: ModelTier = "light";
    if (t.roleProfile !== undefined) {
      if (!has(fc.roleCatalog.roles, t.roleProfile)) missingRoles.push(`${t.roleProfile} (hallucinated, node ${t.nodeId})`);
      else { resolvedRole = t.roleProfile; roleFloor = fc.roleCatalog.roles[t.roleProfile]!.floor ?? "light"; }
    } else {
      // INFER: a role owns a path if the path is UNDER its fileDomain; the LONGEST fileDomain wins. EVERY non-empty-scope
      // path must uniquely match, and all to the SAME role (R5-P2-1: a matched path must not mask an unmatched one).
      // Any unmatched/tie path, paths disagreeing on the role, or a broad span -> needsRole (deterministic, no pick-first).
      const roleIds = Object.keys(fc.roleCatalog.roles);
      const roleForPath = (p: string): string | undefined => { // longest-fileDomain owning role; undefined if no match OR equal-length tie
        let bestLen = -1;
        const atBest = new Set<string>();
        for (const rid of roleIds) for (const fd of fc.roleCatalog.roles[rid]!.fileDomain ?? []) {
          if (p === fd || p.startsWith(fd)) {
            if (fd.length > bestLen) { bestLen = fd.length; atBest.clear(); atBest.add(rid); }
            else if (fd.length === bestLen) atBest.add(rid);
          }
        }
        return atBest.size === 1 ? [...atBest][0] : undefined;
      };
      const spansIntoRole = (p: string): boolean => roleIds.some((rid) => (fc.roleCatalog.roles[rid]!.fileDomain ?? []).some((fd) => fd.startsWith(p) && fd !== p));
      let inferredRole: string | undefined;
      let unresolved = false;
      for (const p of scope) {
        const rid = roleForPath(p);
        if (rid === undefined) unresolved = true; // no match OR equal-length tie on this path
        else if (inferredRole === undefined) inferredRole = rid;
        else if (inferredRole !== rid) unresolved = true; // paths disagree on the role
        if (spansIntoRole(p)) unresolved = true;
      }
      if (!unresolved && inferredRole !== undefined) { resolvedRole = inferredRole; roleFloor = fc.roleCatalog.roles[inferredRole]!.floor ?? "light"; }
      else if (scope.length > 0) unresolvedInferredRoleNodes.push(t.nodeId); // non-empty scope without one unanimous role -> needsRole; empty scope needs no role
    }

    const effectiveComplexity = Math.max(t.complexity, (t.independentScore as number | undefined) ?? t.complexity); // SCORE-DISAGREES
    complexitySum += effectiveComplexity;
    const modelTier = maxTier(complexityTier(effectiveComplexity), kindFloor(kind), roleFloor); // TIER-FLOOR
    if (t.criticalPath === true) criticalNodeIds.add(t.nodeId);

    const sourceWriteScope = t.sourceWriteScope as string[] | undefined;
    nodes.push({
      nodeId: t.nodeId,
      kind,
      goal: t.goal,
      dependsOn: [...(t.dependsOn as string[])],
      outputContract: oc.outputContract,
      acceptance,
      artifactScope: [...(t.artifactScope as string[])],
      ...(sourceWriteScope !== undefined ? { sourceWriteScope: [...sourceWriteScope] } : {}),
      estimatedRuntimeSec: (t.estimatedRuntimeSec as number | undefined) ?? 600,
      retryBudget: 2,
      required: true,
      runtime: "ephemeral",
      modelTier,
      ...(resolvedRole !== undefined ? { roleProfile: resolvedRole } : {}),
      ...(t.criticalPath === true ? { criticalPath: true } : {}),
      ...(opts.resolvedRisk?.[t.nodeId] !== undefined ? { resolvedRisk: opts.resolvedRisk[t.nodeId]!.risk } : {}),
      specDigest: "",
    });

    if (t.freeTextNotes.length > 0) {
      complexitySum += effectiveComplexity; // review scales with the work
      nodes.push({
        nodeId: `${t.nodeId}::review`,
        kind: "review",
        goal: `Independent review of ${t.nodeId} (prose obligations): ${(t.freeTextNotes as string[]).join("; ")}`,
        dependsOn: [t.nodeId as string],
        outputContract: { requiredOutputs: [{ logicalName: "review-verdict", kind: "notes" }] },
        acceptance: [{ check: REQUIRED_REVIEW_CHECK, args: { version: REQUIRED_REVIEW_CHECK_VERSION, boundTo: t.nodeId, notes: [...(t.freeTextNotes as string[])] } }],
        artifactScope: [],
        estimatedRuntimeSec: 600,
        retryBudget: 2,
        required: true,
        runtime: "ephemeral",
        modelTier: "heavy",
        specDigest: "",
      });
    }
  }

  // R4 via the SHARED evaluator (same rule the loader enforces). criticalPath layered on top for the clarify branch.
  const assess = evaluateR4(nodes, fc.ownerDomainPolicy, fc.riskPolicy);
  const criticalUnknown = assess.unknownRiskNodeIds.filter((id) => criticalNodeIds.has(id));
  if (criticalUnknown.length > 0) {
    const questions: ClarificationQuestion[] = [];
    for (const id of criticalUnknown) {
      const node = nodes.find((n) => n.nodeId === id);
      for (const p of node?.sourceWriteScope ?? []) if (overlapsAny(p, fc.riskPolicy.undecidablePrefixes)) questions.push({ questionId: `q-risk-${id}-${questions.length}`, question: `Is writing "${p}" reversible, and who owns it?`, context: `node ${id}: path ${p} matched riskPolicy.undecidablePrefixes (risk ${fc.riskPolicy.version}) and the node is criticalPath` });
    }
    return { outcome: "needsClarification", reason: "unknown risk on a requester-critical node — reversibility must be answered before planning", questions };
  }
  // Role blockers: ALWAYS needsRole for any unresolved role (hallucinated explicit, or ambiguous/no-role inference). A
  // design gate reviews the approach; its verdict does NOT backfill M's roleProfile/floor, and T3a has no role-resolution
  // /continuation step — so an impl node with no resolved role is never executable, gate or not (reviewer 3b).
  const roleBlockers = [...missingRoles, ...unresolvedInferredRoleNodes.map((id) => `no unique role for node ${id}`)];
  if (roleBlockers.length > 0) return { outcome: "needsRole", missingRoles: [...new Set(roleBlockers)], reason: `unresolved role(s) (catalog ${fc.roleCatalog.version}): ${[...new Set(roleBlockers)].join("; ")}` };

  let allNodes = nodes;
  if (assess.designRequired) {
    if (nodes.some((n) => n.nodeId === DESIGN_GATE_ID)) return R(`cannot auto-prepend design gate: nodeId "${DESIGN_GATE_ID}" already used`);
    const impl = nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn, DESIGN_GATE_ID] }));
    try { for (const n of impl) n.specDigest = computeSpecDigest(n); } catch { return R("non-finite or unserializable value in a node (e.g. nested acceptance args)"); }
    const coveredSpecDigests = impl.map((n) => n.specDigest).sort(); // COVERAGE-FINAL: every impl node's final digest
    allNodes = [{
      nodeId: DESIGN_GATE_ID,
      kind: "design",
      goal: `R4 adversarial design review (auto-prepended): ${assess.reasons.join("; ")}`,
      dependsOn: [],
      outputContract: { requiredOutputs: [{ logicalName: "design-verdict", kind: "notes" }] },
      acceptance: [{ check: REQUIRED_REVIEW_CHECK, args: { version: REQUIRED_REVIEW_CHECK_VERSION, gate: "R4", reasons: assess.reasons } }],
      artifactScope: [],
      estimatedRuntimeSec: 600,
      retryBudget: 2,
      required: true,
      runtime: "ephemeral",
      modelTier: "heavy",
      coveredSpecDigests,
      specDigest: "",
    }, ...impl];
  }

  const estModelUsd = complexitySum * bp.coefficientUsdPerPoint;
  if (!Number.isFinite(estModelUsd)) return R("budget estimate is not finite (arithmetic overflow)");
  if (estModelUsd > bp.maxModelUsd) return R(`budget estimate ${estModelUsd} exceeds policy cap ${bp.maxModelUsd} (policy ${bp.version})`);

  const frozenRefs: FrozenRefs = {
    checkRegistry: fc.checkRegistry.version,
    ownerDomainPolicy: fc.ownerDomainPolicy.version,
    riskPolicy: fc.riskPolicy.version,
    roleCatalog: fc.roleCatalog.version,
    budgetPolicy: fc.budgetPolicy.version,
    r4ThresholdPolicy: fc.r4ThresholdPolicy.version,
    sourceBaselineDigest: fc.sourceBaselineDigest,
    ...(fc.planningRequestId !== undefined ? { planningRequestId: fc.planningRequestId } : {}),
  };

  const assembled = {
    jobId: draft.jobId,
    planRevision: draft.planRevision ?? 1,
    nodes: allNodes.map((n) => ({ ...n, specDigest: "" })),
    jobBudget: { maxTotalAttempts: bp.maxTotalAttempts, maxWallClockSec: bp.maxWallClockSec, maxModelUsd: estModelUsd },
    frozenRefs,
    notImplemented: [R4_THRESHOLD_NOT_IMPLEMENTED], // R4 condition 3 phased; round-trips through loadPlan
    planDigest: "",
  };
  // Self-check via the SAME managed-t3 enforcement the consumer applies: translateDraft's output is guaranteed to pass
  // the loader's R4 re-evaluation (a translateDraft bug that failed to insert a required gate surfaces here as rejected,
  // not as a plan the dispatcher later rejects). loadPlan is the sole legality + digest + coverage authority.
  // Spec-bound evidence for the self-check: each stamped node's resolvedRisk + its computed specDigest (the same identity
  // loadPlan will compute), so the loader honors exactly the nodes we legitimately resolved — matching a consumer's reload.
  const selfEvidence: Record<string, { risk: NodeRisk; specDigest: string; answeredPaths: string[] }> = {};
  if (opts.resolvedRisk !== undefined) for (const n of assembled.nodes) if (n.resolvedRisk !== undefined) selfEvidence[n.nodeId] = { risk: n.resolvedRisk, specDigest: computeSpecDigest(n), answeredPaths: opts.resolvedRisk[n.nodeId]?.answeredPaths ?? [] };
  const loaded = loadPlan(assembled, { mode: "managed-t3", ownerDomainPolicy: fc.ownerDomainPolicy, riskPolicy: fc.riskPolicy, expectedFrozenRefs: frozenRefs, ...(Object.keys(selfEvidence).length > 0 ? { resolvedRisk: selfEvidence } : {}) });
  if (!loaded.ok) return R(`assembled plan failed managed loadPlan: ${loaded.reason}`);
  return { outcome: "loadable", plan: loaded.plan };
}
