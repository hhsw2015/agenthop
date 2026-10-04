/**
 * TaskPlan / TaskSpec — the brain's business-task graph (§2.1, §4.1). PURE schema + validation, no IO. A plan is an
 * explicit DAG authored by a human or a planning agent (open Q2: v1 is hand-written JSON); this module is the trust
 * boundary that turns untrusted JSON into a legal plan or rejects it WHOLE.
 *
 * Two deliberate non-ports of happycapy's loader (prior-art §2.1, §3.5):
 *   - NO silent repair. An illegal graph (duplicate nodeId, missing/dangling dependency, self-loop, cycle) rejects
 *     the ENTIRE plan with a reason — we never drop the offending edge and hand back a "fixed" plan. A silently
 *     repaired graph runs the wrong job.
 *   - Digests are canonical-JSON SHA-256 (digest.ts), content-addressed: specDigest identifies "the same task" across
 *     plan revisions (§2.2 V5), planDigest identifies "the same plan" for §2.6 PlanPut idempotency/conflict. loadPlan
 *     recomputes both AUTHORITATIVELY and ignores any digests present in the input — on a hand-written plan they are
 *     derived, not trusted. (Tamper/conflict detection is the commitControl layer's job, T2, not the loader's.)
 *
 * NON-GOAL here: readyTasks / currentAccepted / scheduling (§4.1, §3.1) — those are T2 (task-ready.ts). This module
 * stops at "is this a legal plan, and what are its stable digests".
 */

import { digestOf } from "./digest.js";
import { evaluateR4, overlapsAny, type OwnerDomainPolicy, type RiskPolicy, type NodeRisk } from "./task-r4.js";

// "design" (team-collab §0b R4): an adversarial-review GATE node a planner auto-prepends for a high-stakes change —
// kind IS task identity (in specDigest), so it is a first-class kind, not a role annotation.
export type TaskKind = "work" | "integration" | "synthesis" | "review" | "repair" | "design";
export type OutputKind = "patch" | "files" | "report" | "notes";
/** Model difficulty tier (model-tiering-notes §4): light|standard|heavy. A planner hint, NOT task identity. */
export type ModelTier = "light" | "standard" | "heavy";

export type RequiredOutput = {
  logicalName: string;
  kind: OutputKind;
  pathHint?: string;
};

export type OutputContract = {
  requiredOutputs: RequiredOutput[];
  /** kind=patch outputs: the fixed source commit the patch applies to (V7 `git apply --check`). Required when any
   *  requiredOutput is a patch — without it V7 is unrunnable. */
  baseSourceCommit?: string;
};

export type AcceptanceCheck = { check: string; args?: Record<string, unknown> };

