/**
 * Console projection PURE core (swarm-console producers ① + ②). Two read-only mirrors the downstream `swarm-console` UI
 * (3e097dfe) renders — this module OWNS only the frozen schemas + the pure shape builders, so what the console contracts
 * against is unit-tested with no filesystem. The IO half (reads the decision-batch store read-only, probes presence
 * liveness, atomically writes under `~/.agenthop/swarm/console/`) lives in `console-projection-store.ts`, mirroring the
 * dual-bandwidth pure-core / `-store` split.
 *
 *   ① decisions mirror — the IN-LIBRARY awaiting-ruling (not-yet-consumed) decision batches, each a VERBATIM
 *     decision-batch-v1 `batch.json` object (see docs/swarm/decision-batch-v1.md).
 *   ② roster glance — a per-seat {sid, tool, pane, alive, inflight} view.
 *
 * Invariants baked in here:
 *  - FC-2 r3 THREE-STATE liveness: `seatAliveOf` maps the EXISTING task-liveness tri-state (alive / suspected / dead) to the
 *    seat three-state (alive / unknown / dead). An unreadable OR absent liveness signal (task-liveness's "suspected", which it
 *    never convicts) becomes "unknown" — NEVER a false "dead". An unexpected value also degrades to "unknown".
 *  - FC-6 DETERMINISTIC: seats are deduped + sorted by sid; batch items keep store order; `generatedAtSec` is sidecar
 *    metadata, never an ordering / identity / latest-wins key.
 *  - FC-7 ADDITIVE: the console/ dir + these schemas are NEW; nothing migrates.
 *
 * Pure: no fs, no clock beyond an injected `nowSec`, no top-level side effects.
 */
import { flagDefaultOn } from "./flag-default.js";
import type { DecisionBatch, DecisionItem } from "./decision-batch.js";
import type { Liveness } from "./task-liveness.js";

/** SWARM_CONSOLE gates BOTH producers — LIVE BY DEFAULT (opt-out via [[flagDefaultOn]], user ruling 2026-10-10 family): on
 *  unless SWARM_CONSOLE is explicitly OFF (`SWARM_CONSOLE=0`, the kill-switch). Read at the call site (never a module-level
 *  constant) so a later setLang/env change is seen. Pure. */
export function consoleProjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_CONSOLE);
}

/** Pure throttle for the dispatcher's console writer, mirroring `shouldSampleGauge`: the sweep ticks faster than the write
 *  interval, so each tick is gated here. True iff at least `intervalSec` has elapsed since `lastWriteSec`. Fail-soft on
 *  misconfig: a non-finite `nowSec` never writes (no clock ⇒ no write); a non-finite or non-positive `intervalSec` degrades to
 *  "write every call" (never silently wedge to "never"). Pure, no IO. */
export function shouldWriteConsole(nowSec: number, lastWriteSec: number, intervalSec: number): boolean {
  if (!Number.isFinite(nowSec)) return false;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return true;
  return nowSec - lastWriteSec >= intervalSec;
}

// ---------------------------------------------------------------------------------------------------------------------
// Producer ① — decision-batch "awaiting ruling" mirror. The payload `batch` is a VERBATIM decision-batch-v1 batch.json.
// ---------------------------------------------------------------------------------------------------------------------

export const CONSOLE_DECISIONS_SCHEMA = "console-decisions/v1" as const;

/** One mirrored awaiting-ruling batch. `batch` is a VERBATIM decision-batch-v1 `batch.json` object (batchId / owner /
 *  createdAtSec / items[]) — the console reads `.batch` exactly as a v1 batch. `schema` + `generatedAtSec` are the frozen-read
 *  envelope (same shape family as bandwidth-gauge/v1); `generatedAtSec` is freshness metadata only (FC-6: not an ordering key). */
export type ConsoleDecisionMirror = {
  schema: typeof CONSOLE_DECISIONS_SCHEMA;
  generatedAtSec: number;
  batch: DecisionBatch;
};

/** Project ONE item to the decision-batch-v1 batch.json item shape: id / kind / summary / suggestedAction, plus the optional
 *  evidenceRef / foldedFrom / hardGate emitted ONLY when present (additive, FC-7). A fresh array copy for foldedFrom so the
 *  output never aliases the store's object. */
