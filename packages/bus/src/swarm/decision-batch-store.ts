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
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { writeInbox, composeInboxMsg } from "../inbox.js";
import { acquireHolderLock, releaseHolderLock, type LockSite } from "./holder-lock.js";
import {
  type DecisionBatch, type DecisionsDoc, type DecisionItem, type ResolvedDecision, type Decision, type SlotKind,
  validDecisionBatch, validDecisionsDoc, buildBatch, resolveBatch, enforceScope, foldDecisionDocs,
} from "./decision-batch.js";

const SAFE_BATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;
function assertSafeBatchId(id: string): void {
  if (typeof id !== "string" || !SAFE_BATCH_ID.test(id)) throw new Error(`decision-batch: unsafe batchId ${JSON.stringify(id)} — allowed [A-Za-z0-9_-], 1-64 chars`);
}

function batchesDir(home: string): string { return path.join(home, ".agenthop", "console", "decision-batches"); }
function batchDir(home: string, batchId: string): string { assertSafeBatchId(batchId); return path.join(batchesDir(home), batchId); }
function batchPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "batch.json"); }
// TG-R6-P2-1: the BASELINE (bdd93d7) pending-decisions file, read ONLY for backward-compat import of a batch created before the
// slot ledger existed (never written by this version).
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
// TG-R6-P2-1: the BASELINE's mis-archived-but-recoverable claim slot (never written by this version) — imported for compat.
function rejectedClaimPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "decisions-rejected-claim.json"); }
function notifiedMarkerPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.json"); }
function notifyLockPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.lock"); }
function notifiedSentPath(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "notified.sent"); }
/** TG-R3 (round 6): the APPEND-ONLY SLOT LEDGER. EVERY publish — a console full-snapshot (writeDecisions) and a single-item entry
 *  tap (recordDecision) — grabs the next free monotonic slot `seq/<n>.json` via an EXCLUSIVE create (O_CREAT|O_EXCL semantics,
 *  reusing createExclusiveAtomic's temp+link). Winning slot `n` atomically fixes this decision's PUBLISH ORDER; the record is
 *  IMMUTABLE (never rewritten/renamed/chmod-reordered), so the order is DURABLE and BOUND to that exact decision version — unlike a
 *  filesystem ctime/mtime (which a rename or chmod shifts, and a stat-after-read can skew). The fold orders by the slot number, so
 *  read and consume share ONE order (naturally consistent, no per-consumer stack-variable ordering). No post-hoc marker needed. */
function slotsDir(home: string, batchId: string): string { return path.join(batchDir(home, batchId), "seq"); }
function slotPath(home: string, batchId: string, n: number): string { return path.join(slotsDir(home, batchId), `${n}.json`); }

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

/** The per-batch EXCLUSIVE consume lock, now the shared holder-identity lock (DA2-R6, extracted to ./holder-lock.ts — the proven
 *  DB-R7 lock, ported from vm-ssh `withIdLock`). The lock DIRECTORY is `consume.lockd` inside the batch dir; its hold-intents
 *  live beside it in the batch dir under the `consume.lockd.hold.` prefix. These paths are UNCHANGED from the in-file version, so
 *  behavior is identical — the logic simply lives in one shared module both this store and the shared-budget pool call. */
function consumeLockSite(home: string, batchId: string): LockSite {
  const bdir = batchDir(home, batchId);
  return { lockDir: path.join(bdir, "consume.lockd"), intentDir: bdir, intentPrefix: "consume.lockd.hold." };
}
/** Acquire the per-batch consume lock. Returns our identity token (`<pid>.<nonce>`) if held by us, else null (contended). */
function acquireConsumeLock(home: string, batchId: string): string | null { return acquireHolderLock(consumeLockSite(home, batchId)); }
/** Release: remove our identity file, drop the (now-empty) lock dir, then remove our hold-intent. NEVER throws. */
function releaseConsumeLock(home: string, batchId: string, token: string): void { releaseHolderLock(consumeLockSite(home, batchId), token); }

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
  const orphan = readDecisions(home, batchId); // the CURRENT folded slot ledger (every published decision, by slot order)
  if (!orphan) return; // no valid pending decision
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
  // The EFFECTIVE ledger = legacy baseline data (imported for compat) THEN every published slot, FOLDED by order PRESERVING publish
  // semantics (snapshot replaces / tap merges, TG-R6-P1-1). read and consume fold the SAME entries, so they are naturally consistent
  // (TG-R3-P2-1); the order is the immutable slot index, not a drift-prone filesystem timestamp. null when there is nothing.
  return foldDecisionDocs(readLedgerEntries(home, batchId), batchId);
}