export type TaskSpec = {
  nodeId: string;
  kind: TaskKind;
  goal: string;
  dependsOn: string[];
  outputContract: OutputContract;
  acceptance: AcceptanceCheck[];
  /** Allowed WORK artifact path prefixes (subset of the supervisor allowlist). */
  artifactScope: string[];
  /** kind=patch: path prefixes in the SOURCE base the patch may touch — a different coordinate system from
   *  artifactScope (§2.1; Codex v2-P2-5: a patch.diff lives in out/ but edits src/). */
  sourceWriteScope?: string[];
  estimatedRuntimeSec: number;
  retryBudget: number;
  // --- plan/dispatch ROLE ANNOTATIONS. NOT part of specDigest (task identity) — only planDigest. Flipping any of
  //     these must NOT V5-invalidate a running attempt: retagging a node required/durable did not change the TASK
  //     (§4.2 V5 = "the task itself changed"; fe0376cd review #2). They ARE in planDigest, so §2.6 PlanPut conflict
  //     detection still sees the change.
  /** Necessary for job success (§4.4 "必需节点,默认全部"; projection viz-gap 2). Default true, stored explicitly. */
  required: boolean;
  /** Who executes it: an ephemeral box (outsourced) or a durable member (employee). team-collab §2 node annotation.
   *  Default "ephemeral", stored explicitly. */
  runtime: "ephemeral" | "durable";
  /** Member visibility — only meaningful for a durable member (a box is always headless), so only allowed when
   *  runtime=durable. Optional; absent otherwise. */
  visibility?: "visible" | "headless";
  /** Model difficulty tier the planner assigned (T3). NOT part of specDigest — re-tiering a node did not change the
   *  TASK (same rule as required/runtime/visibility; model-tiering-notes §4 "加字段不升版"). In planDigest. Optional. */
  modelTier?: ModelTier;
  /** Role/skill the executor must match (T3 planner, team-collab §2). NOT part of specDigest — re-staffing ≠ task
   *  changed, so it must not V5-invalidate a running attempt (same class as the other role annotations). Optional. */
  roleProfile?: string;
  /** design-gate node (R4): the FINAL specDigests this node's adversarial review covers. IN specDigest — the coverage
   *  mapping is part of the design task's IDENTITY (changing what it must cover changes the task; design D / P2-3).
   *  Only meaningful on a kind=design node; absent elsewhere. */
  coveredSpecDigests?: string[];
  /** Requester-declared criticality (T3 c790ff1d / errata 0b966a11): a critical node makes unknown-risk worth ASKING.
   *  Annotation class — EXCLUDED from specDigest (a dispatch/supervision attribute, not task identity; same family as
   *  modelTier/roleProfile), kept in planDigest. Persisted so the managed loader can re-verify the unknown∧critical ->
   *  needsClarification decision instead of trusting the planner. */
  criticalPath?: boolean;
  /** Per-node risk adjudication from a requester clarification (T3b, design §3 "节点显式标记"). Annotation class —
   *  EXCLUDED from specDigest (same family as modelTier/roleProfile/criticalPath), kept in planDigest. **NOT trusted from
   *  the serialized plan by the managed loader** — because "reversible" can REMOVE a design gate (an asymmetric, dangerous
   *  forge), the managed loader IGNORES this field unless the caller supplies matching trusted clarification evidence
   *  (ManagedT3Opts.resolvedRisk, derived from closed waits bound to the payloadRef). Set only by the recompile. */
  resolvedRisk?: NodeRisk;
  /** canonical-JSON SHA-256 of the TASK IDENTITY fields — everything EXCEPT specDigest and the role annotations
   *  required/runtime/visibility/modelTier/roleProfile/criticalPath/resolvedRisk (coveredSpecDigests stays IN: identity). */
  specDigest: string;
};

export type JobBudget = {
  maxTotalAttempts: number;
  maxWallClockSec: number;
  maxModelUsd?: number;
};

/** Version references for the frozenContext a planner compiled this plan under (T3 Q2a): digest/version strings, NOT
 *  inlined content (inlining would pollute plan identity). Pinned so loader round-trip + replay see the exact versions;
 *  the content is fetched from digest-addressed durable snapshots by the IO layer. Part of the plan, so in planDigest. */
export type FrozenRefs = {
  checkRegistry: string;
  ownerDomainPolicy: string;
  riskPolicy: string;
  roleCatalog: string;
  budgetPolicy: string;
  r4ThresholdPolicy: string;
  sourceBaselineDigest: string;
  planningRequestId?: string;
};

export type TaskPlan = {
  jobId: string;
  planRevision: number;
  nodes: TaskSpec[];
  jobBudget: JobBudget;
  /** Set by a planner (T3); absent on a hand-written plan. Round-trips through loadPlan unchanged. */
  frozenRefs?: FrozenRefs;
  /** Explicitly phased capabilities (T3 P2-7): e.g. ["r4-threshold"] when R4 condition 3 isn't implemented yet. An
   *  honest marker (not a silent gap); round-trips through loadPlan, in planDigest. */
  notImplemented?: string[];
  /** canonical-JSON SHA-256 of the plan (excluding planDigest). Set by loadPlan. */
  planDigest: string;
};

/** Optional managed-T3 loader mode (loader-interface ruling f06894b8): the loader re-runs the SHARED evaluateR4 against
 *  a trusted policy snapshot and enforces that a required design gate exists covering every impl node — it does NOT just
 *  trust the planner's own coverage. Also ref-matches the plan's frozenRefs against the snapshot. No IO/LLM. */
export type ManagedT3Opts = {
  mode: "managed-t3";
  ownerDomainPolicy: OwnerDomainPolicy;
  riskPolicy: RiskPolicy;
  expectedFrozenRefs: FrozenRefs;
  /** TRUSTED per-node risk evidence (nodeId -> NodeRisk), derived by the caller from closed clarification waits bound to
   *  the plan's payloadRef. A node's serialized resolvedRisk is honored ONLY when it matches this map; otherwise it is
   *  IGNORED (treated as policy), so a forged resolvedRisk cannot remove a design gate. Absent => all serialized
   *  resolvedRisk ignored. */
  resolvedRisk?: Record<string, NodeRisk>;
};

