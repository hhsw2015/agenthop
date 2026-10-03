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
  allocExhausted,
  DEFAULT_LEASE_SEC,
  type ControlEvent,
  type ControlRecord,
  type DispatchAction,
  likelyExpired,
  nextAction,
  physicallyOccupies,
  PROVIDER_LIFETIME_SEC,
} from "./control.js";
import { type ObservedTip, tipToEvent } from "./acceptance.js";

export type HandoffOps = {
  nowSec: () => number;
  self: string;
  cap: number;
  budgetSec: number;
  /** The PROVIDER's physical VM lifetime bound (s), pinned per attempt onto records so physical death is proven by the
   *  provider's lifetime, never the (shorter, configurable) work budget (Codex P1-2). */
  physicalLifetimeSec: number;
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
  /** Best-effort scrub of a retired predecessor box. Returns true ONLY if it RELIABLY terminated the VM (so the slot
   *  can be freed now); false = best-effort / unconfirmed, so the slot stays occupied until the box's deadline. */
  scrubBox: (launchId: string) => Promise<boolean>;
  notify: (msg: string) => void;
  /** Persist a record to the durable mirror. */
  persist: (r: ControlRecord) => void;
  /** Remove a record from the durable mirror + Map (a successor whose box was RELIABLY never created / is dead). */
  removeRecord: (launchId: string) => void;
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

/**
 * Boxes counting against the cap = PHYSICAL occupancy, not task state (Codex P1-2: cap is concurrent boxes). A record
 * occupies a slot while its VM may still be alive (physicallyOccupies: not reliably scrubbed, not past deadline) —
 * including a RETIRED/DONE box whose scrub did not confirm termination. On top of counted records, RESERVE a slot for a
 * successor VM that exists (or may exist) but has no counted record of its own yet:
 *  - an IN-FLIGHT attempt (ALLOCATING, or a reclaimed CLAIMED that RETAINED attempt+successor) whose pinned successor
 *    has no record — the crash/reclaim window where the successor VM may already exist but its placeholder was lost or
 *    not yet persisted; it must still count across CLAIMED and ALLOCATING, else a reclaim drops it (Codex P1-1);
 *  - a CLAIMED record with NO attempt that is ABOUT to allocate a fresh successor (Codex P1-6) — but NOT once the
 *    attempt cap is exhausted, since nextAction is then give_up and no successor is ever allocated (no phantom slot,
 *    Codex P2-2).
 */
export function effectiveLive(records: Map<string, ControlRecord>, nowSec: number): number {
  let count = 0;
  for (const x of records.values()) {
    if (physicallyOccupies(x, nowSec)) count++;
    if (x.successor && !records.has(x.successor)) {
      if (x.state === "ALLOCATING" || (x.state === "CLAIMED" && x.attempt !== undefined)) count++; // in-flight successor, record missing (P1-1)
    } else if (x.state === "CLAIMED" && !x.successor && x.attempt === undefined && !allocExhausted(x)) {
      count++; // about to allocate a fresh successor (P1-6), unless give_up (P2-2)
    }
  }
  return count;
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
  const action = nextAction(r, ops.nowSec(), { self: ops.self, cap: ops.cap, liveCount: effectiveLive(records, ops.nowSec()) });
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
    case "retire_predecessor": {
      // scrub is best-effort; only a CONFIRMED termination frees the physical slot now. Otherwise the box stays counted
      // until its deadline (Codex P1-2) — fine in practice, since a handed-off predecessor is already near its deadline.
      const terminated = await ops.scrubBox(r.launchId);
      return apply(r, { type: "retire", reliablyTerminated: terminated }, ops, records);
    }
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
  const reqStart = ops.nowSec(); // the attempt's lifetime base = REQUEST start, not the post-IO ACK (Codex P2-3)
  // CAS-then-IO: record the attempt + successor (pin successorGen=gen and attemptStartSec=reqStart) FIRST and persist,
  // BEFORE any IO. A throw in persist leaves no box created (IO not reached); a throw AFTER leaves a durable ALLOCATING.
  r = apply(r, { type: "allocating", attempt: `att-${gen}-${successor}`, successor, attemptPhysicalSec: ops.physicalLifetimeSec }, ops, records);
  if (r.state !== "ALLOCATING") return r; // transition rejected -> do not run IO

  // Pre-create the successor PLACEHOLDER record BEFORE the allocate IO (Codex P1-1): once persisted it is counted
  // against the cap and carries a reconcilable deadline (allocStart = reqStart), so a crash mid-allocate leaves a
  // slot that is both bounded and terminable — not a phantom with no deadline. Removed again only on a clean-fail.
  const succ: ControlRecord = {
    launchId: successor,
    state: "RUNNING",
    generation: gen,
    handoffSha,
    sha: handoffSha, // confirmed anchor from the start (handoffSha IS a confirmed checkpoint) so recovery of the child
    // never faces an empty sha and skips allocate forever; its own observe advances it as it publishes (Codex P2-5).
    allocStart: reqStart,
    budgetSec: ops.budgetSec,
    physicalLifetimeSec: ops.physicalLifetimeSec, // the successor VM's OWN physical lifetime, else likelyExpired defaults
    // to 3600 and could free a still-live VM early / let reconcile over-cap (Codex P1-02: the normal create path missed it).
    deadlineEpoch: reqStart + ops.budgetSec,
    updatedAt: reqStart,
  };
  records.set(successor, succ);
  ops.persist(succ);

  const res = await ops.allocateSuccessor(r, successor);
  if (res === "clean-fail") {
    // RELIABLY not created -> remove the placeholder (no phantom slot) and clear the attempt (bounded immediate retry).
    ops.log(`${r.launchId}: successor ${successor} clean-fail; removing placeholder + clearing attempt for retry`);
    ops.removeRecord(successor);
    records.delete(successor);
    return apply(r, { type: "alloc_failed" }, ops, records);
  }
  if (res === "unknown") {
    ops.log(`${r.launchId}: successor ${successor} allocate UNKNOWN; placeholder retained, will reconcile`);
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
  const tip = await ops.observeTip(branchFor(r.successor, sgen), r.handoffSha, r.successor);
  // QUALIFIED takeover evidence = a real worker-driven milestone/final at the pinned gen, descending from handoffSha —
  // the SAME bar as awaitResume. A historical/supervisor rescue tip is NOT proof of a live instance, so it must not win
  // over the physical deadline and trap the attempt in an alive->reject->reclaim loop (Codex P2-1).
  const qualified =
    !!tip && !!tip.manifest &&
    tip.manifest.launchId === r.successor &&
    tip.manifest.generation === sgen &&
    (tip.manifest.kind === "milestone" || tip.manifest.kind === "final") &&
    tip.isDescendantOfAccepted === true;
  if (qualified) return apply(r, { type: "reconcile_alive" }, ops, records); // real takeover in progress -> ALIVE

  // Not qualified. Declare DEAD only on RELIABLE physical-deadline evidence — from the successor record if it exists,
  // else the parent's pinned attemptStartSec (the crash window where the placeholder was never persisted, Codex P1-1),
  // so an unknown allocation cannot stay inconclusive forever. A transient error before the deadline retains the attempt.
  const succ = records.get(r.successor);
  // The attempt is physically dead only past the PROVIDER's lifetime, FIXED per attempt — never the current (possibly
  // changed) work budget (Codex P2-1). From the successor record when it exists, else the parent's pinned attempt base +
  // the pinned attemptPhysicalSec (the crash window where the placeholder was never persisted, Codex P1-1/P1-02).
  const expired = succ
    ? likelyExpired(succ, ops.nowSec())
    : r.attemptStartSec !== undefined && ops.nowSec() > r.attemptStartSec + (r.attemptPhysicalSec ?? PROVIDER_LIFETIME_SEC) + 120;
  if (expired) {
    ops.log(`${r.launchId}: successor ${r.successor} past deadline, no qualified takeover — declaring dead`);
    // Carry the dead child's confirmed recovery point (anchored from a verified descendant of handoffSha in awaitResume)
    // forward to the parent, so the replacement resumes from the newest confirmed work, not the stale handoffSha (P1-3).
    // Order matters (Codex P1-01): PERSIST the parent's carried recovery point FIRST (apply persists), THEN delete the
    // child's only durable copy. If apply throws, the child JSON still exists → next pass retries, nothing lost. If the
    // delete throws after, the parent already holds the recovery sha. The reverse order (old code) lost C on a parent
    // write failure. An empty placeholder (sha === handoffSha / unset) has no newer point — nothing to carry.
    const recoverySha = succ?.sha !== undefined && succ.sha !== r.handoffSha ? succ.sha : undefined;
    const advanced = apply(r, { type: "reconcile_dead", recoverySha }, ops, records); // persists parent (sha=recoverySha)
    ops.removeRecord(r.successor); // only now terminate the dead successor's record + occupancy (may throw, P2-4)
    records.delete(r.successor);
    return advanced;
  }
  ops.log(`${r.launchId}: reconcile ${r.successor} inconclusive (not published, not expired) — retaining attempt`);
  return r;
}

async function awaitResume(r: ControlRecord, records: Map<string, ControlRecord>, ops: HandoffOps): Promise<ControlRecord> {
  if (!r.successor || r.handoffSha === undefined || r.attempt === undefined) return r;
  const sgen = r.successorGen ?? r.generation;
  // Observe against the child's CURRENT anchor (or handoffSha if none): a qualified tip is then a verified descendant of
  // whatever the child has already confirmed, so the recovery point only moves FORWARD — "not the seed" is NOT proof of
  // newer (Codex P2-5b). This base is itself >= handoffSha, so the resume-ACK bar (descendant of handoffSha) still holds.
  const child0 = records.get(r.successor);
  const acceptedBase = child0?.sha ?? r.handoffSha;
  const tip = await ops.observeTip(branchFor(r.successor, sgen), acceptedBase, r.successor);
  if (!tip || !tip.manifest) return r;                   // not published / transient -> keep waiting
  if (tip.manifest.launchId !== r.successor) return r;   // the seed (predecessor's manifest) -> not resumed yet
  if (tip.manifest.generation !== sgen) { ops.log(`${r.launchId}: successor tip gen ${tip.manifest.generation} != pinned ${sgen}; ignoring`); return r; }
  if (tip.manifest.kind !== "milestone" && tip.manifest.kind !== "final") {
    // A supervisor auto-rescue is NOT proof the worker took over — require a worker-driven milestone/final (Codex).
    ops.log(`${r.launchId}: successor tip kind=${tip.manifest.kind} (not worker-driven) — not a resumed-ACK yet`);
    return r;
  }
  if (!tip.isDescendantOfAccepted) { ops.log(`${r.launchId}: successor tip not a descendant of the child's anchor; ignoring`); return r; }
  // Persist the VERIFIED recovery point onto the SUCCESSOR record as a RETRYABLE BARRIER, BEFORE the predecessor goes
  // RESUMED (then RETIRED): persist FIRST, then update the Map, so a persist throw leaves disk==RAM (anchor not moved)
  // and the barrier simply retries next pass instead of stranding disk at the old sha while the parent retires (P2-5a).
  // A child record lost to a crash is REBUILT + persisted here, so recovery always has a durable child anchor (P2-5c).
  if (!child0) {
    const base = r.attemptStartSec ?? ops.nowSec();
    const rebuilt: ControlRecord = {
      launchId: r.successor, state: "RUNNING", generation: sgen, handoffSha: r.handoffSha, sha: tip.sha,
      allocStart: base, budgetSec: ops.budgetSec, physicalLifetimeSec: r.attemptPhysicalSec ?? ops.physicalLifetimeSec,
      deadlineEpoch: base + ops.budgetSec, updatedAt: ops.nowSec(),
    };
    ops.persist(rebuilt);        // barrier: a throw is caught by pass(), retried next pass; parent NOT yet RESUMED
    records.set(r.successor, rebuilt);
  } else if (child0.sha !== tip.sha || child0.generation !== sgen) {
    // advance the recovery point AND correct the generation to the pinned sgen: the generic discovery (swarm-dispatch
    // pass) may have recreated a crash-lost child as generation 0 (it doesn't know the parent's pinned successorGen),
    // which would make the child observe swarm/<child>-g0 forever while the worker publishes at sgen — losing every
    // later checkpoint (Codex P1-03). acceptedBase already proved tip is a forward descendant of child0.sha.
    const anchored = { ...child0, generation: sgen, sha: tip.sha, updatedAt: ops.nowSec() };
    ops.persist(anchored);       // persist FIRST (retryable barrier), then the Map
    records.set(r.successor, anchored);
  }
  // A REAL successor milestone at the pinned publish-generation, descending from the child's anchor -> resumed-ACK.
  return apply(r, { type: "resumed", successor: r.successor, sha: r.handoffSha, generation: r.generation, attempt: r.attempt }, ops, records);
}
