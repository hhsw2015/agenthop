/**
 * egress-ledger IO seam (brief §④). Persists the hash chain as ONE FILE PER ENTRY (`<seq>.json`, atomic tmp+rename). Everything
 * here is fail-OPEN: a recording fault NEVER blocks or throws into the caller's send — it returns null/false and emits a visible
 * GAP line (brief §5). The pure chain math + verify live in egress-ledger.ts.
 *
 * EL-1 (codex:Work): the next seq is taken from the MAX FILENAME seq (never from a filtered survivor count), so a transiently
 *   unreadable interior file can never make an append reuse/overwrite an existing entry; and if the authoritative tail
 *   (max-seq file) is unreadable/corrupt, the record is REFUSED (we never rewrite history). readEgressRaw SURFACES an unreadable
 *   entry (throws) rather than folding to a shorter clean "OK".
 * EL-3: the whole append (incl. lock acquire) is wrapped so a fault returns null, never throws into egress; every entry read is
 *   lstat-gated to a regular file (a planted FIFO can never block readFileSync); a failed record emits a stderr GAP line.
 * EL-4: the append lock is the single-flight FILE lock (acquireSingleFlight), which reclaims a DEAD holder and has NO
 *   mkdir->publish empty window — so a crash while recording cannot permanently disable the ledger (unlike the pre-reclaim
 *   holder-lock dir default).
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, lstatSync, rmSync, openSync, fstatSync, readSync, closeSync, constants as FS } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { acquireSingleFlight } from "./single-flight.js";
import { chainEntry, parseEgressEntry, validHost, type EgressBody, type EgressEntry, type ByteMagnitude, type EgressOutcome } from "./egress-ledger.js";

/** The ledger dir. Default `<home>/.agenthop/swarm/egress/`; `AGENTHOP_EGRESS_DIR` overrides (tests). */
export function egressDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTHOP_EGRESS_DIR ?? path.join(home, ".agenthop", "swarm", "egress");
}

/** PROJ-1/2 lesson: refuse to write if the egress dir (or its `swarm` parent) is a SYMLINK — a planted link would redirect our
 *  writes outside the 0o700 boundary. lstat does not follow; a missing dir is fine (we create it). */
function boundaryOk(dir: string): boolean {
  for (const d of [dir, path.dirname(dir)]) {
    try { if (lstatSync(d).isSymbolicLink()) return false; } catch { /* ENOENT (not yet created) is fine */ }
  }
  return true;
}

const seqRe = /^(\d+)\.json$/;
function entryFile(dir: string, seq: number): string { return path.join(dir, `${String(seq).padStart(12, "0")}.json`); }
function gap(why: string): void { try { process.stderr.write(`egress: record failed (${why}) - call proceeded, ledger has a gap\n`); } catch { /* best-effort */ } }

/** Seq numbers present as `<seq>.json`, sorted ascending. Throws on a readdir fault (an unreadable dir is UNKNOWN, never folded
 *  to empty — EL-1). An absent dir ⇒ []. */
