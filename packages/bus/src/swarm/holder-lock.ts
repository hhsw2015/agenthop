/**
 * Holder-identity lock (shared primitive, DA2-R6). Extracted from the proven decision-batch consume lock (R26 / DB-R7) so every
 * consumer (decision-batch store, shared-budget pool, shell-succession, tg-queue drain) holds ONE identity-in-the-filename lock
 * instead of hand-rolled copies. A lock is a DIRECTORY (atomic mkdir) whose HOLDER IDENTITY is the NAME of the single file inside
 * it (`<pid>.<nonce>`). Identity-in-the-FILENAME makes reclaim structurally race-free (DB-R7): a dead — or this process's OWN
 * stranded — holder is reclaimed by removing its EXACT-named file, never a successor's.
 *
 * SHARED LOCK SEMANTICS (TGP-11 / SUCC-1 / FR6 convergence, coordinator-finalized 2026-10-12 — this is the single implementation
 * all four consumers inherit; if this reclaim logic changes it must be FULLY re-reviewed, it does not ride an older CLEARED SHA):
 *
 *   The mkdir→publish step leaves the dir momentarily EMPTY, and an empty dir ALONE is indistinguishable from a LIVE in-flight
 *   acquisition. So every acquirer first writes a pre-mkdir HOLD-INTENT credential in the writable parent — it names the acquirer's
 *   pid and SURVIVES a compensation that itself faults. Because the intent is written BEFORE the mkdir, an empty dir with NO live
 *   foreign intent provably has NO live acquirer on it.
 *
 *   (1) SOLE-OWNERSHIP VERIFY (②): a successful mkdir+publish is NOT proof of exclusivity — a concurrent reclaimer may have written
 *       its token into our fresh dir during the mkdir→publish window. So `take()` re-reads and holds the lock ONLY if the dir holds
 *       EXACTLY our token; otherwise it BACKS OFF (removes our token) and reports not-taken. No double-hold.
 *   (2) EMPTY-DIR RECLAIM = rmdir-if-empty + fresh mkdir (NOT a pure adopt-into). The mkdir is ATOMIC, so several competing
 *       acquirers resolve to EXACTLY ONE winner — a pure adopt-into with a hard live-intent gate would instead let two live adopters
 *       mutually block forever (livelock). ② closes the ABA window the rmdir opens: if we rmdir a dir a live holder was mid-publishing,
 *       our fresh mkdir + its late token-write land in the SAME dir and its OWN ② backs it off. Gated by the hold-intents: a read
 *       fault ⇒ contend (EIO=unknown); a LIVE FOREIGN intent (anything not ESRCH-definitely-dead) ⇒ contend, never churn it (DB-R7 B).
 *   (3) PUBLISHED-TOKEN RECLAIM (entries>=1, SUCC1-3): reclaim iff EVERY token is OUR OWN (same pid) or DEFINITELY DEAD (ESRCH only);
 *       ANY live/unknown token ⇒ contend (never steal a live holder, never PARTIALLY delete). This keeps a DEAD MULTI-token residual
 *       (two reclaimers whose ② back-off cleanup both faulted) INHERITABLE instead of permanently wedged.
 *   (4) PROBES are ESRCH-only (`pidDefinitelyDead`): EPERM/invalid-pid/any-other error is NOT proof of death ⇒ contend, never steal.
 *
 * A `LockSite` names where the two artifacts live. The intentPrefix isolates one lock's hold-intents from any other lock that
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

/** DEFINITELY dead? Reclaiming a published credential (own-pid aside) or adopting an empty dir is authorized ONLY by a definite
 *  ESRCH (SB1 / DA2-R6). An invalid/out-of-range pid, EPERM (alive, not ours), or ANY other/unknown probe error is NOT proof of
 *  death ⇒ contend, never steal. Treating an unknown probe as "dead" would delete a live holder whose pid merely probes to an
 *  unknown error (the unknown-external-holder boundary; EIO=unknown=HOLD, per SUCC-1 / FR6). */
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

