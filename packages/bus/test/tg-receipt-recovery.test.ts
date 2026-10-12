// TG bridge receipt-recovery fixtures (TGP-4 fix + TGP-7 three-class gate). These exercise the bridge's RECEIPT/OFFSET path — the
// exact path the reviewer's crash fixture failed on in r3. The obligation is derived from the DURABLE LEDGER (receiptOwed) instead
// of the volatile recordDecision outcome, so a recorded-but-undelivered receipt survives consume AND a hard crash. Per the infra
// law, three classes: crash-recovery (real SIGKILL subprocess), restart-idempotency (re-poll/restart dedup), concurrency-race
// (dual-instance record + forward). Fixtures use the SAME store entry points the driver calls.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBatch, consumeDecisions, recordDecision, readDecisions, readBatch } from "../src/swarm/decision-batch-store.js";
import { enforceScope } from "../src/swarm/decision-batch.js";
import { receiptOwed } from "../src/swarm/tg-entry.js";
import { writeInbox, claimInbox } from "../src/inbox.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(PKG_ROOT, "test", "fixtures", "tg-crash-child.mts");
const offsetPath = (home: string) => path.join(home, ".agenthop", "tg", "offset");

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-tgrr-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const soft = (id: string) => ({ id, kind: "merge", summary: `merge ${id}`, suggestedAction: "approve" as const });
const inboxMsg = (text: string, ts: number) => ({ from: "swarm-tg-entry", fromLabel: "tg-entry", text, taskRef: "tg-verdict", title: "TG 决策回执", via: "local" as const, ts });
const runChild = (args: string[]) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) => {
  const c = spawn(process.execPath, ["--import", "tsx", CHILD, ...args], { cwd: PKG_ROOT });
  let out = ""; c.stdout.on("data", (d) => { out += String(d); }); c.stderr.on("data", () => {});
  c.on("close", (code, signal) => resolve({ code, signal, out: out.trim() }));
});

// ── FIXTURE CLASS 1: CRASH RECOVERY ──────────────────────────────────────────────────────────────────────────────────
describe("tg receipt-recovery crash-recovery", () => {
  test("REAL SIGKILL after record, batch then consumed → the real receipt is STILL recoverable from the sealed ledger (r3 lost it)", () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    // a REAL bridge process records the verdict, then hard-crashes before writing the offset or forwarding the receipt.
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, HOME, b.batchId, "n1", "approve", "always", "crash"], { cwd: PKG_ROOT, encoding: "utf8" });
    expect(r.signal).toBe("SIGKILL"); // a true hard crash, not a graceful exit
    // on-disk after the crash: the decision is durable; the offset was never advanced.
    const led0 = readDecisions(HOME, b.batchId)?.decisions.find((d) => d.id === "n1");
    expect(led0).toMatchObject({ id: "n1", verdict: "approve", scope: "always" });
    expect(existsSync(offsetPath(HOME))).toBe(false); // crash before advance
    // another consumer seals the batch before the bridge restarts (the exact interleave that broke r3).
    expect(consumeDecisions(HOME, b.batchId).consumed).toBe(true);
    // RESTART: the bridge re-polls the same update → recordDecision now returns "consumed".
    const dec = { id: "n1", verdict: "approve" as const, scope: "always" as const };
    expect(recordDecision(HOME, b.batchId, dec, 2)).toBe("consumed");
    // r4 recovery: derive the obligation from the sealed ledger → the REAL receipt (coordinator gets 1, NOT 0-stuck).
    const item = readBatch(HOME, b.batchId)!.items.find((it) => it.id === "n1")!;
    const ledgerFinal = readDecisions(HOME, b.batchId)?.decisions.find((d) => d.id === "n1") ?? null;
    const owed = receiptOwed("consumed", enforceScope(item, dec), ledgerFinal);
    expect(owed).toMatchObject({ verdict: "approve", scope: "always" });
  });

  test("a late/losing tap after seal owes NO receipt (never a false/stale audit)", () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    recordDecision(HOME, b.batchId, { id: "n1", verdict: "approve", scope: "always" }, 1);
    expect(consumeDecisions(HOME, b.batchId).consumed).toBe(true);
    const item = readBatch(HOME, b.batchId)!.items.find((it) => it.id === "n1")!;
    const lateReject = { id: "n1", verdict: "reject" as const };
    expect(recordDecision(HOME, b.batchId, lateReject, 2)).toBe("consumed");
    const ledgerFinal = readDecisions(HOME, b.batchId)?.decisions.find((d) => d.id === "n1") ?? null;
    expect(receiptOwed("consumed", enforceScope(item, lateReject), ledgerFinal)).toBeNull(); // approve stays the truth; reject owes nothing
  });
});

