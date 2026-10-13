/**
 * verification-ledger — IO layer (econ-mirror-21 candidate ③). Reads the record surfaces READ-ONLY, each with FC-2 three-state
 * (read / unreadable / absent — an EACCES or a corrupt log is NEVER silently "no accepted changes"). NOTHING here writes to the
 * control-log, rulings, or any durable swarm account — the only output is the coordinator-inbox DRAFT the CLI composes (R16).
 *
 * The control-log is loaded ONCE and projected (by the pure extractor) into accepted / attempt / rejected inputs. The review-report
 * rounds (a SEPARATE, non-joined view) reuse retro-store's reader + retro's reworkRoundDist, and FORWARD its `complete` flag (VL-4:
 * a per-item stat fault makes status "read" but complete=false — a partial scan must NOT render as a complete zero distribution).
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { loadControlLog } from "./control-store.js";
import { liveEntities } from "./control-log.js";
import { reviewReportsDir, readReviewRoundRecords } from "./retro-store.js";
import { reworkRoundDist, type ReworkDist, type SourceStatus } from "./retro.js";
import { extractLedgerInputs, type LedgerInputs } from "./verification-ledger.js";

function controlLogDir(home: string): string { return path.join(home, ".agenthop", "swarm", "control-log"); }

/**
 * Project the control-log into ledger inputs (ONE load). FC-2: ENOENT dir ⇒ absent; EACCES/other readdir fault OR a corrupt log
 * (loadControlLog throws) ⇒ unreadable — NEVER an empty accepted set. Pure-IO (no writes).
 */
export function readLedgerInputs(home: string): { inputs: LedgerInputs; status: SourceStatus } {
  // readdir three-state first (ENOENT⇒absent, EACCES⇒unreadable) — not existsSync (TOCTOU + treats EACCES as "gone").
  try { readdirSync(controlLogDir(home)); }
  catch (e) { return { inputs: { accepted: [], attempts: [], rejections: [] }, status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
  let state;
  try { state = loadControlLog(controlLogDir(home)); }
  catch { return { inputs: { accepted: [], attempts: [], rejections: [] }, status: "unreadable" }; }
  return { inputs: extractLedgerInputs(Object.values(liveEntities(state))), status: "read" };
}

/**
 * The SEPARATE review-report-rounds view (by ticket-NAME; reused from retro). FC-2 + VL-4 completeness forwarded from
 * readReviewRoundRecords: an unreadable/absent dir ⇒ dist=null + the real status; a `read` scan that was NOT complete (a per-item
 * stat faulted) ⇒ dist built from what was read, but `complete:false` so the caller can mark it a lower bound (never a complete zero).
 * `homeForUser` is the user home (the dir lives OUTSIDE the agenthop home, ~/Work/review-reports, overridable via RETRO_REVIEW_REPORTS_DIR).
 */
export function readReviewRoundsDist(homeForUser: string, sinceSec: number | null = null): { dist: ReworkDist | null; status: SourceStatus; complete: boolean } {
  const { records, status, complete } = readReviewRoundRecords(reviewReportsDir(homeForUser), sinceSec);
  if (status !== "read") return { dist: null, status, complete };
  return { dist: reworkRoundDist(records), status, complete };
}
