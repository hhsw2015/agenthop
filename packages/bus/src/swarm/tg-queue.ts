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
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, lstatSync, statSync, appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { acquireHolderLock, releaseHolderLock, type LockSite } from "./holder-lock.js";

export type DrainResult = "sent" | "retry";
export type EnqueueResult = "enqueued" | "already" | "conflict" | "failed";
const SEQ_PAD = 20;                        // zero-pad width: a lexical sort of <pad>.json is numeric (arrival) order
const STALE_CLAIM_MS = 5 * 60_000;         // a claim older than this is reclaimed even if its pid looks alive (a drain that broke out)
const DONE_TTL_MS = 24 * 60 * 60_000;      // DONE/cred older than this are pruned (bounded disk) — well past any live retry window
const CLAIM_SUFFIX = /\.sending-\d+-\d+\.[0-9a-f]+$/; // <pad>.json.sending-<pid>-<claimMs>.<nonce>
const CLAIM_RE = /^(.*\.json)\.sending-(\d+)-(\d+)\.[0-9a-f]+$/; // 1=base .json, 2=pid, 3=claimMs
const PENDING_RE = new RegExp(`^\\d{${SEQ_PAD}}\\.json$`);

const doneDir = (dir: string): string => path.join(dir, "done");
const credDir = (dir: string): string => path.join(dir, "cred");       // TGP-10: per-seq atomic identity credential
const quarantineDir = (dir: string): string => path.join(dir, "quarantine");
// TGP-11: the drain lock is the PROVEN holder-lock primitive (atomic mkdir dir + identity-in-filename, race-free reclaim; it never
// steals a LIVE foreign holder, so a slow-but-alive drainer is contended — not stolen+reordered — and the create/steal/release
// TOCTOU windows of a hand-rolled lock don't exist). One drainer at a time ⇒ FIFO across drainers/instances.
const drainLockSite = (dir: string): LockSite => ({ lockDir: path.join(dir, "drain.lockd"), intentDir: dir, intentPrefix: "drain.lock.hold." });
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

/** Reclaim an ORPHAN incomplete credential — a partial/corrupt (length ≠ 64) cred with NO live pending/claim/DONE for its stem.
 *  r10's linkSync never publishes a partial cred, so this only clears a LEGACY (pre-r10) or planted artifact; run under the drain
 *  lock (the sole exclusive context) so it can never race a live producer. A cred whose stem still has an entry is left alone.
 *  Best-effort; never throws. */
