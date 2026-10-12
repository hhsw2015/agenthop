/**
 * idle-explainer PURE core (北极星差距审计件① — idle-root-cause auto-triage). The user's most frequent activation is "why is it
 * idle again?" — every time, the swarm only LOOKS idle (herdr all idle) but the real cause is a ruling in a box no one swept, an
 * author awaiting a verdict, or an empty review seat. This produces a data-driven one-line explanation so the mod status band can
 * render "idle = waiting for X" instead of a bare all-idle view, and raises an S19 only on an UNEXPLAINED idle.
 *
 * Owns the frozen schema + the pure composition (reason text, anomaly rule, alert-onset). The IO (detect idle, read the signals,
 * atomically write the projection) lives in idle-explainer-store.ts, mirroring the console-projection split.
 *
 * Activity model (codex IE-1): "idle" is measured from the LEDGER — the control-log's live RUNNING/RESULT_PENDING_VALIDATION
 * ATTEMPTS (a member actively executing a dispatched task). It is NOT measured from waits: a `kind:"wait"` query-wait or a
 * `kind:"approval"` wait means the member is BLOCKED awaiting input/a ruling (herdr shows idle) — those are REASONS, not activity.
 * `idleSource` labels this honestly as a ledger view; an UNREADABLE control-log ⇒ idleSource "unknown" ⇒ NOT idle and NOT active
 * (an unknown activity is never written as "active"). A member working with no control-log attempt (e.g. a private sub-agent) is a
 * known ledger-proxy limitation — hence the anomaly is framed as "unexplained idle, verify", never "proven stall".
 *
 * Invariants:
 *  - FC-2 r3 THREE-STATE: every signal is number|null (null = UNREADABLE this tick). An anomaly fires ONLY when idle AND every
 *    signal is a CONFIRMED zero — never on a null (an unknown is not an emptiness).
 *  - FC-6 DETERMINISTIC: generatedAtSec is sidecar freshness, never an ordering/identity/latest-wins key.
 *  - FC-7 ADDITIVE: the console/idle-explainer.json projection + this schema are NEW; nothing migrates.
 * Pure: no fs, no clock beyond an injected nowSec, no top-level side effects.
 */
import { flagDefaultOn } from "./flag-default.js";

/** SWARM_IDLE_EXPLAINER gates the producer — LIVE BY DEFAULT (opt-out via [[flagDefaultOn]]); on unless explicitly OFF
 *  (SWARM_IDLE_EXPLAINER=0). Read at the call site (never a module-level constant). Pure. */
export function idleExplainerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_IDLE_EXPLAINER);
}

export const IDLE_EXPLAINER_SCHEMA = "console-idle-explainer/v1" as const;

/** How "idle" was determined this tick. `ledger` = the control-log's RUNNING-attempt view was readable (idle = zero running
 *  attempts); `unknown` = the control-log was UNREADABLE, so idle could NOT be determined (we never claim idle — nor "active" —
 *  on an unknown). */
export type IdleSource = "ledger" | "unknown";

/** The "why idle" signals, each number|null (null = UNREADABLE this tick, FC-2 r3 — never conflated with a confirmed zero):
 *  unclaimedInboxes = pending work queued in MEMBER boxes (EXCLUDES the coordinator notice box, so the explainer's own S19 can
 *  never feed back in); reviewQueueDepth = open review-seat queue; awaitingRuling = decision batches awaiting a ruling PLUS live
 *  control-log approval-waits; awaitingInput = live control-log query/input waits (a member blocked awaiting an answer);
 *  userGates = hardGate items (needs the user) inside the awaiting batches. */
export type IdleSignals = {
  unclaimedInboxes: number | null;
  reviewQueueDepth: number | null;
  awaitingRuling: number | null;
  awaitingInput: number | null;
  userGates: number | null;
};

/** The frozen projection the mod status band reads. `idle` = no running work for >= N consecutive ticks (ledger). `reason` = the
 *  one-line human explanation. `anomaly` = idle AND the swarm is established (>=1 member) AND every signal a CONFIRMED zero ⇒ an
 *  UNEXPLAINED idle worth one S19 to verify (honest: a ledger view cannot PROVE a stall, so this is "verify", not "proven"). */
export type IdleExplainer = {
  schema: typeof IDLE_EXPLAINER_SCHEMA;
  generatedAtSec: number;
  idle: boolean;
  idleSource: IdleSource;
  reason: string;
  signals: IdleSignals;
  anomaly: boolean;
};

/** An UNEXPLAINED-idle anomaly: idle AND the swarm is established (>=1 roster member — an empty/unstarted swarm is not a stall)
 *  AND every signal a CONFIRMED zero. A single null (unreadable) signal ⇒ NOT an anomaly (an unknown cannot prove "nothing is
 *  pending", FC-2 r3). Not idle / not established ⇒ never an anomaly. Pure. */
