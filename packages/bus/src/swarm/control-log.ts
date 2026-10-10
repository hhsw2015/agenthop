/**
 * commitControl — the PURE core of the CONTROL log (§2.6, §4.3 step A). T2. This module owns the Change union and the
 * decision/reducer engine; the IO shell (append `<seq>.json` atomically, fsync) and the persist-call-point migration
 * live on the dispatcher/lifecycle side. Here everything is a pure function over an in-memory LogState.
 *
 * §2.6 entity-vs-operation model: entities (plan/attempt/binding/accepted/…) have a stable key + a monotonic
 * entityRevision; a state change is a new revision. Operations (one concrete transition) have an immutable
 * operationId + a canonical payload digest + an expectedEntityRevision.
 *
 * Decision order is load-bearing (Codex §2.6 v2; fe0376cd T2 traps), and MUST be exactly this:
 *  1. REPLAY check FIRST: operationId already applied with the SAME payload digest ⇒ no-op replay. This precedes BOTH
 *     the expectedEntityRevision check AND the expectedSeq check — on crash-recovery the dispatcher re-submits a batch
 *     whose seq/revisions have already advanced; checking those first would misjudge a legitimate replay as a conflict.
 *  2. OP-CONFLICT: same operationId, DIFFERENT digest ⇒ hard conflict — reject, alarm, FREEZE the entity (needs human
 *     / repair). Never "latest wins".
 *  3. A new operationId with a STALE expectedEntityRevision is NOT a conflict — it is ordinary concurrency/recompute;
 *     the caller re-reads and recomputes.
 *  4. Batches are GROUP-ATOMIC (all changes visible or none) and may not put the same entity twice (caller bug,
 *     fail-fast).
 *
 * Caller (IO shell) obligations — this pure engine does not enforce them, so they are stated here (P3):
 *  - SEQ STAMPING: a record's own seq field (createdAtSeq / openedAtSeq / decidedAtSeq / atSeq) is the seq of the batch
 *    that commits it = (currentState.seq + 1). Compute it before building the payload and stamp it in; all records in
 *    one batch share that seq (decidedAtSeq is the cross-task total order; within a batch, order by plan for tie-break).
 *  - OPERATION ID: one id PER LOGICAL TRANSITION, minted once and PERSISTED before the commit IO, then reused verbatim
 *    if a crash forces a resubmit (that is what makes recovery idempotent). NOT per pass. Do NOT mint a fresh id for an
 *    unchanged entity — skip the commit entirely when nothing changed (a frequent lifecycle pass with no delta writes
 *    nothing); operationId idempotency is the crash-mid-commit safety net, not a license to log every pass.
 *  - expectedEntityRevision = currentState.revisions[entityKey] ?? 0 (a brand-new entity is 0).
 *  - CAS-then-IO: commit (persist) FIRST, then perform the side effect (startTask/allocate). Recovery replays the log.
 */

import { digestOf } from "./digest.js";
import type { TaskPlan } from "./task-plan.js";
import type { TaskAttempt } from "./task-state.js";
import type { AcceptedResult } from "./task-result.js";
import type { ControlRecord } from "./control.js";
import type { OpsReceiptRecord } from "./coordinator-ops-receipt.js";

/** Dispatch intent (§4.3). Type lives HERE (co-located with Change); the dispatch side imports it and owns the
 *  CONSTRUCTION logic (allocOutcome / physicalEvidence / physicalExpiresAtSec CAS-then-IO semantics). */
export type DispatchIntent = {
  intentId: string; // = assignmentId
  attemptId: string;
  nodeId: string;
  launchId: string;
  bindingId: string;
  assignmentDigest: string;
  allocRequestStartSec: number;
  workDeadlineSec: number;
  physicalExpiresAtSec?: number;
  physicalEvidence?: "provider-expiry" | "creation-bound" | null;
  allocOutcome: "pending" | "created" | "clean-fail" | "unknown";
  status: "pending" | "confirmed" | "abandoned";
};

