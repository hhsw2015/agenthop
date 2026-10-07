/**
 * Decision-batch IO store (R22-P1①). Persists a batch the coordinator asks the user to clear, reads the user's verdicts, and
 * CONSUMES them exactly once (atomic rename = the same claim discipline as the inbox) so the coordinator never executes a
 * verdict set twice. Reuses composeInboxMsg/writeInbox to notify (no new transport). Files under
 * ~/.agenthop/console/decision-batches/<batchId>/.
 *
 * Hardened with the chat-room review lessons: safe batchId (reject, never sanitize), validate at the write boundary, ENOENT
 * (absent) distinguished from a real read error (EACCES → throw, never treated as empty), corrupt-but-readable → null.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, statSync, unlinkSync } from "node:fs";
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
/** Durable per-batch files (existence = the fact). `consumed.json`: the TERMINAL marker — written with an EXCLUSIVE create so
 *  it is the atomic batch-level single-winner (DB-P1-3), not a per-file rename. `notified.json`: the compression ping landed
 *  (DB-P1-4/R2-P2-1), kept in lock-step with the send (marker⟺sent). `decisions-consumed-<ms>-<rand>.json`: a CLAIM — a consume
 *  moves decisions.json here (claim-before-read, DB-P1-2) and, if it faults before the terminal marker, this file is a
 *  RECOVERABLE claim a retry finishes (DB-R2-P1-1), not stranded verdicts. `decisions-rejected-*`: a misbound/corrupt claim set
 *  aside. All inside the batch dir. */
function consumedMarkerPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "consumed.json"); }
function notifiedMarkerPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.json"); }

/** Does a path exist? ENOENT ⇒ false (absent); any other error (EACCES/…) THROWS — a read failure is NEVER treated as
 *  "absent" (the same discipline readJsonOrNull uses), so a permission glitch can't be mistaken for "not yet consumed/notified/
 *  claimed" and re-release verdicts, re-notify, or re-claim. existsSync is deliberately NOT used here (it folds every error
 *  into false). */
