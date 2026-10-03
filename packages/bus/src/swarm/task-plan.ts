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

export type TaskKind = "work" | "integration" | "synthesis" | "review" | "repair";
export type OutputKind = "patch" | "files" | "report" | "notes";

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
  /** Is this node necessary for job success (§4.4 "必需节点,默认全部"; projection viz-gap 2). Defaults to true when
   *  omitted; loadPlan stores it EXPLICITLY so two semantically-equal specs hash identically. It IS part of specDigest
   *  (added at T1 on purpose — adding it at T2 would drift every stored specDigest). */
  required: boolean;
  /** canonical-JSON SHA-256 of this spec's fields (excluding specDigest). Set by loadPlan. */
  specDigest: string;
};

export type JobBudget = {
  maxTotalAttempts: number;
  maxWallClockSec: number;
  maxModelUsd?: number;
};

export type TaskPlan = {
  jobId: string;
  planRevision: number;
  nodes: TaskSpec[];
  jobBudget: JobBudget;
  /** canonical-JSON SHA-256 of the plan (excluding planDigest). Set by loadPlan. */
  planDigest: string;
};

export type LoadResult = { ok: true; plan: TaskPlan } | { ok: false; reason: string };

const TASK_KINDS: ReadonlySet<string> = new Set(["work", "integration", "synthesis", "review", "repair"]);
const OUTPUT_KINDS: ReadonlySet<string> = new Set(["patch", "files", "report", "notes"]);

/** specDigest = canonical-JSON SHA-256 of the spec WITHOUT its own specDigest field (self-reference impossible). */
export function computeSpecDigest(spec: TaskSpec): string {
  const { specDigest: _omit, ...rest } = spec;
  return digestOf(rest);
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
  if (!isIntAtLeast(o.retryBudget, 0)) return { reason: `${where}.retryBudget must be an integer >= 0` };
  if (o.required !== undefined && typeof o.required !== "boolean") return { reason: `${where}.required must be a boolean` };
  const required = o.required === undefined ? true : o.required;

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
    retryBudget: o.retryBudget,
    required,
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

/** Turn untrusted JSON into a legal TaskPlan or reject it whole. Recomputes all digests authoritatively. */
export function loadPlan(raw: unknown): LoadResult {
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

  for (const s of specs) s.specDigest = computeSpecDigest(s);
  const plan: TaskPlan = {
    jobId: o.jobId,
    planRevision: o.planRevision,
    nodes: specs,
    jobBudget: {
      maxTotalAttempts: jb.maxTotalAttempts,
      maxWallClockSec: jb.maxWallClockSec,
      ...(jb.maxModelUsd !== undefined ? { maxModelUsd: jb.maxModelUsd as number } : {}),
    },
    planDigest: "",
  };
  plan.planDigest = computePlanDigest(plan);
  return { ok: true, plan };
}
