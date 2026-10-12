// tg-queue — the durable claim-based file queue powering the TG bridge OUTBOX + dialog-PENDING + receipt-obligation stores. This
// suite is the regression for happycapy's item-① review (DO-P1-1/2, DO-P2-1/2/3) PLUS the infra law's three classes. The queue is
// seq-keyed (a monotonic numeric event id — the TG update_id for pending): FIFO by seq, lossless identity, a durable DONE ledger,
// unique per-drain claims, read-error-release / corrupt-quarantine, and stuck-release retry.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, renameSync, existsSync, utimesSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueQueue, drainQueue, recoverStaleQueueClaims, retryStuckQueue, pidAlive } from "../src/swarm/tg-queue.js";

let DIR: string;
beforeEach(() => { DIR = mkdtempSync(path.join(os.tmpdir(), "ah-tgq-")); });
afterEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

const pendingFiles = (d: string) => { try { return readdirSync(d).filter((n) => /^\d{20}\.json$/.test(n)); } catch { return []; } };
const allFiles = (d: string) => { try { return readdirSync(d); } catch { return []; } };
const doneFiles = (d: string) => { try { return readdirSync(path.join(d, "done")); } catch { return []; } };
const quarantineBytes = (d: string) => { try { return readdirSync(path.join(d, "quarantine")).filter((n) => !n.endsWith(".log")); } catch { return []; } };
const DEAD = () => false;
const ALIVE = () => true;

describe("tg-queue basics", () => {
  test("enqueue then drain delivers once and leaves a DONE marker, no residue", async () => {
    expect(enqueueQueue(DIR, { chatId: 7, text: "hi" }, 5)).toBe("enqueued");
    const seen: unknown[] = [];
    const r = await drainQueue(DIR, (rec) => { seen.push(rec); return "sent"; });
    expect(r).toMatchObject({ claimed: 1, sent: 1, retried: 0 });
    expect(seen).toEqual([{ chatId: 7, text: "hi" }]);
    expect(pendingFiles(DIR)).toEqual([]);
    expect(allFiles(DIR).filter((n) => /\.sending-/.test(n))).toEqual([]); // no claim residue
    expect(doneFiles(DIR).length).toBe(1); // durable terminal state recorded
  });

  test('"retry" releases the record so the next drain re-delivers it', async () => {
    enqueueQueue(DIR, { n: 1 }, 1);
    expect(await drainQueue(DIR, () => "retry")).toMatchObject({ sent: 0, retried: 1 });
    expect(pendingFiles(DIR).length).toBe(1);
    expect(await drainQueue(DIR, () => "sent")).toMatchObject({ sent: 1 });
    expect(pendingFiles(DIR)).toEqual([]);
  });

  test("cap bounds the claims per drain", async () => {
    for (let i = 0; i < 5; i++) enqueueQueue(DIR, { i }, i);
    expect((await drainQueue(DIR, () => "sent", { cap: 2 })).claimed).toBe(2);
    expect(pendingFiles(DIR).length).toBe(3);
  });
});

// ── DO-P2-3: FIFO by update_id, NOT digest/lexical-of-hash order ──────────────────────────────────────────────────────
describe("tg-queue FIFO by seq (DO-P2-3)", () => {
  test("records drain in ascending update_id order regardless of enqueue order", async () => {
    for (const seq of [9, 8, 10, 4, 3, 1, 7, 2, 6, 5]) enqueueQueue(DIR, { seq }, seq); // the reviewer's scrambled order
    const order: number[] = [];
    await drainQueue(DIR, (rec) => { order.push((rec as { seq: number }).seq); return "sent"; }, { cap: 100 });
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // arrival order preserved (a conversation stays in sequence)
  });

  test("a handler retry HOLDS the head: later items are not sent ahead of it (DO-P2-3)", async () => {
    for (const seq of [1, 2, 3]) enqueueQueue(DIR, { seq }, seq);
    const sent: number[] = [];
    // first drain: item 1 retries ⇒ the drain STOPS (2 and 3 are not sent ahead of 1).
    const r1 = await drainQueue(DIR, (rec) => { const s = (rec as { seq: number }).seq; if (s === 1) return "retry"; sent.push(s); return "sent"; }, { cap: 100 });
    expect(r1).toMatchObject({ claimed: 1, retried: 1 }); // only item 1 was claimed before the break
    expect(sent).toEqual([]);                             // nothing jumped ahead of the retried head
    // second drain: everything sends, strictly in order.
    await drainQueue(DIR, (rec) => { sent.push((rec as { seq: number }).seq); return "sent"; }, { cap: 100 });
    expect(sent).toEqual([1, 2, 3]);
  });
});

