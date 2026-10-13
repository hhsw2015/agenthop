// Delivery-drain fixture child (TGP-7): runs the EXACT receipt-obligation drain the driver's drainReceiptObligations runs — the
// SAME tg-queue claim, readConsumedResult authority, obligationReceiptValue decision, and writeInbox (publishOnce, keyed by
// update_id) to the coordinator inbox. Two of these racing over one obligation queue + one coordinator inbox prove exactly-once.
// argv: <home> <obligationDir> <coordSid>
import { drainQueue } from "../../src/swarm/tg-queue.js";
import { readConsumedResult } from "../../src/swarm/decision-batch-store.js";
import { obligationReceiptValue, tgIdempotencyKey, type ReceiptObligation } from "../../src/swarm/tg-entry.js";
import { writeInbox } from "../../src/inbox.js";

const [home, obDir, coordSid] = process.argv.slice(2);
await drainQueue(obDir!, (rec) => {
  const ob = rec as Partial<ReceiptObligation>;
  if (!ob || typeof ob.updateId !== "number" || typeof ob.batchId !== "string" || typeof ob.itemId !== "string" || !ob.recordedValue) return "sent";
  let authority: { consumed: true; itemValue: { verdict: "approve" | "reject" | "defer"; scope?: "once" | "this-chat" | "always" } | null } | { consumed: false } | { consumed: "unknown" };
  try {
    const cr = readConsumedResult(home!, ob.batchId);
    if (cr.consumed === true) { const d = cr.doc.decisions.find((x) => x.id === ob.itemId); authority = { consumed: true, itemValue: d ? { verdict: d.verdict, ...(d.scope ? { scope: d.scope } : {}) } : null }; }
    else authority = cr;
  } catch { return "retry"; }
  const act = obligationReceiptValue(authority, ob.recordedValue);
  if (act.action === "retry") return "retry";
  if (act.action === "drop") return "sent";
  const res = writeInbox(home!, coordSid!, { from: "tg", fromLabel: "tg", text: `[tg-verdict] ${ob.batchId}/${ob.itemId}: ${act.value.verdict}:${act.value.scope ?? "-"}`, taskRef: "tg-verdict", title: "t", via: "local", ts: Date.now() }, tgIdempotencyKey("tg-verdict", ob.updateId));
  return (res === "published" || res === "already") ? "sent" : "retry";
});
process.exit(0);
