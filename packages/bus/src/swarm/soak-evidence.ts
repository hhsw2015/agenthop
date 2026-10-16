/**
 * Soak evidence surfaces (liveness-tier §3; swarm-soak r2 needs a TIMED positive record over the whole window, or a row stays UNKNOWN).
 * Append-only JSON lines under ~/.agenthop/swarm/soak/, one record per sweep round, ISO time first:
 *   inbox-oldest.jsonl  {ts, box, oldest_age_s, live_owner, reason?}   — the inbox sentinel's view of the coordinator role box
 *   bridge-tick.jsonl   {ts, tick, moved, outcome}                     — the bridge sweep's mirror tick each round
 * A record that could not be measured says so (oldest_age_s: null + reason; tick: null) — never a made-up value.
 * Writing is best-effort for the SWEEP (it never throws into the caller) but a failure is REPORTED once per surface per
 * episode — committed only when that S19 was delivered (a failed report stays owed); the next successful write re-arms it.
 * Pure record builders + one tiny appender.
 */
import { closeSync, constants as fsConstants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";

export type InboxOldestRecord = { ts: string; box: string; oldest_age_s: number | null; live_owner: boolean | null; reason?: string; owner_reason?: string };
/** The role box's owner as measured in THIS round: true / false, or null + why (not measured, source unreadable, unknown). */
export type OwnerFact = { owner: boolean | null; reason?: string };
export type BridgeTickRecord = { ts: string; tick: number | null; moved: boolean | null; outcome: string };

/** The role box's oldest unclaimed mail age. `oldestMtimeSec` null = the box could not be read (reason says why); an empty box = 0. */
export function inboxOldestRecord(nowMs: number, box: string, pending: { mtimeSec: number }[] | null, owner: OwnerFact, reason?: string): InboxOldestRecord {
  const ts = new Date(nowMs).toISOString();
  const o = owner.owner === null ? { live_owner: null, owner_reason: owner.reason ?? "owner not measured this round" } : { live_owner: owner.owner };
  if (pending === null) return { ts, box, oldest_age_s: null, ...o, reason: reason ?? "box unreadable" };
  const oldest = pending.length ? Math.min(...pending.map((p) => p.mtimeSec)) : null;
  return { ts, box, oldest_age_s: oldest === null ? 0 : Math.max(0, Math.round(nowMs / 1000 - oldest)), ...o };
}

/** One sentinel round with its owner measured fresh (SE-OWNER-FRESHNESS): the owner starts every round as null ("not measured
 *  this round"); `body` may set it; the sample runs after the body however it ends (early return, throw). A previous round's
 *  owner is never carried into this round's record. Never throws from the sample; rethrows the body's error after sampling. */
export function ownerRound(body: (setOwner: (o: OwnerFact) => void) => void, sample: (o: OwnerFact) => void): void {
  let o: OwnerFact = { owner: null, reason: "owner not measured this round" };
  try { body((x) => { o = x; }); }
  finally { try { sample(o); } catch { /* the sample is best-effort; its failure is reported by its own path */ } }
}

/** One bridge round: the mirror tick read this round (null = unreadable), whether it moved since the last READ tick, and the tick's
 *  outcome word. `moved` is null when either side is unknown (no previous read, or this one failed). */
export function bridgeTickRecord(nowMs: number, tick: number | null, prevTick: number | null, outcome: string): BridgeTickRecord {
  return { ts: new Date(nowMs).toISOString(), tick, moved: tick === null || prevTick === null ? null : tick !== prevTick, outcome };
}

export const soakDir = (home: string) => path.join(home, ".agenthop", "swarm", "soak");

/** Append one JSON line, bounded (SE-APPEND-BOUND): the target must be a regular file (or absent ⇒ created); it is opened
 *  O_RDWR|O_APPEND|O_NONBLOCK|O_NOFOLLOW (read: its last byte, for the line boundary) — a FIFO / symlink / device is refused, never waited on — and the opened descriptor is
 *  fstat-checked to be the same regular file that was lstat-ed (no swap between the check and the open). Never throws; false = not
 *  written (the caller reports it). Constant work per call: one lstat, one open, one fstat, one write. */
export const APPEND_MAX_WRITES = 8;
type Writer = (fd: number, buf: Buffer, off: number, len: number) => number;
export function appendEvidence(home: string, file: "inbox-oldest.jsonl" | "bridge-tick.jsonl", rec: object,
  write: Writer = (fd, buf, off, len) => writeSync(fd, buf, off, len),
  truncate: (fd: number, size: number) => void = (fd, size) => ftruncateSync(fd, size)): boolean {
  let fd: number | null = null;
  try {
    mkdirSync(soakDir(home), { recursive: true, mode: 0o700 });
    const f = path.join(soakDir(home), file);
    let before: { ino: number; dev: number } | null = null;
    try { const st = lstatSync(f); if (!st.isFile()) return false; before = { ino: st.ino, dev: st.dev }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    fd = openSync(f, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW, 0o600);
    const st = fstatSync(fd);
    if (!st.isFile() || (before !== null && (st.ino !== before.ino || st.dev !== before.dev))) return false;
    // SE-WRITE-RESULT r9: the file's line boundary is checked on EVERY append from its last byte (no memory of earlier calls, so
    // it holds across restarts). A file that does not end in "\n" holds a half line (a short write whose cut-back failed): this call
    // writes a separating "\n" first, so the new record parses on its own, and still returns false — the failure episode (owed S19)
    // ends only on a later append that finds a clean boundary and writes a whole line.
    let dirty = false;
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      if (readSync(fd, last, 0, 1, st.size - 1) !== 1) return false;
      dirty = last[0] !== 0x0a;
    }
    const buf = Buffer.from(`${dirty ? "\n" : ""}${JSON.stringify(rec)}\n`, "utf8");
    let off = 0;
    for (let n = 0; off < buf.length && n < APPEND_MAX_WRITES; n++) {
      let w: number;
      try { w = write(fd, buf, off, buf.length - off); } catch { w = 0; }
      if (!(w > 0)) break;
      off += w;
    }
    if (off === buf.length) return !dirty;
    try { truncate(fd, st.size); } catch { /* the reader skips a line that does not parse */ }
    return false;
  } catch { return false; }
  finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

/** Failure reporting, one S19 per failure episode per surface (SE-FAILURE-COMMIT): `shouldReportEvidenceFailure` only says whether a
 *  report is OWED; `commitEvidenceReport` records that it was DELIVERED. A report that failed to deliver stays owed and is retried
 *  on the next failing round. A successful write ends the episode (nothing owed, the next failure reports again). Mutates `st`. */
export function shouldReportEvidenceFailure(st: Set<string>, file: string, ok: boolean): boolean {
  if (ok) { st.delete(file); return false; }
  return !st.has(file);
}
export function commitEvidenceReport(st: Set<string>, file: string, delivered: boolean): void {
  if (delivered) st.add(file);
}

/** One inbox-oldest sample, end to end: read the role box (bounded scan), build the record, append it. Taken every sentinel round,
 *  independent of the sentinel's alert candidates (SE-EMPTY-ROUND). `readBox` is progress-watch's bounded readBoxMails. Returns
 *  whether the line was written (the caller reports a failure). Never throws. */
export function sampleRoleBox(home: string, box: string, credited: OwnerFact, nowMs: number,
  readBox: (dir: string) => { mtimeSec: number }[] | "absent" | "unknown"): boolean {
  let mails: ReturnType<typeof readBox>;
  try { mails = readBox(path.join(home, ".agenthop", "inbox", box)); } catch { mails = "unknown"; }
  const rec = typeof mails === "string"
    ? inboxOldestRecord(nowMs, box, mails === "absent" ? [] : null, credited, mails === "absent" ? undefined : "box unreadable or larger than one scan")
    : inboxOldestRecord(nowMs, box, mails, credited);
  return appendEvidence(home, "inbox-oldest.jsonl", rec);
}
