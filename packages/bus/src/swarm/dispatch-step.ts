/**
 * Handoff orchestration step (one record, one pass). The single-active dispatcher's decision layer: it OBSERVES a
 * record's WORK branch, applies the authoritative clock (drain near deadline / expire when physically gone), then
 * EXECUTES the pure nextAction (claim -> allocate a successor -> await its first publish -> resumed -> retire, plus the
 * reconcile / give_up crash edges). All IO is behind an injected `ops` layer so the whole handoff is unit-testable
 * offline; scripts/swarm-dispatch.ts wires the real IO (git observe, swarm-launch, swarm-task --resume, scrub).
 *
 * Generation model: `record.generation` is the OWNER generation (bumped on claim/reclaim). The SUCCESSOR's publish
 * generation is pinned per-attempt in `record.successorGen` at `allocating` — a reclaim bumps the owner generation but
 * the already-allocated successor still publishes at swarm/<successor>-g<successorGen>, so reconcile/await-resume
 * observe THAT branch. Two-record model: the predecessor advances RUNNING->...->RESUMED->RETIRED; the successor is a
 * fresh RUNNING record resumed from the predecessor's pinned handoffSha.
 *
 * Recovery discipline (Codex): CAS-then-IO (persist the attempt BEFORE the allocate IO, so a crash leaves a
 * reconcilable ALLOCATING, never a silent re-alloc); the Map is synced on every persisted transition; the attempt is
 * cleared ONLY on a RELIABLE clean failure (alloc_failed) or physical death (reconcile_dead), never on a transient
 * query error / not-yet-published; the successor slot is RESERVED at claim so the cap is never exceeded.
 */

import {
  advance,
  DEFAULT_LEASE_SEC,
  type ControlEvent,
  type ControlRecord,
  type DispatchAction,
  likelyExpired,
  nextAction,
} from "./control.js";
import { type ObservedTip, tipToEvent } from "./acceptance.js";

export type HandoffOps = {
  nowSec: () => number;
  self: string;
  cap: number;
  budgetSec: number;
  handoffLeadSec: number;
  /** Gate the handoff ACTIONS (claim/allocate/resume/reconcile/retire). When false, observe + clock still run. */
  execEnabled: boolean;
  /** Mint a fresh successor launchId BEFORE the allocate IO (so the attempt is recorded CAS-then-IO). */
  newLaunchId: () => string;
  /** Observe a WORK branch tip for `launchId` (pin sha, read manifest FROM it, ancestry vs lastSha). null = none/err. */
  observeTip: (branch: string, lastSha: string | undefined, launchId: string) => Promise<ObservedTip | null>;
  /** Allocate the given successor box (runs swarm-launch allocate-only). "ok" = created; "clean-fail" = RELIABLY not
   *  created (provider refusal); "unknown" = result lost (box may exist). */
  allocateSuccessor: (predecessor: ControlRecord, successorId: string) => Promise<"ok" | "clean-fail" | "unknown">;
  /** Tell the successor to resume from handoffSha, publishing to `branch` at `generation` (runs swarm-task --resume).
   *  true = resume command accepted; false = result unknown (reconcile next pass). */
  resumeSuccessor: (a: { successor: string; handoffSha: string; generation: number; branch: string }) => Promise<boolean>;
  /** Best-effort scrub of a retired predecessor box. */
  scrubBox: (launchId: string) => Promise<void>;
  notify: (msg: string) => void;
  /** Persist a record to the durable mirror. */
  persist: (r: ControlRecord) => void;
  log: (m: string) => void;
};

export function branchFor(launchId: string, generation: number): string {
  return `swarm/${launchId}-g${generation}`;
}

/** Advance + persist + sync the in-memory Map in ONE place, so a later IO throw can never leave the Map on a stale
 *  pre-transition state that a next pass would re-execute (Codex P1-5). Returns the updated record (or the old one on
 *  a rejected transition). */
function apply(r: ControlRecord, ev: ControlEvent, ops: HandoffOps, records: Map<string, ControlRecord>): ControlRecord {
  const res = advance(r, ev, ops.nowSec());
  if (!res.ok) {
    ops.log(`event ${ev.type} on ${r.launchId} rejected: ${res.error}`);
    return r;
  }
  ops.persist(res.record); // may throw -> caller/pass() catches; the Map is NOT yet updated, consistent with no IO run
  records.set(res.record.launchId, res.record);
  return res.record;
}

/** Non-terminal records count toward the cap; a CLAIMED record without a successor yet RESERVES one more slot (it will
 *  allocate a successor), so two predecessors can't both claim the last slot (Codex P1-6). */
