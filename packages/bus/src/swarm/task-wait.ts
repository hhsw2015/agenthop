/**
 * Wait/Approval transitions (team-collab §0b R2) — PURE, immutable, mirrors control.ts/advance. A WaitRecord makes a
 * pause durable so the liveness sweep can find it; this module is the pure state machine over one record. The IO caller
 * attaches a per-transition operationId and commits each as a {put:"wait"} Change (the type lives in control-log.ts).
 *
 * Three states, decide → execute → confirm, each durable (P1-1 — the two crash windows): on timeout the handler first
 * CAS-commits `pendingAction` (open → action_pending), THEN performs the IO, and only confirms (→ resolved) with
 * evidence. Never resolve-then-IO, never IO-then-record; a crash in action_pending leaves a recoverable intent.
 *
 * Rules the R2 review turned into counterexamples (each pinned by a test):
 *  - §0b erratum 2026-10-03 (team-collab SHA 94284fc2): ANY timeout action's completion ends only THAT action and NEVER
 *    resolves the wait — a wait represents the awaited work/reply itself, and a reminder/bypass delivery is not
 *    completion evidence. So action_done ALWAYS re-arms: back to open with a fresh deadline + escalatedAt (supervision
 *    transfers, never vanishes), for a reversible `wait` and an approval alike. (Before the erratum a reversible
 *    action_done resolved; that was the over-wide resolve scope the erratum tightened.)
 *  - resolved comes ONLY from close (subject normal completion / reassignment / budget-exhausted) — and, for an
 *    approval, from decide reaching a terminal decision (the approval subject completing). escalation never grants.
 *  - P2-1 race: a normal completion/cancel of the subject closes the wait (from open OR action_pending); a late action
 *    completion on an already-resolved wait is a no-op for the caller (rejected here).
 */

import type { WaitRecord, WaitState, ApprovalDecision, PendingAction, WaitResolution, WaitSubject } from "./control-log.js";

export type NewWait = {
  waitId: string;
  kind: WaitRecord["kind"];
  subject: WaitSubject;
  deadlineSec: number;
  owner: string;
  timeoutPolicy: WaitRecord["timeoutPolicy"];
  // approval-only context (kind="approval"):
  actionRef?: string;
  paramsDigest?: string;
  approvalAuthority?: string;
  approvalReason?: string;
};

export function openWait(i: NewWait): WaitRecord {
  return {
    waitId: i.waitId,
    kind: i.kind,
    subject: i.subject,
    state: "open",
    deadlineSec: i.deadlineSec,
    owner: i.owner,
    timeoutPolicy: i.timeoutPolicy,
    ...(i.kind === "approval"
      ? {
          decision: "pending" as ApprovalDecision,
          ...(i.actionRef !== undefined ? { actionRef: i.actionRef } : {}),
          ...(i.paramsDigest !== undefined ? { paramsDigest: i.paramsDigest } : {}),
          ...(i.approvalAuthority !== undefined ? { approvalAuthority: i.approvalAuthority } : {}),
          ...(i.approvalReason !== undefined ? { approvalReason: i.approvalReason } : {}),
        }
      : {}),
  };
}

export type NewQueryWait = {
  waitId: string;
  subject: WaitSubject;
  deadlineSec: number;
  owner: string;
  /** The pre-stored default answer applied on timeout (R3-b). REQUIRED — a query must not bare-wait. */
  defaultOnTimeout: WaitResolution;
  /** T3 needsClarification: content-addressed ref to the immutable resume bundle (original draft + PRD + frozenContext
   *  version refs). Optional; the IO layer (T3b) stores/retrieves the bundle, this only pins the digest. */
  payloadRef?: string;
};

/** R3-b: open a query-wait = an ordinary bypass wait carrying a durable default answer. On timeout the sweep applies the
 *  default via applyDefaultOnTimeout (a close), not a new event. kind/timeoutPolicy are fixed here, and defaultOnTimeout
 *  is required — so a query-wait ALWAYS carries its default (the type invariant "问询不裸等"); approvals, built by
 *  openWait, cannot carry one (NewWait has no such field — "门控才裸等"). */
