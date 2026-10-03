import { describe, expect, test } from "vitest";
import { initialLogState, commit, entityKeyOf, type Change, type ValidationCandidateRef } from "../src/swarm/control-log.js";
import { advanceWait } from "../src/swarm/task-wait.js";
import { advanceValidationRun, verdictEligible, moveValidator } from "../src/swarm/task-validation.js";
import { openValidationRunWithWait, closeValidationWithWait, moveValidatorAction, moveValidatorWithWait, type OpenRpvInput } from "../src/swarm/task-rpv.js";

const candidate: ValidationCandidateRef = { observedResultId: "job/P/a1/obs1", observedWorkCommit: "wc9", resultClosureDigest: "cd1" };
function openInput(p: Partial<OpenRpvInput> = {}): OpenRpvInput {
  return { jobId: "job", attemptId: "job/P/a1", candidateRef: candidate, validationRunId: "job/P/a1/vr0", generation: 0, validatorLocation: "dispatcher-local", openedAtSeq: 10, waitId: "job/P/a1/vw0", deadlineSec: 100, owner: "disp", timeoutPolicy: "escalate", ...p };
}
const resolution = { outcome: "verdict-accepted", reason: "ok", sourceOperationId: "op" };

describe("RPV anchor (b): ValidationRun + companion validation-wait", () => {
  test("① same-batch open: both entities present with a consistent mutual reference", () => {
    const rpv = openValidationRunWithWait(openInput());
    // wait is anchored to the run (typed anchoring).
    expect(rpv.wait.subject.validationRunId).toBe(rpv.run.validationRunId);
    expect(rpv.wait.kind).toBe("wait");
    expect(rpv.wait.timeoutPolicy).toBe("escalate");
    expect(rpv.run.state).toBe("running");
    expect(rpv.changes.map((c) => c.put).sort()).toEqual(["validationRun", "wait"]);
    // committed in one batch, both land in the projection.
    const batch: Change[] = rpv.changes.map((b) => ({ ...b, operationId: `${entityKeyOf(b)}#1`, expectedEntityRevision: 0 }) as Change);
    const { result, state } = commit(initialLogState(), 0, batch);
    expect(result.ok).toBe(true);
    expect(state.entities["validationRun:job/P/a1/vr0"]?.put).toBe("validationRun");
    const w = state.entities["wait:job/P/a1/vw0"];
    expect(w?.put === "wait" && w.wait.subject.validationRunId === "job/P/a1/vr0").toBe(true);
  });

  test("② timeout: begin_action(move-validator) then action_done RE-ARMS (not resolve); the MOVE terminal goes through close", () => {
    const { run, wait } = openValidationRunWithWait(openInput({ timeoutPolicy: "escalate" }));
    const action = moveValidatorAction({ actionId: "mv1", newValidatorLocation: "box:rw-7", expectedSubjectVersion: 1 });
    expect(action.actionKind === "move-validator" && action.target === "box:rw-7").toBe(true);
    const pend = advanceWait(wait, { type: "begin_action", pendingAction: action });
    expect(pend.ok && pend.wait.state === "action_pending" && pend.wait.pendingAction?.actionKind === "move-validator").toBe(true);
    // a timeout action completing only RE-ARMS the wait — it does NOT resolve it (§0b erratum 94284fc2).
    const rearmed = advanceWait(pend.ok ? pend.wait : wait, { type: "action_done", newDeadlineSec: 400, nowSec: 200 });
    expect(rearmed.ok && rearmed.wait.state === "open" && rearmed.wait.deadlineSec === 400).toBe(true);
    // the actual MOVE is a reassignment-class terminal: CLOSE the old wait + supersede the run + open a new run & wait.
    const moved = moveValidatorWithWait(run, rearmed.ok ? rearmed.wait : wait, { newValidationRunId: "job/P/a1/vr1", validatorLocation: "box:rw-7", openedAtSeq: 30, atSeq: 30, newWaitId: "job/P/a1/vw1", deadlineSec: 100, owner: "disp", timeoutPolicy: "escalate", resolution: { outcome: "reassigned", reason: "validator timeout", sourceOperationId: "op" } });
    expect("error" in moved).toBe(false);
    if (!("error" in moved)) {
      expect(moved.closedOldWait.state).toBe("resolved"); // old wait CLOSED, not action_done'd
      expect(moved.closedOldRun.state).toBe("closed");
      expect(moved.next.state).toBe("running");
      expect(moved.next.generation).toBe(1);
      expect(moved.next.candidateRef).toEqual(candidate); // PINNED candidate — business not re-run
      expect(moved.newWait.subject.validationRunId).toBe("job/P/a1/vr1"); // new companion wait anchored to the new run
      expect(moved.changes.map((c) => c.put).sort()).toEqual(["validationRun", "validationRun", "wait", "wait"]);
    }
  });

  test("③ normal completion (P2-1): resolve the run AND close the companion wait in one batch", () => {
    const { run, wait } = openValidationRunWithWait(openInput());
    const vp = advanceValidationRun(run, { type: "verdict_observed" }); // verdict came back
    expect(vp.ok).toBe(true);
    const closed = closeValidationWithWait(vp.ok ? vp.run : run, wait, { atSeq: 20, resolution });
    expect("error" in closed).toBe(false);
    if (!("error" in closed)) {
      expect(closed.run.state).toBe("closed");
      expect(closed.run.closeReason).toBe("verdict-accepted");
      expect(closed.wait.state).toBe("resolved");
      expect(closed.changes.map((c) => c.put).sort()).toEqual(["validationRun", "wait"]);
    }
  });

  test("④ a late reply on an already-closed wait / superseded run is rejected (existing guards)", () => {
    const { run, wait } = openValidationRunWithWait(openInput());
    const vp = advanceValidationRun(run, { type: "verdict_observed" });
    const closed = closeValidationWithWait(vp.ok ? vp.run : run, wait, { atSeq: 20, resolution });
    expect("error" in closed).toBe(false);
    if (!("error" in closed)) {
      // late action on the resolved wait: rejected.
      expect(advanceWait(closed.wait, { type: "begin_action", pendingAction: moveValidatorAction({ actionId: "x", newValidatorLocation: "y", expectedSubjectVersion: 1 }) }).ok).toBe(false);
      // late verdict on the closed run: fenced.
      expect(verdictEligible(closed.run)).toBe(false);
    }
    // the superseded (stuck) run after a validator move: its late verdict is fenced, the new run is eligible.
    const { run: freshRun } = openValidationRunWithWait(openInput());
    const moved = moveValidator(freshRun, { validationRunId: "job/P/a1/vr1", validatorLocation: "box:rw-7", openedAtSeq: 30, atSeq: 30 });
    expect("error" in moved).toBe(false);
    if (!("error" in moved)) {
      expect(verdictEligible(moved.closedOld)).toBe(false);
      expect(verdictEligible(moved.next)).toBe(true);
    }
  });
});
