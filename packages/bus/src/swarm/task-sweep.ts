/**
 * liveness sweep (team-collab §0b R2) — the dispatcher pass's fixed step that REPLACES the human coordinator: each round
 * it scans the durable wait entities + member liveness and mechanically matches the §0b rules, so "any single point stuck
 * ⇒ job stalls forever" can't happen without a code path catching it. R2: progress is a property of the LOOP, not any
 * member's memory — a member may die/idle/forget; the loop + durable records move it forward.
 *
 * Rules matched (per OPEN wait, owner liveness via injected isAlive):
 *   - RPV validation-wait (subject.validationRunId) stuck/dead validator → moveValidator (close old gen + open gen+1 over
 *     the SAME pinned candidate; business never re-run). [§0b RPV / P2-2]
 *   - owner DEAD                                     → reassign (close old + open new for a successor).            [R5]
 *   - EXPIRED (owner alive)                          → bypass (reversible) / escalation (approval), then RE-ARM.   [rules 2+3]
 * A single "suspected" never convicts (no action). EXPIRED/approval RE-ARM, never resolve (§0b erratum 94284fc2): a
 * timeout action ends only THAT action and re-opens the wait with a fresh deadline + escalatedAt; resolved comes only from
 * a real subject close or an approval decide. All decisions are pure; all IO + liveness are injected (SweepOps).
 *
 * ACTION LIFECYCLE — begin → fire → confirm, each tick, in three phases (P1-1/P1-2/P1-3):
 *   PHASE 1 begin : for each OPEN wait needing an action, CAS-commit the recoverable intent (open → action_pending)
 *                   BEFORE any IO. A rejected commit blocks the IO and never claims success (P1-1 — the barrier is checked,
 *                   not merely ordered).
 *   PHASE 2 fire  : fire the IO for EVERY action_pending wait — fresh begins AND crash/unconfirmed residue (recovery,
 *                   P1-2) — CONCURRENTLY within a bounded window (P1-3), EXCEPT frozen entities (op-conflict ⇒ repair, R5).
 *                   Delivery is AT-LEAST-ONCE (the message carries actionId for receiver dedup, R6 — not transport-
 *                   idempotent); an IO unconfirmed within the window is LEFT action_pending and re-fired next tick. One
 *                   slow IO never blocks another's fire or the loop (no serial await-per-wait).
 *   PHASE 3 confirm: for each DELIVERED action, RE-READ the current wait and confirm ONLY if its pending action is STILL
 *                   the one we fired (actionId match, R2) and unfrozen — a concurrent close/decide/re-begin must not be
 *                   confirmed with a stale result (P2-1). Commit the confirm transition by actionKind. Undelivered ⇒
 *                   untouched (recovered next tick).
 * isAlive is injected (bus-identity owns the impl + its known defects). PendingAction.target carries the IO DESTINATION
 * (reassignee / new validator location) so the confirm + routing are reconstructable from the durable intent alone.
 */

import { liveEntities, type WaitRecord, type PendingAction, type LogState, type ChangeBody, type CommitResult, type ValidationRun } from "./control-log.js";
import { advanceWait, openWait, openQueryWait, applyDefaultOnTimeout } from "./task-wait.js";
import { moveValidatorAction, moveValidatorWithWait } from "./task-rpv.js";

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
  /** A fresh validator execution location for a stuck/dead RPV validator; null = none ⇒ leave for escalation (v1, same
   *  convention as pickReassignee — the real picker needs the validator roster, owned by bus-identity). */
  pickValidator: (wait: WaitRecord, run: ValidationRun) => string | null;
  newWaitId: (base: string) => string;
  newValidationRunId: (base: string) => string;
  newActionId: () => string;
  /** Deadline for a freshly re-armed / reassigned / moved wait. */
  freshDeadlineSec: () => number;
  /** The bounded supervised IO (bypass ping / escalation notice / reassign / move-validator notify) via an R5 channel;
   *  resolves true when delivered. AT-LEAST-ONCE delivery: the intent is committed (begin_action) before this runs and a
   *  recovery may re-fire it, so the message MUST carry action.actionId for the receiver to self-dedup — this is NOT
   *  exactly-once and NOT idempotent at the transport (durable dedup is bus-identity's I3). */
  doAction: (wait: WaitRecord, action: PendingAction) => Promise<boolean>;
  /** Bounded window (ms) for a single action's IO per tick — a slower IO is left action_pending and re-fired next tick,
   *  so one slow action never blocks the sweep (P1-3 bounded delay). */
  actionTimeoutMs: number;
  log: (m: string) => void;
};

