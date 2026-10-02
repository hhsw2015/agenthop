/**
 * Handoff orchestration step (one record, one pass). The single-active dispatcher's decision layer: it OBSERVES a
 * record's WORK branch, applies the authoritative clock (drain near deadline / expire when physically gone), then
 * EXECUTES the pure nextAction (claim -> allocate a successor -> await its first publish -> resumed -> retire, plus the
 * reconcile / give_up crash edges). All IO is behind an injected `ops` layer so the whole handoff is unit-testable
 * offline; scripts/swarm-dispatch.ts wires the real IO (git observe, swarm-launch, swarm-task --resume, scrub).
 *
 * Generation model: `record.generation` is the OWNER generation (bumped on each claim/reclaim). A successor publishes
 * at that bumped generation (swarm-task --resume sets SWARM_GENERATION accordingly), so a box's branch is always
 * swarm/<launchId>-g<generation> and the manifest's generation matches the record it belongs to. The successor is a
 * SEPARATE record (two-record model): the predecessor advances RUNNING->...->RESUMED->RETIRED; the successor is a
 * fresh RUNNING record that resumes from the predecessor's pinned handoffSha.
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
  /** Gate the handoff ACTIONS (claim/allocate/resume/reconcile/retire). When false, observe + authoritative clock
   *  (drain/expire) still run and record progress, but no VM is allocated/retired — a safe default until SWARM_EXEC. */
  execEnabled: boolean;
  /** Observe a WORK branch tip for `launchId` (pin sha, read manifest FROM it, ancestry vs lastSha). null = none/err. */
  observeTip: (branch: string, lastSha: string | undefined, launchId: string) => Promise<ObservedTip | null>;
  /** Allocate a FRESH successor box; returns its launchId, or null on failure (runs swarm-launch new). */
  allocateSuccessor: (predecessor: ControlRecord) => Promise<string | null>;
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

function apply(r: ControlRecord, ev: ControlEvent, ops: HandoffOps): ControlRecord {
  const res = advance(r, ev, ops.nowSec());
  if (!res.ok) {
    ops.log(`event ${ev.type} on ${r.launchId} rejected: ${res.error}`);
    return r;
  }
  ops.persist(res.record);
  return res.record;
}

/** Drive ONE record through observe -> clock -> nextAction EXEC. Mutates `records` (adds the successor on allocate,
 *  advances the predecessor). Returns the updated record. */
export async function handoffStep(
  rIn: ControlRecord,
  records: Map<string, ControlRecord>,
  ops: HandoffOps,
): Promise<ControlRecord> {
  let r = rIn;
  if (r.state === "RETIRED" || r.state === "DONE") return r;

  // 1) Observe this box's OWN branch and accept forward progress — only in states where it still publishes
  //    (RUNNING/DRAINING) or where a late tip advances recovery (EXPIRED). Once CLAIMED/ALLOCATING/RESUMED the box's
  //    work is frozen at handoffSha; its branch would be queried at the new owner generation and is not expected.
  if (r.state === "RUNNING" || r.state === "DRAINING" || r.state === "EXPIRED") {
    const tip = await ops.observeTip(branchFor(r.launchId, r.generation), r.sha, r.launchId);
    if (tip) {
      const dec = tipToEvent(r, tip);
      if (dec.kind === "advance") r = apply(r, dec.event, ops);
    }
  }

  // 2) Authoritative clock: drain near the deadline; expire if the box is likely physically gone.
  const deadline = r.allocStart + r.budgetSec;
  if (r.state === "RUNNING" && ops.nowSec() >= deadline - ops.handoffLeadSec) {
    r = apply(r, { type: "drain" }, ops);
    ops.log(`${r.launchId} DRAINING (T-${deadline - ops.nowSec()}s)`);
  }
  if (r.state !== "RETIRED" && r.state !== "DONE" && r.state !== "EXPIRED" && likelyExpired(r, ops.nowSec())) {
    r = apply(r, { type: "expire" }, ops);
    ops.notify(`box ${r.launchId} expired; recoverySha=${r.sha ?? "none"}`);
  }

  // 3) Handoff EXEC via the pure decision. liveCount is a snapshot of non-terminal records (incl. in-flight successors).
  const liveCount = [...records.values()].filter((x) => x.state !== "RETIRED" && x.state !== "DONE").length;
  const action = nextAction(r, ops.nowSec(), { self: ops.self, cap: ops.cap, liveCount });
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
      return apply(r, { type: "claim", owner: ops.self, generation: r.generation + 1, leaseUntil: lease() }, ops);
    case "reclaim":
      return apply(r, { type: "reclaim", owner: ops.self, generation: r.generation + 1, leaseUntil: lease() }, ops);
    case "reconcile":
      return reconcile(r, ops);
    case "allocate":
      return allocate(r, records, ops);
    case "await_resume":
      return awaitResume(r, ops);
    case "retire_predecessor":
      await ops.scrubBox(r.launchId);
      return apply(r, { type: "retire" }, ops);
    case "give_up":
      ops.notify(`box ${r.launchId}: allocation attempts exhausted (${r.attemptCount ?? 0}); needs manual attention`);
      return r;
    default:
      return r;
  }
}

