import { describe, expect, test, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initialLogState, type Change } from "../src/swarm/control-log.js";
import { loadControlLog, commitControl } from "../src/swarm/control-store.js";

/**
 * control-store is the THIN IO shell (brain §4.3 step A, ownership split (B)): it persists each ok batch from the pure
 * commit() engine as <seq>.json (atomic) and rebuilds state on startup via replayLog. The CAS-then-IO discipline lives
 * at the call site (commit BEFORE startTask/allocate IO); the store's job is only durable write + faithful reload.
 */

let DIR: string;
beforeEach(() => { DIR = path.join(mkdtempSync(path.join(tmpdir(), "ah-clog-")), "control-log"); });

const files = (): string[] => { try { return readdirSync(DIR).filter((f) => /^\d+\.json$/.test(f)).sort(); } catch { return []; } };

function intent(id: string, opId: string, rev: number): Change {
  return {
    put: "intent",
    intent: {
      intentId: id, attemptId: "job/n/a0", nodeId: "n", launchId: "rw-1", bindingId: "job/n/a0/b0",
      assignmentDigest: `dig-${id}`, allocRequestStartSec: 100, workDeadlineSec: 3580, allocOutcome: "pending", status: "pending",
    },
    operationId: opId,
    expectedEntityRevision: rev,
  };
}

describe("loadControlLog", () => {
  test("a missing dir replays to the initial (seq 0) state", () => {
    expect(loadControlLog(DIR)).toEqual(initialLogState());
  });
});

describe("commitControl — persist + reload roundtrip", () => {
  test("an ok batch is persisted as <seq>.json and reload rebuilds identical state", () => {
    let s = loadControlLog(DIR);
    const r1 = commitControl(DIR, s, [intent("i1", "op1", 0)]);
    expect(r1.result.ok).toBe(true);
    s = r1.state;
    const r2 = commitControl(DIR, s, [intent("i2", "op2", 0)]);
    s = r2.state;
    expect(files()).toEqual(["1.json", "2.json"]);
    expect(s.seq).toBe(2);
    // a fresh process replays the on-disk log to the exact same state
    expect(loadControlLog(DIR)).toEqual(s);
  });

  test("a full replay (same opId, same payload) is a no-op: no new file, seq unchanged", () => {
    let s = commitControl(DIR, loadControlLog(DIR), [intent("i1", "op1", 0)]).state;
    expect(files()).toEqual(["1.json"]);
    const again = commitControl(DIR, s, [intent("i1", "op1", 0)]); // identical op replayed
    expect(again.result).toMatchObject({ ok: true, replay: true });
    expect(files()).toEqual(["1.json"]); // nothing new written
    expect(again.state.seq).toBe(1);
  });

  test("a rejected batch (stale-entity) writes no file and does not advance seq", () => {
    let s = commitControl(DIR, loadControlLog(DIR), [intent("i1", "op1", 0)]).state; // intent:i1 -> rev 1
    const stale = commitControl(DIR, s, [intent("i1", "op2", 0)]); // wrong expectedEntityRevision (0, should be 1)
    expect(stale.result).toMatchObject({ ok: false, reason: "stale-entity" });
    expect(files()).toEqual(["1.json"]);
    expect(stale.state.seq).toBe(1);
  });

  test("a leftover .tmp file from a crashed write is ignored on reload", () => {
    const s = commitControl(DIR, loadControlLog(DIR), [intent("i1", "op1", 0)]).state;
    writeFileSync(path.join(DIR, "2.json.tmp.9999"), "garbage"); // crashed partial write
    expect(loadControlLog(DIR)).toEqual(s); // only 1.json replayed, tmp ignored
  });
});