export type LoadResult = { ok: true; plan: TaskPlan } | { ok: false; reason: string };

const TASK_KINDS: ReadonlySet<string> = new Set(["work", "integration", "synthesis", "review", "repair", "design"]);
const OUTPUT_KINDS: ReadonlySet<string> = new Set(["patch", "files", "report", "notes"]);
const MODEL_TIERS: ReadonlySet<string> = new Set(["light", "standard", "heavy"]);
const RUNTIMES: ReadonlySet<string> = new Set(["ephemeral", "durable"]);
const VISIBILITIES: ReadonlySet<string> = new Set(["visible", "headless"]);

/** specDigest = canonical-JSON SHA-256 of the TASK IDENTITY fields. Omits specDigest (self-reference) AND the
 *  plan/dispatch role annotations required/runtime/visibility: specDigest answers "what must the worker do and what
 *  counts as acceptable", so V5 invalidates an attempt ONLY when the task itself changed — never when a node is
 *  retagged required/durable/visible/retiered/restaffed (§4.2 V5; fe0376cd review #2; T3 F-T3-2). coveredSpecDigests
 *  is NOT excluded — a design node's coverage set is part of its identity. */
export function computeSpecDigest(spec: TaskSpec): string {
  const { specDigest: _d, required: _r, runtime: _rt, visibility: _v, modelTier: _mt, roleProfile: _rp, criticalPath: _cp, resolvedRisk: _rr, ...identity } = spec;
  return digestOf(identity);
}

/** planDigest = canonical-JSON SHA-256 of the plan WITHOUT its own planDigest field. Node specDigests are part of
 *  the hashed content (they must already be set — loadPlan sets them before calling this). */
