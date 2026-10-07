import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, chmodSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
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

  const dbDir = (id: string) => path.join(HOME, ".agenthop", "console", "decision-batches", id);

  test("DB-P1-1: a decisions doc bound to another batch, dropped into this batch's dir, is never consumed as its verdicts", () => {
    openBatch(HOME, { batchId: "A", owner: "coord", items: [item("1")], nowSec: 1 });
    openBatch(HOME, { batchId: "B", owner: "coord", items: [item("1")], nowSec: 1 });
    // a foreign/misplaced write bypassing writeDecisions' dir derivation: batch B's doc sitting in batch A's directory
    writeFileSync(path.join(dbDir("A"), "decisions.json"), JSON.stringify({ batchId: "B", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve" }] }));
    const got = consumeDecisions(HOME, "A");
    expect(got.consumed).toBe(false);
    expect(got.resolved).toEqual([]);                 // B's approve never authorizes A's item 1 (same id, different batch)
    expect(got.undecided.map((i) => i.id)).toEqual(["1"]);
    expect(got.unknownIds).toEqual(["1"]);            // reported as foreign, acted on by nothing
    // the misbound claim did NOT mark A consumed ⇒ A's REAL decisions still work afterwards (no foreign-drop DoS)
    writeDecisions(HOME, { batchId: "A", decidedAtSec: 3, decisions: [{ id: "1", verdict: "reject" }] });
    const real = consumeDecisions(HOME, "A");
    expect(real.consumed).toBe(true);
    expect(real.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["1", "reject"]]);
  });

  test("DB-P1-2: consume returns the verdicts it ACTUALLY claimed (reads after the atomic claim, not a pre-claim cache)", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 2, decisions: [{ id: "1", verdict: "reject", reason: "dup" }] });
    const got = consumeDecisions(HOME, "b1");
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["1", "reject"]]);
    // what we returned == the bytes renamed aside under decisions-consumed-* (the claimed file), not whatever decisions.json held
    const consumedName = readdirSync(dbDir("b1")).find((n) => n.startsWith("decisions-consumed-"));
    expect(consumedName).toBeTruthy();
    const claimed = JSON.parse(readFileSync(path.join(dbDir("b1"), consumedName!), "utf8"));
    expect(claimed.decisions).toEqual([{ id: "1", verdict: "reject", reason: "dup" }]);
  });

  test("DB-P1-3: a consumed batch never re-releases — re-written decisions are refused at write and ignored at consume", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1"), item("2")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve" }, { id: "2", verdict: "defer" }] });
    const first = consumeDecisions(HOME, "b1");
    expect(first.consumed).toBe(true);
    expect(first.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["1", "approve"], ["2", "defer"]]);
    // write boundary: the console cannot resubmit into a consumed batch — a deferred item can't be flipped to approve here
    expect(() => writeDecisions(HOME, { batchId: "b1", decidedAtSec: 3, decisions: [{ id: "2", verdict: "approve" }] })).toThrow(/already consumed/);
    // even a raw/foreign re-write of decisions.json is not re-consumed (same approve never becomes actionable twice)
    writeFileSync(path.join(dbDir("b1"), "decisions.json"), JSON.stringify({ batchId: "b1", decidedAtSec: 4, decisions: [{ id: "1", verdict: "approve" }, { id: "2", verdict: "approve" }] }));
    const again = consumeDecisions(HOME, "b1");
    expect(again.consumed).toBe(false);
    expect(again.resolved).toEqual([]);
  });

  test("DB-P1-4: a notify failure is VISIBLE and re-notifies on retry; after success a repeat open does not re-notify", () => {
    // block the inbox write: make .agenthop/inbox a FILE so writeInbox's mkdir fails (ENOTDIR) — a deterministic FS fault
    mkdirSync(path.join(HOME, ".agenthop"), { recursive: true });
    writeFileSync(path.join(HOME, ".agenthop", "inbox"), "x");
    expect(() => openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1")], nowSec: 1700000000, notifyTo: "user-sid" })).toThrow();
    expect(readBatch(HOME, "b1")!.items).toHaveLength(1);                       // batch IS persisted
    expect(existsSync(path.join(dbDir("b1"), "notified.json"))).toBe(false);    // but not marked notified (failure left no marker)
    // recover the FS, retry same batchId ⇒ exactly one ping lands now (the preserved re-notify path)
    rmSync(path.join(HOME, ".agenthop", "inbox"));
    openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1")], nowSec: 1700000001, notifyTo: "user-sid" });
    openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1")], nowSec: 1700000002, notifyTo: "user-sid" }); // success ⇒ no re-notify
    const c = claimInbox(HOME, ["user-sid"], "probe");
    expect(c).toHaveLength(1);
    expect(c[0].msg).toMatchObject({ via: "decision-batch", taskRef: "decision-batch:b1" });
  });
});
