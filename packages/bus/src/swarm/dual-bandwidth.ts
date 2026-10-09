/**
 * Dual-bandwidth gauge pure core (T5-2, DHH-eval borrow — grounds in docs/research/dhh-16thread-eval.md). DHH's deep insight:
 * the bottleneck is HUMAN JUDGMENT bandwidth, not agent throughput — "the faster the agents run, the fewer threads I can run"
 * (38:21). When the rate at which agents PRODUCE items needing a human verdict outruns the rate at which the user CONSUMES
 * (clears) those verdicts, the backlog grows unbounded and the user drowns. Today that imbalance is invisible. This gauge makes
 * it a reading: two bandwidths (produce / consume), their ratio, the backlog and its drain time, and a zone the coordinator
 * acts on (compress harder / throttle thread-opening).
 *
 * DESIGN LAW (DHH 18:51): the gauge MEASURES so the coordinator can COMPRESS or THROTTLE; it is a sensor, never an approval or
 * latency hop. RED means "open fewer threads" (R18 two-tier: concurrency bounded by B_cons), NOT "add an approval gate".
 *
 * Pure: no fs, no clock beyond the injected `nowSec`, so the window math + zone thresholds are unit-tested without disk. The IO
 * half (scan decision-batch / chat-room / inbox durable files → event timestamps) lives in dual-bandwidth-store.ts. This core
 * takes two already-classified timestamp streams and the current backlog, and never reads a source.
 *
 * Coordinator rulings folded (2026-10-08): (1) two numbers per bandwidth — a rolling-window RATE (real-time imbalance) + a
 * session-cumulative COUNT (daily-report base); (2) thresholds 0.8/1.2 are tunable constants to start; (3) B_cons counts ONLY
 * real decisions (approve/reject/defer + 呈批 verdicts), NEVER chat-room sign-offs (communication is not a decision — folding it
 * in would inflate the apparent consume rate) — that classification is the IO layer's job, this core just takes the streams.
 */

/** The coordinator-facing zone. GREEN = carry on; AMBER = compress harder (bigger batches, defer low-priority, merge 呈批);
 *  RED = throttle thread-opening (never an approval hop). */
import { digestOf } from "./digest.js";

export type BwZone = "green" | "amber" | "red";

/** Tunable thresholds + window (coordinator ruling (2): constants to start, recalibrate after a week). */
export type DualBandwidthConfig = {
  windowSec?: number;          // rolling window for the main rate (default 3600 = 1h)
  amberRatio?: number;         // ratio above this (and ≤ redRatio) ⇒ at least AMBER (default 0.8)
  redRatio?: number;           // ratio above this ⇒ RED (default 1.2)
  backlogSoftCap?: number;     // backlog at/above this ⇒ at least AMBER (default 20)
  backlogHardCap?: number;     // backlog above this ⇒ RED (default 50)
  tDrainHorizonHours?: number; // drain time above this ⇒ RED (default 8)
  skewToleranceSec?: number;   // max future clock skew tolerated; an event past now+this is IGNORED (default 300 = 5min, T52-P2-4)
};

/** One gauge reading. Rates are PER HOUR. `ratio` / `tDrainHours` are null when undefined (no consumption in the window): a
 *  non-serializable Infinity is never emitted — the zone carries the severity instead. */
export type DualBandwidthReading = {
  bProd1h: number;            // produce rate over the window, per hour
  bCons1h: number;            // consume (real-decision) rate over the window, per hour
  bProdTotal: number;         // cumulative produce events this session
  bConsTotal: number;         // cumulative consume events this session
  ratio: number | null;       // bProd1h / bCons1h; null when bCons1h === 0 (undefined)
  backlog: number;            // D — current undecided count
  dBacklogDtPerHour: number;  // net backlog growth rate = bProd1h - bCons1h (dD/dt)
  tDrainHours: number | null; // backlog / bCons1h; 0 when backlog === 0; null when bCons1h === 0 and backlog > 0 (never drains)
  zone: BwZone;
};

export type DualBandwidthInput = {
  nowSec: number;
  produceAtSec: readonly number[]; // timestamps (sec) of items that needed a human verdict (decision-batch opens + 呈批/签收/并库/立项)
  consumeAtSec: readonly number[]; // timestamps (sec) of REAL decisions cleared (consume verdicts + 呈批 verdicts) — NO chat sign-offs
  backlog: number;                 // D — current undecided count (from the IO layer)
  config?: DualBandwidthConfig;
};

const DEFAULTS = { windowSec: 3600, amberRatio: 0.8, redRatio: 1.2, backlogSoftCap: 20, backlogHardCap: 50, tDrainHorizonHours: 8, skewToleranceSec: 300 };

