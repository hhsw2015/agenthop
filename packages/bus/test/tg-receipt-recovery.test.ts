// TG bridge receipt-recovery fixtures (TGP-4 TG-r5 + TGP-7 delivery-layer gate). The receipt obligation is derived from TWO
// independent fact sources: a DURABLE per-event obligation (captured only on "recorded", keyed by update_id — event identity) and
// the AUTHORITATIVE consumed result (readConsumedResult — the digest-verified consumed projection, NOT the orphan-inclusive fold).
// These fixtures assert the DELIVERY layer: the coordinator's received receipt COUNT + VALUE + the offset, a real two-process race,
// and the orphan-interleave regression the r4 review exposed. The in-process `deliver` mirrors the driver's drainReceiptObligations
// (same tg-queue claim, readConsumedResult, obligationReceiptValue, writeInbox); one subprocess variant proves real concurrency.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBatch, consumeDecisions, recordDecision, readDecisions, readConsumedResult } from "../src/swarm/decision-batch-store.js";
import { enforceScope, type DecisionItem } from "../src/swarm/decision-batch.js";
import { obligationReceiptValue, tgReceiptObligationDir, tgIdempotencyKey, type ReceiptObligation } from "../src/swarm/tg-entry.js";
import { enqueueQueue, drainQueue } from "../src/swarm/tg-queue.js";
import { writeInbox, claimInbox } from "../src/inbox.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DELIVER_CHILD = path.join(PKG_ROOT, "test", "fixtures", "tg-deliver-child.mts");
const COORD = "coord-sid";

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-tgr5-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const soft = (id: string) => ({ id, kind: "merge", summary: `merge ${id}`, suggestedAction: "approve" as const });
const seqSlotPath = (batchId: string, n: number) => path.join(HOME, ".agenthop", "console", "decision-batches", batchId, "seq", `${n}.json`);
const coordReceipts = () => claimInbox(HOME, [COORD], "p").map((c) => c.msg.text);

// the driver's record→obligation step: record the tap, then durably capture the obligation keyed by update_id (fact b).
function recordAndCapture(batchId: string, itemId: string, updateId: number, dec: { id: string; verdict: "approve" | "reject" | "defer"; scope?: "once" | "this-chat" | "always" }, item: DecisionItem): string {
  const outcome = recordDecision(HOME, batchId, dec, 1);
  if (outcome === "recorded") {
    const mine = enforceScope(item, dec);
    enqueueQueue(tgReceiptObligationDir(HOME), { updateId, batchId, itemId, recordedValue: { verdict: mine.verdict, ...(mine.scope ? { scope: mine.scope } : {}) } } satisfies ReceiptObligation, updateId);
  }
  return outcome;
}

// the driver's drainReceiptObligations (in-process; same functions the driver uses).
async function deliver(): Promise<{ sent: number; retried: number; skipped: number }> {
  const r = await drainQueue(tgReceiptObligationDir(HOME), (rec) => {
    const ob = rec as Partial<ReceiptObligation>;
    if (!ob || typeof ob.updateId !== "number" || typeof ob.batchId !== "string" || typeof ob.itemId !== "string" || !ob.recordedValue) return "sent";
    let authority: { consumed: true; itemValue: { verdict: "approve" | "reject" | "defer"; scope?: "once" | "this-chat" | "always" } | null } | { consumed: false } | { consumed: "unknown" };
    try {
      const cr = readConsumedResult(HOME, ob.batchId);
      if (cr.consumed === true) { const d = cr.doc.decisions.find((x) => x.id === ob.itemId); authority = { consumed: true, itemValue: d ? { verdict: d.verdict, ...(d.scope ? { scope: d.scope } : {}) } : null }; }
      else authority = cr;
    } catch { return "retry"; }
    const act = obligationReceiptValue(authority, ob.recordedValue);
    if (act.action === "retry") return "retry";
    if (act.action === "drop") return "sent";
    const res = writeInbox(HOME, COORD, { from: "tg", fromLabel: "tg", text: `${ob.itemId}:${act.value.verdict}:${act.value.scope ?? "-"}`, taskRef: "tg-verdict", title: "t", via: "local", ts: Date.now() }, tgIdempotencyKey("tg-verdict", ob.updateId));
    return (res === "published" || res === "already") ? "sent" : "retry";
  });
  return { sent: r.sent, retried: r.retried, skipped: r.skipped };
}
const runDeliverChild = (): Promise<number> => new Promise((resolve) => {
  const c = spawn(process.execPath, ["--import", "tsx", DELIVER_CHILD, HOME, tgReceiptObligationDir(HOME), COORD], { cwd: PKG_ROOT });
  c.on("close", (code) => resolve(code ?? -1));
});

