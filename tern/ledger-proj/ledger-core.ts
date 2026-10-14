/**
 * ledger-core — PURE core of the verification/review ledger SQLite projection (tern-adoption line ③ B3, contract
 * docs/swarm/tern-batch2-contracts.md §3 @1e0f860). No fs, no clock, no child_process: given already-read inputs it
 * produces the EXACT deterministic SQL text that the IO shell (export.mts) pipes to the `sqlite3` CLI. Decoupled on
 * purpose (resume.ts PeerLike discipline): it defines its OWN minimal input shapes instead of importing the bus
 * readers, so it stays cherry-pickable and selftests with zero bus dependency.
 *
 * Contract-frozen schema (NOT changed here):
 *   reviews(sha TEXT, item TEXT, seat TEXT, rounds INT, outcome TEXT, usd REAL, ts INT);  -- outcome/usd v1 ALWAYS NULL
 *   batches(batch TEXT, shas TEXT, merged_ts INT);                                        -- git-derived (this impl)
 *
 * Honesty (coordinator ruling A, verification-ledger discipline): `outcome` and `usd` have NO structured source in v1,
 * so they are emitted as SQL NULL — an explicit "unknown", NEVER a fabricated join or a 0 read as "cheap". `rounds` is
 * NULL when the ticket has no review-report round record (absent/unreadable source ⇒ unknown, not 0).
 *
 * Determinism (acceptance: rerun ⇒ same bytes): every row set is TOTALLY ordered (all columns as tiebreakers, no ties),
 * the whole build is ONE transaction (a single change-counter bump), and a fixed page_size/encoding are pinned before
 * table creation. Same inputs + same sqlite3 binary ⇒ byte-identical db.
 */

/** One review event from the autoscale review-queue ledger (coordinator ruling A: that is the structured source). */
export interface ReviewInput {
  sha: string; // the reviewed commit (hex); "" when the ledger record had none
  item: string; // the ticket name (review-queue `item`)
  seat: string; // the review seat id
  ts: number; // sentSec — when the review was opened
}

/** A review row as it lands in the `reviews` table. outcome/usd are v1-NULL (no structured source); rounds may be null. */
export interface ReviewRow {
  sha: string;
  item: string;
  seat: string;
  rounds: number | null; // from retro reworkRoundDist by ticket; null when the ticket has no round record (unknown ≠ 0)
  outcome: null; // v1: always NULL (no structured source; candidate: review-current index)
  usd: null; // v1: always NULL (no joinable cost; candidate: tasklog account)
  ts: number;
}

/** A batch row (git-derived): one per rehearse-batch-N, with the feature shas merged into it and its merge/artifact time. */
export interface BatchRow {
  batch: string; // "batch-N"
  shas: string; // comma-joined sorted unique feature shas merged into the batch
  merged_ts: number; // the batch's artifact-regen commit time if present, else the latest merge time
}

/** A single `git log` entry the shell feeds in (`--format=%ct%x09%s`), parsed to {commitTimeSec, subject}. */
export interface GitLogEntry { commitTimeSec: number; subject: string; }

/**
 * Join the review-queue records with per-ticket round counts into deterministic ReviewRows. One row per queue record
 * (a review event). `roundsByTicket` comes from retro's reworkRoundDist (distinct review shas per ticket); a ticket
 * absent from the map ⇒ rounds null (unknown, never 0). outcome/usd are v1-NULL. Pure; input arrays are not mutated.
 */
export function assembleReviewRows(records: readonly ReviewInput[], roundsByTicket: ReadonlyMap<string, number>): ReviewRow[] {
  const rows = records.map((r): ReviewRow => ({
    sha: r.sha,
    item: r.item,
    seat: r.seat,
    rounds: roundsByTicket.has(r.item) ? roundsByTicket.get(r.item)! : null,
    outcome: null,
    usd: null,
    ts: r.ts,
  }));
  // Total order (no ties): ts, then item, seat, sha — a stable, content-only order so rerun emits identical bytes.
  return rows.sort((a, b) => a.ts - b.ts || cmp(a.item, b.item) || cmp(a.seat, b.seat) || cmp(a.sha, b.sha));
}