export function openQueryWait(i: NewQueryWait): WaitRecord {
  return {
    waitId: i.waitId,
    kind: "wait",
    subject: i.subject,
    state: "open",
    deadlineSec: i.deadlineSec,
    owner: i.owner,
    timeoutPolicy: "bypass",
    defaultOnTimeout: i.defaultOnTimeout,
    ...(i.payloadRef !== undefined ? { payloadRef: i.payloadRef } : {}),
  };
}

/** Apply the pre-stored default on timeout: a CLOSE with the default resolution (outcome "default-applied") — the
 *  question's subject completed, answer source = default (§0b/R3-b, consistent with "resolved only from close"). No IO
 *  (notifying the asker is advisory), so it is a direct CAS close. Rejected if the wait carries no default (not a query
 *  wait) — never fabricate a resolution. */
export function applyDefaultOnTimeout(w: WaitRecord, nowSec?: number): WaitAdvance {
  if (w.defaultOnTimeout === undefined) return { ok: false, error: "applyDefaultOnTimeout on a wait with no defaultOnTimeout (not a query wait)" };
  // occurredAtSec (R5-B) = the timeout instant, injected by the sweep IO (pure layer never reads a clock). Absent nowSec
  // leaves it off = current behavior.
  return advanceWait(w, { type: "close", resolution: { outcome: "default-applied", reason: w.defaultOnTimeout.reason, sourceOperationId: w.defaultOnTimeout.sourceOperationId, ...(nowSec !== undefined ? { occurredAtSec: nowSec } : {}) } });
}

export type WaitEvent =
  // timeout handling, phase "execute": CAS the recoverable action intent BEFORE the IO.
  | { type: "begin_action"; pendingAction: PendingAction }
  // phase "confirm": the timeout action finished. It ends only THAT action and re-arms the wait (open + newDeadlineSec +
  // escalatedAt) for EVERY wait kind — it never resolves (§0b erratum 94284fc2). newDeadlineSec is REQUIRED.
  | { type: "action_done"; newDeadlineSec: number; nowSec?: number }
  // the real approval decision arrived (approval only). A terminal decision ENDS the wait.
  | { type: "decide"; decision: Exclude<ApprovalDecision, "pending">; grantRef?: string; resolution?: WaitResolution }
  // the subject completed/cancelled/was replaced normally -> close the wait (P2-1; committed same-batch as the subject).
  | { type: "close"; resolution: WaitResolution }
  // §2c-b evidence renewal: fresh liveness evidence arrived WHILE open -> push the deadline out. Same re-armed shape as
  // action_done, NEVER resolves. ONLY for a renewable (liveness/reminder) wait — a semantic-deadline wait rejects it.
  | { type: "renew"; newDeadlineSec: number; nowSec?: number };

export type WaitAdvance = { ok: true; wait: WaitRecord } | { ok: false; error: string };

