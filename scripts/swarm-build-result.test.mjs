// Box-side result-merge regression (run: `node --test scripts/swarm-build-result.test.mjs`). Locks the invariant that
// matters for T1 acceptance: identity ALWAYS comes from the assignment (V2 can't be tripped by a lying worker), and a
// missing/garbled report becomes an explicit failure result, never a silent success or a hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultJson } from "./swarm-build-result.mjs";

const ASG = {
  assignmentId: "job/build/a0/b0@asg", jobId: "job", planRevision: 3, nodeId: "build",
  attemptId: "job/build/a0", inputBindingDigest: "ibd-xyz",
};

test("success report: identity from assignment, work parts from report, no failureReason", () => {
  const r = buildResultJson(ASG, {
    outcome: "success",
    outputs: [{ logicalName: "patch", kind: "patch", path: "out/patch.diff" }],
    validationEvidence: [{ check: "tests", exitCode: 0 }],
  });
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.jobId, "job");
  assert.equal(r.planRevision, 3);
  assert.equal(r.nodeId, "build");
  assert.equal(r.attemptId, "job/build/a0");
  assert.equal(r.assignmentId, "job/build/a0/b0@asg");
  assert.equal(r.inputBindingDigest, "ibd-xyz");
  assert.equal(r.outcome, "success");
  assert.equal(r.failureReason, undefined);
  assert.deepEqual(r.outputs, [{ logicalName: "patch", kind: "patch", path: "out/patch.diff" }]);
  assert.deepEqual(r.validationEvidence, [{ check: "tests", exitCode: 0 }]);
});

test("a lying worker cannot forge identity — it is overwritten from the assignment", () => {
  const r = buildResultJson(ASG, { outcome: "success", jobId: "evil", attemptId: "evil/a9", assignmentId: "forged", outputs: [], validationEvidence: [] });
  assert.equal(r.jobId, "job");
  assert.equal(r.attemptId, "job/build/a0");
  assert.equal(r.assignmentId, "job/build/a0/b0@asg");
});

test("failure report keeps the worker's reason", () => {
  const r = buildResultJson(ASG, { outcome: "failure", failureReason: "tests failed", outputs: [], validationEvidence: [] });
  assert.equal(r.outcome, "failure");
  assert.equal(r.failureReason, "tests failed");
});

test("missing report ⇒ explicit failure with a default reason (never a silent success)", () => {
  const r = buildResultJson(ASG, null);
  assert.equal(r.outcome, "failure");
  assert.equal(r.failureReason, "worker produced no usable outcome report");
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(r.validationEvidence, []);
});

test("garbled fields are sanitized: non-array outputs ⇒ [], non-success outcome ⇒ failure", () => {
  const r = buildResultJson(ASG, { outcome: "weird", outputs: "nope", validationEvidence: 5 });
  assert.equal(r.outcome, "failure");
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(r.validationEvidence, []);
  assert.equal(r.failureReason, "worker produced no usable outcome report");
});
