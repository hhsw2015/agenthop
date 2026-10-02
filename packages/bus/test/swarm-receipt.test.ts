import { describe, expect, test } from "vitest";
import { advance, type ControlRecord } from "../src/swarm/control.js";
import { encodeReceipt, parseReceipt, type Receipt, receiptAcceptable, receiptToEvent } from "../src/swarm/receipt.js";

const T0 = 1_000_000;
function rec(partial: Partial<ControlRecord> = {}): ControlRecord {
  return { launchId: "rw-aaaa", state: "RUNNING", generation: 0, allocStart: T0, budgetSec: 3480, updatedAt: T0, ...partial };
}
function receipt(partial: Partial<Receipt> = {}): Receipt {
  return { launchId: "rw-aaaa", generation: 0, requestId: "req-1", kind: "milestone", sha: "abc1234", createdAt: T0, ...partial };
}

describe("encode / parse", () => {
  test("round-trips and is byte-stable for the same receipt", () => {
    const r = receipt({ manifest: "m" });
    expect(parseReceipt(encodeReceipt(r))).toEqual(r);
    expect(encodeReceipt(r)).toBe(encodeReceipt({ ...r })); // stable key order
  });
  test("rejects malformed / oversized / bad-field input (reader sees null, not a throw)", () => {
    expect(parseReceipt("")).toBeNull();
    expect(parseReceipt("not json")).toBeNull();
    expect(parseReceipt("{}")).toBeNull();
    expect(parseReceipt(encodeReceipt(receipt({ sha: "nothex!" })))).toBeNull();
    expect(parseReceipt(encodeReceipt(receipt({ kind: "bogus" as any })))).toBeNull();
    expect(parseReceipt(JSON.stringify({ ...receipt(), generation: -1 }))).toBeNull();
    expect(parseReceipt(JSON.stringify({ ...receipt(), sha: "x".repeat(9000) }))).toBeNull();
  });
  test("tolerates a partial file (mid temp+rename) as null", () => {
    const whole = encodeReceipt(receipt());
    expect(parseReceipt(whole.slice(0, whole.length - 5))).toBeNull();
  });
});

describe("acceptance = current generation only (stale-worker fencing)", () => {
  test("accepts a receipt for the current generation + matching launchId", () => {
    expect(receiptAcceptable(rec({ generation: 2 }), receipt({ generation: 2 })).accept).toBe(true);
  });
  test("rejects a stale generation", () => {
    const c = receiptAcceptable(rec({ generation: 3 }), receipt({ generation: 2 }));
    expect(c.accept).toBe(false);
  });
  test("rejects a different launchId", () => {
    expect(receiptAcceptable(rec(), receipt({ launchId: "rw-other" })).accept).toBe(false);
  });
});

describe("receiptToEvent: drives the state machine, no rollback, state-legal", () => {
  test("milestone advances sha and the event actually applies", () => {
    const r = rec({ sha: "old0000" });
    const out = receiptToEvent(r, receipt({ sha: "new1111" }));
    expect(out.kind).toBe("advance");
    if (out.kind === "advance") {
      const res = advance(r, out.event, T0 + 1);
      expect(res.ok && res.record.sha === "new1111").toBe(true);
    }
  });
  test("a milestone re-asserting the recorded sha is a duplicate (idempotent no-op, no rollback)", () => {
    const r = rec({ sha: "same999" });
    expect(receiptToEvent(r, receipt({ sha: "same999" })).kind).toBe("duplicate");
  });
  test("final receipt only lands from DRAINING; rejected while RUNNING", () => {
    expect(receiptToEvent(rec({ state: "RUNNING" }), receipt({ kind: "final", sha: "fin0000" })).kind).toBe("reject");
    const draining = rec({ state: "DRAINING" });
    const out = receiptToEvent(draining, receipt({ kind: "final", sha: "fin0000" }));
    expect(out.kind).toBe("advance");
    if (out.kind === "advance") {
      const res = advance(draining, out.event, T0 + 1);
      expect(res.ok && res.record.state === "CHECKPOINTED" && res.record.sha === "fin0000").toBe(true);
    }
  });
  test("duplicate final after CHECKPOINTED with the same sha is a no-op", () => {
    const r = rec({ state: "CHECKPOINTED", sha: "fin0000" });
    expect(receiptToEvent(r, receipt({ kind: "final", sha: "fin0000" })).kind).toBe("duplicate");
  });
  test("done receipt from RUNNING advances to DONE; duplicate once DONE", () => {
    const out = receiptToEvent(rec(), receipt({ kind: "done", sha: "fin2222" }));
    expect(out.kind).toBe("advance");
    const done = rec({ state: "DONE", sha: "fin2222" });
    expect(receiptToEvent(done, receipt({ kind: "done", sha: "fin2222" })).kind).toBe("duplicate");
  });
  test("a stale-generation receipt is rejected before any state consideration", () => {
    const r = rec({ generation: 5, state: "DRAINING" });
    expect(receiptToEvent(r, receipt({ generation: 4, kind: "final", sha: "fin0000" })).kind).toBe("reject");
  });
});