const MERGE_RE = /Merge\s+.*\s+into\s+rehearse-batch-(\d+)\b.*?@([0-9a-f]{7,40})/i;
const ARTIFACT_RE = /regenerate presence artifacts for batch-(\d+)\b/i;

/**
 * Derive batch rows from `git log` entries (structured, NOT heuristic free-text — the merge/artifact subjects are a
 * controlled format). A merge commit `Merge <x> into rehearse-batch-N (dual-cleared @<sha>)` contributes <sha> to
 * batch-N; an artifact commit `regenerate presence artifacts for batch-N` sets batch-N's merged_ts. A batch with merges
 * but no artifact commit falls back to its latest merge time. Batches with neither a parsable merge nor shas are dropped
 * (an artifact-only batch-N with no merge has no shas to record). Pure; deterministic order (batch number ascending).
 */
export function parseGitBatches(entries: readonly GitLogEntry[]): BatchRow[] {
  const shasByN = new Map<number, Set<string>>();
  const latestMergeTs = new Map<number, number>();
  const artifactTs = new Map<number, number>();
  for (const e of entries) {
    const m = MERGE_RE.exec(e.subject);
    if (m) {
      const n = Number(m[1]);
      if (!shasByN.has(n)) shasByN.set(n, new Set());
      shasByN.get(n)!.add(m[2]!.toLowerCase());
      latestMergeTs.set(n, Math.max(latestMergeTs.get(n) ?? 0, e.commitTimeSec));
      continue;
    }
    const a = ARTIFACT_RE.exec(e.subject);
    if (a) {
      const n = Number(a[1]);
      // the LATEST artifact commit for a batch wins its merged_ts (a re-regen supersedes)
      artifactTs.set(n, Math.max(artifactTs.get(n) ?? 0, e.commitTimeSec));
    }
  }
  const rows: BatchRow[] = [];
  for (const [n, shas] of shasByN) {
    rows.push({
      batch: `batch-${n}`,
      shas: [...shas].sort().join(","),
      merged_ts: artifactTs.get(n) ?? latestMergeTs.get(n)!, // artifact time preferred; else latest merge (always set here)
    });
  }
  return rows.sort((x, y) => batchNum(x.batch) - batchNum(y.batch));
}

/** Build the full deterministic SQL text (pure). One transaction ⇒ one change-counter bump ⇒ byte-stable db on rerun. */
export function buildLedgerSql(reviews: readonly ReviewRow[], batches: readonly BatchRow[]): string {
  const out: string[] = [];
  // page_size/encoding pinned BEFORE any table exists (they fix the db creation; outside the explicit transaction).
  out.push("PRAGMA page_size=4096;");
  out.push("PRAGMA encoding='UTF-8';");
  out.push("BEGIN;");
  out.push("CREATE TABLE reviews(sha TEXT, item TEXT, seat TEXT, rounds INT, outcome TEXT, usd REAL, ts INT);");
  out.push("CREATE TABLE batches(batch TEXT, shas TEXT, merged_ts INT);");
  for (const r of reviews) {
    out.push(`INSERT INTO reviews VALUES(${q(r.sha)},${q(r.item)},${q(r.seat)},${numOrNull(r.rounds)},NULL,NULL,${intLit(r.ts)});`);
  }
  for (const b of batches) {
    out.push(`INSERT INTO batches VALUES(${q(b.batch)},${q(b.shas)},${intLit(b.merged_ts)});`);
  }
  out.push("COMMIT;");
  return out.join("\n") + "\n";
}

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function batchNum(batch: string): number { const m = /^batch-(\d+)$/.exec(batch); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; }
/** SQL single-quoted string literal, single-quotes doubled (the only escape SQLite string literals need). */
function q(s: string): string { return `'${String(s).replace(/'/g, "''")}'`; }
function numOrNull(n: number | null): string { return n === null ? "NULL" : intLit(n); }
/** Integer literal; a non-finite/NaN value degrades to NULL rather than emitting invalid SQL. */
function intLit(n: number): string { return Number.isFinite(n) ? String(Math.trunc(n)) : "NULL"; }
