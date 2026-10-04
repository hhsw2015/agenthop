/**
 * Projection writer (projection-schema v1 — docs/swarm/projection-schema.md). The READ-ONLY consumer view of swarm state
 * for swarm-viz + fast dispatcher startup. PURE derivation from the control-log LogState via the AUTHORITATIVE deciders
 * (buildSched / jobStatus / currentAccepted), so a consumer never re-implements the reducer (C-1) and never self-computes a
 * cascaded judgment (complete / jobStatus) that would drift (viz-gap 1). CONTROL is authoritative; a lost/corrupt
 * projection is rebuilt by replay (§8). The IO half (atomic temp+rename per file, C-3) is writeProjection below.
 *
 * Scope v1: the control-log-derived files — meta + jobs/<jobId>/{plan,attempts/<nodeId>,results,budget}. members.json is
 * the bus ROSTER (not control-log data), so it is written by the dispatcher from its peer roster, not here (the consumer
 * contract merges members.json with its own peers()). executor is always {kind:"box"} in v1 — the durable-member binding
 * variant (§3 [D]) is not yet in ExecutionBinding.
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { liveEntities, type LogState } from "./control-log.js";
import type { TaskPlan } from "./task-plan.js";
import type { TaskAttempt, ExecutionBinding } from "./task-state.js";
import type { AcceptedResult } from "./task-result.js";
import { buildSched } from "./task-pass.js";
import { jobStatus, currentAccepted, type JobUsage } from "./task-ready.js";

export const PROJECTION_SCHEMA_VERSION = 1;

export type ProjectionFile = { relPath: string; json: unknown };
export type ProjectOpts = { nowSec: number; jobStartSec?: (jobId: string) => number | undefined };

const HISTORY_MAX = 8; // Open question 1: last 8 attempts + count.

const bindingState = (b: ExecutionBinding): "open" | "closing" | "closed" =>
  b.closedAtSeq !== undefined ? "closed" : b.closing !== undefined ? "closing" : "open";

/** A short human line for a status (the consumer shows it directly; English only, viz translates — Open question 2). */
function statusNote(a: TaskAttempt): string {
  if (a.note) return a.note;
  switch (a.status) {
    case "RUNNING": return "worker running";
    case "RESULT_PENDING_VALIDATION": return "worker reported a result, awaiting validation";
    case "SUCCEEDED": return "accepted";
    case "RETRY_WAIT": return `retry scheduled${a.failureClass ? ` (${a.failureClass})` : ""}`;
    case "FAILED": return `failed${a.failureClass ? ` (${a.failureClass})` : ""}`;
    case "ABANDONED": return `abandoned${a.abandonReason ? ` (${a.abandonReason})` : ""}`;
    default: return String(a.status);
  }
}

function attemptView(a: TaskAttempt) {
  return {
    attemptId: a.attemptId,
    status: a.status,
    statusNote: statusNote(a),
    role: null, // v1: the assignment's role text is not persisted in the control-log (viz-gap 4) — a follow-up when it is.
    retriesUsed: a.retriesUsed,
    retryAt: a.retryAt ?? null,
    failureClass: a.failureClass ?? null,
    inputBindings: a.inputBindings,
    executionBindings: a.executionBindings.map((b) => ({
      bindingId: b.bindingId,
      executor: { kind: "box" as const, launchId: b.launchId }, // v1: all bindings are box (durable-member variant is §3 [D])
      publishGeneration: b.publishGeneration,
      continuationOf: b.continuationOf ?? null,
      state: bindingState(b),
    })),
  };
}

