/**
 * export.mts — IO shell for the review-ledger SQLite projection (tern-adoption line ③ B3). The ONE write face for
 * ~/.agenthop/carly/ledger.db (contract §3 writable domain). Reads the structured sources READ-ONLY (review-queue
 * ledger + review-report rounds + git log), hands them to the pure core (ledger-core.ts) for the deterministic SQL,
 * builds a FRESH temp db via the `sqlite3` CLI, then atomically renames it over ledger.db.
 *
 * Concurrency (contract §3: "并发写未验 ⇒ v1 规避而非解决"): the SOLE writer is this script (cron/manual). We do NOT
 * claim two-writer safety; the property we DO guarantee is that Tern (read-only reader) never sees a torn db — the
 * atomic rename publishes a COMPLETE db (old or new, never half). The temp is O_EXCL-claimed (atomic-write-ownership:
 * a random suffix is not ownership) so a stale/foreign temp is never silently filled or truncated.
 *
 * Run: packages/bus/node_modules/.bin/tsx tern/ledger-proj/export.mts
 * Env: AH_HOME (agenthop home; default ~), RETRO_REVIEW_REPORTS_DIR (review-reports; default ~/Work/review-reports),
 *      TERN_LEDGER_REPO (git repo for batches; default this file's repo), TERN_LEDGER_GIT_REF (default "main").
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReviewLedger, reviewQueueDir } from "../../packages/bus/src/swarm/review-seat-autoscale.js";
import { readReviewRoundRecords, reviewReportsDir } from "../../packages/bus/src/swarm/retro-store.js";
import { reworkRoundDist } from "../../packages/bus/src/swarm/retro.js";
import { assembleReviewRows, parseGitBatches, buildLedgerSql, type ReviewInput, type GitLogEntry } from "./ledger-core.js";
import { buildAndPublish } from "./ledger-io.js";

function ledgerDbPath(home: string): string { return path.join(home, ".agenthop", "carly", "ledger.db"); }

/** git log of the batch ref → structured entries for parseGitBatches. A git failure degrades to [] (⇒ empty batches,
 *  contract-allowed) with a stderr warning — never crashes the whole export. */
function readGitLog(repo: string, ref: string): GitLogEntry[] {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repo, "log", ref, "--format=%ct%x09%s"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    process.stderr.write(`ledger-export: git log failed (${(e as Error).message}) ⇒ batches empty\n`);
    return [];
  }
  const entries: GitLogEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ct = Number(line.slice(0, tab));
    if (!Number.isFinite(ct)) continue;
    entries.push({ commitTimeSec: ct, subject: line.slice(tab + 1) });
  }
  return entries;
}

async function main(): Promise<void> {
  const home = process.env.AH_HOME || homedir();
  const userHome = homedir();
  const repo = process.env.TERN_LEDGER_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const ref = process.env.TERN_LEDGER_GIT_REF || "main";

  // reviews source: the autoscale review-queue ledger (coordinator ruling A). readReviewLedger is FC-2 (missing ⇒ []).
  const ledger = await readReviewLedger(reviewQueueDir(home));
  const reviews: ReviewInput[] = ledger.map((r) => ({ sha: r.sha, item: r.ticket, seat: r.seat, ts: r.sentSec }));

  // rounds supplement: retro reworkRoundDist by ticket. Absent/unreadable review-reports ⇒ status != "read" ⇒ rounds null.
  const { records: roundRecords, status: rrStatus } = readReviewRoundRecords(reviewReportsDir(userHome));
  const roundsByTicket = new Map<string, number>();
  if (rrStatus === "read") for (const t of reworkRoundDist(roundRecords).perTicket) roundsByTicket.set(t.ticket, t.rounds);

  const reviewRows = assembleReviewRows(reviews, roundsByTicket);
  const batchRows = parseGitBatches(readGitLog(repo, ref));
  const sql = buildLedgerSql(reviewRows, batchRows);
  const dest = ledgerDbPath(home);
  buildAndPublish(dest, sql);
  const size = statSync(dest).size;
  process.stdout.write(`ledger-export: wrote ${dest} (${reviewRows.length} reviews, ${batchRows.length} batches, ${size}B; rounds source ${rrStatus})\n`);
}

main().catch((e) => { process.stderr.write(`ledger-export: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
