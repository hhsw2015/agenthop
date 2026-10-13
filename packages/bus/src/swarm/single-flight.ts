/**
 * Single-flight file lock (team-collab §0b R2, Codex review P2-1/R2). The dispatcher is "single-active" by design, but a
 * second process (or a --sweep-once overlapping a live loop) ran concurrent sweeps that double-delivered + overwrote
 * same-seq batches. This makes the single-writer precondition a MECHANISM.
 *
 * The naive "create empty, write pid, check pid, unlink-if-dead" had three races the review pinned (each closed here):
 *   #1 stale-reclaim race : two racers both see a dead holder and both reclaim ⇒ two owners. rename alone is NOT enough —
 *      it moves whatever the path points to NOW, which may be a lock another racer already REFRESHED between our read and
 *      our rename. FIX: rename-aside then VERIFY the moved content is byte-identical to the holder we judged; if it changed
 *      (a live lock slipped in), restore it + retry; only the exact stale lock we judged is removed. (A rare 3-way restore
 *      race remains — a full fix needs an OS flock/lease, not in the Node stdlib; this closes the 2-racer reflex.)
 *   #2 empty-file window  : A's O_EXCL create made an EMPTY file before writing its pid; B read holder=0, called it stale,
 *      and took over. FIX: publish atomically via hard-link of a temp that ALREADY holds the pid — the lock file is never
 *      observed empty.
 *   #3 double release     : A released, B acquired, A released again and deleted B's lock. FIX: release is
 *      ownership-checked + idempotent — it removes the lock ONLY if it still holds OUR pid.
 * A live holder ⇒ null (back off). Pure except the injected pidAlive (real = signal 0; EPERM ⇒ alive, the process exists).
 *
 * DISP-3 three-state read: a lock we CANNOT read is UNKNOWN, NOT reclaimable (never steal a live-but-unreadable holder's lock).
 * EL-3 (egress review, codex:Work): the lock read is FIFO-SAFE — a planted FIFO/dir/symlink at the lock path can NOT block the
 *   caller inside a plain readFileSync. The default readLock opens O_NONBLOCK|O_NOFOLLOW, fstats the SAME fd to confirm a regular
 *   file (closing the lstat->read TOCTOU), and reads the small pid record from that fd; a non-regular/would-block/symlink lock is
 *   a throw the three-state read maps to UNKNOWN=HOLD (timely failure, never a hang).
 */

import { writeFileSync, unlinkSync, renameSync, linkSync, openSync, fstatSync, readSync, closeSync, constants as FS } from "node:fs";

export type LockIO = {
  pidAlive: (pid: number) => boolean;
  /** DISP-3 three-state seam: read the lock file's raw contents, throwing with `.code` on fault (ENOENT = gone vs any other =
   *  UNKNOWN). Injectable so the unreadable-lock path is deterministically testable. Defaults to the FIFO-safe reader (EL-3). */
  readLock?: (lockPath: string) => string;
};

/** FIFO-SAFE, symlink-rejecting, non-blocking read of a lock file (EL-3). A plain `readFileSync` on a FIFO lock BLOCKS until a
 *  writer appears — wedging the record (and the caller's send). Opens O_RDONLY|O_NONBLOCK|O_NOFOLLOW (a FIFO opens immediately,
 *  a symlink ⇒ ELOOP), fstats the SAME fd to confirm a regular file (closes the lstat->read TOCTOU), then reads the small pid
 *  record from that fd. Throws ENOENT when absent (three-state treats it as "vanished ⇒ retry"); any other fault — non-regular
 *  (ENOTREG), symlink (ELOOP), EACCES, or a would-block FIFO (EAGAIN) — throws and the three-state read maps it to UNKNOWN=HOLD. */
function readLockFifoSafe(lockPath: string): string {
  const fd = openSync(lockPath, FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOFOLLOW); // ENOENT/ELOOP/EACCES propagate with .code
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error(`lock ${lockPath} is not a regular file`), { code: "ENOTREG" });
    const buf = Buffer.allocUnsafe(64); // a pid record is tiny; never read an unbounded stream from the lock path
    let off = 0;
    for (;;) {
      const r = readSync(fd, buf, off, buf.length - off, null); // regular-file read (O_NONBLOCK is a no-op here); EAGAIN ⇒ throws
      off += r;
      if (r === 0 || off >= buf.length) break;
    }
    return buf.toString("utf8", 0, off);
  } finally { closeSync(fd); }
}

export const realLockIO: LockIO = {
  pidAlive: (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // EPERM ⇒ exists; ESRCH/other ⇒ not a live holder
  },
  readLock: readLockFifoSafe,
};