// ── DO-P1-1: read error KEEPS the record; corrupt goes to OBSERVABLE quarantine (never silent delete) ─────────────────
describe("tg-queue crash-recovery (DO-P1-1)", () => {
  test("a transient READ error releases the record (retry), never deletes or quarantines it", async () => {
    // a directory named like a record ⇒ readFileSync throws EISDIR (a READ error, distinct from a parse error on real bytes).
    mkdirSync(path.join(DIR, "00000000000000000001.json"), { recursive: true });
    const r = await drainQueue(DIR, () => "sent");
    expect(r).toMatchObject({ claimed: 1, sent: 0, retried: 1 }); // KEPT for retry, never sent
    expect(pendingFiles(DIR)).toContain("00000000000000000001.json"); // released back, NOT deleted
    expect(quarantineBytes(DIR)).toEqual([]); // a read error is NOT corruption ⇒ never quarantined
  });

  test("a thrown handler (a crash mid-handle) keeps the record for retry, never drops it", async () => {
    enqueueQueue(DIR, { keep: true }, 2);
    const r = await drainQueue(DIR, () => { throw new Error("boom"); });
    expect(r).toMatchObject({ sent: 0, retried: 1 });
    expect(pendingFiles(DIR).length).toBe(1);
  });

  test("a parse-CORRUPT record is moved to an observable quarantine/, never silently deleted", async () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, "00000000000000000003.json"), "{ not json");
    const r = await drainQueue(DIR, () => "sent");
    expect(r.claimed).toBe(1);
    expect(r.sent).toBe(0); // handler never ran on corrupt bytes
    expect(pendingFiles(DIR)).toEqual([]); // removed from the delivery path
    expect(quarantineBytes(DIR).length).toBe(1); // but PRESERVED, observable (FC-2), not deleted
  });

  test("a claim left by a crashed (dead) drainer is reclaimed and re-delivered", async () => {
    enqueueQueue(DIR, { chatId: 1, text: "survive" }, 7);
    const [name] = pendingFiles(DIR);
    renameSync(path.join(DIR, name!), path.join(DIR, `${name}.sending-999999-1000.abcdef`)); // crash mid-handle (dead pid, claim-time 1000)
    expect(pendingFiles(DIR).length).toBe(0);
    const seen: unknown[] = [];
    const r = await drainQueue(DIR, (rec) => { seen.push(rec); return "sent"; }, { isAlive: DEAD });
    expect(seen).toEqual([{ chatId: 1, text: "survive" }]);
    expect(r.sent).toBe(1);
  });

  test("recoverStaleQueueClaims restores a dead-pid claim, leaves a fresh live-pid claim", () => {
    enqueueQueue(DIR, { a: 1 }, 1); const [n1] = pendingFiles(DIR);
    renameSync(path.join(DIR, n1!), path.join(DIR, `${n1}.sending-111-1000.aaaaaa`)); // dead pid, old claim-time
    enqueueQueue(DIR, { a: 2 }, 2); const n2 = pendingFiles(DIR).find((n) => n.startsWith("0000"))!;
    renameSync(path.join(DIR, n2), path.join(DIR, `${n2}.sending-222-${Date.now()}.bbbbbb`)); // alive pid, FRESH claim-time
    recoverStaleQueueClaims(DIR, (pid) => pid === 222); // 111 dead → reclaimed; 222 alive + fresh → left alone
    expect(pendingFiles(DIR)).toContain(n1);
    expect(allFiles(DIR).some((n) => n.startsWith(`${n2}.sending-222-`))).toBe(true);
  });
});

