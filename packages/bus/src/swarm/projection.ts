/**
 * Projection writer (projection-schema v1 — docs/swarm/projection-schema.md, authoritative SHA 4fa06522 incl. §8b/§8c).
 * The READ-ONLY consumer view of swarm state for swarm-viz + fast dispatcher startup. PURE derivation from the control-log
 * LogState via the AUTHORITATIVE deciders (jobStatus / currentAccepted), so a consumer never re-implements the reducer (C-1)
 * and never self-computes a cascaded judgment (complete / jobStatus) that would drift (viz-gap 1). CONTROL is authoritative;
 * a lost/corrupt projection is rebuilt by replay (§8). The IO half (atomic temp+rename per file + prune, C-3) is below.
 *
 * SECURITY (review P1-1): jobId / nodeId / waitId become PATH SEGMENTS — a `../` id is an arbitrary-write escape from the
 * read-only view. Every id is whitelist-validated; a job with ANY unsafe id emits NOTHING (fail-closed), and the writer
 * refuses any path that resolves outside the projection root (belt-and-suspenders).
 *
 * DATA DOMAIN (review P1-2): each job's files are derived from its OWN attempts/accepted/rejected/observed, isolated by
 * jobId BEFORE the deciders — the authoritative algorithm cannot fix a wrong-domain input (cross-job false complete/budget).
 *
 * Scope: meta + jobs/<jobId>/{plan,attempts/<nodeId>,results,budget} + waits/<waitId> (§8c) + results.observed[] (§8b).
 * Deferred (entity fields not yet persisted, documented not faked): role (assignment text, viz-gap 4), §8b decidedBy /
 * supersededBy / members.runDrift. members.json is an EMPTY placeholder — the durable roster is the bus peers() view the
 * control-log does not hold; viz fills live members from its own peers() merge (§6). jobs/* require an actual PlanPut in
 * CONTROL (not merely a SWARM_PLAN file).
 */