export function computePlanDigest(plan: TaskPlan): string {
  const { planDigest: _omit, ...rest } = plan;
  return digestOf(rest);
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isIntAtLeast = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
const isNumAtLeast = (v: unknown, min: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min;

/** Validate one node's shape (not graph edges). Returns null on success or a reason string. */
function validateSpecShape(raw: unknown, index: number): { reason: string } | { spec: TaskSpec } {
  const at = `nodes[${index}]`;
  if (typeof raw !== "object" || raw === null) return { reason: `${at} not an object` };
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.nodeId)) return { reason: `${at}.nodeId must be a non-empty string` };
  const where = `node ${o.nodeId}`;
  if (!isString(o.kind) || !TASK_KINDS.has(o.kind)) return { reason: `${where}.kind invalid` };
  if (!isString(o.goal)) return { reason: `${where}.goal must be a string` };
  if (!isStringArray(o.dependsOn)) return { reason: `${where}.dependsOn must be a string[]` };
  if (typeof o.outputContract !== "object" || o.outputContract === null) return { reason: `${where}.outputContract missing` };
  const oc = o.outputContract as Record<string, unknown>;
  if (!Array.isArray(oc.requiredOutputs)) return { reason: `${where}.outputContract.requiredOutputs must be an array` };
  let hasPatch = false;
  for (let i = 0; i < oc.requiredOutputs.length; i++) {
    const ro = oc.requiredOutputs[i] as Record<string, unknown>;
    if (typeof ro !== "object" || ro === null) return { reason: `${where}.requiredOutputs[${i}] not an object` };
    if (!isNonEmptyString(ro.logicalName)) return { reason: `${where}.requiredOutputs[${i}].logicalName` };
    if (!isString(ro.kind) || !OUTPUT_KINDS.has(ro.kind)) return { reason: `${where}.requiredOutputs[${i}].kind invalid` };
    if (ro.pathHint !== undefined && !isString(ro.pathHint)) return { reason: `${where}.requiredOutputs[${i}].pathHint` };
    if (ro.kind === "patch") hasPatch = true;
  }
  if (oc.baseSourceCommit !== undefined && !isString(oc.baseSourceCommit)) return { reason: `${where}.baseSourceCommit` };
  if (hasPatch && !isNonEmptyString(oc.baseSourceCommit)) return { reason: `${where}: patch output requires outputContract.baseSourceCommit` };
  if (!Array.isArray(o.acceptance)) return { reason: `${where}.acceptance must be an array` };
  for (let i = 0; i < o.acceptance.length; i++) {
    const ac = o.acceptance[i] as Record<string, unknown>;
    if (typeof ac !== "object" || ac === null || !isNonEmptyString(ac.check)) return { reason: `${where}.acceptance[${i}].check` };
    if (ac.args !== undefined && (typeof ac.args !== "object" || ac.args === null)) return { reason: `${where}.acceptance[${i}].args` };
  }
  if (!isStringArray(o.artifactScope)) return { reason: `${where}.artifactScope must be a string[]` };
  if (o.sourceWriteScope !== undefined && !isStringArray(o.sourceWriteScope)) return { reason: `${where}.sourceWriteScope` };
  if (!isNumAtLeast(o.estimatedRuntimeSec, 0)) return { reason: `${where}.estimatedRuntimeSec` };
  if (o.retryBudget !== undefined && !isIntAtLeast(o.retryBudget, 0)) return { reason: `${where}.retryBudget must be an integer >= 0` };
  const retryBudget = o.retryBudget === undefined ? 2 : o.retryBudget; // §2.1 "默认 2": omission is legal, explicit invalid is not
  if (o.required !== undefined && typeof o.required !== "boolean") return { reason: `${where}.required must be a boolean` };
  const required = o.required === undefined ? true : o.required;
  if (o.runtime !== undefined && (!isString(o.runtime) || !RUNTIMES.has(o.runtime))) return { reason: `${where}.runtime must be ephemeral|durable` };
  const runtime = (o.runtime === undefined ? "ephemeral" : o.runtime) as "ephemeral" | "durable";
  if (o.visibility !== undefined) {
    if (!isString(o.visibility) || !VISIBILITIES.has(o.visibility)) return { reason: `${where}.visibility must be visible|headless` };
    if (runtime !== "durable") return { reason: `${where}.visibility only allowed when runtime=durable` };
  }
  if (o.modelTier !== undefined && (!isString(o.modelTier) || !MODEL_TIERS.has(o.modelTier))) return { reason: `${where}.modelTier must be light|standard|heavy` };
  if (o.roleProfile !== undefined && !isNonEmptyString(o.roleProfile)) return { reason: `${where}.roleProfile must be a non-empty string` };
  if (o.coveredSpecDigests !== undefined && !isStringArray(o.coveredSpecDigests)) return { reason: `${where}.coveredSpecDigests must be a string[]` };
  if (o.criticalPath !== undefined && typeof o.criticalPath !== "boolean") return { reason: `${where}.criticalPath must be a boolean` };
  if (o.resolvedRisk !== undefined && o.resolvedRisk !== "reversible" && o.resolvedRisk !== "irreversible") return { reason: `${where}.resolvedRisk must be "reversible" or "irreversible"` };

  const spec: TaskSpec = {
    nodeId: o.nodeId,
    kind: o.kind as TaskKind,
    goal: o.goal,
    dependsOn: [...o.dependsOn],
    outputContract: {
      requiredOutputs: (oc.requiredOutputs as Record<string, unknown>[]).map((ro) => ({
        logicalName: ro.logicalName as string,
        kind: ro.kind as OutputKind,
        ...(ro.pathHint !== undefined ? { pathHint: ro.pathHint as string } : {}),
      })),
      ...(oc.baseSourceCommit !== undefined ? { baseSourceCommit: oc.baseSourceCommit as string } : {}),
    },
    acceptance: (o.acceptance as Record<string, unknown>[]).map((ac) => ({
      check: ac.check as string,
      ...(ac.args !== undefined ? { args: ac.args as Record<string, unknown> } : {}),
    })),
    artifactScope: [...o.artifactScope],
    ...(o.sourceWriteScope !== undefined ? { sourceWriteScope: [...(o.sourceWriteScope as string[])] } : {}),
    estimatedRuntimeSec: o.estimatedRuntimeSec,
    retryBudget,
    required,
    runtime,
    ...(o.visibility !== undefined ? { visibility: o.visibility as "visible" | "headless" } : {}),
    ...(o.modelTier !== undefined ? { modelTier: o.modelTier as ModelTier } : {}),
    ...(o.roleProfile !== undefined ? { roleProfile: o.roleProfile as string } : {}),
    ...(o.coveredSpecDigests !== undefined ? { coveredSpecDigests: [...(o.coveredSpecDigests as string[])] } : {}),
    ...(o.criticalPath !== undefined ? { criticalPath: o.criticalPath as boolean } : {}),
    ...(o.resolvedRisk !== undefined ? { resolvedRisk: o.resolvedRisk as NodeRisk } : {}),
    specDigest: "",
  };
  return { spec };
}

