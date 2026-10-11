/**
 * Console projection IO (swarm-console producers ① + ②). Two READ-ONLY mirrors, written atomically (temp + rename) under the
 * NEW `~/.agenthop/swarm/console/` dir, in the style of `dual-bandwidth-store.ts`: compute from the swarm's EXISTING durable
 * artifacts, write a frozen-schema projection, fully fail-soft. The pure shape builders live in `console-projection.ts`.
 *
 *   ① `console/decisions/<batchId>.json` — one file per IN-LIBRARY awaiting-ruling (NOT-yet-consumed) decision batch, each a
 *      verbatim decision-batch-v1 `batch.json` (buildDecisionMirror). Reads the decision-batch store READ-ONLY (`readBatch`
 *      + the terminal `consumed.json` marker); it NEVER calls the mutating `consumeDecisions` / `writeDecisions`, and never
 *      touches the store's write surface. Stale mirror files (a batch that consumed or vanished) are pruned from the console/
 *      dir only.
 *   ② `console/roster.json` — a per-seat {sid, tool, pane, alive, inflight} glance derived from the roster-snapshot
 *      (resume.ts ROSTER_FILE, via shell-succession.readRosterMembers) + presence liveness (task-liveness.fileIsAlive —
 *      the EXISTING liveness model, FC-2 r3 three-state) + the control-log's live non-terminal waits (inflight, the same
 *      activeOwners derivation the sentinel uses). An unreadable/absent liveness signal ⇒ alive:"unknown" (never false dead).
 *
 * Why the decision-batch `consumed.json` path is read directly here: the store exposes no `isConsumed()` read API, and
 * "awaiting ruling" IS "terminal consumed.json absent" per decision-batch-v1. This is a READ-ONLY stat of the store's own
 * terminal marker — the exact precedent `dual-bandwidth-store.ts` sets (it reads `consumedPath` read-only for the same reason).
 */
import { mkdirSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readBatch } from "./decision-batch-store.js";
import { readRosterMembers } from "./shell-succession.js";
import type { RosterMember } from "./resume.js";
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
function decisionBatchesDir(home: string): string { return path.join(home, ".agenthop", "console", "decision-batches"); }
function consumedMarkerPath(home: string, batchId: string): string { return path.join(decisionBatchesDir(home), batchId, "consumed.json"); }
function controlLogDir(home: string): string { return path.join(home, ".agenthop", "swarm", "control-log"); }

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

/** Enumerate candidate batch ids from the store dir, fail-soft. ENOENT (no store yet) OR any access fault ⇒ [] (the sweep
 *  wrapper logs; a stale mirror simply lingers until the next readable tick). Only SAFE-id directories are considered. */
function listBatchDirIds(home: string): string[] {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(decisionBatchesDir(home), { withFileTypes: true }); }
  catch { return []; }
  const ids: string[] = [];
  for (const d of entries) if (d.isDirectory() && SAFE_BATCH_ID.test(d.name)) ids.push(d.name);
  return ids;
}

/** Is this batch TERMINAL (consumed)? ENOENT ⇒ false (no marker ⇒ awaiting ruling). Any other stat error PROPAGATES to the
 *  per-batch catch, which SKIPS the batch (conservative: an unprovable state is not asserted as "pending"), never crashes. */
