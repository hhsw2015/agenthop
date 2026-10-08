/**
 * Decision-batch IO store (R22-P1①). Persists a batch the coordinator asks the user to clear, reads the user's verdicts, and
 * CONSUMES them exactly once (atomic rename = the same claim discipline as the inbox) so the coordinator never executes a
 * verdict set twice. Reuses composeInboxMsg/writeInbox to notify (no new transport). Files under
 * ~/.agenthop/console/decision-batches/<batchId>/.
 *
 * Hardened with the chat-room review lessons: safe batchId (reject, never sanitize), validate at the write boundary, ENOENT
 * (absent) distinguished from a real read error (EACCES → throw, never treated as empty), corrupt-but-readable → null.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, statSync, unlinkSync, linkSync, rmSync, rmdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
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

/** The per-batch EXCLUSIVE consume lock — a lock DIRECTORY (atomic mkdir) whose HOLDER IDENTITY is the NAME of the single file
 *  inside it (`<pid>.<nonce>`), ported from the proven vm-ssh `withIdLock`. Identity-in-the-FILENAME makes reclaim structurally
 *  race-free (DB-R7): a dead holder is reclaimed by removing its EXACT-named file, never a successor's. The mkdir→publish step
 *  leaves the dir momentarily EMPTY, and an empty dir ALONE is indistinguishable from a LIVE in-flight acquisition (which must
 *  NEVER be stolen). So every acquirer first writes a pre-mkdir HOLD-INTENT credential `consume.lockd.hold.<pid>.<nonce>` while
 *  the parent is still writable — it SURVIVES even a compensation that itself faults (the parent/lock dir turning unwritable
 *  mid-cleanup) and names the faulter's pid. An empty lock dir is then recoverable iff NO hold-intent of a LIVE FOREIGN pid
 *  exists (a faulted holder's intent is dead/own ⇒ reclaim; a live holder's intent is alive ⇒ contend) — so a faulted empty dir
 *  recovers the original verdict on retry while a live in-flight one is never reclaimed. */
function consumeLockDir(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "consume.lockd"); }
const HOLD_INTENT_PREFIX = "consume.lockd.hold.";
function holdIntentPath(home: string, batchId: string, token: string): string { return path.join(batchDir(home, batchId), `${HOLD_INTENT_PREFIX}${token}`); }
/** True while pid is a running process (EPERM = exists, not ours = alive). Only a definite ESRCH is "dead". */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** Hold-intents in the batch dir (the empty-window recovery credentials), with the owning pid parsed from each name. A READ
 *  FAILURE (EACCES/…) PROPAGATES — inability to read the intents must NEVER be folded to "no intents" (DB-R7 A): it cannot
 *  authorize reclaiming an empty lock dir that a live holder may own. */