function resolveConfig(c: DualBandwidthConfig = {}): Required<DualBandwidthConfig> {
  const cfg = { ...DEFAULTS, ...c };
  // Reject an invalid config LOUDLY — never silently disable a threshold or emit a NaN/Infinity reading (mirrors RoomRateLimiter).
  // windowSec must be ≥ 1: a sub-second window underflows `windowSec/3600` toward 0 and makes the per-hour rate Infinity/NaN (T52-P2-5).
  if (!Number.isFinite(cfg.windowSec) || cfg.windowSec < 1 || cfg.windowSec > Number.MAX_SAFE_INTEGER) throw new Error(`dual-bandwidth: windowSec must be a finite number in [1, ${Number.MAX_SAFE_INTEGER}] (got ${String(c.windowSec)})`);
  if (!Number.isFinite(cfg.amberRatio) || cfg.amberRatio <= 0) throw new Error(`dual-bandwidth: amberRatio must be a positive finite number (got ${String(c.amberRatio)})`);
  if (!Number.isFinite(cfg.redRatio) || cfg.redRatio <= 0) throw new Error(`dual-bandwidth: redRatio must be a positive finite number (got ${String(c.redRatio)})`);
  if (cfg.redRatio <= cfg.amberRatio) throw new Error(`dual-bandwidth: redRatio (${cfg.redRatio}) must exceed amberRatio (${cfg.amberRatio})`);
  if (!Number.isInteger(cfg.backlogSoftCap) || cfg.backlogSoftCap < 0) throw new Error(`dual-bandwidth: backlogSoftCap must be a non-negative integer (got ${String(c.backlogSoftCap)})`);
  if (!Number.isInteger(cfg.backlogHardCap) || cfg.backlogHardCap < 0) throw new Error(`dual-bandwidth: backlogHardCap must be a non-negative integer (got ${String(c.backlogHardCap)})`);
  if (cfg.backlogHardCap < cfg.backlogSoftCap) throw new Error(`dual-bandwidth: backlogHardCap (${cfg.backlogHardCap}) must be ≥ backlogSoftCap (${cfg.backlogSoftCap})`);
  if (!Number.isFinite(cfg.tDrainHorizonHours) || cfg.tDrainHorizonHours <= 0) throw new Error(`dual-bandwidth: tDrainHorizonHours must be a positive finite number (got ${String(c.tDrainHorizonHours)})`);
  if (!Number.isFinite(cfg.skewToleranceSec) || cfg.skewToleranceSec < 0) throw new Error(`dual-bandwidth: skewToleranceSec must be a non-negative finite number (got ${String(c.skewToleranceSec)})`);
  return cfg;
}

/** An event timestamp is COUNTABLE if finite and not past `now + skewTolerance`: a far-future stamp (clock bug / bogus data) is
 *  ignored, never counted (T52-P2-4 — a verdict dated a year out must not inflate the current reading). */
function countable(t: number, upperSec: number): boolean { return Number.isFinite(t) && t <= upperSec; }

/** Count countable timestamps inside the rolling window (now-windowSec, now+skew], normalized to a PER-HOUR rate. */
function rateInWindow(atSec: readonly number[], nowSec: number, windowSec: number, upperSec: number): number {
  const cutoff = nowSec - windowSec;
  let n = 0;
  for (const t of atSec) if (countable(t, upperSec) && t > cutoff) n += 1;
  return n / (windowSec / 3600); // normalize the count to a PER-HOUR rate regardless of window length
}

/** Count all countable timestamps (session cumulative) — same future-skew bound as the window rate. */
function countTotal(atSec: readonly number[], upperSec: number): number {
  let n = 0;
  for (const t of atSec) if (countable(t, upperSec)) n += 1;
  return n;
}

/**
 * Compute the dual-bandwidth reading from two timestamp streams + the current backlog. Deterministic in `nowSec`. The IO layer
 * classifies events into the two streams (and excludes chat sign-offs from `consumeAtSec`, ruling (3)); this core only aggregates.
 */