function isConsumed(home: string, batchId: string): boolean {
  try { statSync(consumedMarkerPath(home, batchId)); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/** Mirror every IN-LIBRARY awaiting-ruling batch to `console/decisions/<batchId>.json`, then prune stale files. READ-ONLY of
 *  the store. Per-batch fail-soft: a foreign/corrupt batch.json (readBatch ⇒ null) or a per-batch read fault is skipped so one
 *  bad batch never hides the rest. Returns the set of batch ids mirrored. */
export function writeDecisionMirrors(home: string, nowSec: number): { written: string[] } {
  mkdirSync(decisionsDir(home), { recursive: true, mode: 0o700 });
  const awaiting = new Set<string>();
  for (const id of listBatchDirIds(home)) {
    try {
      if (isConsumed(home, id)) continue;        // terminal ⇒ not awaiting ⇒ not mirrored (pruned below)
      const batch = readBatch(home, id);         // dir-bound; foreign/corrupt ⇒ null; EACCES ⇒ throws (caught)
      if (!batch) continue;
      writeJsonAtomic(decisionFilePath(home, id), buildDecisionMirror(batch, nowSec));
      awaiting.add(id);
    } catch { /* fail-soft: skip this batch, keep mirroring the rest */ }
  }
  pruneStaleDecisionFiles(home, awaiting);
  return { written: [...awaiting] };
}

/** Remove `console/decisions/*.json` files for batches that are no longer awaiting (consumed / vanished), so the console never
 *  reads a stale pending batch. Only touches the console/ dir (never the store). Best-effort; `.tmp-*` temps are ignored. */
function pruneStaleDecisionFiles(home: string, keep: Set<string>): void {
  let files: string[];
  try { files = readdirSync(decisionsDir(home)); }
  catch { return; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue; // skip `*.json.tmp-<hex>` partials
    const id = f.slice(0, -".json".length);
    if (keep.has(id)) continue;
    try { unlinkSync(path.join(decisionsDir(home), f)); } catch { /* best-effort prune */ }
  }
}

// ===================================================================================================================
// Producer ② — roster glance
// ===================================================================================================================

/** The injected facts the seat assembler needs — real-fs defaults in `defaultRosterFacts`, fixtures in the selftest. */
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

/** Count live (non-terminal) waits per native sid from the control-log — the SAME derivation the sentinel's `activeOwners`
 *  uses (liveEntities drops tombstones/resolved; a wait owner resolves handle→sid via resolveSession, ambiguous ⇒ credited to
 *  no one, F16). Fail-soft: no/unreadable control-log ⇒ an empty map (0 inflight everywhere), never a throw. READ-ONLY. */
function computeInflightBySid(home: string, sids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  let live: Record<string, import("./control-log.js").ChangeBody>;
  try { live = liveEntities(loadControlLog(controlLogDir(home))); }
  catch { return out; }
  for (const b of Object.values(live)) {
    if (b.put !== "wait") continue;
    const w = b.wait;
    if (w.state === "resolved") continue; // terminal ⇒ not in-flight
    const owner = resolveSession(w.owner ?? "", sids);
    if (owner) out.set(owner, (out.get(owner) ?? 0) + 1);
  }
  return out;
}

/** Real-fs facts: roster from the snapshot; liveness from presence pid + signal-0 (task-liveness, FC-2 r3); inflight from the
 *  control-log; pane from the member's handle (`title`, the window label the roster captured; else the member identity). The
 *  roster snapshot usually stores full sids, so resolveSid is mostly identity; a handle degrades to presence-absent ⇒ "unknown"
 *  (safe), never a false dead. */
function defaultRosterFacts(home: string): RosterFacts {
  const members = readRosterMembers(home); // fail-soft [] on any fault
  const sids = listSessions(home);
  const io = makeFileLiveness(home);
  const inflightBySid = computeInflightBySid(home, sids);
  return {
    members,
    resolveSid: (memberId) => resolveSession(memberId, sids) ?? memberId,
    livenessOf: (sid) => fileIsAlive(sid, io),
    inflightOf: (sid) => inflightBySid.get(sid) ?? 0,
    paneOf: (m) => m.title ?? m.member ?? null,
  };
}

/** Compute + atomically write `console/roster.json`. `facts` overrides the real-fs defaults (selftest / future wiring).
 *  Returns the written projection. */
export function writeRosterProjection(home: string, nowSec: number, facts?: Partial<RosterFacts>): ConsoleRosterProjection {
  const merged: RosterFacts = { ...defaultRosterFacts(home), ...facts };
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
