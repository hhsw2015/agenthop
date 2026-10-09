/**
 * review-seat-autoscale — scale the adversarial-review seat pool to queue depth (S14 T5-5).
 *
 * Why: the DHH baseline audit (docs/swarm/architecture-review-dhh-baseline.md #5) found the reviewer seat is the real
 * bottleneck — review is un-self-reviewable, so its cost is O(N tickets) and cannot be compressed the way member events
 * can. "Reviewers = agents = scale" was only DESIGN-true (2 codex seats queued in practice). This makes it practice-true:
 * spawn a seat when the review queue deepens, reclaim one when it drains, with hysteresis so a flapping queue never
 * churns seats.
 *
 * Pure core (selftested): queue-depth from the durable ledger, the scale decision (hysteresis + sustain window +
 * min-dwell + floor), seat selection for reclaim (amendment ①: idle + no in-flight, NOT merely newest), and the
 * new-seat first-ticket slow-start band (amendment ②, dispatch-side). IO shell below (ledger file, presence, spawn/
 * despawn) is exercised by live runs; all scaling actions are gated by a dormant flag + the CPA budget (over-budget =
 * a money gate that belongs to the user, R16).
 */

import type { ModelTier } from "./task-plan.js";

// ============================================================================================================
// Pure core (selftested in review-seat-autoscale.selftest.mts)
// ============================================================================================================

export type SeatId = string;

/** A review-queue record: one outstanding (or finished) review assigned to a seat. */
export interface ReviewRecord {
  ticket: string;
  seat: SeatId;
  author: string;
  sha: string;
  sentSec: number;
  done: boolean;
}

/** Live-observed state of a review seat (presence + ledger-derived in-flight + battle history). */
export interface SeatState {
  seat: SeatId;
  live: boolean; // presence: process alive
  idle: boolean; // presence: not mid-review right now
  inFlight: number; // open records to this seat's name
  completedReviews: number; // finished reviews — battle history (slow-start gate)
  spawnedSec: number; // for seniority tiebreak
  floor: boolean; // one of the original floor seats — never reclaim
}

export interface QueueSignal {
  totalOpen: number;
  perSeat: Record<SeatId, number>;
}

export interface ScaleConfig {
  kUp: number; // scale-up threshold: open per seat (K_up)
  kDown: number; // scale-down threshold: open per seat (K_down); hysteresis requires kUp > kDown
  floor: number; // minimum seat count (never reclaim below this); default 2
  sustainSec: number; // the signal must hold this long (debounce window)
  minDwellSec: number; // minimum time between any two scaling actions
}

export type ScaleAction =
  | { action: "scale-up" }
  | { action: "scale-down"; seat: SeatId }
  | { action: "hold"; reason: string };

/**
 * Phantom-depth guard: keep only records whose author AND seat are both live. A crashed author's orphan review must
 * not inflate the queue and pull a needless seat (CORE law 4: two evidence faces; suspected≠dead). Pure.
 */
export function filterLiveRecords(records: readonly ReviewRecord[], liveAuthors: ReadonlySet<string>, liveSeats: ReadonlySet<SeatId>): ReviewRecord[] {
  return records.filter((r) => !r.done && liveAuthors.has(r.author) && liveSeats.has(r.seat));
}

/** queue-depth = count of open records, total and per-seat. Expects already-live-filtered records. Uses a
 *  NULL-prototype map so a seat named `toString`/`constructor`/`__proto__` counts as a plain own key and never reads an
 *  inherited property (T55-P2-2); Σ per-seat === totalOpen for any seat names. Pure. */
export function queueDepth(openRecords: readonly ReviewRecord[]): QueueSignal {
  const perSeat: Record<SeatId, number> = Object.create(null);
  for (const r of openRecords) perSeat[r.seat] = (perSeat[r.seat] ?? 0) + 1;
  return { totalOpen: openRecords.length, perSeat };
}

/**
 * Amendment ②: new-seat first-ticket slow-start band (DISPATCH-side rule, not a seat property). A seat with no battle
 * history (completedReviews === 0) may only take a LOW-priority (P2 or lower, i.e. priority number ≥ 2) or small first
 * ticket — a fresh seat born straight into a P0/P1 heavy ticket has no calibration and an unknown misjudgment rate.
 * Once it has cleared one review, no restriction. Pure.
 */
export function canRouteToSeat(ticket: { priority?: number; small?: boolean }, seat: { completedReviews: number }): boolean {
  if (seat.completedReviews > 0) return true; // calibrated — full rotation
  if (ticket.small === true) return true; // small first ticket is allowed
  // Fresh seat: route ONLY on EXPLICIT low priority (P2/P3). Absent/unknown priority cannot be confirmed low-stakes, so
  // it is REJECTED (fail-closed) — the band is a safety gate, and an uncalibrated seat must not take an unknown ticket.
  return typeof ticket.priority === "number" && ticket.priority >= 2;
}

