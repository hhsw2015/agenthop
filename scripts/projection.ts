import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Reader for the swarm-brain PROJECTION — the read-only current-state view the brain writes once
 * brain-design §4.3 step A ships. The projection schema is frozen (consumer contract in
 * docs/swarm/viz-projection-contract.md); this module is the consumer half.
 *
 * Three disciplines, straight from the contract:
 *   C-1  read CURRENT STATE, never replay control-log. Re-deriving the reducer here would drift.
 *   C-2  read FILES, never import bus modules. The file shape is the whole interface.
 *   C-3  each file is atomic (temp+rename); cross-file is eventually consistent — tolerate skew, do
 *        not retry-assemble a consistent cut (that reimplements the barrier).
 *
 * JUDGMENT-SINK: `complete`, `jobStatus`, node終败 are computed by the authoritative reducer and arrive
 * in the projection. This module and the page CONSUME those booleans/enums and never re-derive
 * currentAccepted — doing so would show a green node whose upstream has gone stale, the hardest lie to
 * catch. Layout (assignLayers) is the only thing we compute, and layout is presentation, not judgment.
 */

// ---------------------------------------------------------------------------------------------
// Types (mirror the frozen schema; see docs/swarm/viz-projection-contract.md)
// ---------------------------------------------------------------------------------------------

export type JobStatus = "running" | "succeeded" | "failed" | "blocked";
export type NodeKind = "work" | "integration" | "synthesis" | "review" | "repair";
export type AttemptStatus =
  | "RUNNING"
  | "RESULT_PENDING_VALIDATION"
  | "SUCCEEDED"
  | "RETRY_WAIT"
  | "FAILED"
  | "ABANDONED";

/** The executor of a binding — a discriminated union (the stable part; publishKey shape is C0's). */
export type Executor =
  | { kind: "box"; launchId: string }
  | { kind: "member"; memberId: string; publishKey?: string };

export type ExecutionBinding = {
  bindingId: string;
  executor: Executor;
  publishGeneration?: number;
  continuationOf?: string | null;
  state?: "open" | "closing" | "closed";
};

export type TaskNode = {
  nodeId: string;
  kind: NodeKind;
  goal?: string;
  dependsOn: string[];
  required: boolean;
  runtime?: "ephemeral" | "durable";
  visibility?: string;
  specDigest?: string;
  /** View-computed topological depth (NOT from the projection). Added by assignLayers. */
  layer?: number;
};

export type TaskPlan = {
  jobId: string;
  planRevision: number;
  planDigest?: string;
  jobStatus: JobStatus;
  jobStatusNote?: string;
  nodes: TaskNode[];
};

export type AttemptCurrent = {
  attemptId: string;
  status: AttemptStatus;
  statusNote?: string;
  /** = currentAccepted(node) != null, computed by the authoritative reducer. Never re-derived here. */
  complete: boolean;
  role?: string;
  retriesUsed?: number;
  retryAt?: number | null;
  failureClass?: string | null;
  inputBindings?: Array<{ depNodeId: string; acceptedResultId: string }>;
  executionBindings?: ExecutionBinding[];
};

export type AttemptRecord = {
  nodeId: string;
  current?: AttemptCurrent;
  history?: Array<{ attemptId: string; status: AttemptStatus; failureClass?: string | null }>;
};

export type JobResults = {
  accepted?: Array<{
    acceptedResultId: string; nodeId: string; attemptId?: string; observedWorkCommit?: string; resultPath?: string;
    superseded?: boolean;
    /** rev2: who accepted it — the dual-judge structure (fe=conformance, codex=adversarial). */
    decidedBy?: string;
    /** rev2 (S8): the recall — who issued the supersede, and when. */
    supersededBy?: { issuedBy?: string; atSeq?: number } | null;
    decidedAtSeq?: number;
  }>;
  rejected?: Array<{ nodeId: string; attemptId?: string; reason?: string; decidedBy?: string; atSeq?: number }>;
  candidates?: Array<{ nodeId: string; attemptId?: string; note?: string }>;
  /** rev2 (S2): per-attempt observed commits — an attempt can land several (keyed by attemptId). */
  observed?: Array<{ attemptId: string; observedWorkCommit: string; resultPath?: string; note?: string }>;
  peerLate?: number;
};

export type JobBudget = {
  jobBudget?: { maxTotalAttempts?: number; maxWallClockSec?: number; maxModelUsd?: number | null };
  used?: { totalAttempts?: number; wallClockSec?: number; modelUsd?: number | null };
  perNode?: Array<{ nodeId: string; attempts?: number; retriesUsed?: number; retryBudget?: number }>;
};

export type Member = {
  memberId: string;
  class: "durable";
  visibility?: string;
  reachability?: "ok" | "suspected";
  role?: string;
  activeBindings?: string[];
  /** rev2 (S5/F1): identity drift — how many times this member's underlying run id changed. */
  runDrift?: { count?: number; lastChangeAtSec?: number | null };
};

