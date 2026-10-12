/**
 * idle-explainer IO (北极星差距审计件① — idle-root-cause auto-triage). Reads the idle signal + the four "why idle" sources and
 * atomically writes the `console/idle-explainer.json` projection the mod status band renders. Mirrors console-projection-store.ts:
 * errno-discriminated reads (FC-2 r3: an UNREADABLE source ⇒ null, never a false zero), a symlink-boundary guard before any write
 * (CP-3), atomic temp+rename, fully fail-soft. The pure shape/rule builders live in idle-explainer.ts. The S19 anomaly alert is
 * raised by the dispatcher (which owns coordinator-SID resolution), not here.
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, statSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadControlLog } from "./control-store.js";
import { liveEntities } from "./control-log.js";
import { scanUnclaimedInbox } from "../inbox.js";
import { reviewQueueDir, parseReviewFileName } from "./review-seat-autoscale.js";
import { listBatchesStrict, readBatch } from "./decision-batch-store.js";
import { buildIdleExplainer, type IdleSignals, type IdleSource, type IdleExplainer } from "./idle-explainer.js";

// --- paths (the projection is a sibling of the console producers under ~/.agenthop/swarm/console/) --------------------
function consoleDir(home: string): string { return path.join(home, ".agenthop", "swarm", "console"); }
function idleExplainerPath(home: string): string { return path.join(consoleDir(home), "idle-explainer.json"); }
function controlLogDir(home: string): string { return path.join(home, ".agenthop", "swarm", "control-log"); }
function inboxRoot(home: string): string { return path.join(home, ".agenthop", "inbox"); }
function consumedMarkerPath(home: string, batchId: string): string { return path.join(home, ".agenthop", "console", "decision-batches", batchId, "consumed.json"); }

/** CP-3 — refuse to write through a pre-existing symlinked console dir (a redirected write root). lstat (no-follow): a symlink or
 *  non-directory ⇒ false; ENOENT ⇒ not created yet (our mkdir makes a real dir) ⇒ ok; any other fault ⇒ refuse. */
