import { describe, expect, test } from "vitest";
import { assertLiveness, type ReviewCut, type LivenessResponsibility, type ObservationFact, type ObservationSource, type Modes } from "../src/swarm/task-liveness-inv1.js";

const NOW = 1000;
const fresh = (source: ObservationSource, instance?: string): ObservationFact => ({ source, instance, sampledAtSec: 990, validUntilSec: 1100 });
const stale = (source: ObservationSource, instance?: string): ObservationFact => ({ source, instance, sampledAtSec: 800, validUntilSec: 900 });
function cut(responsibilities: LivenessResponsibility[], over: { observations?: ObservationFact[]; modes?: Modes; jobTerminal?: boolean; seq?: number; jobId?: string } = {}): ReviewCut {
  return {
    controlCut: { jobId: over.jobId ?? "J", seq: over.seq ?? 10, jobTerminal: over.jobTerminal ?? false, responsibilities },
    observations: over.observations ?? [],
    modes: over.modes ?? { sweepOn: true, taskExecOn: true },
  };
}

describe("core non-emptiness (§1 / §6)", () => {
  test("terminal job needs no holder -> OK", () => {
    expect(assertLiveness(cut([], { jobTerminal: true }), NOW).verdict).toBe("OK");
  });
  test("non-terminal with NO responsibility at all -> STALL (three sets empty can never be OK)", () => {
    const v = assertLiveness(cut([], { seq: 42 }), NOW);
    expect(v.verdict).toBe("STALL");
    if (v.verdict === "STALL") {
      expect(v.incidentKey).toBe("J:no-live-holder");
      expect(v.lastObservedSeq).toBe(42);
    }
  });
  test("a verified READY (dispatcher mode on + fresh pass-heartbeat) -> OK, counted in R", () => {
    const v = assertLiveness(cut([{ kind: "READY", subjectId: "M" }], { observations: [fresh("pass-heartbeat")] }), NOW);
    expect(v.verdict === "OK" && v.coverage.r).toEqual(["M"]);
  });
  test("non-empty verified set is NEVER mis-reported as STALL", () => {
    const v = assertLiveness(cut([{ kind: "VALIDATION", subjectId: "J/P/a1" }], { observations: [fresh("sweep-heartbeat")] }), NOW);
    expect(v.verdict).toBe("OK");
  });
});

describe("① legitimate backoff is a supervised wait, not STALL", () => {
  test("a RETRY_WAIT backoff with sweep live counts in W -> OK", () => {
    const v = assertLiveness(cut([{ kind: "RETRY_WAIT_BACKOFF", subjectId: "J/P/a1" }], { observations: [fresh("sweep-heartbeat")] }), NOW);
    expect(v.verdict === "OK" && v.coverage.w).toEqual(["J/P/a1"]);
  });
});

describe("② missing/stale observation -> UNVERIFIABLE, never guess", () => {
  test("a RUNNING business exec with fresh work-progress but ABSENT roster -> UNVERIFIABLE (no evidence != dead != alive)", () => {
    const v = assertLiveness(cut([{ kind: "BUSINESS_EXEC", subjectId: "J/P/a1", executorInstance: "rw-7" }], { observations: [fresh("work-progress")] }), NOW);
    expect(v.verdict).toBe("UNVERIFIABLE");
    if (v.verdict === "UNVERIFIABLE") expect(v.missing.some((m) => m.includes("roster@rw-7"))).toBe(true);
  });
  test("a READY with a STALE pass-heartbeat -> UNVERIFIABLE(stale), not STALL", () => {
    const v = assertLiveness(cut([{ kind: "READY", subjectId: "M" }], { observations: [stale("pass-heartbeat")] }), NOW);
    expect(v.verdict).toBe("UNVERIFIABLE");
    if (v.verdict === "UNVERIFIABLE") expect(v.missing.some((m) => m.includes("stale pass-heartbeat"))).toBe(true);
  });
});

describe("③ same controlCut + different observations -> different verdict (health is an input)", () => {
  test("fresh pass-heartbeat => OK; stale => UNVERIFIABLE, on the SAME cut", () => {
    const resp: LivenessResponsibility[] = [{ kind: "READY", subjectId: "M" }];
    expect(assertLiveness(cut(resp, { observations: [fresh("pass-heartbeat")] }), NOW).verdict).toBe("OK");
    expect(assertLiveness(cut(resp, { observations: [stale("pass-heartbeat")] }), NOW).verdict).toBe("UNVERIFIABLE");
  });
});

describe("④ incidentKey is stable (seq-independent); lastObservedSeq updates separately", () => {
  test("the same ongoing stall at different seqs yields the SAME incidentKey (dedup no-op)", () => {
    const a = assertLiveness(cut([], { seq: 100 }), NOW);
    const b = assertLiveness(cut([], { seq: 137 }), NOW);
    expect(a.verdict === "STALL" && b.verdict === "STALL" && a.incidentKey === b.incidentKey).toBe(true);
    if (a.verdict === "STALL" && b.verdict === "STALL") {
      expect(a.incidentKey).not.toContain("100"); // no seq in the key
      expect(a.lastObservedSeq).toBe(100);
      expect(b.lastObservedSeq).toBe(137); // only lastObservedSeq moves
    }
  });
});

describe("⑤ coverage != progress", () => {
  test("OK carries a coverage breakdown (responsibility held), not a progress claim", () => {
    const v = assertLiveness(cut([{ kind: "BUSINESS_EXEC", subjectId: "J/P/a1", executorInstance: "rw-7" }], { observations: [fresh("work-progress"), fresh("roster", "rw-7")] }), NOW);
    expect(v.verdict === "OK" && v.coverage.e).toEqual(["J/P/a1"]);
    // the verdict object has coverage only — no "progress" field; INV-1 proves a holder exists, not that it advanced.
    if (v.verdict === "OK") expect("progress" in v).toBe(false);
  });
});

describe("mode-off is a verified-dead holder (STALL), not UNVERIFIABLE", () => {
  test("an awaiting-gate wait while sweep is OFF -> STALL (we KNOW the loop isn't running)", () => {
    const v = assertLiveness(cut([{ kind: "AWAITING_GATE", subjectId: "w1" }], { observations: [fresh("sweep-heartbeat")], modes: { sweepOn: false, taskExecOn: true } }), NOW);
    expect(v.verdict).toBe("STALL");
  });
});

describe("one verified holder satisfies INV-1 even if another is unverifiable", () => {
  test("verified READY + roster-absent BUSINESS_EXEC -> OK (the READY holds it)", () => {
    const v = assertLiveness(cut([
      { kind: "READY", subjectId: "M" },
      { kind: "BUSINESS_EXEC", subjectId: "J/P/a1", executorInstance: "rw-7" },
    ], { observations: [fresh("pass-heartbeat"), fresh("work-progress")] }), NOW); // roster absent
    expect(v.verdict === "OK" && v.coverage.r).toEqual(["M"]);
  });
});

describe("countermodel #10: separate loop heartbeats — sweep staleness is not masked by a fresh pass heartbeat", () => {
  test("only an awaiting-gate wait, sweep-heartbeat STALE while pass-heartbeat is fresh -> UNVERIFIABLE (sweep)", () => {
    const v = assertLiveness(cut([{ kind: "AWAITING_GATE", subjectId: "w1" }], { observations: [fresh("pass-heartbeat"), stale("sweep-heartbeat")] }), NOW);
    expect(v.verdict).toBe("UNVERIFIABLE");
    if (v.verdict === "UNVERIFIABLE") expect(v.missing.some((m) => m.includes("sweep-heartbeat"))).toBe(true);
  });
});