/** The full fold input: legacy baseline data (imported for compat, TG-R6-P2-1) folded in BEFORE every slot, THEN the slot ledger.
 *  A read error PROPAGATES. The legacy files are console FULL SNAPSHOTS in baseline PRECEDENCE: the mis-archived rejected-claim
 *  (oldest, order -3), the recoverable consumed-claim (-2), then decisions.json (freshest, -1, supersedes the others). These are
 *  imported UNCONDITIONALLY (not gated on sealed) so the fold is IDENTICAL before and after a consume seals — otherwise a sealed
 *  batch would drop the import and the post-seal read would differ from the consumed digest, firing a FALSE orphan (R6-P2-1 A).
 *  `decisions.json` and the rejected-claim are never written by this version (always baseline). The consumed-claim is EITHER a
 *  baseline recoverable claim OR this version's consumed PROJECTION; importing it as a snapshot is correct for BOTH — the slots
 *  re-apply on top (idempotent for a projection, since a projection IS the slots' fold), so it never double-counts or mis-orders. */
function readLedgerEntries(home: string, batchId: string): { doc: DecisionsDoc; order: bigint; kind: SlotKind }[] {
  const entries: { doc: DecisionsDoc; order: bigint; kind: SlotKind }[] = [];
  const rej = readJsonOrNull(rejectedClaimPath(home, batchId), validDecisionsDoc);
  if (rej && rej.batchId === batchId) entries.push({ doc: rej, order: -3n, kind: "snapshot" });
  const claim = readJsonOrNull(claimPath(home, batchId), validDecisionsDoc);
  if (claim && claim.batchId === batchId) entries.push({ doc: claim, order: -2n, kind: "snapshot" });
  const snap = readJsonOrNull(decisionsPath(home, batchId), validDecisionsDoc);
  if (snap && snap.batchId === batchId) entries.push({ doc: snap, order: -1n, kind: "snapshot" });
  entries.push(...readSlots(home, batchId));
  return entries;
}

/** Read every published SLOT for a batch as {doc, order=slot#, kind}. A dir/file read error PROPAGATES (never folded to [] — a lost
 *  slot is a lost/miscounted verdict); a missing dir ⇒ none; a corrupt/misbound slot ⇒ skipped. The slot is IMMUTABLE, so one read
 *  is a consistent snapshot (no stat/ctime race): the order is the filename's integer, bound to the record written at slot creation. */
function readSlots(home: string, batchId: string): { doc: DecisionsDoc; order: bigint; kind: SlotKind }[] {
  let names: string[];
  try { names = readdirSync(slotsDir(home, batchId)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const out: { doc: DecisionsDoc; order: bigint; kind: SlotKind }[] = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name); // only canonical slot files (skip temps / anything else)
    if (!m) continue;
    const slot = readSlotFile(path.join(slotsDir(home, batchId), name)); // throws on a real read error ⇒ kept, not dropped
    if (slot && slot.doc.batchId === batchId) out.push({ doc: slot.doc, order: BigInt(m[1]!), kind: slot.kind });
  }
  return out;
}

/** Read one immutable slot file: its DecisionsDoc + its publish KIND. ENOENT/corrupt ⇒ null; a real read error (EACCES) PROPAGATES.
 *  A record missing `kind` (never written by this version) defaults to "snapshot" — the safe full-replace. */
function readSlotFile(file: string): { doc: DecisionsDoc; kind: SlotKind } | null {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; } // readable-but-corrupt ⇒ null
  const doc = validDecisionsDoc(parsed);
  if (!doc) return null;
  const kind: SlotKind = (parsed as { kind?: unknown }).kind === "tap" ? "tap" : "snapshot";
  return { doc, kind };
}

/** The highest published slot number + 1 (the probe start for the next publish). ENOENT ⇒ 0; a read error PROPAGATES (a publisher
 *  must not silently start at 0 against an unreadable ledger). */