import { mkdirSync, writeFileSync, renameSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import { liveEntities, type LogState, type WaitRecord, type ResultObserved } from "./control-log.js";
import type { TaskPlan } from "./task-plan.js";
import type { TaskAttempt, ExecutionBinding } from "./task-state.js";
import type { AcceptedResult } from "./task-result.js";
import { jobStatus, currentAccepted, type SchedInput, type JobUsage } from "./task-ready.js";

export const PROJECTION_SCHEMA_VERSION = 1;

export type ProjectionFile = { relPath: string; json: unknown };
export type ProjectOpts = { nowSec: number; jobStartSec?: (jobId: string) => number | undefined };

const HISTORY_MAX = 8;   // Open question 1: last 8 attempts + count.
const OBSERVED_MAX = 8;  // §8b observed[]: recent N per attempt.

/** A path segment is SAFE iff it is a non-empty run of [A-Za-z0-9._-] and not "." / ".." — no separators, no traversal. */
const SAFE_SEG = /^[A-Za-z0-9._-]+$/;
const isSafeSeg = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s !== "." && s !== ".." && SAFE_SEG.test(s);

const bindingState = (b: ExecutionBinding): "open" | "closing" | "closed" =>
  b.closedAtSeq !== undefined ? "closed" : b.closing !== undefined ? "closing" : "open";

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
    role: null, // deferred: the assignment role text is not persisted in the control-log (viz-gap 4) — nullable until it is.
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
  // members.json — empty placeholder (v1): the durable roster is the bus peers() view, not control-log data; viz merges it
  // (schema §6). NOT written by the dispatcher from a roster in this batch; do not read this as "the roster is wired".
  out.push({ relPath: "members.json", json: { members: [] as unknown[] } });

  const plans: TaskPlan[] = [];
  const attempts: TaskAttempt[] = [];
  const accepted: AcceptedResult[] = [];
  const rejected: Array<{ nodeId: string; attemptId: string; atSeq: number; reason?: unknown }> = [];
  const observed: ResultObserved[] = [];
  const waits: WaitRecord[] = [];
  for (const body of Object.values(liveEntities(state))) {
    if (body.put === "plan") plans.push(body.plan as unknown as TaskPlan);
    else if (body.put === "attempt") attempts.push(body.attempt);
    else if (body.put === "accepted") accepted.push(body.accepted);
    else if (body.put === "rejected") rejected.push(body.rejected as unknown as { nodeId: string; attemptId: string; atSeq: number });
    else if (body.put === "observed") observed.push(body.observed);
    else if (body.put === "wait") waits.push(body.wait);
  }

  // §8c — waits/<waitId>.json: the WaitRecord current state, AS-IS (all fields; optional A1 budget fields pass through).
  for (const w of waits) {
    if (!isSafeSeg(w.waitId)) continue; // unsafe id ⇒ no file (P1-1)
    out.push({ relPath: `waits/${w.waitId}.json`, json: w });
  }

  for (const plan of plans) {
    const jobId = plan.jobId;
    // P1-1: reject the WHOLE job if its jobId or ANY nodeId is not a safe path segment — fail-closed, emit nothing for it.
    if (!isSafeSeg(jobId) || !plan.nodes.every((n) => isSafeSeg(n.nodeId))) continue;

    // P1-2: isolate this job's data BEFORE the deciders. attemptId convention is `${jobId}/${nodeId}/a${n}`, so the prefix
    // isolates rejected/observed that lack a jobId field; accepted carries jobId directly.
    const inJob = (attemptId: string): boolean => attemptId.startsWith(`${jobId}/`);
    const jobAttempts = attempts.filter((a) => a.jobId === jobId);
    const jobAccepted = accepted.filter((r) => r.jobId === jobId);
    const jobRejected = rejected.filter((r) => inJob(r.attemptId));
    const jobObserved = observed.filter((o) => inJob(o.attemptId));
    const sched: SchedInput = { plan, attempts: jobAttempts, acceptedResults: jobAccepted };

    const jobStartSec = opts.jobStartSec?.(jobId);
    const wallClockSec = jobStartSec !== undefined ? Math.max(0, opts.nowSec - jobStartSec) : 0;
    const usage: JobUsage = { totalAttempts: jobAttempts.length, wallClockSec };
    const status = jobStatus({ ...sched, now: opts.nowSec, jobUsage: usage });

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

    const byNode = new Map<string, TaskAttempt[]>();
    for (const a of jobAttempts) { const arr = byNode.get(a.nodeId) ?? []; arr.push(a); byNode.set(a.nodeId, arr); }
    for (const node of plan.nodes) {
      const nodeAttempts = (byNode.get(node.nodeId) ?? []).slice().sort((x, y) => x.createdAtSeq - y.createdAtSeq);
      if (nodeAttempts.length === 0) continue;
      const current = nodeAttempts[nodeAttempts.length - 1]!;
      const complete = currentAccepted(node.nodeId, sched) !== null; // AUTHORITATIVE (reducer), over this job's data only
      const history = nodeAttempts.slice(0, -1).slice(-HISTORY_MAX).map((a) => ({ attemptId: a.attemptId, status: a.status, failureClass: a.failureClass ?? null }));
      out.push({ relPath: `jobs/${jobId}/attempts/${node.nodeId}.json`, json: { nodeId: node.nodeId, current: { ...attemptView(current), complete }, history } });
    }

    // §8b — observed[]: recent N ResultObserved per attempt (commit/path trajectory). decidedBy/supersededBy are deferred
    // (not persisted on the accepted/rejected entities yet) — documented, not faked.
    const observedByAttempt = new Map<string, ResultObserved[]>();
    for (const o of jobObserved) { const arr = observedByAttempt.get(o.attemptId) ?? []; arr.push(o); observedByAttempt.set(o.attemptId, arr); }
    const observedSummary = [...observedByAttempt.entries()].flatMap(([attemptId, os]) =>
      os.slice(-OBSERVED_MAX).map((o) => ({ attemptId, observedWorkCommit: o.observedWorkCommit, resultPath: o.resultPath, generation: o.generation })));
    out.push({
      relPath: `jobs/${jobId}/results.json`,
      json: {
        accepted: jobAccepted.map((r) => ({ acceptedResultId: r.acceptedResultId, nodeId: r.nodeId, attemptId: r.attemptId, observedWorkCommit: r.observedWorkCommit, resultPath: r.resultPath, superseded: r.superseded ?? false, decidedAtSeq: r.decidedAtSeq })),
        rejected: jobRejected.map((r) => ({ nodeId: r.nodeId, attemptId: r.attemptId, reason: r.reason ?? (r as { failureClass?: unknown }).failureClass ?? "rejected", atSeq: r.atSeq })),
        candidates: [] as unknown[],
        observed: observedSummary,
        peerLate: 0,
      },
    });

    out.push({
      relPath: `jobs/${jobId}/budget.json`,
      json: {
        jobBudget: { maxTotalAttempts: plan.jobBudget.maxTotalAttempts, maxWallClockSec: plan.jobBudget.maxWallClockSec, maxModelUsd: (plan.jobBudget as { maxModelUsd?: number | null }).maxModelUsd ?? null },
        used: { totalAttempts: usage.totalAttempts, wallClockSec: usage.wallClockSec, modelUsd: null },
        perNode: plan.nodes.map((n) => {
          const na = byNode.get(n.nodeId) ?? [];
          return { nodeId: n.nodeId, attempts: na.length, retriesUsed: na.reduce((m, a) => Math.max(m, a.retriesUsed), 0), retryBudget: n.retryBudget };
        }),
      },
    });
  }
  return out;
}

