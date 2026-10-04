import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { commit, entityKeyOf, initialLogState, type ChangeBody, type LogState, type WaitRecord } from "../src/swarm/control-log.js";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import type { TaskAttempt } from "../src/swarm/task-state.js";
import type { AcceptedResult } from "../src/swarm/task-result.js";
import { buildProjectionFiles, writeProjection } from "../src/swarm/projection.js";

function planOf(jobId: string, nodeId: string, over: { maxWallClockSec?: number; maxTotalAttempts?: number } = {}): TaskPlan {
  const r = loadPlan({
    jobId, planRevision: 1,
    nodes: [{ nodeId, kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }],
    jobBudget: { maxTotalAttempts: over.maxTotalAttempts ?? 10, maxWallClockSec: over.maxWallClockSec ?? 3600 },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

/** projection-schema v1 (docs/swarm/projection-schema.md): the read-only consumer view derived PURELY from the control-log
 *  via the authoritative deciders — jobStatus + complete come from the reducer, never self-computed (C-1 / viz-gap 1). */

function plan1(): TaskPlan {
  const r = loadPlan({
    jobId: "job-x", planRevision: 1,
    nodes: [{ nodeId: "build", kind: "work", goal: "build it", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }],
    jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 3600 },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}
function stamp(state: LogState, bodies: ChangeBody[]): LogState {
  const changes = bodies.map((b) => { const k = entityKeyOf(b); const rev = state.revisions[k] ?? 0; return { ...b, operationId: `${k}#${rev + 1}`, expectedEntityRevision: rev }; });
  return commit(state, state.seq, changes).state;
}
const attempt = (over: Partial<TaskAttempt>): TaskAttempt => ({
  attemptId: "job-x/build/a1", jobId: "job-x", planRevision: 1, nodeId: "build", status: "RUNNING",
  inputBindings: [], inputBindingDigest: "d", specDigest: "s",
  executionBindings: [{ bindingId: "job-x/build/a1/b0", assignmentId: "rw-1@build", launchId: "rw-1", publishGeneration: 1, openedAtSeq: 1 }],
  retriesUsed: 0, createdAtSeq: 1, ...over,
});
const acc = (over: Partial<AcceptedResult>): AcceptedResult => ({
  acceptedResultId: "job-x/build/a1/r1", attemptId: "job-x/build/a1", nodeId: "build", jobId: "job-x", planRevision: 1,
  observedWorkCommit: "c0ffee", resultPath: "out/results/job-x/build/a1/result.json", resultBlobOid: "blob",
  resultClosureDigest: "cd", inputBindingDigest: "d", validatorVersion: "v1", decision: "accepted", decidedAtSeq: 2, ...over,
});
const planBody = (p: TaskPlan): ChangeBody => ({ put: "plan", plan: p } as unknown as ChangeBody);
const byPath = (files: ReturnType<typeof buildProjectionFiles>, rel: string): any => files.find((f) => f.relPath === rel)?.json; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("buildProjectionFiles", () => {
  test("running job ⇒ meta + plan(running) + attempt(RUNNING, complete=false) + budget usage", () => {
    const p = plan1();
    let s = initialLogState();
    s = stamp(s, [planBody(p)]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ specDigest: p.nodes[0]!.specDigest }) }]);
    const files = buildProjectionFiles(s, { nowSec: 1000, jobStartSec: () => 400 });
    expect(byPath(files, "meta.json")).toMatchObject({ schemaVersion: 1, lastAppliedSeq: s.seq });
    expect(byPath(files, "jobs/job-x/plan.json")).toMatchObject({ jobId: "job-x", jobStatus: "running", nodes: [{ nodeId: "build", required: true, runtime: "ephemeral" }] });
    const att = byPath(files, "jobs/job-x/attempts/build.json");
    expect(att.current.status).toBe("RUNNING");
    expect(att.current.complete).toBe(false); // AUTHORITATIVE — no accepted yet
    expect(att.current.executionBindings[0]).toMatchObject({ executor: { kind: "box", launchId: "rw-1" }, state: "open" });
    expect(byPath(files, "jobs/job-x/budget.json")).toMatchObject({ used: { totalAttempts: 1, wallClockSec: 600, modelUsd: null }, perNode: [{ nodeId: "build", attempts: 1 }] });
  });

  test("an accepted result ⇒ jobStatus succeeded + complete=true + results.accepted (SUCCEEDED⇔accepted)", () => {
    const p = plan1();
    let s = initialLogState();
    s = stamp(s, [planBody(p)]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ status: "SUCCEEDED", specDigest: p.nodes[0]!.specDigest }) }]);
    s = stamp(s, [{ put: "accepted", accepted: acc({}) }]);
    const files = buildProjectionFiles(s, { nowSec: 1000 });
    expect(byPath(files, "jobs/job-x/plan.json").jobStatus).toBe("succeeded"); // reducer-derived, not self-computed
    expect(byPath(files, "jobs/job-x/attempts/build.json").current.complete).toBe(true);
    expect(byPath(files, "jobs/job-x/results.json").accepted).toHaveLength(1);
    expect(byPath(files, "jobs/job-x/results.json").accepted[0]).toMatchObject({ nodeId: "build", superseded: false });
  });

  test("writeProjection writes atomic files; meta.lastAppliedSeq matches; valid JSON on disk", () => {
    const p = plan1();
    let s = initialLogState();
    s = stamp(s, [planBody(p)]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ specDigest: p.nodes[0]!.specDigest }) }]);
    const dir = mkdtempSync(path.join(tmpdir(), "proj-"));
    writeProjection(dir, s, { nowSec: 1000, jobStartSec: () => 400 });
    expect(JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")).lastAppliedSeq).toBe(s.seq);
    expect(JSON.parse(readFileSync(path.join(dir, "jobs/job-x/plan.json"), "utf8")).jobId).toBe("job-x");
    expect(existsSync(path.join(dir, "jobs/job-x/attempts/build.json"))).toBe(true);
    expect(existsSync(path.join(dir, "jobs/job-x/results.json"))).toBe(true);
  });
});

