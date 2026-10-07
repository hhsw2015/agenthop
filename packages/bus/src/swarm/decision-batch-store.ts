/**
 * Decision-batch IO store (R22-P1①). Persists a batch the coordinator asks the user to clear, reads the user's verdicts, and
 * CONSUMES them exactly once (atomic rename = the same claim discipline as the inbox) so the coordinator never executes a
 * verdict set twice. Reuses composeInboxMsg/writeInbox to notify (no new transport). Files under
 * ~/.agenthop/console/decision-batches/<batchId>/.
 *
 * Hardened with the chat-room review lessons: safe batchId (reject, never sanitize), validate at the write boundary, ENOENT
 * (absent) distinguished from a real read error (EACCES → throw, never treated as empty), corrupt-but-readable → null.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
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
  return readJsonOrNull(decisionsPath(home, batchId), validDecisionsDoc);
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
  if (existing) return existing;
  const batch = buildBatch({ batchId, owner: i.owner, items: i.items, nowSec: i.nowSec });
  writeBatch(home, batch);
  if (i.notifyTo) {
    try {
      writeInbox(home, i.notifyTo, composeInboxMsg({
        from: i.owner, fromLabel: "coordinator",
        text: `${batch.items.length} decision(s) pending — clear batch ${batchId} (approve/reject/defer)`,
        via: "decision-batch", ts: i.nowSec * 1000, taskRef: `decision-batch:${batchId}`, title: "decisions pending",
      }));
    } catch { /* best-effort notify; the batch is persisted regardless and the console can list it */ }
  }
  return batch;
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
  const doc = readDecisions(home, batchId);
  if (!doc) return { resolved: [], undecided: batch.items, unknownIds: [], consumed: false }; // user has not decided yet
  const res = resolveBatch(batch, doc);
  // consume-once: claim the decisions by atomic rename. Only the winner (rename succeeds) gets the resolution; a loser (the
  // file already moved ⇒ ENOENT) returns not-consumed so no double execution.
  const consumedTo = decisionsPath(home, batchId).replace(/decisions\.json$/, `decisions-consumed-${Date.now()}-${randomBytes(3).toString("hex")}.json`);
  try { renameSync(decisionsPath(home, batchId), consumedTo); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { resolved: [], undecided: batch.items, unknownIds: [], consumed: false }; throw e; }
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
