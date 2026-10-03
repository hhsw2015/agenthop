/**
 * liveness sweep (team-collab §0b R2) — the dispatcher pass's fixed step that REPLACES the human coordinator: each round
 * it scans the durable wait entities + member liveness and mechanically matches the §0b rules, so "any single point stuck
 * ⇒ job stalls forever" can't happen without a code path catching it. R2: progress is a property of the LOOP, not any
 * member's memory — a member may die/idle/forget; the loop + durable records move it forward.
 *
 * This increment implements the two highest-value rules (fe0376cd's acceptance scenarios A/B):
 *   - EXPIRED wait (owner alive)    → begin_action (bypass|escalation) → IO → action_done   [scenario A]
 *   - owner DEAD (isAlive)          → reassign: begin_action → IO → close old + open new    [scenario B]
 * Remaining rules (blocked×approval reminder, overload×idle R8, validation RPV-timeout moveValidator, idle×ready which
 * taskPass already covers) layer on next. All decisions are pure; all IO + liveness are injected (SweepOps), so the
 * ordering (CAS-then-IO, bounded delay, single suspected ≠ dead) is offline-testable.
 *
 * CAS-then-IO + bounded delay (P2-3): a timeout handler CAS-commits the recoverable action intent (open→action_pending)
 * BEFORE the IO, and an already-action_pending wait is SKIPPED this tick (its IO is in flight / will be confirmed) — a
 * slow supervised action never blocks the sweep from running. isAlive is injected (bus-identity owns the impl + its
 * known defects, §4); a SINGLE "suspected" is NOT dead (only a trustworthy "dead" reassigns).
 */

import { liveEntities, type WaitRecord, type PendingAction, type LogState, type ChangeBody, type CommitResult } from "./control-log.js";
import { advanceWait, openWait, isLive } from "./task-wait.js";

export type Liveness = "alive" | "suspected" | "dead";

export type SweepOps = {
  nowSec: () => number;
  loadState: () => LogState;
  /** Stamp operationId + expectedEntityRevision per body + persist (same convention as the task commit). */
  commit: (state: LogState, bodies: ChangeBody[]) => { state: LogState; result: CommitResult };
  /** Member liveness — injected; bus-identity owns the implementation + its known defects (§4). */
  isAlive: (memberId: string) => Liveness;
  /** An idle same-role successor for a dead owner's wait; null = none available ⇒ don't reassign (leave for escalation). */
  pickReassignee: (wait: WaitRecord) => string | null;
  newWaitId: (base: string) => string;
  newActionId: () => string;
  /** Deadline for a freshly reassigned wait. */
  freshDeadlineSec: () => number;
  /** The bounded supervised IO (bypass ping / escalation notice / reassign notify) via an R5 channel; resolves true when
   *  delivered with evidence. The action intent is ALREADY committed (begin_action) before this runs. */
  doAction: (wait: WaitRecord, action: PendingAction) => Promise<boolean>;
  log: (m: string) => void;
};

const subjectTarget = (w: WaitRecord): string => w.subject.attemptId ?? w.subject.bindingId ?? w.subject.jobId;

export async function sweepPass(ops: SweepOps): Promise<void> {
  let state = ops.loadState();
  const waits: WaitRecord[] = [];
  for (const body of Object.values(liveEntities(state))) if (body.put === "wait") waits.push(body.wait);

  for (const w of waits) {
    if (!isLive(w)) continue;                     // resolved — nothing to supervise
    if (w.state === "action_pending") continue;   // an action is already in flight (begin committed) — bounded delay: skip re-begin
    const live = ops.isAlive(w.owner);

    // Rule — owner DEAD ⇒ reassign (close old + open new, same batch), regardless of deadline (R5 / scenario B). A single
    // "suspected" is NOT dead (fe0376cd §4): we leave it. "alive" falls through to the expiry check.
    if (live === "dead") {
      const to = ops.pickReassignee(w);
      if (to === null) { ops.log(`sweep ${w.waitId}: owner ${w.owner} dead, no reassignee — leaving for escalation`); continue; }
      const action: PendingAction = { actionId: ops.newActionId(), actionKind: "reassign", target: subjectTarget(w), expectedSubjectVersion: 0 };
      const begun = advanceWait(w, { type: "begin_action", pendingAction: action });
      if (!begun.ok) { ops.log(`sweep ${w.waitId}: begin reassign rejected: ${begun.error}`); continue; }
      state = ops.commit(state, [{ put: "wait", wait: begun.wait }]).state;            // CAS: open → action_pending
      const delivered = await ops.doAction(begun.wait, action);                        // IO: notify the new owner (R5)
      if (!delivered) { ops.log(`sweep ${w.waitId}: reassign notify unconfirmed — holding action_pending, retry next tick`); continue; }
      const closed = advanceWait(begun.wait, { type: "close", resolution: { outcome: "owner-dead", reason: `owner ${w.owner} unreachable`, sourceOperationId: action.actionId } });
      if (!closed.ok) { ops.log(`sweep ${w.waitId}: close(owner-dead) rejected: ${closed.error}`); continue; }
      const fresh = openWait({ waitId: ops.newWaitId(w.waitId), kind: w.kind, subject: w.subject, deadlineSec: ops.freshDeadlineSec(), owner: to, timeoutPolicy: w.timeoutPolicy });
      state = ops.commit(state, [{ put: "wait", wait: closed.wait }, { put: "wait", wait: fresh }]).state; // close old + open new, same batch
      ops.log(`sweep ${w.waitId}: owner-dead ⇒ reassigned ${w.owner} → ${to} (new ${fresh.waitId})`);
      continue;
    }

    // Rule — EXPIRED (owner alive) ⇒ bypass / escalation (scenario A).
    if (live === "alive" && ops.nowSec() >= w.deadlineSec) {
      const kind = w.timeoutPolicy === "bypass" ? "bypass" : "escalation";
      const action: PendingAction = { actionId: ops.newActionId(), actionKind: kind, target: subjectTarget(w), expectedSubjectVersion: 0 };
      const begun = advanceWait(w, { type: "begin_action", pendingAction: action });
      if (!begun.ok) { ops.log(`sweep ${w.waitId}: begin ${kind} rejected: ${begun.error}`); continue; }
      state = ops.commit(state, [{ put: "wait", wait: begun.wait }]).state;            // CAS: open → action_pending (BEFORE IO)
      const delivered = await ops.doAction(begun.wait, action);                        // IO: send the ping / escalation notice (R5)
      if (!delivered) { ops.log(`sweep ${w.waitId}: ${kind} unconfirmed — holding action_pending, retry next tick`); continue; }
      // kind:"wait" is reversible ⇒ action_done resolves it; an approval still-pending would instead reopen with a fresh
      // deadline (the reducer enforces that + requires newDeadlineSec — handled when the approval rules land).
      const done = advanceWait(begun.wait, { type: "action_done", resolution: { outcome: kind, reason: `deadline passed; ${kind} sent`, sourceOperationId: action.actionId } });
      if (!done.ok) { ops.log(`sweep ${w.waitId}: action_done rejected: ${done.error}`); continue; }
      state = ops.commit(state, [{ put: "wait", wait: done.wait }]).state;
      ops.log(`sweep ${w.waitId}: expired ⇒ ${kind} sent, resolved`);
    }
  }
}