function consoleBoundaryOk(home: string): boolean {
  const d = consoleDir(home);
  try { return lstatSync(d).isDirectory(); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Atomic JSON write (temp + rename), 0o700 dir / 0o600 file, so a reader never sees a half-written projection. */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------------------
// Idle detection — the authoritative dispatcher view of ACTIVE work: live control-log waits of kind "wait" (a member is working
// on a dispatched task). An "approval" wait is NOT active work (the member is STOPped awaiting a ruling — herdr shows idle), so it
// is excluded here and surfaces as the awaitingRuling signal instead.
// ---------------------------------------------------------------------------------------------------------------------

/** Count live (non-resolved) `kind:"wait"` waits = members actively working. 0 ⇒ idle-this-tick. errno-discriminated: a MISSING
 *  control-log dir (ENOENT) ⇒ 0 (confirmed no active work); any other stat fault (EACCES/…) OR a read fault inside loadControlLog
 *  ⇒ null (UNREADABLE — idle cannot be determined, FC-2 r3). READ-ONLY. */
export function countWorkingWaits(home: string): number | null {
  const dir = controlLogDir(home);
  try { statSync(dir); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; } // ENOENT ⇒ confirmed none; else unknown
  try {
    let n = 0;
    for (const b of Object.values(liveEntities(loadControlLog(dir)))) {
      if (b.put === "wait" && b.wait.kind === "wait" && b.wait.state !== "resolved") n += 1;
    }
    return n;
  } catch { return null; } // a readable dir but an unreadable/corrupt batch ⇒ unknown (never a false "idle")
}

// ---------------------------------------------------------------------------------------------------------------------
// The four "why idle" signals (each number | null, FC-2 r3)
// ---------------------------------------------------------------------------------------------------------------------

/** Total UNCLAIMED (pending, not-yet-consumed) messages across all inbox boxes. Enumerate the inbox root; sum per-box via the
 *  shared scanUnclaimedInbox. ENOENT (no inbox root) ⇒ 0 (confirmed none); any other readdir fault ⇒ null (unreadable). */
function sumUnclaimedInboxes(home: string): number | null {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(inboxRoot(home), { withFileTypes: true }); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; }
  let total = 0;
  for (const d of entries) {
    if (!d.isDirectory()) continue; // a box is a dir; skip stray files
    total += scanUnclaimedInbox(home, d.name).count; // scanUnclaimedInbox is itself fail-soft (unreadable box ⇒ 0)
  }
  return total;
}

/** Open review-seat queue depth. Counted from the ledger FILENAMES (`<ticket>.<seat>[.done].json`) — no file-content read needed.
 *  ENOENT (no review-queue dir) ⇒ 0; any other readdir fault ⇒ null. */
function reviewQueueDepthSync(home: string): number | null {
  let names: string[];
  try { names = readdirSync(reviewQueueDir(home)); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; }
  let open = 0;
  for (const name of names) {
    const parsed = parseReviewFileName(name);
    if (parsed && !parsed.done) open += 1;
  }
  return open;
}

/** Is this decision batch TERMINAL (consumed)? ENOENT ⇒ false (awaiting). Any other stat fault PROPAGATES to the per-batch catch
 *  (the batch is skipped, never miscounted as pending). */
function isConsumed(home: string, batchId: string): boolean {
  try { statSync(consumedMarkerPath(home, batchId)); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/** Decision batches AWAITING a ruling (not consumed) + the hardGate items inside them (needs the user). READ-ONLY of the
 *  decision-batch store (listBatchesStrict + readBatch + a stat of consumed.json — never a mutating call). A GLOBAL enumerate
 *  fault ⇒ both null (unreadable). A per-batch fault/corrupt is skipped (best-effort; one bad batch never nulls the signal). */
function awaitingRulingAndGates(home: string): { awaitingRuling: number | null; userGates: number | null } {
  let ids: string[];
  try { ids = listBatchesStrict(home); }
  catch { return { awaitingRuling: null, userGates: null }; } // non-ENOENT enumerate fault ⇒ unknown
  let awaiting = 0;
  let gates = 0;
  for (const id of ids) {
    try {
      if (isConsumed(home, id)) continue;       // terminal ⇒ not awaiting
      const batch = readBatch(home, id);        // foreign/corrupt/unreadable ⇒ null ⇒ skip (not counted)
      if (!batch) continue;
      awaiting += 1;
      gates += batch.items.filter((it) => it.hardGate === true).length;
    } catch { /* per-batch fault ⇒ skip (the global enumeration already succeeded) */ }
  }
  return { awaitingRuling: awaiting, userGates: gates };
}

/** Read all four "why idle" signals. Each is independently errno-discriminated (FC-2 r3). READ-ONLY. */
export function readIdleSignals(home: string): IdleSignals {
  const { awaitingRuling, userGates } = awaitingRulingAndGates(home);
  return {
    unclaimedInboxes: sumUnclaimedInboxes(home),
    reviewQueueDepth: reviewQueueDepthSync(home),
    awaitingRuling,
    userGates,
  };
}

/** Compute the signals, build the projection, atomically write `console/idle-explainer.json`, return it (or null when the write
 *  was SKIPPED by the CP-3 boundary guard). `idle` + `idleSource` are passed in by the dispatcher (which owns the N-consecutive-
 *  tick counter and the control-log idle read). Fail-soft is the caller's wrap. */
export function writeIdleExplainer(home: string, nowSec: number, idle: boolean, idleSource: IdleSource): IdleExplainer | null {
  if (!consoleBoundaryOk(home)) return null; // CP-3: never write through a redirected console dir chain
  const explainer = buildIdleExplainer({ idle, idleSource, signals: readIdleSignals(home), nowSec });
  writeJsonAtomic(idleExplainerPath(home), explainer);
  return explainer;
}