export function isIdleAnomaly(idle: boolean, swarmEstablished: boolean, s: IdleSignals): boolean {
  if (!idle || !swarmEstablished) return false;
  const vals = [s.unclaimedInboxes, s.reviewQueueDepth, s.awaitingRuling, s.awaitingInput, s.userGates];
  if (vals.some((v) => v === null)) return false;
  return vals.every((v) => v === 0);
}

/** Compose the one-line status-band reason. Unknown activity (control-log unreadable) ⇒ an explicit "unknown", NEVER "active".
 *  Not idle ⇒ "active (work running)". Idle ⇒ the actionable waits most-decision-relevant first; else, if nothing is pending,
 *  either a degraded line naming the unreadable sources OR an honest "unexplained idle — verify" (never a false "proven stall"
 *  on an unknown). Pure. */
export function idleReason(idle: boolean, idleSource: IdleSource, s: IdleSignals): string {
  if (idleSource === "unknown") return "activity unknown (control-log unreadable) — cannot determine idle";
  if (!idle) return "active (work running)";
  const parts: string[] = [];
  if ((s.awaitingRuling ?? 0) > 0) parts.push(`${s.awaitingRuling} awaiting ruling`);
  if ((s.reviewQueueDepth ?? 0) > 0) parts.push(`${s.reviewQueueDepth} in review`);
  if ((s.unclaimedInboxes ?? 0) > 0) parts.push(`${s.unclaimedInboxes} unclaimed in member boxes`);
  if ((s.awaitingInput ?? 0) > 0) parts.push(`${s.awaitingInput} awaiting input`);
  if ((s.userGates ?? 0) > 0) parts.push(`${s.userGates} awaiting user`);
  if (parts.length > 0) return `idle (no running work) — waiting: ${parts.join("; ")}`;
  const unreadable = ([
    ["inbox", s.unclaimedInboxes], ["review", s.reviewQueueDepth], ["ruling", s.awaitingRuling],
    ["input", s.awaitingInput], ["user-gate", s.userGates],
  ] as const).filter(([, v]) => v === null).map(([k]) => k);
  if (unreadable.length > 0) return `idle (no running work) — some signals unreadable (${unreadable.join(", ")}); cannot confirm a stall`;
  return "idle (no running work) and no detected reason — verify the swarm is not stalled (vs idle between tasks)";
}

/** Build the projection from the detected idle state + already-read signals. Pure + deterministic in its inputs. */
export function buildIdleExplainer(i: { idle: boolean; idleSource: IdleSource; swarmEstablished: boolean; signals: IdleSignals; nowSec: number }): IdleExplainer {
  return {
    schema: IDLE_EXPLAINER_SCHEMA,
    generatedAtSec: i.nowSec,
    idle: i.idle,
    idleSource: i.idleSource,
    reason: idleReason(i.idle, i.idleSource, i.signals),
    signals: i.signals,
    anomaly: isIdleAnomaly(i.idle, i.swarmEstablished, i.signals),
  };
}

/** S19 dedup helper: alert ONLY on the anomaly ONSET (a non-anomaly → anomaly transition). The dispatcher additionally gates on
 *  CONFIRMED delivery (deliver-then-mark), so an undelivered onset is retried, not lost. Pure. */
export function shouldAlertOnset(prevAnomaly: boolean, currAnomaly: boolean): boolean {
  return currAnomaly && !prevAnomaly;
}

/**
 * IE-4 — when NOT in the anomaly state, decide whether the anomaly EPISODE is CONFIRMED over (⇒ the dispatcher re-arms for the
 * next episode) vs this tick merely could not confirm the anomaly (⇒ RETAIN the episode + its delivered state). `anomaly === false`
 * is ambiguous: it is BOTH "a real recovery / a reason appeared" AND "an unreadable signal / unknown activity / an unresolvable
 * coordinator made the check inconclusive" — those must NOT share the recovery branch, or a transient read fault fakes a recovery
 * and re-publishes the same card under a fresh onset key. A recovery is CONFIRMED only when:
 *   - work RESUMED: running > 0 on a readable ledger (idleSource "ledger") — a definitive, coordinator-independent recovery; OR
 *   - a reason APPEARED: idle + established + EVERY signal readable (no null) + at least one positive, AND the coordinator is
 *     resolvable (so the unclaimed-inbox signal is free of the producer's own notice — IE-4's self-notice exclusion holds).
 * Anything else (unknown activity, any null signal, unresolvable coordinator) ⇒ NOT confirmed ⇒ the caller retains the episode.
 * Pure. */
export function recoveryConfirmed(i: { idle: boolean; idleSource: IdleSource; swarmEstablished: boolean; signals: IdleSignals; running: number | null; coordResolvable: boolean }): boolean {
  const vals = [i.signals.unclaimedInboxes, i.signals.reviewQueueDepth, i.signals.awaitingRuling, i.signals.awaitingInput, i.signals.userGates];
  const workActive = i.idleSource === "ledger" && (i.running ?? 0) > 0;
  const explainedIdle = i.idle && i.swarmEstablished && vals.every((v) => v !== null) && vals.some((v) => (v ?? 0) > 0) && i.coordResolvable;
  return workActive || explainedIdle;
}