describe("projection review fixes", () => {
  test("P1-1: a traversal nodeId is REJECTED fail-closed — the job emits nothing, no escaping relPath, nothing written outside root", () => {
    const evil = planOf("safe-job", "../../../../control-log/42");
    let s = initialLogState();
    s = stamp(s, [planBody(evil)]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ jobId: "safe-job", nodeId: "../../../../control-log/42", attemptId: "safe-job/x/a1", specDigest: evil.nodes[0]!.specDigest }) }]);
    const files = buildProjectionFiles(s, { nowSec: 1000 });
    expect(files.some((f) => f.relPath.includes("safe-job"))).toBe(false);          // whole job skipped
    expect(files.every((f) => !f.relPath.includes("..") && !f.relPath.includes("control-log"))).toBe(true);
    const base = mkdtempSync(path.join(tmpdir(), "p1esc-"));
    writeFileSync(path.join(base, "sentinel"), "ORIGINAL");
    writeProjection(path.join(base, "projection"), s, { nowSec: 1000 });
    expect(readFileSync(path.join(base, "sentinel"), "utf8")).toBe("ORIGINAL");      // no escaping write
    expect(existsSync(path.join(base, "control-log"))).toBe(false);                  // the attack target was never created
  });

  test("P1-2: job isolation — A does NOT borrow B's accepted (no false complete) nor B's attempt in its budget", () => {
    const a = planOf("jobA", "build");
    const b = planOf("jobB", "build"); // same nodeId + identical spec ⇒ same specDigest
    let s = initialLogState();
    s = stamp(s, [planBody(a)]);
    s = stamp(s, [planBody(b)]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ jobId: "jobB", nodeId: "build", attemptId: "jobB/build/a1", status: "SUCCEEDED", specDigest: b.nodes[0]!.specDigest }) }]);
    s = stamp(s, [{ put: "accepted", accepted: acc({ acceptedResultId: "jobB/build/a1/r1", attemptId: "jobB/build/a1", nodeId: "build", jobId: "jobB" }) }]);
    const files = buildProjectionFiles(s, { nowSec: 1000, jobStartSec: () => 400 });
    expect(byPath(files, "jobs/jobA/plan.json").jobStatus).toBe("running");   // NOT succeeded off B's accepted
    expect(byPath(files, "jobs/jobB/plan.json").jobStatus).toBe("succeeded");
    expect(files.some((f) => f.relPath === "jobs/jobA/attempts/build.json")).toBe(false); // A has no attempt (B's not borrowed)
    expect(byPath(files, "jobs/jobA/budget.json").used.totalAttempts).toBe(0);  // B's attempt not counted in A
    expect(byPath(files, "jobs/jobB/budget.json").used.totalAttempts).toBe(1);
  });

  test("§8c: a wait entity ⇒ waits/<waitId>.json emitted as-is (full WaitRecord)", () => {
    const w: WaitRecord = { waitId: "coord-x", kind: "wait", subject: { jobId: "j" }, state: "open", deadlineSec: 5000, owner: "claude:owner", timeoutPolicy: "bypass" };
    let s = initialLogState();
    s = stamp(s, [{ put: "wait", wait: w }]);
    const files = buildProjectionFiles(s, { nowSec: 1000 });
    expect(byPath(files, "waits/coord-x.json")).toEqual(w); // as-is, all fields
  });

  test("§8b: results.observed[] carries recent ResultObserved per attempt (commit/path trajectory)", () => {
    const p = planOf("job-o", "build");
    let s = initialLogState();
    s = stamp(s, [planBody(p)]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ jobId: "job-o", nodeId: "build", attemptId: "job-o/build/a1", specDigest: p.nodes[0]!.specDigest }) }]);
    s = stamp(s, [{ put: "observed", observed: { observedId: "job-o/build/a1/g1/c1", attemptId: "job-o/build/a1", nodeId: "build", bindingId: "job-o/build/a1/b0", launchId: "rw-1", generation: 1, observedWorkCommit: "c1", resultPath: "out/results/job-o/build/a1/result.json", resultBlobOid: "b1", closureFiles: [] } }]);
    const results = byPath(buildProjectionFiles(s, { nowSec: 1000 }), "jobs/job-o/results.json");
    expect(results.observed).toHaveLength(1);
    expect(results.observed[0]).toMatchObject({ attemptId: "job-o/build/a1", observedWorkCommit: "c1", generation: 1 });
  });

  test("P2-2: a rebuild to an older snapshot PRUNES a stale attempt file (no lingering SUCCEEDED)", () => {
    const p = planOf("job-x", "build");
    // newer snapshot: plan + a SUCCEEDED attempt ⇒ attempts/build.json written
    let s3 = initialLogState();
    s3 = stamp(s3, [planBody(p)]);
    s3 = stamp(s3, [{ put: "attempt", attempt: attempt({ jobId: "job-x", nodeId: "build", attemptId: "job-x/build/a1", status: "SUCCEEDED", specDigest: p.nodes[0]!.specDigest }) }]);
    const dir = mkdtempSync(path.join(tmpdir(), "p22-"));
    writeProjection(dir, s3, { nowSec: 1000 });
    expect(existsSync(path.join(dir, "jobs/job-x/attempts/build.json"))).toBe(true);
    // rebuild to an older snapshot: plan only, no attempt ⇒ the stale attempt file must be pruned
    let s1 = initialLogState();
    s1 = stamp(s1, [planBody(p)]);
    writeProjection(dir, s1, { nowSec: 1000 });
    expect(existsSync(path.join(dir, "jobs/job-x/attempts/build.json"))).toBe(false); // pruned, not a lingering SUCCEEDED
  });

  test("P2-1 now-dependency: the same state recomputes a wall-clock-exhausted job as failed (per-tick refresh maintains it)", () => {
    const p = planOf("job-x", "build", { maxWallClockSec: 100 });
    let s = initialLogState();
    s = stamp(s, [planBody(p)]);
    s = stamp(s, [{ put: "attempt", attempt: attempt({ jobId: "job-x", nodeId: "build", attemptId: "job-x/build/a1", status: "RUNNING", specDigest: p.nodes[0]!.specDigest }) }]);
    const early = byPath(buildProjectionFiles(s, { nowSec: 450, jobStartSec: () => 400 }), "jobs/job-x/plan.json"); // wall 50 < 100
    const late = byPath(buildProjectionFiles(s, { nowSec: 550, jobStartSec: () => 400 }), "jobs/job-x/plan.json");  // wall 150 >= 100
    expect(early.jobStatus).toBe("running");
    expect(late.jobStatus).toBe("failed"); // now-dependent — only a per-tick refresh (not commit-only) keeps this current
  });

  test("re-review P1: prune does NOT follow a directory symlink out of root (no out-of-root delete)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "psym-"));
    const root = path.join(base, "projection");
    const external = path.join(base, "external");
    mkdirSync(external, { recursive: true });
    writeFileSync(path.join(external, "42.json"), "AUTHORITATIVE");
    mkdirSync(path.join(root, "jobs"), { recursive: true });
    symlinkSync(external, path.join(root, "jobs", "external")); // planted directory symlink inside projection/jobs/
    writeProjection(root, initialLogState(), { nowSec: 1000 });  // prune must NOT traverse the link
    expect(readFileSync(path.join(external, "42.json"), "utf8")).toBe("AUTHORITATIVE"); // intact
  });

  test("re-review P1: writer REFUSES to write through a symlinked ancestor (throws, no out-of-root write)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "pwsym-"));
    const root = path.join(base, "projection");
    const external = path.join(base, "external-job");
    mkdirSync(external, { recursive: true });
    mkdirSync(path.join(root, "jobs"), { recursive: true });
    symlinkSync(external, path.join(root, "jobs", "safe-job")); // jobs/safe-job → outside the root
    const p = planOf("safe-job", "build");
    let s = initialLogState(); s = stamp(s, [planBody(p)]);
    expect(() => writeProjection(root, s, { nowSec: 1000 })).toThrow(); // must refuse the symlinked ancestor
    expect(existsSync(path.join(external, "plan.json"))).toBe(false);   // nothing escaped
  });

  test("re-review P1 (temp symlink): an unpredictable temp name defeats a symlink pre-planted at the OLD predictable path", () => {
    const base = mkdtempSync(path.join(tmpdir(), "ptmp-"));
    const root = path.join(base, "projection");
    mkdirSync(root, { recursive: true });
    const external = path.join(base, "external.json");
    writeFileSync(external, JSON.stringify({ marker: "authority" }));
    symlinkSync(external, path.join(root, `members.json.tmp.${process.pid}`)); // the OLD predictable temp path
    writeProjection(root, initialLogState(), { nowSec: 1000 });
    expect(JSON.parse(readFileSync(external, "utf8")).marker).toBe("authority");            // NOT overwritten (random temp used)
    expect(JSON.parse(readFileSync(path.join(root, "members.json"), "utf8"))).toMatchObject({ members: [] }); // real file written
  });

  test("L1b/P2-1: meta.json carries livenessVerdict WITH its freshness window when provided, omits it otherwise (§1c/§1d)", () => {
    let s = initialLogState(); s = stamp(s, [planBody(plan1())]);
    const withV = byPath(buildProjectionFiles(s, { nowSec: 1000, livenessVerdict: { verdict: "STALL", why: "no holder" }, livenessValidForSec: 200 }), "meta.json");
    // §1c: the verdict is published WITH cutSeq + sample time + validUntilSec so a consumer expires a stale OK (review P2-1).
    expect(withV.livenessVerdict).toMatchObject({ verdict: "STALL", why: "no holder", cutSeq: s.seq, sampledAtSec: 1000, validUntilSec: 1200 });
    const dflt = byPath(buildProjectionFiles(s, { nowSec: 1000, livenessVerdict: { verdict: "OK" } }), "meta.json");
    expect(dflt.livenessVerdict.validUntilSec).toBe(1000 + 120); // default evidence window when the caller omits one
    const without = byPath(buildProjectionFiles(s, { nowSec: 1000 }), "meta.json");
    expect("livenessVerdict" in without).toBe(false);
  });

  test("re-review P2b: a waitId containing '/' is projected under a percent-encoded flat filename (not dropped)", () => {
    const w: WaitRecord = { waitId: "w/r-123abc", kind: "wait", subject: { jobId: "j" }, state: "open", deadlineSec: 5000, owner: "claude:owner", timeoutPolicy: "escalate" };
    let s = initialLogState(); s = stamp(s, [{ put: "wait", wait: w }]);
    const wf = buildProjectionFiles(s, { nowSec: 1000 }).find((f) => f.relPath.startsWith("waits/"));
    expect(wf?.relPath).toBe("waits/w%2Fr-123abc.json"); // "/" → %2F (standard UTF-8 percent-encoding), flat, collision-free
    expect(wf?.json).toEqual(w);                          // content as-is (real waitId preserved)
    let s2 = initialLogState(); s2 = stamp(s2, [{ put: "wait", wait: { ...w, waitId: "coord-x" } }]);
    expect(buildProjectionFiles(s2, { nowSec: 1000 }).some((f) => f.relPath === "waits/coord-x.json")).toBe(true); // safe id = identity (viz-compat)
    let s3 = initialLogState(); s3 = stamp(s3, [{ put: "wait", wait: { ...w, waitId: "../../etc" } }]);
    expect(buildProjectionFiles(s3, { nowSec: 1000 }).some((f) => f.relPath.startsWith("waits/"))).toBe(false); // real traversal rejected
  });

  test("re-review P2-2: encoding is collision-free (UTF-8) — 'w-€' and 'w- ac' map to DISTINCT files, neither overwritten", () => {
    const mk = (id: string): WaitRecord => ({ waitId: id, kind: "wait", subject: { jobId: "j" }, state: "open", deadlineSec: 5000, owner: "o", timeoutPolicy: "bypass" });
    let s = initialLogState();
    s = stamp(s, [{ put: "wait", wait: mk("w-€") }]); // € = U+20AC (one UTF-16 unit 0x20ac)
    s = stamp(s, [{ put: "wait", wait: mk("w- ac") }]);    // space (0x20) + literal "ac" — collided to %20ac under charCodeAt-hex
    const waitFiles = buildProjectionFiles(s, { nowSec: 1000 }).filter((f) => f.relPath.startsWith("waits/"));
    const paths = waitFiles.map((f) => f.relPath);
    expect(new Set(paths).size).toBe(2); // two DISTINCT filenames — no collision, neither wait silently dropped
    expect(paths).toContain(`waits/${encodeURIComponent("w-€")}.json`);
    expect(paths).toContain(`waits/${encodeURIComponent("w- ac")}.json`);
    for (const f of waitFiles) // the filename round-trips back to the real waitId (shared decode contract)
      expect(decodeURIComponent(f.relPath.slice("waits/".length, -".json".length))).toBe((f.json as WaitRecord).waitId);
  });

  test("re-review P2a: a prune unlink failure (EACCES) throws — meta is NOT certified over stale state", () => {
    const p = planOf("job-x", "build");
    let s3 = initialLogState();
    s3 = stamp(s3, [planBody(p)]);
    s3 = stamp(s3, [{ put: "attempt", attempt: attempt({ jobId: "job-x", nodeId: "build", attemptId: "job-x/build/a1", status: "SUCCEEDED", specDigest: p.nodes[0]!.specDigest }) }]);
    const dir = mkdtempSync(path.join(tmpdir(), "peacc-"));
    writeProjection(dir, s3, { nowSec: 1000 }); // attempts/build.json written; meta=s3.seq
    const attemptsDir = path.join(dir, "jobs/job-x/attempts");
    chmodSync(attemptsDir, 0o500); // read-only dir ⇒ unlink inside fails EACCES
    let s1 = initialLogState(); s1 = stamp(s1, [planBody(p)]); // no attempt ⇒ prune would unlink build.json
    let threw = false;
    try { writeProjection(dir, s1, { nowSec: 1000 }); } catch { threw = true; } finally { chmodSync(attemptsDir, 0o700); }
    if (!threw) return; // running as root ignores the mode — can't exercise EACCES here
    expect(existsSync(path.join(attemptsDir, "build.json"))).toBe(true);                                // stale NOT removed
    expect(JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")).lastAppliedSeq).toBe(s3.seq);  // meta NOT advanced
  });
});
