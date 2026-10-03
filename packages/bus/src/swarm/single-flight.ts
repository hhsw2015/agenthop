/**
 * Single-flight file lock (team-collab §0b R2, Codex review P2-1/R2). The dispatcher is "single-active" by design, but a
 * second process (or a --sweep-once overlapping a live loop) ran concurrent sweeps that double-delivered + overwrote
 * same-seq batches. This makes the single-writer precondition a MECHANISM.
 *
 * The naive "create empty, write pid, check pid, unlink-if-dead" had three races the review pinned (each closed here):
 *   #1 stale-reclaim race : two racers both see a dead holder, both unlink + recreate ⇒ two owners. FIX: reclaim is an
 *      atomic rename (only ONE racer renames the stale lock aside; the loser gets ENOENT and simply retries).
 *   #2 empty-file window  : A's O_EXCL create made an EMPTY file before writing its pid; B read holder=0, called it stale,
 *      and took over. FIX: publish atomically via hard-link of a temp that ALREADY holds the pid — the lock file is never
 *      observed empty.
 *   #3 double release     : A released, B acquired, A released again and deleted B's lock. FIX: release is
 *      ownership-checked + idempotent — it removes the lock ONLY if it still holds OUR pid.
 * A live holder ⇒ null (back off). Pure except the injected pidAlive (real = signal 0; EPERM ⇒ alive, the process exists).
 */

import { writeFileSync, readFileSync, unlinkSync, renameSync, linkSync } from "node:fs";

export type LockIO = { pidAlive: (pid: number) => boolean };

export const realLockIO: LockIO = {
  pidAlive: (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // EPERM ⇒ exists; ESRCH/other ⇒ not a live holder
  },
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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tmp = uniq(lockPath, "acq");
    writeFileSync(tmp, String(process.pid), { mode: 0o600 }); // stage the pid BEFORE publishing (no empty-file window, #2)
    try {
      linkSync(tmp, lockPath); // atomic publish — EEXIST if held; the lock is born already holding our pid
      safeUnlink(tmp);
      return release;
    } catch (e) {
      safeUnlink(tmp);
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // a real fs error — surface it
      let holder = 0;
      try { holder = Number(readFileSync(lockPath, "utf8").trim()); } catch { /* unreadable ⇒ treat as reclaimable */ }
      if (holder > 0 && io.pidAlive(holder)) return null; // a live holder owns it — back off
      // stale (dead/garbage holder): claim the reclaim atomically — only one racer wins the rename (#1); then retry.
      try { const aside = uniq(lockPath, "stale"); renameSync(lockPath, aside); safeUnlink(aside); }
      catch { /* ENOENT: another racer already reclaimed it — just retry the link */ }
    }
  }
  return null; // lost the reclaim race repeatedly — back off rather than risk two writers
}
