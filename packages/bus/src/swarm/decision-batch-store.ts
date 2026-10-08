/**
 * Decision-batch IO store (R22-P1①). Persists a batch the coordinator asks the user to clear, reads the user's verdicts, and
 * CONSUMES them exactly once (atomic rename = the same claim discipline as the inbox) so the coordinator never executes a
 * verdict set twice. Reuses composeInboxMsg/writeInbox to notify (no new transport). Files under
 * ~/.agenthop/console/decision-batches/<batchId>/.
 *
 * Hardened with the chat-room review lessons: safe batchId (reject, never sanitize), validate at the write boundary, ENOENT
 * (absent) distinguished from a real read error (EACCES → throw, never treated as empty), corrupt-but-readable → null.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, statSync, unlinkSync, linkSync } from "node:fs";
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
/** Durable per-batch files (existence = the fact), all inside the batch dir.
 *  - `consumed.json`: the TERMINAL marker. Committed via temp+link (`createExclusiveAtomic`) so it appears ONLY with COMPLETE
 *    content (a half-written marker never seals the batch, DB-R2-P1-1) and is the atomic batch-level single winner (DB-P1-3).
 *  - `decisions-consumed-claim.json`: the CLAIM — a consume moves decisions.json here (claim-before-read, DB-P1-2) under ONE
 *    STABLE name, so a newer claim atomically OVERWRITES an older one (the latest decision wins without any wall-clock/random
 *    ordering, DB-R3-P1-1); if a consume faults before the terminal marker this file is a RECOVERABLE claim a retry finishes
 *    (DB-R2-P1-1). `decisions-rejected-claim.json`: a misbound/corrupt claim set aside.
 *  - `notified.json` (intent, pre-send), `notified.lock` (exclusive notify lock), `notified.sent` (proof of a landed ping):
 *    the notify is sent at most once even under concurrency/faults (DB-P1-4 / R2-P2-1 / R3-P2-1). `notified.sent` — NOT the
 *    intent — is the only "definitely sent" signal. */
function consumedMarkerPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "consumed.json"); }
function claimPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "decisions-consumed-claim.json"); }
function rejectedClaimPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "decisions-rejected-claim.json"); }
function notifiedMarkerPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.json"); }
function notifyLockPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.lock"); }
function notifiedSentPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.sent"); }

/** Atomically create `target` with COMPLETE `content`, exclusively (no overwrite): write a temp fully, then `link` it into
 *  place. The name appears only once the bytes are all written (a partial/interrupted write — EFBIG, a crash — never yields a
 *  half-written committed file, DB-R2-P1-1), and `link` is no-overwrite so only ONE creator wins (DB-P1-3 / DB-R3-P2-1).
 *  Returns "created" (we won) | "exists" (someone already created it). A write/link fault (EFBIG/EACCES/…) THROWS, leaving no
 *  committed target. */
function createExclusiveAtomic(target: string, content: string): "created" | "exists" {
  const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  try { writeFileSync(tmp, content, { mode: 0o600 }); }
  catch (e) { try { unlinkSync(tmp); } catch { /* best-effort */ } throw e; } // write fault ⇒ no commit; the target never appears
  try { linkSync(tmp, target); }
  catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists"; // another creator won
    throw e;
  }
  try { unlinkSync(tmp); } catch { /* the link holds the inode; dropping the temp name is best-effort */ }
  return "created";
}

/** Does a path exist? ENOENT ⇒ false (absent); any other error (EACCES/…) THROWS — a read failure is NEVER treated as
 *  "absent" (the same discipline readJsonOrNull uses), so a permission glitch can't be mistaken for "not yet consumed/notified/
 *  claimed" and re-release verdicts, re-notify, or re-claim. existsSync is deliberately NOT used here (it folds every error
 *  into false). */
