/**
 * ledger-sources.ts — the READ-ONLY source readers for the B3 export (tern-adoption line ③). Kept out of the CLI shell
 * so they are unit-testable. Each reader is FC-2 honest: an UNREADABLE source is never silently degraded to empty.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseReviewFileName } from "../../packages/bus/src/swarm/review-seat-autoscale.js";
import type { ReviewInput, GitLogEntry } from "./ledger-core.js";

/** Validate a parsed review-queue record by RUNTIME SHAPE (B3-P2 fix, r3 — JSON.parse + a TS assertion is not
 *  validation). A record is `{sha:string, sentSec:number}` as markReviewOpen writes it (sha may be "" — a review opened
 *  without a sha is a legit data state). A non-object (`[]`, a string), a non-string sha (`{"sha":{...}}` ⇒ would render
 *  "[object Object]"), or a non-finite sentSec ⇒ null (corrupt carrier). Pure. */
function validReviewMeta(v: unknown): { sha: string; sentSec: number } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.sha !== "string") return null;
  if (typeof o.sentSec !== "number" || !Number.isFinite(o.sentSec)) return null;
  return { sha: o.sha, sentSec: o.sentSec };
}

/**
 * Read the review-queue ledger with STRICT FC-2 three-state (B3-FC2 fix, r2+r3). The reviews table's row existence comes
 * from here, so an UNREADABLE or CORRUPT source must NOT degrade to an empty/garbage export that clobbers the last good db:
 *  - ENOENT dir ⇒ absent ⇒ [] (legitimately no reviews yet — an empty reviews table is honest).
 *  - any other readdir fault (EACCES/EIO/…) ⇒ THROW ⇒ the shell aborts BEFORE publishing ⇒ the previous good db stays.
 *  - a per-record read fault, malformed JSON, OR a wrong-shape record ⇒ THROW (never default to empty sha / ts=0, and
 *    never let a non-string sha reach the db as "[object Object]"). Fail-closed = preserve the good db, same discipline as
 *    the morning-digest/v1 validator (a corrupt carrier is stated, never silently normalized).
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
    const fn = parseReviewFileName(name);
    if (!fn) continue; // not a review file (e.g. a .tmp) — skip, as readReviewLedger does
    let raw: string;
    try { raw = readFileSync(path.join(dir, name), "utf8"); }
    catch (e) { throw new Error(`review-queue record unreadable (${name}: ${(e as Error).message}) — refusing to publish`); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error(`review-queue record malformed JSON (${name}) — refusing to publish`); }
    const meta = validReviewMeta(parsed);
    if (!meta) throw new Error(`review-queue record wrong shape (${name}: need {sha:string, sentSec:number}) — refusing to publish`);
    out.push({ sha: meta.sha, item: fn.ticket, seat: fn.seat, ts: meta.sentSec });
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