/** A result observed on a WORK branch by O1 (§4.2), before validation. Carries bindingId + workCommit so V3's binding
 *  check and F5's "registered before cutoff" can be answered from the log, and closureFiles (the sorted (path,blobOid)
 *  raw material) so the V6 closure + the P2-1 evidence are pinned at observe time (not recomputed later). The closure
 *  digest is DERIVED from resultBlobOid + closureFiles via computeResultClosureDigest — not stored, to avoid drift. */
export type ResultObserved = {
  observedId: string;
  attemptId: string;
  nodeId: string;
  bindingId: string;
  launchId: string;
  generation: number;
  observedWorkCommit: string;
  resultPath: string;
  resultBlobOid: string;
  closureFiles: Array<{ path: string; blobOid: string }>;
};

/** A rejected candidate written for audit (§2.5). */
export type RejectedResult = {
  attemptId: string;
  nodeId: string;
  reason: string;
  atSeq: number;
};

/** Wait/Approval — a first-class CONTROL entity so every pause is durable and swept, not held in a coordinator's memory
 *  (team-collab §0b R2). Type lives HERE (co-located with Change); transitions are in task-wait.ts. The three states are
 *  decide → execute → confirm, each durable (P1-1): a timeout handler CAS-commits pendingAction BEFORE the IO and only
 *  resolves with evidence — never resolve-then-IO, never IO-then-record. */
export type WaitKind = "wait" | "approval";
export type WaitState = "open" | "action_pending" | "resolved";
export type ApprovalDecision = "pending" | "granted" | "denied" | "cancelled";

/** Typed anchoring (P2-1): a wait binds a concrete execution object; a stale wait must not act on a new binding/attempt. */
export type WaitSubject = {
  jobId: string;
  attemptId?: string;
  bindingId?: string;
  observedResultId?: string;
  validationRunId?: string;
  approvalRequestId?: string;
};

export type PendingAction = { actionId: string; actionKind: string; target: string; expectedSubjectVersion: number };
/** occurredAtSec (dead-letter R5-B): the wall-clock second at which the fact this resolution proves ACTUALLY occurred
 *  (the recovery/close moment), supplied by the committing IO — NOT the later moment the sweep observes the close. The
 *  pure layer only stores it. Optional + absent = current behavior (same additive precedent as payloadRef): a bare close
 *  carries no boundary, and an incident-boundary consumer (failureReopensIncident) then fails toward reopening rather
 *  than silently swallowing a post-recovery failure. It is the ONLY datum that separates a pre-recovery burst from a
 *  post-recovery one when both are observed at the same later tick. */
export type WaitResolution = { outcome: string; reason: string; sourceOperationId: string; occurredAtSec?: number };

export type WaitRecord = {
  waitId: string;
  kind: WaitKind;
  subject: WaitSubject;
  state: WaitState;
  deadlineSec: number;
  owner: string;
  /** Predefined policy ref: a reversible/non-privileged wait may bypass on timeout; a privileged/irreversible one escalates. */
  timeoutPolicy: "bypass" | "escalate";
  pendingAction?: PendingAction;
  resolution?: WaitResolution;
  escalatedAt?: number;
  /** R3-b (问询不裸等): a query-wait (kind="wait", timeoutPolicy="bypass") carries a pre-stored default answer applied
   *  on timeout via close(outcome "default-applied"). Durable so the sweep and recovery both see it. Set ONLY by
   *  openQueryWait; an approval (real gate) must NOT carry one — it bare-waits. */
  defaultOnTimeout?: WaitResolution;
  /** T3 needsClarification carrier (payloadRef): a content-addressed digest ref to the immutable bundle
   *  {original draft + PRD version + frozenContext version refs} a planner must re-read to resume compilation after
   *  the query resolves. Explicit record over path convention (supervision chain — the resume reference travels IN the
   *  durable record, not by an implicit "derive it from waitId"). Bundle storage/retrieval is the IO layer's (T3b);
   *  this field only pins the ref. Optional. */
  payloadRef?: string;
  // --- approval branch (kind="approval"): resolved != granted (P1-2). ---
  actionRef?: string;
  paramsDigest?: string;
  approvalAuthority?: string;
  decision?: ApprovalDecision;
  grantRef?: string;
  preauthorizationRef?: string;
  /** R3: explanatory audit only — NOT the authority fact (a missing reason is a malformed request, never auto-grant). */
  approvalReason?: string;
};