async function allocate(r: ControlRecord, records: Map<string, ControlRecord>, ops: HandoffOps): Promise<ControlRecord> {
  // Resume from the CONFIRMED checkpoint sha. handoffSha is pinned BY the allocating event (= record.sha) and is still
  // undefined at CLAIMED, so gate on r.sha here, not r.handoffSha.
  const handoffSha = r.sha;
  if (handoffSha === undefined) {
    ops.log(`${r.launchId}: allocate with no confirmed sha to resume from; skipping`);
    return r;
  }
  const successor = await ops.allocateSuccessor(r);
  if (!successor) {
    ops.notify(`${r.launchId}: successor allocation failed; will retry next pass`);
    return r; // stays CLAIMED; nextAction re-issues allocate
  }
  const gen = r.generation; // successor publishes at the owner generation
  // Record the attempt + successor on the predecessor (allocating pins handoffSha=r.sha + successor), THEN resume IO.
  r = apply(r, { type: "allocating", attempt: `att-${gen}-${ops.nowSec()}`, successor }, ops);
  // Create the successor's OWN RUNNING record so its branch is observed going forward and it survives a restart.
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
  const ok = await ops.resumeSuccessor({ successor, handoffSha, generation: gen, branch: branchFor(successor, gen) });
  if (!ok) {
    r = apply(r, { type: "alloc_unknown" }, ops); // result unknown -> reconciled next pass, not blind-retried
    ops.log(`${r.launchId}: resume IO result unknown; will reconcile`);
  }
  return r;
}

async function reconcile(r: ControlRecord, ops: HandoffOps): Promise<ControlRecord> {
  // Did the in-flight successor actually come up? Check its branch: a confirmed descendant commit => ALIVE (re-enter
  // await-resume), else => DEAD (clear the attempt so a fresh allocate can run).
  if (!r.successor) return apply(r, { type: "reconcile_dead" }, ops);
  const tip = await ops.observeTip(branchFor(r.successor, r.generation), r.handoffSha, r.successor);
  if (tip && tip.manifest && tip.manifest.launchId === r.successor) return apply(r, { type: "reconcile_alive" }, ops);
  return apply(r, { type: "reconcile_dead" }, ops);
}

async function awaitResume(r: ControlRecord, ops: HandoffOps): Promise<ControlRecord> {
  if (!r.successor || r.handoffSha === undefined || r.attempt === undefined) return r;
  const tip = await ops.observeTip(branchFor(r.successor, r.generation), r.handoffSha, r.successor);
  if (!tip || !tip.manifest || tip.manifest.launchId !== r.successor) return r; // not published yet -> keep waiting
  if (!tip.isDescendantOfAccepted) {
    ops.log(`${r.launchId}: successor ${r.successor} tip ${tip.sha.slice(0, 8)} not a descendant of handoffSha; ignoring`);
    return r;
  }
  // Successor published its first snapshot descending from handoffSha -> resumed-ACK (verified against the pinned sha).
  return apply(r, { type: "resumed", successor: r.successor, sha: r.handoffSha, generation: r.generation, attempt: r.attempt }, ops);
}