const safeUnlink = (p: string): void => { try { unlinkSync(p); } catch { /* already gone */ } };
const uniq = (lockPath: string, tag: string): string => `${lockPath}.${tag}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(1, 6)}`;

/** Acquire the single-flight lock at `lockPath`. Returns a release fn on success, or null if a LIVE holder has it (or the
 *  reclaim race was lost repeatedly). A stale lock (dead holder pid) is atomically reclaimed; an UNKNOWN (unreadable/non-regular)
 *  lock is held, never reclaimed. */
export function acquireSingleFlight(lockPath: string, io: LockIO = realLockIO): (() => void) | null {
  const readLock = io.readLock ?? realLockIO.readLock!; // DISP-3 three-state read seam (default = FIFO-safe reader, EL-3)
  // Ownership-checked, idempotent release (#3): remove the lock only if it STILL holds our pid — never a successor's. The read is
  // FIFO-safe too (EL-3: every lock-path read in the record transaction, including release, must not block on a planted FIFO).
  const release = (): void => {
    try { if (Number(readLock(lockPath).trim()) === process.pid) unlinkSync(lockPath); }
    catch { /* lock gone, unreadable, or not ours — nothing of ours to remove */ }
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tmp = uniq(lockPath, "acq");
    writeFileSync(tmp, String(process.pid), { mode: 0o600 }); // stage the pid BEFORE publishing (no empty-file window, #2)
    try {
      linkSync(tmp, lockPath); // atomic publish — EEXIST if held; the lock is born already holding our pid
      safeUnlink(tmp);
      return release;
    } catch (e) {
      safeUnlink(tmp);
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // a real fs error — surface it
      // DISP-3 three-state read of the holder (lock-readability ROOT fix): a lock we CANNOT read is UNKNOWN, NOT reclaimable.
      // ENOENT = the lock vanished (released) between our EEXIST and this read ⇒ retry the link. Any other error (non-regular
      // FIFO/dir, symlink, EACCES/EIO) ⇒ UNKNOWN holder ⇒ HOLD (return null, back off) — never reclaim a lock we cannot read, a
      // LIVE holder may own it, and (EL-R2-1) folding an unreadable LIVE lock to reclaimable lets a racer STEAL it ⇒ two writers
      // ⇒ an already-confirmed record gets overwritten. The read is FIFO-safe so a planted FIFO fails fast here, never hangs.
      let holderRaw: string;
      try { holderRaw = readLock(lockPath).trim(); }
      catch (re) {
        if ((re as NodeJS.ErrnoException).code === "ENOENT") continue; // lock vanished ⇒ retry the link
        return null;                                                   // unreadable/non-regular ⇒ UNKNOWN ⇒ HOLD (never reclaim)
      }
      const holder = Number(holderRaw);
      if (holder > 0 && io.pidAlive(holder)) return null; // a live holder owns it — back off
      // stale (dead/garbage holder): rename-aside, then VERIFY it is the SAME lock we judged (#1). rename is atomic but
      // judge-then-reclaim is not, so a racer may have refreshed the lock in between — if the moved content changed, we
      // grabbed a LIVE lock ⇒ restore it; only the exact stale lock we judged is removed. Then retry the link.
      const aside = uniq(lockPath, "stale");
      try { renameSync(lockPath, aside); } catch { continue; } // ENOENT: another racer already moved it — retry
      // Reclaim ONLY if the moved-aside copy READ SUCCESSFULLY and is byte-identical to the holder we judged. An unreadable moved
      // copy is treated as CHANGED (restore it), never as a match (DISP-3: never reclaim on the back of an unreadable read).
      let moved: string | null = null;
      try { moved = readLock(aside).trim(); } catch { moved = null; }
      if (moved !== null && moved === holderRaw) safeUnlink(aside); // exactly the stale lock we judged — reclaimed
      else {
        // DISP3-1 (codex:Work): restore the moved-aside lock ATOMICALLY. A plain rename would CLOBBER a lock a racer PUBLISHED at
        // lockPath in the judge→reclaim gap (double-hold: we overwrite the racer's live lock with our empty/old copy, then reclaim
        // it). linkSync fails EEXIST when lockPath is now occupied ⇒ we ABANDON the restore (the racer owns it) instead of
        // overwriting, and contend. This is the file-lock analog of the lock-semantics "write-then-verify-exclusive" rule.
        try { linkSync(aside, lockPath); } catch { /* occupied by a racer (EEXIST) or gone — never clobber a published holder */ }
        safeUnlink(aside); // drop our aside copy either way (restored ⇒ remove the dup hardlink; not ⇒ clean up)
      }
    }
  }
  return null; // lost the reclaim race repeatedly — back off rather than risk two writers
}