const subjectTarget = (w: WaitRecord): string => w.subject.attemptId ?? w.subject.bindingId ?? w.subject.jobId;

type Indexed = { waits: WaitRecord[]; runs: Map<string, ValidationRun> };
function indexEntities(state: LogState): Indexed {
  const waits: WaitRecord[] = [];
  const runs = new Map<string, ValidationRun>();
  for (const b of Object.values(liveEntities(state))) {
    if (b.put === "wait") waits.push(b.wait);
    else if (b.put === "validationRun") runs.set(b.validationRun.validationRunId, b.validationRun);
  }
  return { waits, runs };
}

/** Bound a single IO: resolve its delivered flag, or false if it doesn't settle within ms (left action_pending → next
 *  tick). Takes a THUNK so the timer is armed BEFORE the action is invoked (R1 — no eager argument evaluation). NOTE: this
 *  bounds the ASYNC delivery wait only; a synchronous-blocking adapter cannot be interrupted by a JS timer, so action
 *  adapters must stay async (and the real writeInbox is a fast sync write). */
function withTimeout(thunk: () => Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done(false), ms);
    Promise.resolve().then(thunk).then((v) => done(v), () => done(false));
  });
}

/** PURE-ish decision for an OPEN wait: the PendingAction it needs now, or null (no action / deferred). Mirrors the §0b
 *  rules; target carries the IO destination so the confirm is reconstructable. May log a deferral reason. */
function decideAction(w: WaitRecord, runs: Map<string, ValidationRun>, live: Liveness, ops: SweepOps): PendingAction | null {
  // NOTE: an EXPIRED query wait (kind=wait + defaultOnTimeout) is handled by PHASE 0 in sweepPass (a direct CAS close with its
  // default, covering BOTH open and action_pending), so it never reaches decideAction's IO branches (review 01b773d-E2).
  // RPV validation-wait: a DEAD or ALIVE-but-expired validator ⇒ moveValidator. A single "suspected" never convicts.
  if (w.subject.validationRunId !== undefined) {
    if (live === "suspected") return null;
    if (live === "alive" && ops.nowSec() < w.deadlineSec) return null; // validator working within deadline — leave it
    const run = runs.get(w.subject.validationRunId);
    if (!run) { ops.log(`sweep ${w.waitId}: validation-wait references unknown run ${w.subject.validationRunId} — skipping`); return null; }
    const to = ops.pickValidator(w, run);
    if (to === null) { ops.log(`sweep ${w.waitId}: validator ${run.validatorLocation} stuck/dead, no replacement — leaving for escalation`); return null; }
    return moveValidatorAction({ actionId: ops.newActionId(), newValidatorLocation: to, expectedSubjectVersion: run.generation });
  }
  // owner DEAD ⇒ reassign (target = the successor; routing + confirm use it). A single "suspected" is NOT dead.
  if (live === "dead") {
    const to = ops.pickReassignee(w);
    if (to === null) { ops.log(`sweep ${w.waitId}: owner ${w.owner} dead, no reassignee — leaving for escalation`); return null; }
    return { actionId: ops.newActionId(), actionKind: "reassign", target: to, expectedSubjectVersion: 0 };
  }
  // EXPIRED ⇒ bypass (reversible) / escalation (approval). Fires for a NOT-dead owner — a DEAD owner was already handled by
  // the reassign branch above, and a SUSPECTED owner's expired wait must still re-arm: supervision never silently
  // evaporates (§0b R2 / P1-4 / F17 — "suspected is not convicted" includes not stopping its supervision). This is what
  // keeps expiry handling live under the bus-identity liveness kernel, which in v1 (no birth collection) returns suspected
  // for every owner; a truly-dead owner misjudged suspected gets harmless repeated re-arm/ping (at-least-once) until birth
  // collection + a picker enable a real reassign. (An approval ALWAYS escalates, never bypass.)
  if (ops.nowSec() >= w.deadlineSec) { // live is alive|suspected here (dead returned above) — expiry fires for any not-dead owner
    // A query wait was already handled at the TOP (E2-A), so here it is an approval (escalate) or an ordinary bypass wait.
    const isApproval = w.kind === "approval" && (w.decision ?? "pending") === "pending";
    const kind = isApproval || w.timeoutPolicy !== "bypass" ? "escalation" : "bypass";
    return { actionId: ops.newActionId(), actionKind: kind, target: subjectTarget(w), expectedSubjectVersion: 0 };
  }
  return null;
}