function effectiveLive(records: Map<string, ControlRecord>): number {
  let live = 0;
  let reservations = 0;
  for (const x of records.values()) {
    if (x.state === "RETIRED" || x.state === "DONE") continue;
    live++;
    if (x.state === "CLAIMED" && !x.successor) reservations++;
  }
  return live + reservations;
}

/** Drive ONE record through observe -> clock -> gated nextAction EXEC. Mutates `records`. Returns the updated record. */
export async function handoffStep(
  rIn: ControlRecord,
  records: Map<string, ControlRecord>,
  ops: HandoffOps,
): Promise<ControlRecord> {
  let r = rIn;
  if (r.state === "RETIRED" || r.state === "DONE") return r;

  // 1) Observe this box's OWN branch and accept forward progress — only while it still publishes (RUNNING/DRAINING) or
  //    a late tip advances recovery (EXPIRED). Once CLAIMED/ALLOCATING/RESUMED its work is frozen at handoffSha.
  if (r.state === "RUNNING" || r.state === "DRAINING" || r.state === "EXPIRED") {
    const tip = await ops.observeTip(branchFor(r.launchId, r.generation), r.sha, r.launchId);
    if (tip) {
      const dec = tipToEvent(r, tip);
      if (dec.kind === "advance") r = apply(r, dec.event, ops, records);
    }
  }

  // 2) Authoritative clock: drain near the deadline (RUNNING only); expire ONLY a still-live box (RUNNING/DRAINING) —
  //    a CLAIMED/ALLOCATING/RESUMED record is the recovery process, not the box, and must not be re-expired (Codex).
  const deadline = r.allocStart + r.budgetSec;
  if (r.state === "RUNNING" && ops.nowSec() >= deadline - ops.handoffLeadSec) {
    r = apply(r, { type: "drain" }, ops, records);
    ops.log(`${r.launchId} DRAINING (T-${deadline - ops.nowSec()}s)`);
  }
  if ((r.state === "RUNNING" || r.state === "DRAINING") && likelyExpired(r, ops.nowSec())) {
    r = apply(r, { type: "expire" }, ops, records);
    ops.notify(`box ${r.launchId} expired; recoverySha=${r.sha ?? "none"}`);
  }

  // 3) Handoff EXEC via the pure decision (gated).
  const action = nextAction(r, ops.nowSec(), { self: ops.self, cap: ops.cap, liveCount: effectiveLive(records) });
  if (ops.execEnabled) {
    r = await runAction(r, action, records, ops);
  } else if (action !== "none") {
    ops.log(`${r.launchId}: would ${action} (handoff exec gated — set SWARM_EXEC=1 to enable)`);
  }

  records.set(r.launchId, r);
  return r;
}

async function runAction(
  r: ControlRecord,
  action: DispatchAction,
  records: Map<string, ControlRecord>,
  ops: HandoffOps,
): Promise<ControlRecord> {
  const lease = () => ops.nowSec() + DEFAULT_LEASE_SEC;
  switch (action) {
    case "none":
      return r;
    case "claim":
      return apply(r, { type: "claim", owner: ops.self, generation: r.generation + 1, leaseUntil: lease() }, ops, records);
    case "reclaim":
      return apply(r, { type: "reclaim", owner: ops.self, generation: r.generation + 1, leaseUntil: lease() }, ops, records);
    case "reconcile":
      return reconcile(r, records, ops);
    case "allocate":
      return allocate(r, records, ops);
    case "await_resume":
      return awaitResume(r, records, ops);
    case "retire_predecessor":
      await ops.scrubBox(r.launchId);
      return apply(r, { type: "retire" }, ops, records);
    case "give_up":
      ops.notify(`box ${r.launchId}: allocation attempts exhausted (${r.attemptCount ?? 0}); needs manual attention`);
      return r;
    default:
      return r;
  }
}

