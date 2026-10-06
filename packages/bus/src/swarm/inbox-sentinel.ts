/**
 * F40 — unclaimed-mail sentinel. The LAST line of defense against a silent swarm stall: even if write-side stable addressing
 * (resolveInboxTarget) and drain-side legacy-claim (legacyInboxKeys) both miss, a durable inbox that accumulates unread mail
 * past a threshold with NO live session draining it is a stuck mailbox — and the machine must notice it, not a human hours later
 * (the F40 incident: a dead box's backlog surfaced only when the user eyeballed it).
 *
 * Pure decision (detectStalledInboxes) + injected IO (scanInboxes reads the fs; the caller supplies liveness + escalation), so
 * the "is this box stalled?" rule is unit-tested without a filesystem or a broker. The dispatcher runs it on the sweep tick and
 * escalates each alert to the coordinator's durable inbox (notifyCoordinator), fail-soft.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Is `pid` a LIVE process (kill(pid,0): ok / EPERM ⇒ alive; ESRCH / any other errno ⇒ not alive). An "alive" claim is IN
 *  FLIGHT (a live drainer holds it) and must not be counted or stolen; a NOT-alive one (dead ESRCH, or an unverifiable errno)
 *  is a stranded residual the sentinel REPORTS — it never claims/acks/steals, so reporting an unverifiable pid is safe. */
function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** One durable inbox dir's unclaimed state. `oldestUnclaimedAtMs` = the ts of the oldest DELIVERABLE (.json) message; the age
 *  is computed by the pure decision against nowSec. In-flight `.claim-<pid>` files (a drainer holds them) are NOT counted. */
export type InboxStat = { key: string; unclaimedCount: number; oldestUnclaimedAtMs: number };

export type StallAlert = { key: string; unclaimedCount: number; staleSec: number };

/**
 * PURE: which inboxes are stalled — unclaimed mail older than thresholdSec AND no live session owns the box. A box with a live
 * owner is being drained (near-live via the fs-watch, or on the 5s flush), so it is never alerted however old its backlog looks
 * in a single instant. isOwnedByLive(key) is injected (the caller folds the live roster + each session's current+legacy keys,
 * mirroring core's inboxKeys()) — so this stays a decision, not an fs/proc probe.
 */
export function detectStalledInboxes(stats: InboxStat[], isOwnedByLive: (key: string) => boolean, thresholdSec: number, nowSec: number): StallAlert[] {
  const alerts: StallAlert[] = [];
  for (const s of stats) {
    if (s.unclaimedCount <= 0) continue;
    const staleSec = nowSec - Math.floor(s.oldestUnclaimedAtMs / 1000);
    if (staleSec < thresholdSec) continue; // backlog is fresh — a drainer may simply not have run its 5s flush yet
    if (isOwnedByLive(s.key)) continue;    // a live session's key-set includes this box ⇒ it will be drained, not stalled
    alerts.push({ key: s.key, unclaimedCount: s.unclaimedCount, staleSec });
  }
  return alerts;
}

/**
 * IO: scan ~/.agenthop/inbox/<key>/ for STRANDED messages, returning each box's count + oldest ts. Stranded =
 *  - a deliverable `.json` (no drainer has claimed it), OR
 *  - a `.json.claim-<pid>` whose holder pid is NOT alive (F40-3): a crashed/exited drainer left it, and recoverStaleClaims
 *    only rescues keys a live core already owns — so an UNOWNED box's dead-pid residual is otherwise invisible to the last
 *    line of stall detection. A LIVE-pid claim is in-flight and excluded (never counted, never stolen). The sentinel only
 *    REPORTS, so counting a dead/unverifiable pid is safe (it does not claim/ack).
 * The oldest ts comes from the filename prefix (padStart(16) of the message ts — see inbox.ts writeInbox; the `.claim-<pid>`
 * suffix is appended AFTER, so the prefix still parses), falling back to the file mtime if unparseable. quarantine/ lives in a
 * subdir, so it is never a top-level entry here. Fail-soft: an unreadable root/dir is skipped, never thrown. `pidAlive` is
 * injected for tests; it defaults to a real kill(pid,0) probe.
 */
export function scanInboxes(home: string, pidAlive: (pid: number) => boolean = defaultPidAlive): InboxStat[] {
  const root = path.join(home, ".agenthop", "inbox");
  let dirs: string[];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
  const out: InboxStat[] = [];
  for (const key of dirs) {
    const dir = path.join(root, key);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const stranded: string[] = [];
    for (const n of names) {
      if (n.endsWith(".json")) { stranded.push(n); continue; } // deliverable, unclaimed
      const m = n.match(/\.json\.claim-(\d+)$/);               // a claimed-but-orphaned message
      if (m && !pidAlive(Number(m[1]))) stranded.push(n);      // holder gone/unverifiable ⇒ stranded (live-pid ⇒ in flight, skip)
    }
    if (stranded.length === 0) continue;
    let oldest = Infinity;
    for (const n of stranded) {
      const fromName = Number(n.slice(0, 16));
      let atMs = Number.isFinite(fromName) && fromName > 0 ? fromName : NaN;
      if (!Number.isFinite(atMs)) { try { atMs = statSync(path.join(dir, n)).mtimeMs; } catch { atMs = Date.now(); } }
      if (atMs < oldest) oldest = atMs;
    }
    out.push({ key, unclaimedCount: stranded.length, oldestUnclaimedAtMs: oldest === Infinity ? Date.now() : oldest });
  }
  return out;
}
