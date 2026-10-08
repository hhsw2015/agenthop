/**
 * placement-engine — the UPPER layer of vm-ctl's two-layer architecture (S14 phase-2a, pure core).
 *
 * User/coordinator only says "want a member to do work"; this engine converges "allocate VM / build env / hand off on
 * expiry" into reality. Modeled on the K8s controller pattern: a declarative DESIRED state, an observed ACTUAL state
 * (the vm-ctl ledger), and a LEVEL-TRIGGERED reconcile that converges actual → desired idempotently (crash-replay safe).
 *
 * Seam (one-way): this engine CALLS the vm-ctl command family (up/adopt/boot/creds/ready/snapshot/down); vm-ctl does
 * NOT know the engine exists — the command family is a stateless wrench, the engine is the sole holder of desired state.
 *
 * Pure decisions below (selftested): health classification, bin-packing, desired-count diff, the fork health-gate
 * (Betabrand invariant), and the reconcile decision. IO (the loop that reads presence + calls vm-ctl) is dormant
 * (`SWARM_PLACEMENT` off) and lives in the caller. North star: zero external activation.
 */

// ============================================================================================================
// Pure core (selftested in placement-engine.selftest.mts)
// ============================================================================================================

/** liveness ≠ readiness (CORE two evidence faces): a VM can be alive but not yet able to take work. */
export type HealthClass = "non-live" | "live-not-ready" | "ready";
export function classifyHealth(m: { live: boolean; ready: boolean }): HealthClass {
  if (!m.live) return "non-live";
  return m.ready ? "ready" : "live-not-ready";
}

/** Disposition per class: a dead VM is rebuilt, a booting one is given time (NOT killed), a ready one is fed. Pure. */
export type Disposition = "rebuild" | "wait" | "feed";
export function disposition(c: HealthClass): Disposition {
  return c === "non-live" ? "rebuild" : c === "live-not-ready" ? "wait" : "feed";
}

export interface MachineCap {
  id: string;
  freeCapacity: number;
}
export interface PackResult {
  assignments: Record<string, number>;
  placed: number;
  unplaceable: number;
}

/** Bin-pack `units` of work onto machines up to each one's free capacity (never oversubscribe). `unplaceable` is the
 *  shortfall that drives a spawn. Null-prototype map so a machine id can't collide with Object.prototype. Pure. */
export function binPack(units: number, machines: readonly MachineCap[]): PackResult {
  const assignments: Record<string, number> = Object.create(null);
  let placed = 0;
  let remaining = Number.isFinite(units) ? Math.max(0, Math.floor(units)) : 0;
  for (const m of machines) {
    if (remaining <= 0) break;
    const free = Number.isFinite(m.freeCapacity) ? Math.max(0, Math.floor(m.freeCapacity)) : 0;
    const take = Math.min(remaining, free);
    if (take > 0) {
      assignments[m.id] = take;
      placed += take;
      remaining -= take;
    }
  }
  return { assignments, placed, unplaceable: remaining };
}

/** The two demand consumers: durable board-admission work (fill to capacity) + fanout's explicit machine count. */
export interface Demand {
  boardUnits: number;
  fanoutMachines: number;
}

/** Desired machine count = max(ceil(board work / per-machine capacity), fanout machines). Pure. */
export function desiredCount(d: Demand, perMachineCapacity: number): number {
  const byBoard = perMachineCapacity > 0 ? Math.ceil(Math.max(0, d.boardUnits) / perMachineCapacity) : 0;
  const byFanout = Number.isFinite(d.fanoutMachines) ? Math.max(0, Math.floor(d.fanoutMachines)) : 0;
  return Math.max(byBoard, byFanout);
}

/**
 * Betabrand invariant (three-states-same-image): a `fork`/`template` reuse may proceed ONLY from a template VERIFIED
 * healthy — a poisoned golden image would spawn N poisoned machines. Fail-closed: an unverified/absent template never
 * forks. Pure. */
export function forkHealthGate(template: { verified: boolean } | null | undefined): boolean {
  return !!template && template.verified === true;
}

export interface MachineView {
  id: string;
  live: boolean;
  ready: boolean;
  idleSec: number;
  remainingSec: number | null; // null = does not self-destruct
  inFlight: number;
  floor?: boolean; // a baseline standing machine — never reclaimed
}

export interface ReconcileConfig {
  perMachineCapacity: number;
  floor: number;
  reclaimIdleSec: number; // a surplus machine must be idle this long before reclaim (hysteresis)
  expiringSec: number; // remainingSec at/below this ⇒ snapshot + rebuild before self-destruct
  minDwellSec: number; // min time between SCALE actions (debounce)
}

export type Action =
  | { kind: "reclaim"; id: string; reason: "non-live" | "surplus" }
  | { kind: "rebuild"; id: string; reason: "expiring" }
  | { kind: "spawn"; n: number }
  | { kind: "hold"; reason: string };

/**
 * Level-triggered reconcile: actual (machines) → desired. HEAL is ungated/urgent (a dead VM is reclaimed so a spawn
 * replaces it; an expiring live VM is snapshot+rebuilt before it self-destructs). SCALE is dwell-gated + hysteretic
 * (spawn the shortfall; reclaim a surplus machine only when it is ready+idle-long+in-flight=0+non-floor). Idempotent:
 * the same (desired, actual) yields the same actions, safe to replay. Pure. */
export function reconcile(d: Demand, machines: readonly MachineView[], cfg: ReconcileConfig, sinceLastActionSec: number): Action[] {
  const want = Math.max(desiredCount(d, cfg.perMachineCapacity), cfg.floor);
  const healthy = machines.filter((m) => m.live);
  const actions: Action[] = [];

  // HEAL (ungated): dead → reclaim (shortfall spawn replaces); expiring live → snapshot+rebuild (preserve state).
  for (const m of machines) if (!m.live) actions.push({ kind: "reclaim", id: m.id, reason: "non-live" });
  for (const m of healthy) if (m.remainingSec != null && m.remainingSec <= cfg.expiringSec) actions.push({ kind: "rebuild", id: m.id, reason: "expiring" });

  // SCALE (dwell-gated + hysteresis) on the healthy set.
  const dwellOk = sinceLastActionSec >= cfg.minDwellSec;
  if (dwellOk && healthy.length < want) {
    actions.push({ kind: "spawn", n: want - healthy.length });
  } else if (dwellOk && healthy.length > want) {
    const cand = healthy.filter((m) => m.ready && m.inFlight === 0 && m.idleSec >= cfg.reclaimIdleSec && !m.floor);
    if (cand.length > 0) actions.push({ kind: "reclaim", id: cand.reduce((a, b) => (b.idleSec > a.idleSec ? b : a)).id, reason: "surplus" });
  }

  if (actions.length === 0) actions.push({ kind: "hold", reason: dwellOk ? "at desired" : "min-dwell" });
  return actions;
}

// ============================================================================================================
// IO shell — the reconcile loop (dormant: SWARM_PLACEMENT off; lives in the caller, exercised by live runs)
// ============================================================================================================

/** placement wiring flip, default OFF (dormant-ahead-of-use, like SWARM_VM_CTL / SWARM_BOARD_ADMIT). */
export function placementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_PLACEMENT ?? "");
}