function listHoldIntents(home: string, batchId: string): { name: string; pid: number }[] {
  return readdirSync(batchDir(home, batchId)).filter((n) => n.startsWith(HOLD_INTENT_PREFIX)).map((n) => ({ name: n, pid: Number(n.slice(HOLD_INTENT_PREFIX.length).split(".")[0]) }));
}
/** Acquire the per-batch consume lock. Returns our identity token (`<pid>.<nonce>`) if held by us, else null (contended). */
function acquireConsumeLock(home: string, batchId: string): string | null {
  const dir = consumeLockDir(home, batchId);
  const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const mine = path.join(dir, token);
  const intent = holdIntentPath(home, batchId, token);
  // Stage our hold-intent FIRST, while the parent is writable — the credential that keeps the brief empty mkdir→publish window
  // (and any faulted cleanup that can no longer touch the lock dir) recoverable WITHOUT stealing a live acquirer.
  try { writeFileSync(intent, "", { flag: "wx", mode: 0o600 }); } catch { return null; } // cannot even stage ⇒ contended (rare)
  const dropIntent = () => { try { unlinkSync(intent); } catch { /* best-effort */ } };
  // Win the atomic mkdir, then publish our identity INSIDE the lock. A publish fault leaves an empty lock dir — our hold-intent
  // (above) remains as the recovery credential, so we RETHROW without dropping it.
  const take = (): boolean => {
    try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return false; } // held by someone
    writeFileSync(mine, "", { mode: 0o600 }); return true;
  };
  if (take()) return token; // won; identity published; intent stays as our working credential until release
  // Lock dir exists. Reclaim ONLY when the holder is provably gone.
  let entries: string[]; try { entries = readdirSync(dir); } catch { dropIntent(); return null; } // vanished mid-check ⇒ contended
  if (entries.length === 1) {
    // A PUBLISHED holder. Reclaim by its EXACT name iff dead/own (never a successor's differently-named file).
    const holder = entries[0]!;
    const hpid = Number(holder.split(".")[0]);
    if (Number.isInteger(hpid) && hpid > 0 && (hpid === process.pid || !pidAlive(hpid))) {
      let removed = false; try { rmSync(path.join(dir, holder)); removed = true; } catch { /* a peer reclaimed it first */ }
      if (removed) { try { rmdirSync(dir); } catch { /* a successor populated/removed it */ } }
      if (take()) return token; // a peer winning the fresh mkdir ⇒ fall through to contend
    }
    dropIntent(); return null; // live published holder, or reclaim lost ⇒ contended
  }
  if (entries.length === 0) {
    // EMPTY lock dir: the brief mkdir→publish window, or faulted debris, or a holder mid-release. Reclaim is bound to the
    // occupancy we actually observe, and NEVER steals a live/arriving holder (DB-R7 A & B):
    const bdir = batchDir(home, batchId);
    const liveForeign = (list: { name: string; pid: number }[]) =>
      list.some((i) => i.name !== path.basename(intent) && i.pid !== process.pid && pidAlive(i.pid));
    // (A) reading the hold-intents MUST succeed; a read fault cannot prove "no live holder" ⇒ contend (never fold to empty).
    let before: { name: string; pid: number }[]; try { before = listHoldIntents(home, batchId); } catch { dropIntent(); return null; }
    if (liveForeign(before)) { dropIntent(); return null; } // a holder is actively here ⇒ never disturb it
    // No live foreign holder observed ⇒ tentatively reclaim: drop the stale dir and re-create a FRESH one we own.
    try { rmdirSync(dir); } catch { /* already gone / a co-reclaimer; the mkdir below arbitrates */ }
    try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") { dropIntent(); return null; } throw e; } // someone else took it ⇒ contend
    // (B) RE-VERIFY against the occupancy NOW: if a live successor arrived DURING our reclaim (its hold-intent now live), YIELD
    // the fresh empty dir to it (leave it for the successor to adopt) rather than keeping a dir a live holder is using.
    let after: { name: string; pid: number }[]; try { after = listHoldIntents(home, batchId); } catch { dropIntent(); return null; }
    if (liveForeign(after)) { dropIntent(); return null; } // yield to the live successor
    for (const i of after) { if (i.name !== path.basename(intent)) { try { unlinkSync(path.join(bdir, i.name)); } catch { /* best-effort */ } } }
    writeFileSync(mine, "", { mode: 0o600 }); return token; // publish our identity into the fresh dir (a fault here leaves our intent as credential)
  }
  dropIntent(); return null; // >1 identity (ambiguous) ⇒ contended
}
/** Release: remove our identity file, drop the (now-empty) lock dir, then remove our hold-intent LAST. NEVER throws — a cleanup
 *  fault can't mask a committed result, and if the rmdir faults the hold-intent REMAINS as a recognizable recovery credential. */
function releaseConsumeLock(home: string, batchId: string, token: string): void {
  const dir = consumeLockDir(home, batchId);
  try { rmSync(path.join(dir, token), { force: true }); } catch { /* best-effort */ }
  try { rmdirSync(dir); } catch { /* a successor is in, or parent unwritable ⇒ the hold-intent below stays as the credential */ }
  try { unlinkSync(holdIntentPath(home, batchId, token)); } catch { /* best-effort; a faulted removal leaves a recoverable credential */ }
}

/** DB-R3-P1-1 / R25 orphan-recovery contract. An ORPHAN is a decision in decisions.json that is valid, bound to this batch, and
 *  NOT the verdict that was consumed — a subsequent user decision the batch never fulfilled. Identity is by CONTENT DIGEST (never a
 *  second-granularity clock, which cannot order same-second re-decisions): if the current decisions.json digests to the SAME value
 *  as the consumed verdict it is already fulfilled (no signal); otherwise it is a distinct update. The signal is a durable inbox
 *  message to the batch OWNER (the coordinator), guaranteed to reach them; the owner re-batches under a new batchId.
 *  DB-R3-P1-1: distinguish a send CLAIM from a delivered FACT. We deliver FIRST and record the `orphan-<digest>.sent` PROOF only
 *  AFTER the inbox write succeeds — so a delivery that FAULTS leaves NO proof and PROPAGATES, and a retry re-sends exactly one
 *  (a pre-send claim must never make a failed delivery look done). Concurrent double-send is prevented by the CONSUME LOCK (every
 *  emit runs under it — the terminal path takes it too), not by a marker; the per-update `.sent` proof then dedups across retries
 *  so a LATER different update (new digest) is never blocked by an earlier one (B), and the consumed verdict never re-signals. */
