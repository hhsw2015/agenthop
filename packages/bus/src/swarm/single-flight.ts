/**
 * Single-flight file lock (team-collab §0b R2, Codex review P2-1). The dispatcher is "single-active" by design, but that
 * was an ASSUMPTION — a second dispatcher process (or a --sweep-once overlapping a live loop) ran concurrent sweeps that
 * double-delivered inbox pings and let a stale in-memory snapshot overwrite an already-committed <seq>.json. This makes
 * the serial/single-writer precondition a MECHANISM: an O_EXCL lock file holding the owner's pid.
 *
 * A live holder ⇒ null (the caller backs off — do NOT run a second writer). A STALE lock (its pid is dead) is reclaimed
 * once, so a crashed dispatcher doesn't wedge the next start. Pure except for the injected pidAlive (real impl = signal 0,
 * EPERM ⇒ alive since the process exists), so the reclaim decision is unit-tested.
 */

import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";

export type LockIO = { pidAlive: (pid: number) => boolean };

export const realLockIO: LockIO = {
  pidAlive: (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // EPERM ⇒ exists; ESRCH/other ⇒ not a live holder
  },
};

/** Acquire the single-flight lock at `lockPath`. Returns a release fn on success, or null if a LIVE holder already has it.
 *  A stale lock (dead holder pid) is reclaimed once and retried. */
export function acquireSingleFlight(lockPath: string, io: LockIO = realLockIO): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL — fails with EEXIST if present
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // a real fs error — surface it
      let holder = 0;
      try { holder = Number(readFileSync(lockPath, "utf8").trim()); } catch { /* unreadable — treat as reclaimable */ }
      if (holder > 0 && io.pidAlive(holder)) return null;          // a live holder owns it — back off
      try { unlinkSync(lockPath); } catch { /* another racer reclaimed it first */ } // stale — reclaim, then retry once
    }
  }
  return null; // lost the reclaim race twice — let the caller back off rather than risk two writers
}