// ── crash-recovery (delivery layer, event-bound) ─────────────────────────────────────────────────────────────────────
describe("tg receipt-recovery crash-recovery (delivery layer)", () => {
  test("recorded→obligation durable→(crash: not delivered)→consume→restart delivers EXACTLY ONE real receipt; offset final", async () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    expect(recordAndCapture(b.batchId, "n1", 42, { id: "n1", verdict: "approve", scope: "always" }, b.items[0]!)).toBe("recorded");
    // the driver advances the offset once the obligation is durable:
    const offset = path.join(HOME, ".agenthop", "tg", "offset"); mkdirSync(path.dirname(offset), { recursive: true }); writeFileSync(offset, "43");
    // "crash": we never delivered. Another consumer seals the batch before the bridge restarts.
    expect(consumeDecisions(HOME, b.batchId).consumed).toBe(true);
    // restart: the durable obligation (keyed by update_id 42) drives delivery — no re-derivation from the ledger fold.
    const d = await deliver();
    expect(d.sent).toBe(1);
    expect(coordReceipts()).toEqual(["n1:approve:always"]); // the REAL authoritative receipt, exactly one
    expect(readFileSync(offset, "utf8")).toBe("43"); // offset reached update_id+1 and stayed
  });

  test("a consumed/never-recorded tap captures NO obligation ⇒ coordinator receives nothing (no false receipt)", async () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    recordDecision(HOME, b.batchId, { id: "n1", verdict: "approve", scope: "once" }, 1); // the console decides
    consumeDecisions(HOME, b.batchId);                                                     // and seals
    // two late TG taps with the SAME value arrive after the seal — recordDecision returns "consumed" ⇒ NO obligation captured.
    expect(recordAndCapture(b.batchId, "n1", 42, { id: "n1", verdict: "approve", scope: "once" }, b.items[0]!)).toBe("consumed");
    expect(recordAndCapture(b.batchId, "n1", 43, { id: "n1", verdict: "approve", scope: "once" }, b.items[0]!)).toBe("consumed");
    const d = await deliver();
    expect(d.sent).toBe(0);
    expect(coordReceipts()).toEqual([]); // value-equality is NOT event identity ⇒ zero spurious recovery receipts
  });
});

// ── orphan-interleave regression (the r4-review counterexample) ───────────────────────────────────────────────────────
describe("tg receipt-recovery orphan-interleave (TGP-4 authority)", () => {
  test("a late ORPHAN reject slot does NOT change the receipt: the authoritative consumed value (approve) is delivered", async () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    expect(recordAndCapture(b.batchId, "n1", 42, { id: "n1", verdict: "approve", scope: "once" }, b.items[0]!)).toBe("recorded"); // slot 0 = approve
    expect(consumeDecisions(HOME, b.batchId).consumed).toBe(true); // claim + marker digest bind APPROVE
    // simulate the legal late orphan: a higher reject slot published after the seal (the store folds it; the claim does NOT).
    writeFileSync(seqSlotPath(b.batchId, 1), JSON.stringify({ batchId: b.batchId, decidedAtSec: 2, decisions: [{ id: "n1", verdict: "reject" }], kind: "tap" }));
    expect(readDecisions(HOME, b.batchId)!.decisions.find((d) => d.id === "n1")!.verdict).toBe("reject"); // the orphan-inclusive fold
    const auth = readConsumedResult(HOME, b.batchId); expect(auth.consumed).toBe(true);
    if (auth.consumed === true) expect(auth.doc.decisions.find((d) => d.id === "n1")!.verdict).toBe("approve"); // the AUTHORITY stays approve
    const d = await deliver();
    expect(d.sent).toBe(1);
    expect(coordReceipts()).toEqual(["n1:approve:once"]); // NOT the orphan reject — the authoritative consumed value
  });
});

// ── restart-idempotency: a re-poll / replay never double-delivers ─────────────────────────────────────────────────────
describe("tg receipt-recovery restart-idempotency (delivery layer)", () => {
  test("delivering, then re-capturing the same update_id, yields exactly ONE coordinator receipt", async () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    recordAndCapture(b.batchId, "n1", 42, { id: "n1", verdict: "approve", scope: "once" }, b.items[0]!);
    expect((await deliver()).sent).toBe(1); // delivered + DONE marker written
    // a re-poll of the same update after a restart re-captures ⇒ the queue DONE marker makes it a no-op ("already").
    expect(enqueueQueue(tgReceiptObligationDir(HOME), { updateId: 42, batchId: b.batchId, itemId: "n1", recordedValue: { verdict: "approve", scope: "once" } }, 42)).toBe("already");
    await deliver();
    expect(coordReceipts().length).toBe(1); // exactly one, never a duplicate across the restart
  });
});

// ── concurrency: a REAL two-process dual-instance drain ⇒ exactly one coordinator receipt ─────────────────────────────
describe("tg receipt-recovery dual-instance (real two processes)", () => {
  test("two bridge instances draining the SAME obligation queue deliver the receipt exactly once", async () => {
    const b = openBatch(HOME, { owner: "o", items: [soft("n1")], nowSec: 1 });
    recordAndCapture(b.batchId, "n1", 42, { id: "n1", verdict: "approve", scope: "always" }, b.items[0]!); // not sealed ⇒ forward recorded value
    const [a, c] = await Promise.all([runDeliverChild(), runDeliverChild()]);
    expect(a).toBe(0); expect(c).toBe(0); // neither crashed
    expect(coordReceipts().length).toBe(1); // publishOnce + tg-queue atomic claim ⇒ exactly once at the coordinator
  });
});
