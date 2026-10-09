/**
 * Holder-identity lock (shared primitive, DA2-R6). Extracted VERBATIM from the proven decision-batch consume lock
 * (R26 / DB-R7) so both the decision-batch store and the shared-budget pool hold one identity-in-the-filename lock instead of
 * two hand-rolled copies. A lock is a DIRECTORY (atomic mkdir) whose HOLDER IDENTITY is the NAME of the single file inside it
 * (`<pid>.<nonce>`). Identity-in-the-FILENAME makes reclaim structurally race-free (DB-R7): a dead — or this process's OWN
 * stranded — holder is reclaimed by removing its EXACT-named file, never a successor's. It also recovers OUR OWN leftover
 * credential after a faulted release (SB1): the retry finds a holder whose pid is ours and reclaims it, instead of mistaking
 * our still-alive pid for a live EXTERNAL holder and contending to timeout.
 *
 * The mkdir→publish step leaves the dir momentarily EMPTY, and an empty dir ALONE is indistinguishable from a LIVE in-flight
 * acquisition (which must NEVER be stolen). So every acquirer first writes a pre-mkdir HOLD-INTENT credential in the writable
 * parent while it is still writable — it SURVIVES even a compensation that itself faults (the parent/lock dir turning
 * unwritable mid-cleanup) and names the faulter's pid. An empty lock dir is then recoverable iff NO hold-intent of a LIVE
 * FOREIGN pid exists (a faulted holder's intent is dead/own ⇒ reclaim; a live holder's intent is alive ⇒ contend) — so a
 * faulted empty dir recovers on retry while a live in-flight one is never reclaimed.
 *
 * A `LockSite` names where the three artifacts live. The intentPrefix isolates one lock's hold-intents from any other lock that
 * shares the same intentDir (e.g. every budget pool's intents live together in the budgets dir).
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, rmSync, rmdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface LockSite {
  /** The atomic-mkdir lock DIRECTORY (the occupancy). */
  readonly lockDir: string;
  /** A WRITABLE parent dir that holds the pre-mkdir hold-intent credentials. The caller MUST ensure it exists before acquiring. */
  readonly intentDir: string;
  /** Prefix isolating THIS lock's hold-intents within intentDir (e.g. `consume.lockd.hold.` or `<pool>.lock.hold.`). */
  readonly intentPrefix: string;
}

/** MIGHT the process be alive? A successful probe or EPERM (exists, not ours) is alive. Used only to detect a LIVE foreign
 *  hold-intent in the empty-dir branch (where returning false just falls through to the own-stranded gate, which contends for any
 *  non-own dir) — it NEVER authorizes removing an external credential. An invalid pid is "not alive" here. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** DEFINITELY dead? Reclaiming an EXTERNAL published credential is authorized ONLY by a definite ESRCH (SB1 / DA2-R6). An
 *  invalid/out-of-range pid (process.kill throws ERR_OUT_OF_RANGE / ERR_INVALID_ARG_TYPE), EPERM (alive), or ANY other/unknown
 *  probe error is NOT proof of death ⇒ contend, never steal. A non-EPERM exception must not be read as "dead": that over-broad
 *  read would delete a live holder's credential whose pid merely probes to an unknown error (the unknown-external-holder boundary). */
function pidDefinitelyDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

function holdIntentPath(site: LockSite, token: string): string { return path.join(site.intentDir, `${site.intentPrefix}${token}`); }

/** Hold-intents in the intent dir, with the owning pid parsed from each name. A READ FAILURE (EACCES/…) PROPAGATES — inability
 *  to read the intents must NEVER be folded to "no intents" (DB-R7 A): it cannot authorize touching an empty lock dir a holder owns. */
function listHoldIntents(site: LockSite): { name: string; pid: number }[] {
  return readdirSync(site.intentDir).filter((n) => n.startsWith(site.intentPrefix)).map((n) => ({ name: n, pid: Number(n.slice(site.intentPrefix.length).split(".")[0]) }));
}

/** Lock DIRECTORIES THIS PROCESS created but could not publish into or drop on release — its OWN unfinished occupancy. Own-recovery
 *  is bound to THIS in-process fact, NOT to a same-pid hold-intent on disk: a prior COMPLETED call whose cleanup merely faulted
 *  leaves a stale own intent that is NOT current occupancy (DB-R7). No other process ever touches a foreign empty lock dir, so a dir
 *  we stranded stays ours alone to recover. Keyed by absolute lockDir path, so distinct sites never collide. */
const strandedLockDirs = new Set<string>();

/** Acquire the lock for `site` in ONE attempt. Returns our identity token (`<pid>.<nonce>`) if held by us, else null (contended).
 *  A caller that needs to wait wraps this in a bounded retry loop. */
