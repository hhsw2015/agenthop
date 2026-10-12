/**
 * idle-explainer IO (北极星差距审计件① — idle-root-cause auto-triage). Reads the idle signal (the control-log RUNNING-attempt
 * view) + the four/five "why idle" sources and atomically writes `console/idle-explainer.json`. Mirrors console-projection-store:
 * errno-discriminated reads (FC-2 r3: an UNREADABLE source ⇒ null, never a false zero — INCLUDING per-item faults, which never
 * collapse to a lower-bound zero), a symlink-boundary guard (CP-3), atomic temp+rename, fully fail-soft. The pure shape/rule
 * builders live in idle-explainer.ts. The S19 anomaly alert is raised by the dispatcher (coordinator-SID resolution + delivery).
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadControlLog } from "./control-store.js";
import { liveEntities } from "./control-log.js";
import { reviewQueueDir, parseReviewFileName } from "./review-seat-autoscale.js";
import { listBatchesStrict, readBatch } from "./decision-batch-store.js";
import { ROSTER_FILE } from "./resume.js";
import { buildIdleExplainer, type IdleSignals, type IdleSource, type IdleExplainer } from "./idle-explainer.js";

// --- paths ------------------------------------------------------------------------------------------------------------
function consoleDir(home: string): string { return path.join(home, ".agenthop", "swarm", "console"); }
function idleExplainerPath(home: string): string { return path.join(consoleDir(home), "idle-explainer.json"); }
function controlLogDir(home: string): string { return path.join(home, ".agenthop", "swarm", "control-log"); }
function inboxRoot(home: string): string { return path.join(home, ".agenthop", "inbox"); }
function rosterSnapshotPath(home: string): string { return path.join(home, ".agenthop", "swarm", ROSTER_FILE); }
function consumedMarkerPath(home: string, batchId: string): string { return path.join(home, ".agenthop", "console", "decision-batches", batchId, "consumed.json"); }

/** CP-3 — refuse to write through a pre-existing symlinked console dir. lstat (no-follow): a symlink/non-dir ⇒ false; ENOENT ⇒
 *  not created yet (our mkdir makes a real dir) ⇒ ok; any other fault ⇒ refuse. */