/** Confirm transition for a DELIVERED action, by actionKind ⇒ the ChangeBody[] to commit, or null (log + skip). */
function confirmChanges(w: WaitRecord, action: PendingAction, runs: Map<string, ValidationRun>, atSeq: number, ops: SweepOps): ChangeBody[] | null {
  switch (action.actionKind) {
    case "bypass":
    case "escalation": {
      // E2-C (review 4c617fa): a QUERY wait may be left in a STALE pending-bypass by a pre-fix version or a crash/upgrade.
      // Its deadline decision is ALWAYS "apply the default + CLOSE", never a re-arm (which re-asks forever and starves the
      // default's consumer). Recognize the query here and apply its default regardless of the stale actionKind.
      if (w.kind === "wait" && w.defaultOnTimeout !== undefined) {
        const applied = applyDefaultOnTimeout(w, ops.nowSec());
        if (!applied.ok) { ops.log(`sweep ${w.waitId}: applyDefaultOnTimeout (stale ${action.actionKind}) rejected: ${applied.error}`); return null; }
        return [{ put: "wait", wait: applied.wait }];
      }
      // Re-arm (erratum 94284fc2): the ping/notice ended only THAT action; re-open with a fresh deadline + escalatedAt.
      const done = advanceWait(w, { type: "action_done", newDeadlineSec: ops.freshDeadlineSec(), nowSec: ops.nowSec() });
      if (!done.ok) { ops.log(`sweep ${w.waitId}: action_done rejected: ${done.error}`); return null; }
      return [{ put: "wait", wait: done.wait }];
    }
    case "apply-default": {
      // Query-wait deadline reached (R3-b): apply the pre-stored default answer and CLOSE (resolved, outcome=default-applied) —
      // NOT a re-arm, so the consumer waiting on the default stops being starved (review ab1bf81-P1#2). applyDefaultOnTimeout
      // rejects a non-query wait, which decideAction already excludes; close-on-resolved is a no-op, so a late re-fire is safe.
      // nowSec stamps resolution.occurredAtSec = the timeout instant (R5-B occurrence), so this close carries its true boundary.
      const applied = applyDefaultOnTimeout(w, ops.nowSec());
      if (!applied.ok) { ops.log(`sweep ${w.waitId}: applyDefaultOnTimeout rejected: ${applied.error}`); return null; }
      return [{ put: "wait", wait: applied.wait }];
    }
    case "reassign": {
      const closed = advanceWait(w, { type: "close", resolution: { outcome: "owner-dead", reason: `owner ${w.owner} unreachable → ${action.target}`, sourceOperationId: action.actionId } });
      if (!closed.ok) { ops.log(`sweep ${w.waitId}: close(owner-dead) rejected: ${closed.error}`); return null; }
      // E2-B (review 4c617fa): a QUERY wait (defaultOnTimeout) reassigned before its deadline — only the DECIDER changed, so the
      // new owner inherits the SAME unanswered question: its default, payloadRef, AND original semantic deadline must all survive.
      // openWait+freshDeadlineSec would drop the default/payload and reset the deadline to a fresh window — re-opening the
      // "default lost / deadline reset on reassign" gap. Rebuild it as a query wait keyed to the SAME deadline instead.
      let fresh: WaitRecord;
      if (w.kind === "wait" && w.defaultOnTimeout !== undefined) {
        fresh = openQueryWait({ waitId: ops.newWaitId(w.waitId), subject: w.subject, deadlineSec: w.deadlineSec, owner: action.target, defaultOnTimeout: w.defaultOnTimeout, ...(w.payloadRef !== undefined ? { payloadRef: w.payloadRef } : {}) });
      } else {
        // Carry the approval context (what needs deciding) to the successor — the new owner inherits the SAME request; only
        // the decider changed. Dropping actionRef/paramsDigest/authority/reason would silently strip an approval (report
        // conditional note). decision resets to pending via openWait (a fresh decider), which is correct.
        const approvalCtx = w.kind === "approval"
          ? { actionRef: w.actionRef, paramsDigest: w.paramsDigest, approvalAuthority: w.approvalAuthority, approvalReason: w.approvalReason }
          : {};
        fresh = openWait({ waitId: ops.newWaitId(w.waitId), kind: w.kind, subject: w.subject, deadlineSec: ops.freshDeadlineSec(), owner: action.target, timeoutPolicy: w.timeoutPolicy, ...approvalCtx });
      }
      return [{ put: "wait", wait: closed.wait }, { put: "wait", wait: fresh }];
    }
    case "move-validator": {
      const run = w.subject.validationRunId ? runs.get(w.subject.validationRunId) : undefined;
      if (!run) { ops.log(`sweep ${w.waitId}: move-validator confirm — run ${w.subject.validationRunId ?? "?"} missing`); return null; }
      const moved = moveValidatorWithWait(run, w, {
        newValidationRunId: ops.newValidationRunId(run.validationRunId), validatorLocation: action.target, openedAtSeq: atSeq, atSeq,
        newWaitId: ops.newWaitId(w.waitId), deadlineSec: ops.freshDeadlineSec(), owner: action.target, timeoutPolicy: w.timeoutPolicy,
        resolution: { outcome: "validator-moved", reason: `validator ${run.validatorLocation} stuck/dead → ${action.target}`, sourceOperationId: action.actionId },
      });
      if ("error" in moved) { ops.log(`sweep ${w.waitId}: moveValidatorWithWait rejected: ${moved.error}`); return null; }
      return moved.changes;
    }
    default:
      ops.log(`sweep ${w.waitId}: unknown actionKind ${action.actionKind} — skipping confirm`);
      return null;
  }
}