// ── DO-P1-2: lossless identity (no char-fold/truncate collision) ──────────────────────────────────────────────────────
describe("tg-queue lossless identity (DO-P1-2)", () => {
  test("event id BINDS payload: identical replay = already; DIFFERENT payload = conflict (original kept, never overwritten)", async () => {
    expect(enqueueQueue(DIR, { v: 1 }, 42)).toBe("enqueued");
    expect(enqueueQueue(DIR, { v: 1 }, 42)).toBe("already");  // identical replay ⇒ idempotent, one file
    expect(enqueueQueue(DIR, { v: 2 }, 42)).toBe("conflict"); // DIFFERENT payload for the same id ⇒ rejected
    expect(pendingFiles(DIR).length).toBe(1);
    let got: unknown; await drainQueue(DIR, (rec) => { got = rec; return "sent"; });
    expect(got).toEqual({ v: 1 }); // the ORIGINAL payload survived — not silently overwritten by {v:2}
    enqueueQueue(DIR, { v: 9 }, 43);
    expect(pendingFiles(DIR).length).toBe(1); // distinct event ⇒ its own file (42 already drained)
  });

  test("a re-enqueue DURING an in-flight claim does not create a second copy (DO-P2-1a active-claim)", () => {
    enqueueQueue(DIR, { v: 1 }, 42);
    const [n] = pendingFiles(DIR);
    renameSync(path.join(DIR, n!), path.join(DIR, `${n}.sending-${process.pid}-${Date.now()}.abc123`)); // simulate an in-flight claim
    expect(enqueueQueue(DIR, { v: 1 }, 42)).toBe("already");  // same payload, claimed ⇒ no duplicate
    expect(enqueueQueue(DIR, { v: 2 }, 42)).toBe("conflict"); // different payload, claimed ⇒ rejected (no second claim)
    expect(pendingFiles(DIR)).toEqual([]); // no new <seq>.json spawned beside the claim
  });

  test("seqs that a char-fold would collide stay distinct (the DO-P1-2 class)", () => {
    // 100 and 1000 (or any two distinct integers) can never map to one file — the id is encoded verbatim, not folded.
    enqueueQueue(DIR, { v: 1 }, 100);
    enqueueQueue(DIR, { v: 2 }, 1000);
    expect(pendingFiles(DIR).length).toBe(2);
  });

  test("an illegal id is REJECTED (failed), never folded into a colliding name", () => {
    expect(enqueueQueue(DIR, { v: 1 }, -1)).toBe("failed");
    expect(enqueueQueue(DIR, { v: 1 }, 1.5)).toBe("failed");
    expect(enqueueQueue(DIR, { v: 1 }, Number.NaN)).toBe("failed");
    expect(pendingFiles(DIR)).toEqual([]);
  });
});

// ── DO-P2-1: durable DONE ledger ⇒ no re-send after completion / replay / crash-after-send ────────────────────────────
describe("tg-queue exactly-once via DONE ledger (DO-P2-1)", () => {
  test("a completed seq is NOT re-queued (replay after completion ⇒ already)", async () => {
    enqueueQueue(DIR, { x: 1 }, 1);
    await drainQueue(DIR, () => "sent");
    expect(enqueueQueue(DIR, { x: 1 }, 1)).toBe("already"); // the producer replays the same event ⇒ no second send
    expect(pendingFiles(DIR)).toEqual([]);
  });

  test("a DONE claim re-surfaced during flight discharges WITHOUT re-sending (crash-after-send window)", async () => {
    enqueueQueue(DIR, { x: 1 }, 1);
    let sends = 0;
    await drainQueue(DIR, () => { sends++; return "sent"; }); // writes done/00..01
    // simulate a crash AFTER send+done but before the claim was deleted: re-create the claim file for the same seq.
    writeFileSync(path.join(DIR, "00000000000000000001.json"), JSON.stringify({ x: 1 }));
    await drainQueue(DIR, () => { sends++; return "sent"; }); // recovery drain sees DONE ⇒ discharges, no re-send
    expect(sends).toBe(1); // delivered exactly once across the crash-recovery
    expect(pendingFiles(DIR)).toEqual([]);
  });

  test("a DONE-write failure RELEASES the record (preserves the completion obligation), never acks without recording it (DO-P2-1c)", async () => {
    enqueueQueue(DIR, { v: 1 }, 1);
    mkdirSync(path.join(DIR, "done"), { recursive: true, mode: 0o500 }); // read-only done/ ⇒ the DONE marker write faults
    try {
      let ran = 0;
      const r = await drainQueue(DIR, () => { ran++; return "sent"; });
      expect(ran).toBe(1); // the handler ran (the sink was hit)
      expect(r).toMatchObject({ sent: 0, retried: 1 }); // but DONE did not land ⇒ released, NOT acked-without-record
      expect(pendingFiles(DIR).length).toBe(1); // obligation preserved for a re-attempt (dedup of the re-run rides the sink)
    } finally { chmodSync(path.join(DIR, "done"), 0o700); }
  });

  test("pruneDone KEEPS a DONE whose stem still has a pending entry (DO-P2-1d: DONE outlives the entry it dedups)", async () => {
    enqueueQueue(DIR, { v: 1 }, 5); // a leftover pending entry for stem 5 (e.g. an ack-failed claim released back)
    mkdirSync(path.join(DIR, "done"), { recursive: true });
    writeFileSync(path.join(DIR, "done", "00000000000000000005"), "");
    const old = (Date.now() - 48 * 3600 * 1000) / 1000; // 48h ago — well past the 24h TTL
    utimesSync(path.join(DIR, "done", "00000000000000000005"), old, old);
    let ran = 0;
    const r = await drainQueue(DIR, () => { ran++; return "sent"; }); // pruneDone runs first, THEN the claim
    expect(ran).toBe(0);        // the DONE survived pruning ⇒ the entry was discharged (not re-run); had it been pruned, ran would be 1
    expect(r.skipped).toBe(1);
  });
});

