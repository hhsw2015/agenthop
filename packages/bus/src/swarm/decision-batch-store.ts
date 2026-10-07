/**
 * Decision-batch IO store (R22-P1①). Persists a batch the coordinator asks the user to clear, reads the user's verdicts, and
 * CONSUMES them exactly once (atomic rename = the same claim discipline as the inbox) so the coordinator never executes a
 * verdict set twice. Reuses composeInboxMsg/writeInbox to notify (no new transport). Files under
 * ~/.agenthop/console/decision-batches/<batchId>/.
 *
 * Hardened with the chat-room review lessons: safe batchId (reject, never sanitize), validate at the write boundary, ENOENT
 * (absent) distinguished from a real read error (EACCES → throw, never treated as empty), corrupt-but-readable → null.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { writeInbox, composeInboxMsg } from "../inbox.js";
import {
  type DecisionBatch, type DecisionsDoc, type DecisionItem, type ResolvedDecision,
  validDecisionBatch, validDecisionsDoc, buildBatch, resolveBatch,
} from "./decision-batch.js";

const SAFE_BATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;
function assertSafeBatchId(id: string): void {
  if (typeof id !== "string" || !SAFE_BATCH_ID.test(id)) throw new Error(`decision-batch: unsafe batchId ${JSON.stringify(id)} — allowed [A-Za-z0-9_-], 1-64 chars`);
}

function batchesDir(home: string): string { return path.join(home, ".agenthop", "console", "decision-batches"); }
function batchDir(home: string, batchId: string): string { assertSafeBatchId(batchId); return path.join(batchesDir(home), batchId); }
function batchPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "batch.json"); }
function decisionsPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "decisions.json"); }
/** Durable per-batch markers (existence = the fact): `consumed.json` once the verdicts are claimed (DB-P1-3), `notified.json`
 *  once the compression ping landed (DB-P1-4). Kept inside the batch dir so they travel/clean up with it. */
function consumedMarkerPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "consumed.json"); }
function notifiedMarkerPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.json"); }

/** Does a marker file exist? ENOENT ⇒ false (absent); any other error (EACCES/…) THROWS — a read failure is NEVER treated as
 *  "absent" (the same discipline readJsonOrNull uses), so a permission glitch can't be mistaken for "not yet consumed/notified"
 *  and re-release verdicts or re-notify. existsSync is deliberately NOT used here (it folds every error into false). */