function existsStrict(file: string): boolean {
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
  const batch = readJsonOrNull(batchPath(home, batchId), validDecisionBatch);
  // DB-P1-1: the batch.json's own batchId MUST equal the directory it sits in. A planted/foreign batch.json (batchId ≠ dir)
  // is NOT this batch — treat it as absent, so consume never resolves a foreign batch's items as this batch's nor seals the dir.
  if (batch && batch.batchId !== batchId) return null;
  return batch;
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
  if (existsStrict(consumedMarkerPath(home, valid.batchId))) throw new Error(`writeDecisions: batch ${valid.batchId} already consumed — remaining items are re-batched under a new batchId`);
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

/** Write ONE durable-inbox compression ping for a batch, exactly once (DB-P1-4 / DB-R2-P2-1). INVARIANT: `notified.json`
 *  exists ⟺ the ping was sent. We RECORD FIRST (write the marker), then SEND; if the send fails we ROLL BACK the marker and
 *  rethrow. So the state is never ambiguous: a present marker always means sent (⇒ a retry never re-sends → no duplicate
 *  reminder), an absent marker always means not-sent (⇒ a retry sends once). The failure is never swallowed — a send fault
 *  propagates out of openBatch so the coordinator knows the user was not pinged, and the rolled-back marker makes the retry
 *  re-send exactly one. (Recording first and rolling back on failure is what distinguishes not-sent from sent-but-unrecorded
 *  without a blind resend: the marker and the send move together.) */
function notifyOnce(home: string, batchId: string, owner: string, itemCount: number, notifyTo: string, nowSec: number): void {
  const marker = notifiedMarkerPath(home, batchId);
  if (existsStrict(marker)) return; // marker present ⇒ already sent on an earlier open ⇒ never re-send
  writeJsonAtomic(marker, { to: notifyTo, notifiedAtSec: nowSec }); // record intent FIRST (fails ⇒ throws, nothing sent, retriable)
  try {
    writeInbox(home, notifyTo, composeInboxMsg({
      from: owner, fromLabel: "coordinator",
      text: `${itemCount} decision(s) pending — clear batch ${batchId} (approve/reject/defer)`,
      via: "decision-batch", ts: nowSec * 1000, taskRef: `decision-batch:${batchId}`, title: "decisions pending",
    }));
  } catch (e) {
    try { unlinkSync(marker); } catch { /* best-effort rollback; see ceiling note */ } // send failed ⇒ undo the record so the retry re-sends
    throw e; // visible, retriable; marker⟺sent invariant preserved
  }
  // ponytail: residual window is a crash BETWEEN a failed writeInbox and the rollback unlink (marker set, not sent). chmod/EACCES
  // faults (what we test) never hit it; a true process kill there would skip one retry — acceptable vs a duplicate reminder.
}

export type ConsumeResult = { resolved: ResolvedDecision[]; undecided: DecisionItem[]; unknownIds: string[]; consumed: boolean };

/**
 * Consume the user's decisions for a batch EXACTLY ONCE across concurrent consumers, sequential re-submits, AND a fault +
 * retry. Shape: (1) a batch consumed once is TERMINAL (consumed.json); (2) a claim moves decisions.json → a STABLE in-progress
 * file (decisions.claiming.json) and reads THAT — so a mid-consume fault leaves a recoverable claim a retry finishes, never a
 * stranded throwaway; (3) the batch's single winner is whoever EXCLUSIVE-creates consumed.json (a file rename alone is not a
 * batch-level commit). `consumed:false` + all-undecided means: not decided yet, OR a racer already closed the batch. The
 * coordinator executes `resolved` (approve/reject) and re-batches `undecided` + deferred under a NEW batchId.
 */
/** The CLAIM files for a batch: `decisions-consumed-<ms>-<rand>.json` (a claimed decisions set — in-flight, or the archive of a
 *  finished consume). ENOENT ⇒ none; any other readdir error THROWS (an unreadable dir is not "no claims"). */
function listClaims(home: string, batchId: string): string[] {
  const d = batchDir(home, batchId);
  try { return readdirSync(d).filter((n) => /^decisions-consumed-.*\.json$/.test(n)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
/** The newest claim file (by the embedded ms, tiebroken by name), or null. Used to RESUME an unfinalized claim on retry. */
function latestClaim(home: string, batchId: string): string | null {
  const names = listClaims(home, batchId);
  if (names.length === 0) return null;
  names.sort((a, b) => (Number(b.match(/decisions-consumed-(\d+)/)?.[1] ?? 0) - Number(a.match(/decisions-consumed-(\d+)/)?.[1] ?? 0)) || (a < b ? 1 : -1));
  return path.join(batchDir(home, batchId), names[0]);
}

export function consumeDecisions(home: string, batchId: string): ConsumeResult {
  const batch = readBatch(home, batchId); // DB-P1-1: dir-bound — a planted/foreign batch.json reads as null ⇒ "no such batch"
  if (!batch) throw new Error(`consumeDecisions: no such batch ${batchId}`);
  const none: ConsumeResult = { resolved: [], undecided: batch.items, unknownIds: [], consumed: false };
  const consumedMarker = consumedMarkerPath(home, batchId);
  // DB-P1-3: a batch consumed once is TERMINAL — a decisions.json re-written afterwards never re-releases verdicts (remaining
  // items were re-asked under a NEW batchId). The EXCLUSIVE-created marker below is the atomic batch-level barrier.
  if (existsStrict(consumedMarker)) return none;
  // Prefer a FRESH decisions.json: claim it atomically (rename → decisions-consumed-<ts>) BEFORE reading (DB-P1-2 — a producer
  // swapping decisions.json after the claim lands on a new file, never on the verdicts we return), and let it SUPERSEDE any
  // stale unfinalized claim (DB-R2-P1-1 — a newer decision is never overwritten by a failed older claim).
  let claimFile: string | null = null;
  if (existsStrict(decisionsPath(home, batchId))) {
    const target = path.join(batchDir(home, batchId), `decisions-consumed-${Date.now()}-${randomBytes(4).toString("hex")}.json`);
    try { renameSync(decisionsPath(home, batchId), target); claimFile = target; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } // a racer took decisions.json first ⇒ fall through to resume its claim
  }
  // No fresh decision ⇒ RESUME the latest unfinalized claim (a prior consume faulted after claiming but before the terminal
  // marker). This is the recovery path: a fault leaves a recoverable claim, not "undecided"; a retry finishes it with no resubmit.
  if (!claimFile) claimFile = latestClaim(home, batchId);
  if (!claimFile) return none; // nothing to consume (no decisions yet / a racer already claimed+closed)
  const doc = readJsonOrNull(claimFile, validDecisionsDoc); // read EXACTLY the claimed bytes; EACCES → throws, the claim persists → recoverable retry (DB-R2-P1-1)
  // DB-P1-1: the claimed doc MUST be bound to this batch. A misbound (foreign batchId) or corrupt claim yields NO actionable
  // verdict and is NOT marked consumed — it is set aside (decisions-rejected-*) so it can't starve the real decisions nor be re-resumed.
  if (!doc || doc.batchId !== batchId) {
    try { renameSync(claimFile, claimFile.replace(/decisions-consumed-/, "decisions-rejected-")); } catch { /* raced away */ }
    return { ...none, unknownIds: doc ? doc.decisions.map((d) => d.id) : [] };
  }
  const res = resolveBatch(batch, doc);
  // DB-P1-3 / DB-R2-P1-1: the TERMINAL marker is an EXCLUSIVE create — the atomic batch-level single winner. A plain file rename
  // is NOT a batch commit (concurrent/raced consumers can hold claims on the same bytes); only the one that CREATES consumed.json
  // closes the batch. A loser (EEXIST) returns not-consumed and executes nothing (no double). EACCES throws with the claim intact
  // ⇒ a retry completes the SAME consume (no user resubmit).
  try { writeFileSync(consumedMarker, JSON.stringify({ batchId, decidedAtSec: doc.decidedAtSec, consumedAtMs: Date.now() }), { mode: 0o600, flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return none; throw e; } // another consumer already closed this batch
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
