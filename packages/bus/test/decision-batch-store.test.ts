import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, chmodSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { openBatch, readBatch, writeDecisions, readDecisions, consumeDecisions, listBatches, listBatchesStrict, recordDecision } from "../src/swarm/decision-batch-store.js";
import { type DecisionItem } from "../src/swarm/decision-batch.js";
import { collectBandwidthEvents } from "../src/swarm/dual-bandwidth-store.js";
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
  // Write a RAW slot into the append-only ledger (bypassing the API) — simulates a planted/late/foreign publish for the invariant tests.
  const rawSlot = (id: string, n: number, doc: unknown) => {
    mkdirSync(path.join(dbDir(id), "seq"), { recursive: true });
    writeFileSync(path.join(dbDir(id), "seq", `${n}.json`), JSON.stringify(doc));
  };

  test("DB-P1-1: a slot bound to another batch, planted in this batch's dir, is never consumed as its verdicts", () => {
    openBatch(HOME, { batchId: "A", owner: "coord", items: [item("1")], nowSec: 1 });
    openBatch(HOME, { batchId: "B", owner: "coord", items: [item("1")], nowSec: 1 });
    // a foreign/misplaced publish: batch B's decision sitting as a slot in batch A's ledger
    rawSlot("A", 0, { batchId: "B", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve" }] });
    const got = consumeDecisions(HOME, "A");
    expect(got.consumed).toBe(false);
    expect(got.resolved).toEqual([]);                 // B's approve never authorizes A's item 1 (same id, different batch) — readSlots drops it
    expect(got.undecided.map((i) => i.id)).toEqual(["1"]);
    // the foreign slot did NOT mark A consumed ⇒ A's REAL decisions still work afterwards (no foreign-drop DoS)
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
    // what we returned == the canonical consumed-record projection (the folded slot ledger), written at consume
    const claimed = JSON.parse(readFileSync(path.join(dbDir("b1"), "decisions-consumed-claim.json"), "utf8"));
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
    // even a raw late slot appended after the seal is not re-consumed (same approve never becomes actionable twice)
    rawSlot("b1", 1, { batchId: "b1", decidedAtSec: 4, decisions: [{ id: "1", verdict: "approve" }, { id: "2", verdict: "approve" }] });
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

  test("DB-R2-P1-1 (slot): a read fault on a slot during consume is RECOVERABLE — retry completes the SAME verdict, no resubmit, no seal on the fault", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses chmod
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("1")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve", reason: "ok" }] }); // slot 0
    const s0 = path.join(dbDir("b1"), "seq", "0.json");
    const mode = statSync(s0).mode & 0o777;
    chmodSync(s0, 0o000); // consume reads the slot ledger and FAULTS reading slot 0 — the immutable slot is intact, just unreadable now
    let blind = false; try { readFileSync(s0); } catch { blind = true; }
    try {
      if (!blind) return; // environment can still read (root-ish)
      expect(() => consumeDecisions(HOME, "b1")).toThrow();                     // read fault PROPAGATES (never a silent drop)
      expect(existsSync(path.join(dbDir("b1"), "consumed.json"))).toBe(false);  // NOT sealed on a fault
    } finally { chmodSync(s0, mode); }
    // recover permissions ⇒ retry re-reads the SAME immutable slot and completes the SAME verdict with no user resubmit
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["1", "approve"]]);
  });

  test("DB-R3-P1-1 (slot): a LATER slot supersedes an earlier one by slot order — DURABLE under a permission change (ctime drift can't reorder)", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] }); // slot 0
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 21, decisions: [{ id: "same", verdict: "reject" }] });  // slot 1 (later publish)
    // a permission change on the OLDER slot advances its ctime but NOT its slot number — the order must not drift (the ctime-killer).
    if (!(typeof process.getuid === "function" && process.getuid() === 0)) {
      const s0 = path.join(dbDir("b1"), "seq", "0.json"); const mode = statSync(s0).mode & 0o777;
      chmodSync(s0, 0o400); chmodSync(s0, mode);
    }
    const got = consumeDecisions(HOME, "b1"); // the later slot (reject) wins, never the revived older approve
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

  // (The round-5 claim-inode / commit-verify-undo / rejected-slot-recovery tests are retired: the slot ledger has NO mutable claim
  //  to swap or mis-archive — each slot is an IMMUTABLE record, never renamed, so those races cannot occur. The invariant they
  //  guarded — a stale verdict is never committed and no valid decision is lost — is now structural and covered below + by DB-R3-P1-1 (slot).)
  test("DB-R3-P1-1 (slot): concurrent publishers get DISTINCT slots and the later one wins the fold; a foreign slot is dropped, not lost-as", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    rawSlot("b1", 0, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] }); // slot 0
    rawSlot("b1", 1, { batchId: "b1", decidedAtSec: 21, decisions: [{ id: "same", verdict: "reject" }] });  // slot 1 (later)
    rawSlot("b1", 2, { batchId: "OTHER", decidedAtSec: 99, decisions: [{ id: "same", verdict: "approve" }] }); // foreign slot — dropped by readSlots
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["reject"]); // the later bound slot wins; the foreign slot never authorizes anything
  });

  // ---- R24: unified per-batch lock (no stale commit + valid recoverable, by excluding concurrent replacement) ----
  const lockDir = (id: string) => path.join(dbDir(id), "consume.lockd");
  const holdLock = (id: string, pid: number, nonce = "n") => { mkdirSync(lockDir(id), { recursive: true }); writeFileSync(path.join(lockDir(id), `${pid}.${nonce}`), ""); };

  test("R24: a consume whose batch lock is held by a LIVE holder returns an explicit contended receipt (decision stays recoverable)", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    holdLock("b1", 1); // a DIFFERENT live holder (init, pid 1 — not us)
    const contended = consumeDecisions(HOME, "b1");
    expect(contended).toMatchObject({ consumed: false, contended: true }); // explicit receipt, NOT a silent/stale consume
    expect(contended.resolved).toEqual([]);
    rmSync(lockDir("b1"), { recursive: true }); // holder releases
    const got = consumeDecisions(HOME, "b1"); // the decision was never lost — now it consumes
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["approve"]);
  });

  test("R24 (newer wins): a FRESH decisions.json supersedes a stale doc stranded in the rejected slot — the latest is consumed, not the older", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    // older valid decision stranded in the rejected slot (e.g. a prior mis-archive)
    writeFileSync(path.join(dbDir("b1"), "decisions-rejected-claim.json"), JSON.stringify({ batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] }));
    // a NEWER user decision in decisions.json (writeDecisions is unlocked ⇒ always accepted)
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 21, decisions: [{ id: "same", verdict: "reject" }] });
    const got = consumeDecisions(HOME, "b1");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["reject"]); // the fresh reject wins over the stranded approve
  });

  test("R24: a DEAD lock holder is reclaimed — a crashed consumer never wedges the batch", () => {
    if (typeof process.getuid !== "function") return;
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    // find a pid that is definitely dead
    let deadPid = 2147480000; for (let p = 2147480000; p < 2147480050; p++) { try { process.kill(p, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") { deadPid = p; break; } } }
    holdLock("b1", deadPid); // a dead holder left its identity file
    const got = consumeDecisions(HOME, "b1"); // steals the stale lock
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.verdict)).toEqual(["approve"]);
  });

  test("R25 orphan: a NEWER decision arriving after consume emits a re-batch signal that REACHES the owner (coordinator), once", () => {
    openBatch(HOME, { batchId: "b1", owner: "coord-sid", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    expect(consumeDecisions(HOME, "b1").resolved.map((r) => r.verdict)).toEqual(["approve"]); // consumed.decidedAtSec=20
    // a NEWER valid decision lands (a later slot) after the batch is terminal — an orphan
    rawSlot("b1", 1, { batchId: "b1", decidedAtSec: 21, decisions: [{ id: "same", verdict: "reject" }] });
    expect(consumeDecisions(HOME, "b1").consumed).toBe(false); // terminal — detects the orphan + signals the owner
    const first = claimInbox(HOME, ["coord-sid"], "probe").map((c) => c.msg);
    const orphan = first.find((m) => m.title === "orphan decision — re-batch");
    expect(orphan).toBeTruthy();                       // the re-batch signal ACTUALLY reached the owner's inbox
    expect(orphan!.taskRef).toBe("decision-batch:b1");
    expect(orphan!.via).toBe("decision-batch");
    consumeDecisions(HOME, "b1"); // once-only: no second signal
    expect(claimInbox(HOME, ["coord-sid"], "probe2").some((c) => c.msg.title === "orphan decision — re-batch")).toBe(false);
  });

  test("R25 orphan: a decision IDENTICAL to the consumed verdict is NOT re-signaled (already fulfilled — content digest match, not a clock)", () => {
    openBatch(HOME, { batchId: "b1", owner: "coord-sid", items: [item("same")], nowSec: 1 });
    const d = { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "reject" as const }] };
    writeDecisions(HOME, d);
    consumeDecisions(HOME, "b1"); // consumed.json records the content digest of d
    rawSlot("b1", 1, d); // a later slot with the SAME decision (same content)
    consumeDecisions(HOME, "b1");
    expect(claimInbox(HOME, ["coord-sid"], "probe").some((c) => c.msg.title === "orphan decision — re-batch")).toBe(false); // identical ⇒ already fulfilled ⇒ no signal
  });

  test("R25 orphan: a SAME-SECOND different decision after consume IS signaled (digest, not decidedAtSec, decides identity)", () => {
    openBatch(HOME, { batchId: "b1", owner: "coord-sid", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    consumeDecisions(HOME, "b1");
    rawSlot("b1", 1, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "reject" }] }); // a later slot, SAME second, different content
    consumeDecisions(HOME, "b1");
    expect(claimInbox(HOME, ["coord-sid"], "probe").some((c) => c.msg.title === "orphan decision — re-batch")).toBe(true); // different content ⇒ orphan (digest, not decidedAtSec)
  });

  test("DB-R7: a consume NEVER steals or deletes a LIVE holder's lock (instance-bound; the race can't double-execute)", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    holdLock("b1", 1, "peer-live"); // a LIVE foreign holder (init, pid 1)
    const r = consumeDecisions(HOME, "b1");
    expect(r).toMatchObject({ consumed: false, contended: true });   // contended — not stolen
    expect(existsSync(path.join(lockDir("b1"), "1.peer-live"))).toBe(true); // the live holder's identity file is UNTOUCHED
  });

  test("R24: the terminal commit is FINAL (no retraction) — once consumed, a late write is refused and re-consume is terminal", () => {
    openBatch(HOME, { batchId: "b1", owner: "c", items: [item("same")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "b1", decidedAtSec: 20, decisions: [{ id: "same", verdict: "approve" }] });
    expect(consumeDecisions(HOME, "b1").resolved.map((r) => r.verdict)).toEqual(["approve"]);
    expect(() => writeDecisions(HOME, { batchId: "b1", decidedAtSec: 21, decisions: [{ id: "same", verdict: "reject" }] })).toThrow(/already consumed/);
    expect(consumeDecisions(HOME, "b1").consumed).toBe(false); // terminal, final
  });
});

