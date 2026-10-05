/**
 * task-intent — the dispatcher-side construction of a DispatchIntent (type: control-log.ts; construction semantics:
 * HERE, per the ownership split). The intent is the CAS-then-IO durable record committed BEFORE startTask allocates a
 * box (brain §4.3 / §4.5-6): persist the intent, THEN run swarm-launch, THEN record the outcome.
 *
 * The load-bearing rule is the physical-occupancy evidence discipline (§4.3, F1/F2): physicalExpiresAtSec may be set
 * ONLY from trustworthy evidence — a provider-reported expiry, or a creation-completion bound (+PROVIDER_LIFETIME+skew).
 * A local runScript SIGKILL/timeout is NOT evidence (it kills local bash, not the provider's accepted request), so an
 * "unknown" allocation leaves physicalExpiresAtSec ABSENT ⇒ the record is conservatively counted as occupying a slot
 * indefinitely until a trustworthy result, a WORK first-snapshot, or evidence-backed expiry.
 */

import type { DispatchIntent } from "./control-log.js";
import type { Assignment } from "./task-assignment.js";
import { PROVIDER_LIFETIME_SEC } from "./control.js";

export type IntentTiming = {
  /** Alloc-request start (IO-before persist, §4.3 Codex P1-4). */
  allocRequestStartSec: number;
  /** Work deadline = start + budget; drives drain/checkpoint only, NEVER physical-death judgement. */
  workDeadlineSec: number;
};

/** The pre-IO record: pending/pending, bound to the assignment, no physical evidence (nothing allocated yet). */
export function buildDispatchIntent(a: Assignment, t: IntentTiming): DispatchIntent {
  return {
    intentId: a.assignmentId,
    attemptId: a.attemptId,
    nodeId: a.nodeId,
    launchId: a.launchId,
    bindingId: a.bindingId,
    assignmentDigest: a.assignmentDigest,
    allocRequestStartSec: t.allocRequestStartSec,
    workDeadlineSec: t.workDeadlineSec,
    allocOutcome: "pending",
    status: "pending",
  };
}

export type AllocOutcome = "created" | "clean-fail" | "unknown";
export type ResolveCtx = {
  /** The dispatcher clock when swarm-launch returned. */
  nowSec: number;
  providerLifetimeSec?: number;
  skewSec?: number;
};

/**
 * Record the allocate outcome on a pending intent (immutable). Only "created" yields a trustworthy physical bound
 * (creation-bound = now + PROVIDER_LIFETIME + skew); "clean-fail" and "unknown" leave physicalExpiresAtSec ABSENT —
 * "clean-fail" because the provider reliably did NOT create (no slot held), "unknown" because a lost response / local
 * timeout is no evidence the box isn't running (F1/F2 conservative occupancy). Call once on the pending intent.
 */
export function resolveAllocOutcome(intent: DispatchIntent, outcome: AllocOutcome, ctx: ResolveCtx): DispatchIntent {
  if (outcome === "created") {
    const providerLifetimeSec = ctx.providerLifetimeSec ?? PROVIDER_LIFETIME_SEC;
    const skewSec = ctx.skewSec ?? 120;
    return { ...intent, allocOutcome: "created", physicalExpiresAtSec: ctx.nowSec + providerLifetimeSec + skewSec, physicalEvidence: "creation-bound" };
  }
  return { ...intent, allocOutcome: outcome };
}

/** Provider gave a reliable expiry (the strongest evidence source). */
export function withProviderExpiry(intent: DispatchIntent, expiresAtSec: number): DispatchIntent {
  return { ...intent, physicalExpiresAtSec: expiresAtSec, physicalEvidence: "provider-expiry" };
}

/** The full startTask IO (alloc + assignment/token scp + worker start) succeeded. */
export function confirmIntent(intent: DispatchIntent): DispatchIntent {
  return { ...intent, status: "confirmed" };
}

/** The dispatch is abandoned (clean-fail, or intent revoked before IO). */
export function abandonIntent(intent: DispatchIntent): DispatchIntent {
  return { ...intent, status: "abandoned" };
}