/**
 * Amendment ①: pick a seat to reclaim. ONLY a live, idle, in-flight=0, non-floor seat is eligible — never kill a seat
 * mid-review (that discards its context and forces a whole re-review). Among eligible seats, reclaim the NEWEST
 * (youngest seniority) so the earlier-spawned extras persist. null when none is eligible ("都忙则不缩，等窗"). Pure.
 */
export function selectSeatToReclaim(seats: readonly SeatState[]): SeatId | null {
  const eligible = seats.filter((s) => s.live && s.idle && s.inFlight === 0 && !s.floor);
  if (eligible.length === 0) return null;
  return eligible.reduce((newest, s) => (s.spawnedSec > newest.spawnedSec ? s : newest)).seat;
}

/**
 * The scale decision. Hysteresis (kUp > kDown) + a sustain window + a min-dwell between actions. `sustainedSec` is how
 * long the CURRENT instantaneous want (up or down) has continuously held (the loop resets it when the want flips).
 * Budget/dormant gates are applied by the IO caller, not here. Pure.
 */
export function scaleDecision(
  signal: QueueSignal,
  seats: readonly SeatState[],
  cfg: ScaleConfig,
  sinceLastActionSec: number,
  sustainedSec: number,
): ScaleAction {
  const n = seats.filter((s) => s.live).length;
  // The autoscaler flexes ONLY above the floor. Below floor (a standing seat crashed) is NOT its job to top up — the
  // roster / swarm-resume / sweep own standing-member liveness (one owner, F22). Hold and let them restore the baseline
  // first; this also avoids a double-spawn race with resume on restart.
  if (n < cfg.floor) return { action: "hold", reason: "below floor — roster restores baseline, autoscaler flexes only above" };
  if (sinceLastActionSec < cfg.minDwellSec) return { action: "hold", reason: "min-dwell not elapsed" };

  const wantUp = signal.totalOpen > n * cfg.kUp;
  const wantDown = signal.totalOpen < (n - 1) * cfg.kDown;

  if (wantUp) {
    return sustainedSec >= cfg.sustainSec ? { action: "scale-up" } : { action: "hold", reason: "up not sustained" };
  }
  if (wantDown && n > cfg.floor) {
    const seat = selectSeatToReclaim(seats);
    if (seat === null) return { action: "hold", reason: "no idle+empty seat; wait" };
    return sustainedSec >= cfg.sustainSec ? { action: "scale-down", seat } : { action: "hold", reason: "down not sustained" };
  }
  return { action: "hold", reason: wantDown ? "at floor" : "within band" };
}

/**
 * SUGGESTION-MODE planner (user ruling 2026-10-08: the autoscale flag is HALF-flipped — the dispatcher only ADVISES the
 * coordinator, it NEVER spawns or reclaims a seat itself). Composes the phantom-depth filter → queue-depth → scaleDecision
 * and renders a non-hold action as a one-line suggestion; returns null on hold (nothing to advise). Pure — the dispatcher
 * gathers presence + the cross-tick timings and delivers the text to the coordinator's durable inbox (S11, taskRef=
 * autoscale-suggest). The action is returned alongside the text purely so a caller can log/key on it; it is NOT executed.
 */
export function planAutoscaleSuggestion(input: {
  records: readonly ReviewRecord[];
  liveAuthors: ReadonlySet<string>;
  liveSeats: ReadonlySet<SeatId>;
  seats: readonly SeatState[];
  cfg: ScaleConfig;
  sinceLastActionSec: number;
  sustainedSec: number;
}): { action: ScaleAction; text: string } | null {
  const open = filterLiveRecords(input.records, input.liveAuthors, input.liveSeats);
  const signal = queueDepth(open);
  const action = scaleDecision(signal, input.seats, input.cfg, input.sinceLastActionSec, input.sustainedSec);
  if (action.action === "hold") return null;
  const nLive = input.seats.filter((s) => s.live).length;
  const text =
    action.action === "scale-up"
      ? `review queue deep: ${signal.totalOpen} open across ${nLive} live seat(s) (K_up=${input.cfg.kUp}) — SUGGEST spawning one more review seat`
      : `review queue drained: ${signal.totalOpen} open across ${nLive} live seat(s) — SUGGEST reclaiming idle seat "${action.seat}"`;
  return { action, text };
}

export interface SeatBirthCert {
  roleProfile: "reviewer";
  tool: "codex";
  modelTier: ModelTier;
  cwd: string;
  seatLabel: string;
  notebookTemplate: string; // the reviewer notebook: adversarial protocol + S27/28/29 + honesty taxonomy
}