async function allocate(r: ControlRecord, records: Map<string, ControlRecord>, ops: HandoffOps): Promise<ControlRecord> {
  const handoffSha = r.sha; // resume from the CONFIRMED checkpoint; the allocating event pins it as handoffSha
  if (handoffSha === undefined) {
    ops.log(`${r.launchId}: allocate with no confirmed sha to resume from; skipping`);
    return r;
  }
  const gen = r.generation;
  const successor = ops.newLaunchId();
  // CAS-then-IO: record the attempt + successor (and pin successorGen=gen) FIRST and persist, BEFORE any IO. A throw in
  // persist leaves no box created (IO not reached); a throw AFTER leaves a durable ALLOCATING the next pass reconciles.
  r = apply(r, { type: "allocating", attempt: `att-${gen}-${successor}`, successor }, ops, records);
  if (r.state !== "ALLOCATING") return r; // transition rejected -> do not run IO

  const res = await ops.allocateSuccessor(r, successor);
  if (res === "clean-fail") {
    // RELIABLY not created -> clear the attempt (bounded immediate retry); no successor record, no phantom slot.
    ops.log(`${r.launchId}: successor ${successor} clean-fail; clearing attempt for retry`);
    return apply(r, { type: "alloc_failed" }, ops, records);
  }
  // ok OR unknown: a box may exist publishing to swarm/<successor>-g<gen>. Create its record (reserve slot + pin gen).
  const succ: ControlRecord = {
    launchId: successor,
    state: "RUNNING",
    generation: gen,
    handoffSha,
    allocStart: ops.nowSec(),
    budgetSec: ops.budgetSec,
    deadlineEpoch: ops.nowSec() + ops.budgetSec,
    updatedAt: ops.nowSec(),
  };
  records.set(successor, succ);
  ops.persist(succ);
  if (res === "unknown") {
    ops.log(`${r.launchId}: successor ${successor} allocate UNKNOWN; retained, will reconcile`);
    return apply(r, { type: "alloc_unknown" }, ops, records);
  }
  // res === "ok": tell the successor to resume from handoffSha.
  const ok = await ops.resumeSuccessor({ successor, handoffSha, generation: gen, branch: branchFor(successor, gen) });
  if (!ok) {
    ops.log(`${r.launchId}: resume IO result unknown; will reconcile`);
    return apply(r, { type: "alloc_unknown" }, ops, records);
  }
  return r;
}

async function reconcile(r: ControlRecord, records: Map<string, ControlRecord>, ops: HandoffOps): Promise<ControlRecord> {
  if (!r.successor) return apply(r, { type: "reconcile_dead" }, ops, records); // nothing pinned to reconcile
  const sgen = r.successorGen ?? r.generation; // the successor publishes at its pinned gen, NOT the bumped owner gen
  const tip = await ops.observeTip(branchFor(r.successor, sgen), undefined, r.successor);
  if (tip && tip.manifest && tip.manifest.launchId === r.successor && tip.manifest.generation === sgen) {
    return apply(r, { type: "reconcile_alive" }, ops, records); // the successor published -> ALIVE
  }
  // Not observed publishing. Declare DEAD only on RELIABLE evidence — the successor is physically past its deadline.
  // A transient git error / not-yet-published must NOT clear the attempt (Codex: don't judge a live box dead).
  const succ = records.get(r.successor);
  if (succ && likelyExpired(succ, ops.nowSec())) return apply(r, { type: "reconcile_dead" }, ops, records);
  ops.log(`${r.launchId}: reconcile ${r.successor} inconclusive (not published, not expired) — retaining attempt`);
  return r;
}

async function awaitResume(r: ControlRecord, records: Map<string, ControlRecord>, ops: HandoffOps): Promise<ControlRecord> {
  if (!r.successor || r.handoffSha === undefined || r.attempt === undefined) return r;
  const sgen = r.successorGen ?? r.generation;
  const tip = await ops.observeTip(branchFor(r.successor, sgen), r.handoffSha, r.successor);
  if (!tip || !tip.manifest) return r;                   // not published / transient -> keep waiting
  if (tip.manifest.launchId !== r.successor) return r;   // the seed (predecessor's manifest) -> not resumed yet
  if (tip.manifest.generation !== sgen) { ops.log(`${r.launchId}: successor tip gen ${tip.manifest.generation} != pinned ${sgen}; ignoring`); return r; }
  if (tip.manifest.kind !== "milestone" && tip.manifest.kind !== "final") {
    // A supervisor auto-rescue is NOT proof the worker took over — require a worker-driven milestone/final (Codex).
    ops.log(`${r.launchId}: successor tip kind=${tip.manifest.kind} (not worker-driven) — not a resumed-ACK yet`);
    return r;
  }
  if (!tip.isDescendantOfAccepted) { ops.log(`${r.launchId}: successor tip not a descendant of handoffSha; ignoring`); return r; }
  // A REAL successor milestone at the pinned publish-generation, descending from handoffSha -> resumed-ACK.
  return apply(r, { type: "resumed", successor: r.successor, sha: r.handoffSha, generation: r.generation, attempt: r.attempt }, ops, records);
}