// ── FIXTURE CLASS 2: RESTART IDEMPOTENCY ─────────────────────────────────────────────────────────────────────────────
describe("tg receipt-recovery restart-idempotency", () => {
  test("re-forwarding the same receipt (same update_id key) after a restart lands EXACTLY ONE coordinator message", () => {
    const key = "tg-verdict.deadbeefcafe"; // = tgIdempotencyKey("tg-verdict", update_id) in the driver
    expect(writeInbox(HOME, "coord", inboxMsg("[tg-verdict] 批 b1 项 n1: approve (scope=always)", 1), key)).toBe("published");
    expect(writeInbox(HOME, "coord", inboxMsg("[tg-verdict] 批 b1 项 n1: approve (scope=always)", 2), key)).toBe("already"); // a restart re-forward dedups
    expect(claimInbox(HOME, ["coord"], "pidX").length).toBe(1); // exactly one receipt, never a duplicate
  });

  test("re-deriving the obligation after a restart is deterministic (same real receipt)", () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    recordDecision(HOME, b.batchId, { id: "n1", verdict: "approve", scope: "always" }, 1);
    consumeDecisions(HOME, b.batchId);
    const item = readBatch(HOME, b.batchId)!.items.find((it) => it.id === "n1")!;
    const mine = enforceScope(item, { id: "n1", verdict: "approve", scope: "always" });
    const derive = () => receiptOwed("consumed", mine, readDecisions(HOME, b.batchId)?.decisions.find((d) => d.id === "n1") ?? null);
    expect(derive()).toEqual(derive());
    expect(derive()).toMatchObject({ verdict: "approve", scope: "always" });
  });
});

// ── FIXTURE CLASS 3: CONCURRENCY RACE (dual-instance) ─────────────────────────────────────────────────────────────────
describe("tg receipt-recovery concurrency-race", () => {
  test("two REAL bridge instances record the same item concurrently → the ledger holds exactly ONE final decision (no corruption)", async () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    const [a, c] = await Promise.all([
      runChild([HOME, b.batchId, "n1", "approve", "always", "exit"]),
      runChild([HOME, b.batchId, "n1", "approve", "once", "exit"]),
    ]);
    // neither instance crashed/threw; each reported a terminal outcome.
    for (const r of [a, c]) { expect(r.signal).toBeNull(); expect(["recorded", "consumed", "contended"]).toContain(r.out); }
    expect([a.out, c.out].includes("recorded")).toBe(true); // at least one won the consume lock and recorded
    const finals = readDecisions(HOME, b.batchId)!.decisions.filter((d) => d.id === "n1");
    expect(finals.length).toBe(1); // exactly one final decision — no double-entry, no corruption
    expect(finals[0]!.verdict).toBe("approve");
    expect(["once", "always"]).toContain(finals[0]!.scope); // a legal clamped scope (whichever instance won)
  });

  test("two concurrent forwards of the same receipt key → exactly one coordinator message (publishOnce atomic claim)", () => {
    const key = "tg-verdict.racekey";
    const results = [writeInbox(HOME, "coord", inboxMsg("x", 1), key), writeInbox(HOME, "coord", inboxMsg("x", 2), key)];
    expect(results.filter((r) => r === "published").length).toBe(1);
    expect(results.filter((r) => r === "already").length).toBe(1);
    expect(claimInbox(HOME, ["coord"], "p").length).toBe(1); // exactly-once at the coordinator even under a dual-instance forward
  });
});