/** Detect a cycle via DFS coloring. Assumes all dependsOn targets exist (checked before). Returns a node on a cycle
 *  or null. Self-loops are caught earlier for a clearer message. */
function findCycle(nodes: TaskSpec[]): string | null {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.nodeId, n.dependsOn]));
  const color = new Map<string, 0 | 1 | 2>(); // 0 white, 1 gray, 2 black
  let found: string | null = null;
  const visit = (id: string): void => {
    if (found) return;
    color.set(id, 1);
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep) ?? 0;
      if (c === 1) { found = dep; return; }
      if (c === 0) { visit(dep); if (found) return; }
    }
    color.set(id, 2);
  };
  for (const n of nodes) if ((color.get(n.nodeId) ?? 0) === 0) { visit(n.nodeId); if (found) break; }
  return found;
}

function validateFrozenRefs(v: unknown): { reason: string } | { refs: FrozenRefs | undefined } {
  if (v === undefined) return { refs: undefined };
  if (typeof v !== "object" || v === null) return { reason: "frozenRefs must be an object" };
  const o = v as Record<string, unknown>;
  const req = ["checkRegistry", "ownerDomainPolicy", "riskPolicy", "roleCatalog", "budgetPolicy", "r4ThresholdPolicy", "sourceBaselineDigest"] as const;
  for (const k of req) if (!isNonEmptyString(o[k])) return { reason: `frozenRefs.${k} must be a non-empty string` };
  if (o.planningRequestId !== undefined && !isNonEmptyString(o.planningRequestId)) return { reason: "frozenRefs.planningRequestId must be a non-empty string" };
  return {
    refs: {
      checkRegistry: o.checkRegistry as string, ownerDomainPolicy: o.ownerDomainPolicy as string, riskPolicy: o.riskPolicy as string,
      roleCatalog: o.roleCatalog as string, budgetPolicy: o.budgetPolicy as string, r4ThresholdPolicy: o.r4ThresholdPolicy as string,
      sourceBaselineDigest: o.sourceBaselineDigest as string,
      ...(o.planningRequestId !== undefined ? { planningRequestId: o.planningRequestId as string } : {}),
    },
  };
}

/** R4 structural coverage validation (T3 P1-2; policy-free — the four-condition OR re-run needs frozenContext and so
 *  stays in translateDraft). A kind=design gate must (a) cover at least one node, (b) cover only REAL node digests — no
 *  stale/dangling coverage (catches "change M, keep old D coverage"), and (c) be a transitive ANCESTOR of every node it
 *  covers (design-ancestor: the gate precedes the gated work). Runs after specDigests are set. Returns a reason or null. */
function validateR4Coverage(specs: TaskSpec[]): string | null {
  const byDigest = new Map<string, string>();
  for (const s of specs) byDigest.set(s.specDigest, s.nodeId);
  const deps = new Map(specs.map((s) => [s.nodeId, s.dependsOn] as const));
  const ancestorCache = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [...(deps.get(id) ?? [])];
    while (stack.length > 0) {
      const d = stack.pop()!;
      if (out.has(d)) continue;
      out.add(d);
      for (const dd of deps.get(d) ?? []) stack.push(dd);
    }
    ancestorCache.set(id, out);
    return out;
  };
  for (const d of specs) {
    if (d.kind !== "design") continue;
    const cov = d.coveredSpecDigests;
    if (cov === undefined || cov.length === 0) return `design node ${d.nodeId} must cover at least one node (empty coveredSpecDigests)`;
    for (const cd of cov) {
      const coveredId = byDigest.get(cd);
      if (coveredId === undefined) return `design node ${d.nodeId} covers digest ${cd} matching no node (stale/dangling coverage)`;
      if (coveredId === d.nodeId) return `design node ${d.nodeId} cannot cover itself`;
      if (!ancestorsOf(coveredId).has(d.nodeId)) return `design node ${d.nodeId} is not an ancestor of covered node ${coveredId}`;
    }
  }
  return null;
}

