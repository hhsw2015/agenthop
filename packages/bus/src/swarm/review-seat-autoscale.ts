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

/** queue-depth = count of open records, total and per-seat. Expects already-live-filtered records. Pure. */
export function queueDepth(openRecords: readonly ReviewRecord[]): QueueSignal {
  const perSeat: Record<SeatId, number> = {};
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
  const p = ticket.priority ?? Number.POSITIVE_INFINITY; // absent priority = lowest urgency = allowed
  return p >= 2; // P2/P3 only for a fresh seat; P0/P1 blocked
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

/** Parse a review-queue filename `<ticket>.<seat>.json` / `<ticket>.<seat>.done.json`. seat = last token before
 *  (optional) `.done`; ticket = the rest. null when not a review file. Pure. */
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
  return { ticket: stem.slice(0, dot), seat: stem.slice(dot + 1), done };
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

/** Author writes a review request (open record). Atomic temp+rename. */
export async function markReviewOpen(rec: Omit<ReviewRecord, "done">, dir: string = reviewQueueDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${rec.ticket}.${rec.seat}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ author: rec.author, sha: rec.sha, sentSec: rec.sentSec }, null, 2));
  await rename(tmp, file);
}

/** Reviewer's terminal verdict: atomic rename open → `.done`. */
export async function markReviewDone(ticket: string, seat: SeatId, dir: string = reviewQueueDir()): Promise<void> {
  await rename(join(dir, `${ticket}.${seat}.json`), join(dir, `${ticket}.${seat}.done.json`));
}
