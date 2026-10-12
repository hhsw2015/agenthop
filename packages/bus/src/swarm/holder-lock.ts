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

/** Options for a single acquire. */
export interface AcquireOpts {
  /**
   * SUCC-1 (opt-in; default OFF ⇒ existing callers byte-identical). Also reclaim an EXTERNAL empty lock dir that is PROVABLY
   * stranded — EVERY foreign hold-intent is a CONFIRMED-DEAD (ESRCH) pid, at least one exists, and NONE is alive-or-unknown.
   * Reclaim is single-winner + generation-atomic (SUCC1-1): the all-dead SCAN alone is NOT proof the dir is still the one we
   * probed — a NORMAL release + fresh acquire can swap the generation between scan and write — so the reclaimer rmdirs the dir
   * ONLY while it is still EMPTY (atomic empty-check; a published holder ⇒ ENOTEMPTY, an already-removed dir ⇒ ENOENT, both ⇒
   * contend), then re-acquires via a fresh mkdir (single-winner CAS) and publishes under the SOLE-OCCUPANCY guard (publishSole:
   * after the identity write it reads the dir back and holds ONLY if its token is the single entry — an interloper from a dir
   * swapped in the mkdir→publish window shows up as a second entry and we back out). Two concurrent reclaimers cannot both win
   * (the rmdir source is consumed once; the re-mkdir is single). A non-ESRCH probe (EPERM/EIO/unknown) never authorizes (SUCC1-2).
   * Succession passes this so a crash-stranded `<sid>.adopt.lockd` is not un-adoptable forever; decision-batch (R26 out-of-band)
   * + shared-budget do NOT.
   */
  reclaimExternalStranded?: boolean;
}

/** Acquire the lock for `site` in ONE attempt. Returns our identity token (`<pid>.<nonce>`) if held by us, else null (contended).
 *  A caller that needs to wait wraps this in a bounded retry loop. */
