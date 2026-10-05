import { describe, expect, test } from "vitest";
import { subjectProgressSeq, waitArmSeq, hasFreshSubjectEvidence, renewOperationId, renewalCount } from "../src/swarm/evidence-renewal.js";
import type { Change, CommittedBatch } from "../src/swarm/control-log.js";

// Minimal change fixtures: the derivations read only a few fields per change type, so build those and cast.
const ch = (body: Record<string, unknown>): Change => ({ ...body, operationId: "op", expectedEntityRevision: 0 } as unknown as Change);
const batch = (seq: number, ...changes: Change[]): CommittedBatch => ({ seq, changes });
const plan = (jobId: string) => ch({ put: "plan", plan: { jobId } });
const attempt = (jobId: string, attemptId: string) => ch({ put: "attempt", attempt: { jobId, attemptId } });
const observed = (attemptId: string) => ch({ put: "observed", observed: { attemptId } });
const intent = (attemptId: string) => ch({ put: "intent", intent: { attemptId } });
const accepted = (jobId: string) => ch({ put: "accepted", accepted: { jobId } });
const waitAt = (waitId: string, state: string, jobId = "J") => ch({ put: "wait", wait: { waitId, state, subject: { jobId } } });

describe("subjectProgressSeq (§2c-b subject progress evidence)", () => {
  test("counts plan/attempt/accepted by jobId and observed/intent via the job's attempts; returns the max seq", () => {
    const batches = [
      batch(1, plan("J")),
      batch(2, attempt("J", "a1")),
      batch(3, observed("a1")),
      batch(4, intent("a1")),
      batch(5, accepted("J")),
    ];
    expect(subjectProgressSeq(batches, "J")).toBe(5);
  });

  test("another job's changes, and observed/intent on a non-J attempt, do not count", () => {
    const batches = [
      batch(1, plan("J")),            // J progress @1
      batch(2, attempt("OTHER", "b1")),
      batch(3, observed("b1")),       // on OTHER's attempt — not J
      batch(4, intent("b1")),
      batch(5, plan("OTHER")),
    ];
    expect(subjectProgressSeq(batches, "J")).toBe(1);
    expect(subjectProgressSeq(batches, "NONE")).toBe(0);
  });

  test("WAIT changes NEVER count as subject progress (no renew→progress→renew loop)", () => {
    const batches = [
      batch(1, plan("J")),
      batch(9, waitAt("W", "open", "J")),          // the subject's own wait, armed — must NOT advance progress
      batch(10, waitAt("W", "action_pending", "J")),
    ];
    expect(subjectProgressSeq(batches, "J")).toBe(1); // still 1, not 9/10
  });
});

describe("waitArmSeq (last arm = a 'put wait' leaving state 'open')", () => {
  test("open (create) and a later open (renew/action_done) count; action_pending and resolved do not", () => {
    const batches = [
      batch(1, waitAt("W", "open")),             // create/arm @1
      batch(2, waitAt("W", "action_pending")),   // escalation step — not an arm
      batch(3, waitAt("W", "open")),             // re-arm @3
      batch(4, waitAt("W", "resolved")),         // close — not an arm
    ];
    expect(waitArmSeq(batches, "W")).toBe(3);
    expect(waitArmSeq(batches, "OTHER")).toBe(0);
  });
});

describe("renewalCount (§2c-b acceptance ③: finite renewals, derived from the log)", () => {
  const renewCh = (waitId: string, progressSeq: number): Change =>
    ({ put: "wait", wait: { waitId, state: "open" }, operationId: renewOperationId(waitId, progressSeq), expectedEntityRevision: 0 } as unknown as Change);

  test("renewOperationId is distinguishable and idempotent by progress seq", () => {
    expect(renewOperationId("W", 5)).toBe("wait:W#renew@5");
    expect(renewOperationId("W", 5)).toBe(renewOperationId("W", 5)); // same inputs ⇒ same id ⇒ replay no-op
  });

  test("counts DISTINCT renew ids; a re-attempt (same id) and a create/action_done open (non-renew id) do not add", () => {
    const batches = [
      batch(1, waitAt("W", "open")),      // create — operationId "op", NOT a renewal
      batch(2, renewCh("W", 5)),          // renewal #1
      batch(3, waitAt("W", "action_pending")),
      batch(4, renewCh("W", 8)),          // renewal #2
      batch(5, renewCh("W", 5)),          // a re-attempt of #1 (same id) — replay, not a new renewal
    ];
    expect(renewalCount(batches, "W")).toBe(2);
    expect(renewalCount(batches, "OTHER")).toBe(0);
  });
});

describe("hasFreshSubjectEvidence (the sweep's renew-vs-escalate test)", () => {
  test("progress AFTER the last arm ⇒ fresh (renew); progress at/before ⇒ none (escalate); repeat after renew ⇒ no-op", () => {
    // armed @2, then the subject commits @5 ⇒ fresh evidence
    expect(hasFreshSubjectEvidence([batch(2, waitAt("W", "open")), batch(5, accepted("J"))], "J", "W")).toBe(true);
    // subject progress @1, wait armed later @4 ⇒ nothing new since the arm
    expect(hasFreshSubjectEvidence([batch(1, accepted("J")), batch(4, waitAt("W", "open"))], "J", "W")).toBe(false);
    // after a renew the arm advances PAST the triggering progress ⇒ the same evidence does not renew again
    expect(hasFreshSubjectEvidence([batch(2, waitAt("W", "open")), batch(5, accepted("J")), batch(6, waitAt("W", "open"))], "J", "W")).toBe(false);
  });
});