// TG entry (user-entry layer): two entries (console + TG) over the SINGLE decision ledger. The consume-once seal means
// whoever decides FIRST wins and the other entry's later verdict is a NO-OP — no double-execute, no fork. (Coordinator-
// mandated counterexample for the tg-entry charter.)
describe("two entries, one ledger: consume-once makes the second entry a no-op (no fork)", () => {
  test("console approves first -> a later TG reject is a no-op (write refused, never executed)", () => {
    openBatch(HOME, { batchId: "e1", owner: "coord", items: [item("1")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "e1", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve" }] }); // console
    const first = consumeDecisions(HOME, "e1");
    expect(first.consumed).toBe(true);
    expect(first.resolved.map((r) => r.verdict)).toEqual(["approve"]);
    // TG, later: the batch is sealed, so the conflicting write is REFUSED (the strongest no-fork — it never reaches the ledger).
    expect(() => writeDecisions(HOME, { batchId: "e1", decidedAtSec: 3, decisions: [{ id: "1", verdict: "reject" }] })).toThrow(/already consumed/);
    const second = consumeDecisions(HOME, "e1");
    expect(second.consumed).toBe(false);     // terminal; nothing new to execute
    expect(second.resolved).toEqual([]);      // the TG reject NEVER executes
  });
  test("bidirectional: TG approves first -> a later console reject is a no-op (write refused)", () => {
    openBatch(HOME, { batchId: "e2", owner: "coord", items: [item("1")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "e2", decidedAtSec: 2, decisions: [{ id: "1", verdict: "approve", scope: "once" }] }); // TG (carries a scope)
    const first = consumeDecisions(HOME, "e2");
    expect(first.consumed).toBe(true);
    expect(first.resolved.map((r) => r.verdict)).toEqual(["approve"]);
    expect(() => writeDecisions(HOME, { batchId: "e2", decidedAtSec: 3, decisions: [{ id: "1", verdict: "reject" }] })).toThrow(/already consumed/); // console, later
    const second = consumeDecisions(HOME, "e2");
    expect(second.consumed).toBe(false);
    expect(second.resolved).toEqual([]);
  });
});

// TG-P1-2 / TG-P1-1 at the store: recordDecision MERGES one item (never overwrites siblings) + clamps a hard-gate scope.
describe("recordDecision (atomic single-item merge for an entry tap)", () => {
  test("TG-P1-2: a second item's tap preserves the first (no snapshot overwrite)", () => {
    openBatch(HOME, { batchId: "m1", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    expect(recordDecision(HOME, "m1", { id: "a", verdict: "approve" }, 2)).toBe("recorded");
    expect(recordDecision(HOME, "m1", { id: "b", verdict: "reject" }, 3)).toBe("recorded");
    const doc = readDecisions(HOME, "m1")!;
    expect(doc.decisions.map((d) => d.id).sort()).toEqual(["a", "b"]); // BOTH survive
    expect(doc.decisions.find((d) => d.id === "a")!.verdict).toBe("approve");
  });
  test("TG-P1-1: a hard-gate item's 'always' is clamped to once on write", () => {
    openBatch(HOME, { batchId: "m2", owner: "coord", items: [{ id: "x", kind: "spend", summary: "pay", suggestedAction: "approve", hardGate: true }], nowSec: 1 });
    expect(recordDecision(HOME, "m2", { id: "x", verdict: "approve", scope: "always" }, 2)).toBe("recorded");
    expect(readDecisions(HOME, "m2")!.decisions[0]!.scope).toBe("once"); // never records the expanded grant
  });
  test("a tap on a sealed batch is a no-op (consumed), not a fork", () => {
    openBatch(HOME, { batchId: "m3", owner: "coord", items: [item("a")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "m3", decidedAtSec: 2, decisions: [{ id: "a", verdict: "approve" }] });
    expect(consumeDecisions(HOME, "m3").consumed).toBe(true);
    expect(recordDecision(HOME, "m3", { id: "a", verdict: "reject" }, 3)).toBe("consumed"); // sealed -> no write
  });
  test("an unknown item id -> unknown-item (never written)", () => {
    openBatch(HOME, { batchId: "m4", owner: "coord", items: [item("a")], nowSec: 1 });
    expect(recordDecision(HOME, "m4", { id: "ghost", verdict: "approve" }, 2)).toBe("unknown-item");
    expect(readDecisions(HOME, "m4")).toBeNull();
  });
});

// TG round-3 counterexamples: a single-item entry tap must NEVER lose a sibling decision — not one stranded in a recoverable
// claim (a faulted consume), nor one a concurrent console full-snapshot write landed. Plus the strict lister's read-error vs absence.
describe("TG-P1-2 (round 3): a tap never drops a sibling (recoverable claim / concurrent snapshot)", () => {
  const dbDir = (id: string) => path.join(HOME, ".agenthop", "console", "decision-batches", id);
  const batchesDir = () => path.join(HOME, ".agenthop", "console", "decision-batches");

  // (counterexample A — "a tap preserves a decision stranded in a recoverable claim" — is retired: the slot ledger has no claim
  //  to strand; both the console publish and the tap are independent immutable slots, so neither can lose the other, as below.)
  test("counterexample B (R6 semantics): a console full snapshot AFTER a tap REPLACES it (the snapshot is the complete console view)", () => {
    openBatch(HOME, { batchId: "cb", owner: "coord", items: [item("a"), item("c")], nowSec: 1 });
    expect(recordDecision(HOME, "cb", { id: "a", verdict: "approve" }, 2)).toBe("recorded"); // TG tap (slot 0)
    writeDecisions(HOME, { batchId: "cb", decidedAtSec: 5, decisions: [{ id: "c", verdict: "approve" }] }); // console full snapshot (slot 1) — omits a
    const doc = readDecisions(HOME, "cb")!;
    expect(doc.decisions.map((d) => d.id)).toEqual(["c"]); // the later full snapshot REPLACES the earlier tap (baseline parity, TG-R6-P1-1)
    const r = consumeDecisions(HOME, "cb");
    expect(r.resolved.map((x) => x.item.id)).toEqual(["c"]);
    // (the complementary snapshot->tap MERGE case is covered by "TG-R3-P2-1: a console slot + a tap slot BOTH appear")
  });

  test("TG-P1-1: writeDecisions (console path) clamps a hard-gate 'always' to once at the WRITE boundary", () => {
    openBatch(HOME, { batchId: "wd", owner: "coord", items: [{ id: "x", kind: "spend", summary: "pay", suggestedAction: "approve", hardGate: true }], nowSec: 1 });
    writeDecisions(HOME, { batchId: "wd", decidedAtSec: 2, decisions: [{ id: "x", verdict: "approve", scope: "always" }] });
    expect(readDecisions(HOME, "wd")!.decisions[0]!.scope).toBe("once"); // never SAVES the expanded grant
  });

  test("TG-P2-1: listBatchesStrict THROWS on an unreadable batches dir (listBatches folds to [])", () => {
    openBatch(HOME, { batchId: "s1", owner: "coord", items: [item("a")], nowSec: 1 });
    openBatch(HOME, { batchId: "s2", owner: "coord", items: [item("a")], nowSec: 1 });
    expect(listBatchesStrict(HOME).sort()).toEqual(["s1", "s2"]);
    const dir = batchesDir(); const mode = statSync(dir).mode;
    chmodSync(dir, 0o000);
    try {
      expect(() => listBatchesStrict(HOME)).toThrow();   // a read error is NOT "no batches" (keep the retry obligation)
      expect(listBatches(HOME)).toEqual([]);             // the best-effort lister still folds it to []
    } finally { chmodSync(dir, mode); }
  });

  test("a confirmed-absent batches dir is [] for BOTH listers (ENOENT ⇒ no batches, not an error)", () => {
    expect(listBatchesStrict(HOME)).toEqual([]);
    expect(listBatches(HOME)).toEqual([]);
  });
});

// TG round-4 counterexamples (codex r3 verdict, 3 REMAIN): fold by WRITE order (not the 1s decidedAtSec), a LOSSLESS tap key
// (distinct ids that UTF-8-alias must not collide), and a CANONICAL consumed record the existing read/bandwidth side can read.
describe("TG r4: write-order fold, lossless tap key, canonical consumed record", () => {
  const d = (id: string) => path.join(HOME, ".agenthop", "console", "decision-batches", id);

  test("TG-R3-P1-1: a later-WRITTEN console reject in the SAME second beats an earlier tap approve", () => {
    openBatch(HOME, { batchId: "wo", owner: "coord", items: [item("a")], nowSec: 1 });
    expect(recordDecision(HOME, "wo", { id: "a", verdict: "approve" }, 1000)).toBe("recorded"); // tap, written first
    writeDecisions(HOME, { batchId: "wo", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "reject" }] }); // console, written AFTER
    expect(readDecisions(HOME, "wo")!.decisions.find((x) => x.id === "a")!.verdict).toBe("reject");
    expect(consumeDecisions(HOME, "wo").resolved[0]!.verdict).toBe("reject"); // the later write wins, not a fixed entry preference
  });

  test("TG-R3-P1-1 reverse: a later-WRITTEN tap beats an earlier console write (same second)", () => {
    openBatch(HOME, { batchId: "wr", owner: "coord", items: [item("a")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "wr", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "reject" }] }); // console first
    expect(recordDecision(HOME, "wr", { id: "a", verdict: "approve" }, 1000)).toBe("recorded"); // tap written AFTER
    expect(consumeDecisions(HOME, "wr").resolved[0]!.verdict).toBe("approve");
  });

  test("TG-P1-2: distinct item ids whose UTF-8 encodings ALIAS do not overwrite each other's tap", () => {
    const ids = ["\ud800", "�"]; // an unpaired surrogate vs the replacement char: distinct ids, identical UTF-8 bytes
    expect(ids[0]).not.toBe(ids[1]);
    openBatch(HOME, { batchId: "al", owner: "coord", items: ids.map((x) => item(x)), nowSec: 1 });
    expect(recordDecision(HOME, "al", { id: ids[0]!, verdict: "approve" }, 1000)).toBe("recorded");
    expect(recordDecision(HOME, "al", { id: ids[1]!, verdict: "reject" }, 1001)).toBe("recorded");
    const got = consumeDecisions(HOME, "al");
    expect(got.resolved.length).toBe(2); // both survive — no silent overwrite
    expect(got.undecided.length).toBe(0);
  });

  for (const mode of ["tap-only", "mixed"] as const) {
    test(`TG-R3-P2-1 (${mode}): the consumed claim holds the FULL merged record; bandwidth counts every consumed item`, () => {
      openBatch(HOME, { batchId: "cr", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
      if (mode === "mixed") writeDecisions(HOME, { batchId: "cr", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "approve" }] });
      else expect(recordDecision(HOME, "cr", { id: "a", verdict: "approve" }, 1000)).toBe("recorded");
      expect(recordDecision(HOME, "cr", { id: "b", verdict: "reject" }, 1001)).toBe("recorded");
      expect(consumeDecisions(HOME, "cr").resolved.length).toBe(2);
      const claim = JSON.parse(readFileSync(path.join(d("cr"), "decisions-consumed-claim.json"), "utf8"));
      expect(claim.decisions.length).toBe(2);                              // canonical consumed record is complete
      expect(collectBandwidthEvents(HOME).consumeAtSec.length).toBe(2);    // bandwidth sees both consumed items (not 0/1)
    });
  }

  test("TG-R3-P2-1: a console slot + a tap slot BOTH appear in readDecisions (backlog not miscounted)", () => {
    openBatch(HOME, { batchId: "rc", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "rc", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "approve" }] }); // slot 0
    expect(recordDecision(HOME, "rc", { id: "b", verdict: "reject" }, 1001)).toBe("recorded");                 // slot 1
    expect(readDecisions(HOME, "rc")!.decisions.map((x) => x.id).sort()).toEqual(["a", "b"]); // both slots fold in
    expect(collectBandwidthEvents(HOME).backlog).toBe(0);                 // both decided -> no backlog miscount
  });

  test("TG-P2-1: an unreadable slot dir does NOT seal (throws, recovers on retry)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses chmod
    openBatch(HOME, { batchId: "ut", owner: "coord", items: [item("a")], nowSec: 1 });
    expect(recordDecision(HOME, "ut", { id: "a", verdict: "approve" }, 1000)).toBe("recorded");
    const seq = path.join(d("ut"), "seq"); const mode = statSync(seq).mode;
    chmodSync(seq, 0o000);
    try {
      expect(() => readDecisions(HOME, "ut")).toThrow();
      expect(() => consumeDecisions(HOME, "ut")).toThrow();
      expect(existsSync(path.join(d("ut"), "consumed.json"))).toBe(false); // never sealed on a read failure
    } finally { chmodSync(seq, mode); }
    const got = consumeDecisions(HOME, "ut");
    expect(got.consumed).toBe(true); expect(got.resolved.length).toBe(1); // recovers once readable
  });
});


// TG round-6 (codex r5 verdict + coordinator ruling): ctime is NOT a durable, version-bound publish order — a rename moves it, a
// CHMOD advances it with identical content (proven on APFS), a stat-after-read skews it, a retry loses a stack-local order. The
// publish order is now the APPEND-ONLY SLOT LEDGER: each decision EXCLUSIVE-creates the next seq/<n>.json; the slot NUMBER is the
// durable, immutable, version-bound order; read and consume fold the SAME slots. These assert the properties ctime failed to hold.
describe("TG r6: slot-ledger durable publish order", () => {
  const d = (id: string) => path.join(HOME, ".agenthop", "console", "decision-batches", id);
  const slot = (id: string, n: number, doc: unknown) => { mkdirSync(path.join(d(id), "seq"), { recursive: true }); writeFileSync(path.join(d(id), "seq", `${n}.json`), JSON.stringify(doc)); };

  test("the ctime-killer: a permission change on the older slot (identical content, advanced ctime) does NOT reorder — the later slot wins", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses chmod
    openBatch(HOME, { batchId: "ck", owner: "coord", items: [item("a")], nowSec: 1 });
    slot("ck", 0, { batchId: "ck", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "approve" }] }); // earlier publish
    slot("ck", 1, { batchId: "ck", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "reject" }] });  // later publish (SAME second)
    const s0 = path.join(d("ck"), "seq", "0.json"); const mode = statSync(s0).mode & 0o777;
    chmodSync(s0, 0o400); chmodSync(s0, mode); // advances slot 0's ctime with UNCHANGED content — a ctime order would now wrongly pick approve
    expect(readDecisions(HOME, "ck")!.decisions[0]!.verdict).toBe("reject"); // slot order is immune to the ctime bump
    expect(consumeDecisions(HOME, "ck").resolved[0]!.verdict).toBe("reject");
  });

  test("read and consume agree on the SAME slot order (no per-reader divergence)", () => {
    openBatch(HOME, { batchId: "ag", owner: "coord", items: [item("a")], nowSec: 1 });
    expect(recordDecision(HOME, "ag", { id: "a", verdict: "approve" }, 1000)).toBe("recorded"); // slot 0
    writeDecisions(HOME, { batchId: "ag", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "reject" }] }); // slot 1 (later)
    expect(readDecisions(HOME, "ag")!.decisions[0]!.verdict).toBe("reject"); // read
    expect(consumeDecisions(HOME, "ag").resolved[0]!.verdict).toBe("reject"); // consume — identical order
  });

  test("control: the canonical claim survives a seal failure; a later tap + retry still consumes all (latest wins by slot)", () => {
    openBatch(HOME, { batchId: "cf", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "cf", decidedAtSec: 1000, decisions: [{ id: "a", verdict: "approve" }] }); // slot 0
    expect(recordDecision(HOME, "cf", { id: "b", verdict: "approve" }, 1001)).toBe("recorded");               // slot 1
    const marker = path.join(d("cf"), "consumed.json");
    const orig = fs.linkSync; let injected = false;
    const spy = vi.spyOn(fs, "linkSync").mockImplementation(((s: unknown, dst: unknown) => {
      if (String(dst) === marker && !injected) { injected = true; throw Object.assign(new Error("seal unavailable"), { code: "EACCES" }); }
      return (orig as (ss: unknown, dd: unknown) => void)(s, dst);
    }) as typeof fs.linkSync);
    syncBuiltinESMExports();
    try { expect(() => consumeDecisions(HOME, "cf")).toThrow(); } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(injected).toBe(true);
    expect(existsSync(marker)).toBe(false);                                   // not sealed on the seal fault
    expect(readDecisions(HOME, "cf")!.decisions.length).toBe(2);              // the immutable slots survived the fault
    expect(recordDecision(HOME, "cf", { id: "a", verdict: "reject" }, 1002)).toBe("recorded"); // slot 2 (later)
    const got = consumeDecisions(HOME, "cf");
    expect(got.resolved.find((r) => r.item.id === "a")!.verdict).toBe("reject"); // the later slot wins on retry
    expect(collectBandwidthEvents(HOME).consumeAtSec.length).toBe(2);
  });
});

