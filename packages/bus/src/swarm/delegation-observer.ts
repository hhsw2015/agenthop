/**
 * Durable-state observer (cluster-liveness L2-struct, design §2b-c / §2c + the coordinator's watch-list expansion, user+F25).
 * The one place that turns "a durable surface changed but nobody was told" into a pushed event — F22/F25 same-family root-fix.
 * It watches:
 *   1. completion-slot locators (§2c): for each PRODUCTION-phase delegation, poll its locator; a discovered artifact becomes a
 *      Candidate the caller verifies via observeCandidate (independent of the producer messaging anyone — the F22 root-fix).
 *   2. the work board ~/.agenthop/swarm/board/ (.claimed./.done. renames) + PROGRESS.md (mtime): a change is itself an event —
 *      pushed to the coordinator inbox immediately, not left for the next patrol tick.
 *
 * Pure here (scan/diff over injected reads); the IO (fs scan + hashing + the wait commits + the coordinator inbox write) is the
 * dispatcher wiring. The snapshot is an IO-owned file, so events fire only on CHANGE (not every tick).
 */

import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DelegationRegistry, Candidate, CompletionRecord } from "./delegation-envelope.js";
import type { IncidentSignal } from "./incident-episode.js";

/** What the IO reader returns for a locator that currently holds an artifact: its content digest + the completion record the
 *  artifact self-declares (§2b). null = nothing there yet. The reader (fs + hash + parse) is the dispatcher's; injected for tests. */
export type ArtifactRead = { observedDigest: string; record: CompletionRecord } | null;
export type ReadArtifact = (locator: string) => ArtifactRead;

/** Scan every PRODUCTION-phase delegation's completion-slot locator; emit a Candidate for each locator that currently holds an
 *  artifact. The caller verifies each via observeCandidate (locator + targetDigest + record identity) before closing anything. */
export function scanCompletionSlots(reg: DelegationRegistry, read: ReadArtifact): Candidate[] {
  const out: Candidate[] = [];
  for (const env of Object.values(reg.envelopes)) {
    if (env.phase !== "production") continue;
    const a = read(env.completionSlot.locator);
    if (a === null) continue;
    out.push({ observedLocator: env.completionSlot.locator, observedDigest: a.observedDigest, record: a.record });
  }
  return out;
}

/** Parse a completion-record artifact (v1 lightweight adapter, §2c). The record DECLARES its WORK TARGET (the commit/spec it
 *  produced); observedDigest = that declared workTarget, in the SAME domain as the completion-slot's targetDigest — a file-content
 *  hash is NOT the work target and never equals a commit SHA (review f0a999f-P1-1: comparing domains ⇒ a legit result never
 *  verifies). NULL-SAFE: a null / non-object / field-incomplete record ⇒ null, never a throw (review f0a999f-P2-1: one bad
 *  artifact must not abort the scan or the board watch). v1's target fact is the record's self-declared workTarget; INDEPENDENT
 *  resolution (git rev-parse) + content integrity are the deferred real-adapter acceptance (documented, not faked). */
export function parseCompletionArtifact(raw: string): ArtifactRead {
  let rec: unknown;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (rec === null || typeof rec !== "object") return null;
  const r = rec as { requestId?: unknown; payloadDigest?: unknown; workTarget?: unknown; subject?: unknown };
  if (typeof r.requestId !== "string" || typeof r.payloadDigest !== "string" || typeof r.workTarget !== "string") return null;
  if (r.subject === null || typeof r.subject !== "object") return null;
  const s = r.subject as { jobId?: unknown; revision?: unknown };
  if (typeof s.jobId !== "string") return null;
  return { observedDigest: r.workTarget, record: { requestId: r.requestId, payloadDigest: r.payloadDigest, subject: { jobId: s.jobId, ...(typeof s.revision === "number" ? { revision: s.revision } : {}) } } };
}

/** A board-file name parses to {item, state, who}. Convention: `<item>.<state>.<who>.json` (state ∈ claimed/done) or
 *  `<item>.json` (posted/unclaimed). Items are kebab-case (no dots); the LAST two dot-segments are state+who. */