function markerExists(file: string): boolean {
  try { statSync(file); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

export function newBatchId(): string { return `batch-${randomBytes(8).toString("hex")}`; }

/** Read a file, distinguishing ENOENT (absent ⇒ `null` for the caller) from any other error (EACCES/… ⇒ throw — a read
 *  failure is NOT "absent"). An unsafe-id throw from the path builder propagates. */
function readJsonOrNull<T>(file: string, validate: (raw: unknown) => T | null): T | null {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try { return validate(JSON.parse(raw)); } catch { return null; } // readable-but-corrupt ⇒ null (distinct from a read failure)
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

export function readBatch(home: string, batchId: string): DecisionBatch | null {
  return readJsonOrNull(batchPath(home, batchId), validDecisionBatch);
}

export function readDecisions(home: string, batchId: string): DecisionsDoc | null {
  const doc = readJsonOrNull(decisionsPath(home, batchId), validDecisionsDoc);
  // DB-P1-1 (IO side): a doc whose batchId ≠ the directory it sits in is MISBOUND (a foreign/stale drop) — not valid decisions
  // for this batch. Treat it as absent so no verdict is ever read from the wrong batch's directory.
  if (doc && doc.batchId !== batchId) return null;
  return doc;
}

/** Persist a batch (validate at the write boundary — never persist a batch the read side would reject, e.g. a duplicate id). */
function writeBatch(home: string, batch: DecisionBatch): void {
  const valid = validDecisionBatch(batch);
  if (!valid) throw new Error("writeBatch: refusing to persist an invalid decision batch (batchId/owner non-empty, finite ts, unique valid items)");
  writeJsonAtomic(batchPath(home, valid.batchId), valid);
}

/** Write the user's decisions (validate at the write boundary). The console/CLI calls this after the user clears the batch. */
export function writeDecisions(home: string, doc: DecisionsDoc): void {
  const valid = validDecisionsDoc(doc);
  if (!valid) throw new Error("writeDecisions: refusing to persist an invalid decisions doc");
  // DB-P1-3 (write boundary): a batch consumed once is DONE — refuse to persist fresh decisions into it. Remaining/deferred
  // items are re-asked by the coordinator under a NEW batchId (per the contract), so re-submitting here can only be a
  // double-decision attempt. Combined with the consume-side marker check, re-submission can never re-release a verdict.
  if (markerExists(consumedMarkerPath(home, valid.batchId))) throw new Error(`writeDecisions: batch ${valid.batchId} already consumed — remaining items are re-batched under a new batchId`);
  writeJsonAtomic(decisionsPath(home, valid.batchId), valid);
}

/**
 * Open a batch: persist it, and (optionally) write ONE durable-inbox notification to `notifyTo` (a stableId) summarizing it —
 * the compression event: N pending items → one "you have N decisions" ping, pointing at the batch (the console renders the
 * full one-screen list). Idempotent on batchId: if a batch already exists, it is returned unchanged (never reset).
 */
export function openBatch(home: string, i: { batchId?: string; owner: string; items: DecisionItem[]; nowSec: number; notifyTo?: string }): DecisionBatch {
  const batchId = i.batchId ?? newBatchId();
  const existing = readBatch(home, batchId); // throws on a read failure ⇒ never overwrite an unreadable batch
  const batch = existing ?? buildBatch({ batchId, owner: i.owner, items: i.items, nowSec: i.nowSec });
  if (!existing) writeBatch(home, batch); // idempotent on batchId: an existing batch is never reset
  // DB-P1-4: the compression ping is NOT best-effort. notifyOnce writes exactly one durable ping (marking it only AFTER the
  // write lands) and lets a failure PROPAGATE — so the caller sees it, the batch is already persisted, and an idempotent
  // retry (same batchId) re-notifies because the marker was never written. A repeat call after success is a no-op (marker set).
  if (i.notifyTo) notifyOnce(home, batchId, i.owner, batch.items.length, i.notifyTo, i.nowSec);
  return batch;
}

/** Write ONE durable-inbox compression ping for a batch, exactly once (DB-P1-4). The `notified.json` marker is written only
 *  AFTER writeInbox succeeds (markNotified-after-success, the chat-room lesson) — so a notify failure leaves NO marker and the
 *  next openBatch(same id) re-sends. A present marker ⇒ already delivered ⇒ skip (no duplicate ping). The failure is NOT
 *  swallowed: writeInbox throwing propagates out of openBatch so the coordinator knows the user was not pinged. */
function notifyOnce(home: string, batchId: string, owner: string, itemCount: number, notifyTo: string, nowSec: number): void {
  if (markerExists(notifiedMarkerPath(home, batchId))) return; // already notified on an earlier (successful) open
  writeInbox(home, notifyTo, composeInboxMsg({
    from: owner, fromLabel: "coordinator",
    text: `${itemCount} decision(s) pending — clear batch ${batchId} (approve/reject/defer)`,
    via: "decision-batch", ts: nowSec * 1000, taskRef: `decision-batch:${batchId}`, title: "decisions pending",
  })); // may throw (FS fault) — intentionally NOT caught: failure must be visible and retriable (marker stays unwritten)
  writeJsonAtomic(notifiedMarkerPath(home, batchId), { to: notifyTo, notifiedAtSec: nowSec });
}

export type ConsumeResult = { resolved: ResolvedDecision[]; undecided: DecisionItem[]; unknownIds: string[]; consumed: boolean };

/**
 * Consume the user's decisions for a batch EXACTLY ONCE: read batch + decisions, match them, then atomically move
 * decisions.json aside so a second call cannot re-return (and the coordinator cannot execute the same verdicts twice) — the
 * same atomic-rename claim the inbox uses. `consumed:false` + all-undecided means the user has not decided yet (or another
 * consumer already won the race). The coordinator executes `resolved` (approve/reject), and re-batches `undecided` + deferred.
 */
export function consumeDecisions(home: string, batchId: string): ConsumeResult {
  const batch = readBatch(home, batchId);
  if (!batch) throw new Error(`consumeDecisions: no such batch ${batchId}`);
  const none: ConsumeResult = { resolved: [], undecided: batch.items, unknownIds: [], consumed: false };
  // DB-P1-3: a batch consumed once is DONE — a decisions.json re-written afterwards (same batchId) never re-releases verdicts.
  // The remaining/deferred items were re-asked by the coordinator under a NEW batchId. This marker is the durable barrier.
  if (markerExists(consumedMarkerPath(home, batchId))) return none;
  // DB-P1-2: CLAIM the file FIRST (atomic rename = single cross-process winner), THEN read EXACTLY the bytes we claimed — so a
  // producer swapping decisions.json between our check and our read lands on a NEW file, never on the verdicts we return. The
  // old order (read → resolve → rename) could return an approve while the rename actually claimed a swapped-in reject.
  const claimed = decisionsPath(home, batchId).replace(/decisions\.json$/, `decisions-consumed-${Date.now()}-${randomBytes(3).toString("hex")}.json`);
  try { renameSync(decisionsPath(home, batchId), claimed); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return none; throw e; } // nothing to claim (no decisions yet / a concurrent consumer won)
  const doc = readJsonOrNull(claimed, validDecisionsDoc); // read the claimed file, not a pre-claim cache (DB-P1-2)
  // DB-P1-1: the claimed doc MUST be bound to THIS batch. A misbound (foreign batchId) or corrupt claim yields NO actionable
  // verdict and is NOT marked consumed — a foreign drop is archived aside but cannot strand the user's real decisions.
  if (!doc || doc.batchId !== batchId) return { ...none, unknownIds: doc ? doc.decisions.map((d) => d.id) : [] };
  const res = resolveBatch(batch, doc);
  // DB-P1-3: record the consume durably BEFORE returning, so a subsequent re-written decisions.json (or a racing consumer that
  // reaches here after a mid-flight rewrite) cannot re-release this batch's verdicts.
  writeJsonAtomic(consumedMarkerPath(home, batchId), { batchId, decidedAtSec: doc.decidedAtSec, consumedAtMs: Date.now() });
  return { ...res, consumed: true };
}

/** List batchIds that have a batch.json (console index). Best-effort; unreadable ⇒ []. */
export function listBatches(home: string): string[] {
  try {
    return readdirSync(batchesDir(home), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(batchPath(home, d.name)))
      .map((d) => d.name);
  } catch { return []; }
}