export function acquireHolderLock(site: LockSite): string | null {
  const dir = site.lockDir;
  const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const mine = path.join(dir, token);
  const intent = holdIntentPath(site, token);
  const intentName = `${site.intentPrefix}${token}`;
  // Stage our hold-intent FIRST, while the parent is writable: it tells a concurrent acquirer we hold the empty mkdir→publish
  // window (⇒ they contend, never steal), and if we DIE mid-window it is the DEAD credential another process recovers us by.
  try { writeFileSync(intent, "", { flag: "wx", mode: 0o600 }); } catch { return null; } // cannot even stage ⇒ contended (rare)
  const dropIntent = () => { try { unlinkSync(intent); } catch { /* best-effort */ } };
  // Win the atomic mkdir, then publish our identity INSIDE the lock. If the publish faults, the empty dir we just made is OUR OWN
  // unfinished occupancy ⇒ record it so a same-process retry recovers it (never leave an identity-less dir to a stale-intent guess).
  const take = (): boolean => {
    try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return false; } // held by someone
    try { writeFileSync(mine, "", { mode: 0o600 }); } catch (e) { strandedLockDirs.add(dir); throw e; }
    strandedLockDirs.delete(dir); return true;
  };
  if (take()) return token; // won; identity published
  // Lock dir exists.
  let entries: string[]; try { entries = readdirSync(dir); } catch { dropIntent(); return null; } // vanished mid-check ⇒ contended
  if (entries.length === 1) {
    // A PUBLISHED holder. Reclaim by its EXACT name iff it is OUR OWN residue (same pid — a faulted release of ours) or the holder
    // is DEFINITELY dead (ESRCH only). An invalid/out-of-range pid, EPERM, or any unknown probe error is NOT reclaimable (SB1).
    const holder = entries[0]!;
    const hpid = Number(holder.split(".")[0]);
    if (Number.isInteger(hpid) && hpid > 0 && (hpid === process.pid || pidDefinitelyDead(hpid))) {
      let removed = false; try { rmSync(path.join(dir, holder)); removed = true; } catch { /* a peer reclaimed it first */ }
      if (removed) { try { rmdirSync(dir); strandedLockDirs.delete(dir); } catch { strandedLockDirs.add(dir); } } // dropped it ⇒ any stale own record is void (DB-R7 B); could not drop ⇒ ours to recover (retry adopts)
      try { if (take()) return token; } catch (e) { throw e; }
    }
    dropIntent(); return null; // live published holder, or reclaim lost ⇒ contended
  }
  if (entries.length === 0) {
    // EMPTY lock dir. We recover it ONLY to continue OUR OWN unfinished occupancy, by ADOPTION (publish our identity straight INTO
    // it — NO rmdir, so no remove→recreate gap a live holder could fall into). Any other empty dir ⇒ CONTEND:
    //  (A) reading the hold-intents MUST succeed — a read fault cannot prove recoverability ⇒ contend (never fold to empty);
    //  (B) a LIVE FOREIGN hold-intent ⇒ a holder is mid-publish/arriving ⇒ contend (never steal — DB-R7 occupancy protection);
    //  (C) OUR OWN unfinished occupancy (this process stranded THIS dir, tracked in-process) ⇒ adopt.
    // An EXTERNAL empty dir — including a DEAD holder's stranded one — is NEVER adopted here: a stale on-disk credential cannot
    // prove the CURRENT dir is unoccupied (DB-R7 A/B — a dead intent may outlive the dir it named), and a crashed external holder's
    // recovery is handled out of band (R26). So external empty dirs are simply contended.
    let others: { name: string; pid: number }[];
    try { others = listHoldIntents(site).filter((i) => i.name !== intentName); } catch { dropIntent(); return null; }
    if (others.some((i) => i.pid !== process.pid && pidAlive(i.pid))) { dropIntent(); return null; } // (B) live foreign ⇒ contend
    if (!strandedLockDirs.has(dir)) { dropIntent(); return null; } // (C-neg) not our own unfinished occupancy ⇒ contend
    try { writeFileSync(mine, "", { mode: 0o600 }); } catch { dropIntent(); return null; } // (C) adopt; dir not writable/vanished ⇒ contend (a later retry re-adopts or wins fresh)
    strandedLockDirs.delete(dir);
    for (const i of others) { if (i.pid === process.pid) { try { unlinkSync(path.join(site.intentDir, i.name)); } catch { /* best-effort cleanup of our OWN stale intents (a dead foreign intent is left for R26) */ } } }
    return token;
  }
  dropIntent(); return null; // >1 identity (ambiguous) ⇒ contended
}

/** Release: remove our identity file, drop the (now-empty) lock dir, then remove our hold-intent. NEVER throws. If the rmdir
 *  faults, the empty dir is OUR OWN unfinished occupancy ⇒ record it so a same-process retry recovers it (adopts it). */
export function releaseHolderLock(site: LockSite, token: string): void {
  const dir = site.lockDir;
  try { rmSync(path.join(dir, token), { force: true }); } catch { /* best-effort */ }
  try { rmdirSync(dir); strandedLockDirs.delete(dir); } catch { strandedLockDirs.add(dir); } // could not drop the empty dir ⇒ ours to recover
  try { unlinkSync(holdIntentPath(site, token)); } catch { /* best-effort */ }
}
