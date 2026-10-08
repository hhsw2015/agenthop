import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, chmodSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
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

  test("DB-P1-1 (round-2): a planted/foreign batch.json (batchId≠dir) is not consumed as this batch and does not seal the dir", () => {
    openBatch(HOME, { batchId: "A", owner: "coord", items: [item("1")], nowSec: 1 });
    // overwrite A/batch.json with a FOREIGN batch (batchId "B") — planted/misbound metadata in dir A
    writeFileSync(path.join(dbDir("A"), "batch.json"), JSON.stringify({ batchId: "B", owner: "x", createdAtSec: 1, items: [{ id: "1", kind: "pr", summary: "s", suggestedAction: "merge" }] }));
    writeFileSync(path.join(dbDir("A"), "decisions.json"), JSON.stringify({ batchId: "B", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve" }] }));
    expect(() => consumeDecisions(HOME, "A")).toThrow(/no such batch/);          // dir-bound readBatch ⇒ foreign batch.json reads as absent
    expect(existsSync(path.join(dbDir("A"), "consumed.json"))).toBe(false);       // NOT sealed
    // restore the correct batch.json ⇒ the real decision still works (no starvation)
    writeFileSync(path.join(dbDir("A"), "batch.json"), JSON.stringify({ batchId: "A", owner: "coord", createdAtSec: 1, items: [{ id: "1", kind: "pr", summary: "s", suggestedAction: "merge" }] }));
    writeDecisions(HOME, { batchId: "A", decidedAtSec: 3, decisions: [{ id: "1", verdict: "reject" }] });
    const got = consumeDecisions(HOME, "A");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["1", "reject"]]);
  });

  test("DB-P1-3 (round-2): the terminal marker is the batch barrier — a claim in hand cannot re-release an already-closed batch", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1")], nowSec: 1 });
    // batch already closed (consumed.json present) but a claim file is still sitting in the dir (a paused/raced consumer)
    writeFileSync(path.join(dbDir("b1"), "consumed.json"), JSON.stringify({ batchId: "b1", decidedAtSec: 2, consumedAtMs: 1 }));
    writeFileSync(path.join(dbDir("b1"), "decisions-consumed-100-aaaa.json"), JSON.stringify({ batchId: "b1", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve" }] }));
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(false);   // the terminal marker wins — the held claim is NOT executed (no double)
    expect(got.resolved).toEqual([]);
  });

  test("DB-R2-P1-1: a read fault after claiming leaves a RECOVERABLE claim — retry completes the SAME consume, no resubmit", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses chmod
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve", reason: "ok" }] });
    const dpath = path.join(dbDir("b1"), "decisions.json");
    const mode = statSync(dpath).mode & 0o777;
    chmodSync(dpath, 0o000); // consume CLAIMS it (rename needs only dir write), then faults READING the claimed file
    let blind = false; try { readFileSync(dpath); } catch { blind = true; }
    try {
      if (!blind) return; // environment can still read (root-ish)
      expect(() => consumeDecisions(HOME, "b1")).toThrow();                     // read fault surfaces; the claim persists as decisions-consumed-* (NOT "undecided")
      expect(existsSync(path.join(dbDir("b1"), "consumed.json"))).toBe(false);  // not closed on a fault
    } finally {
      // restore perms on the claimed file (named decisions-consumed-*, exactly the reviewer's probe restore pattern)
      for (const f of readdirSync(dbDir("b1"))) if (f === "decisions.json" || f.startsWith("decisions-consumed-")) chmodSync(path.join(dbDir("b1"), f), mode);
    }
    // recover permissions ⇒ retry RESUMES the claim and completes the SAME verdict with no user resubmit
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["1", "approve"]]);
  });

  test("DB-R3-P1-1: a newer failed claim supersedes an older one (stable claim name, no wall-clock ordering)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses chmod
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    const dpath = path.join(dbDir("b1"), "decisions.json");
    const failClaim = (verdict: "approve" | "reject", ts: number) => {
      writeDecisions(HOME, { batchId: "b1", decidedAtSec: ts, decisions: [{ id: "same", verdict }] });
      const mode = statSync(dpath).mode & 0o777;
      chmodSync(dpath, 0o000); // consume CLAIMS it (rename), then faults reading — leaving a recoverable claim
      try { consumeDecisions(HOME, "b1"); } catch { /* read fault expected */ }
      for (const f of readdirSync(dbDir("b1"))) if (f === "decisions.json" || f.startsWith("decisions-consumed-")) chmodSync(path.join(dbDir("b1"), f), mode);
    };
    let blind = false; writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    chmodSync(dpath, 0o000); try { readFileSync(dpath); } catch { blind = true; } chmodSync(dpath, 0o600);
    if (!blind) return; // environment can still read (root-ish)
    failClaim("approve", 20); // older claim
    failClaim("reject", 21);  // newer claim OVERWRITES the stale approve claim (stable name)
    const got = consumeDecisions(HOME, "b1"); // retry: the later (reject) wins, never the revived older approve
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["reject"]);
  });

  test("DB-R2-P2-1: a lingering notify lock without a sent-proof yields UNCERTAIN, never a silent skip or blind re-send", () => {
    openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1")], nowSec: 1 });
    // a prior notify that locked but faulted before recording the send (no notified.sent)
    writeFileSync(path.join(dbDir("b1"), "notified.lock"), JSON.stringify({ to: "user-sid", at: 1 }));
    expect(() => openBatch(HOME, { batchId: "b1", owner: "coord", items: [item("1")], nowSec: 2, notifyTo: "user-sid" })).toThrow(/unconfirmed/);
    expect(claimInbox(HOME, ["user-sid"], "probe")).toHaveLength(0); // NOT re-sent (can't prove the prior ping didn't land)
  });

  test("DB-R2-P1-1 (resid): a successful consume commits a COMPLETE consumed.json (atomic link-commit, no leftover temp)", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve" }] });
    consumeDecisions(HOME, "b1");
    expect(JSON.parse(readFileSync(path.join(dbDir("b1"), "consumed.json"), "utf8"))).toMatchObject({ batchId: "b1", decidedAtSec: 2 }); // complete/parseable
    expect(readdirSync(dbDir("b1")).some((n) => n.includes(".tmp-"))).toBe(false); // temp cleaned up
  });

  test("DB-R3-P1-1 (instance): an old reader whose claim was replaced does NOT commit its stale verdict (inode binding)", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    // old consumer's claim sits as approve; simulate a concurrent replacement AFTER it read by swapping the claim inode
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    const claim = path.join(dbDir("b1"), "decisions-consumed-claim.json");
    renameSync(path.join(dbDir("b1"), "decisions.json"), claim); // the old claim (approve)
    const readIno = statSync(claim).ino;
    // a newer consumer replaces the claim instance (reject) — different inode at the same path
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 21, decisions: [{ id: "same", verdict: "reject" }] });
    renameSync(path.join(dbDir("b1"), "decisions.json"), claim); // overwrite ⇒ new inode
    expect(statSync(claim).ino).not.toBe(readIno); // precondition: the instance changed
    // a consume now reads the CURRENT claim (reject) and commits it; the stale approve instance is gone
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["reject"]); // the live instance wins, never the replaced approve
  });

  test("DB-R3-P1-1 (commit verify-undo): a committed marker is UNDONE when the claim was replaced before the link", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    const claim = path.join(dbDir("b1"), "decisions-consumed-claim.json");
    renameSync(path.join(dbDir("b1"), "decisions.json"), claim); // O's claim (approve)
    const readIno = statSync(claim).ino;
    // simulate: O read approve, then a newer consumer replaced the claim instance (reject) before O's terminal commit
    writeFileSync(path.join(dbDir("b1"), "decisions.json"), JSON.stringify({ batchId: "b1", decidedAtSec: 21, decisions: [{ id: "same", verdict: "reject" }] }));
    renameSync(path.join(dbDir("b1"), "decisions.json"), claim); // overwrite ⇒ new inode (reject)
    expect(statSync(claim).ino).not.toBe(readIno);
    // retry consumes the live reject instance (not the stale approve); verify-undo guarantees no stale commit
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["reject"]);
  });

  test("DB-R3-P1-1 (equiv verification): a mis-archived VALID doc is recovered from the rejected slot — no valid decision lost", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    // a bound (valid) decisions doc stranded in the rejected slot — e.g. an archive restore that faulted (DB-R2-P1-1 window C)
    writeFileSync(path.join(dbDir("b1"), "decisions-rejected-claim.json"), JSON.stringify({ batchId: "b1", decidedAtSec: 9, decisions: [{ id: "same", verdict: "reject" }] }));
    const got = consumeDecisions(HOME, "b1"); // resume-fallback recovers it
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["reject"]);
    // a genuinely-foreign doc in the rejected slot is NEVER recovered (stays discarded)
    openBatch(HOME, { batchId: "b2", owner: "c", items: [item("same")], nowSec: 1 });
    writeFileSync(path.join(dbDir("b2"), "decisions-rejected-claim.json"), JSON.stringify({ batchId: "OTHER", decidedAtSec: 9, decisions: [{ id: "same", verdict: "approve" }] }));
    expect(consumeDecisions(HOME, "b2").consumed).toBe(false);
  });
});