export function parseBoardFile(file: string): { item: string; state: string; who: string } | null {
  if (!file.endsWith(".json")) return null;
  const name = file.slice(0, -".json".length);
  const segs = name.split(".");
  if (segs.length === 1) return { item: segs[0]!, state: "posted", who: "" };
  if (segs.length >= 3) return { item: segs.slice(0, segs.length - 2).join("."), state: segs[segs.length - 2]!, who: segs[segs.length - 1]! };
  return { item: segs[0]!, state: segs[1]!, who: "" }; // 2 segments: <item>.<state>
}

/** The watched durable surfaces at one instant: the set of board file names + PROGRESS.md's mtime. */
export type WatchSnapshot = { boardFiles: string[]; progressMtimeMs: number };
export const emptyWatchSnapshot = (): WatchSnapshot => ({ boardFiles: [], progressMtimeMs: 0 });

export type WatchEvent =
  | { kind: "board"; file: string; item: string; state: string; who: string }
  | { kind: "progress"; mtimeMs: number };

/** Diff two snapshots into events. A board file PRESENT in curr but not prev is a change (a rename lands as a new name — the new
 *  name carries the new state, so one event per newly-seen file suffices; a vanished old name needs no separate event). A changed
 *  PROGRESS mtime is one event. Pure; the caller pushes each event to the coordinator inbox and persists curr. */
export function detectWatchEvents(prev: WatchSnapshot, curr: WatchSnapshot): WatchEvent[] {
  const events: WatchEvent[] = [];
  const prevSet = new Set(prev.boardFiles);
  for (const f of curr.boardFiles) {
    if (prevSet.has(f)) continue;
    const p = parseBoardFile(f);
    if (p !== null) events.push({ kind: "board", file: f, item: p.item, state: p.state, who: p.who });
  }
  if (curr.progressMtimeMs !== prev.progressMtimeMs && prev.progressMtimeMs !== 0) events.push({ kind: "progress", mtimeMs: curr.progressMtimeMs });
  return events;
}

// --- dead-letter watch (F26, user: "a send failure nobody knows about = a defect") ---
// The LEDGER WRITE side (a sender appends {ts,from,to,error,preview} on a failed send) is bus-identity v1.5's job; THIS is the
// read/watch side: N dead-letters to the same `to` within a window ⇒ a ROUTING incident (via the generic incident-episode
// core, category="routing"); the window clearing ⇒ recovered. Routing incident identity = groupKey `routing:<to>`.

export type DeadLetter = { ts: number; from?: string; to: string; error?: string; preview?: string };
const ROUTING_GK_PREFIX = "routing:";
/** Route IDENTITY = the (from → to) PAIR (review bb2a2cb-P2-1: keying by `to` alone merges A→X and B→X). encodeURIComponent on
 *  each leg keeps the composite unambiguous. A dead-letter missing `from` has no route-pair identity — it is diagnostic only
 *  (never silently folded into a specific pair), so routeKeyOf returns null and it does not count toward any incident. */
export const routeKeyOf = (dl: DeadLetter): string | null => {
  if (dl.from === undefined) return null;
  // encodeURIComponent THROWS a URIError on a malformed string (e.g. a lone UTF-16 surrogate like "\ud800" that JSON.parse
  // accepts). A throw here used to escape the per-record loop AFTER the byte cursor had advanced, permanently skipping the
  // HEALTHY records later in the same chunk (review 4aafeca-R1). A from/to we cannot encode has no usable route identity —
  // treat it as diagnostic-only (null, like a from-less entry), never a throw.
  try { return `${encodeURIComponent(dl.from)}->${encodeURIComponent(dl.to)}`; }
  catch { return null; }
};
export const routingGroupKey = (routeKey: string): string => `${ROUTING_GK_PREFIX}${routeKey}`;
export const routeKeyOfGroup = (groupKey: string): string | null => groupKey.startsWith(ROUTING_GK_PREFIX) ? groupKey.slice(ROUTING_GK_PREFIX.length) : null;