function frozenRefsMismatch(got: FrozenRefs | undefined, want: FrozenRefs): string | null {
  if (got === undefined) return "managed-t3: plan has no frozenRefs";
  const keys: (keyof FrozenRefs)[] = ["checkRegistry", "ownerDomainPolicy", "riskPolicy", "roleCatalog", "budgetPolicy", "r4ThresholdPolicy", "sourceBaselineDigest", "planningRequestId"];
  for (const k of keys) if (got[k] !== want[k]) return `managed-t3: frozenRefs.${k} mismatch (plan ${String(got[k])} vs policy ${String(want[k])})`;
  return null;
}

/** Managed-T3 R4 enforcement (loader ruling f06894b8): re-run the SHARED evaluateR4 on the impl nodes against the
 *  trusted policy snapshot; if a design gate is required, EVERY impl node's final specDigest must appear in some design
 *  node's coverage. Catches the structural bypasses a/b/c miss — deleting all design nodes (still cross-domain) or
 *  covering only a subset. (Structural dangling/ancestor/non-empty is validateR4Coverage's job.) */
function validateManagedT3(specs: TaskSpec[], opts: ManagedT3Opts): string | null {
  // EFFECTIVE per-node risk: honor a serialized resolvedRisk ONLY when it matches the caller's TRUSTED evidence map;
  // otherwise ignore it (a forged resolvedRisk must not remove a gate). Absent evidence => every serialized value ignored.
  const effectiveRisk = (s: TaskSpec): NodeRisk | undefined =>
    s.resolvedRisk !== undefined && opts.resolvedRisk?.[s.nodeId] === s.resolvedRisk ? s.resolvedRisk : undefined;

  // A critical node with an unknown-risk path should have been needsClarification, never loadable (c790ff1d ③ /
  // errata 0b966a11) — UNLESS a trusted clarification resolved it (effective resolvedRisk present). This applies to EVERY
  // node — INCLUDING a design gate itself; so it runs over all specs, not the impl-only filter used for coverage.
  for (const s of specs) if (s.criticalPath === true && effectiveRisk(s) === undefined) for (const p of s.sourceWriteScope ?? []) {
    if (overlapsAny(p, opts.riskPolicy.undecidablePrefixes)) return `managed-t3: node ${s.nodeId} is criticalPath with unknown-risk path ${p} — should be needsClarification, not loadable`;
  }
  const impl = specs.filter((s) => s.kind !== "design").map((s) => ({ ...s, resolvedRisk: effectiveRisk(s) }));
  const assess = evaluateR4(impl, opts.ownerDomainPolicy, opts.riskPolicy);
  if (!assess.designRequired) return null;
  const covered = new Set<string>();
  for (const s of specs) if (s.kind === "design" && s.coveredSpecDigests) for (const d of s.coveredSpecDigests) covered.add(d);
  const uncovered = impl.filter((s) => !covered.has(s.specDigest));
  if (uncovered.length > 0) return `managed-t3: R4 requires a design gate (${assess.reasons.join("; ")}) covering every impl node; uncovered: ${uncovered.map((s) => s.nodeId).join(",")}`;
  return null;
}

/** Turn untrusted JSON into a legal TaskPlan or reject it whole. Recomputes all digests authoritatively. In managed-t3
 *  mode the loader additionally ref-matches frozenRefs and re-enforces R4 from the trusted policy snapshot. */
