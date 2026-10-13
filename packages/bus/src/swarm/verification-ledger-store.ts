/**
 * verification-ledger — IO layer (econ-mirror-21 candidate ③). Reads the record surfaces READ-ONLY, each with FC-2 three-state
 * (read / unreadable / absent — an EACCES or a corrupt log is NEVER silently "no accepted changes"). NOTHING here writes to the
 * control-log, rulings, or any durable swarm account — the only output is the coordinator-inbox DRAFT the CLI composes (R16).
 *
 * The control-log is loaded ONCE and projected into both halves of the reliable metric:
 *   - accepted changes  (put:"accepted" → AcceptedResult, nodeId-keyed, carries the supersede flag);
 *   - rework counters   (put:"attempt" / put:"rejected" tallied by nodeId).
 * The review-report rounds (a SEPARATE, non-joined view) reuse retro-store's reader + retro's reworkRoundDist — not duplicated.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { loadControlLog } from "./control-store.js";
import { liveEntities } from "./control-log.js";
import { reviewReportsDir, readReviewRoundRecords } from "./retro-store.js";
import { reworkRoundDist, type ReworkDist, type SourceStatus } from "./retro.js";
import { extractLedgerInputs, type AcceptedChange, type ReworkByNode } from "./verification-ledger.js";

function controlLogDir(home: string): string { return path.join(home, ".agenthop", "swarm", "control-log"); }

/**
 * Project the control-log into accepted changes + per-node rework counters (ONE load). FC-2: ENOENT dir ⇒ absent; EACCES/other
 * readdir fault OR a corrupt log (loadControlLog throws) ⇒ unreadable — NEVER an empty accepted set. Pure-IO (no writes).
 */
export function readAcceptedAndRework(home: string): { accepted: AcceptedChange[]; rework: ReworkByNode; status: SourceStatus } {
  // readdir three-state first (ENOENT⇒absent, EACCES⇒unreadable) — not existsSync (TOCTOU + treats EACCES as "gone").
  try { readdirSync(controlLogDir(home)); }
  catch (e) { return { accepted: [], rework: {}, status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
  let state;
  try { state = loadControlLog(controlLogDir(home)); }
  catch { return { accepted: [], rework: {}, status: "unreadable" }; }
  const { accepted, rework } = extractLedgerInputs(Object.values(liveEntities(state)));
  return { accepted, rework, status: "read" };
}

/**
 * The SEPARATE review-report-rounds view (by ticket-NAME; reused from retro). FC-2 forwarded from readReviewRoundRecords: an
 * unreadable/absent dir ⇒ dist=null + the real status (NEVER a zero-round dist). `homeForUser` is the user home (the dir lives
 * OUTSIDE the agenthop home, ~/Work/review-reports, overridable via RETRO_REVIEW_REPORTS_DIR).
 */
export function readReviewRoundsDist(homeForUser: string, sinceSec: number | null = null): { dist: ReworkDist | null; status: SourceStatus } {
  const { records, status } = readReviewRoundRecords(reviewReportsDir(homeForUser), sinceSec);
  if (status !== "read") return { dist: null, status };
  return { dist: reworkRoundDist(records), status };
}