export function computeDualBandwidth(input: DualBandwidthInput): DualBandwidthReading {
  const cfg = resolveConfig(input.config);
  if (!Number.isFinite(input.nowSec)) throw new Error(`dual-bandwidth: nowSec must be a finite number (got ${String(input.nowSec)})`);
  // Number.isSafeInteger (not just isInteger): Number.MAX_VALUE IS an integer but overflows backlog/bCons arithmetic into
  // Infinity (which JSON would turn into a null that reads as "no consumption"). A safe-integer bound keeps every derived value finite (T52-P2-5).
  if (!Number.isSafeInteger(input.backlog) || input.backlog < 0) throw new Error(`dual-bandwidth: backlog must be a safe non-negative integer (got ${String(input.backlog)})`);

  const upperSec = input.nowSec + cfg.skewToleranceSec; // future-skew bound shared by the rate and the cumulative count
  const bProd1h = rateInWindow(input.produceAtSec, input.nowSec, cfg.windowSec, upperSec);
  const bCons1h = rateInWindow(input.consumeAtSec, input.nowSec, cfg.windowSec, upperSec);
  const bProdTotal = countTotal(input.produceAtSec, upperSec);
  const bConsTotal = countTotal(input.consumeAtSec, upperSec);
  const consuming = bCons1h > 0;
  const backlog = input.backlog;

  const ratio = consuming ? bProd1h / bCons1h : null;
  const dBacklogDtPerHour = bProd1h - bCons1h;
  const tDrainHours = backlog === 0 ? 0 : consuming ? backlog / bCons1h : null; // null ⇒ never drains (no consumption)

  // Zone, precedence RED > AMBER > GREEN.
  //  RED  : ratio > redRatio (or producing with ZERO consumption = max imbalance) · backlog over hard cap · drain over horizon
  //         (a null drain = "never drains" while backlog > 0 exceeds any horizon).
  //  AMBER: ratio > amberRatio · backlog rising (dD/dt > 0) · backlog at/over soft cap.
  const ratioRed = consuming ? ratio! > cfg.redRatio : bProd1h > 0;
  const drainRed = tDrainHours === null ? backlog > 0 : tDrainHours > cfg.tDrainHorizonHours;
  let zone: BwZone;
  if (ratioRed || backlog > cfg.backlogHardCap || drainRed) zone = "red";
  else if ((consuming && ratio! > cfg.amberRatio) || dBacklogDtPerHour > 0 || backlog >= cfg.backlogSoftCap) zone = "amber";
  else zone = "green";

  // Final guard (T52-P2-5 B): a derived value must never be non-finite. With consumption present, an arithmetic overflow must
  // THROW loudly — never be emitted as an Infinity that JSON silently turns into the "no consumption" null. (null is ONLY the
  // legitimate undefined — bCons1h === 0 — handled above; here `consuming` guarantees these are real divisions.)
  const nonFinite =
    !Number.isFinite(bProd1h) || !Number.isFinite(bCons1h) || !Number.isFinite(dBacklogDtPerHour) ||
    (consuming && !Number.isFinite(ratio as number)) || (consuming && backlog > 0 && !Number.isFinite(tDrainHours as number));
  if (nonFinite) throw new Error(`dual-bandwidth: a derived value overflowed to non-finite (windowSec/backlog/counts out of range) — refusing to emit a null-masquerade`);

  return { bProd1h, bCons1h, bProdTotal, bConsTotal, ratio, backlog, dBacklogDtPerHour, tDrainHours, zone };
}

// ============================================================================================================
// submit-tag (T5-2 secondary-source seam) — produce-event merge with de-dup. Pure.
// ============================================================================================================

/** The stable content digest of a tagged `submit` — the de-dup key shared by the raw submit scan AND the `foldedFrom` stamp a
 *  decision-batch item carries when it compresses that submit. Content-addressed (NOT time-keyed) so a submit observed at post
 *  time and the later batch item it is folded into resolve to the SAME key. Two byte-identical submissions by the same author
 *  collide to one (a benign de-dup of a resend). The fold path MUST stamp foldedFrom with this exact function. */
export function submitDigest(from: string, text: string): string {
  return digestOf({ from, text });
}

export type ProduceMergeInput = {
  /** One per decision-batch item: a stable per-item digest, the batch's createdAtSec, and the submit digests it folded (empty = a
   *  native item not derived from a tagged submit). */
  batchItems: readonly { digest: string; createdAtSec: number; foldedFrom: readonly string[] }[];
  /** One per observed tagged `submit`: its content digest (submitDigest) and the second it was posted. */
  submits: readonly { digest: string; atSec: number }[];
};

/**
 * Merge decision-batch produce + tagged submits into B_prod events, each LOGICAL submission counted ONCE by digest at its
 * EARLIEST timestamp (coordinator R3-b: B_prod = N — N logical items are N units of demand; compression is a CONSUME-side
 * efficiency, it must NOT shrink the demand count). A batch item that folded submit(s) contributes those submit digests (at the
 * item's createdAtSec as a floor), so a folded submit is counted once whether or not it was also observed raw; a native item (no
 * fold) contributes its own digest. Returns the produce timestamps (seconds). Pure.
 */
export function mergeProduceEvents(inp: ProduceMergeInput): number[] {
  const earliest = new Map<string, number>();
  const add = (digest: string, atSec: number): void => {
    const e = earliest.get(digest);
    if (e === undefined || atSec < e) earliest.set(digest, atSec);
  };
  for (const s of inp.submits) add(s.digest, s.atSec);
  for (const it of inp.batchItems) {
    if (it.foldedFrom.length > 0) for (const d of it.foldedFrom) add(d, it.createdAtSec);
    else add(it.digest, it.createdAtSec);
  }
  return [...earliest.values()];
}
