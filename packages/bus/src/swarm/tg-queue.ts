/**
 * tg-queue — a durable, claim-based file queue for the TG bridge (dialog-officer item ①), mirroring the inbox claim discipline
 * (claimInbox / releaseInbox / recoverStaleClaims / quarantineInbox / retryStuckPoison). One producer drops a record keyed by a
 * MONOTONIC numeric event id (`seq`: the TG update_id for the dialog-pending queue; a producer counter for the outbox); a drainer
 * atomically CLAIMS it, runs a handler, and on success writes a DURABLE DONE marker BEFORE deleting the claim. Properties:
 *   - FIFO (DO-P2-3): the filename is the zero-padded `seq`, so a lexical sort IS arrival order (no digest/wall-clock reordering).
 *   - lossless identity (DO-P1-2): `seq` is an integer encoded verbatim (no char-fold, no truncation) ⇒ distinct events never collide;
 *     the same event reuses the SAME filename ⇒ a replay collapses to one file, never a second copy.
 *   - crash-recovery (DO-P1-1 / DO-P2-1c): a READ error KEEPS the record (release + retry — a transient fault is NEVER a proof the
 *     record is undeliverable); a parse-CORRUPT record is moved to an observable quarantine/ (FC-2), never silently deleted; a claim
 *     left by a dead pid (or a claim older than STALE_CLAIM_MS) is reclaimed.
 *   - at-LEAST-once end-to-end (DO-P2-1a/c): a completed `seq` gets a durable DONE marker (written ATOMICALLY — temp+rename, never
 *     torn), checked on BOTH enqueue and claim, so a replay or a crash-after-DONE does not re-run the handler. If the DONE write
 *     FAULTS (disk full, EIO) the claim is RELEASED, not ack'd (the completion obligation is preserved, never dropped) — so the item
 *     is re-claimed and the handler RE-RUNS. Thus a handler CAN run more than once (a DONE-write fault, a crash before DONE, or an
 *     uncertain sink response), and REPEATED faults cause REPEATED runs — there is NO max-one-duplicate guarantee. End-to-end
 *     exactly-once holds ONLY for an idempotent sink (writeInbox publishOnce dedups). For a NON-idempotent sink (TG sendMessage, no
 *     idempotency key) this queue is at-least-once; the caller must treat it so.
 *   - concurrency (DO-P2-1b): the claim name carries the pid, the CLAIM TIME, and a per-drain nonce, so two concurrent drains (even
 *     in ONE process) never share a claim; the loser of the atomic rename gets ENOENT and skips. The claim time (not the file mtime,
 *     which is the ENQUEUE time) is the claim-age basis for stale recovery (TGP-8), so a long-queued-then-freshly-claimed item is
 *     never mistaken for an abandoned claim.
 *   - stuck-recovery (DO-P2-2): a release/ack that fails on a transient FS fault is recorded in the caller's `stuck` set and
 *     re-attempted each drain (retryStuckQueue), so a live-pid claim is never permanently skipped waiting for the process to exit.
 * Never throws (fail-soft): every entry point swallows IO faults into a return value or a logged no-op.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, lstatSync, statSync, appendFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";

export type DrainResult = "sent" | "retry";
export type EnqueueResult = "enqueued" | "already" | "conflict" | "failed";
const SEQ_PAD = 20;                        // zero-pad width: a lexical sort of <pad>.json is numeric (arrival) order
const STALE_CLAIM_MS = 5 * 60_000;         // a claim older than this is reclaimed even if its pid looks alive (a drain that broke out)
const STALE_DRAINLOCK_MS = 60_000;         // a drain lock held longer than this (dead or wedged owner) is stealable
const DONE_TTL_MS = 24 * 60 * 60_000;      // DONE/cred older than this are pruned (bounded disk) — well past any live retry window
const CLAIM_SUFFIX = /\.sending-\d+-\d+\.[0-9a-f]+$/; // <pad>.json.sending-<pid>-<claimMs>.<nonce>
const CLAIM_RE = /^(.*\.json)\.sending-(\d+)-(\d+)\.[0-9a-f]+$/; // 1=base .json, 2=pid, 3=claimMs
const PENDING_RE = new RegExp(`^\\d{${SEQ_PAD}}\\.json$`);

const doneDir = (dir: string): string => path.join(dir, "done");
const credDir = (dir: string): string => path.join(dir, "cred");       // TGP-10: per-seq atomic identity credential (O_EXCL)
const quarantineDir = (dir: string): string => path.join(dir, "quarantine");
const drainLockPath = (dir: string): string => path.join(dir, "drain.lock"); // TGP-11: one drainer at a time ⇒ FIFO across drainers
const bodyHash = (body: string): string => createHash("sha256").update(body).digest("hex");

/** A pid is alive unless process.kill(pid,0) raises ESRCH. EPERM ⇒ exists (not ours) ⇒ alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Encode a seq to its fixed-width filename stem, or null if it is not a queue-legal id (non-negative integer within SEQ_PAD digits). */
function seqName(seq: number): string | null {
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
  const s = String(seq);
  return s.length <= SEQ_PAD ? s.padStart(SEQ_PAD, "0") : null;
}

