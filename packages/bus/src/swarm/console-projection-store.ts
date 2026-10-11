/**
 * Console projection IO (swarm-console producers ① + ②). Two READ-ONLY mirrors, written atomically (temp + rename) under the
 * NEW `~/.agenthop/swarm/console/` dir, in the style of `dual-bandwidth-store.ts`: compute from the swarm's EXISTING durable
 * artifacts, write a frozen-schema projection, fully fail-soft. The pure shape builders live in `console-projection.ts`.
 *
 *   ① `console/decisions/<batchId>.json` — one file per IN-LIBRARY awaiting-ruling (NOT-yet-consumed) decision batch, each a
 *      verbatim decision-batch-v1 `batch.json` (buildDecisionMirror). Reads the decision-batch store READ-ONLY (`readBatch`
 *      + the terminal `consumed.json` marker); it NEVER calls the mutating `consumeDecisions` / `writeDecisions`, and never
 *      touches the store's write surface. A mirror is pruned ONLY for a CONFIRMED-terminal (consumed) or CONFIRMED-vanished
 *      batch; a read/enumerate UNCERTAINTY keeps the old mirror (CP-1, FC-2 r3), and a redirected output dir chain is refused
 *      (CP-3). console/ dir only.
 *   ② `console/roster.json` — a per-seat {sid, tool, pane, alive, inflight} glance derived from the roster-snapshot
 *      (resume.ts ROSTER_FILE, read errno-strictly here) + presence liveness (task-liveness.fileIsAlive — the EXISTING liveness
 *      model, FC-2 r3 three-state) + the control-log's live non-terminal waits (inflight, the same activeOwners derivation the
 *      sentinel uses). A per-seat unreadable/absent liveness signal ⇒ alive:"unknown"; a COLLECTION-level unreadable source
 *      (roster snapshot or control-log) ⇒ the whole publish is SKIPPED (CP-2) rather than overwriting with a false empty.
 *
 * Why the decision-batch `consumed.json` path is read directly here: the store exposes no `isConsumed()` read API, and
 * "awaiting ruling" IS "terminal consumed.json absent" per decision-batch-v1. This is a READ-ONLY stat of the store's own
 * terminal marker — the exact precedent `dual-bandwidth-store.ts` sets (it reads `consumedPath` read-only for the same reason).
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readBatch, listBatchesStrict } from "./decision-batch-store.js";
import { ROSTER_FILE, type RosterMember } from "./resume.js";
import { fileIsAlive, makeFileLiveness, resolveSession, listSessions, type Liveness } from "./task-liveness.js";
import { loadControlLog } from "./control-store.js";
import { liveEntities } from "./control-log.js";
import {
  buildDecisionMirror,
  buildRosterProjection,
  seatAliveOf,
  type ConsoleRosterProjection,
  type RosterSeat,
  type SeatLiveness,
} from "./console-projection.js";

// --- console/ output paths (the NEW dir, a sibling of ~/.agenthop/swarm/projection) --------------------------------
function consoleDir(home: string): string { return path.join(home, ".agenthop", "swarm", "console"); }
function decisionsDir(home: string): string { return path.join(consoleDir(home), "decisions"); }
function decisionFilePath(home: string, batchId: string): string { return path.join(decisionsDir(home), `${batchId}.json`); }
function rosterPath(home: string): string { return path.join(consoleDir(home), "roster.json"); }

// --- the decision-batch store's own layout (READ-ONLY — the store owns the write surface) ---------------------------
function consumedMarkerPath(home: string, batchId: string): string { return path.join(home, ".agenthop", "console", "decision-batches", batchId, "consumed.json"); }
function controlLogDir(home: string): string { return path.join(home, ".agenthop", "swarm", "control-log"); }
function rosterSnapshotPath(home: string): string { return path.join(home, ".agenthop", "swarm", ROSTER_FILE); }

/**
 * CP-3 — the console output dir chain must be REAL owned directories, never redirected by a pre-existing symlink. A symlinked
 * console/ or console/decisions/ would land our writes AND our prunes OUTSIDE the console boundary (the review's evidence: a
 * decisions/ symlink pointing at the live control-log, whose source files the prune would then delete). SAFE_BATCH_ID only
 * constrains the FILENAME, not the directory's real landing — a string-prefix check cannot catch this. So lstat (NO-follow)
 * each component: a symlink (or any non-directory) ⇒ REFUSE (return false, the caller skips write+prune). ENOENT ⇒ not created
 * yet ⇒ safe (our own mkdir will create real dirs). Any other stat fault ⇒ refuse (never risk a write/prune we can't vet).
 */
function consoleBoundaryOk(home: string): boolean {
  for (const d of [consoleDir(home), decisionsDir(home)]) {
    let st;
    try { st = lstatSync(d); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; return false; }
    if (!st.isDirectory()) return false; // a symlink (even to a dir) or a plain file ⇒ not a real owned dir ⇒ refuse
  }
  return true;
}

