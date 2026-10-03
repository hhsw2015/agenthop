// Write a PROJECTION-shaped fixture so the task-logical (DAG) view can be built and tested before the
// brain actually writes a projection. Same discipline as control-samples: build against the frozen
// schema, prove the render path, light up for real when the projection lands.
//
//   tsx scripts/swarm-projection-fixture.ts [--dir <path>]   # default: ~/.agenthop/swarm/projection-sample
//   tsx scripts/swarm-projection-fixture.ts --clean [--dir <path>]
//
// Writes to a SEPARATE dir (projection-sample), never the real projection/, so it cannot be mistaken for
// authoritative data. Point the exporter at it with SWARM_PROJECTION_DIR.
//
// The job models the shape the brain is for: one goal fanned out to parallel workers, coordinated by a
// fan-in integration node, with a review and a repair branch — and deliberately includes the two states a
// viewer most needs to see honestly: a node still awaiting validation (claimed ≠ accepted) and a node that
// was accepted but whose upstream was superseded (SUCCEEDED but complete=false → "was green, now stale").
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function targetDir(): string {
  const i = process.argv.indexOf("--dir");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return path.join(homedir(), ".agenthop", "swarm", "projection-sample");
}

function writeJson(file: string, obj: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  // Mirror the projection's atomic-rename discipline even in the fixture.
  rmSync(file, { force: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  rmSync(tmp, { force: true });
}

const JOB = "job-demo";

/** nodeId -> its attempt record. Hand-shaped so the view exercises every case that must be visible. */
function build(dir: string): void {
  const now = Math.floor(Date.now() / 1000);
  const jobDir = path.join(dir, "jobs", JOB);

  writeJson(path.join(dir, "meta.json"), { schemaVersion: 1, lastAppliedSeq: 128, rebuiltAt: now });

  // DAG: C (shared context) -> {P, Q, R} parallel work -> I integration -> V review ; D is a repair
  // spun off a failed path. Parallelism = P/Q/R share a layer; coordination = I fans them in.
  writeJson(path.join(jobDir, "plan.json"), {
    jobId: JOB,
    planRevision: 4,
    planDigest: "demo",
    jobStatus: "running",
    jobStatusNote: "waiting on I (2 of 3 inputs accepted)",
    nodes: [
      { nodeId: "C", kind: "work", goal: "establish shared context", dependsOn: [], required: true, runtime: "durable" },
      { nodeId: "P", kind: "work", goal: "implement module A", dependsOn: ["C"], required: true, runtime: "ephemeral" },
      { nodeId: "Q", kind: "work", goal: "implement module B", dependsOn: ["C"], required: true, runtime: "ephemeral" },
      { nodeId: "R", kind: "work", goal: "implement module C", dependsOn: ["C"], required: false, runtime: "ephemeral" },
      { nodeId: "I", kind: "integration", goal: "integrate A+B+C", dependsOn: ["P", "Q", "R"], required: true, runtime: "ephemeral" },
      { nodeId: "V", kind: "review", goal: "adversarial review of the integration", dependsOn: ["I"], required: true, runtime: "durable" },
      { nodeId: "D", kind: "repair", goal: "repair the Q/R integration conflict", dependsOn: ["Q", "R"], required: false, runtime: "ephemeral" },
    ],
  });

  const attempt = (nodeId: string, cur: Record<string, unknown>, history: unknown[] = []) =>
    writeJson(path.join(jobDir, "attempts", `${nodeId}.json`), { nodeId, current: cur, history });

  // C: done cleanly, run by a DURABLE member (an employee holds the shared-context task).
  attempt("C", {
    attemptId: `${JOB}/C/a1`, status: "SUCCEEDED", statusNote: "accepted", complete: true, role: "context-owner",
    executionBindings: [{ bindingId: `${JOB}/C/a1/b0`, executor: { kind: "member", memberId: "claude:Work-20cab0a5", publishKey: "dm-7a31" }, state: "closed" }],
  });
  // P: done, run by an outsourced box.
  attempt("P", {
    attemptId: `${JOB}/P/a1`, status: "SUCCEEDED", statusNote: "accepted", complete: true, role: "worker",
    inputBindings: [{ depNodeId: "C", acceptedResultId: `${JOB}/C/a1/r1` }],
    executionBindings: [{ bindingId: `${JOB}/P/a1/b0`, executor: { kind: "box", launchId: "rw-5a3f0001" }, publishGeneration: 0, state: "closed" }],
  });
  // Q: WORKER CLAIMS DONE, NOT YET ACCEPTED — the two-layer-validation case that must be visually distinct.
  attempt("Q", {
    attemptId: `${JOB}/Q/a2`, status: "RESULT_PENDING_VALIDATION", statusNote: "worker self-reported done; awaiting validation", complete: false, role: "worker", retriesUsed: 1,
    inputBindings: [{ depNodeId: "C", acceptedResultId: `${JOB}/C/a1/r1` }],
    executionBindings: [{ bindingId: `${JOB}/Q/a2/b1`, executor: { kind: "box", launchId: "rw-5a3f0002" }, publishGeneration: 1, continuationOf: `${JOB}/Q/a1/b0`, state: "open" }],
  }, [{ attemptId: `${JOB}/Q/a1`, status: "ABANDONED", failureClass: "transient-infra" }]);
  // R: WAS GREEN, NOW STALE — accepted once, but its upstream was superseded. SUCCEEDED && complete=false.
  attempt("R", {
    attemptId: `${JOB}/R/a1`, status: "SUCCEEDED", statusNote: "accepted, but an upstream was superseded — pending rerun", complete: false, role: "worker",
    inputBindings: [{ depNodeId: "C", acceptedResultId: `${JOB}/C/a1/r0` }],
    executionBindings: [{ bindingId: `${JOB}/R/a1/b0`, executor: { kind: "box", launchId: "rw-5a3f0003" }, publishGeneration: 0, state: "closed" }],
  });
  // I: blocked, waiting on its inputs — running now, two of three accepted.
  attempt("I", {
    attemptId: `${JOB}/I/a1`, status: "RUNNING", statusNote: "integrating; R not yet re-accepted", complete: false, role: "integrator",
    inputBindings: [
      { depNodeId: "P", acceptedResultId: `${JOB}/P/a1/r1` },
      { depNodeId: "Q", acceptedResultId: `${JOB}/Q/a2/r1` },
    ],
    executionBindings: [{ bindingId: `${JOB}/I/a1/b0`, executor: { kind: "box", launchId: "rw-5a3f0006" }, publishGeneration: 0, state: "open" }],
  });
  // D: a repair node that FAILED — the honest "this split needs a human" signal.
  attempt("D", {
    attemptId: `${JOB}/D/a2`, status: "FAILED", statusNote: "repair exhausted its retry budget", complete: false, role: "repair", retriesUsed: 2, failureClass: "business-fail",
    executionBindings: [{ bindingId: `${JOB}/D/a2/b0`, executor: { kind: "box", launchId: "rw-5a3f000b" }, publishGeneration: 0, state: "closed" }],
  }, [{ attemptId: `${JOB}/D/a1`, status: "FAILED", failureClass: "business-fail" }]);
  // V: not started yet — no attempt file at all (blocked by I). Intentionally omitted.

  writeJson(path.join(jobDir, "results.json"), {
    accepted: [
      { acceptedResultId: `${JOB}/C/a1/r1`, nodeId: "C", attemptId: `${JOB}/C/a1`, superseded: false, decidedAtSeq: 40 },
      { acceptedResultId: `${JOB}/P/a1/r1`, nodeId: "P", attemptId: `${JOB}/P/a1`, superseded: false, decidedAtSeq: 55 },
      { acceptedResultId: `${JOB}/R/a1/r1`, nodeId: "R", attemptId: `${JOB}/R/a1`, superseded: true, decidedAtSeq: 48 },
    ],
    rejected: [{ nodeId: "D", attemptId: `${JOB}/D/a2`, reason: "contract", atSeq: 120 }],
    candidates: [{ nodeId: "Q", attemptId: `${JOB}/Q/a2`, note: "awaiting validation" }],
    peerLate: 1,
  });

  writeJson(path.join(jobDir, "budget.json"), {
    jobBudget: { maxTotalAttempts: 20, maxWallClockSec: 14400, maxModelUsd: null },
    used: { totalAttempts: 9, wallClockSec: 6300, modelUsd: null },
    perNode: [
      { nodeId: "Q", attempts: 2, retriesUsed: 1, retryBudget: 2 },
      { nodeId: "D", attempts: 2, retriesUsed: 2, retryBudget: 2 },
    ],
  });

  writeJson(path.join(dir, "members.json"), {
    members: [
      { memberId: "claude:Work-20cab0a5", class: "durable", visibility: "visible", reachability: "ok", role: "context-owner", activeBindings: [`${JOB}/C/a1/b0`] },
      { memberId: "claude:agenthop-90b58f9c", class: "durable", visibility: "visible", reachability: "ok", role: "observer", activeBindings: [] },
    ],
  });
}

function main(): void {
  const dir = targetDir();
  if (process.argv.includes("--clean")) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`removed ${dir}`);
    return;
  }
  build(dir);
  console.log(`wrote projection fixture to ${dir}`);
  console.log(`point the exporter at it:  SWARM_PROJECTION_DIR=${dir} tsx scripts/swarm-viz-export.ts`);
}

main();
