import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commit, entityKeyOf, initialLogState, type ChangeBody, type LogState } from "../src/swarm/control-log.js";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import type { TaskAttempt } from "../src/swarm/task-state.js";
import type { AcceptedResult } from "../src/swarm/task-result.js";
import { buildProjectionFiles, writeProjection } from "../src/swarm/projection.js";

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