function consoleBoundaryOk(home: string): boolean {
  try { return lstatSync(consoleDir(home)).isDirectory(); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Atomic JSON write (temp + rename), 0o700 dir / 0o600 file. */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Null-safe add: null if either operand is null (an unreadable sub-source taints the sum — FC-2 r3). */
function addN(a: number | null, b: number | null): number | null { return a === null || b === null ? null : a + b; }

// ---------------------------------------------------------------------------------------------------------------------
// Control-log read — ONE pass yields the idle signal (running attempts) + two reason signals (approval-waits, input-waits).
// IE-1: idle is measured from ACTIVE EXECUTION (RUNNING/RESULT_PENDING_VALIDATION attempts), NOT from waits — a `kind:"wait"`
// query-wait or a `kind:"approval"` wait means the member is BLOCKED (herdr idle), so those are REASONS, not activity.
// ---------------------------------------------------------------------------------------------------------------------

export type ControlLogSignals = {
  running: number | null;        // RUNNING/RESULT_PENDING_VALIDATION attempts (active execution); 0 ⇒ idle-this-tick
  approvalWaits: number | null;  // live kind:"approval" waits (awaiting a ruling) — folded into awaitingRuling
  inputWaits: number | null;     // live kind:"wait" waits (awaiting a query/input answer) — the awaitingInput reason
};

/** Read the control-log once, errno-discriminated. A MISSING dir (ENOENT) ⇒ all 0 (confirmed empty swarm-work). Any other stat
 *  fault OR a read fault inside loadControlLog ⇒ all null (UNREADABLE — idle cannot be determined, FC-2 r3). READ-ONLY. */
export function readControlLogSignals(home: string): ControlLogSignals {
  const dir = controlLogDir(home);
  try { statSync(dir); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { running: 0, approvalWaits: 0, inputWaits: 0 } : { running: null, approvalWaits: null, inputWaits: null }; }
  try {
    let running = 0, approvalWaits = 0, inputWaits = 0;
    for (const b of Object.values(liveEntities(loadControlLog(dir)))) {
      if (b.put === "attempt") {
        if (b.attempt.status === "RUNNING" || b.attempt.status === "RESULT_PENDING_VALIDATION") running += 1;
      } else if (b.put === "wait" && b.wait.state !== "resolved") {
        if (b.wait.kind === "approval") approvalWaits += 1; else inputWaits += 1;
      }
    }
    return { running, approvalWaits, inputWaits };
  } catch { return { running: null, approvalWaits: null, inputWaits: null }; } // readable dir but corrupt/unreadable batch ⇒ unknown
}

// --- the "why idle" signals (each number|null, FC-2 r3) ---------------------------------------------------------------

/** Total UNCLAIMED pending work across MEMBER boxes. IE-4: `excludeBoxNames` (the coordinator notice box + the dispatcher's own
 *  box) are skipped so the explainer's own S19 can never feed back in as "pending work". IE-2: strict per-box — a box we cannot
 *  read ⇒ the whole signal is null (never a lower-bound zero). ENOENT root ⇒ 0; any other root readdir fault ⇒ null. A box = a
 *  dir; unclaimed = a top-level `.json` file (a `.json.claim-<pid>` / `.json.tmp-*` / sidecar dir is excluded by the suffix). */
function sumUnclaimedInboxes(home: string, excludeBoxNames: ReadonlySet<string>): number | null {
  let boxes: import("node:fs").Dirent[];
  try { boxes = readdirSync(inboxRoot(home), { withFileTypes: true }); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; }
  let total = 0;
  for (const box of boxes) {
    if (!box.isDirectory() || excludeBoxNames.has(box.name)) continue;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(path.join(inboxRoot(home), box.name), { withFileTypes: true }); }
    catch { return null; } // IE-2: an unreadable box ⇒ unknown total (never swallow to a lower-bound zero)
    for (const f of entries) if (f.isFile() && f.name.endsWith(".json")) total += 1;
  }
  return total;
}

/** Open review-seat queue depth, from the ledger FILENAMES (no content read). ENOENT ⇒ 0; any other readdir fault ⇒ null. */
function reviewQueueDepthSync(home: string): number | null {
  let names: string[];
  try { names = readdirSync(reviewQueueDir(home)); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; }
  let open = 0;
  for (const name of names) { const p = parseReviewFileName(name); if (p && !p.done) open += 1; }
  return open;
}

/** Is this decision batch TERMINAL (consumed)? ENOENT ⇒ false (awaiting). Any other stat fault PROPAGATES to the caller. */
function isConsumed(home: string, batchId: string): boolean {
  try { statSync(consumedMarkerPath(home, batchId)); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/** Decision batches AWAITING a ruling + their hardGate (needs-user) items. READ-ONLY (listBatchesStrict + readBatch + a stat of
 *  consumed.json). IE-2: a GLOBAL enumerate fault OR ANY per-batch uncertainty (a consumed-stat fault, or readBatch ⇒ null =
 *  foreign/corrupt/unreadable) ⇒ BOTH signals null — a skipped batch would make the count a lower-bound, which must NOT be read
 *  as a confirmed zero. Only an enumeration where EVERY batch resolved cleanly yields a confirmed count. */
function decisionBatchAwaitingAndGates(home: string): { awaiting: number | null; userGates: number | null } {
  let ids: string[];
  try { ids = listBatchesStrict(home); }
  catch { return { awaiting: null, userGates: null }; }
  let awaiting = 0;
  let gates = 0;
  for (const id of ids) {
    try {
      if (isConsumed(home, id)) continue; // terminal ⇒ not awaiting
    } catch { return { awaiting: null, userGates: null }; } // IE-2: a consumed-stat fault ⇒ unknown (never a lower-bound)
    const batch = readBatch(home, id);
    if (!batch) return { awaiting: null, userGates: null }; // IE-2: null (foreign/corrupt/unreadable) ⇒ unknown, never skip-to-zero
    awaiting += 1;
    gates += batch.items.filter((it) => it.hardGate === true).length;
  }
  return { awaiting, userGates: gates };
}

/** Member roster size (for the anomaly's "established swarm" gate). ENOENT ⇒ 0; unreadable/corrupt/unrecognized shape ⇒ null. */
export function countRosterMembers(home: string): number | null {
  let raw: string;
  try { raw = readFileSync(rosterSnapshotPath(home), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null; }
  try {
    const snap = JSON.parse(raw) as { members?: unknown };
    return Array.isArray(snap?.members) ? (snap.members as unknown[]).length : null;
  } catch { return null; }
}

/** Read all "why idle" signals. awaitingRuling = decision-batch-awaiting + control-log approval-waits (null-safe). awaitingInput
 *  = control-log input-waits. unclaimedInboxes excludes the coordinator/self boxes (IE-4). Each independently FC-2 r3. READ-ONLY. */
export function readIdleSignals(home: string, excludeBoxNames: ReadonlySet<string>, cl: ControlLogSignals): IdleSignals {
  const { awaiting, userGates } = decisionBatchAwaitingAndGates(home);
  return {
    unclaimedInboxes: sumUnclaimedInboxes(home, excludeBoxNames),
    reviewQueueDepth: reviewQueueDepthSync(home),
    awaitingRuling: addN(awaiting, cl.approvalWaits), // decision batches + live approval-waits (IE-1)
    awaitingInput: cl.inputWaits,                      // live query/input waits (IE-1)
    userGates,
  };
}

/** Build the projection, atomically write `console/idle-explainer.json`, return it (or null when CP-3 skips the write). `idle` +
 *  `idleSource` + `swarmEstablished` + `signals` are computed by the dispatcher (which owns the N-tick streak + the control-log
 *  read). Fail-soft is the caller's wrap. */
export function writeIdleExplainer(home: string, nowSec: number, idle: boolean, idleSource: IdleSource, swarmEstablished: boolean, signals: IdleSignals): IdleExplainer | null {
  if (!consoleBoundaryOk(home)) return null; // CP-3
  const explainer = buildIdleExplainer({ idle, idleSource, swarmEstablished, signals, nowSec });
  writeJsonAtomic(idleExplainerPath(home), explainer);
  return explainer;
}