/** Birth certificate for a spawned review seat (the spawn envelope). Pure. */
export function buildReviewSeatBirthCert(n: number, cwd: string): SeatBirthCert {
  return {
    roleProfile: "reviewer",
    tool: "codex",
    modelTier: "heavy",
    cwd,
    seatLabel: `review-seat-${n}`,
    notebookTemplate: "reviewer", // resolved to the notebook template at spawn (CORE onboarding)
  };
}

/** A review ticket/seat id must be a dot-free token and not the reserved word `done`, so the `<ticket>.<seat>[.done].json`
 *  filename round-trips unambiguously (T55-P2-3): a dot would mis-split, and a seat literally named `done` would collide
 *  with the done-marker. The writer rejects non-conforming ids; the parser rejects non-conforming filenames. Pure. */
const REVIEW_ID = /^[A-Za-z0-9_-]+$/;
export function isValidReviewId(s: string): boolean {
  return typeof s === "string" && REVIEW_ID.test(s) && s !== "done";
}

/** Parse a review-queue filename `<ticket>.<seat>.json` / `<ticket>.<seat>.done.json`. seat = last token before
 *  (optional) `.done`; ticket = the rest. null when not a review file OR either id is non-conforming (T55-P2-3). Pure. */
export function parseReviewFileName(name: string): { ticket: string; seat: string; done: boolean } | null {
  if (!name.endsWith(".json")) return null;
  let stem = name.slice(0, -".json".length);
  let done = false;
  if (stem.endsWith(".done")) {
    done = true;
    stem = stem.slice(0, -".done".length);
  }
  const dot = stem.lastIndexOf(".");
  if (dot <= 0 || dot === stem.length - 1) return null; // need both a ticket and a seat
  const ticket = stem.slice(0, dot);
  const seat = stem.slice(dot + 1);
  if (!isValidReviewId(ticket) || !isValidReviewId(seat)) return null; // non-round-trippable id ⇒ reject
  return { ticket, seat, done };
}

/**
 * The raw instantaneous want BEFORE the sustain/dwell gates — for a caller that tracks how long a want has continuously held
 * (suggestion mode tracks this across ticks to feed sustainedSec into planAutoscaleSuggestion). Mirrors scaleDecision's
 * wantUp/wantDown exactly, including the below-floor and at-floor guards (so a tracked "none" matches scaleDecision's hold).
 * Pure.
 */
export function instantaneousWant(signal: QueueSignal, seats: readonly SeatState[], cfg: ScaleConfig): "up" | "down" | "none" {
  const n = seats.filter((s) => s.live).length;
  if (n < cfg.floor) return "none"; // below floor: roster restores the baseline, autoscaler flexes only above
  if (signal.totalOpen > n * cfg.kUp) return "up";
  if (signal.totalOpen < (n - 1) * cfg.kDown && n > cfg.floor) return "down";
  return "none";
}

/**
 * Derive SeatState[] for SUGGESTION mode from the durable ledger + a live-seat set (presence). Pure. Per seat that appears
 * in the ledger: inFlight = its open records, completedReviews = its done records, spawnedSec = its earliest record's
 * sentSec (a seniority proxy), live = membership in liveSeats, idle = inFlight === 0 (a LEDGER proxy — a seat with no open
 * record is treated as idle; the coordinator verifies true idle before acting on a reclaim suggestion). floor = the
 * cfg.floor most-senior LIVE seats (never reclaimed). KNOWN BOUNDARY: only seats that appear in the ledger are built, so a
 * live reviewer seat that has never held a review is NOT counted — n is biased low, i.e. toward an over-provisioning
 * (scale-up) suggestion; acceptable because the output is advisory and the coordinator confirms the real seat count. Uses a
 * Map (not an object) so a seat named `toString`/`__proto__`/`constructor` is a plain key (no prototype collision).
 */
export function buildSeatStatesFromLedger(
  records: readonly ReviewRecord[],
  liveSeats: ReadonlySet<SeatId>,
  cfg: ScaleConfig,
  nowSec: number,
): SeatState[] {
  const agg = new Map<SeatId, { inFlight: number; completed: number; earliest: number }>();
  for (const r of records) {
    const e = agg.get(r.seat) ?? { inFlight: 0, completed: 0, earliest: r.sentSec > 0 ? r.sentSec : nowSec };
    if (r.done) e.completed += 1; else e.inFlight += 1;
    if (r.sentSec > 0 && r.sentSec < e.earliest) e.earliest = r.sentSec;
    agg.set(r.seat, e);
  }
  const seniority = (a: [SeatId, { earliest: number }], b: [SeatId, { earliest: number }]): number =>
    a[1].earliest - b[1].earliest || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const floorSet = new Set<SeatId>(
    [...agg].filter(([seat]) => liveSeats.has(seat)).sort(seniority).slice(0, Math.max(0, cfg.floor)).map(([seat]) => seat),
  );
  return [...agg].map(([seat, e]) => ({
    seat,
    live: liveSeats.has(seat),
    idle: e.inFlight === 0,
    inFlight: e.inFlight,
    completedReviews: e.completed,
    spawnedSec: e.earliest,
    floor: floorSet.has(seat),
  }));
}