function digestDoc(doc: DecisionsDoc): string {
  return createHash("sha256").update(JSON.stringify({ batchId: doc.batchId, decidedAtSec: doc.decidedAtSec, decisions: doc.decisions })).digest("hex");
}
function orphanSentPath(home: string, batchId: string, digest: string): string { return path.join(batchDir(home, batchId), `orphan-${digest}.sent`); }
function emitOrphanSignal(home: string, batchId: string, owner: string): void {
  const orphan = readJsonOrNull(decisionsPath(home, batchId), validDecisionsDoc);
  if (!orphan || orphan.batchId !== batchId) return; // no valid pending decision
  const digest = digestDoc(orphan);
  const consumed = readJsonOrNull(consumedMarkerPath(home, batchId), (raw) => (raw !== null && typeof raw === "object" && typeof (raw as Record<string, unknown>).digest === "string" ? (raw as { digest: string }) : null));
  if (consumed && consumed.digest === digest) return; // this IS the consumed verdict (already fulfilled) ⇒ not an orphan
  const sent = orphanSentPath(home, batchId, digest);
  if (existsStrict(sent)) return; // PROOF-OF-SENT present ⇒ this exact update already reached the owner ⇒ never re-send
  // Deliver first; a fault here PROPAGATES with no proof recorded ⇒ a retry re-sends exactly one (DB-R3-P1-1).
  writeInbox(home, owner, composeInboxMsg({
    from: owner, fromLabel: "decision-batch",
    text: `orphan decision in batch ${batchId} (digest ${digest.slice(0, 12)}) arrived but was not consumed — re-batch it under a new batchId`,
    via: "decision-batch", taskRef: `decision-batch:${batchId}`, title: "orphan decision — re-batch",
  }));
  try { createExclusiveAtomic(sent, JSON.stringify({ digest, at: Date.now() })); } catch { /* proof write faulted AFTER a good send ⇒ a retry may re-send one (a duplicate re-batch is recoverable; a lost signal is not) */ }
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
  // DB-P1-3 (write boundary): a batch consumed once is DONE — refuse to persist fresh decisions into it. A concurrent write
  // DURING a consume is intentionally ALLOWED (not locked): the newer decision must be able to win (R24: valid verdict
  // recoverable / latest wins), and the consume RE-CLAIMS the latest decisions.json right before it commits.
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

export type ConsumeResult = { resolved: ResolvedDecision[]; undecided: DecisionItem[]; unknownIds: string[]; consumed: boolean; contended?: boolean };

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
  // R24/R25: take the per-batch EXCLUSIVE consume lock for the WHOLE critical section (serializes consumers; the terminal marker
  // is created once and FINAL). The terminal orphan signal runs under the lock too, so concurrent emitters never double-send
  // (DB-R3-P1-1 — the dedup is the lock + the post-send `.sent` proof, not a pre-send claim). A consumer that cannot take the
  // lock returns an explicit `contended` receipt (a concurrent holder is already emitting/committing).
  const token = acquireConsumeLock(home, batchId);
  if (token === null) return { ...none, contended: true };
  try {
    if (existsStrict(consumedMarker)) { emitOrphanSignal(home, batchId, batch.owner); return none; } // terminal — surface any orphan (R25), under the lock
    const claim = claimPath(home, batchId);
    const dpath = decisionsPath(home, batchId);
    // Claim the LATEST decision: a FRESH decisions.json first; else RESUME a prior in-progress claim; else RECOVER a VALID doc
    // stranded in the rejected slot (foreign — batchId≠dir — left there). writeDecisions is NOT locked (R25: concurrent writes
    // are accepted, not refused), so a newer decision may land concurrently — we re-claim it below so the latest wins.
    if (existsStrict(dpath)) {
      renameSync(dpath, claim);
    } else if (!existsStrict(claim)) {
      const rejected = rejectedClaimPath(home, batchId);
      if (existsStrict(rejected)) {
        const r = readJsonOrNull(rejected, validDecisionsDoc);
        if (r && r.batchId === batchId) renameSync(rejected, claim); // recover a valid stranded decision
      }
    }
    if (existsStrict(dpath)) renameSync(dpath, claim); // R25 (newer wins): a write that landed during acquire/recover supersedes
    if (!existsStrict(claim)) return none; // nothing to consume (no decisions yet)
    const doc = readJsonOrNull(claim, validDecisionsDoc);
    // DB-P1-1: the claimed doc MUST be bound to this batch; a misbound/corrupt claim yields NO actionable verdict, set aside.
    if (!doc || doc.batchId !== batchId) {
      try { renameSync(claim, rejectedClaimPath(home, batchId)); } catch { /* raced away */ }
      return { ...none, unknownIds: doc ? doc.decisions.map((d) => d.id) : [] };
    }
    const res = resolveBatch(batch, doc);
    // FINAL terminal commit (temp+link). DB-R7: if a concurrent consumer already created consumed.json ("exists"), we LOST the
    // race — return NOT consumed (never return an executable verdict for a lost commit; no double-execute). EFBIG/EACCES THROWS
    // with the claim intact ⇒ finally releases the lock, a retry resumes the SAME claim.
    if (createExclusiveAtomic(consumedMarker, JSON.stringify({ batchId, decidedAtSec: doc.decidedAtSec, consumedAtMs: Date.now(), digest: digestDoc(doc) })) === "exists") return none;
    emitOrphanSignal(home, batchId, batch.owner); // a decision that landed during this consume (now terminal) is an orphan — signal it (R25)
    return { ...res, consumed: true };
  } finally { releaseConsumeLock(home, batchId, token); }
}

/** List batchIds that have a batch.json (console index). Best-effort; unreadable ⇒ []. */
export function listBatches(home: string): string[] {
  try {
    return readdirSync(batchesDir(home), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(batchPath(home, d.name)))
      .map((d) => d.name);
  } catch { return []; }
}