function pruneBadCreds(dir: string): void {
  let names: string[];
  try { names = readdirSync(credDir(dir)); } catch { return; }
  const live = livePendingStems(dir);
  if (live === null) return; // can't confirm liveness ⇒ touch nothing
  for (const n of names) {
    if (!/^\d{20}$/.test(n)) continue;
    if (live.has(n)) continue;                                   // a pending/claim exists for this stem ⇒ leave the cred
    if (markerState(path.join(doneDir(dir), n)) !== "absent") continue; // a DONE (or unknown) exists ⇒ leave it
    let content: string;
    try { content = readFileSync(path.join(credDir(dir), n), "utf8"); } catch { continue; } // unreadable ⇒ leave (never force)
    if (content.length === 64) continue;                         // a COMPLETE orphan cred is not ours to judge here ⇒ leave
    try { unlinkSync(path.join(credDir(dir), n)); } catch { /* raced/gone */ } // an orphan PARTIAL cred ⇒ reclaim so its seq can enqueue again
  }
}
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
export function enqueueQueue(dir: string, record: unknown, seq: number, recordTempSuffix: () => string = () => randomBytes(8).toString("hex")): EnqueueResult {
  const stem = seqName(seq);
  if (stem === null) return "failed"; // reject an illegal id rather than fold it into a colliding name
  let body: string;
  try { body = JSON.stringify(record); } catch { return "failed"; }
  const h = bodyHash(body);
  try {
    if (markerState(path.join(doneDir(dir), stem)) === "present") return "already"; // already completed ⇒ never re-queue
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(credDir(dir), { recursive: true, mode: 0o700 });
    // FC-7 (DO-P1-2): a PRE-EXISTING record binds its payload — INCLUDING a legacy entry written before credentials existed (no cred).
    // Never overwrite it: identical body ⇒ "already", different ⇒ "conflict" (keep the original), unreadable ⇒ "failed" (retry).
    const ex = readRecordBody(dir, stem);
    if (ex.found === "unknown") return "failed";
    if (ex.found) return ex.body === body ? "already" : "conflict";
    const cred = path.join(credDir(dir), stem);
    // TGP-14: the credential must be ATOMIC AND COMPLETE. An O_EXCL `wx` create guarantees a unique NAME but NOT a complete body (a
    // crash/EIO between create and the hash write leaves a 0/partial cred a later replay would misread as a different-payload
    // conflict). So publish the FULL hash to a temp, then linkSync it into place — the cred appears only as a hard link to a
    // fully-written inode (atomic + no-overwrite: EEXIST if already claimed). On EEXIST, COMPARE the (complete) prior hash.
    // The temp is O_EXCL (`wx`, unique random name) so it is EXCLUSIVELY ours — a leftover temp (a prior unlink that faulted) is
    // never silently truncated/reused (TGP-10), and we only ever clean OUR OWN temp. The FULL hash lands in the temp BEFORE the
    // atomic linkSync into `cred`, so `cred` only ever appears as a link to a complete inode (never partial).
    const credTmp = `${cred}.tmp-${randomBytes(8).toString("hex")}`;
    try { writeFileSync(credTmp, h, { flag: "wx", mode: 0o600 }); } catch { return "failed"; } // name collision (astronomically rare) ⇒ retry fresh
    try {
      try { linkSync(credTmp, cred); } // ATOMIC exclusive publish of a COMPLETE credential (EEXIST ⇒ already claimed)
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return "failed";
        const prior = readFileSync(cred, "utf8"); // EACCES/… ⇒ throw ⇒ caught by the outer try ⇒ "failed" (preserve, never overwrite)
        if (prior !== h) {
          // A COMPLETE different hash ⇒ a genuine different-payload conflict (keep the original). A length mismatch ⇒ an INCOMPLETE /
          // corrupt prior cred (legacy only — r10's linkSync never publishes a partial): retry WITHOUT touching it, so a concurrent
          // writer that just completed the same id is never clobbered (TGP-10). A true orphan partial is reclaimed under the drain lock.
          return prior.length === h.length ? "conflict" : "failed";
        }
        const rs = recordState(dir, stem); // same id+payload: idempotent IF a record exists; MISSING ⇒ (re)write; UNKNOWN ⇒ retry
        if (rs === "present") return "already";
        if (rs === "unknown") return "failed"; // TGP-15: can't prove the record exists ⇒ retry, NEVER advance on a guess
        // rs === "absent" ⇒ fall through and (re)write the record.
      }
    } finally { try { unlinkSync(credTmp); } catch { /* always clean OUR temp; if we linked, `cred` keeps the inode */ } }
    // Write the record. TGP-10 ("cred ⟹ record" by RETRY, never by ROLLBACK): on a write fault return "failed" but NEVER unlink the
    // cred. The cred is the AUTHORITATIVE, SHARED seq→payload binding — a CONCURRENT producer with the SAME payload may ALREADY have
    // published the record against THIS very cred and returned "enqueued"; unlinking it would let a DIFFERENT-payload producer re-create
    // the cred and OVERWRITE that accepted record (the TGP-10 interleaving: A creates cred → B publishes the record on it → A's record
    // write faults → A's old rollback deleted the cred → C re-creates it with a new payload and clobbers B). cred⟹record is instead
    // restored by RETRY: the driver HOLDS its offset on "failed", and a same-payload retry finds cred==h + record-absent and (re)writes
    // it. A different-payload producer always hits EEXIST+hash-mismatch ⇒ "conflict" ⇒ never overwrites. A crash that strands a COMPLETE
    // cred with no record is a narrow, self-healing orphan (the same-payload retry rebuilds the record; for seq=update_id the payload is
    // invariant) — not a lost delivery.
    // TGP-10 (record temp OWNERSHIP, layer 2): the record temp must be EXCLUSIVELY ours (O_EXCL via "wx"), not a plain "w" (O_TRUNC).
    // A plain-"w" temp lets a SECOND same-payload recovery producer that generates a colliding temp name TRUNCATE our in-progress temp,
    // so our rename then publishes HIS (possibly half-written / killed) bytes — a torn record. "wx" gives each writer its OWN inode; on
    // a name collision (EEXIST) retry a FRESH name — NEVER truncate or unlink the colliding temp (it is another writer's, and random
    // digits are not ownership). We clean ONLY the temp we created. (Mirrors 件② r5 @81f8894 / DOS-CORE-P1-1.)
    const file = path.join(dir, `${stem}.json`);
    let tmp = "";
    let fd: number | undefined;
    for (let attempt = 0; ; attempt++) {
      tmp = `${file}.tmp-${process.pid}-${recordTempSuffix()}`;
      try { fd = openSync(tmp, "wx", 0o600); break; }                                  // own the inode, or EEXIST ⇒ a colliding name
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt < 8) continue; return "failed"; } // never clobber a foreign temp ⇒ retry fresh; exhausted/other ⇒ retry later
    }
    try {
      // DO-R8-P1-1: writeSync may SHORT-write (store FEWER bytes than requested — a legal syscall outcome); a single call can publish a
      // TRUNCATED record. Loop until every byte lands. Zero progress ⇒ fail (never spin a stuck fd). A mid-write throw propagates to the
      // outer catch, which cleans OUR temp. (writeFileSync loops internally; the raw fd write we chose for O_EXCL must loop explicitly.)
      const buf = Buffer.from(body, "utf8");
      for (let off = 0; off < buf.length; ) {
        const n = writeSync(fd, buf, off, buf.length - off);
        if (n <= 0) throw new Error("zero-progress write"); // never advance on a 0-byte write
        off += n;
      }
      closeSync(fd); fd = undefined; renameSync(tmp, file); // atomic publish of OUR complete inode (same-payload last-writer-wins is byte-identical; never torn)
    }
    catch { if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } } try { unlinkSync(tmp); } catch { /* */ } return "failed"; } // clean ONLY our own temp; cred stays ⇒ retry obligation preserved
    return "enqueued";
  } catch { return "failed"; }
}