// ── DO-P2-2: a release/ack that faults keeps a retry obligation (never a permanently-skipped live-pid claim) ──────────
describe("tg-queue stuck-release retry (DO-P2-2)", () => {
  test("retryStuckQueue re-releases a claim whose rename-back faulted earlier", () => {
    enqueueQueue(DIR, { x: 1 }, 1);
    const [n] = pendingFiles(DIR);
    const claim = path.join(DIR, `${n}.sending-${process.pid}-${Date.now()}.cccccc`);
    renameSync(path.join(DIR, n!), claim); // a live-pid claim whose release "failed"
    const stuck = new Set<string>([claim]);
    retryStuckQueue(DIR, stuck); // the fault has cleared ⇒ it releases now
    expect(stuck.size).toBe(0); // obligation discharged
    expect(pendingFiles(DIR).length).toBe(1); // back to deliverable
  });

  test("a vanished stuck claim is cleared from the set (no infinite retry)", () => {
    const stuck = new Set<string>([path.join(DIR, "00000000000000000009.json.sending-1-1000.zzzzzz")]);
    retryStuckQueue(DIR, stuck);
    expect(stuck.size).toBe(0);
  });
});

// ── TGP-8: a long-QUEUED item freshly CLAIMED is not mistaken for a stale claim (claim age = claim time, not enqueue mtime) ──────
describe("tg-queue claim-age is claim-time not enqueue-mtime (TGP-8)", () => {
  test("a backlogged pending, freshly claimed by a live pid, is NOT reclaimed by a concurrent recovery", () => {
    enqueueQueue(DIR, { x: 1 }, 1);
    const [n] = pendingFiles(DIR);
    // backdate the pending file's mtime to 10 minutes ago (a long-queued backlog item).
    const old = Date.now() - 10 * 60_000;
    utimesSync(path.join(DIR, n!), old / 1000, old / 1000);
    // a live-pid drain claims it NOW (fresh claim-time in the name).
    const claim = `${n}.sending-${process.pid}-${Date.now()}.abc123`;
    renameSync(path.join(DIR, n!), path.join(DIR, claim));
    // a concurrent recovery (pid alive) must NOT reclaim it: the claim was taken seconds ago, not 5+ min ago.
    recoverStaleQueueClaims(DIR, () => true);
    expect(allFiles(DIR)).toContain(claim); // still held, not wrongly reclaimed
    expect(pendingFiles(DIR)).toEqual([]);
  });

  test("a genuinely old claim (claim-time 6 min ago) on a live pid IS reclaimed", () => {
    enqueueQueue(DIR, { x: 1 }, 2);
    const [n] = pendingFiles(DIR);
    const oldClaimMs = Date.now() - 6 * 60_000;
    renameSync(path.join(DIR, n!), path.join(DIR, `${n}.sending-${process.pid}-${oldClaimMs}.def456`));
    recoverStaleQueueClaims(DIR, () => true); // pid alive, but held > STALE_CLAIM_MS ⇒ reclaim
    expect(pendingFiles(DIR)).toContain(n);
  });
});

// ── concurrency: unique per-drain claims ⇒ two drains (even same pid) never double-send one record (DO-P2-1b) ──────────
describe("tg-queue concurrency-race (DO-P2-1b)", () => {
  test("two concurrent drains over one record ⇒ sent exactly once", async () => {
    enqueueQueue(DIR, { chatId: 9, text: "solo" }, 1);
    let sends = 0;
    const slow = async (): Promise<"sent"> => { await new Promise((r) => setTimeout(r, 5)); sends++; return "sent"; };
    const [a, b] = await Promise.all([drainQueue(DIR, slow), drainQueue(DIR, slow)]);
    expect(sends).toBe(1);
    expect(a.sent + b.sent).toBe(1);
    expect(pendingFiles(DIR)).toEqual([]);
  });

  test("many records across concurrent drains ⇒ each delivered exactly once", async () => {
    const N = 20;
    for (let i = 0; i < N; i++) enqueueQueue(DIR, { i }, i);
    const seen = new Set<number>(); let dup = 0;
    const h = (rec: unknown) => { const i = (rec as { i: number }).i; if (seen.has(i)) dup++; seen.add(i); return "sent" as const; };
    const results = await Promise.all(Array.from({ length: 4 }, () => drainQueue(DIR, h, { cap: N })));
    expect(dup).toBe(0);
    expect(seen.size).toBe(N);
    expect(results.reduce((s, r) => s + r.sent, 0)).toBe(N);
  });

  test("pidAlive: self alive, impossible pid dead", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2147480000)).toBe(false);
    expect(pidAlive(0)).toBe(false);
  });
});
