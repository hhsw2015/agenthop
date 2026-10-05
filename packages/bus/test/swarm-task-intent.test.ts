import { describe, expect, test } from "vitest";
import { createAttempt, type InputBinding, type ExecutionBinding, type TaskAttempt } from "../src/swarm/task-state.js";
import type { TaskSpec } from "../src/swarm/task-plan.js";
import { buildAssignment, type Assignment } from "../src/swarm/task-assignment.js";
import { PROVIDER_LIFETIME_SEC } from "../src/swarm/control.js";
import { buildDispatchIntent, resolveAllocOutcome, confirmIntent, abandonIntent, withProviderExpiry } from "../src/swarm/task-intent.js";

/**
 * task-intent — the dispatcher-side construction of the DispatchIntent persisted BEFORE startTask IO (brain §4.3 /
 * §4.5-6, CAS-then-IO). The load-bearing correctness is the physical-occupancy evidence rule (F1/F2): an allocation
 * with NO trustworthy evidence of a physical expiry must leave physicalExpiresAtSec ABSENT ⇒ conservatively counted as
 * occupying indefinitely. A local runScript timeout is NOT evidence; only provider-expiry or a creation-completion
 * bound may set it.
 */

const SPEC: TaskSpec = {
  nodeId: "build", kind: "work", goal: "g", dependsOn: [],
  outputContract: { requiredOutputs: [{ logicalName: "r", kind: "report" }] },
  acceptance: [{ check: "c" }], artifactScope: ["out/"], estimatedRuntimeSec: 1800, retryBudget: 2,
  required: true, runtime: "ephemeral", specDigest: "sd",
};
const BINDING: ExecutionBinding = { bindingId: "job/build/a0/b0", assignmentId: "job/build/a0/b0@asg", launchId: "rw-1", publishGeneration: 0, openedAtSeq: 1 };
const ATTEMPT: TaskAttempt = createAttempt({ jobId: "job", nodeId: "build", n: 0, planRevision: 1, specDigest: "sd", inputBindings: [] as InputBinding[], firstBinding: BINDING, createdAtSeq: 1 });
const ASG: Assignment = buildAssignment({ attempt: ATTEMPT, spec: SPEC, binding: BINDING, remainingLifeSec: 3000, checkpointBudgetSec: 300, handoffMarginSec: 180 });

const TIMING = { allocRequestStartSec: 1000, workDeadlineSec: 1000 + 3480 };

describe("buildDispatchIntent — the pre-IO durable record", () => {
  test("pending/pending, bound to the assignment, no physical evidence yet", () => {
    const i = buildDispatchIntent(ASG, TIMING);
    expect(i.intentId).toBe(ASG.assignmentId);
    expect(i.attemptId).toBe(ASG.attemptId);
    expect(i.nodeId).toBe(ASG.nodeId);
    expect(i.launchId).toBe(ASG.launchId);
    expect(i.bindingId).toBe(ASG.bindingId);
    expect(i.assignmentDigest).toBe(ASG.assignmentDigest);
    expect(i.allocRequestStartSec).toBe(1000);
    expect(i.workDeadlineSec).toBe(4480);
    expect(i.allocOutcome).toBe("pending");
    expect(i.status).toBe("pending");
    expect(i.physicalExpiresAtSec).toBeUndefined();
    expect(i.physicalEvidence).toBeUndefined();
  });
});

describe("resolveAllocOutcome — evidence discipline (F1/F2)", () => {
  const base = buildDispatchIntent(ASG, TIMING);

  test("created ⇒ creation-bound physical expiry = now + PROVIDER_LIFETIME + skew", () => {
    const i = resolveAllocOutcome(base, "created", { nowSec: 2000, skewSec: 120 });
    expect(i.allocOutcome).toBe("created");
    expect(i.physicalEvidence).toBe("creation-bound");
    expect(i.physicalExpiresAtSec).toBe(2000 + PROVIDER_LIFETIME_SEC + 120);
    expect(i.status).toBe("pending"); // full startTask IO confirms later, not here
  });

  test("unknown ⇒ NO physical expiry (conservative indefinite occupancy), stays pending", () => {
    const i = resolveAllocOutcome(base, "unknown", { nowSec: 2000 });
    expect(i.allocOutcome).toBe("unknown");
    expect(i.physicalExpiresAtSec).toBeUndefined();
    expect(i.physicalEvidence).toBeUndefined();
    expect(i.status).toBe("pending");
  });

  test("clean-fail ⇒ reliably not created: no physical expiry", () => {
    const i = resolveAllocOutcome(base, "clean-fail", { nowSec: 2000 });
    expect(i.allocOutcome).toBe("clean-fail");
    expect(i.physicalExpiresAtSec).toBeUndefined();
  });

  test("is immutable — the input intent is untouched", () => {
    resolveAllocOutcome(base, "created", { nowSec: 2000 });
    expect(base.allocOutcome).toBe("pending");
    expect(base.physicalExpiresAtSec).toBeUndefined();
  });
});

describe("withProviderExpiry / status transitions", () => {
  const base = buildDispatchIntent(ASG, TIMING);
  test("withProviderExpiry sets provider-expiry evidence", () => {
    const i = withProviderExpiry(base, 9999);
    expect(i.physicalExpiresAtSec).toBe(9999);
    expect(i.physicalEvidence).toBe("provider-expiry");
  });
  test("confirmIntent ⇒ confirmed, abandonIntent ⇒ abandoned, both immutable", () => {
    expect(confirmIntent(base).status).toBe("confirmed");
    expect(abandonIntent(base).status).toBe("abandoned");
    expect(base.status).toBe("pending");
  });
});