/** A validation execution record (team-collab §0b, R2 P2-2): when a candidate is observed but can't be VALIDATED (V8
 *  environment broke / timed out), this does NOT become business transient-infra — the pinned candidate is fine, only
 *  the validator is stuck. We open a new validation run at a different validator location, re-using the SAME pinned
 *  candidate (business is NOT re-run), and fence the old validator's late reply by generation (peer-late analog to the
 *  ExecutionBinding (launchId,generation) seam). Durable so run/candidate identity survives a crash (impl obligation 3).
 *  Type lives here (co-located with Change); transitions are in task-validation.ts. */
export type ValidationRunState = "running" | "verdict_pending" | "closed";
export type ValidationCandidateRef = { observedResultId: string; observedWorkCommit: string; resultClosureDigest: string };
export type ValidationRun = {
  validationRunId: string;
  attemptId: string;
  /** The PINNED candidate — identical across every run for this attempt (business is never re-run). */
  candidateRef: ValidationCandidateRef;
  /** Monotonic; a new validator execution location = a new generation. A verdict from an older generation is fenced. */
  generation: number;
  validatorLocation: string;
  state: ValidationRunState;
  openedAtSeq: number;
  closedAtSeq?: number;
  closeReason?: "verdict-accepted" | "superseded" | "cancelled";
};

export type ChangeBody =
  | { put: "plan"; plan: TaskPlan }
  | { put: "attempt"; attempt: TaskAttempt }
  | { put: "observed"; observed: ResultObserved }
  | { put: "accepted"; accepted: AcceptedResult }
  | { put: "rejected"; rejected: RejectedResult }
  | { put: "supersede"; acceptedResultId: string }
  | { put: "intent"; intent: DispatchIntent }
  | { put: "wait"; wait: WaitRecord }
  | { put: "validationRun"; validationRun: ValidationRun }
  | { put: "lifecycle"; record: ControlRecord }
  | { put: "scan"; branch: string; cursor: string | null }
  | { put: "tombstone"; launchId: string }
  | { put: "opsReceipt"; ops: OpsReceiptRecord }; // F53: a coordinator spawn/inject fired, awaiting durable proof (additive, FC-7)

/** Each Change carries its operation identity (§2.6): a globally-unique operationId and the entityRevision the caller
 *  believed the target entity was at. */
export type Change = ChangeBody & { operationId: string; expectedEntityRevision: number };

export type LogState = {
  seq: number;
  revisions: Record<string, number>; // entityKey -> current entityRevision (count of applied ops)
  operations: Record<string, string>; // operationId -> payload digest (for replay/conflict detection)
  frozen: string[]; // entityKeys frozen by an op-conflict
  entities: Record<string, ChangeBody>; // entityKey -> last-applied body (the projection)
};

export type CommittedBatch = { seq: number; changes: Change[] };

export type CommitResult =
  | { ok: true; newSeq: number; replay: boolean }
  | { ok: false; reason: "seq"; currentSeq: number }
  | { ok: false; reason: "op-conflict"; operationId: string; entityKey: string }
  | { ok: false; reason: "stale-entity"; entityKey: string; currentRevision: number }
  | { ok: false; reason: "batch"; detail: string };

export function initialLogState(): LogState {
  return { seq: 0, revisions: {}, operations: {}, frozen: [], entities: {} };
}