// TG round-7 (codex r6 verdict): slots must preserve PUBLISH SEMANTICS (a console full snapshot REPLACES; a single-item tap
// MERGES) — not a blind historical union — AND import legacy baseline (bdd93d7) pending/recoverable data instead of silently
// dropping it.
describe("TG r7: snapshot-replace / tap-merge semantics + legacy import", () => {
  const dd = (id: string) => path.join(HOME, ".agenthop", "console", "decision-batches", id);

  test("TG-R6-P1-1: snapshot -> snapshot REPLACES (a later full snapshot that omits an item un-decides it)", () => {
    openBatch(HOME, { batchId: "ss", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "ss", decidedAtSec: 10, decisions: [{ id: "a", verdict: "approve" }] });            // snapshot 1
    writeDecisions(HOME, { batchId: "ss", decidedAtSec: 11, decisions: [{ id: "b", verdict: "reject" }] });             // snapshot 2 — omits a
    const got = consumeDecisions(HOME, "ss");
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["b", "reject"]]); // only b (a is un-decided by the replace)
  });

  test("TG-R6-P1-1: snapshot -> tap MERGES (the tap preserves the snapshot's untouched items)", () => {
    openBatch(HOME, { batchId: "st", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "st", decidedAtSec: 10, decisions: [{ id: "a", verdict: "approve" }] }); // snapshot
    expect(recordDecision(HOME, "st", { id: "b", verdict: "reject" }, 11)).toBe("recorded");                 // tap
    const got = consumeDecisions(HOME, "st");
    expect(got.resolved.map((r) => [r.item.id, r.verdict]).sort()).toEqual([["a", "approve"], ["b", "reject"]]); // BOTH
  });

  test("TG-R6-P1-1: an EMPTY full snapshot clears prior decisions (zero consumed, not a stale approve)", () => {
    openBatch(HOME, { batchId: "es", owner: "coord", items: [item("a")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "es", decidedAtSec: 10, decisions: [{ id: "a", verdict: "approve" }] });
    writeDecisions(HOME, { batchId: "es", decidedAtSec: 11, decisions: [] }); // the console cleared the batch with no decisions
    expect(readDecisions(HOME, "es")!.decisions).toEqual([]);
    expect(consumeDecisions(HOME, "es").resolved).toEqual([]); // zero — the old approve is NOT consumed
  });

  test("TG-R6-P1-1: snapshot(a)->snapshot(b) and snapshot(a)->tap(b) DIVERGE (publish type is recorded, not inferred)", () => {
    openBatch(HOME, { batchId: "d1", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "d1", decidedAtSec: 10, decisions: [{ id: "a", verdict: "approve" }] });
    writeDecisions(HOME, { batchId: "d1", decidedAtSec: 11, decisions: [{ id: "b", verdict: "approve" }] });
    expect(consumeDecisions(HOME, "d1").resolved.map((r) => r.item.id)).toEqual(["b"]);        // snapshot->snapshot: replace

    openBatch(HOME, { batchId: "d2", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    writeDecisions(HOME, { batchId: "d2", decidedAtSec: 10, decisions: [{ id: "a", verdict: "approve" }] });
    expect(recordDecision(HOME, "d2", { id: "b", verdict: "approve" }, 11)).toBe("recorded");
    expect(consumeDecisions(HOME, "d2").resolved.map((r) => r.item.id).sort()).toEqual(["a", "b"]); // snapshot->tap: merge
  });

  test("TG-R6-P2-1: a legacy baseline decisions.json (no slots) is IMPORTED, not silently dropped", () => {
    openBatch(HOME, { batchId: "lg", owner: "coord", items: [item("a")], nowSec: 1 });
    // a pending batch created by the baseline (bdd93d7) API: a raw decisions.json, no seq/ ledger, no consumed.json
    writeFileSync(path.join(dd("lg"), "decisions.json"), JSON.stringify({ batchId: "lg", decidedAtSec: 5, decisions: [{ id: "a", verdict: "approve" }] }));
    expect(readDecisions(HOME, "lg")!.decisions.map((d) => d.id)).toEqual(["a"]); // read sees the legacy decision
    const got = consumeDecisions(HOME, "lg");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["a", "approve"]]); // and it consumes it (no silent loss)
  });

  test("TG-R6-P2-1: a legacy baseline recoverable claim (no consumed.json, no slots) is IMPORTED", () => {
    openBatch(HOME, { batchId: "lc", owner: "coord", items: [item("a")], nowSec: 1 });
    // a baseline consume that claimed decisions.json then faulted before sealing left a recoverable claim
    writeFileSync(path.join(dd("lc"), "decisions-consumed-claim.json"), JSON.stringify({ batchId: "lc", decidedAtSec: 5, decisions: [{ id: "a", verdict: "reject" }] }));
    expect(readDecisions(HOME, "lc")!.decisions.map((d) => d.id)).toEqual(["a"]);
    expect(consumeDecisions(HOME, "lc").resolved.map((r) => r.verdict)).toEqual(["reject"]); // recovered, not lost
  });

  test("TG-R6-P2-1: a legacy decisions.json then a NEW tap — the legacy snapshot is the base, the tap merges on top", () => {
    openBatch(HOME, { batchId: "lm", owner: "coord", items: [item("a"), item("b")], nowSec: 1 });
    writeFileSync(path.join(dd("lm"), "decisions.json"), JSON.stringify({ batchId: "lm", decidedAtSec: 5, decisions: [{ id: "a", verdict: "approve" }] })); // legacy base
    expect(recordDecision(HOME, "lm", { id: "b", verdict: "reject" }, 10)).toBe("recorded"); // new slot 0 (tap)
    const got = consumeDecisions(HOME, "lm");
    expect(got.resolved.map((r) => [r.item.id, r.verdict]).sort()).toEqual([["a", "approve"], ["b", "reject"]]); // legacy a + new b
  });
});