/** Parse a dead-letter ledger (JSONL — one record per line). Null-safe: blank / malformed / partial-last lines are skipped
 *  (the append-only ledger may be mid-write), never a throw. Only records with a string `to` + numeric `ts` count. `maxLines`
 *  (optional) bounds the parse to the most-recent N lines — a verifiable read budget (review P2-3); the window is recent anyway. */
export function parseDeadLetters(jsonl: string, maxLines?: number): DeadLetter[] {
  let lines = jsonl.split("\n");
  if (maxLines !== undefined && lines.length > maxLines) lines = lines.slice(lines.length - maxLines);
  const out: DeadLetter[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    let rec: unknown;
    try { rec = JSON.parse(t); } catch { continue; }
    if (rec === null || typeof rec !== "object") continue;
    const r = rec as { ts?: unknown; to?: unknown; from?: unknown; error?: unknown; preview?: unknown };
    if (typeof r.to !== "string" || typeof r.ts !== "number") continue;
    out.push({ ts: r.ts, to: r.to, ...(typeof r.from === "string" ? { from: r.from } : {}), ...(typeof r.error === "string" ? { error: r.error } : {}), ...(typeof r.preview === "string" ? { preview: r.preview } : {}) });
  }
  return out;
}

/** Count dead-letters per ROUTE PAIR within [windowStartMs, +∞) — a sliding window so an aged-out burst no longer counts.
 *  From-less (identity-less) entries are excluded (diagnostic only, P2-1). */
export function countDeadLettersByRoute(entries: readonly DeadLetter[], windowStartMs: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) { if (e.ts < windowStartMs) continue; const rk = routeKeyOf(e); if (rk === null) continue; m.set(rk, (m.get(rk) ?? 0) + 1); }
  return m;
}

/** The ACTIVE routing incident signal for a route at/above threshold. There is NO window-clear→recovered signal (review P1-1:
 *  absence of dead-letters is "untested", not recovery — a real recovery needs POSITIVE evidence, a subsequent successful
 *  delivery, which the ledger does not carry; routing recovery is therefore driven by the repair-wait being resolved, synced
 *  by reconcileRegistryWithControl, DEFERRED to when a delivery-success signal exists). subjectJobId = synthetic routing domain. */
export function routingActiveSignal(routeKey: string, count: number, lastObservedSeq: number): IncidentSignal {
  return { kind: "active", groupKey: routingGroupKey(routeKey), category: "routing", why: `${count} dead-letters on route ${routeKey} within window`, lastObservedSeq, subjectJobId: "swarm-routing" };
}

// --- dead-letter watch DURABLE STATE (review d1bcd94 R1-R5): the watch must never re-read the whole ledger (R3), never drop
// an in-window burst or an observed-but-deferred candidate (R1), distinguish pre- vs post-recovery failures (R5), and keep an
// undelivered notice alive past episode close (R4). All of that needs state persisted between ticks, below. ---

export type WindowEvent = { ts: number; route: string };
/** An unfulfilled (or recently-delivered) coordinator notice for ONE incident, keyed by its FULL incidentId in the watch (R4).
 *  notifiedAtSec unset ⇒ still owed (retry, at-least-once); set ⇒ delivered (durable, so a confirmed notice is never re-sent). */