export function acquireHolderLock(site: LockSite, opts: AcquireOpts = {}): string | null {
  const dir = site.lockDir;
  const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const mine = path.join(dir, token);
  const intent = holdIntentPath(site, token);
  const intentName = `${site.intentPrefix}${token}`;
  // Stage our hold-intent FIRST, while the parent is writable: it tells a concurrent acquirer we hold the empty mkdir→publish
  // window (⇒ they contend, never steal), and if we DIE mid-window it is the DEAD credential another process recovers us by.
  try { writeFileSync(intent, "", { flag: "wx", mode: 0o600 }); } catch { return null; } // cannot even stage ⇒ contended (rare)
  const dropIntent = () => { try { unlinkSync(intent); } catch { /* best-effort */ } };
  // SUCC1-1 r4 (codex:Work): publish our identity, then prove SOLE OCCUPANCY (not a generation SAMPLE — r3's dev+ino+birth
  // baseline was read AFTER mkdir, so a swap in the mkdir→firstStat window was already baked into the baseline; codex broke it).
  // A NON-EMPTY lock dir can NEVER be rmdir'd (ENOTEMPTY is the exact OS guarantee the reclaim path relies on), so once our token
  // is the dir's ONLY entry we hold it STABLY — no reclaimer can touch it thereafter. The read-back AFTER the write closes the
  // whole mkdir→publish window with an INVARIANT, not a sample: if a reclaimer rmdir'd our empty dir and recreated+published into
  // a new generation, our write lands in THAT dir alongside its token ⇒ readdir shows >1 entry (or not our token) ⇒ we remove our
  // misplaced file and CONTEND; if the dir vanished entirely, the write already threw. Two LIVE sole-occupants of one dir are
  // impossible: the dir can only transition {P1}→{P2} after P1's token is removed (P1 released or is dead), never while P1 holds.
  // On a write IO fault it still records the dir as our own unfinished occupancy and THROWS (a same-process retry recovers it).
  const publishSole = (): boolean => {
    try { writeFileSync(mine, "", { mode: 0o600 }); } catch (e) { strandedLockDirs.add(dir); throw e; }
    let sole = false;
    try { const es = readdirSync(dir); sole = es.length === 1 && es[0] === token; } catch { sole = false; } // dir swapped/vanished ⇒ not sole
    if (!sole) { try { rmSync(mine, { force: true }); } catch { /* best-effort */ } strandedLockDirs.add(dir); return false; } // an interloper shares the dir (or it is gone) ⇒ void our publish ⇒ contend
    strandedLockDirs.delete(dir); return true;
  };
  // Win the atomic mkdir, then publish our identity INSIDE the lock and prove sole occupancy. If the publish faults, the empty
  // dir we just made is OUR OWN unfinished occupancy ⇒ record it so a same-process retry recovers it.
  const take = (): boolean => {
    try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return false; } // held by someone
    return publishSole();
  };
  if (take()) return token; // won; identity published
  // Lock dir exists.
  let entries: string[]; try { entries = readdirSync(dir); } catch { dropIntent(); return null; } // vanished mid-check ⇒ contended
  if (entries.length >= 1) {
    // One or more PUBLISHED identities. Reclaim by EXACT name iff EVERY token is OUR OWN residue (same pid -- a faulted
    // release/backout of ours) or DEFINITELY dead (ESRCH only). A LIVE holder, an UNKNOWN pid (EPERM/EIO), or an invalid/garbage
    // pid is PROTECTED -- a holder or an in-flight publisher may own the dir -- so we delete nothing and contend (SB1 preserved,
    // no P1 reopen). SUCC1-3 (codex:Work): classifying ALL entries (not just a single one) lets a dead MULTI-token residue --
    // left when two rejected publishSole backouts both failed their exact-name cleanup on a transient dir fault -- be recovered
    // instead of being permanently un-adoptable; still single-winner (precise removes + non-recursive rmdir + a fresh mkdir).
    let protectedEntry = false;
    const removable: string[] = [];
    for (const name of entries) {
      const pid = Number(name.split(".")[0]);
      if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || pidDefinitelyDead(pid))) removable.push(name);
      else protectedEntry = true; // live / unknown (EPERM/EIO) / invalid pid => protected, never deleted
    }
    if (protectedEntry || removable.length === 0) { dropIntent(); return null; } // a live/unknown identity may own the dir => contend
    for (const name of removable) { try { rmSync(path.join(dir, name)); } catch { /* a peer reclaimed it first */ } } // remove each own/dead token by EXACT name
    try { rmdirSync(dir); strandedLockDirs.delete(dir); } catch { strandedLockDirs.add(dir); } // dropped => stale own record void (DB-R7 B); could not drop => ours to recover (retry)
    try { if (take()) return token; } catch (e) { throw e; }
    dropIntent(); return null; // reclaim lost the re-acquire race => contended
  }
  if (entries.length === 0) {
    // EMPTY lock dir. We recover it ONLY to continue OUR OWN unfinished occupancy, by ADOPTION (publish our identity straight INTO
    // it — NO rmdir, so no remove→recreate gap a live holder could fall into). Any other empty dir ⇒ CONTEND:
    //  (A) reading the hold-intents MUST succeed — a read fault cannot prove recoverability ⇒ contend (never fold to empty);
    //  (B) a LIVE FOREIGN hold-intent ⇒ a holder is mid-publish/arriving ⇒ contend (never steal — DB-R7 occupancy protection);
    //  (C) OUR OWN unfinished occupancy (this process stranded THIS dir, tracked in-process) ⇒ adopt.
    // An EXTERNAL empty dir is adopted ONLY under the opt-in reclaimExternalStranded (SUCC-1, (D) below); otherwise a stale on-disk
    // credential cannot prove the CURRENT dir is unoccupied (DB-R7 A/B — a dead intent may outlive the dir it named), so by default
    // a crashed external holder's recovery is left out of band (R26) and external empty dirs are contended.
    let others: { name: string; pid: number }[];
    try { others = listHoldIntents(site).filter((i) => i.name !== intentName); } catch { dropIntent(); return null; }
    if (others.some((i) => i.pid !== process.pid && pidAlive(i.pid))) { dropIntent(); return null; } // (B) live foreign ⇒ contend
    const ownStranded = strandedLockDirs.has(dir);
    // (D) SUCC-1 external-stranded reclaim: PROVABLY stranded = at least one foreign hold-intent AND every foreign intent is a
    // CONFIRMED-DEAD (ESRCH) pid. A non-ESRCH probe (EPERM/EIO/unknown) leaves it NOT-all-dead ⇒ contend (SUCC1-2: unknown never
    // authorizes). A concurrent live acquirer has a LIVE intent here ⇒ not-all-dead ⇒ both contend (single-winner, no ABA).
    const externalStranded = !!opts.reclaimExternalStranded && others.length > 0 && others.every((i) => pidDefinitelyDead(i.pid));
    if (!ownStranded && !externalStranded) { dropIntent(); return null; } // (C-neg) not our own, not provably-stranded ⇒ contend
    if (externalStranded) {
      // (D) SUCC1-1 (codex:Work): a stale all-dead scan is NOT proof the CURRENT dir is still the one we probed — a NORMAL
      // release + fresh acquire can swap the lock dir's generation between our scan and our write, so a blind adopt-into would
      // seat us on someone ELSE's new dir (two holders). Reclaim is therefore single-winner + generation-atomic: rmdir removes
      // the dir ONLY while it is still EMPTY (a published holder ⇒ ENOTEMPTY ⇒ contend; already gone ⇒ ENOENT ⇒ contend),
      // CONSUMING this exact empty dir; a fresh take() then re-mkdirs (single-winner CAS) and publishes under the SOLE-OCCUPANCY
      // guard (publishSole). A dir released+recreated meanwhile is caught by rmdir (non-empty / vanished) or by the sole-occupancy
      // read-back — never adopted blind. Two concurrent reclaimers cannot both win: the rmdir source is consumed once, re-mkdir is single.
      try { rmdirSync(dir); } catch { dropIntent(); return null; }
      let held = false; try { held = take(); } catch { dropIntent(); return null; } // write IO fault ⇒ contend (own-recovery recorded)
      if (!held) { dropIntent(); return null; } // lost the re-acquire mkdir race / swapped under us ⇒ contend
      for (const i of others) { if (i.pid === process.pid || pidDefinitelyDead(i.pid)) { try { unlinkSync(path.join(site.intentDir, i.name)); } catch { /* best-effort */ } } } // the dead/own intents we superseded
      return token;
    }
    // (C) OUR OWN unfinished occupancy: adopt INTO our own empty dir, sole-occupancy-guarded (publishSole). No rmdir — this dir is
    // ours alone (tracked in-process; no default-path peer reclaims a foreign empty dir), and the guard still catches a concurrent
    // opt-in reclaimer that rmdir'd it under us (our write would then not be the sole entry).
    let held = false; try { held = publishSole(); } catch { dropIntent(); return null; }
    if (!held) { dropIntent(); return null; }
    for (const i of others) { if (i.pid === process.pid) { try { unlinkSync(path.join(site.intentDir, i.name)); } catch { /* best-effort */ } } }
    return token;
  }
  dropIntent(); return null; // defensive: entries is >=1 or ===0 above, both handled — unreachable, kept for the return type
}

/** Release: remove our identity file, drop the (now-empty) lock dir, then remove our hold-intent. NEVER throws. If the rmdir
 *  faults, the empty dir is OUR OWN unfinished occupancy ⇒ record it so a same-process retry recovers it (adopts it). */
export function releaseHolderLock(site: LockSite, token: string): void {
  const dir = site.lockDir;
  try { rmSync(path.join(dir, token), { force: true }); } catch { /* best-effort */ }
  try { rmdirSync(dir); strandedLockDirs.delete(dir); } catch { strandedLockDirs.add(dir); } // could not drop the empty dir ⇒ ours to recover
  try { unlinkSync(holdIntentPath(site, token)); } catch { /* best-effort */ }
}