export async function sweepPass(ops: SweepOps): Promise<void> {
  let state = ops.loadState();
  // Commit-then-IO barrier (P1-1): a REJECTED commit must NOT proceed and must NOT be logged as success. Advance local
  // state only on ok; on reject log honestly and return false so the caller bails (record left recoverable).
  const commitOk = (bodies: ChangeBody[], ctx: string): boolean => {
    const r = ops.commit(state, bodies);
    if (!r.result.ok) { ops.log(`sweep ${ctx}: commit rejected (${r.result.reason}) — no IO, no completion claim`); return false; }
    state = r.state;
    return true;
  };

  // PHASE 0 — expired-query default (review 01b773d-E2): a query wait (kind=wait + defaultOnTimeout) past its deadline applies
  // its pre-stored default via a DIRECT CAS close, in EITHER open OR action_pending state, with NO IO. The default needs no
  // delivery (notifying the asker is advisory), so a failed bypass/reassign IO or an unresolvable/dead owner must NEVER block it
  // — that stranded the query past its semantic deadline with no answer. This preempts the begin/fire/confirm phases for a query,
  // and clears any stale pendingAction via the close. Skips a resolved (a real answer/terminal state won) or FROZEN wait; a late
  // re-run is a no-op (close-on-resolved is rejected). Non-query waits are untouched here — they keep the 3-phase path below.
  for (const w of indexEntities(state).waits) {
    if (w.state === "resolved" || w.kind !== "wait" || w.defaultOnTimeout === undefined) continue; // only a LIVE query wait
    if (ops.nowSec() < w.deadlineSec) continue;                                                     // not yet the decision moment
    if (state.frozen.includes(`wait:${w.waitId}`)) { ops.log(`sweep ${w.waitId}: expired query FROZEN — skipping default`); continue; }
    const applied = applyDefaultOnTimeout(w, ops.nowSec());
    if (!applied.ok) { ops.log(`sweep ${w.waitId}: expired-query default rejected: ${applied.error}`); continue; }
    commitOk([{ put: "wait", wait: applied.wait }], `${w.waitId} expired-query default`);
  }

  // PHASE 1 — begin: CAS-commit a recoverable intent for each OPEN wait that needs an action (no IO here).
  state = ops.loadState(); // pick up PHASE 0's closes so a defaulted query is no longer seen as open/pending
  for (const w of indexEntities(state).waits) {
    if (w.state !== "open") continue; // action_pending residue is handled in phase 2 (recovery); resolved is done
    const action = decideAction(w, indexEntities(state).runs, ops.isAlive(w.owner), ops);
    if (!action) continue;
    const begun = advanceWait(w, { type: "begin_action", pendingAction: action });
    if (!begun.ok) { ops.log(`sweep ${w.waitId}: begin ${action.actionKind} rejected: ${begun.error}`); continue; }
    commitOk([{ put: "wait", wait: begun.wait }], `${w.waitId} begin ${action.actionKind}`); // CAS BEFORE IO (phase 2)
  }

  // PHASE 2 — fire (bounded, concurrent): every action_pending wait (fresh + crash/unconfirmed residue — recovery) gets
  // its IO re-fired within a bounded window (at-least-once; the receiver dedups by actionId). Unsettled ⇒ left
  // action_pending, re-fired next tick. A FROZEN entity (op-conflict) is NOT auto-fired — it needs repair (R5).
  state = ops.loadState();
  const frozen = new Set(state.frozen);
  const allPending = indexEntities(state).waits.filter((w) => w.state === "action_pending" && w.pendingAction);
  for (const w of allPending) if (frozen.has(`wait:${w.waitId}`)) ops.log(`sweep ${w.waitId}: action_pending but FROZEN (op-conflict) — skipping IO, needs repair/investigation`);
  const pending = allPending.filter((w) => !frozen.has(`wait:${w.waitId}`));
  const fired = await Promise.all(pending.map((w) => {
    const action = w.pendingAction as PendingAction;
    return withTimeout(() => ops.doAction(w, action), ops.actionTimeoutMs).then((delivered) => ({ waitId: w.waitId, actionId: action.actionId, delivered }));
  }));

  // PHASE 3 — confirm: for each DELIVERED action, re-read the current wait and confirm ONLY if its pending action is STILL
  // the exact one we fired (actionId match, R2) and the entity is not frozen (R5) — a concurrent close/decide/re-begin
  // must not be confirmed with this stale result (P2-1). Commit the confirm transition per actionKind.
  state = ops.loadState();
  for (const f of fired) {
    if (!f.delivered) continue; // undelivered/timed-out ⇒ stays action_pending, recovered next tick
    const { waits, runs } = indexEntities(state);
    const w = waits.find((x) => x.waitId === f.waitId);
    if (!w || w.state !== "action_pending" || w.pendingAction?.actionId !== f.actionId) continue; // moved on — stale result
    if (state.frozen.includes(`wait:${w.waitId}`)) { ops.log(`sweep ${w.waitId}: confirm skipped — entity frozen`); continue; }
    const changes = confirmChanges(w, w.pendingAction, runs, state.seq + 1, ops);
    if (!changes) continue;
    if (commitOk(changes, `${w.waitId} ${w.pendingAction.actionKind} confirm`))
      ops.log(`sweep ${w.waitId}: ${w.pendingAction.actionKind} confirmed`);
  }
}
