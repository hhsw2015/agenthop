/**
 * translateDraft (T3 planner, frozen design 60c9ffa7 §1) — PURE, zero-LLM. The "晚上交代" entry: it turns a structured
 * DRAFT (the output of the LLM draftPlan step, T3b) plus a versioned, explicit frozenContext into a legal TaskPlan —
 * or into an explicit non-dispatchable outcome. It does NO natural-language parsing and NO ambient IO: every input it
 * trusts is passed in (PURE-SNAPSHOT), so the same (draft, frozenContext) always yields the same result (DIGEST-EXACT).
 *
 * Four explicit output classes — the last three NEVER masquerade as dispatchable (§1 :23):
 *   loadable{plan} | rejected{reason} | needsRole{missingRoles} | needsClarification{questions}
 *
 * The clauses the reviewer's counterexamples pin (each a G/C/D/E fixture):
 *  - checkRegistry authority (P1-1 / AC-UNKNOWN, AC-REGISTRY-DOWNGRADE): a structuredCheck is accepted only if its name
 *    is in the versioned registry and its required args are present — unknown check / malformed args ⇒ reject, never
 *    silently drop or downgrade. A non-{check} element (prose smuggled into structured) ⇒ reject (AC-PROSE).
 *  - obligation never evaporates (P1-1 / AC-OBLIGATION-DROP): a non-empty freeTextNotes spawns a SEPARATE required
 *    review node (kind=review) whose acceptance is the candidate-version-bound `required-review-pass` gate (V8 at A2
 *    time, Q1; design §26). The work node keeps its structured checks; the prose obligation becomes its own reviewer
 *    task, never dropped and never folded as prose. Empty structuredChecks AND empty notes ⇒ reject (C).
 *  - R4 from TRUSTED inputs only (P1-2 / R4-OWNER-SPOOF, R4-FROZEN, R4-UNKNOWN): the four-condition gate reads the
 *    frozenContext owner/frozen/irreversible policy, NEVER the model's own covers/risk labels. ≥2 trusted domains, a
 *    frozen-scope write, or an irreversible path ⇒ auto-prepend one design gate (coveredSpecDigests = the covered impl
 *    nodes' FINAL digests). Unknown ownership never silently counts as one owner: unknown + non-irreversible ⇒ design
 *    (conservative); unknown + irreversible/critical ⇒ needsClarification (undecidable, must ask).
 *  - tier floors (P2-2 / TIER-FLOOR, SCORE-DISAGREES, PLANNER-HEAVY): effective complexity = max(self, independent
 *    re-score if run) [宁贵勿返]; effective tier = max(complexityTier, kind floor, role floor). design/review floor=heavy.
 *  - identity (P2-3 / D): specDigest is loadPlan's authority; modelTier/roleProfile are excluded (role annotations),
 *    coveredSpecDigests is included (design identity). loadPlan recomputes everything — it is the sole legality entry.
 *
 * Scope: T3a = this pure function + the §1b schema extensions. T3b owns draftPlan (the LLM step), the needsClarification
 * resume bundle storage, the answer→D'/C' re-compile loop, and the deterministic operationId minting. A2 (real dispatch
 * + V8 execution of required-review-pass) is a separate downstream gate — a loadable plan is NOT an A2 claim.
 */

import { loadPlan, computeSpecDigest, type TaskPlan, type TaskSpec, type TaskKind, type ModelTier, type RequiredOutput, type AcceptanceCheck } from "./task-plan.js";

/** A draft check, pre-split upstream as mechanizable (F-T3-3). `check` must be a registry name. */
export type DraftCheck = { check: string; args?: Record<string, unknown> };

/** One drafted task. kind excludes "design" — a design gate is auto-prepended by R4, never drafted. */
export type DraftTask = {
  nodeId: string;
  kind: Exclude<TaskKind, "design">;
  goal: string;
  dependsOn: string[];
  /** Acceptance pre-split upstream: mechanizable checks vs prose obligations (F-T3-3). */
  structuredChecks: DraftCheck[];
  freeTextNotes: string[];
  /** Self-assessed complexity 1-10; independentScore present only if a second eval ran (E / SCORE-DISAGREES). */
  complexity: number;
  independentScore?: number;
  requiredOutputs: RequiredOutput[];
  baseSourceCommit?: string;
  artifactScope: string[];
  sourceWriteScope?: string[];
  /** Suggested role; validated against the catalog (hallucinated role ⇒ needsRole, never silent default). */
  roleProfile?: string;
  estimatedRuntimeSec?: number;
};