export type OwedNotice = { why: string; open: boolean; repairWaitId: string; notifiedAtSec?: number };
export type DeadLetterWatch = {
  /** Ledger file-identity fingerprint for rotation/truncation detection (R3): a changed sig OR size < offset ⇒ re-read from 0. */
  sig: string;
  /** Byte cursor: the next unread position in the ledger (R3 incremental read; never a full-file slurp). */
  offset: number;
  /** Bytes read past the last COMPLETE record — the incomplete trailing line as BASE64 bytes (not a string: a multi-byte UTF-8
   *  char split across the read boundary must not be decoded until its continuation arrives), carried to the next tick (R1/R3). */
  carry: string;
  /** True while SKIPPING a pathological over-long (> maxCarry) line that has no newline: drop its bytes until the next newline
   *  rather than growing carry unboundedly each tick (R3), then resume on the records AFTER it — never a re-tail, never a drop
   *  of the healthy suffix. */
  truncating: boolean;
  /** In-window failure events (route-pair), accumulated from the incremental read and pruned each tick (R1 keeps in-window). */
  window: WindowEvent[];
  /** route -> the max failure ts already COVERED by an opened incident (R5 watermark): a failure at/under this never reopens. */
  handled: Record<string, number>;
  /** route -> the recovery-boundary ts recorded when an incident was recovered/closed (R5): a failure at/under it is
   *  pre-recovery and never reopens, EVEN IF ingested AFTER the recovery was observed — so a late-ingested pre-recovery burst
   *  cannot fake a relapse; only a failure strictly newer than this boundary is post-recovery evidence. */
  recovered: Record<string, number>;
  /** route -> the FAILURE TIMESTAMPS of a candidate that reached threshold, awaiting a durable CONTROL commit. Stored as the
   *  timestamps (not just a count) so the candidate is SELF-CONTAINED (review 7e9a08b-R5-C): it is a discovered obligation that
   *  survives window aging — it is pruned ONLY when a recovery boundary filters its post-recovery members below threshold, never
   *  because its samples left the sliding detection window. Removed on commit. */
  pending: Record<string, number[]>;
  /** incidentId -> the owed/delivered coordinator notice (R4). reg.episodes is keyed by groupKey and keeps only the LATEST
   *  generation, so a recurrence (episode+1) overwrites a previous episode still owing a notice; keying the obligation by the
   *  full incidentId HERE (durable) preserves every generation's notice until delivered. A delivered entry is pruned once its
   *  episode is superseded, bounding growth. The delivered marker living here (not only on the overwritten episode) means a
   *  lost registry write only DELAYS a notice, and a confirmed one is never re-sent across a restart. */
  owed: Record<string, OwedNotice>;
};

export function emptyDeadLetterWatch(): DeadLetterWatch {
  return { sig: "", offset: 0, carry: "", truncating: false, window: [], handled: {}, recovered: {}, pending: {}, owed: {} };
}

/** Fold a freshly-read byte chunk into (events, carryB64, truncating): prepend the prior carry BYTES, decode only up to the
 *  last newline BYTE (a complete-line boundary is always a valid UTF-8 boundary) and parse those via the null-safe parser, and
 *  return the trailing incomplete bytes as the new base64 carry. A record split across two reads — even mid-UTF-8-char — is
 *  never half-parsed, mis-decoded, or lost (R1/R3 record boundary). CARRY IS BOUNDED (R3): a no-newline residual exceeding
 *  maxCarryBytes is a pathological over-long line ⇒ enter `truncating` (drop its bytes until the next newline) instead of
 *  growing carry each tick; the records after its terminating newline resume normally, never tail-cut (which would re-open R1). */
export function ingestLedgerChunk(carryB64: string, chunk: Buffer, maxCarryBytes: number, truncating: boolean): { events: DeadLetter[]; carry: string; truncating: boolean } {
  let combined = carryB64 ? Buffer.concat([Buffer.from(carryB64, "base64"), chunk]) : chunk;
  if (truncating) {
    const end = combined.indexOf(0x0a); // skipping an over-long line: wait for its terminating newline
    if (end < 0) return { events: [], carry: "", truncating: true }; // not ended yet — drop this chunk's bytes, keep skipping
    combined = combined.subarray(end + 1); // resume on the suffix after the over-long line
  }
  const nl = combined.lastIndexOf(0x0a); // last '\n' byte
  if (nl < 0) {
    if (combined.length > maxCarryBytes) return { events: [], carry: "", truncating: true }; // over-long incomplete line ⇒ start skipping (R3)
    return { events: [], carry: combined.toString("base64"), truncating: false };            // no complete line yet — keep accumulating
  }
  // Parse the complete prefix lines, then cap the TRAILING incomplete fragment too (R3-b): the bytes after the last newline are
  // an incomplete line like the no-newline case, so an over-cap fragment must ALSO enter skipping instead of being carried —
  // the cap was previously only checked on the no-newline branch, letting a long trailing residue persist past the limit.
  const events = parseDeadLetters(combined.toString("utf8", 0, nl));
  const rest = combined.subarray(nl + 1);
  if (rest.length > maxCarryBytes) return { events, carry: "", truncating: true }; // over-long trailing fragment ⇒ skip until its newline; the parsed records are kept
  return { events, carry: rest.toString("base64"), truncating: false };
}

