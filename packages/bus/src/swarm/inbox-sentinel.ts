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
 * IO: scan ~/.agenthop/inbox/<key>/ for DELIVERABLE (.json) messages, returning each box's unclaimed count + oldest ts. The
 * oldest ts comes from the filename prefix (padStart(16) of the message ts — see inbox.ts writeInbox), falling back to the file
 * mtime if a name is unparseable. Only TOP-LEVEL .json files count: quarantine/ lives in a subdir, and in-flight `.claim-*`
 * files are excluded (a live drainer holds them). Fail-soft: an unreadable root/dir is skipped, never thrown.
 */
export function scanInboxes(home: string): InboxStat[] {
  const root = path.join(home, ".agenthop", "inbox");
  let dirs: string[];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
  const out: InboxStat[] = [];
  for (const key of dirs) {
    const dir = path.join(root, key);
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { continue; }
    if (names.length === 0) continue;
    let oldest = Infinity;
    for (const n of names) {
      const fromName = Number(n.slice(0, 16));
      let atMs = Number.isFinite(fromName) && fromName > 0 ? fromName : NaN;
      if (!Number.isFinite(atMs)) { try { atMs = statSync(path.join(dir, n)).mtimeMs; } catch { atMs = Date.now(); } }
      if (atMs < oldest) oldest = atMs;
    }
    out.push({ key, unclaimedCount: names.length, oldestUnclaimedAtMs: oldest === Infinity ? Date.now() : oldest });
  }
  return out;
}
