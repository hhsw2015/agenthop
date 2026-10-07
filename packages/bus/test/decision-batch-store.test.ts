import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, chmodSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBatch, readBatch, writeDecisions, readDecisions, consumeDecisions, listBatches } from "../src/swarm/decision-batch-store.js";
import { type DecisionItem } from "../src/swarm/decision-batch.js";
import { claimInbox } from "../src/inbox.js";

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-dbatch-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const item = (id: string): DecisionItem => ({ id, kind: "pr", summary: `merge PR ${id}?`, suggestedAction: "merge", evidenceRef: `pr://${id}` });

describe("decision-batch store (IO)", () => {
  test("openBatch persists + is idempotent; readBatch round-trips", () => {
    const b = openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1"), item("2")], nowSec: 100 });
    expect(b).toMatchObject({ batchId: "b1", owner: "coord" });
    expect(b.items).toHaveLength(2);
    expect(openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("9")], nowSec: 999 }).items).toHaveLength(2); // idempotent, no reset
    expect(readBatch(HOME, "b1")!.items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  test("an unsafe batchId is REJECTED", () => {
    expect(() => openBatch(HOME, { batchId: "..", owner: "c", items: [item("1")], nowSec: 1 })).toThrow(/unsafe/);
    expect(() => openBatch(HOME, { batchId: "a/b", owner: "c", items: [item("1")], nowSec: 1 })).toThrow(/unsafe/);
    expect(() => readDecisions(HOME, "..")).toThrow(/unsafe/);
  });

  test("openBatch with notifyTo writes ONE durable-inbox notification (the compression ping)", () => {
    openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1"), item("2"), item("3")], nowSec: 1700000000, notifyTo: "user-sid" });
    const c = claimInbox(HOME, ["user-sid"], "probe");
    expect(c).toHaveLength(1);
    expect(c[0].msg).toMatchObject({ via: "decision-batch", taskRef: "decision-batch:b1" });
    expect(c[0].msg.text).toMatch(/3 decision/);
  });

  test("consumeDecisions: before decisions ⇒ not consumed, all undecided; after ⇒ resolved + consumed; second call ⇒ consume-once", () => {
    openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1"), item("2"), item("3")], nowSec: 100 });
    const pre = consumeDecisions(HOME, "b1");
    expect(pre).toMatchObject({ consumed: false });
    expect(pre.undecided.map((i) => i.id)).toEqual(["1", "2", "3"]);

    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 200, decisions: [
      { id: "1", verdict: "approve" }, { id: "2", verdict: "reject", reason: "dup" }, { id: "zzz", verdict: "approve" },
    ] });
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["1", "approve"], ["2", "reject"]]);
    expect(got.undecided.map((i) => i.id)).toEqual(["3"]); // item 3 had no verdict
    expect(got.unknownIds).toEqual(["zzz"]);

    const again = consumeDecisions(HOME, "b1"); // consume-once: decisions already claimed
    expect(again.consumed).toBe(false);
    expect(again.undecided.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  test("consumeDecisions throws on a missing batch; writeDecisions rejects an invalid doc", () => {
    expect(() => consumeDecisions(HOME, "ghost")).toThrow(/no such batch/);
    expect(() => writeDecisions(HOME, { batchId: "b1", decidedAtSec: 1, decisions: [{ id: "a", verdict: "nope" as never }] })).toThrow();
  });

  test("listBatches indexes batches that have batch.json", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1")], nowSec: 1 });
    openBatch(HOME, { batchId: "b2", owner: "c", items: [item("1")], nowSec: 1 });
    mkdirSync(path.join(HOME, ".agenthop", "console", "decision-batches", "nobatch"), { recursive: true });
    expect(listBatches(HOME).sort()).toEqual(["b1", "b2"]);
  });

  test("a read failure (EACCES) is NOT 'absent' — readBatch throws, openBatch refuses to overwrite (non-root)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses chmod
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1")], nowSec: 1 });
    const bf = path.join(HOME, ".agenthop", "console", "decision-batches", "b1", "batch.json");
    const mode = statSync(bf).mode & 0o777;
    chmodSync(bf, 0o000);
    let blind = false; try { readFileSync(bf); } catch { blind = true; }
    try {
      if (!blind) return; // environment can still read (root-ish)
      expect(() => readBatch(HOME, "b1")).toThrow();
      expect(() => openBatch(HOME, { batchId: "b1", owner: "c", items: [item("x")], nowSec: 2 })).toThrow(); // no silent overwrite
    } finally { chmodSync(bf, mode); }
  });
});