export function entityKeyOf(c: ChangeBody): string {
  switch (c.put) {
    case "plan": return `plan:${c.plan.jobId}`;
    case "attempt": return `attempt:${c.attempt.attemptId}`;
    case "observed": return `observed:${c.observed.observedId}`;
    case "accepted": return `accepted:${c.accepted.acceptedResultId}`;
    case "rejected": return `rejected:${c.rejected.attemptId}:${c.rejected.atSeq}`;
    case "supersede": return `accepted:${c.acceptedResultId}`; // modifies that accepted entity
    case "intent": return `intent:${c.intent.intentId}`;
    case "wait": return `wait:${c.wait.waitId}`;
    case "validationRun": return `validationRun:${c.validationRun.validationRunId}`;
    case "lifecycle": return `lifecycle:${c.record.launchId}`;
    case "scan": return `scan:${c.branch}`;
    case "tombstone": return `tombstone:${c.launchId}`;
    case "opsReceipt": return `opsReceipt:${c.ops.opId}`;
  }
}

function bodyOf(c: Change): ChangeBody {
  const { operationId: _o, expectedEntityRevision: _r, ...body } = c;
  return body as ChangeBody;
}

export function payloadDigestOf(c: Change): string {
  return digestOf(bodyOf(c));
}

function applyChanges(state: LogState, changes: Change[]): LogState {
  const revisions = { ...state.revisions };
  const operations = { ...state.operations };
  const entities = { ...state.entities };
  for (const c of changes) {
    const key = entityKeyOf(c);
    revisions[key] = (revisions[key] ?? 0) + 1;
    operations[c.operationId] = payloadDigestOf(c);
    if (c.put === "supersede") {
      // supersede keys to accepted:<id> — it MUTATES that AcceptedResult's superseded flag, it does NOT replace the
      // entity body with the supersede op (which would lose observedWorkCommit/resultPath/decidedAtSeq and break both
      // currentAccepted and the results.json projection — fe0376cd T2 review #2 P1). Target existence is validated in
      // commit(); on the replay path a valid log guarantees the accepted was put first, so a miss here is a corrupt log.
      const existing = entities[key];
      if (existing === undefined || existing.put !== "accepted") throw new Error(`supersede target ${key} missing or not an accepted`);
      entities[key] = { put: "accepted", accepted: { ...existing.accepted, superseded: true } };
    } else {
      entities[key] = bodyOf(c);
    }
  }
  return { ...state, seq: state.seq + 1, revisions, operations, entities };
}

/** Decide + (on success) produce the next state for one batch. Pure; group-atomic. See the module header for the
 *  mandated decision order. On an op-conflict the offending entity is FROZEN (that state change persists even though
 *  the batch's puts are not applied); every other failure leaves state untouched. */
