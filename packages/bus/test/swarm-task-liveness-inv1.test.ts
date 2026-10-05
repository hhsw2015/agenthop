import { describe, expect, test } from "vitest";
import { assertLiveness, type ReviewCut, type LivenessResponsibility, type ObservationFact, type ObservationSource, type Modes } from "../src/swarm/task-liveness-inv1.js";

const NOW = 1000;
const PASS = "disp-1";
const SWEEP = "sweep-1";
const fresh = (source: ObservationSource, instance: string): ObservationFact => ({ source, instance, sampledAtSec: 990, validUntilSec: 1100 });
const stalE = (source: ObservationSource, instance: string): ObservationFact => ({ source, instance, sampledAtSec: 800, validUntilSec: 900 });
const future = (source: ObservationSource, instance: string): ObservationFact => ({ source, instance, sampledAtSec: 1050, validUntilSec: 1200 }); // sampled in the FUTURE
type Over = { observations?: ObservationFact[]; modes?: Modes; jobTerminal?: boolean; seq?: number; jobId?: string; openIncidentEpisode?: number };
function cut(responsibilities: LivenessResponsibility[], over: Over = {}): ReviewCut {
  return {
    controlCut: { jobId: over.jobId ?? "J", seq: over.seq ?? 10, jobTerminal: over.jobTerminal ?? false, responsibilities, ...(over.openIncidentEpisode !== undefined ? { openIncidentEpisode: over.openIncidentEpisode } : {}) },
    observations: over.observations ?? [],
    modes: over.modes ?? { sweepOn: true, taskExecOn: true, passInstance: PASS, sweepInstance: SWEEP },
  };
}

describe("core non-emptiness (§1 / §6)", () => {
  test("terminal job needs no holder -> OK", () => {
    expect(assertLiveness(cut([], { jobTerminal: true }), NOW).verdict).toBe("OK");
  });
  test("non-terminal with NO responsibility -> STALL (three empty sets can never be OK); groupKey stable, seq apart", () => {
    const v = assertLiveness(cut([], { seq: 42 }), NOW);
    expect(v.verdict).toBe("STALL");
    if (v.verdict === "STALL") {
      expect(v.groupKey).toBe("J:no-live-holder");
      expect(v.lastObservedSeq).toBe(42);
      expect(v.incidentId).toBeUndefined(); // no episode supplied
    }
  });
  test("a verified READY (pass mode on + fresh pass-heartbeat from the declared instance) -> OK, counted in R", () => {
    const v = assertLiveness(cut([{ kind: "READY", subjectId: "M" }], { observations: [fresh("pass-heartbeat", PASS)] }), NOW);
    expect(v.verdict === "OK" && v.coverage.r).toEqual(["M"]);
  });
  test("a non-empty verified set is never mis-reported STALL", () => {
    const v = assertLiveness(cut([{ kind: "VALIDATION", subjectId: "J/P/a1" }], { observations: [fresh("sweep-heartbeat", SWEEP)] }), NOW);
    expect(v.verdict).toBe("OK");
  });
});

describe("① legitimate backoff is a supervised wait, not STALL", () => {
  test("RETRY_WAIT backoff with sweep live counts in W -> OK", () => {
    const v = assertLiveness(cut([{ kind: "RETRY_WAIT_BACKOFF", subjectId: "J/P/a1" }], { observations: [fresh("sweep-heartbeat", SWEEP)] }), NOW);
    expect(v.verdict === "OK" && v.coverage.w).toEqual(["J/P/a1"]);
  });
});

describe("② missing/stale observation -> UNVERIFIABLE, never guess", () => {
  test("business exec with fresh WORK but ABSENT roster -> UNVERIFIABLE", () => {
    const v = assertLiveness(cut([{ kind: "BUSINESS_EXEC", subjectId: "J/P/a1", executorInstance: "rw-7" }], { observations: [fresh("work-progress", "rw-7")] }), NOW);
    expect(v.verdict === "UNVERIFIABLE" && v.missing.some((m) => m.includes("roster@rw-7"))).toBe(true);
  });
  test("READY with a STALE pass-heartbeat -> UNVERIFIABLE, not STALL", () => {
    expect(assertLiveness(cut([{ kind: "READY", subjectId: "M" }], { observations: [stalE("pass-heartbeat", PASS)] }), NOW).verdict).toBe("UNVERIFIABLE");
  });
});

describe("③ same controlCut + different observations -> different verdict", () => {
  test("fresh pass-heartbeat => OK; stale => UNVERIFIABLE on the SAME cut", () => {
    const resp: LivenessResponsibility[] = [{ kind: "READY", subjectId: "M" }];
    expect(assertLiveness(cut(resp, { observations: [fresh("pass-heartbeat", PASS)] }), NOW).verdict).toBe("OK");
    expect(assertLiveness(cut(resp, { observations: [stalE("pass-heartbeat", PASS)] }), NOW).verdict).toBe("UNVERIFIABLE");
  });
});

