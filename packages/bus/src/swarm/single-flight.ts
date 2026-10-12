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
 */

import { writeFileSync, readFileSync, unlinkSync, renameSync, linkSync } from "node:fs";

export type LockIO = {
  pidAlive: (pid: number) => boolean;
  /** DISP-3 three-state seam: read the lock file's raw contents, throwing with `.code` on fault (ENOENT = gone vs EACCES/other =
   *  UNKNOWN). Injectable so the unreadable-lock path is deterministically testable without a flaky chmod. Defaults to readFileSync. */
  readLock?: (lockPath: string) => string;
};

export const realLockIO: LockIO = {
  pidAlive: (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // EPERM ⇒ exists; ESRCH/other ⇒ not a live holder
  },
  readLock: (lockPath) => readFileSync(lockPath, "utf8"),
};

const safeUnlink = (p: string): void => { try { unlinkSync(p); } catch { /* already gone */ } };
const uniq = (lockPath: string, tag: string): string => `${lockPath}.${tag}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(1, 6)}`;

/** Acquire the single-flight lock at `lockPath`. Returns a release fn on success, or null if a LIVE holder has it (or the
 *  reclaim race was lost repeatedly). A stale lock (dead holder pid) is atomically reclaimed. */
export function acquireSingleFlight(lockPath: string, io: LockIO = realLockIO): (() => void) | null {
  // Ownership-checked, idempotent release (#3): remove the lock only if it STILL holds our pid — never a successor's.
  const release = (): void => {
    try { if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) unlinkSync(lockPath); }
    catch { /* lock gone or unreadable — nothing of ours to remove */ }
  };
  const readLock = io.readLock ?? realLockIO.readLock!; // DISP-3 three-state read seam (default readFileSync)

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
      // ENOENT = the lock vanished (released) between our EEXIST and this read ⇒ retry the link. EACCES/EIO/any other error ⇒
      // UNKNOWN holder ⇒ HOLD (return null, back off) — never reclaim a lock we cannot read, a LIVE holder may own it. (The old
      // code folded an unreadable lock to "" ⇒ NaN ⇒ reclaimable, which could STEAL a live-but-unreadable holder's lock — the
      // defect 90b58f9c's fleet FR6 shell-precheck temporarily avoided; this is the terminal fix at the shared-primitive layer.)
      let holderRaw: string;
      try { holderRaw = readLock(lockPath).trim(); }
      catch (re) {
        if ((re as NodeJS.ErrnoException).code === "ENOENT") continue; // lock vanished ⇒ retry the link
        return null;                                                   // unreadable ⇒ UNKNOWN ⇒ HOLD (never reclaim)
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
