import { describe, expect, test } from "vitest";
import type { ValidationRun, ValidationCandidateRef } from "../src/swarm/control-log.js";
import { openValidationRun, advanceValidationRun, moveValidator, verdictEligible, type NewValidationRun } from "../src/swarm/task-validation.js";

const candidate: ValidationCandidateRef = { observedResultId: "job/P/a1/obs1", observedWorkCommit: "wc9", resultClosureDigest: "cd1" };
function mkRun(p: Partial<NewValidationRun> = {}): ValidationRun {
  return openValidationRun({ validationRunId: "job/P/a1/vr0", attemptId: "job/P/a1", candidateRef: candidate, generation: 0, validatorLocation: "dispatcher-local", openedAtSeq: 10, ...p });
}

describe("openValidationRun", () => {
  test("starts running over the pinned candidate", () => {
    const r = mkRun();
    expect(r.state).toBe("running");
    expect(r.generation).toBe(0);
    expect(r.candidateRef).toEqual(candidate);
  });
});

describe("advanceValidationRun", () => {
  test("verdict_observed: running -> verdict_pending -> resolve -> closed(verdict-accepted)", () => {
    const vp = advanceValidationRun(mkRun(), { type: "verdict_observed" });
    expect(vp.ok && vp.run.state === "verdict_pending").toBe(true);
    const done = advanceValidationRun(vp.ok ? vp.run : mkRun(), { type: "resolve", atSeq: 11 });
    expect(done.ok && done.run.state === "closed" && done.run.closeReason === "verdict-accepted" && done.run.closedAtSeq === 11).toBe(true);
  });
  test("resolve only from verdict_pending; no transition out of closed", () => {
    expect(advanceValidationRun(mkRun(), { type: "resolve", atSeq: 1 }).ok).toBe(false); // running -> resolve illegal
    const closed = advanceValidationRun(mkRun(), { type: "cancel", atSeq: 1 });
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      for (const ev of [{ type: "verdict_observed" }, { type: "resolve", atSeq: 2 }, { type: "supersede", atSeq: 2 }, { type: "cancel", atSeq: 2 }] as const) {
        expect(advanceValidationRun(closed.run, ev).ok).toBe(false);
      }
    }
  });
});

describe("moveValidator (P2-2): swap validator location, pin candidate, fence old verdict", () => {
  test("closes the stuck run and opens generation+1 over the SAME candidate (business not re-run)", () => {
    const stuck = mkRun(); // gen 0 running
    const moved = moveValidator(stuck, { validationRunId: "job/P/a1/vr1", validatorLocation: "box:rw-7", openedAtSeq: 20, atSeq: 20 });
    expect("error" in moved).toBe(false);
    if (!("error" in moved)) {
      expect(moved.closedOld.state).toBe("closed");
      expect(moved.closedOld.closeReason).toBe("superseded");
      expect(moved.next.generation).toBe(1);
      expect(moved.next.validatorLocation).toBe("box:rw-7");
      expect(moved.next.state).toBe("running");
      expect(moved.next.candidateRef).toEqual(candidate); // PINNED — identical candidate, no business re-run
      expect(moved.next.attemptId).toBe("job/P/a1");
    }
  });
  test("the superseded run's late verdict is FENCED; only the current run is eligible", () => {
    const moved = moveValidator(mkRun(), { validationRunId: "job/P/a1/vr1", validatorLocation: "box:rw-7", openedAtSeq: 20, atSeq: 20 });
    expect("error" in moved).toBe(false);
    if (!("error" in moved)) {
      expect(verdictEligible(moved.closedOld)).toBe(false); // old (stuck) validator's eventual reply: fenced
      expect(verdictEligible(moved.next)).toBe(true); // current run: eligible
    }
  });
  test("verdictEligible: a running or verdict_pending run is eligible, a closed one is not", () => {
    expect(verdictEligible(mkRun())).toBe(true);
    const vp = advanceValidationRun(mkRun(), { type: "verdict_observed" });
    expect(vp.ok && verdictEligible(vp.run)).toBe(true);
    const c = advanceValidationRun(mkRun(), { type: "cancel", atSeq: 1 });
    expect(c.ok && verdictEligible(c.run)).toBe(false);
  });
  test("cannot move from a closed run", () => {
    const c = advanceValidationRun(mkRun(), { type: "cancel", atSeq: 1 });
    const moved = c.ok ? moveValidator(c.run, { validationRunId: "x", validatorLocation: "y", openedAtSeq: 2, atSeq: 2 }) : { error: "setup" };
    expect("error" in moved).toBe(true);
  });
});