/** The body of a PRE-EXISTING record for `stem` (FC-7 / DO-P1-2): the pending <stem>.json, else an in-flight claim — INCLUDING a
 *  legacy entry written before credentials existed. { found:true, body } when readable; { found:false } when definitively none;
 *  { found:"unknown" } on a read/enumerate fault (the caller must retry, never overwrite). */
function readRecordBody(dir: string, stem: string): { found: true; body: string } | { found: false } | { found: "unknown" } {
  try { return { found: true, body: readFileSync(path.join(dir, `${stem}.json`), "utf8") }; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { found: "unknown" }; }
  let names: string[];
  try { names = readdirSync(dir); } catch { return { found: "unknown" }; }
  const claim = names.find((n) => n.startsWith(`${stem}.json.sending-`));
  if (!claim) return { found: false };
  try { return { found: true, body: readFileSync(path.join(dir, claim), "utf8") }; } catch { return { found: "unknown" }; }
}

/** The existence state of a record for `stem` — THREE-state (TGP-15): "present" (pending <stem>.json or an in-flight claim),
 *  "absent" (neither), or "unknown" (a read/enumerate fault — the caller must RETRY, never treat as present or absent). */
function recordState(dir: string, stem: string): "present" | "absent" | "unknown" {
  const m = markerState(path.join(dir, `${stem}.json`));
  if (m === "present") return "present";
  if (m === "unknown") return "unknown"; // pending lstat fault ⇒ unknown (TGP-15)
  let names: string[];
  try { names = readdirSync(dir); } catch { return "unknown"; } // enumerate fault ⇒ unknown, NOT "already"
  return names.some((n) => n.startsWith(`${stem}.json.sending-`)) ? "present" : "absent";
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
  // TGP-11 exclusion is TWO layers: (1) an IN-PROCESS guard — the drain is async, and holder-lock treats a same-pid holder as
  // reclaimable own-residue, so it CANNOT exclude a second in-process call while the first's handler is still awaiting; a concurrent
  // drain of THIS dir in THIS process therefore skips here. (2) the cross-process holder-lock below. Together: one drainer at a time ⇒
  // FIFO across drainers/instances; exactly-once is unaffected (DONE+cred).
  if (drainingDirs.has(dir)) return zero; // (1) in-process: another live drain of this dir is mid-flight ⇒ skip
  drainingDirs.add(dir);
  try {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return zero; } // the lock's intentDir must exist; no dir ⇒ nothing to drain
  const lockTok = acquireHolderLock(drainLockSite(dir)); // empty-lockdir crash recovery (a drainer SIGKILLed between mkdir and identity-publish) is now IN the shared primitive (rmdir-if-empty + ② sole-verify); no caller-side reaper
  if (lockTok === null) return zero; // another LIVE drainer holds the queue ⇒ skip (holder-lock never steals a live holder ⇒ no reorder)
  try {
  recoverStaleQueueClaims(dir, isAlive);
  if (stuck) retryStuckQueue(dir, stuck);
  pruneDone(dir);
  pruneBadCreds(dir); // TGP-10: reclaim any orphan partial/legacy credential (safe: under the drain lock)
  // DO-P2-3 / TGP-11 HEAD OWNERSHIP across ALL states, from a SINGLE directory snapshot (so there is no "pending read ok, claim read
  // fails" window where an unknown slips through): one readdir yields BOTH the pending list AND the claim set. A read fault ⇒ return
  // zero (process NOTHING — an un-enumerable queue can't prove no earlier head is stuck; unknown NEVER authorizes jumping the head).
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return zero; }
  const names = entries.filter((n) => PENDING_RE.test(n)).sort();
  // blockSeq = the lowest seq of an UNRESOLVED claim. A claim whose stem has a CONFIRMED DONE is TERMINAL (business complete, only its
  // cleanup is pending) ⇒ NOT a blocker. A claim whose DONE state is absent OR UNKNOWN ⇒ treated as unresolved ⇒ blocks (TGP-11:
  // confirmed-unresolved and unknown both hold the head; only a confirmed-terminal claim is let past).
  let blockSeq = Number.POSITIVE_INFINITY;
  for (const nm of entries) {
    const m = CLAIM_RE.exec(nm);
    if (!m) continue;
    const s = Number(m[1]!.slice(0, SEQ_PAD));
    if (s >= blockSeq) continue;
    if (markerState(path.join(doneDir(dir), m[1]!.slice(0, SEQ_PAD))) === "present") continue; // DONE ⇒ terminal ⇒ not a blocker
    blockSeq = s;
  }
  let claimed = 0, sent = 0, retried = 0, skipped = 0;
  const release = (c: string): void => { try { renameSync(c, baseOfClaim(c)); } catch { stuck?.add(c); } }; // DO-P2-2: keep the obligation
  const ack = (c: string): void => { try { unlinkSync(c); } catch { stuck?.add(c); } };
  for (const n of names) {
    if (claimed >= cap) break;
    if (Number(n.slice(0, SEQ_PAD)) > blockSeq) break; // DO-P2-3: an earlier-seq item is stuck in a claim ⇒ never deliver past it
    const jsonPath = path.join(dir, n);
    const claimPath = `${jsonPath}.sending-${process.pid}-${Date.now()}.${randomBytes(6).toString("hex")}`; // pid + claim-time + nonce (DO-P2-1b unique; TGP-8 age=claim-time)
    try { renameSync(jsonPath, claimPath); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; break; } // ENOENT ⇒ gone ⇒ skip; a real IO error on the head ⇒ STOP (DO-P2-3 hold FIFO, never jump it)
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
  } finally { releaseHolderLock(drainLockSite(dir), lockTok); }
  } finally { drainingDirs.delete(dir); }
}

/** In-process set of queue dirs currently being drained (TGP-11 layer 1: same-process async reentrancy guard). */
const drainingDirs = new Set<string>();
