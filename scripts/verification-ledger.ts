#!/usr/bin/env tsx
/**
 * verification-ledger — the read-only cost-per-accepted-change projection (econ-mirror-21 candidate ③; coordinator-greenlit after
 * the eval 闭卷 @648aea8). Thin IO shell over the pure core (verification-ledger.ts) + the store (verification-ledger-store.ts).
 *
 * It reads the in-repo review RECORD (control-log accepted/attempt/rejected) + the SEPARATE review-report-rounds view, renders a COST
 * (not ROI) report, and DRAFTS it to the coordinator inbox. It NEVER spends, acts, or writes to control-log / rulings — the only side
 * effect is the durable coordinator draft (publishOnce-keyed by the report's content tag ⇒ a re-run dedups). SWARM_VERIFICATION_LEDGER
 * gates the auto/live path (opt-in OFF, dormant); a manual run works regardless and says so.
 *
 * Obligation model (账随实走): the exit code reflects UNMET obligations. A control-log that is unreadable, or a coordinator delivery
 * that is not confirmed, ⇒ exit 1. --dry prints the report and never delivers (exit 0). VL-5: --days filters ONLY the review-report
 * mtime window; the control-log is always the full current projection, and the report labels both ranges.
 *
 *   tsx scripts/verification-ledger.ts [--threshold N] [--days N] [--coordinator <sid>] [--dry]
 */
import { homedir } from "node:os";
import { writeInbox, composeInboxMsg } from "../packages/bus/src/inbox.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import {
  verificationLedgerEnabled, parseLedgerArgs, costPerAcceptedChange, summarizeLedger, renderLedgerReport, ledgerReportTag,
} from "../packages/bus/src/swarm/verification-ledger.js";
import { readLedgerInputs, readReviewRoundsDist } from "../packages/bus/src/swarm/verification-ledger-store.js";

const nowSec = () => Math.floor(Date.now() / 1000);
function home(): string { return process.env.AH_HOME ?? homedir(); }

const USAGE = `usage: verification-ledger [--threshold N] [--days N] [--coordinator <sid>] [--dry]`;

async function main(): Promise<number> {
  const ns = nowSec();
  const args = parseLedgerArgs(process.argv.slice(2), ns);
  if (!args) { console.error(USAGE); return 2; }
  const H = home();
  if (!verificationLedgerEnabled()) console.log(`verification-ledger: SWARM_VERIFICATION_LEDGER off (dormant) — manual run, no auto path.`);

  // READ (FC-2 three-state, no writes).
  const cl = readLedgerInputs(H);
  const rr = readReviewRoundsDist(H, args.sinceSec);
  const reviewWindowDays = args.sinceSec != null ? Math.round((ns - args.sinceSec) / 86400) : null;

  const cpac = costPerAcceptedChange(cl.inputs);
  const summary = summarizeLedger(cpac, args.threshold);
  const report = renderLedgerReport({
    summary, reviewRounds: rr.dist,
    sources: { controlLog: cl.status, reviewReports: rr.status, reviewReportsComplete: rr.complete },
    reviewWindowDays, threshold: args.threshold,
  });
  console.log(report);

  const outstanding: string[] = [];
  if (cl.status === "unreadable") outstanding.push("control-log:unreadable"); // the reliable metric could not be computed — never a silent zero

  if (args.dry) {
    if (outstanding.length > 0) { console.error(`verification-ledger: ${outstanding.length} outstanding (dry run, not delivered): ${outstanding.join("; ")}`); return 1; }
    return 0;
  }

  const coordRef = args.coordinator ?? process.env.SWARM_COORDINATOR ?? "";
  if (!coordRef) {
    console.log(`verification-ledger: SWARM_COORDINATOR unset — report to stdout only (no delivery obligation).`);
  } else {
    const coordSid = resolveSession(coordRef, listSessions(H));
    if (!coordSid) { console.error(`verification-ledger: coordinator '${coordRef}' did not resolve to a live SID — NOT writing a bare-handle box.`); outstanding.push(`coordinator-delivery:unresolved(${coordRef})`); }
    else {
      try {
        const r = writeInbox(H, coordSid, composeInboxMsg({ from: "verification-ledger", fromLabel: "swarm-verification-ledger", text: report, via: "verification-ledger", intent: "report" }), `verification-ledger-${ledgerReportTag(report)}`);
        console.log(`verification-ledger draft -> coordinator ${coordSid}: ${r}`);
        if (r !== "published" && r !== "already") outstanding.push(`coordinator-delivery:${r}`);
      } catch (e) { console.error(`verification-ledger: coordinator delivery FAILED: ${(e as Error).message}`); outstanding.push("coordinator-delivery:failed"); }
    }
  }

  if (outstanding.length > 0) { console.error(`verification-ledger: ${outstanding.length} outstanding (re-run to retry): ${outstanding.join("; ")}`); return 1; }
  return 0;
}

if (process.argv[1] && /(^|\/)verification-ledger\.ts$/.test(process.argv[1])) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
