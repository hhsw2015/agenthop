/**
 * idle-explainer PURE core (北极星差距审计件① — idle-root-cause auto-triage). The user's most frequent activation is "why is it
 * idle again?" — every time, the swarm only LOOKS idle (herdr all idle) but the real cause is a ruling in a box no one swept, an
 * author awaiting a verdict, or an empty review seat. This produces a data-driven one-line explanation so the mod status band can
 * render "idle = waiting for X" instead of a bare all-idle view, and raises an S19 only on a GENUINE stall.
 *
 * This module owns the frozen schema + the pure composition (reason text, anomaly rule, alert-onset dedup). The IO (read the four
 * signals, detect idle, atomically write the projection) lives in idle-explainer-store.ts, mirroring the console-projection split.
 *
 * Invariants:
 *  - FC-2 r3 THREE-STATE: every signal is `number | null` (null = the source was UNREADABLE this tick). A genuine-stall anomaly
 *    fires ONLY when idle AND every signal is a CONFIRMED zero — never on a null, because an unreadable source cannot prove a
 *    stall (an unknown is not an emptiness).
 *  - FC-6 DETERMINISTIC: `generatedAtSec` is sidecar freshness metadata, never an ordering/identity/latest-wins key.
 *  - FC-7 ADDITIVE: the console/idle-explainer.json projection + this schema are NEW; nothing migrates.
 * Pure: no fs, no clock beyond an injected nowSec, no top-level side effects.
 */
import { flagDefaultOn } from "./flag-default.js";

/** SWARM_IDLE_EXPLAINER gates the producer — LIVE BY DEFAULT (opt-out via [[flagDefaultOn]]): on unless explicitly OFF
 *  (SWARM_IDLE_EXPLAINER=0). Read at the call site (never a module-level constant) so a later env change is seen. Pure. */
export function idleExplainerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_IDLE_EXPLAINER);
}

export const IDLE_EXPLAINER_SCHEMA = "console-idle-explainer/v1" as const;

/** How "idle" was determined this tick. `wait-ledger` = the control-log's in-flight `kind:"wait"` waits were readable (the
 *  authoritative dispatcher view of active work); `none` = the control-log was UNREADABLE, so idle could NOT be determined
 *  (FC-2 r3 — we never claim idle on an unknown). */
export type IdleSource = "wait-ledger" | "none";

/** The four "why idle" signals. Each is `number | null`: a count, or null when that source was UNREADABLE this tick (FC-2 r3 —
 *  never conflated with a confirmed zero). unclaimedInboxes = pending messages across boxes; reviewQueueDepth = open review-seat
 *  queue items; awaitingRuling = decision batches awaiting a coordinator ruling (not consumed); userGates = hardGate items (needs
 *  the user) inside those awaiting batches. */
export type IdleSignals = {
  unclaimedInboxes: number | null;
  reviewQueueDepth: number | null;
  awaitingRuling: number | null;
  userGates: number | null;
};

/** The frozen projection the mod status band reads. `idle` = all members idle for >= N consecutive ticks (no active dispatched
 *  work). `reason` = the one-line human explanation. `anomaly` = idle AND every signal a CONFIRMED zero ⇒ a genuine stall worth an
 *  S19 (nobody is waiting on anything, yet nothing is happening). */
export type IdleExplainer = {
  schema: typeof IDLE_EXPLAINER_SCHEMA;
  generatedAtSec: number;
  idle: boolean;
  idleSource: IdleSource;
  reason: string;
  signals: IdleSignals;
  anomaly: boolean;
};

/** A genuine-stall anomaly: idle AND every one of the four signals is a CONFIRMED zero. A single null (unreadable) signal ⇒ NOT an
 *  anomaly — an unknown cannot prove "nothing is pending" (FC-2 r3). Not idle ⇒ never an anomaly. Pure. */
export function isIdleAnomaly(idle: boolean, s: IdleSignals): boolean {
  if (!idle) return false;
  const vals = [s.unclaimedInboxes, s.reviewQueueDepth, s.awaitingRuling, s.userGates];
  if (vals.some((v) => v === null)) return false; // an unreadable source ⇒ cannot assert a stall
  return vals.every((v) => v === 0);
}

/** Compose the one-line status-band reason. Not idle ⇒ "active". Idle ⇒ the actionable waits, most-decision-relevant first
 *  (awaiting-ruling → review → unclaimed boxes → user gate); then, if nothing is pending, either a genuine-stall line (all
 *  confirmed zero) or a degraded line naming the unreadable sources (never a false "genuine stall" on an unknown). Pure. */
export function idleReason(idle: boolean, s: IdleSignals): string {
  if (!idle) return "active";
  const parts: string[] = [];
  if ((s.awaitingRuling ?? 0) > 0) parts.push(`${s.awaitingRuling} awaiting ruling`);
  if ((s.reviewQueueDepth ?? 0) > 0) parts.push(`${s.reviewQueueDepth} in review`);
  if ((s.unclaimedInboxes ?? 0) > 0) parts.push(`${s.unclaimedInboxes} unclaimed in boxes`);
  if ((s.userGates ?? 0) > 0) parts.push(`${s.userGates} awaiting user`);
  if (parts.length > 0) return `idle — waiting: ${parts.join("; ")}`;
  const unreadable = ([
    ["inbox", s.unclaimedInboxes], ["review", s.reviewQueueDepth], ["ruling", s.awaitingRuling], ["user-gate", s.userGates],
  ] as const).filter(([, v]) => v === null).map(([k]) => k);
  if (unreadable.length > 0) return `idle — some signals unreadable (${unreadable.join(", ")}); cannot confirm a stall`;
  return "idle — nothing in-flight, pending, in review, or gated (genuine stall — check the swarm)";
}

/** Build the projection from the detected idle state + already-read signals. Pure + deterministic in its inputs. */
export function buildIdleExplainer(i: { idle: boolean; idleSource: IdleSource; signals: IdleSignals; nowSec: number }): IdleExplainer {
  return {
    schema: IDLE_EXPLAINER_SCHEMA,
    generatedAtSec: i.nowSec,
    idle: i.idle,
    idleSource: i.idleSource,
    reason: idleReason(i.idle, i.signals),
    signals: i.signals,
    anomaly: isIdleAnomaly(i.idle, i.signals),
  };
}

/** S19 dedup: alert ONLY on the anomaly ONSET (a non-anomaly → anomaly transition), never every tick a stall persists. Pure. */
export function shouldAlertOnset(prevAnomaly: boolean, currAnomaly: boolean): boolean {
  return currAnomaly && !prevAnomaly;
}