function existsStrict(file: string): boolean {
  try { statSync(file); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/** The inode of `file`, or null if absent (ENOENT). Any other error (EACCES/…) THROWS. Used to BIND a consume to the exact
 *  claim INSTANCE it read: a concurrent consumer that overwrites decisions.json → the stable claim path replaces the inode, and
 *  the old reader must neither commit its stale verdict nor archive the newer instance (DB-R3-P1-1). */
function claimIno(file: string): number | null {
  try { return statSync(file).ino; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
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

/** Send the compression ping at most once, even under concurrency and faults (DB-P1-4 / DB-R2-P2-1 / DB-R3-P2-1). Three files:
 *  `notified.sent` is the ONLY "definitely sent" proof (written AFTER the send); `notified.lock` is an exclusive link-lock that
 *  serializes concurrent notifiers; `notified.json` is a pre-send intent record (its rename is where the fault/concurrency tests
 *  inject). Flow: if `notified.sent` exists → done (no dup). Else take the exclusive lock; a loser re-checks `notified.sent` and,
 *  if still absent, throws UNCERTAIN (another notifier is in-flight or faulted — never a silent skip, never a blind re-send). The
 *  lock holder writes the intent, sends, then records `notified.sent`. A failure BEFORE a confirmed send releases the lock (so a
 *  retry re-sends exactly one); a failure AFTER the send (only the proof-write left) keeps the lock, so a retry returns UNCERTAIN
 *  rather than re-pinging. A leftover intent marker is NEVER treated as "sent". */
function notifyOnce(home: string, batchId: string, owner: string, itemCount: number, notifyTo: string, nowSec: number): void {
  const sent = notifiedSentPath(home, batchId);
  if (existsStrict(sent)) return; // proof-of-sent present ⇒ already delivered ⇒ never re-send
  const lock = notifyLockPath(home, batchId);
  if (createExclusiveAtomic(lock, JSON.stringify({ to: notifyTo, at: nowSec })) === "exists") {
    if (existsStrict(sent)) return; // the lock holder completed the send
    // DB-N1: the holder may have sent the ping and only failed to record the proof — so this is DELIVERY-UNCONFIRMED, not
    // definitively "unsent". Surface it as uncertain (never a silent skip, never a blind re-send that could duplicate).
    throw new Error(`notifyOnce: batch ${batchId} notification delivery is unconfirmed (a prior notifier is in-flight or faulted after possibly sending) — not re-sending to avoid a duplicate ping`);
  }
  // We hold the exclusive lock. Record the pre-send intent (its rename is the tests' injection point), then send, then prove it.
  try { writeJsonAtomic(notifiedMarkerPath(home, batchId), { to: notifyTo, notifiedAtSec: nowSec }); }
  catch (e) { try { unlinkSync(lock); } catch { /* retry then returns uncertain, never a silent skip */ } throw e; } // intent failed, nothing sent ⇒ release
  try {
    writeInbox(home, notifyTo, composeInboxMsg({
      from: owner, fromLabel: "coordinator",
      text: `${itemCount} decision(s) pending — clear batch ${batchId} (approve/reject/defer)`,
      via: "decision-batch", ts: nowSec * 1000, taskRef: `decision-batch:${batchId}`, title: "decisions pending",
    }));
  } catch (e) {
    // Send FAILED (nothing delivered) ⇒ release the lock + roll back the intent so a retry re-sends exactly one. If these
    // best-effort cleanups also fail (e.g. the dir is read-only), the lock lingers ⇒ a later retry returns UNCERTAIN — never a
    // silent "success" with zero pings (DB-R2-P2-1).
    try { unlinkSync(lock); } catch { /* lingers ⇒ retry is uncertain, not silently sent */ }
    try { unlinkSync(notifiedMarkerPath(home, batchId)); } catch { /* best-effort */ }
    throw e;
  }
  // Sent. Record the proof. If THIS throws, the lock is intentionally NOT released: a retry sees lock + no proof ⇒ UNCERTAIN,
  // never a duplicate ping (we cannot prove the proof-write's failure means the ping didn't land — it did).
  writeJsonAtomic(sent, { to: notifyTo, notifiedAtSec: nowSec });
}

export type ConsumeResult = { resolved: ResolvedDecision[]; undecided: DecisionItem[]; unknownIds: string[]; consumed: boolean };

/**
 * Consume the user's decisions for a batch EXACTLY ONCE across concurrent consumers, sequential re-submits, AND a fault +
 * retry. Shape: (1) a batch consumed once is TERMINAL (consumed.json, which only ever appears COMPLETE); (2) a claim moves
 * decisions.json → a STABLE name (decisions-consumed-claim.json) and reads THAT — a mid-consume fault leaves a recoverable claim
 * a retry finishes (never a stranded throwaway), and a newer claim atomically overwrites an older one so the latest decision
 * wins without wall-clock ordering; (3) the batch's single winner is whoever EXCLUSIVE-creates consumed.json (a claim rename
 * alone is not a batch-level commit). `consumed:false` + all-undecided means: not decided yet, OR a racer already closed the
 * batch. The coordinator executes `resolved` (approve/reject) and re-batches `undecided` + deferred under a NEW batchId.
 */
export function consumeDecisions(home: string, batchId: string): ConsumeResult {
  const batch = readBatch(home, batchId); // DB-P1-1: dir-bound — a planted/foreign batch.json reads as null ⇒ "no such batch"
  if (!batch) throw new Error(`consumeDecisions: no such batch ${batchId}`);
  const none: ConsumeResult = { resolved: [], undecided: batch.items, unknownIds: [], consumed: false };
  const consumedMarker = consumedMarkerPath(home, batchId);
  const claim = claimPath(home, batchId);
  const rejected = rejectedClaimPath(home, batchId);
  // DB-P1-3: a batch consumed once is TERMINAL — consumed.json only ever appears COMPLETE (createExclusiveAtomic), so its mere
  // presence is a true "done"; a half-written marker can never seal the batch (DB-R2-P1-1).
  if (existsStrict(consumedMarker)) return none;
  // Acquire a claim, in order of preference:
  //  (1) a FRESH decisions.json — claim it (rename → the STABLE claim name) so the LATEST decision wins (DB-R3-P1-1);
  //  (2) the stable claim — RESUME a prior consume that faulted before the terminal marker;
  //  (3) a VALID doc stranded in decisions-rejected-claim.json — RECOVER it. A mis-archive under contention (or a restore that
  //      faulted, DB-R2-P1-1 / DB-R3-P1-1) can leave a real decision in the rejected slot; a genuinely-foreign doc (batchId≠dir)
  //      is left there. Recovering a bound doc keeps a valid verdict from being stranded after an archive fault.
  let haveClaim = false;
  if (existsStrict(decisionsPath(home, batchId))) {
    try { renameSync(decisionsPath(home, batchId), claim); haveClaim = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } // a racer took decisions.json first ⇒ fall through
  }
  if (!haveClaim && existsStrict(claim)) haveClaim = true;
  if (!haveClaim && existsStrict(rejected)) {
    const r = readJsonOrNull(rejected, validDecisionsDoc);
    if (r && r.batchId === batchId) { try { renameSync(rejected, claim); haveClaim = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  }
  if (!haveClaim) return none; // nothing to consume (no decisions yet / a racer already claimed+closed)
  // DB-R3-P1-1 instance binding: capture the inode of the claim we are about to READ. A concurrent consumer that overwrites
  // decisions.json → claim replaces this inode; we must then neither commit our stale read nor archive the newer instance.
  const readIno = claimIno(claim);
  if (readIno === null) return none; // the claim vanished (a racer took and closed it)
  const doc = readJsonOrNull(claim, validDecisionsDoc); // reads exactly these bytes; a concurrent replace lands on a NEW inode
  // DB-P1-1: the claimed doc MUST be bound to this batch. A misbound/corrupt claim yields NO actionable verdict and is set aside
  // (decisions-rejected-claim.json). If the archive actually moved a DIFFERENT (newer) inode — a concurrent claim slipped into the
  // path during the rename — restore it so the newer decision is recovered on retry (via source (3) above).
  if (!doc || doc.batchId !== batchId) {
    try {
      renameSync(claim, rejected);
      if (claimIno(rejected) !== readIno) { try { renameSync(rejected, claim); } catch { /* a racer re-took it */ } }
    } catch { /* claim raced away */ }
    return { ...none, unknownIds: doc ? doc.decisions.map((d) => d.id) : [] };
  }
  const res = resolveBatch(batch, doc);
  // DB-R3-P1-1 (atomic bind, not a stat race): the terminal commit must act on the SAME instance we read. A bare stat-then-link
  // is a TOCTOU (the claim can be replaced between the check and the link). Instead COMMIT, then VERIFY the claim is still our
  // instance; if a newer decision replaced it (so we would have sealed a superseded verdict), UNDO the just-created marker and
  // abort — the newer claim is consumed on a retry. "exists" ⇒ another consumer already committed ⇒ execute nothing.
  if (createExclusiveAtomic(consumedMarker, JSON.stringify({ batchId, decidedAtSec: doc.decidedAtSec, consumedAtMs: Date.now() })) === "exists") return none;
  if (claimIno(claim) !== readIno) { try { unlinkSync(consumedMarker); } catch { /* already gone */ } return none; }
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
