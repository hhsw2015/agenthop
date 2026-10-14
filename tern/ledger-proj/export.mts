/**
 * export.mts — IO shell for the review-ledger SQLite projection (tern-adoption line ③ B3). The ONE write face for
 * ~/.agenthop/carly/ledger.db (contract §3 writable domain). Reads the structured sources READ-ONLY via ledger-sources
 * (review-queue ledger + review-report rounds + git log), hands them to the pure core (ledger-core.ts) for the
 * deterministic SQL, builds a FRESH temp db via the `sqlite3` CLI, then atomically renames it over ledger.db.
 *
 * FC-2 preserve-good-db (B3-FC2, r2): an UNREADABLE review-queue source throws in readReviewQueueStrict — BEFORE any
 * buildAndPublish — so the previous good db is left intact (never clobbered by an empty/default export).
 *
 * Concurrency (contract §3: "并发写未验 ⇒ v1 规避而非解决"): the SOLE writer is this script (cron/manual). We do NOT
 * claim two-writer safety; the property we DO guarantee is that Tern (read-only reader) never sees a torn db — the
 * atomic rename publishes a COMPLETE db (old or new, never half).
 *
 * Run: packages/bus/node_modules/.bin/tsx tern/ledger-proj/export.mts
 * Env: AH_HOME (agenthop home; default ~), RETRO_REVIEW_REPORTS_DIR (review-reports; default ~/Work/review-reports),
 *      TERN_LEDGER_REPO (git repo for batches; default this file's repo), TERN_LEDGER_GIT_REF (default "main").
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reviewQueueDir } from "../../packages/bus/src/swarm/review-seat-autoscale.js";
import { readReviewRoundRecords, reviewReportsDir } from "../../packages/bus/src/swarm/retro-store.js";
import { reworkRoundDist } from "../../packages/bus/src/swarm/retro.js";
import { assembleReviewRows, parseGitBatches, buildLedgerSql } from "./ledger-core.js";
import { buildAndPublish } from "./ledger-io.js";
import { readReviewQueueStrict, readGitLog } from "./ledger-sources.js";

function ledgerDbPath(home: string): string { return path.join(home, ".agenthop", "carly", "ledger.db"); }

function main(): void {
  const home = process.env.AH_HOME || homedir();
  const userHome = homedir();
  const repo = process.env.TERN_LEDGER_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const ref = process.env.TERN_LEDGER_GIT_REF || "main";

  // reviews source: the autoscale review-queue ledger (coordinator ruling A). STRICT FC-2 — an unreadable source throws
  // here, BEFORE buildAndPublish, so the last good db is preserved (B3-FC2 fix).
  const reviews = readReviewQueueStrict(reviewQueueDir(home));

  // rounds supplement: retro reworkRoundDist by ticket. Absent/unreadable review-reports ⇒ status != "read" ⇒ rounds null
  // (an unknown round count is honest and does NOT justify failing the whole export — the review rows are still valid).
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

// Run only when invoked directly (not when imported by a selftest).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (e) { process.stderr.write(`ledger-export: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
}