/** Build every projection file for the current control-log state. Pure; the caller writes them atomically. */
export function buildProjectionFiles(state: LogState, opts: ProjectOpts): ProjectionFile[] {
  const out: ProjectionFile[] = [];
  out.push({ relPath: "meta.json", json: { schemaVersion: PROJECTION_SCHEMA_VERSION, lastAppliedSeq: state.seq, rebuiltAt: new Date(opts.nowSec * 1000).toISOString() } });
  // members.json — the durable roster is the bus peers() view, which the control-log does not hold; v1 emits an empty
  // roster so the file always exists for the defensive consumer, and viz fills live members from its own peers() merge
  // (schema §6 consumer promise). activeBindings would come from member-kind executionBindings (none in v1 — all box).
  out.push({ relPath: "members.json", json: { members: [] as unknown[] } });

  const plans: TaskPlan[] = [];
  const attempts: TaskAttempt[] = [];
  const accepted: AcceptedResult[] = [];
  const rejected: Array<{ nodeId: string; attemptId: string; atSeq: number; [k: string]: unknown }> = [];
  for (const body of Object.values(liveEntities(state))) {
    if (body.put === "plan") plans.push(body.plan as unknown as TaskPlan);
    else if (body.put === "attempt") attempts.push(body.attempt);
    else if (body.put === "accepted") accepted.push(body.accepted);
    else if (body.put === "rejected") rejected.push(body.rejected as unknown as { nodeId: string; attemptId: string; atSeq: number });
  }

  for (const plan of plans) {
    const jobId = plan.jobId;
    const sched = buildSched(plan, state);
    const jobStartSec = opts.jobStartSec?.(jobId);
    const wallClockSec = jobStartSec !== undefined ? Math.max(0, opts.nowSec - jobStartSec) : 0;
    const usage: JobUsage = { totalAttempts: sched.attempts.length, wallClockSec };
    const status = jobStatus({ ...sched, now: opts.nowSec, jobUsage: usage });

    // plan.json — the DAG skeleton + the authoritative job status.
    out.push({
      relPath: `jobs/${jobId}/plan.json`,
      json: {
        jobId, planRevision: plan.planRevision, planDigest: plan.planDigest,
        jobStatus: status.status, jobStatusNote: status.note ?? "",
        nodes: plan.nodes.map((n) => ({
          nodeId: n.nodeId, kind: n.kind, goal: n.goal, dependsOn: n.dependsOn,
          required: n.required, runtime: n.runtime, ...(n.visibility !== undefined ? { visibility: n.visibility } : {}),
          specDigest: n.specDigest,
        })),
      },
    });

    // attempts/<nodeId>.json — current attempt + complete + history, per node declared in the plan.
    const byNode = new Map<string, TaskAttempt[]>();
    for (const a of sched.attempts) { const arr = byNode.get(a.nodeId) ?? []; arr.push(a); byNode.set(a.nodeId, arr); }
    for (const node of plan.nodes) {
      const nodeAttempts = (byNode.get(node.nodeId) ?? []).slice().sort((x, y) => x.createdAtSeq - y.createdAtSeq);
      if (nodeAttempts.length === 0) continue; // no attempt yet ⇒ no file (consumer renders pending from plan)
      const current = nodeAttempts[nodeAttempts.length - 1]!;
      const complete = currentAccepted(node.nodeId, sched) !== null; // AUTHORITATIVE (reducer), never self-computed
      const history = nodeAttempts.slice(0, -1).slice(-HISTORY_MAX).map((a) => ({ attemptId: a.attemptId, status: a.status, failureClass: a.failureClass ?? null }));
      out.push({ relPath: `jobs/${jobId}/attempts/${node.nodeId}.json`, json: { nodeId: node.nodeId, current: { ...attemptView(current), complete }, history } });
    }

    // results.json — acceptance decisions for this job.
    const jobAccepted = accepted.filter((r) => r.jobId === jobId);
    const jobNodeIds = new Set(plan.nodes.map((n) => n.nodeId));
    out.push({
      relPath: `jobs/${jobId}/results.json`,
      json: {
        accepted: jobAccepted.map((r) => ({ acceptedResultId: r.acceptedResultId, nodeId: r.nodeId, attemptId: r.attemptId, observedWorkCommit: r.observedWorkCommit, resultPath: r.resultPath, superseded: r.superseded ?? false, decidedAtSeq: r.decidedAtSeq })),
        rejected: rejected.filter((r) => jobNodeIds.has(r.nodeId)).map((r) => ({ nodeId: r.nodeId, attemptId: r.attemptId, reason: (r as { reason?: unknown }).reason ?? (r as { failureClass?: unknown }).failureClass ?? "rejected", atSeq: r.atSeq })),
        candidates: [] as unknown[], // v1: candidate index not separately tracked in the control-log; viz renders from attempts
        peerLate: 0,
      },
    });

    // budget.json — cost visibility.
    out.push({
      relPath: `jobs/${jobId}/budget.json`,
      json: {
        jobBudget: { maxTotalAttempts: plan.jobBudget.maxTotalAttempts, maxWallClockSec: plan.jobBudget.maxWallClockSec, maxModelUsd: (plan.jobBudget as { maxModelUsd?: number | null }).maxModelUsd ?? null },
        used: { totalAttempts: usage.totalAttempts, wallClockSec: usage.wallClockSec, modelUsd: null },
        perNode: plan.nodes.map((n) => {
          const na = byNode.get(n.nodeId) ?? [];
          const retriesUsed = na.reduce((m, a) => Math.max(m, a.retriesUsed), 0);
          return { nodeId: n.nodeId, attempts: na.length, retriesUsed, retryBudget: n.retryBudget };
        }),
      },
    });
  }
  return out;
}

/** Write every projection file atomically (temp+rename per file, C-3). meta.json is written LAST — its lastAppliedSeq is
 *  the consistency marker, so it only advances once all data files for this seq are on disk. v1 overwrites in place and
 *  does not prune files for a removed job/node (a follow-up); a stale file is harmless to the defensive consumer. */
export function writeProjection(dir: string, state: LogState, opts: ProjectOpts): void {
  const files = buildProjectionFiles(state, opts);
  const ordered = [...files.filter((f) => f.relPath !== "meta.json"), ...files.filter((f) => f.relPath === "meta.json")];
  for (const f of ordered) {
    const abs = path.join(dir, f.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(f.json, null, 2), { mode: 0o644 });
    renameSync(tmp, abs);
  }
}