export function loadPlan(raw: unknown, opts?: ManagedT3Opts): LoadResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "plan not an object" };
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.jobId)) return { ok: false, reason: "jobId must be a non-empty string" };
  if (!isIntAtLeast(o.planRevision, 0)) return { ok: false, reason: "planRevision must be an integer >= 0" };
  if (!Array.isArray(o.nodes) || o.nodes.length === 0) return { ok: false, reason: "nodes must be a non-empty array" };

  if (typeof o.jobBudget !== "object" || o.jobBudget === null) return { ok: false, reason: "jobBudget missing" };
  const jb = o.jobBudget as Record<string, unknown>;
  if (!isIntAtLeast(jb.maxTotalAttempts, 1)) return { ok: false, reason: "jobBudget.maxTotalAttempts must be an integer >= 1" };
  if (!isNumAtLeast(jb.maxWallClockSec, 1)) return { ok: false, reason: "jobBudget.maxWallClockSec must be >= 1" };
  if (jb.maxModelUsd !== undefined && !isNumAtLeast(jb.maxModelUsd, 0)) return { ok: false, reason: "jobBudget.maxModelUsd" };

  const fr = validateFrozenRefs(o.frozenRefs);
  if ("reason" in fr) return { ok: false, reason: fr.reason };
  if (o.notImplemented !== undefined && !isStringArray(o.notImplemented)) return { ok: false, reason: "notImplemented must be a string[]" };

  const specs: TaskSpec[] = [];
  for (let i = 0; i < o.nodes.length; i++) {
    const res = validateSpecShape(o.nodes[i], i);
    if ("reason" in res) return { ok: false, reason: res.reason };
    specs.push(res.spec);
  }

  // Graph legality — reject WHOLE, never repair.
  const ids = new Set<string>();
  for (const s of specs) {
    if (ids.has(s.nodeId)) return { ok: false, reason: `duplicate nodeId ${s.nodeId}` };
    ids.add(s.nodeId);
  }
  for (const s of specs) {
    for (const dep of s.dependsOn) {
      if (dep === s.nodeId) return { ok: false, reason: `node ${s.nodeId} has a self-loop` };
      if (!ids.has(dep)) return { ok: false, reason: `node ${s.nodeId} depends on missing node ${dep}` };
    }
  }
  const cyc = findCycle(specs);
  if (cyc) return { ok: false, reason: `plan has a cycle (through ${cyc})` };

  const plan: TaskPlan = {
    jobId: o.jobId,
    planRevision: o.planRevision,
    nodes: specs,
    jobBudget: {
      maxTotalAttempts: jb.maxTotalAttempts,
      maxWallClockSec: jb.maxWallClockSec,
      ...(jb.maxModelUsd !== undefined ? { maxModelUsd: jb.maxModelUsd as number } : {}),
    },
    ...(fr.refs !== undefined ? { frozenRefs: fr.refs } : {}),
    ...(o.notImplemented !== undefined ? { notImplemented: [...(o.notImplemented as string[])] } : {}),
    planDigest: "",
  };
  // Digests canonicalize the whole spec (including arbitrary acceptance.args), so a non-finite number smuggled in via
  // JSON.parse("1e400") => Infinity surfaces HERE. loadPlan's contract is "a legal plan or a whole reject" — it must
  // never throw, so catch it and reject (Codex re-review h).
  try {
    for (const s of specs) s.specDigest = computeSpecDigest(s);
    plan.planDigest = computePlanDigest(plan);
  } catch {
    return { ok: false, reason: "non-finite or unserializable value in plan" };
  }
  // R4 structural coverage (design-ancestor / coverage-match / non-empty) — runs on authoritative digests.
  const covReason = validateR4Coverage(specs);
  if (covReason) return { ok: false, reason: covReason };
  // Managed-T3: ref-match + policy-driven R4 enforcement (loader does not just trust the planner's coverage).
  if (opts?.mode === "managed-t3") {
    // guard the opts shape (missing policy/refs -> clean reject, never a TypeError)
    if (opts.ownerDomainPolicy == null || opts.riskPolicy == null || opts.expectedFrozenRefs == null || typeof opts.ownerDomainPolicy.version !== "string" || typeof opts.riskPolicy.version !== "string") {
      return { ok: false, reason: "managed-t3 requires ownerDomainPolicy, riskPolicy, and expectedFrozenRefs (with versions)" };
    }
    // the policy snapshot used to re-evaluate R4 MUST be the version the plan was compiled under — otherwise a weak/other
    // policy could wave a cross-domain no-gate plan through even with matching frozenRefs.
    if (opts.ownerDomainPolicy.version !== opts.expectedFrozenRefs.ownerDomainPolicy) return { ok: false, reason: `managed-t3: ownerDomainPolicy version ${opts.ownerDomainPolicy.version} != plan ref ${opts.expectedFrozenRefs.ownerDomainPolicy}` };
    if (opts.riskPolicy.version !== opts.expectedFrozenRefs.riskPolicy) return { ok: false, reason: `managed-t3: riskPolicy version ${opts.riskPolicy.version} != plan ref ${opts.expectedFrozenRefs.riskPolicy}` };
    const refMismatch = frozenRefsMismatch(plan.frozenRefs, opts.expectedFrozenRefs);
    if (refMismatch) return { ok: false, reason: refMismatch };
    const mReason = validateManagedT3(specs, opts);
    if (mReason) return { ok: false, reason: mReason };
  }
  // Deep-clone so the returned plan shares NO mutable reference with the caller's input (acceptance.args etc.): a later
  // mutation of the input must not change the loaded plan or invalidate its digests (Codex re-review g).
  return { ok: true, plan: structuredClone(plan) };
}