/** Drop window events older than the window start (sliding window; R1 retains in-window, prunes aged-out). */
export function pruneDeadLetterWindow(window: readonly WindowEvent[], windowStartMs: number): WindowEvent[] {
  return window.filter((e) => e.ts >= windowStartMs);
}

/** Count in-window failures per route STRICTLY NEWER than the route's floor = max(handled watermark, recovery boundary). R5:
 *  a failure already covered by an opened incident (handled), OR at/under a recorded recovery (recovered), never reopens — so
 *  neither the same already-counted burst nor a PRE-recovery failure can fake a relapse; recurrence needs a failure strictly
 *  after the recovery boundary. The recovered boundary is the TRUE recovery OCCURRENCE (the resolved repair-wait's
 *  resolution.occurredAtSec, set by the committing IO; the caller stores it here in ms), NOT the observation time — this strict
 *  `> boundary` test mirrors task-wait.failureReopensIncident (the agreed truth source) in ms. A recovery with no finite
 *  occurrence sets no boundary (recovered unset ⇒ 0 floor) ⇒ its post-recovery failures reopen (fail-toward-noticing). */
export function countFreshByRoute(window: readonly WindowEvent[], windowStartMs: number, handled: Record<string, number>, recovered: Record<string, number>): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of window) {
    if (e.ts < windowStartMs) continue;
    if (e.ts <= Math.max(handled[e.route] ?? 0, recovered[e.route] ?? 0)) continue; // handled OR pre-recovery ⇒ not fresh (R5)
    m.set(e.route, (m.get(e.route) ?? 0) + 1);
  }
  return m;
}

/** The max in-window ts for a route (the new handled-through watermark once an incident is committed for it, R5). */
export function maxTsForRoute(window: readonly WindowEvent[], route: string): number {
  let mx = 0;
  for (const e of window) if (e.route === route && e.ts > mx) mx = e.ts;
  return mx;
}

/** The in-window FRESH failure timestamps per route — those strictly newer than the route's floor = max(handled, recovered),
 *  same freshness rule as countFreshByRoute but returning the timestamps so the caller can store a SELF-CONTAINED durable
 *  candidate (review 7e9a08b-R5-C). Sorted ascending per route. */
export function freshTimestampsByRoute(window: readonly WindowEvent[], windowStartMs: number, handled: Record<string, number>, recovered: Record<string, number>): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const e of window) {
    if (e.ts < windowStartMs) continue;
    if (e.ts <= Math.max(handled[e.route] ?? 0, recovered[e.route] ?? 0)) continue; // handled OR pre-recovery ⇒ not fresh (R5)
    (m.get(e.route) ?? m.set(e.route, []).get(e.route)!).push(e.ts);
  }
  for (const tss of m.values()) tss.sort((a, b) => a - b);
  return m;
}

/** Fold the window's FRESH failures into the durable pending candidates at INGESTION (review 2548808-D1): for EVERY route whose
 *  fresh (post-handled/recovery) in-window failures reach `threshold`, record them — REPLACING with the current window SNAPSHOT,
 *  never accumulating, so the SAME failure is never double-counted AND a route that already has (stale) pending gets its NEW
 *  burst folded in here rather than only when the budget-limited group loop reaches it. A threshold-reaching set is a discovered
 *  obligation and is STICKY: a route whose fresh is now BELOW threshold keeps its previously-recorded pending (it survives the
 *  sliding window aging out its samples — R5-C). Pure (returns the next map), so the budget-independent consolidation is
 *  unit-tested; the caller commits incidents from `pending` under its per-tick group budget separately. */
