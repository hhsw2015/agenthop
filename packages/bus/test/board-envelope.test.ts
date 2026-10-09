import { describe, expect, test } from "vitest";
import { planGrantEnvelope, type GrantedClaim } from "../src/swarm/board-envelope.js";
import { openDelegation, emptyDelegationRegistry } from "../src/swarm/delegation-envelope.js";
import type { TaskPlan } from "../src/swarm/task-plan.js";

// Minimal cast fixtures — planGrantEnvelope reads only a few node fields.
const node = (nodeId: string, over: Record<string, unknown> = {}): unknown => ({
  nodeId, kind: "work", goal: `do ${nodeId}`, dependsOn: [],
  outputContract: { requiredOutputs: [{ logicalName: `${nodeId}-out`, kind: "patch", pathHint: `out/${nodeId}.diff` }] },
  acceptance: [], artifactScope: [`src/${nodeId}`], estimatedRuntimeSec: 120, retryBudget: 1, specDigest: `sd-${nodeId}`, ...over,
});
const plan = (nodes: unknown[], over: Record<string, unknown> = {}): TaskPlan =>
  ({ jobId: "J", planRevision: 3, nodes, jobBudget: {}, planDigest: "pd", ...over } as unknown as TaskPlan);
const claim = (nodeId: string, over: Partial<GrantedClaim> = {}): GrantedClaim =>
  ({ jobId: "J", nodeId, attemptId: `att-${nodeId}`, specDigest: `sd-${nodeId}`, inputBindingDigest: `ibd-${nodeId}`, ...over });

describe("board-envelope planGrantEnvelope (§2b OPEN side: granted claim → delegation OpenSpec, R14 pre-flight)", () => {
  test("maps identity correctly (requestId=attemptId, subject=job+revision, owner, completionSlot from the required output)", () => {
    const spec = planGrantEnvelope(claim("a"), plan([node("a")]), 1000, "member-x", "coord")!;
    expect(spec.requestId).toBe("att-a");
    expect(spec.subject).toEqual({ jobId: "J", revision: 3 });
    expect(spec.owner).toBe("member-x");
    expect(spec.completionSlot).toEqual({ locator: "out/a.diff", targetDigest: "sd-a", resultFormat: "patch", acceptor: "coord" });
    expect(spec.productionDeadlineSec).toBe(1000 + 120);
    expect(spec.payload).toBeTruthy(); // inline reconstructable source
    expect(spec.payloadDigest).toMatch(/^[0-9a-f]{64}$/); // canonical-JSON sha256
  });

  test("locator falls back to logicalName when the output has no pathHint", () => {
    const n = node("a", { outputContract: { requiredOutputs: [{ logicalName: "report-a", kind: "report" }] } });
    const spec = planGrantEnvelope(claim("a"), plan([n]), 0, "m", "c")!;
    expect(spec.completionSlot.locator).toBe("report-a");
    expect(spec.completionSlot.resultFormat).toBe("report");
  });

  test("a node with NO required output -> null (nothing to observe -> no envelope)", () => {
    const n = node("a", { outputContract: { requiredOutputs: [] } });
    expect(planGrantEnvelope(claim("a"), plan([n]), 0, "m", "c")).toBeNull();
  });

  test("a node absent from the plan -> null (defensive)", () => {
    expect(planGrantEnvelope(claim("ghost"), plan([node("a")]), 0, "m", "c")).toBeNull();
  });

  test("deterministic: same inputs -> identical spec (stable payloadDigest)", () => {
    const a = planGrantEnvelope(claim("a"), plan([node("a")]), 1000, "m", "c")!;
    const b = planGrantEnvelope(claim("a"), plan([node("a")]), 1000, "m", "c")!;
    expect(a).toEqual(b);
  });

  test("payloadDigest binds BOTH specDigest and inputBindingDigest (input drift changes it)", () => {
    const base = planGrantEnvelope(claim("a"), plan([node("a")]), 0, "m", "c")!;
    const drift = planGrantEnvelope(claim("a", { inputBindingDigest: "ibd-OTHER" }), plan([node("a")]), 0, "m", "c")!;
    expect(drift.payloadDigest).not.toBe(base.payloadDigest);
  });

  test("end-to-end: the spec opens a production envelope; a re-grant replay is idempotent (same requestId+payload ⇒ no new wait)", () => {
    const spec = planGrantEnvelope(claim("a"), plan([node("a")]), 1000, "member-x", "coord")!;
    const open1 = openDelegation(emptyDelegationRegistry(), spec, 1000);
    expect(open1.ok).toBe(true);
    if (!open1.ok) return;
    expect(open1.openProductionWait).toBeTruthy(); // first open emits a production-wait
    const open2 = openDelegation(open1.registry, spec, 1001); // replay
    expect(open2.ok).toBe(true);
    if (!open2.ok) return;
    expect(open2.openProductionWait).toBeUndefined(); // idempotent: no duplicate envelope / wait
  });

  test("a same requestId with a DIFFERENT payload is a conflict (rejected, never overwritten)", () => {
    const spec = planGrantEnvelope(claim("a"), plan([node("a")]), 1000, "member-x", "coord")!;
    const open1 = openDelegation(emptyDelegationRegistry(), spec, 1000);
    if (!open1.ok) return;
    const drift = planGrantEnvelope(claim("a", { inputBindingDigest: "ibd-OTHER" }), plan([node("a")]), 1000, "member-x", "coord")!;
    const open2 = openDelegation(open1.registry, drift, 1000); // same requestId (attemptId), different payloadDigest
    expect(open2.ok).toBe(false);
  });
});