function projectItem(it: DecisionItem): DecisionItem {
  return {
    id: it.id,
    kind: it.kind,
    summary: it.summary,
    suggestedAction: it.suggestedAction,
    ...(it.evidenceRef !== undefined ? { evidenceRef: it.evidenceRef } : {}),
    ...(it.foldedFrom !== undefined ? { foldedFrom: [...it.foldedFrom] } : {}),
    ...(it.hardGate ? { hardGate: true } : {}),
  };
}

/** Build the per-batch mirror payload from a (store-validated) batch. Pure + deterministic in (batch, nowSec): the batch is
 *  re-projected field-by-field so the output is EXACTLY the v1 schema (no store-internal key leaks) with item order preserved. */
export function buildDecisionMirror(batch: DecisionBatch, nowSec: number): ConsoleDecisionMirror {
  return {
    schema: CONSOLE_DECISIONS_SCHEMA,
    generatedAtSec: nowSec,
    batch: {
      batchId: batch.batchId,
      owner: batch.owner,
      createdAtSec: batch.createdAtSec,
      items: batch.items.map(projectItem),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Producer ② — per-seat roster glance.
// ---------------------------------------------------------------------------------------------------------------------

export const CONSOLE_ROSTER_SCHEMA = "console-roster/v1" as const;

/** FC-2 r3 three-state: alive | dead | unknown. "unknown" is the SAFE direction for any unreadable/absent liveness signal. */
export type SeatLiveness = "alive" | "dead" | "unknown";

/**
 * FC-2 r3 — map the EXISTING task-liveness tri-state (Liveness = "alive" | "suspected" | "dead") to the seat three-state.
 *  - "alive" ⇒ "alive" (presence pid exists + signal-0 ok/EPERM),
 *  - "dead"  ⇒ "dead"  (the ONE strong death signal — ESRCH),
 *  - "suspected" (no presence pid / file unreadable / unknown errno — task-liveness deliberately NEVER convicts on a weak
 *    signal) ⇒ "unknown". So an unreadable OR absent liveness signal is "unknown", NEVER a false "dead". Any unexpected value
 *    also degrades to "unknown" (defensive; never false-dead). Pure. Reuses the existing liveness model — invents none. */
export function seatAliveOf(raw: Liveness): SeatLiveness {
  return raw === "alive" ? "alive" : raw === "dead" ? "dead" : "unknown";
}

/** One seat's console glance. `sid` is the roster identity (stableId or handle); `pane` is the window/pane label (null when
 *  unknown); `alive` is the FC-2 r3 three-state; `inflight` is the count of live (non-terminal) waits this seat owns. */
export type RosterSeat = { sid: string; tool: string; pane: string | null; alive: SeatLiveness; inflight: number };

/** The frozen roster projection the console reads. `seats` is deterministically ordered (sorted by sid). */
export type ConsoleRosterProjection = {
  schema: typeof CONSOLE_ROSTER_SCHEMA;
  generatedAtSec: number;
  seats: RosterSeat[];
};

/** Normalize one seat: a valid three-state `alive` (else "unknown"); a finite non-negative integer `inflight` (else 0); a
 *  string `tool` (else ""); `pane` as a string or null. Never throws. */
function normalizeSeat(s: RosterSeat): RosterSeat {
  const alive: SeatLiveness = s.alive === "alive" || s.alive === "dead" || s.alive === "unknown" ? s.alive : "unknown";
  const inflight = Number.isFinite(s.inflight) && s.inflight > 0 ? Math.floor(s.inflight) : 0;
  return {
    sid: s.sid,
    tool: typeof s.tool === "string" ? s.tool : "",
    pane: s.pane == null ? null : String(s.pane),
    alive,
    inflight,
  };
}

/** Build the roster projection from already-resolved seat facts. Pure: drops seats with no sid, DEDUPES by sid (first wins),
 *  normalizes each, and SORTS by sid (FC-6 deterministic order — no timestamp decides anything). `generatedAtSec` is sidecar
 *  freshness metadata only. */
export function buildRosterProjection(seats: readonly RosterSeat[], nowSec: number): ConsoleRosterProjection {
  const bySid = new Map<string, RosterSeat>();
  for (const s of seats) {
    if (typeof s.sid !== "string" || s.sid === "") continue;
    if (bySid.has(s.sid)) continue; // dedupe: first occurrence wins (deterministic given input order)
    bySid.set(s.sid, normalizeSeat(s));
  }
  const sorted = [...bySid.values()].sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  return { schema: CONSOLE_ROSTER_SCHEMA, generatedAtSec: nowSec, seats: sorted };
}