// TG round-8 (codex r7 verdict): close the legacy-import lifecycle — a consumed import must NOT fire a false orphan post-seal
// (the import stays stable across the seal), and a baseline rejected-claim must be imported too.
describe("TG r8: legacy import lifecycle (stable across seal; rejected-claim import)", () => {
  const dd = (id: string) => path.join(HOME, ".agenthop", "console", "decision-batches", id);

  test("TG-R6-P2-1 A: an imported legacy snapshot + a new tap consumes both, and a terminal re-consume fires NO false orphan", () => {
    openBatch(HOME, { batchId: "fa", owner: "coord-sid", items: [item("a"), item("b")], nowSec: 1 });
    writeFileSync(path.join(dd("fa"), "decisions.json"), JSON.stringify({ batchId: "fa", decidedAtSec: 5, decisions: [{ id: "a", verdict: "approve" }] })); // baseline legacy
    expect(recordDecision(HOME, "fa", { id: "b", verdict: "reject" }, 10)).toBe("recorded"); // new tap (slot 0)
    expect(consumeDecisions(HOME, "fa").resolved.map((r) => r.item.id).sort()).toEqual(["a", "b"]); // both consumed
    const again = consumeDecisions(HOME, "fa"); // terminal re-consume — nothing new was published
    expect(again.consumed).toBe(false);
    expect(claimInbox(HOME, ["coord-sid"], "p").some((c) => c.msg.title === "orphan decision — re-batch")).toBe(false); // NO false orphan
  });

  test("TG-R6-P2-1 A: with the owner inbox UNWRITABLE, a legacy-import consume does NOT throw (no spurious orphan write)", () => {
    openBatch(HOME, { batchId: "fw", owner: "coord-sid", items: [item("a"), item("b")], nowSec: 1 });
    writeFileSync(path.join(dd("fw"), "decisions.json"), JSON.stringify({ batchId: "fw", decidedAtSec: 5, decisions: [{ id: "a", verdict: "approve" }] }));
    expect(recordDecision(HOME, "fw", { id: "b", verdict: "reject" }, 10)).toBe("recorded");
    mkdirSync(path.join(HOME, ".agenthop"), { recursive: true });
    writeFileSync(path.join(HOME, ".agenthop", "inbox"), "x"); // block any inbox write (a spurious orphan would throw ENOTDIR)
    const got = consumeDecisions(HOME, "fw"); // must NOT throw — the post-seal read equals the consumed digest, so no orphan
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => r.item.id).sort()).toEqual(["a", "b"]);
  });

  test("TG-R6-P2-1 A (claim variant): a legacy recoverable claim + a new tap — no false orphan post-seal", () => {
    openBatch(HOME, { batchId: "fc", owner: "coord-sid", items: [item("a"), item("b")], nowSec: 1 });
    writeFileSync(path.join(dd("fc"), "decisions-consumed-claim.json"), JSON.stringify({ batchId: "fc", decidedAtSec: 5, decisions: [{ id: "a", verdict: "approve" }] })); // baseline recoverable claim
    expect(recordDecision(HOME, "fc", { id: "b", verdict: "reject" }, 10)).toBe("recorded");
    expect(consumeDecisions(HOME, "fc").resolved.map((r) => r.item.id).sort()).toEqual(["a", "b"]);
    consumeDecisions(HOME, "fc");
    expect(claimInbox(HOME, ["coord-sid"], "p").some((c) => c.msg.title === "orphan decision — re-batch")).toBe(false);
  });

  test("TG-R6-P2-1 B: a legacy baseline rejected-claim (valid, bound) is IMPORTED and consumed; a foreign one is not", () => {
    openBatch(HOME, { batchId: "rb", owner: "coord", items: [item("a")], nowSec: 1 });
    writeFileSync(path.join(dd("rb"), "decisions-rejected-claim.json"), JSON.stringify({ batchId: "rb", decidedAtSec: 5, decisions: [{ id: "a", verdict: "approve" }] }));
    expect(readDecisions(HOME, "rb")!.decisions.map((x) => x.id)).toEqual(["a"]);
    const got = consumeDecisions(HOME, "rb");
    expect(got.consumed).toBe(true);
    expect(got.resolved.map((r) => [r.item.id, r.verdict])).toEqual([["a", "approve"]]);
    openBatch(HOME, { batchId: "rb2", owner: "coord", items: [item("a")], nowSec: 1 });
    writeFileSync(path.join(dd("rb2"), "decisions-rejected-claim.json"), JSON.stringify({ batchId: "OTHER", decidedAtSec: 5, decisions: [{ id: "a", verdict: "approve" }] }));
    expect(consumeDecisions(HOME, "rb2").consumed).toBe(false); // a foreign (batchId != dir) rejected-claim is never imported
  });
});