export function commit(state: LogState, expectedSeq: number, changes: Change[]): { result: CommitResult; state: LogState } {
  if (changes.length === 0) return { result: { ok: false, reason: "batch", detail: "empty batch" }, state };

  // Classify each change against already-applied operations (replay / conflict / new).
  let replays = 0;
  let news = 0;
  for (const c of changes) {
    const prior = state.operations[c.operationId];
    const digest = payloadDigestOf(c);
    if (prior !== undefined && prior !== digest) {
      // 2. op-conflict — precedence over everything; freeze the entity.
      const entityKey = entityKeyOf(c);
      const frozen = state.frozen.includes(entityKey) ? state.frozen : [...state.frozen, entityKey];
      return { result: { ok: false, reason: "op-conflict", operationId: c.operationId, entityKey }, state: { ...state, frozen } };
    }
    if (prior !== undefined) replays += 1;
    else news += 1;
  }

  // 1. full replay — precedes seq AND revision checks (crash-recovery idempotency).
  if (replays === changes.length) return { result: { ok: true, newSeq: state.seq, replay: true }, state };
  // mixed replay + new in one batch = operationId collision across batches (caller bug).
  if (replays > 0) return { result: { ok: false, reason: "batch", detail: "mixed replay and new changes in one batch" }, state };

  // all-new batch from here.
  if (expectedSeq !== state.seq) return { result: { ok: false, reason: "seq", currentSeq: state.seq }, state };

  // 4. no entity put twice in one batch.
  const seen = new Set<string>();
  for (const c of changes) {
    const key = entityKeyOf(c);
    if (seen.has(key)) return { result: { ok: false, reason: "batch", detail: `entity ${key} put twice in one batch` }, state };
    seen.add(key);
  }

  // 3. each new op must match the entity's current revision, the entity must not be frozen, and a supersede must
  //    target an existing accepted (superseding a nonexistent/non-accepted entity is a caller bug — fail-fast).
  for (const c of changes) {
    const key = entityKeyOf(c);
    if (state.frozen.includes(key)) return { result: { ok: false, reason: "batch", detail: `entity ${key} is frozen` }, state };
    if (c.put === "supersede") {
      const existing = state.entities[key];
      if (existing === undefined || existing.put !== "accepted") return { result: { ok: false, reason: "batch", detail: `supersede target ${key} missing or not an accepted` }, state };
    }
    const current = state.revisions[key] ?? 0;
    if (c.expectedEntityRevision !== current) return { result: { ok: false, reason: "stale-entity", entityKey: key, currentRevision: current }, state };
  }

  return { result: { ok: true, newSeq: state.seq + 1, replay: false }, state: applyChanges(state, changes) };
}

/** Rebuild LogState by folding the ordered, already-committed log — crash recovery + projection (§4.3). The log is
 *  authoritative, so this APPLIES each batch without re-deciding; it only asserts contiguous seq to catch a gap. */
export function replayLog(batches: CommittedBatch[]): LogState {
  let state = initialLogState();
  for (const b of batches) {
    if (b.seq !== state.seq + 1) throw new Error(`replayLog: seq gap, expected ${state.seq + 1} got ${b.seq}`);
    state = applyChanges(state, b.changes);
  }
  return state;
}

/** F17 (§4.3 step B): after a `git push --force-with-lease` to the CONTROL repo, read the ref back and decide. A lease
 *  can report "up-to-date" success on a stale same-target push, so "push ok" ≠ "I wrote it". Compare the batch already
 *  on the chain to the batch we intended: identical operation identities (operationId → payload digest) ⇒ ADVANCE
 *  (idempotent — whoever wrote it, same op + same digest is equivalent, §2.6); any difference ⇒ HALT (a second active
 *  dispatcher is a deploy accident — stop, do not split-brain). Pure; shares payloadDigestOf with the local engine so
 *  "equivalent" means exactly what a replay means. */
export function reconcilePush(intended: Change[], onChain: Change[]): "advance" | "halt" {
  const fingerprint = (changes: Change[]): string => {
    const ops = changes.map((c) => `${c.operationId}=${payloadDigestOf(c)}`).sort();
    return digestOf(ops);
  };
  return fingerprint(intended) === fingerprint(onChain) ? "advance" : "halt";
}

/** The projection minus tombstoned lifecycle records and the tombstone markers themselves. Discovery MUST consult
 *  this (not the raw entities) so a deleted launch is not resurrected (§4.3: "discovery 查 tombstone"). */
export function liveEntities(state: LogState): Record<string, ChangeBody> {
  const tombstoned = new Set<string>();
  for (const [key, body] of Object.entries(state.entities)) {
    if (body.put === "tombstone") tombstoned.add(body.launchId);
    void key;
  }
  const out: Record<string, ChangeBody> = {};
  for (const [key, body] of Object.entries(state.entities)) {
    if (body.put === "tombstone") continue;
    if (body.put === "lifecycle" && tombstoned.has(body.record.launchId)) continue;
    out[key] = body;
  }
  return out;
}