/** All .json files currently under `dir` (recursive), as dir-relative POSIX paths — for prune (P2-2). Uses lstat and does
 *  NOT follow symlinks (review P1: a directory symlink must never let prune recurse/delete OUTSIDE the root). A vanished
 *  entry/dir (ENOENT, raced) is skipped; any OTHER enumeration error PROPAGATES (review P2a — a readdir/lstat failure must
 *  not be read as "no managed files" and let the writer certify a complete meta). */
function existingJsonFiles(dir: string, rel = ""): string[] {
  let entries: string[];
  try { entries = readdirSync(path.join(dir, rel)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: string[] = [];
  for (const name of entries) {
    const r = rel ? `${rel}/${name}` : name;
    let st;
    try { st = lstatSync(path.join(dir, r)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (st.isSymbolicLink()) continue;                 // never follow a link (P1)
    if (st.isDirectory()) out.push(...existingJsonFiles(dir, r));
    else if (st.isFile() && name.endsWith(".json")) out.push(r);
  }
  return out;
}

/** True iff every EXISTING ancestor of `abs` up to `root` is a real directory (not a symlink) — so a mkdir/write cannot
 *  escape through a planted directory symlink (review P1). A not-yet-created ancestor (ENOENT) is fine (mkdir makes a real
 *  dir); a symlink or any other lstat error is unsafe. */
function ancestorsSafe(root: string, abs: string): boolean {
  let cur = path.dirname(abs);
  while (cur !== root && cur.startsWith(root + path.sep)) {
    try { if (lstatSync(cur).isSymbolicLink()) return false; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; } // ENOENT = will be mkdir'd (safe)
    cur = path.dirname(cur);
  }
  return cur === root;
}

/** Write every projection file atomically (temp+rename, C-3), meta.json LAST (its lastAppliedSeq is the consistency
 *  marker — only advanced once the data files are on disk). PRUNES stale files absent from the new snapshot (P2-2). Any
 *  real error (symlink ancestor, prune/write failure other than a benign ENOENT) THROWS before meta is written, so the
 *  projection is left behind-but-retriable rather than certified complete over corrupt/escaped state (review P1/P2a); the
 *  caller is fail-soft and the next tick retries. */
export function writeProjection(dir: string, state: LogState, opts: ProjectOpts): void {
  const files = buildProjectionFiles(state, opts);
  const root = path.resolve(dir);
  const want = new Set(files.map((f) => f.relPath));

  // Prune first (meta.json is always in `want`). ENOENT on unlink = already gone (OK); any other error propagates (P2a).
  for (const rel of existingJsonFiles(root)) {
    if (want.has(rel)) continue;
    try { unlinkSync(path.join(root, rel)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }

  const ordered = [...files.filter((f) => f.relPath !== "meta.json"), ...files.filter((f) => f.relPath === "meta.json")];
  for (const f of ordered) {
    const abs = path.resolve(root, f.relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`projection: refusing out-of-root path ${f.relPath}`); // lexical guard
    if (!ancestorsSafe(root, abs)) throw new Error(`projection: refusing write through a symlinked ancestor of ${f.relPath}`); // P1: no symlink escape
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(f.json, null, 2), { mode: 0o644 });
    renameSync(tmp, abs);
  }
}
