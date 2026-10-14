/**
 * ledger-sources.ts — the READ-ONLY source readers for the B3 export (tern-adoption line ③). Kept out of the CLI shell
 * so they are unit-testable. Each reader is FC-2 honest: an UNREADABLE source is never silently degraded to empty.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseReviewFileName } from "../../packages/bus/src/swarm/review-seat-autoscale.js";
import type { ReviewInput, GitLogEntry } from "./ledger-core.js";

/**
 * Read the review-queue ledger with STRICT FC-2 three-state (B3-FC2 fix, r2). The reviews table's row existence comes
 * from here, so an UNREADABLE source must NOT degrade to an empty export that clobbers the last good db:
 *  - ENOENT dir ⇒ absent ⇒ [] (legitimately no reviews yet — an empty reviews table is honest).
 *  - any other readdir fault (EACCES/EIO/…) ⇒ THROW ⇒ the shell aborts BEFORE publishing ⇒ the previous good db stays.
 *  - a per-record read fault or malformed JSON ⇒ THROW (never silently default to empty sha / ts=0).
 * A valid record missing an optional field keeps the legacy default ("" / 0) — that is a data state, not a read fault.
 */
export function readReviewQueueStrict(dir: string): ReviewInput[] {
  let names: string[];
  try { names = readdirSync(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // absent: no reviews yet
    throw new Error(`review-queue unreadable (${(e as Error).message}) — refusing to publish an empty ledger over the last good one`);
  }
  const out: ReviewInput[] = [];
  for (const name of names.sort()) {
    const parsed = parseReviewFileName(name);
    if (!parsed) continue; // not a review file (e.g. a .tmp) — skip, as readReviewLedger does
    let raw: string;
    try { raw = readFileSync(path.join(dir, name), "utf8"); }
    catch (e) { throw new Error(`review-queue record unreadable (${name}: ${(e as Error).message}) — refusing to publish`); }
    let meta: { author?: string; sha?: string; sentSec?: number };
    try { meta = JSON.parse(raw) as typeof meta; }
    catch { throw new Error(`review-queue record malformed JSON (${name}) — refusing to publish`); }
    out.push({ sha: meta.sha ?? "", item: parsed.ticket, seat: parsed.seat, ts: meta.sentSec ?? 0 });
  }
  return out;
}

/** git log of the batch ref → structured entries for parseGitBatches. A git failure degrades to [] (⇒ empty batches,
 *  contract-allowed) with a stderr warning — never crashes the whole export (batches are secondary to reviews). */
export function readGitLog(repo: string, ref: string): GitLogEntry[] {
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