describe("C1 (P1): match observations by identity+instance, never wildcard a missing anchor", () => {
  test("A's own WORK is stale; B's fresh WORK must NOT witness A -> UNVERIFIABLE (not OK)", () => {
    const v = assertLiveness(cut([{ kind: "BUSINESS_EXEC", subjectId: "A", executorInstance: "exec-A" }], {
      observations: [stalE("work-progress", "exec-A"), fresh("work-progress", "exec-B"), fresh("roster", "exec-A")],
    }), NOW);
    expect(v.verdict).toBe("UNVERIFIABLE");
  });
  test("a business exec with NO executorInstance -> UNVERIFIABLE (no anchor), even with other WORK present", () => {
    const v = assertLiveness(cut([{ kind: "BUSINESS_EXEC", subjectId: "A" }], { observations: [fresh("work-progress", "exec-B"), fresh("roster", "exec-B")] }), NOW);
    expect(v.verdict === "UNVERIFIABLE" && v.missing.some((m) => /not declared|instance/.test(m))).toBe(true); // no anchor => not wildcarded to exec-B
  });
  test("a shared loop heartbeat from another/undeclared instance does not witness", () => {
    expect(assertLiveness(cut([{ kind: "READY", subjectId: "M" }], { observations: [fresh("pass-heartbeat", "OTHER-disp")] }), NOW).verdict).toBe("UNVERIFIABLE");
    const noInst = assertLiveness(cut([{ kind: "READY", subjectId: "M" }], { observations: [fresh("pass-heartbeat", PASS)], modes: { sweepOn: true, taskExecOn: true } }), NOW);
    expect(noInst.verdict === "UNVERIFIABLE" && noInst.missing.some((m) => m.includes("not declared"))).toBe(true);
  });
});

describe("C2 (P2): reject future samples", () => {
  test("a pass-heartbeat sampled in the future proves nothing -> UNVERIFIABLE (not OK)", () => {
    expect(assertLiveness(cut([{ kind: "READY", subjectId: "M" }], { observations: [future("pass-heartbeat", PASS)] }), NOW).verdict).toBe("UNVERIFIABLE");
  });
});

describe("C3 (P2): groupKey (fingerprint) separate from episode-bearing incidentId", () => {
  test("groupKey is stable across seq and carries no seq/episode", () => {
    const a = assertLiveness(cut([], { seq: 100 }), NOW);
    const b = assertLiveness(cut([], { seq: 137 }), NOW);
    expect(a.verdict === "STALL" && b.verdict === "STALL" && a.groupKey === b.groupKey).toBe(true);
    if (a.verdict === "STALL") expect(a.groupKey).not.toMatch(/100|episode/);
  });
  test("same episode across seq => same incidentId; a new episode (recurrence) => different incidentId", () => {
    const e1s1 = assertLiveness(cut([], { seq: 100, openIncidentEpisode: 1 }), NOW);
    const e1s2 = assertLiveness(cut([], { seq: 200, openIncidentEpisode: 1 }), NOW);
    const e2 = assertLiveness(cut([], { seq: 300, openIncidentEpisode: 2 }), NOW);
    if (e1s1.verdict === "STALL" && e1s2.verdict === "STALL" && e2.verdict === "STALL") {
      expect(e1s1.incidentId).toBe("J:no-live-holder:episode-1");
      expect(e1s1.incidentId).toBe(e1s2.incidentId); // same episode, different seq -> stable
      expect(e2.incidentId).not.toBe(e1s1.incidentId); // closed-then-new episode -> not reused
      expect(e1s1.groupKey).toBe(e2.groupKey); // same group fingerprint either way
    }
  });
});

describe("⑤ coverage != progress", () => {
  test("OK carries a coverage breakdown, not a progress claim", () => {
    const v = assertLiveness(cut([{ kind: "BUSINESS_EXEC", subjectId: "J/P/a1", executorInstance: "rw-7" }], { observations: [fresh("work-progress", "rw-7"), fresh("roster", "rw-7")] }), NOW);
    expect(v.verdict === "OK" && v.coverage.e).toEqual(["J/P/a1"]);
    if (v.verdict === "OK") expect("progress" in v).toBe(false);
  });
});

describe("mode-off is verified-dead (STALL); one verified holder still satisfies INV-1", () => {
  test("awaiting-gate wait while sweep is OFF -> STALL", () => {
    expect(assertLiveness(cut([{ kind: "AWAITING_GATE", subjectId: "w1" }], { modes: { sweepOn: false, taskExecOn: true, passInstance: PASS } }), NOW).verdict).toBe("STALL");
  });
  test("verified READY + roster-absent BUSINESS_EXEC -> OK (the READY holds it)", () => {
    const v = assertLiveness(cut([
      { kind: "READY", subjectId: "M" },
      { kind: "BUSINESS_EXEC", subjectId: "J/P/a1", executorInstance: "rw-7" },
    ], { observations: [fresh("pass-heartbeat", PASS), fresh("work-progress", "rw-7")] }), NOW); // roster absent
    expect(v.verdict === "OK" && v.coverage.r).toEqual(["M"]);
  });
});

describe("countermodel #10: separate loop heartbeats — sweep staleness not masked by a fresh pass heartbeat", () => {
  test("awaiting-gate only; sweep-heartbeat STALE while pass-heartbeat fresh -> UNVERIFIABLE (sweep)", () => {
    const v = assertLiveness(cut([{ kind: "AWAITING_GATE", subjectId: "w1" }], { observations: [fresh("pass-heartbeat", PASS), stalE("sweep-heartbeat", SWEEP)] }), NOW);
    expect(v.verdict === "UNVERIFIABLE" && v.missing.some((m) => m.includes("sweep-heartbeat"))).toBe(true);
  });
});
