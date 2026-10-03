import { describe, expect, test } from "vitest";
import { createAttempt, type TaskAttempt, type InputBinding, type ExecutionBinding, type AttemptStatus } from "../src/swarm/task-state.js";
import type { AcceptedResult } from "../src/swarm/task-result.js";
import { entityKeyOf, type ChangeBody } from "../src/swarm/control-log.js";
import { supersedeCascade } from "../src/swarm/task-supersede.js";

function bind(id: string, activated: boolean): ExecutionBinding {
  const b: ExecutionBinding = { bindingId: id, assignmentId: "as", launchId: "rw", publishGeneration: 0, openedAtSeq: 1 };
  return activated ? { ...b, activatedAtSeq: 2 } : b;
}
function att(nodeId: string, n: number, inputs: InputBinding[], status: AttemptStatus, activated = true): TaskAttempt {
  const a = createAttempt({ jobId: "job", nodeId, n, planRevision: 1, specDigest: "sd", inputBindings: inputs, firstBinding: bind(`job/${nodeId}/a${n}/b0`, activated), createdAtSeq: 1 });
  return { ...a, status };
}
function acc(nodeId: string, n: number): AcceptedResult {
  const attemptId = `job/${nodeId}/a${n}`;
  return { acceptedResultId: `${attemptId}/r1`, attemptId, nodeId, jobId: "job", planRevision: 1, observedWorkCommit: "wc", resultPath: "p", resultBlobOid: "b", resultClosureDigest: "c", inputBindingDigest: "d", validatorVersion: "brain-v1", decision: "accepted", decidedAtSeq: 1 };
}
function boundTo(a: AcceptedResult): InputBinding {
  return { depNodeId: a.nodeId, acceptedResultId: a.acceptedResultId, workCommit: a.observedWorkCommit, resultPath: a.resultPath };
}
const supersededIds = (out: ChangeBody[]): string[] => out.flatMap((c) => (c.put === "supersede" ? [c.acceptedResultId] : []));
const abandonedAttempts = (out: ChangeBody[]): TaskAttempt[] => out.flatMap((c) => (c.put === "attempt" ? [c.attempt] : []));

describe("supersedeCascade (§4.2)", () => {
  test("SUCCEEDED downstream cascades; un-started RUNNING is revoked stale-input", () => {
    const cAcc = acc("C", 1);
    const pA = att("P", 1, [boundTo(cAcc)], "SUCCEEDED");
    const pAcc = acc("P", 1);
    const dRunning = att("D", 1, [boundTo(cAcc)], "RUNNING", false); // never activated
    const out = supersedeCascade({ rootAcceptedResultId: cAcc.acceptedResultId, attempts: [pA, dRunning], acceptedResults: [cAcc, pAcc] });
    expect(supersededIds(out).sort()).toEqual([cAcc.acceptedResultId, pAcc.acceptedResultId].sort());
    const abandoned = abandonedAttempts(out);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.nodeId).toBe("D");
    expect(abandoned[0]!.status).toBe("ABANDONED");
    expect(abandoned[0]!.abandonReason).toBe("stale-input");
  });

  test("a RUNNING attempt already executing (activated binding) is LEFT ALONE (V4 handles it)", () => {
    const cAcc = acc("C", 1);
    const dActive = att("D", 1, [boundTo(cAcc)], "RUNNING", true); // activated
    const out = supersedeCascade({ rootAcceptedResultId: cAcc.acceptedResultId, attempts: [dActive], acceptedResults: [cAcc] });
    expect(abandonedAttempts(out)).toHaveLength(0);
    expect(supersededIds(out)).toEqual([cAcc.acceptedResultId]);
  });

  test("a RESULT_PENDING_VALIDATION attempt does NOT appear in the cascade (left to V4 -> stale)", () => {
    const cAcc = acc("C", 1);
    const dPending = att("D", 1, [boundTo(cAcc)], "RESULT_PENDING_VALIDATION", true);
    const out = supersedeCascade({ rootAcceptedResultId: cAcc.acceptedResultId, attempts: [dPending], acceptedResults: [cAcc] });
    expect(out.some((c) => c.put === "attempt")).toBe(false);
  });

  test("RETRY_WAIT downstream is left as-is (a succession re-resolves inputs)", () => {
    const cAcc = acc("C", 1);
    const dRetry = att("D", 1, [boundTo(cAcc)], "RETRY_WAIT");
    const out = supersedeCascade({ rootAcceptedResultId: cAcc.acceptedResultId, attempts: [dRetry], acceptedResults: [cAcc] });
    expect(abandonedAttempts(out)).toHaveLength(0);
  });

  test("recursive chain C -> P -> I (all SUCCEEDED) supersedes all three accepted", () => {
    const cAcc = acc("C", 1);
    const pA = att("P", 1, [boundTo(cAcc)], "SUCCEEDED"); const pAcc = acc("P", 1);
    const iA = att("I", 1, [boundTo(pAcc)], "SUCCEEDED"); const iAcc = acc("I", 1);
    const out = supersedeCascade({ rootAcceptedResultId: cAcc.acceptedResultId, attempts: [pA, iA], acceptedResults: [cAcc, pAcc, iAcc] });
    expect(supersededIds(out).sort()).toEqual([cAcc, pAcc, iAcc].map((a) => a.acceptedResultId).sort());
  });

  test("diamond double-path convergence: I is superseded EXACTLY once (no same-entity-twice batchError)", () => {
    const cAcc = acc("C", 1);
    const pA = att("P", 1, [boundTo(cAcc)], "SUCCEEDED"); const pAcc = acc("P", 1);
    const qA = att("Q", 1, [boundTo(cAcc)], "SUCCEEDED"); const qAcc = acc("Q", 1);
    const iA = att("I", 1, [boundTo(pAcc), boundTo(qAcc)], "SUCCEEDED"); const iAcc = acc("I", 1); // consumes both P and Q
    const out = supersedeCascade({ rootAcceptedResultId: cAcc.acceptedResultId, attempts: [pA, qA, iA], acceptedResults: [cAcc, pAcc, qAcc, iAcc] });
    const ids = supersededIds(out);
    expect(ids.filter((x) => x === iAcc.acceptedResultId)).toHaveLength(1); // reached via P and via Q, emitted once
    expect(ids.sort()).toEqual([cAcc, pAcc, qAcc, iAcc].map((a) => a.acceptedResultId).sort());
  });

  test("no entity appears twice in the batch (commitControl would batchError)", () => {
    const cAcc = acc("C", 1);
    const pA = att("P", 1, [boundTo(cAcc)], "SUCCEEDED"); const pAcc = acc("P", 1);
    const qA = att("Q", 1, [boundTo(cAcc)], "SUCCEEDED"); const qAcc = acc("Q", 1);
    const iA = att("I", 1, [boundTo(pAcc), boundTo(qAcc)], "SUCCEEDED"); const iAcc = acc("I", 1);
    const dRunning = att("D", 1, [boundTo(cAcc)], "RUNNING", false);
    const out = supersedeCascade({ rootAcceptedResultId: cAcc.acceptedResultId, attempts: [pA, qA, iA, dRunning], acceptedResults: [cAcc, pAcc, qAcc, iAcc] });
    const keys = out.map((c) => entityKeyOf(c));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