export type ProjectionMeta = { schemaVersion?: number; lastAppliedSeq?: number; rebuiltAt?: number };

/** One job, assembled from its files. The page renders the DAG from this. */
export type VizJob = {
  plan: TaskPlan;
  attempts: Record<string, AttemptRecord>; // keyed by nodeId
  results: JobResults;
  budget: JobBudget | null;
};

export type Projection = {
  present: boolean; // false when no projection dir exists yet (the normal state today)
  meta: ProjectionMeta | null;
  jobs: VizJob[];
  members: Member[];
};

// ---------------------------------------------------------------------------------------------
// Paths — relocatable independently of AH_HOME (lesson: AH_HOME also moves the bus home, which hides
// the live roster; a read source must have its own knob).
// ---------------------------------------------------------------------------------------------

export function projectionDir(home: string = homedir()): string {
  const explicit = process.env.SWARM_PROJECTION_DIR;
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(home, explicit);
  return path.join(home, ".agenthop", "swarm", "projection");
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined; // missing or torn — C-3 tolerates it
  }
}

// ---------------------------------------------------------------------------------------------
// Topological layering — the one thing we compute. Pure, cycle-safe, selftest-covered.
// ---------------------------------------------------------------------------------------------

/**
 * Assign each node a layer = longest dependency path from a root, so the DAG draws left→right by
 * dependency flow and nodes in the same layer with no path between them sit side-by-side (= visible
 * parallelism). Returns a NEW nodes array with `layer` set; never mutates the input.
 *
 * Cycle-safe: the plan is a DAG by construction (brain loads reject cycles), but a torn/partial read
 * could present one. A node still unresolved after V passes is forced to layer 0 rather than looping
 * forever — a defensive floor, not a correctness claim about the data.
 */
export function assignLayers(nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const layer = new Map<string, number>();

  const resolve = (id: string, seen: Set<string>): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle or dangling — floor it
    const node = byId.get(id);
    if (!node) return 0; // dependency points outside the plan (dangling) — treat as a root
    seen.add(id);
    const deps = node.dependsOn.filter((d) => byId.has(d));
    const l = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => resolve(d, seen)));
    seen.delete(id);
    layer.set(id, l);
    return l;
  };

  return nodes.map((n) => ({ ...n, layer: resolve(n.nodeId, new Set()) }));
}

/** Edges of the DAG as (from dep -> to node) pairs, dropping any that point outside the plan. */
export function planEdges(plan: TaskPlan): Array<{ from: string; to: string }> {
  const ids = new Set(plan.nodes.map((n) => n.nodeId));
  const edges: Array<{ from: string; to: string }> = [];
  for (const n of plan.nodes) for (const d of n.dependsOn) if (ids.has(d)) edges.push({ from: d, to: n.nodeId });
  return edges;
}

// ---------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------

/** Every job directory under projection/jobs, each assembled from its files. Absent dir -> []. */
export function readJobs(dir: string): VizJob[] {
  const jobsDir = path.join(dir, "jobs");
  let ids: string[];
  try {
    ids = readdirSync(jobsDir).filter((n) => {
      try {
        return statSync(path.join(jobsDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const out: VizJob[] = [];
  for (const jobId of ids) {
    const jobDir = path.join(jobsDir, jobId);
    const plan = readJson<TaskPlan>(path.join(jobDir, "plan.json"));
    if (!plan || !Array.isArray(plan.nodes)) continue; // a job with no readable plan is not drawable
    plan.nodes = assignLayers(plan.nodes);
    // Attempt files are driven by the plan's nodes (contract commitment: no dir glob).
    const attempts: Record<string, AttemptRecord> = {};
    for (const node of plan.nodes) {
      const rec = readJson<AttemptRecord>(path.join(jobDir, "attempts", `${node.nodeId}.json`));
      if (rec) attempts[node.nodeId] = rec;
    }
    const results = readJson<JobResults>(path.join(jobDir, "results.json")) ?? {};
    const budget = readJson<JobBudget>(path.join(jobDir, "budget.json")) ?? null;
    out.push({ plan, attempts, results, budget });
  }
  return out;
}

export function readMembers(dir: string): Member[] {
  const m = readJson<{ members?: Member[] }>(path.join(dir, "members.json"));
  return Array.isArray(m?.members) ? m!.members : [];
}

/** The whole projection, or { present:false } when the brain has not written one yet. */
export function readProjection(home: string = homedir()): Projection {
  const dir = projectionDir(home);
  if (!existsSync(dir)) return { present: false, meta: null, jobs: [], members: [] };
  return {
    present: true,
    meta: readJson<ProjectionMeta>(path.join(dir, "meta.json")) ?? null,
    jobs: readJobs(dir),
    members: readMembers(dir),
  };
}