export type Draft = { jobId: string; planRevision?: number; tasks: DraftTask[] };

/** Versioned registry of supported acceptance checks: name -> required arg names. Unknown name ⇒ reject. */
export type CheckRegistry = { version: string; checks: Record<string, { requiredArgs?: string[] }> };
/** Trusted owner/risk policy (NOT model-produced). Longest-prefix match assigns a logical owner domain. */
export type OwnerDomainPolicy = {
  version: string;
  ownerByPrefix: Array<{ prefix: string; domain: string }>;
  /** Writing under any of these = a frozen-contract change ⇒ force a design gate (R4-FROZEN). */
  frozenScopePrefixes: string[];
  /** Writing under any of these = irreversible/critical ⇒ force design, or needsClarification if ownership unknown. */
  irreversiblePrefixes: string[];
};
export type RoleCatalog = { version: string; roles: Record<string, { floor?: ModelTier }> };
export type BudgetPolicy = {
  version: string;
  coefficientUsdPerPoint: number;
  maxModelUsd: number;
  maxTotalAttempts: number;
  maxWallClockSec: number;
};
/** All inputs explicit and versioned; none from the model (PURE-SNAPSHOT / P2-1 / Q2a). planningRequestId threads
 *  through so T3b can derive a deterministic, request-scoped operationId — this pure function does not mint one. */
