import { describe, expect, test } from "vitest";
import { advance, type ControlRecord } from "../src/swarm/control.js";
import { encodeReceipt, parseReceipt, type Receipt, receiptAcceptable, receiptToEvent } from "../src/swarm/receipt.js";

const T0 = 1_000_000;
function rec(partial: Partial<ControlRecord> = {}): ControlRecord {
  return { launchId: "rw-aaaa", state: "RUNNING", generation: 0, allocStart: T0, budgetSec: 3480, updatedAt: T0, ...partial };
}
function receipt(partial: Partial<Receipt> = {}): Receipt {
  return { launchId: "rw-aaaa", generation: 0, requestId: "req-1", seq: 1, kind: "milestone", sha: "abc1234", createdAt: T0, ...partial };
}

describe("encode / parse", () => {
  test("round-trips and is byte-stable", () => {
    const r = receipt({ manifest: "m", seq: 4 });
    expect(parseReceipt(encodeReceipt(r))).toEqual(r);
    expect(encodeReceipt(r)).toBe(encodeReceipt({ ...r }));
  });
  test("rejects malformed / bad seq / bad sha / partial", () => {
    expect(parseReceipt("")).toBeNull();
    expect(parseReceipt("{}")).toBeNull();
    expect(parseReceipt(encodeReceipt(receipt({ sha: "nothex!" })))).toBeNull();
    expect(parseReceipt(JSON.stringify({ ...receipt(), seq: 0 }))).toBeNull(); // seq must be >= 1
    expect(parseReceipt(JSON.stringify({ ...receipt(), seq: 1.5 }))).toBeNull();
    const whole = encodeReceipt(receipt());
    expect(parseReceipt(whole.slice(0, whole.length - 5))).toBeNull();
  });
});

describe("acceptance = current generation", () => {
  test("accepts current gen, rejects stale gen / other launchId", () => {
    expect(receiptAcceptable(rec({ generation: 2 }), receipt({ generation: 2 })).accept).toBe(true);
    expect(receiptAcceptable(rec({ generation: 3 }), receipt({ generation: 2 })).accept).toBe(false);
    expect(receiptAcceptable(rec(), receipt({ launchId: "rw-other" })).accept).toBe(false);
  });
});

describe("receiptToEvent: seq ordering prevents rollback/replay", () => {
  test("milestone advances on a higher seq and applies", () => {
    const r = rec({ sha: "old0", lastSeq: 1 });
    const out = receiptToEvent(r, receipt({ sha: "new1", seq: 2 }));
    expect(out.kind).toBe("advance");
    if (out.kind === "advance") {
      const res = advance(r, out.event, T0 + 1);
      expect(res.ok && res.record.sha === "new1" && res.record.lastSeq === 2).toBe(true);
    }
  });
  test("exact replay (same seq+sha) is a duplicate no-op", () => {
    expect(receiptToEvent(rec({ sha: "s9", lastSeq: 2 }), receipt({ sha: "s9", seq: 2 })).kind).toBe("duplicate");
  });
  test("A -> B -> replay A is REJECTED, not applied (the Codex rollback bug)", () => {
    // record already advanced to B at seq 2; a replay of the older A (seq 1) must not roll sha back.
    const atB = rec({ sha: "B", lastSeq: 2 });
    const out = receiptToEvent(atB, receipt({ sha: "A", seq: 1 }));
    expect(out.kind).toBe("reject");
  });
  test("same seq but DIFFERENT sha is rejected (conflict, not duplicate)", () => {
    expect(receiptToEvent(rec({ sha: "B", lastSeq: 2 }), receipt({ sha: "C", seq: 2 })).kind).toBe("reject");
  });
  test("final only from DRAINING, seq-guarded; duplicate after CHECKPOINTED", () => {
    expect(receiptToEvent(rec({ state: "RUNNING" }), receipt({ kind: "final", sha: "f", seq: 2 })).kind).toBe("reject");
    const draining = rec({ state: "DRAINING", lastSeq: 1 });
    const out = receiptToEvent(draining, receipt({ kind: "final", sha: "fin", seq: 2 }));
    expect(out.kind).toBe("advance");
    if (out.kind === "advance") {
      const res = advance(draining, out.event, T0 + 1);
      expect(res.ok && res.record.state === "CHECKPOINTED" && res.record.sha === "fin").toBe(true);
    }
    expect(receiptToEvent(rec({ state: "CHECKPOINTED", sha: "fin", lastSeq: 2 }), receipt({ kind: "final", sha: "fin", seq: 2 })).kind).toBe("duplicate");
  });
  test("done advances once; conflicting/duplicate handled", () => {
    expect(receiptToEvent(rec({ lastSeq: 1 }), receipt({ kind: "done", sha: "fin", seq: 2 })).kind).toBe("advance");
    expect(receiptToEvent(rec({ state: "DONE", sha: "fin", lastSeq: 2 }), receipt({ kind: "done", sha: "fin", seq: 2 })).kind).toBe("duplicate");
    expect(receiptToEvent(rec({ state: "DONE", sha: "fin", lastSeq: 2 }), receipt({ kind: "done", sha: "other", seq: 3 })).kind).toBe("reject");
  });
  test("stale generation rejected before state/seq", () => {
    expect(receiptToEvent(rec({ generation: 5, state: "DRAINING" }), receipt({ generation: 4, kind: "final", sha: "f", seq: 9 })).kind).toBe("reject");
  });
});