export function advanceWait(w: WaitRecord, event: WaitEvent): WaitAdvance {
  const bad = (error: string): WaitAdvance => ({ ok: false, error });
  const ok = (patch: Partial<WaitRecord>): WaitAdvance => ({ ok: true, wait: { ...w, ...patch } });

  switch (event.type) {
    case "begin_action":
      if (w.state !== "open") return bad(`begin_action from ${w.state}`);
      return ok({ state: "action_pending", pendingAction: event.pendingAction });

    case "action_done": {
      if (w.state !== "action_pending") return bad(`action_done from ${w.state}`);
      // A timeout action's completion ends only THAT action and NEVER resolves the wait (§0b erratum 94284fc2) — a
      // reminder/bypass delivery is not completion evidence. Re-arm for EVERY kind: back to open, fresh deadline,
      // escalatedAt (supervision transfers, never vanishes). resolved comes only from close (or decide, for approval).
      if (event.newDeadlineSec === undefined) return bad("action_done requires newDeadlineSec (re-arm never resolves)");
      return ok({ state: "open", deadlineSec: event.newDeadlineSec, escalatedAt: event.nowSec, pendingAction: undefined });
    }

    case "decide": {
      if (w.kind !== "approval") return bad("decide on a non-approval wait");
      if ((w.decision ?? "pending") !== "pending") return bad(`decide from decision=${w.decision}`);
      if (w.state === "resolved") return bad("decide on a resolved wait");
      // A terminal decision ends the approval wait. granted records the grant; escalation never reaches here.
      return ok({
        state: "resolved",
        decision: event.decision,
        pendingAction: undefined,
        ...(event.decision === "granted" && event.grantRef !== undefined ? { grantRef: event.grantRef } : {}),
        ...(event.resolution !== undefined ? { resolution: event.resolution } : {}),
      });
    }

    case "close":
      if (w.state === "resolved") return bad("close on a resolved wait");
      return ok({ state: "resolved", pendingAction: undefined, resolution: event.resolution });

    case "renew": {
      // Renewal is a liveness re-arm from OPEN (evidence arrived before any timeout action). Same shape as action_done's
      // re-arm (open + fresh deadline + escalatedAt, pendingAction cleared) and NEVER resolves. Only a renewable wait
      // qualifies — a semantic-deadline wait (query/validation/approval/bypass) must keep its real deadline.
      if (!isRenewable(w)) return bad("renew on a semantic-deadline wait (not a renewable liveness/reminder wait)");
      if (w.state !== "open") return bad(`renew from ${w.state} (only an open wait renews; action_pending must action_done first)`);
      if (event.newDeadlineSec === undefined) return bad("renew requires newDeadlineSec (renewal never resolves)");
      return ok({ state: "open", deadlineSec: event.newDeadlineSec, escalatedAt: event.nowSec, pendingAction: undefined });
    }
  }
}

/** §2c-b classification (single source of truth; the sweep side reuses this exact predicate). A wait is RENEWABLE
 *  (liveness/reminder — fresh health evidence may push its deadline) iff it is an escalate-policy supervision wait with no
 *  semantic-deadline marker: a query-wait (defaultOnTimeout), a validation-wait (subject.validationRunId), an approval, or
 *  any non-escalate timeoutPolicy is a SEMANTIC deadline and is NOT renewable. */
export function isRenewable(w: WaitRecord): boolean {
  return w.kind === "wait" && w.defaultOnTimeout === undefined && w.subject.validationRunId === undefined && w.timeoutPolicy === "escalate";
}

/** Incident-boundary semantics (dead-letter R5-B; single source of truth, the sweep side reuses this exact predicate).
 *  Given a failure/dead-letter observation stamped at failureTsSec and a routing-repair wait's recovery resolution, does
 *  this failure REOPEN the incident? It does iff it occurred strictly AFTER the recovery (failureTsSec > occurrence): a
 *  failure at or before the recovery moment is STALE — already subsumed by the repair that resolution closed — even when
 *  the sweep only observes both at a later, common tick (the two counterexamples that no observation-derived boundary can
 *  separate). Strict `>` so the stale burst that TRIGGERED an instant (same-tick) repair does not immediately re-flap.
 *  Fail toward NOTICING: a missing or non-finite occurrence (a bare/legacy close, or garbage) establishes no suppression
 *  boundary, so reopen — never let a NaN comparison (NaN > x === false) silently swallow a real post-recovery failure.
 *  ponytail: second granularity; a genuine same-second post-recovery failure needs finer clock resolution, not a flipped
 *  comparison (which would guarantee flaps on every instant repair). */
export function failureReopensIncident(failureTsSec: number, recovery: WaitResolution): boolean {
  const boundary = recovery.occurredAtSec;
  if (boundary === undefined || !Number.isFinite(boundary) || !Number.isFinite(failureTsSec)) return true;
  return failureTsSec > boundary;
}

/** Is this wait still something the sweep must supervise? (open or action_pending). */
export function isLive(w: WaitRecord): boolean {
  return w.state !== "resolved";
}

/** Does the protected IO have admission? ONLY a matching, granted approval — never "no unresolved wait" (§0b: admission
 *  = a valid grant for actionId+paramsDigest). Pure check over the record the caller resolved for this action. */
export function isGranted(w: WaitRecord, paramsDigest: string): boolean {
  return w.kind === "approval" && w.decision === "granted" && w.paramsDigest === paramsDigest;
}