/** The store's own batchId guard (safe to use as a filename — no path traversal; `^[A-Za-z0-9_-]{1,64}$`). We re-check it
 *  locally so an unsafe on-disk dir name can never flow into a console/ filename (and readBatch would throw on it anyway). */
const SAFE_BATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Atomic JSON write (temp + rename) so a console reader never sees a half-written file. 0o700 dir / 0o600 file. */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

// ===================================================================================================================
// Producer ① — decisions mirror
// ===================================================================================================================

/** Is this batch TERMINAL (consumed)? ENOENT ⇒ false (no marker ⇒ awaiting ruling). Any other stat error PROPAGATES to the
 *  per-batch catch, which SKIPS the batch (conservative: an unprovable state is not asserted as "pending"), never crashes. */
function isConsumed(home: string, batchId: string): boolean {
  try { statSync(consumedMarkerPath(home, batchId)); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/**
 * Mirror every IN-LIBRARY awaiting-ruling batch to `console/decisions/<batchId>.json`, then prune ONLY confirmed-stale files.
 * READ-ONLY of the store. CP-1 (FC-2 r3): the prune KEEP-set is NOT merely "what we wrote" — "couldn't publish / couldn't read"
 * is NOT "consumed / vanished". Three outcomes per batch:
 *   - CONFIRMED awaiting  (readBatch ok)        ⇒ mirror written, id kept.
 *   - CONFIRMED terminal  (consumed.json seen)  ⇒ not mirrored, id NOT kept ⇒ its mirror is pruned.
 *   - UNCERTAIN (readBatch null = foreign/corrupt/read-swallowed, or an isConsumed stat / a write fault) ⇒ id kept ⇒ its old
 *     mirror is RETAINED (never a false prune; retry next tick).
 * A GLOBAL enumerate fault (listBatchesStrict throws on a non-ENOENT dir/stat error) ⇒ we cannot tell awaiting from gone ⇒ SKIP
 * the whole pass (keep EVERY mirror). ENOENT (no store yet) ⇒ [] ⇒ every mirror is genuinely stale ⇒ pruned. CP-3: refuse if the
 * output dir chain is redirected by a pre-existing symlink (a prune could otherwise delete files outside the console boundary).
 */
export function writeDecisionMirrors(home: string, nowSec: number): { written: string[]; skipped?: boolean } {
  if (!consoleBoundaryOk(home)) return { written: [], skipped: true }; // CP-3: never write/prune through a redirected dir chain
  let ids: string[];
  try { ids = listBatchesStrict(home); }                                // CP-1: non-ENOENT enumerate/stat fault PROPAGATES
  catch { return { written: [], skipped: true }; }                      // global uncertainty ⇒ keep ALL mirrors, retry next tick
  mkdirSync(decisionsDir(home), { recursive: true, mode: 0o700 });
  const keep = new Set<string>();      // ids whose console mirror must survive this prune = awaiting (mirrored) ∪ uncertain
  const written: string[] = [];
  for (const id of ids) {
    if (!SAFE_BATCH_ID.test(id)) continue; // a store dir name that could not be a safe mirror filename — ignore (never prunes it)
    try {
      if (isConsumed(home, id)) continue;        // CONFIRMED terminal ⇒ not kept ⇒ its mirror is pruned below
      const batch = readBatch(home, id);         // null = foreign/corrupt OR a swallowed read fault ⇒ UNCERTAIN (keep, never prune)
      if (!batch) { keep.add(id); continue; }    // CP-1: an unprovable batch keeps its old mirror (FC-2 r3), never a false prune
      writeJsonAtomic(decisionFilePath(home, id), buildDecisionMirror(batch, nowSec));
      keep.add(id); written.push(id);
    } catch { keep.add(id); }                     // CP-1: isConsumed stat fault / write fault ⇒ UNCERTAIN ⇒ keep the old mirror
  }
  pruneStaleDecisionFiles(home, keep);
  return { written };
}

/** Remove `console/decisions/*.json` files whose id is NOT in `keep` — i.e. CONFIRMED consumed (terminal) or vanished (absent
 *  from a SUCCESSFUL enumeration); an UNCERTAIN id is always in `keep` (CP-1). Only touches the console/ dir, and only unlinks a
 *  REGULAR file (CP-3: never follow/remove a symlink that could point outside the boundary). Best-effort; `.tmp-*` temps ignored. */
function pruneStaleDecisionFiles(home: string, keep: Set<string>): void {
  let files: string[];
  try { files = readdirSync(decisionsDir(home)); }
  catch { return; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue; // skip `*.json.tmp-<hex>` partials
    const id = f.slice(0, -".json".length);
    if (keep.has(id)) continue;
    const fp = path.join(decisionsDir(home), f);
    try { if (lstatSync(fp).isFile()) unlinkSync(fp); } catch { /* best-effort prune; a symlink/non-file is left untouched */ }
  }
}

// ===================================================================================================================
// Producer ② — roster glance
// ===================================================================================================================

/** The injected facts the seat assembler needs — real-fs values via `realRosterFacts`, fixtures in the selftest. */
export type RosterFacts = {
  members: readonly RosterMember[];
  /** Resolve a roster identity (stableId OR short handle) to its native presence sid; the identity itself if unresolved. */
  resolveSid: (memberId: string) => string;
  /** Liveness for a native sid. MAY THROW (a read fault) ⇒ the assembler catches ⇒ "unknown" (FC-2 r3, never false-dead). */
  livenessOf: (nativeSid: string) => Liveness;
  /** Count of live (non-terminal) waits owned by a native sid. */
  inflightOf: (nativeSid: string) => number;
  /** The console-facing pane / window label for a member. */
  paneOf: (m: RosterMember) => string | null;
};

/**
 * Assemble raw seats from the injected facts — one per roster member. FC-2 r3: a liveness probe that THROWS (read error) OR
 * reports "suspected" (absent/unreadable) ⇒ alive:"unknown", NEVER a false "dead". inflight / pane probes are likewise
 * fail-soft (0 / null on fault). The IO probing is injected, so this is unit-tested with fixtures incl. a THROWING probe.
 * Deduping + sorting happen in the pure `buildRosterProjection`.
 */
export function assembleRosterSeats(facts: RosterFacts): RosterSeat[] {
  const seats: RosterSeat[] = [];
  for (const m of facts.members) {
    const sid = m.member;
    let nativeSid: string;
    try { nativeSid = facts.resolveSid(sid); } catch { nativeSid = sid; }

    let alive: SeatLiveness;
    try { alive = seatAliveOf(facts.livenessOf(nativeSid)); }
    catch { alive = "unknown"; } // FC-2 r3: a liveness read error is UNKNOWN, never a false dead

    let inflight = 0;
    try { const n = facts.inflightOf(nativeSid); if (Number.isFinite(n) && n > 0) inflight = Math.floor(n); }
    catch { inflight = 0; }

    let pane: string | null = null;
    try { pane = facts.paneOf(m); } catch { pane = null; }

    seats.push({ sid, tool: m.tool ?? "", pane, alive, inflight });
  }
  return seats;
}

/** CP-2 — the roster-snapshot source, errno-DISCRIMINATED. [] = CONFIRMED no roster (ENOENT: none captured yet). null =
 *  UNREADABLE (EACCES / corrupt-or-torn JSON) — an UNCERTAIN state the caller must NOT publish as a fresh empty roster. The
 *  upstream readRosterMembers folds both to [], which is exactly the false-empty the review (CP-2) flagged, so we read strictly
 *  here. READ-ONLY. */
function readRosterStrict(home: string): RosterMember[] | null {
  let raw: string;
  try { raw = readFileSync(rosterSnapshotPath(home), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null; } // ENOENT ⇒ confirmed empty; else uncertain
  let snap: unknown;
  try { snap = JSON.parse(raw); }
  catch { return null; } // corrupt/torn JSON ⇒ UNCERTAIN (a torn write is transient; never publish a false-empty roster)
  // CP-2 (r2): ONLY a RECOGNIZED shape is a confirmed roster — an object whose `members` IS AN ARRAY (an empty array is a
  // confirmed-empty roster). `null`, a non-object, or a missing/non-array `members` is an UNRECOGNIZED shape ⇒ unknown (null ⇒
  // SKIP), NEVER a false confirmed-empty that overwrites the last projection. Only a structurally-valid empty counts as empty.
  if (!snap || typeof snap !== "object" || !Array.isArray((snap as { members?: unknown }).members)) return null;
  return (snap as { members: unknown[] }).members
    .filter((m: unknown): m is RosterMember => !!m && typeof (m as RosterMember).member === "string" && typeof (m as RosterMember).tool === "string" && typeof (m as RosterMember).cwd === "string");
}

/** CP-2 — count live (non-terminal) waits per native sid from the control-log — the SAME derivation the sentinel's `activeOwners`
 *  uses (liveEntities drops tombstones/resolved; a wait owner resolves handle→sid via resolveSession, ambiguous ⇒ credited to no
 *  one, F16). Errno-DISCRIMINATED: a MISSING control-log dir does NOT throw (loadControlLog ⇒ empty state) ⇒ an empty map
 *  (CONFIRMED no waits); an UNREADABLE control-log (EACCES / corrupt batch) THROWS ⇒ null (UNCERTAIN — the caller must not
 *  publish a fresh "0 inflight everywhere"). READ-ONLY. */
function computeInflightStrict(home: string, sids: string[]): Map<string, number> | null {
  const dir = controlLogDir(home);
  // CP-2 (r2): errno-discriminate the dir OURSELVES first. loadControlLog → readControlBatches gates on existsSync(dir), which
  // folds an access fault (e.g. an unreadable PARENT) to "absent" and returns an empty seq=0 state with NO throw ⇒ a FALSE
  // zero-inflight that would never reach the catch below. A direct stat distinguishes ENOENT (confirmed no control-log ⇒ empty)
  // from any other fault (EACCES/… ⇒ unknown ⇒ SKIP). A readable dir with an unreadable/corrupt BATCH file still throws inside
  // loadControlLog ⇒ caught ⇒ null.
  try { statSync(dir); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? new Map<string, number>() : null; }
  let live: Record<string, import("./control-log.js").ChangeBody>;
  try { live = liveEntities(loadControlLog(dir)); }
  catch { return null; } // a readable dir but an unreadable/corrupt batch ⇒ uncertain (NOT "zero inflight")
  const out = new Map<string, number>();
  for (const b of Object.values(live)) {
    if (b.put !== "wait") continue;
    const w = b.wait;
    if (w.state === "resolved") continue; // terminal ⇒ not in-flight
    const owner = resolveSession(w.owner ?? "", sids);
    if (owner) out.set(owner, (out.get(owner) ?? 0) + 1);
  }
  return out;
}

/** Build RosterFacts from ALREADY-READ source collections: liveness from presence pid + signal-0 (task-liveness, FC-2 r3) — a
 *  per-seat probe fault is still per-seat "unknown"; inflight looked up from the pre-read map; pane from the member's handle
 *  (`title`; else the member identity). The roster snapshot usually stores full sids, so resolveSid is mostly identity. */
function realRosterFacts(home: string, members: readonly RosterMember[], inflightBySid: Map<string, number>): RosterFacts {
  const sids = listSessions(home);
  const io = makeFileLiveness(home);
  return {
    members,
    resolveSid: (memberId) => resolveSession(memberId, sids) ?? memberId,
    livenessOf: (sid) => fileIsAlive(sid, io),
    inflightOf: (sid) => inflightBySid.get(sid) ?? 0,
    paneOf: (m) => m.title ?? m.member ?? null,
  };
}

/**
 * Compute + atomically write `console/roster.json`. Returns the projection, or null when the write was SKIPPED.
 * CP-2 (FC-2 r3): when building from the REAL fs (no `members` override), the COLLECTION-level source reads are errno-
 * discriminated — an UNREADABLE roster snapshot OR an UNREADABLE control-log ⇒ SKIP the publish (return null) so the last good
 * projection stands, rather than overwriting it with a FALSE empty-roster / zero-inflight. A CONFIRMED-empty source (ENOENT)
 * still publishes an empty roster. A `members` override (selftest / future wiring) supplies the collection directly, so the
 * real-source gate does not apply (inflight is then best-effort). CP-3: refuse if the output dir chain is a pre-existing symlink.
 */
export function writeRosterProjection(home: string, nowSec: number, facts?: Partial<RosterFacts>): ConsoleRosterProjection | null {
  if (!consoleBoundaryOk(home)) return null; // CP-3: never write through a redirected console dir chain
  let base: RosterFacts;
  if (facts?.members) {
    // caller supplies the roster collection directly ⇒ no real-source uncertainty to guard (inflight is best-effort here).
    base = realRosterFacts(home, facts.members, computeInflightStrict(home, listSessions(home)) ?? new Map());
  } else {
    const members = readRosterStrict(home);
    const inflightBySid = computeInflightStrict(home, listSessions(home));
    if (members === null || inflightBySid === null) return null; // CP-2: unreadable source ⇒ skip (keep the last projection)
    base = realRosterFacts(home, members, inflightBySid);
  }
  const merged: RosterFacts = { ...base, ...facts };
  const projection = buildRosterProjection(assembleRosterSeats(merged), nowSec);
  writeJsonAtomic(rosterPath(home), projection);
  return projection;
}

// ===================================================================================================================
// Combined entry (the dispatcher calls this once per throttled sweep)
// ===================================================================================================================

/** Write BOTH console projections. Each producer is attempted independently (a decisions failure still lets roster write, and
 *  vice-versa); the first error is re-thrown to the dispatcher's fail-soft logger. Never breaks the sweep (the caller wraps). */
export function writeConsoleProjection(home: string, nowSec: number): void {
  let firstErr: unknown;
  try { writeDecisionMirrors(home, nowSec); } catch (e) { firstErr ??= e; }
  try { writeRosterProjection(home, nowSec); } catch (e) { firstErr ??= e; }
  if (firstErr) throw firstErr;
}