/** Acquire the lock for `site` in ONE attempt. Returns our identity token (`<pid>.<nonce>`) if held by us (verified sole owner),
 *  else null (contended). A caller that needs to wait wraps this in a bounded retry loop. */
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

  // Win the atomic mkdir, publish our identity INSIDE the lock, then VERIFY SOLE OWNERSHIP (②). A successful mkdir+write is NOT
  // proof of exclusivity: a concurrent reclaimer may have written its token into our fresh dir during the mkdir→publish window.
  // Re-read — we hold it ONLY if the dir contains EXACTLY our token; otherwise BACK OFF (remove ours; a faulted remove becomes a
  // residual the entries>=1 SUCC1-3 path clears later) and report not-taken. A publish/verify FS fault ⇒ back off (never claim held).
  const take = (): boolean => {
    try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return false; } // dir already exists ⇒ not a fresh win
    try { writeFileSync(mine, "", { mode: 0o600 }); } catch { try { rmSync(mine, { force: true }); } catch { /* */ } return false; } // publish faulted ⇒ back off (dir left empty ⇒ a retry's rmdir-if-empty reclaims)
    let after: string[];
    try { after = readdirSync(dir); } catch { try { rmSync(mine, { force: true }); } catch { /* residual ⇒ SUCC1-3 reclaims */ } return false; } // can't verify ⇒ back off
    if (after.length !== 1 || after[0] !== token) { try { rmSync(mine, { force: true }); } catch { /* ditto */ } return false; } // ② not sole owner ⇒ back off (no double-hold)
    return true;
  };

  if (take()) return token; // won the fresh mkdir + verified sole
  // Lock dir exists.
  let entries: string[]; try { entries = readdirSync(dir); } catch { dropIntent(); return null; } // vanished mid-check ⇒ contended

  if (entries.length >= 1) {
    // Published token(s). SUCC1-3 reclaim: reclaim iff EVERY token is OUR OWN (same pid — a faulted release/② back-off of ours) or
    // DEFINITELY DEAD (ESRCH). ANY live/unknown token ⇒ contend — never steal a live holder (DB-R7), never PARTIALLY delete (could
    // drop a live holder or reopen double-hold). All-dead ⇒ clear every token by EXACT name, then take() fresh. (entries===1
    // own/dead-reclaim is this same rule at n=1; the old entries>1 ⇒ unconditional-contend was the permanent-wedge gap.)
    const toks = entries.map((h) => ({ name: h, pid: Number(h.split(".")[0]) }));
    const allReclaimable = toks.every((e) => Number.isInteger(e.pid) && e.pid > 0 && (e.pid === process.pid || pidDefinitelyDead(e.pid)));
    if (!allReclaimable) { dropIntent(); return null; } // a live/unknown holder ⇒ contend
    for (const e of toks) { try { rmSync(path.join(dir, e.name)); } catch { /* a peer reclaimed it first; any leftover ⇒ take()'s mkdir EEXIST ⇒ retry next pass */ } }
    try { rmdirSync(dir); } catch { /* not empty (a peer re-published) / raced ⇒ take() below contends cleanly */ }
    try { if (take()) return token; } catch (e) { throw e; }
    dropIntent(); return null; // reclaim lost a race ⇒ contended
  }

  // EMPTY lock dir: a holder crashed between mkdir and publish, OR a prior adopter backed off. Reclaim = rmdir-if-empty + fresh
  // mkdir (take()), gated by the hold-intents:
  //  (1) reading intents MUST succeed — a read fault cannot prove recoverability ⇒ contend (EIO=unknown, never fold to "none");
  //  (2) a LIVE FOREIGN hold-intent (anything not ESRCH-definitely-dead) ⇒ a holder is arriving/mid-publish ⇒ contend (DB-R7 B);
  //  (3) rmdir the empty dir — ENOTEMPTY (a token appeared since) or a race/vanish ⇒ contend — then take() fresh (atomic mkdir + ②).
  let others: { name: string; pid: number }[];
  try { others = listHoldIntents(site).filter((i) => i.name !== intentName); } catch { dropIntent(); return null; } // (1)
  if (others.some((i) => i.pid !== process.pid && !(Number.isInteger(i.pid) && i.pid > 0 && pidDefinitelyDead(i.pid)))) { dropIntent(); return null; } // (2) any not-definitely-dead FOREIGN intent ⇒ contend
  try { rmdirSync(dir); } catch { dropIntent(); return null; } // (3) non-empty / vanished / raced ⇒ contend
  // gate (2) proved every FOREIGN intent ESRCH-dead ⇒ safe to clear our OWN + the dead-foreign intents (prevents an intent-dir leak),
  // by EXACT name so a pid-reused live newcomer's DIFFERENT-named intent is never touched.
  for (const i of others) { try { unlinkSync(path.join(site.intentDir, i.name)); } catch { /* best-effort */ } }
  try { if (take()) return token; } catch (e) { throw e; } // fresh mkdir race + ② sole-verify
  dropIntent(); return null;
}

/** Release: remove our identity file, drop the (now-empty) lock dir, then remove our hold-intent. NEVER throws. If the rmdir
 *  faults (not empty — a reclaimer already re-published — or raced), a later acquire's rmdir-if-empty / SUCC1-3 reclaim handles it. */
export function releaseHolderLock(site: LockSite, token: string): void {
  const dir = site.lockDir;
  try { rmSync(path.join(dir, token), { force: true }); } catch { /* best-effort */ }
  try { rmdirSync(dir); } catch { /* not empty / raced ⇒ a later acquire reclaims it */ }
  try { unlinkSync(holdIntentPath(site, token)); } catch { /* best-effort */ }
}