/**
 * Canonicalize review records against presence for suggestion mode (AS-P2-1 + AS-P2-2). `resolveLive(id)` must resolve an
 * identity to its CANONICAL native session id AND confirm the process is actually alive (a pid file alone is not life — a
 * stale file pointing at a dead pid resolves but is NOT live), returning null for a dead/unresolvable id. Each record keeps
 * ALL its work (a 5-ticket queue stays 5 tickets), but two ALIASES of one seat (e.g. a full sid and its short prefix) both
 * map to the one canonical id, so capacity is never inflated by an alias; a dead/unresolvable seat or author keeps its RAW id
 * (absent from liveSeats/liveAuthors ⇒ excluded downstream, never counted). Returns the canonicalized records + the canonical
 * live id sets. Pure; `resolveLive` is injected (the IO — presence + kill(0) — lives in the caller). resolveLive is memoized
 * per distinct id.
 */
export function canonicalizeLiveRecords(
  records: readonly ReviewRecord[],
  resolveLive: (id: string) => string | null,
): { records: ReviewRecord[]; liveAuthors: Set<string>; liveSeats: Set<SeatId> } {
  const liveAuthors = new Set<string>();
  const liveSeats = new Set<SeatId>();
  const memo = new Map<string, string | null>();
  const canon = (id: string): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    const c = resolveLive(id);
    memo.set(id, c);
    return c;
  };
  const out = records.map((r) => {
    const cSeat = canon(r.seat);
    const cAuthor = r.author !== "" ? canon(r.author) : null;
    if (cSeat !== null) liveSeats.add(cSeat);
    if (cAuthor !== null) liveAuthors.add(cAuthor);
    return { ...r, seat: cSeat ?? r.seat, author: cAuthor ?? r.author };
  });
  return { records: out, liveAuthors, liveSeats };
}

// ============================================================================================================
// IO shell — ledger + wiring (exercised by live/integration runs, NOT the selftest)
// ============================================================================================================

import { readdir, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** `review-seat-autoscale` on, default OFF (dormant-ahead-of-use, like SWARM_BOARD_ADMIT). */
export function autoscaleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_REVIEW_AUTOSCALE ?? "");
}

export function reviewQueueDir(home: string = homedir()): string {
  return join(home, ".agenthop", "swarm", "review-queue");
}

/** Read the ledger directory into records (open + done). Missing dir ⇒ empty. */
export async function readReviewLedger(dir: string = reviewQueueDir()): Promise<ReviewRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ReviewRecord[] = [];
  for (const name of names) {
    const parsed = parseReviewFileName(name);
    if (!parsed) continue;
    let meta: { author?: string; sha?: string; sentSec?: number } = {};
    try {
      meta = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      /* body optional; filename carries ticket/seat/done */
    }
    out.push({ ticket: parsed.ticket, seat: parsed.seat, author: meta.author ?? "", sha: meta.sha ?? "", sentSec: meta.sentSec ?? 0, done: parsed.done });
  }
  return out;
}

/** Author writes a review request (open record). Rejects non-conforming ids BEFORE writing (T55-P2-3). Atomic temp+rename. */
export async function markReviewOpen(rec: Omit<ReviewRecord, "done">, dir: string = reviewQueueDir()): Promise<void> {
  if (!isValidReviewId(rec.ticket) || !isValidReviewId(rec.seat)) {
    throw new Error(`invalid review id (ticket/seat must match ${REVIEW_ID} and not be 'done'): ${rec.ticket}.${rec.seat}`);
  }
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${rec.ticket}.${rec.seat}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ author: rec.author, sha: rec.sha, sentSec: rec.sentSec }, null, 2));
  await rename(tmp, file);
}

/** Reviewer's terminal verdict: atomic rename open → `.done`. Rejects non-conforming ids (T55-P2-3). */
export async function markReviewDone(ticket: string, seat: SeatId, dir: string = reviewQueueDir()): Promise<void> {
  if (!isValidReviewId(ticket) || !isValidReviewId(seat)) throw new Error(`invalid review id: ${ticket}.${seat}`);
  await rename(join(dir, `${ticket}.${seat}.json`), join(dir, `${ticket}.${seat}.done.json`));
}