function nextSlotStart(home: string, batchId: string): number {
  let names: string[];
  try { names = readdirSync(slotsDir(home, batchId)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0; throw e; }
  let max = -1;
  for (const name of names) { const m = /^(\d+)\.json$/.exec(name); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

/** Publish ONE decision record (with its KIND) by COMPETING for the next free monotonic slot: probe n = highest+1, EXCLUSIVE-create
 *  seq/<n>.json; on EEXIST (a concurrent publisher won n) probe n+1 and retry. The slot that is exclusively created IS the acceptance
 *  point — the publish order is fixed atomically and the record is immutable, so no later op can drift it. TG-R6-P1-1: `kind`
 *  (snapshot|tap) is stored IN the record so the fold preserves publish semantics (replace vs merge). Returns the slot number. */
function publishSlot(home: string, batchId: string, record: DecisionsDoc, kind: SlotKind): number {
  mkdirSync(slotsDir(home, batchId), { recursive: true, mode: 0o700 });
  let n = nextSlotStart(home, batchId);
  for (;;) {
    if (createExclusiveAtomic(slotPath(home, batchId, n), JSON.stringify({ ...record, kind })) === "created") return n;
    n += 1; // the slot was taken by a concurrent publisher ⇒ a LATER publisher gets a HIGHER slot ⇒ publish order preserved
  }
}

/** Persist a batch (validate at the write boundary — never persist a batch the read side would reject, e.g. a duplicate id). */
function writeBatch(home: string, batch: DecisionBatch): void {
  const valid = validDecisionBatch(batch);
  if (!valid) throw new Error("writeBatch: refusing to persist an invalid decision batch (batchId/owner non-empty, finite ts, unique valid items)");
  writeJsonAtomic(batchPath(home, valid.batchId), valid);
}

/** Write the user's decisions (validate at the write boundary). The console/CLI calls this after the user clears the batch —
 *  ONE publish event = ONE immutable slot (the full snapshot). */
export function writeDecisions(home: string, doc: DecisionsDoc): void {
  const valid = validDecisionsDoc(doc);
  if (!valid) throw new Error("writeDecisions: refusing to persist an invalid decisions doc");
  // DB-P1-3 (write boundary): a batch consumed once is DONE — refuse to persist fresh decisions into it. A concurrent publish
  // DURING a consume is intentionally ALLOWED (not locked, R24/R25): it grabs a HIGHER slot, so if it lands before the seal it
  // wins by slot order; if after, consume surfaces it as an orphan.
  if (existsStrict(consumedMarkerPath(home, valid.batchId))) throw new Error(`writeDecisions: batch ${valid.batchId} already consumed — remaining items are re-batched under a new batchId`);
  // TG-P1-1 (round 3): enforce the scope ladder at the WRITE boundary too (not only at resolve) — a hard-gate item can NEVER be
  // SAVED with a this-chat/always grant, from console or TG. Clamp against the REAL item; the consume-side clamp stays a backstop.
  const batch = readBatch(home, valid.batchId);
  const enforced: DecisionsDoc = batch
    ? { ...valid, decisions: valid.decisions.map((d) => { const it = batch.items.find((i) => i.id === d.id); return it ? enforceScope(it, d) : d; }) }
    : valid;
  publishSlot(home, valid.batchId, enforced, "snapshot"); // a console full clear ⇒ a SNAPSHOT slot (replaces prior state, TG-R6-P1-1)
}

/** Record ONE item's decision as its OWN immutable slot (an entry tap). Each tap COMPETES for the next slot, so the publish order
 *  is durable + bound to this exact decision (TG-R3-P1-1/P2-1) — a re-tap of the same item just grabs a LATER slot that supersedes
 *  it by order (the fold keeps the latest-per-id). Under the per-batch lock (serialized vs consume so a tap never lands mid-seal):
 *  refuse if already consumed (sealed -> a no-op, no fork), enforce the scope against the REAL item (TG-P1-1), publish the one-item
 *  slot. "contended" => a concurrent holder has the lock, the caller must retry (do NOT treat as decided). "unknown-item" => the id
 *  is not in this batch. */
export function recordDecision(home: string, batchId: string, decision: Decision, nowSec: number): "recorded" | "consumed" | "unknown-item" | "contended" {
  const batch = readBatch(home, batchId);
  if (!batch) throw new Error(`recordDecision: no such batch ${batchId}`);
  const idx = batch.items.findIndex((it) => it.id === decision.id);
  if (idx < 0) return "unknown-item";
  const token = acquireConsumeLock(home, batchId);
  if (token === null) return "contended";
  try {
    if (existsStrict(consumedMarkerPath(home, batchId))) return "consumed"; // sealed — no fork, the tap is a no-op
    publishSlot(home, batchId, { batchId, decidedAtSec: nowSec, decisions: [enforceScope(batch.items[idx]!, decision)] }, "tap"); // a single-item entry ⇒ a TAP slot (merges, preserves siblings)
    return "recorded";
  } finally { releaseConsumeLock(home, batchId, token); }
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
 * retry. Shape: (1) a batch consumed once is TERMINAL (consumed.json, which only ever appears COMPLETE); (2) the decisions are the
 * append-only SLOT LEDGER (seq/<n>.json), folded by slot order — IMMUTABLE records, so a mid-consume fault leaves them intact for a
 * retry to re-fold identically, and the latest decision wins by its higher slot (no wall-clock / ctime ordering); the merged result
 * is projected to decisions-consumed-claim.json for the existing read side; (3) the batch's single winner is whoever EXCLUSIVE-creates
 * consumed.json. `consumed:false` + all-undecided means: not decided yet, OR a racer already closed the batch. The coordinator
 * executes `resolved` (approve/reject) and re-batches `undecided` + deferred under a NEW batchId.
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
    // Read the append-only SLOT LEDGER (the single authority) and FOLD by slot order (TG-R3). Read as late as possible — right
    // before resolve+seal — so a publish that just landed (a HIGHER slot) is included (R25 newest-wins); a slot that lands AFTER
    // this read is surfaced as an orphan below. A slot read failure PROPAGATES (never a silent drop ⇒ a lost approval). The slots
    // are IMMUTABLE, so their order is the same for every reader and every retry — no claim move / permission change / stack-local
    // ordering can drift it.
    const entries = readLedgerEntries(home, batchId); // slot ledger + any legacy baseline import (TG-R6-P2-1), by publish order
    if (entries.length === 0) return none; // nothing to consume yet
    const doc = foldDecisionDocs(entries, batchId) ?? { batchId, decidedAtSec: 0, decisions: [] };
    const res = resolveBatch(batch, doc);
    // The CANONICAL consumed record — a PROJECTION of the folded ledger for the existing read side (the bandwidth collector's
    // readBoundDoc(claim), any post-consume canonical read). The slots remain the authority and keep their order; the claim never
    // changes it (reviewer ruling). Written BEFORE the seal so the projection is complete the instant the batch is terminal.
    writeJsonAtomic(claimPath(home, batchId), doc);
    // FINAL terminal commit (temp+link). DB-R7: if a concurrent consumer already created consumed.json ("exists"), we LOST the race
    // — return NOT consumed (never return an executable verdict for a lost commit; no double-execute). EFBIG/EACCES THROWS with the
    // slots intact ⇒ finally releases the lock, a retry re-folds the SAME slots (idempotent).
    if (createExclusiveAtomic(consumedMarker, JSON.stringify({ batchId, decidedAtSec: doc.decidedAtSec, consumedAtMs: Date.now(), digest: digestDoc(doc) })) === "exists") return none;
    emitOrphanSignal(home, batchId, batch.owner); // a decision that landed during this consume (a higher slot now visible, now terminal) is an orphan — signal it (R25)
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

/** Like listBatches but a dir/batch read error PROPAGATES (never folded to []): a caller resolving a callback ref must tell a
 *  batch that is GENUINELY GONE (terminal — safe to expire the tap) from a dir that is momentarily UNREADABLE (transient — the
 *  tap must be retried, never silently skipped, TG-P2-1). ENOENT (no batches dir yet) ⇒ []. existsStrict throws on an unreadable
 *  batch.json so an EACCES can't masquerade as "absent". */
export function listBatchesStrict(home: string): string[] {
  let entries;
  try { entries = readdirSync(batchesDir(home), { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  return entries.filter((d) => d.isDirectory() && existsStrict(batchPath(home, d.name))).map((d) => d.name);
}
