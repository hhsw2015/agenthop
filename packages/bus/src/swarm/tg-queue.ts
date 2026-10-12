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
 *   - at-most-once in the common case, at-LEAST-once end-to-end (DO-P2-1a/c): a completed `seq` gets a durable DONE marker (written
 *     ATOMICALLY — temp+rename, never torn), checked on BOTH enqueue and claim, so a replay or a crash-after-DONE does not re-run the
 *     handler. But the DONE write is BEST-EFFORT: if it faults (disk full, EIO) the claim is still ack'd (the handler already ran —
 *     re-running is no safer), so WITHOUT a crash the same `seq`, re-enqueued, CAN re-run the handler. End-to-end exactly-once
 *     therefore relies on the SINK being idempotent (writeInbox publishOnce dedups). For a NON-idempotent sink (TG sendMessage,
 *     which has no idempotency key) this queue is at-least-once — the caller must not treat it as exactly-once.
 *   - concurrency (DO-P2-1b): the claim name carries the pid, the CLAIM TIME, and a per-drain nonce, so two concurrent drains (even
 *     in ONE process) never share a claim; the loser of the atomic rename gets ENOENT and skips. The claim time (not the file mtime,
 *     which is the ENQUEUE time) is the claim-age basis for stale recovery (TGP-8), so a long-queued-then-freshly-claimed item is
 *     never mistaken for an abandoned claim.
 *   - stuck-recovery (DO-P2-2): a release/ack that fails on a transient FS fault is recorded in the caller's `stuck` set and
 *     re-attempted each drain (retryStuckQueue), so a live-pid claim is never permanently skipped waiting for the process to exit.
 * Never throws (fail-soft): every entry point swallows IO faults into a return value or a logged no-op.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, lstatSync, statSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type DrainResult = "sent" | "retry";
export type EnqueueResult = "enqueued" | "already" | "failed";
const SEQ_PAD = 20;                        // zero-pad width: a lexical sort of <pad>.json is numeric (arrival) order
const STALE_CLAIM_MS = 5 * 60_000;         // a claim older than this is reclaimed even if its pid looks alive (a drain that broke out)
const DONE_TTL_MS = 24 * 60 * 60_000;      // DONE markers older than this are pruned (bounded disk) — well past any live retry window
const CLAIM_SUFFIX = /\.sending-\d+-\d+\.[0-9a-f]+$/; // <pad>.json.sending-<pid>-<claimMs>.<nonce>
const CLAIM_RE = /^(.*\.json)\.sending-(\d+)-(\d+)\.[0-9a-f]+$/; // 1=base .json, 2=pid, 3=claimMs
const PENDING_RE = new RegExp(`^\\d{${SEQ_PAD}}\\.json$`);

const doneDir = (dir: string): string => path.join(dir, "done");
const quarantineDir = (dir: string): string => path.join(dir, "quarantine");

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
function writeDone(dir: string, stem: string): void {
  // ATOMIC (temp+rename) so the DONE marker is all-or-nothing — never a torn/partial file a later probe would misread. Still
  // BEST-EFFORT on fault (see the module header): a missed marker only risks a re-run (dedup falls to the sink), never a loss.
  try {
    mkdirSync(doneDir(dir), { recursive: true, mode: 0o700 });
    const p = path.join(doneDir(dir), stem);
    const tmp = `${p}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, "", { mode: 0o600 });
    renameSync(tmp, p);
  } catch { /* best-effort */ }
}
function pruneDone(dir: string): void {
  let names: string[];
  try { names = readdirSync(doneDir(dir)); } catch { return; }
  const cutoff = Date.now() - DONE_TTL_MS;
  for (const n of names) { try { if (statSync(path.join(doneDir(dir), n)).mtimeMs < cutoff) unlinkSync(path.join(doneDir(dir), n)); } catch { /* raced/gone */ } }
}
const sourceGone = (p: string): boolean => { try { lstatSync(p); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; } };
const baseOfClaim = (claimPath: string): string => claimPath.replace(CLAIM_SUFFIX, "");

/** Enqueue a record under a monotonic numeric event id. A completed id (DONE present) is NOT re-queued ("already", DO-P2-1a). An
 *  illegal id ⇒ "failed" (never a char-folded/truncated name that could collide, DO-P1-2). Atomic temp+rename; the deterministic
 *  <seq>.json name makes a replay collapse to one file. Never throws. */
export function enqueueQueue(dir: string, record: unknown, seq: number): EnqueueResult {
  const stem = seqName(seq);
  if (stem === null) return "failed"; // reject an illegal id rather than fold it into a colliding name
  try {
    if (markerState(path.join(doneDir(dir), stem)) === "present") return "already"; // already completed ⇒ never re-queue
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${stem}.json`);
    const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file); // deterministic name ⇒ a re-enqueue of the same event overwrites (one file, never a pile)
    return "enqueued";
  } catch { return "failed"; }
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
  recoverStaleQueueClaims(dir, opts.isAlive ?? pidAlive);
  if (stuck) retryStuckQueue(dir, stuck);
  pruneDone(dir);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => PENDING_RE.test(n)).sort(); } catch { return { claimed: 0, sent: 0, retried: 0, skipped: 0 }; }
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
    if (done === "unknown") { release(claimPath); retried += 1; continue; }   // can't tell ⇒ keep, re-check next drain (no loss, no dup)
    let raw: string;
    try { raw = readFileSync(claimPath, "utf8"); }
    catch { release(claimPath); retried += 1; continue; }                     // DO-P1-1: a READ error KEEPS the record (never delete)
    let record: unknown;
    try { record = JSON.parse(raw); }
    catch { if (quarantineClaim(dir, claimPath, raw) === "failed") release(claimPath); skipped += 1; continue; } // DO-P1-1: corrupt ⇒ observable isolation
    let r: DrainResult;
    try { r = await handle(record); } catch { r = "retry"; }
    if (r === "sent") { writeDone(dir, stem); ack(claimPath); sent += 1; }     // DO-P2-1c: DONE before delete ⇒ a crash-after-delete never re-sends
    else { release(claimPath); retried += 1; }
  }
  return { claimed, sent, retried, skipped };
}