/** Three-state marker probe (mirrors the inbox credential discipline): present / absent / unknown. A read fault is UNKNOWN (never
 *  folded to "absent", which would re-run a done handler, nor to "present", which would drop an unsent record). */
function markerState(p: string): "present" | "absent" | "unknown" {
  try { lstatSync(p); return "present"; } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
}
function writeDone(dir: string, stem: string): boolean {
  // ATOMIC (temp+rename) so the DONE marker is all-or-nothing — never a torn/partial file a later probe would misread. Returns
  // whether it LANDED: a failure must NOT be swallowed-then-ack'd (that drops the completion record) — the caller RELEASES instead,
  // so the completion is re-attempted (DO-P2-1c). End-to-end dedup of that re-run then rides the sink's idempotency.
  try {
    mkdirSync(doneDir(dir), { recursive: true, mode: 0o700 });
    const p = path.join(doneDir(dir), stem);
    const tmp = `${p}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, "", { mode: 0o600 });
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}
function pruneDone(dir: string): void {
  let names: string[];
  try { names = readdirSync(doneDir(dir)); } catch { return; }
  const cutoff = Date.now() - DONE_TTL_MS;
  // TGP-12: the live set is THREE-STATE. If the queue dir can't be enumerated the live set is UNKNOWN (null) ⇒ prune NOTHING this
  // pass (a readdir fault must never be read as "no live entries", which would delete completion evidence a stuck entry still needs).
  const live = livePendingStems(dir);
  if (live === null) return; // unknown ⇒ skip pruning entirely
  for (const n of names) {
    try {
      if (statSync(path.join(doneDir(dir), n)).mtimeMs >= cutoff) continue; // fresh ⇒ keep
      if (live.has(n)) continue; // DO-P2-1d: a pending/claim for this stem still exists ⇒ the DONE must outlive it
      unlinkSync(path.join(doneDir(dir), n));
      try { unlinkSync(path.join(credDir(dir), n)); } catch { /* cred pruned with its DONE (same lifetime ⇒ never cred-without-DONE) */ }
    } catch { /* raced/gone */ }
  }
}

/** Stems (pad20) that currently have a pending <stem>.json OR an in-flight <stem>.json.sending-* claim; null if the queue dir can't
 *  be enumerated (UNKNOWN — the caller must NOT treat it as "none"). */
function livePendingStems(dir: string): Set<string> | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; } // unreadable ⇒ UNKNOWN (TGP-12), never an empty "none"
  const out = new Set<string>();
  for (const n of names) { const m = /^(\d{20})\.json(?:\.sending-.*)?$/.exec(n); if (m) out.add(m[1]!); }
  return out;
}
const sourceGone = (p: string): boolean => { try { lstatSync(p); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; } };
const baseOfClaim = (claimPath: string): string => claimPath.replace(CLAIM_SUFFIX, "");

/** Enqueue a record under a monotonic numeric event id, binding the event IDENTITY to its PAYLOAD via an ATOMIC credential
 *  (TGP-10, mirrors the inbox publishOnce protocol — no check-then-act race):
 *   - DONE already present ⇒ "already" (completed; never re-queue).
 *   - try to O_EXCL-create cred/<seq> = sha256(payload). EXACTLY ONE producer wins the create; a concurrent/replay producer gets
 *     EEXIST and must COMPARE the bound hash — it can never overwrite the record or spawn a second one:
 *       • cred unreadable ⇒ "failed" (PRESERVE + retry — never overwrite an existing-but-unreadable identity);
 *       • hash DIFFERS ⇒ "conflict" (a different payload for the same id ⇒ keep the original);
 *       • hash SAME + a record (pending or in-flight claim) exists ⇒ "already" (idempotent; no second record ⇒ no double-handler);
 *       • hash SAME but the record is MISSING ⇒ a prior enqueue crashed after the cred, before the record ⇒ (re)write it ⇒ "enqueued".
 *   - winner ⇒ write <seq>.json ⇒ "enqueued".
 *  An illegal id ⇒ "failed". Never throws. */
export function enqueueQueue(dir: string, record: unknown, seq: number): EnqueueResult {
  const stem = seqName(seq);
  if (stem === null) return "failed"; // reject an illegal id rather than fold it into a colliding name
  let body: string;
  try { body = JSON.stringify(record); } catch { return "failed"; }
  const h = bodyHash(body);
  try {
    if (markerState(path.join(doneDir(dir), stem)) === "present") return "already"; // already completed ⇒ never re-queue
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(credDir(dir), { recursive: true, mode: 0o700 });
    const cred = path.join(credDir(dir), stem);
    try { writeFileSync(cred, h, { flag: "wx", mode: 0o600 }); } // O_EXCL: the atomic identity claim
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return "failed";
      let prior: string;
      try { prior = readFileSync(cred, "utf8").trim(); } catch { return "failed"; } // unreadable identity ⇒ preserve + retry, never overwrite
      if (prior !== h) return "conflict";          // different payload for the same id ⇒ keep the original
      if (recordPresent(dir, stem)) return "already"; // same id+payload, record live ⇒ idempotent (no second record)
      // same id+payload but the record is gone (a crash after cred, before the record) ⇒ fall through and (re)write it.
    }
    const file = path.join(dir, `${stem}.json`);
    const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, file); // the cred has already serialized identity, so this name never races a different-payload writer
    return "enqueued";
  } catch { return "failed"; }
}

/** Does a record for `stem` exist in a non-terminal state — the pending <stem>.json (present OR unreadable) or an in-flight claim?
 *  An unreadable/unenumerable state counts as PRESENT (conservative: never risk a duplicate write on an uncertain read). */
function recordPresent(dir: string, stem: string): boolean {
  if (markerState(path.join(dir, `${stem}.json`)) !== "absent") return true; // present or unknown ⇒ exists
  let names: string[];
  try { names = readdirSync(dir); } catch { return true; } // can't enumerate ⇒ assume present (don't risk a double-write)
  return names.some((n) => n.startsWith(`${stem}.json.sending-`));
}

/** Reclaim claims whose holder is gone (dead pid) OR that are older than STALE_CLAIM_MS (a drain that broke out mid-flight on a LIVE
 *  pid): rename the claim back to its <seq>.json so a later drain re-handles it. Best-effort; never throws. */
export function recoverStaleQueueClaims(dir: string, isAlive: (pid: number) => boolean = pidAlive): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    const m = CLAIM_RE.exec(n);
    if (!m) continue;
    // TGP-8: the claim AGE is the CLAIM TIME encoded in the name (m[3], set atomically at claim), NOT the file mtime (which is the
    // ENQUEUE time — a long-queued item freshly claimed would otherwise look instantly stale). Reclaim iff owner dead OR held too long.
    const stale = !isAlive(Number(m[2])) || (now - Number(m[3]) > STALE_CLAIM_MS);
    if (!stale) continue;
    try { renameSync(path.join(dir, n), path.join(dir, m[1]!)); } catch { /* raced / gone ⇒ skip */ }
  }
}

/** Re-attempt a release for claims a prior drain could not rename back (a transient FS fault). Mirrors inbox.retryStuckPoison: once
 *  the fault clears the claim leaves the set; a vanished claim is also cleared. Pure damage-control; never throws. */
export function retryStuckQueue(dir: string, stuck: Set<string>): void {
  for (const c of stuck) {
    if (sourceGone(c)) { stuck.delete(c); continue; }
    try { renameSync(c, baseOfClaim(c)); stuck.delete(c); } catch { /* still faulting ⇒ keep for the next tick */ }
  }
}

function quarantineClaim(dir: string, claimPath: string, raw: string): "quarantined" | "failed" | "vanished" {
  const qdir = quarantineDir(dir);
  const base = path.basename(baseOfClaim(claimPath));
  try {
    mkdirSync(qdir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      const target = path.join(qdir, `${base}.${Date.now()}.${randomBytes(8).toString("hex")}`);
      try { linkSync(claimPath, target); break; } // atomic NO-OVERWRITE: EEXIST ⇒ retry a fresh name (never clobber evidence)
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt < 8) continue; throw e; }
    }
    try { unlinkSync(claimPath); } catch { /* bytes already preserved via the link */ }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && sourceGone(claimPath)) return "vanished"; // source truly gone
    return "failed"; // FS fault, or an ENOENT whose source is present/unconfirmable ⇒ caller releases to retry
  }
  try { appendFileSync(path.join(qdir, "dead-letter.log"), JSON.stringify({ ts: Date.now(), error: "corrupt-json", preview: raw.slice(0, 120) }) + "\n"); } catch { /* bytes already safe; a lost audit line never re-delivers */ }
  return "quarantined";
}

/**
 * Drain the queue: recover stale claims + retry stuck releases, then for each unclaimed <seq>.json (FIFO by seq, bounded by `cap`):
 * atomically CLAIM it (unique per-drain name), discharge immediately if already DONE, else READ (transient error ⇒ release+retry,
 * never delete), PARSE (corrupt ⇒ observable quarantine), run `handle`; "sent" ⇒ write the DONE marker then delete the claim;
 * "retry"/throw ⇒ release. A release/ack that faults is recorded in `opts.stuck` for a later retry. Returns counts. Never throws.
 */
export async function drainQueue(
  dir: string,
  handle: (record: unknown) => DrainResult | Promise<DrainResult>,
  opts: { cap?: number; isAlive?: (pid: number) => boolean; stuck?: Set<string> } = {},
): Promise<{ claimed: number; sent: number; retried: number; skipped: number }> {
  const cap = opts.cap ?? 32;
  const stuck = opts.stuck;
  const isAlive = opts.isAlive ?? pidAlive;
  const zero = { claimed: 0, sent: 0, retried: 0, skipped: 0 };
  // TGP-11: ONE drainer at a time (an exclusive, stale-recoverable drain lock) ⇒ FIFO is preserved ACROSS drainers/instances, not
  // just within a single pass. A second drainer finds the lock held by a live, fresh owner and SKIPS — it can never process a later
  // item while another drainer's head item is mid-flight. Exactly-once is unaffected (DONE+cred); this only serializes order.
  const lockTok = acquireDrainLock(dir, isAlive);
  if (lockTok === null) return zero; // another drainer holds the queue ⇒ skip (no concurrent reorder)
  try {
  recoverStaleQueueClaims(dir, isAlive);
  if (stuck) retryStuckQueue(dir, stuck);
  pruneDone(dir);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => PENDING_RE.test(n)).sort(); } catch { return zero; }
  let claimed = 0, sent = 0, retried = 0, skipped = 0;
  const release = (c: string): void => { try { renameSync(c, baseOfClaim(c)); } catch { stuck?.add(c); } }; // DO-P2-2: keep the obligation
  const ack = (c: string): void => { try { unlinkSync(c); } catch { stuck?.add(c); } };
  for (const n of names) {
    if (claimed >= cap) break;
    const jsonPath = path.join(dir, n);
    const claimPath = `${jsonPath}.sending-${process.pid}-${Date.now()}.${randomBytes(6).toString("hex")}`; // pid + claim-time + nonce (DO-P2-1b unique; TGP-8 age=claim-time)
    try { renameSync(jsonPath, claimPath); } catch { continue; } // ENOENT ⇒ another drainer took it ⇒ skip
    claimed += 1;
    const stem = n.slice(0, SEQ_PAD);
    const done = markerState(path.join(doneDir(dir), stem));
    if (done === "present") { ack(claimPath); skipped += 1; continue; }       // DO-P2-1a/c: completed ⇒ discharge, never re-run
    if (done === "unknown") { release(claimPath); retried += 1; break; }       // can't tell ⇒ keep + re-check; DO-P2-3: stop to hold FIFO
    let raw: string;
    try { raw = readFileSync(claimPath, "utf8"); }
    catch { release(claimPath); retried += 1; break; }                         // DO-P1-1: a READ error KEEPS the record; DO-P2-3: stop to hold FIFO
    let record: unknown;
    try { record = JSON.parse(raw); }
    catch { if (quarantineClaim(dir, claimPath, raw) === "failed") { release(claimPath); break; } skipped += 1; continue; } // corrupt ⇒ isolate (a quarantined item leaves the queue ⇒ continue; a failed isolate holds FIFO)
    let r: DrainResult;
    try { r = await handle(record); } catch { r = "retry"; }
    if (r === "sent") {
      // DO-P2-1c: the DONE marker must LAND before the claim is deleted. If it does not, RELEASE (retry) — never ack without the
      // completion record. The re-run's end-to-end dedup rides the sink's idempotency (writeInbox publishOnce). DO-P2-3: a release
      // stops the drain to keep FIFO.
      if (writeDone(dir, stem)) { ack(claimPath); sent += 1; }
      else { release(claimPath); retried += 1; break; }
    } else { release(claimPath); retried += 1; break; } // DO-P2-3: a handler "retry" holds the head of the queue (conversation order preserved)
  }
  return { claimed, sent, retried, skipped };
  } finally { releaseDrainLock(dir, lockTok); }
}

/** Acquire the exclusive per-queue drain lock (TGP-11). Returns a token on success, or null if a LIVE, FRESH drainer holds it. A lock
 *  held by a dead pid OR older than STALE_DRAINLOCK_MS is stolen (O_EXCL re-create; a lost steal race ⇒ null ⇒ skip). Never throws. */
function acquireDrainLock(dir: string, isAlive: (pid: number) => boolean): string | null {
  const lock = drainLockPath(dir);
  const tok = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(lock, tok, { flag: "wx", mode: 0o600 }); return tok; } // O_EXCL
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    let cur: string;
    try { cur = readFileSync(lock, "utf8"); } catch { return null; } // unreadable holder ⇒ don't steal (conservative)
    const m = /^(\d+)-(\d+)-/.exec(cur);
    const stealable = !m || !isAlive(Number(m[1])) || Date.now() - Number(m[2]) > STALE_DRAINLOCK_MS;
    if (!stealable) return null; // a live, fresh drainer owns it ⇒ skip this drain
    try { if (readFileSync(lock, "utf8") === cur) unlinkSync(lock); } catch { /* raced */ } // remove only the stale holder we saw
    try { writeFileSync(lock, tok, { flag: "wx", mode: 0o600 }); return tok; } catch { return null; } // lost the steal race ⇒ skip
  }
}
/** Release the drain lock iff we still own it (never unlink a lock a stealer re-took). Never throws. */
function releaseDrainLock(dir: string, tok: string): void {
  const lock = drainLockPath(dir);
  try { if (readFileSync(lock, "utf8") === tok) unlinkSync(lock); } catch { /* not ours / gone */ }
}
