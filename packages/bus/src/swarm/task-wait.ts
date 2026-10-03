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
 *  - P1-2 / P2-A: for an APPROVAL wait, resolved != granted, and completing the escalation NOTICE does NOT end the
 *    approval. A notice ACK ends only that action; if the decision is still pending the wait goes BACK to open with a
 *    fresh deadline + escalatedAt — supervision transfers, it never vanishes. Only a real terminal decision
 *    (granted/denied/cancelled), or the subject being closed, ends an approval wait.
 *  - escalation only ever produces a notice, never a grant (decide is the only path to granted).
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

export type WaitEvent =
  // timeout handling, phase "execute": CAS the recoverable action intent BEFORE the IO.
  | { type: "begin_action"; pendingAction: PendingAction }
  // phase "confirm": the action finished with evidence. For a reversible `wait` -> resolved. For an approval whose
  // decision is still pending, the completed action was an escalation NOTICE -> back to open with newDeadlineSec +
  // escalatedAt (supervision transfers, P2-A). newDeadlineSec is REQUIRED in that case.
  | { type: "action_done"; resolution?: WaitResolution; newDeadlineSec?: number; nowSec?: number }
  // the real approval decision arrived (approval only). A terminal decision ENDS the wait.
  | { type: "decide"; decision: Exclude<ApprovalDecision, "pending">; grantRef?: string; resolution?: WaitResolution }
  // the subject completed/cancelled/was replaced normally -> close the wait (P2-1; committed same-batch as the subject).
  | { type: "close"; resolution: WaitResolution };

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
      // Approval whose decision is still pending: the finished action was an escalation notice — it does NOT resolve the
      // approval. Transfer supervision: back to open, fresh deadline, record escalatedAt (P1-2 / P2-A, §0b 终审②).
      if (w.kind === "approval" && (w.decision ?? "pending") === "pending") {
        if (event.newDeadlineSec === undefined) return bad("action_done on a still-pending approval requires newDeadlineSec (escalation transfers supervision, never resolves)");
        return ok({ state: "open", deadlineSec: event.newDeadlineSec, escalatedAt: event.nowSec, pendingAction: undefined });
      }
      // Reversible wait (or approval already decided): the action completed -> resolved with evidence.
      return ok({ state: "resolved", pendingAction: undefined, ...(event.resolution !== undefined ? { resolution: event.resolution } : {}) });
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
  }
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