export function consolidatePending(pending: Record<string, number[]>, window: readonly WindowEvent[], windowStartMs: number, handled: Record<string, number>, recovered: Record<string, number>, threshold: number): Record<string, number[]> {
  const next = { ...pending };
  for (const [route, tss] of freshTimestampsByRoute(window, windowStartMs, handled, recovered))
    if (tss.length >= threshold) next[route] = tss; // record/refresh with the current snapshot; sub-threshold routes keep their existing pending (sticky)
  return next;
}

/** Read the durable dead-letter watch state. Missing ⇒ empty (first run); corrupt ⇒ THROWS (caller is fail-soft + skips, so a
 *  transient read error never resets the cursor/window/pending to empty and loses durable obligations — R1). */
export function readDeadLetterWatch(file: string): DeadLetterWatch {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyDeadLetterWatch(); throw e; }
  const p = JSON.parse(raw) as DeadLetterWatch;
  if (p === null || typeof p !== "object" || typeof p.offset !== "number" || typeof p.carry !== "string" || !Array.isArray(p.window)
      || typeof p.handled !== "object" || typeof p.pending !== "object") throw new Error("dead-letter watch: malformed");
  // D2 (review 01b773d): migrate a LEGACY pending. Pre-R5-C the field was Record<string,number> (a count); a bare count has no
  // timestamps, and we must NOT fabricate them. RECONSTRUCT from retained evidence — the watch's own window events for that route —
  // when present; otherwise omit the bare count (its evidence is gone, the tss-based consumer cannot act on a count, and population
  // re-derives any still-in-window burst anyway). Explicitly version-recognized via Array.isArray — never a silent assumption that
  // the old shape cannot occur. (The dead-letter watch is dormant until the ledger exists, so no numeric-pending file is written in
  // production; this is defense-in-depth for a mixed-version read, not a live data migration.)
  const window = (Array.isArray(p.window) ? p.window : []) as WindowEvent[];
  const pending: Record<string, number[]> = {};
  for (const [route, v] of Object.entries((p.pending ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(v)) { const tss = v.filter((t): t is number => typeof t === "number" && Number.isFinite(t)); if (tss.length > 0) pending[route] = tss; continue; }
    const rebuilt = window.filter((e) => e.route === route).map((e) => e.ts).sort((a, b) => a - b); // legacy count ⇒ rebuild tss from retained window evidence
    if (rebuilt.length > 0) pending[route] = rebuilt;
  }
  return {
    sig: typeof p.sig === "string" ? p.sig : "", offset: p.offset, carry: p.carry,
    truncating: p.truncating === true, window,
    handled: p.handled ?? {}, recovered: p.recovered ?? {}, pending, owed: p.owed ?? {},
  };
}

/** Write the watch state atomically (unique temp + exclusive create + rename). Persist AFTER the batch's commits + notifies, so
 *  a crash before the write re-reads the same cursor/pending next run rather than skipping durable work (R1). */
export function writeDeadLetterWatch(file: string, w: DeadLetterWatch): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(w), { mode: 0o644, flag: "wx" });
  renameSync(tmp, file);
}

/** Read the durable snapshot. Missing ⇒ empty (first run); corrupt ⇒ THROWS (caller is fail-soft + skips — a transient read
 *  error must not reset the snapshot to empty and re-fire every board file as "new"). */
export function readWatchSnapshot(file: string): WatchSnapshot {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyWatchSnapshot(); throw e; }
  const parsed = JSON.parse(raw) as WatchSnapshot;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.boardFiles) || typeof parsed.progressMtimeMs !== "number") throw new Error("watch snapshot: malformed");
  return parsed;
}

/** Write the snapshot atomically (unique temp + exclusive create + rename). Persist AFTER the events are pushed, so a push
 *  failure re-fires next tick rather than being dropped. */
export function writeWatchSnapshot(file: string, snap: WatchSnapshot): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o644, flag: "wx" });
  renameSync(tmp, file);
}