export type FrozenContext = {
  checkRegistry: CheckRegistry;
  ownerDomainPolicy: OwnerDomainPolicy;
  roleCatalog: RoleCatalog;
  budgetPolicy: BudgetPolicy;
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
 *  exists" (Q1). translateDraft emits it for a prose obligation; it is trusted, not subject to registry membership. */
export const REQUIRED_REVIEW_CHECK = "required-review-pass";
const DESIGN_GATE_ID = "design-gate";

const TIER_RANK: Record<ModelTier, number> = { light: 0, standard: 1, heavy: 2 };
const RANK_TIER: readonly ModelTier[] = ["light", "standard", "heavy"];
const complexityTier = (score: number): ModelTier => (score <= 3 ? "light" : score <= 7 ? "standard" : "heavy");
const kindFloor = (kind: TaskKind): ModelTier => (kind === "design" || kind === "review" ? "heavy" : "light");
const maxTier = (...ts: ModelTier[]): ModelTier => RANK_TIER[Math.max(...ts.map((t) => TIER_RANK[t]))]!;

/** Direction-setting planner operations are always heavy (PLANNER-HEAVY): a low-tier caller cannot drive a draft/
 *  expand/plan-revision. T3b calls this to route its own LLM step; exposed here so the floor lives with the policy. */
export function plannerOperationTier(): ModelTier {
  return "heavy";
}

const underAny = (path: string, prefixes: string[]): boolean => prefixes.some((p) => path === p || path.startsWith(p));
function resolveDomain(path: string, policy: OwnerDomainPolicy): string | null {
  let best: { prefix: string; domain: string } | null = null;
  for (const e of policy.ownerByPrefix) {
    if ((path === e.prefix || path.startsWith(e.prefix)) && (best === null || e.prefix.length > best.prefix.length)) best = e;
  }
  return best?.domain ?? null;
}

// A draft arrives from the LLM step (T3b) — untrusted, so every field is runtime-checked even where the type narrows it.
const DRAFT_KINDS: ReadonlySet<string> = new Set(["work", "integration", "synthesis", "review", "repair"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isIntInRange = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

const R = (reason: string): TranslateResult => ({ outcome: "rejected", reason });

/** Validate one drafted check against the registry; returns a legal AcceptanceCheck or a reason. */
function checkFromRegistry(c: unknown, registry: CheckRegistry, where: string): { reason: string } | { check: AcceptanceCheck } {
  if (!isObj(c) || !isNonEmptyStr(c.check)) return { reason: `${where}: a structuredCheck must be {check:string} (prose belongs in freeTextNotes)` }; // AC-PROSE
  const spec = registry.checks[c.check];
  if (spec === undefined) return { reason: `${where}: unknown check "${c.check}" (registry ${registry.version}) — not supported, refused` }; // AC-UNKNOWN / AC-REGISTRY-DOWNGRADE
  if (c.args !== undefined && !isObj(c.args)) return { reason: `${where}: check "${c.check}" args must be an object` };
  for (const req of spec.requiredArgs ?? []) {
    if (!isObj(c.args) || !(req in c.args)) return { reason: `${where}: check "${c.check}" missing required arg "${req}"` };
  }
  return { check: { check: c.check, ...(c.args !== undefined ? { args: c.args as Record<string, unknown> } : {}) } };
}

export function translateDraft(draft: Draft, fc: FrozenContext): TranslateResult {
  // --- draft shape (C) ---
  if (!isObj(draft) || !isNonEmptyStr(draft.jobId)) return R("draft.jobId must be a non-empty string");
  if (!Array.isArray(draft.tasks) || draft.tasks.length === 0) return R("draft.tasks must be a non-empty array");

  // --- budget policy sanity (BUDGET-INVALID) ---
  const bp = fc.budgetPolicy;
  if (!(typeof bp.coefficientUsdPerPoint === "number" && Number.isFinite(bp.coefficientUsdPerPoint) && bp.coefficientUsdPerPoint > 0)) return R(`budget coefficient must be a finite positive number (policy ${bp.version})`);
  if (!(typeof bp.maxModelUsd === "number" && Number.isFinite(bp.maxModelUsd) && bp.maxModelUsd > 0)) return R(`budget maxModelUsd cap must be a finite positive number (policy ${bp.version})`);

  // --- per-task validation + node construction (pre-digest; design dep added later) ---
  const missingRoles: string[] = [];
  const nodes: TaskSpec[] = [];
  let complexitySum = 0;

  for (let i = 0; i < draft.tasks.length; i++) {
    const t = draft.tasks[i]!;
    const at = `task[${i}] ${isObj(t) && isStr((t as DraftTask).nodeId) ? (t as DraftTask).nodeId : "?"}`;
    if (!isObj(t) || !isNonEmptyStr(t.nodeId)) return R(`${at}: nodeId must be a non-empty string`);
    const kindRaw: unknown = (t as Record<string, unknown>).kind;
    if (!isStr(kindRaw) || !DRAFT_KINDS.has(kindRaw)) return R(`${at}: kind must be work|integration|synthesis|review|repair ("design" gates are auto-prepended, never drafted)`);
    if (!isStr(t.goal)) return R(`${at}: goal must be a string`);
    if (!Array.isArray(t.dependsOn) || !t.dependsOn.every(isStr)) return R(`${at}: dependsOn must be a string[]`);
    if (!Array.isArray(t.structuredChecks) || !Array.isArray(t.freeTextNotes)) return R(`${at}: structuredChecks and freeTextNotes must both be arrays`);
    if (!isIntInRange(t.complexity, 1, 10)) return R(`${at}: complexity must be an integer 1-10`); // BUDGET-INVALID (out-of-range)
    if (t.independentScore !== undefined && !isIntInRange(t.independentScore, 1, 10)) return R(`${at}: independentScore must be an integer 1-10`);

    // acceptance split (F-T3-3): structured checks go on the work node (registry-validated); a non-empty freeTextNotes
    // spawns a SEPARATE required review node (design §26 "freeTextNotes→review 节点") — never silently dropped, never
    // folded as prose. Both empty ⇒ reject (C).
    if (t.structuredChecks.length === 0 && t.freeTextNotes.length === 0) return R(`${at}: empty acceptance (no structuredChecks and no freeTextNotes)`);
    const acceptance: AcceptanceCheck[] = [];
    for (let j = 0; j < t.structuredChecks.length; j++) {
      const r = checkFromRegistry(t.structuredChecks[j], fc.checkRegistry, `${at}.structuredChecks[${j}]`);
      if ("reason" in r) return R(r.reason);
      acceptance.push(r.check);
    }
    if (t.freeTextNotes.length > 0 && !t.freeTextNotes.every(isNonEmptyStr)) return R(`${at}: freeTextNotes entries must be non-empty strings`);

    // role: present-but-unknown -> needsRole (ROLE-UNKNOWN); absent -> no role constraint
    let roleFloor: ModelTier = "light";
    if (t.roleProfile !== undefined) {
      const role = fc.roleCatalog.roles[t.roleProfile];
      if (role === undefined) { missingRoles.push(t.roleProfile); } else if (role.floor) { roleFloor = role.floor; }
    }

    // tier: effective complexity = max(self, independent re-score if run); tier = max(complexity, kind floor, role floor)
    const effectiveComplexity = Math.max(t.complexity, t.independentScore ?? t.complexity); // SCORE-DISAGREES (存疑向上)
    complexitySum += effectiveComplexity;
    const modelTier = maxTier(complexityTier(effectiveComplexity), kindFloor(t.kind), roleFloor); // TIER-FLOOR

    nodes.push({
      nodeId: t.nodeId,
      kind: t.kind,
      goal: t.goal,
      dependsOn: [...t.dependsOn],
      outputContract: {
        requiredOutputs: t.requiredOutputs.map((o) => ({ logicalName: o.logicalName, kind: o.kind, ...(o.pathHint !== undefined ? { pathHint: o.pathHint } : {}) })),
        ...(t.baseSourceCommit !== undefined ? { baseSourceCommit: t.baseSourceCommit } : {}),
      },
      acceptance, // structured checks only (may be empty if the node's obligations are all prose → its review node)
      artifactScope: [...t.artifactScope],
      ...(t.sourceWriteScope !== undefined ? { sourceWriteScope: [...t.sourceWriteScope] } : {}),
      estimatedRuntimeSec: t.estimatedRuntimeSec ?? 600,
      retryBudget: 2,
      required: true,
      runtime: "ephemeral",
      modelTier,
      ...(t.roleProfile !== undefined ? { roleProfile: t.roleProfile } : {}),
      specDigest: "",
    });

    if (t.freeTextNotes.length > 0) {
      // a required review node (kind=review, heavy) gates the prose obligation: its acceptance is the candidate-version-
      // bound review-pass gate (V8 at A2 time, Q1). Reviewing scales with the work, so it adds to the budget estimate.
      complexitySum += effectiveComplexity;
      nodes.push({
        nodeId: `${t.nodeId}::review`,
        kind: "review",
        goal: `Independent review of ${t.nodeId} (prose obligations): ${t.freeTextNotes.join("; ")}`,
        dependsOn: [t.nodeId],
        outputContract: { requiredOutputs: [{ logicalName: "review-verdict", kind: "notes" }] },
        acceptance: [{ check: REQUIRED_REVIEW_CHECK, args: { boundTo: t.nodeId, notes: [...t.freeTextNotes] } }],
        artifactScope: [],
        estimatedRuntimeSec: 600,
        retryBudget: 2,
        required: true,
        runtime: "ephemeral",
        modelTier: "heavy", // review kind floor
        specDigest: "",
      });
    }
  }

  // needsRole wins over R4/assembly: an unresolved role is not a dispatchable plan (never silently default-dispatch).
  if (missingRoles.length > 0) return { outcome: "needsRole", missingRoles: [...new Set(missingRoles)], reason: `role(s) not in catalog ${fc.roleCatalog.version}: ${[...new Set(missingRoles)].join(", ")}` };

  // --- R4 from TRUSTED policy only (never the model's covers/risk) ---
  const policy = fc.ownerDomainPolicy;
  const domains = new Set<string>();
  const unknownPaths: string[] = [];
  let frozen = false;
  let irreversible = false;
  let irreversibleUnknown = false;
  for (const n of nodes) {
    for (const p of n.sourceWriteScope ?? []) {
      const d = resolveDomain(p, policy);
      if (d === null) { unknownPaths.push(p); } else { domains.add(d); }
      if (underAny(p, policy.frozenScopePrefixes)) frozen = true;
      if (underAny(p, policy.irreversiblePrefixes)) { irreversible = true; if (d === null) irreversibleUnknown = true; }
    }
  }
  // undecidable ownership on an irreversible/critical path ⇒ cannot safely auto-gate ⇒ ask (R2-R4-UNKNOWN-RISK)
  if (irreversibleUnknown) {
    return { outcome: "needsClarification", reason: "unknown ownership on an irreversible/critical path — cannot classify risk", questions: unknownPaths.filter((p) => underAny(p, policy.irreversiblePrefixes)).map((p, k) => ({ questionId: `q-owner-${k}`, question: `Who owns "${p}", and is this change reversible?`, context: `sourceWriteScope path ${p} matched no owner domain (policy ${policy.version}) and is on an irreversible prefix` })) };
  }
  // ≥2 trusted domains / frozen-contract write / irreversible path / unknown ownership (non-irreversible, conservative) ⇒ design gate
  const needDesign = domains.size >= 2 || frozen || irreversible || unknownPaths.length > 0;

  let allNodes = nodes;
  if (needDesign) {
    if (nodes.some((n) => n.nodeId === DESIGN_GATE_ID)) return R(`cannot auto-prepend design gate: nodeId "${DESIGN_GATE_ID}" already used by a drafted task`);
    // constrained impl nodes get the gate as an ancestor; compute their FINAL digests, then the gate covers them.
    const impl = nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn, DESIGN_GATE_ID] }));
    for (const n of impl) n.specDigest = computeSpecDigest(n);
    const coveredSpecDigests = impl.map((n) => n.specDigest).sort(); // COVERAGE-FINAL: final impl digests, deterministic order
    const reasons = [domains.size >= 2 ? `cross-domain (${[...domains].sort().join(",")})` : "", frozen ? "frozen-contract write" : "", irreversible ? "irreversible path" : "", unknownPaths.length > 0 ? `unknown ownership (${[...new Set(unknownPaths)].sort().join(",")})` : ""].filter(Boolean);
    const gate: TaskSpec = {
      nodeId: DESIGN_GATE_ID,
      kind: "design",
      goal: `R4 adversarial design review (auto-prepended): ${reasons.join("; ")}`,
      dependsOn: [],
      outputContract: { requiredOutputs: [{ logicalName: "design-verdict", kind: "notes" }] },
      acceptance: [{ check: REQUIRED_REVIEW_CHECK, args: { gate: "R4", reasons } }],
      artifactScope: [],
      estimatedRuntimeSec: 600,
      retryBudget: 2,
      required: true,
      runtime: "ephemeral",
      modelTier: "heavy", // design kind floor = heavy
      coveredSpecDigests,
      specDigest: "",
    };
    allNodes = [gate, ...impl];
  }

  // --- budget (reject on overflow / over-cap; BUDGET-INVALID) ---
  const estModelUsd = complexitySum * bp.coefficientUsdPerPoint;
  if (!Number.isFinite(estModelUsd)) return R("budget estimate is not finite (arithmetic overflow)");
  if (estModelUsd > bp.maxModelUsd) return R(`budget estimate ${estModelUsd} exceeds policy cap ${bp.maxModelUsd} (policy ${bp.version})`);

  // --- loadPlan is the SOLE legality authority: graph (dup/dangling/self/cycle) + authoritative digest recompute ---
  const assembled = {
    jobId: draft.jobId,
    planRevision: draft.planRevision ?? 1,
    nodes: allNodes.map((n) => ({ ...n, specDigest: "" })), // let loadPlan recompute; coveredSpecDigests stays (identity)
    jobBudget: { maxTotalAttempts: bp.maxTotalAttempts, maxWallClockSec: bp.maxWallClockSec, maxModelUsd: estModelUsd },
    planDigest: "",
  };
  const loaded = loadPlan(assembled);
  if (!loaded.ok) return R(`assembled plan failed loadPlan: ${loaded.reason}`); // C: cycle/dangling/dup surface here
  return { outcome: "loadable", plan: loaded.plan };
}