function listSeqs(dir: string): number[] {
  let names: string[];
  try { names = readdirSync(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  return names.map((n) => seqRe.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((a, b) => a - b);
}

/** FIFO-SAFE read of a regular file's full contents (EL-3, entry path). A plain `readFileSync` on a FIFO BLOCKS until a writer
 *  appears, and a prior `lstat` gate has a TOCTOU window (the path can be swapped to a FIFO between the lstat and the read). This
 *  opens O_RDONLY|O_NONBLOCK|O_NOFOLLOW (a FIFO opens immediately, a symlink ⇒ ELOOP), fstats the SAME fd to confirm a regular
 *  file (closing the lstat->read TOCTOU), then reads the whole file sized from that fstat (an entry is not a fixed-size pid
 *  record). ENOENT propagates (a gap); a non-regular/symlink/would-block path throws and NEVER blocks the caller. */
export function readRegularFileFifoSafe(fp: string, onAfterStat?: () => void): string {
  const fd = openSync(fp, FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOFOLLOW); // ENOENT (gap) / ELOOP (symlink) / EACCES propagate with .code
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(`${fp} is not a regular file`), { code: "ENOTREG" }); // FIFO/dir/socket ⇒ reject, no blocking read
    if (onAfterStat) onAfterStat(); // TEST SEAM (EL-3-GATE): fire a path swap AFTER the fd+fstat phase ⇒ prove the read is immune to
    //                                 a lstat->read TOCTOU (we read from the fd, not the path). Production never passes it (no-op).
    const buf = Buffer.allocUnsafe(Number(st.size));
    let off = 0;
    while (off < st.size) { const r = readSync(fd, buf, off, Number(st.size) - off, null); if (r === 0) break; off += r; } // entries are rename-atomic ⇒ size is stable
    return buf.toString("utf8", 0, off);
  } finally { closeSync(fd); }
}

/** Read one `<seq>.json` as raw JSON. THROWS on an unreadable/non-regular file (EL-1/EL-3: unknown, never silently dropped; a
 *  planted FIFO/dir/symlink is rejected via the FIFO-safe fd read BEFORE any blocking read — no lstat->read TOCTOU). Returns null
 *  for a readable-but-corrupt (bad JSON) file so the verifier flags that position. */
function readRawAt(dir: string, seq: number): unknown {
  const text = readRegularFileFifoSafe(entryFile(dir, seq)); // throws ENOENT (gap) / ENOTREG (non-regular) / EACCES (unreadable) ⇒ propagates (unknown)
  try { return JSON.parse(text); } catch { return null; } // corrupt JSON ⇒ null ⇒ verify flags this position
}

/** Raw entries in seq order, for the VERIFIER. Throws on readdir OR a per-entry unreadable/non-regular file (EL-1: an unreadable
 *  ledger is UNKNOWN — the CLI must report it, never a shorter clean "OK"). A corrupt entry is included as null (verify flags it). */
export function readEgressRaw(dir: string): unknown[] {
  return listSeqs(dir).map((seq) => readRawAt(dir, seq));
}

/** The VALID entries, for display/list (corrupt/dropped entries are skipped — list is not the integrity authority, verify is).
 *  Still propagates an unreadable fault (never a false-complete list). */
export function readEgressLedger(dir: string): EgressEntry[] {
  return readEgressRaw(dir).map((r) => parseEgressEntry(r)).filter((e): e is EgressEntry => e !== null);
}

/**
 * Append one body under the single-flight append lock. Fail-OPEN + never-throws: ANY fault ⇒ a stderr GAP line + null. EL-1: the
 * next seq is MAX FILENAME seq + 1 (never a survivor count), and if the authoritative tail (max-seq file) is unreadable/corrupt
 * or its internal seq disagrees with its filename, the record is REFUSED (history is never rewritten).
 */
function appendBody(dir: string, body: EgressBody): EgressEntry | null {
  try {
    if (!boundaryOk(dir)) { gap("symlinked ledger dir"); return null; }
    mkdirSync(dir, { recursive: true });
    const lockFile = path.join(dir, ".append.lock");
    let release: (() => void) | null = null;
    for (let i = 0; i < 50 && release === null; i += 1) release = acquireSingleFlight(lockFile); // dead-holder-reclaiming file lock (EL-4)
    if (release === null) { gap("could not acquire append lock"); return null; }
    try {
      const seqs = listSeqs(dir).filter((s) => entryFile(dir, s) !== lockFile); // .append.lock is not a <seq>.json, but be explicit
      let tail: EgressEntry | null = null;
      if (seqs.length > 0) {
        const maxSeq = seqs[seqs.length - 1]!;
        const t = parseEgressEntry(readRawAt(dir, maxSeq)); // throws if the tail is unreadable/non-regular ⇒ refuse below
        if (t === null || t.seq !== maxSeq) { gap(`authoritative tail (seq ${maxSeq}) unreadable/corrupt`); return null; } // never rewrite history (EL-1)
        tail = t;
      }
      const entry = chainEntry(tail, body); // seq = tail.seq+1 = maxSeq+1 ⇒ a brand-new filename, never an overwrite
      const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
      writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
      try { renameSync(tmp, entryFile(dir, entry.seq)); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* best-effort */ } throw e; }
      return entry;
    } finally { release(); }
  } catch (e) { gap(e instanceof Error ? e.message : String(e)); return null; } // fail-open: NEVER throw into the egress path (EL-3)
}

/** Record an egress INTENT (before/around the call). Returns the eventId (to pair the later result), or null on a recording fault
 *  (fail-open — the caller's send is NOT blocked). EL-2: the dest-host is validated at WRITE with the SAME rule as the parser; an
 *  invalid value fails the record (no raw value echoed into the diagnostic). */
export function recordEgressIntent(dir: string, e: { destHost: string; callFace: string; initiatorSid: string }, nowSec: number): string | null {
  if (!validHost(e.destHost)) { gap("destHost is not a bare host"); return null; } // EL-2: enforce the narrow contract at write; do NOT echo the raw value
  if (typeof e.callFace !== "string" || e.callFace === "" || typeof e.initiatorSid !== "string" || e.initiatorSid === "") { gap("empty callFace/initiatorSid"); return null; }
  const eventId = `eg_${randomBytes(8).toString("hex")}`;
  const entry = appendBody(dir, { kind: "intent", eventId, tsSec: nowSec, destHost: e.destHost, callFace: e.callFace, initiatorSid: e.initiatorSid });
  return entry === null ? null : eventId;
}

/** Record an egress RESULT (after the call), pairing the intent's eventId. Returns false on a recording fault (fail-open). */
export function recordEgressResult(dir: string, e: { eventId: string; byteMagnitude: ByteMagnitude; outcome: EgressOutcome }, nowSec: number): boolean {
  return appendBody(dir, { kind: "result", eventId: e.eventId, tsSec: nowSec, byteMagnitude: e.byteMagnitude, outcome: e.outcome }) !== null;
}
