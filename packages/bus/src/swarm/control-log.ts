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
 */

import { digestOf } from "./digest.js";
import type { TaskPlan } from "./task-plan.js";
import type { TaskAttempt } from "./task-state.js";
import type { AcceptedResult } from "./task-result.js";
import type { ControlRecord } from "./control.js";

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

/** A result observed on a WORK branch by O1 (§4.2), before validation. */
export type ResultObserved = {
  observedId: string;
  attemptId: string;
  nodeId: string;
  launchId: string;
  generation: number;
  observedWorkCommit: string;
  resultPath: string;
  resultBlobOid: string;
  resultClosureDigest: string;
};

/** A rejected candidate written for audit (§2.5). */
export type RejectedResult = {
  attemptId: string;
  nodeId: string;
  reason: string;
  atSeq: number;
};

export type ChangeBody =
  | { put: "plan"; plan: TaskPlan }
  | { put: "attempt"; attempt: TaskAttempt }
  | { put: "observed"; observed: ResultObserved }
  | { put: "accepted"; accepted: AcceptedResult }
  | { put: "rejected"; rejected: RejectedResult }
  | { put: "supersede"; acceptedResultId: string }
  | { put: "intent"; intent: DispatchIntent }
  | { put: "lifecycle"; record: ControlRecord }
  | { put: "scan"; branch: string; cursor: string | null }
  | { put: "tombstone"; launchId: string };

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
    case "lifecycle": return `lifecycle:${c.record.launchId}`;
    case "scan": return `scan:${c.branch}`;
    case "tombstone": return `tombstone:${c.launchId}`;
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
    entities[key] = bodyOf(c);
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

  // 3. each new op must match the entity's current revision, and the entity must not be frozen.
  for (const c of changes) {
    const key = entityKeyOf(c);
    if (state.frozen.includes(key)) return { result: { ok: false, reason: "batch", detail: `entity ${key} is frozen` }, state };
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
