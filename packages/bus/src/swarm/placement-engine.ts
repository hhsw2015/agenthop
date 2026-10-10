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
 *
 * phase-2b (below the reconcile): multi-backend + cost-aware spawn selection — a PURE `selectBackends` that turns
 * reconcile's backend-agnostic `{spawn,n}` into a cheapest-first per-backend plan bounded by each backend's free capacity
 * AND a budget. The engine DECIDES; the live caller still owns the real spend (an over-budget shortfall is routed to the
 * user money gate, R16 — never auto-spent). reconcile and the one-way vm-ctl seam are untouched.
 */

import { readFileSync } from "node:fs"; // wiring IO: read the declarative placement spec (dormant: SWARM_PLACEMENT off)
import path from "node:path";
import type { Backend } from "./vm-ctl.js"; // phase-2b: reuse vm-ctl's Backend abstraction (type-only; no new backend interface, no runtime coupling)

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
  for (const m of dedupeById(machines)) { // PE3: a repeated id must not double-count then overwrite its assignment
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
  // Counts of machines are integers; a demand that is illegal or overflows a safe integer yields NaN (a clear "not a
  // valid count"), NEVER a fabricated 0 or an Infinity — the consumer (reconcile) turns NaN into an explicit hold. (PE4)
  const cap = Number.isFinite(perMachineCapacity) && perMachineCapacity > 0 ? perMachineCapacity : NaN;
  const board = Number.isFinite(d.boardUnits) && d.boardUnits >= 0 ? d.boardUnits : NaN;
  const fanout = Number.isInteger(d.fanoutMachines) && d.fanoutMachines >= 0 ? d.fanoutMachines : NaN; // machine count is whole (no silent 1.5→1 floor)
  if (Number.isNaN(cap) || Number.isNaN(board) || Number.isNaN(fanout)) return NaN;
  const want = Math.max(Math.ceil(board / cap), fanout);
  return Number.isSafeInteger(want) ? want : NaN; // e.g. board 1e308 / cap 1e-308 overflows the ratio -> NaN, not Infinity
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
  | { kind: "spawn"; n: number; urgent?: boolean } // urgent = restore necessary capacity below floor (bypasses dwell)
  | { kind: "hold"; reason: string };

const finiteNonNeg = (n: number): boolean => Number.isFinite(n) && n >= 0;

/** Dedupe machines by id (first occurrence wins) — duplicate records must not double-count capacity, overwrite
 *  assignments, or fabricate surplus (PE3). Pure. */
export function dedupeById<T extends { id: string }>(xs: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

/**
 * Level-triggered reconcile: actual (machines) → desired. HEAL is ungated/urgent (a dead VM is reclaimed so a spawn
 * replaces it; an expiring live VM is snapshot+rebuilt before it self-destructs). SCALE is dwell-gated + hysteretic
 * (spawn the shortfall; reclaim a surplus machine only when it is ready+idle-long+in-flight=0+non-floor). Idempotent:
 * the same (desired, actual) yields the same actions, safe to replay. Pure. */
export function reconcile(d: Demand, machines: readonly MachineView[], cfg: ReconcileConfig, sinceLastActionSec: number): Action[] {
  // PE4: validate every input; an illegal/abnormal value yields an EXPLICIT hold, never a fabricated 0/Infinity action.
  if (!(Number.isFinite(cfg.perMachineCapacity) && cfg.perMachineCapacity > 0)) return [{ kind: "hold", reason: "invalid perMachineCapacity" }];
  if (!(Number.isInteger(cfg.floor) && cfg.floor >= 0)) return [{ kind: "hold", reason: "invalid floor" }];
  for (const [k, v] of [["reclaimIdleSec", cfg.reclaimIdleSec], ["expiringSec", cfg.expiringSec], ["minDwellSec", cfg.minDwellSec]] as const) {
    if (!finiteNonNeg(v)) return [{ kind: "hold", reason: `invalid ${k}` }];
  }
  if (!finiteNonNeg(d.boardUnits)) return [{ kind: "hold", reason: "invalid demand" }];
  if (!(Number.isInteger(d.fanoutMachines) && d.fanoutMachines >= 0)) return [{ kind: "hold", reason: "invalid demand" }]; // PE4: a machine count must be a whole number (1.5 is not floored into a fabricated demand)
  if (!finiteNonNeg(sinceLastActionSec)) return [{ kind: "hold", reason: "invalid clock" }];

  const uniq = dedupeById(machines); // PE3: duplicates must not double-count or fabricate surplus
  const want = Math.max(desiredCount(d, cfg.perMachineCapacity), cfg.floor);
  if (!Number.isSafeInteger(want)) return [{ kind: "hold", reason: "demand overflow" }]; // PE4: finite inputs (board/cap) can still overflow a safe integer
  const live = uniq.filter((m) => m.live);
  const dwellOk = sinceLastActionSec >= cfg.minDwellSec;
  const actions: Action[] = [];
  const handled = new Set<string>(); // PE1: each machine gets exactly ONE action (heal and scale never collide)

  // dead → reclaim (always; not capacity). The shortfall spawn below replaces necessary ones.
  for (const m of uniq) if (!m.live) { actions.push({ kind: "reclaim", id: m.id, reason: "non-live" }); handled.add(m.id); }

  // surplus: reclaim one live machine beyond `want` (idle+empty+ready+non-floor), dwell-gated + hysteretic. A machine
  // reclaimed here is marked handled, so the expiring-rebuild below never also fires on it (PE1).
  if (dwellOk && live.length > want) {
    const cand = live.filter((m) => !handled.has(m.id) && m.ready && m.inFlight === 0 && m.idleSec >= cfg.reclaimIdleSec && !m.floor);
    if (cand.length > 0) {
      const pick = cand.reduce((a, b) => (b.idleSec > a.idleSec ? b : a));
      actions.push({ kind: "reclaim", id: pick.id, reason: "surplus" });
      handled.add(pick.id);
    }
  }

  // expiring KEPT live → snapshot+rebuild (a surplus-reclaimed one is already handled, so it is not rebuilt).
  for (const m of live) if (!handled.has(m.id) && m.remainingSec != null && m.remainingSec <= cfg.expiringSec) { actions.push({ kind: "rebuild", id: m.id, reason: "expiring" }); handled.add(m.id); }

  // spawn shortfall. Growth (dwell-gated) spawns the full shortfall; inside the dwell window only NECESSARY capacity is
  // restored URGENTLY — the floor PLUS capacity lost to death (machines that existed and died), capped at `want`. NEW
  // demand above the already-committed fleet stays dwell-gated. established = total records this tick (live + dead) =
  // the fleet that was committed before deaths; want-beyond-established is growth, want-within is dead-replacement. (PE2)
  if (live.length < want) {
    if (dwellOk) {
      actions.push({ kind: "spawn", n: want - live.length });
    } else {
      const established = uniq.length; // live + dead records = capacity that was already committed before this tick
      const urgentTarget = Math.max(cfg.floor, Math.min(want, established));
      const urgentN = urgentTarget - live.length;
      if (urgentN > 0) actions.push({ kind: "spawn", n: urgentN, urgent: true });
    }
  }

  if (actions.length === 0) actions.push({ kind: "hold", reason: dwellOk ? "at desired" : "min-dwell" });
  return actions;
}

// ============================================================================================================
// phase-2b — cost-aware, multi-backend spawn selection (pure; composes with reconcile, does NOT change it)
// ============================================================================================================

/** A candidate backend for a spawn. `backend` is vm-ctl's Backend id (reused, not re-invented). `costPerMachineMicroUsd` is the
 *  cost to run ONE machine over the placement horizon as an INTEGER micro-USD (1e-6 USD; 0 = a free tier) — money is carried as
 *  an integer, never a float (PE2B-1 / the "钱不走 float" ruling family): all budget arithmetic below is then exact. `freeSlots`
 *  is how many more machines this backend can accept now (its quota/capacity). `priority` is a deterministic tiebreak when cost
 *  is equal (lower = preferred). */
export interface BackendOption {
  backend: Backend;
  costPerMachineMicroUsd: number;
  freeSlots: number;
  priority?: number;
}

export interface BackendAllocation { backend: Backend; count: number; costMicroUsd: number; } // integer micro-USD

/** The selection outcome. The three shortfall faces are a clean partition of `want`: funded + unfundedByBudget +
 *  unplaceableByCapacity === want.
 *  - `funded`: machines placeable within BOTH budget and capacity (the allocation sums to this).
 *  - `unfundedByBudget`: wanted, capacity exists, but unaffordable within the budget ⇒ the live caller routes these to the
 *    user money gate (R16); the engine NEVER auto-spends past budget.
 *  - `unplaceableByCapacity`: wanted but no backend has capacity at ANY price (a hard shortfall). */
export interface BackendSelection {
  allocation: BackendAllocation[];
  funded: number;
  unfundedByBudget: number;
  unplaceableByCapacity: number;
  totalCostMicroUsd: number; // integer; == the allocation-cost sum; always <= budgetMicroUsd (exact integer arithmetic)
}

const validOption = (o: BackendOption): boolean =>
  typeof o?.backend === "string" && o.backend.length > 0 &&
  Number.isSafeInteger(o.costPerMachineMicroUsd) && o.costPerMachineMicroUsd >= 0 && // integer micro-USD (PE2B-1: money is never a float)
  Number.isInteger(o.freeSlots) && o.freeSlots >= 0 &&
  (o.priority === undefined || Number.isFinite(o.priority)); // PE2B-3: an invalid (NaN/Inf/non-number) priority drops the whole option — it must NEVER reach the comparator (NaN ?? 0 is still NaN, which sort treats as equal and silently skips the name tiebreak)

/**
 * Cost-aware, multi-backend selection: place `want` new machines cheapest-first across `options`, bounded by each backend's
 * `freeSlots` and the `budgetMicroUsd` ceiling. All money is INTEGER micro-USD, so the budget contract
 * (`totalCostMicroUsd <= budgetMicroUsd`) holds EXACTLY — no float rounding, no epsilon (PE2B-1). Deterministic order: cost
 * asc, then priority asc, then backend name asc — NO timestamp / "latest wins" (FC-6). An affordable count is the exact
 * integer-division floor(budgetLeft / cost); a repeated backend id is deduped (first wins — a duplicate must not double its
 * capacity). `want` MUST be a positive safe integer — a fractional/illegal demand is rejected whole (no floor; matches
 * reconcile's PE4 contract), yielding an empty plan (fail-closed: never fabricate a spawn). Pure. */
export function selectBackends(want: number, options: readonly BackendOption[], budgetMicroUsd: number): BackendSelection {
  const empty: BackendSelection = { allocation: [], funded: 0, unfundedByBudget: 0, unplaceableByCapacity: 0, totalCostMicroUsd: 0 };
  // PE2B-2: want MUST already be a positive safe integer — never floor a fractional/illegal demand into an executable count.
  if (!Number.isSafeInteger(want) || want <= 0) return empty;
  const wantN = want;
  const budget = Number.isSafeInteger(budgetMicroUsd) && budgetMicroUsd >= 0 ? budgetMicroUsd : 0; // integer micro-USD; invalid ⇒ 0 (nothing affordable)

  const seen = new Set<Backend>();
  const opts: BackendOption[] = [];
  for (const o of options) { if (!validOption(o) || seen.has(o.backend)) continue; seen.add(o.backend); opts.push(o); } // dedupe + drop invalid
  const totalCapacity = opts.reduce((s, o) => s + o.freeSlots, 0);
  const sorted = [...opts].sort((a, b) =>
    a.costPerMachineMicroUsd !== b.costPerMachineMicroUsd ? a.costPerMachineMicroUsd - b.costPerMachineMicroUsd
      : (a.priority ?? 0) !== (b.priority ?? 0) ? (a.priority ?? 0) - (b.priority ?? 0)
        : a.backend < b.backend ? -1 : a.backend > b.backend ? 1 : 0);

  const allocation: BackendAllocation[] = [];
  let remaining = wantN, budgetLeft = budget, totalMicro = 0;
  for (const o of sorted) {
    if (remaining <= 0) break;
    if (o.freeSlots <= 0) continue;
    // integer arithmetic throughout: affordable = exact integer division; take*cost <= budgetLeft <= budget (a safe integer),
    // so no product/accumulation ever overflows a safe integer or rounds — totalMicro <= budget holds exactly (PE2B-1).
    const affordable = o.costPerMachineMicroUsd <= 0 ? remaining : Math.floor(budgetLeft / o.costPerMachineMicroUsd);
    const take = Math.min(remaining, o.freeSlots, affordable);
    if (take <= 0) continue;
    const costMicroUsd = take * o.costPerMachineMicroUsd;
    allocation.push({ backend: o.backend, count: take, costMicroUsd });
    remaining -= take; budgetLeft -= costMicroUsd; totalMicro += costMicroUsd;
  }

  const funded = wantN - remaining;
  const unplaceableByCapacity = Math.max(0, wantN - totalCapacity); // no capacity at any price
  const unfundedByBudget = remaining - unplaceableByCapacity;       // the rest of the shortfall is budget-limited (>= 0 by construction)
  return { allocation, funded, unfundedByBudget, unplaceableByCapacity, totalCostMicroUsd: totalMicro };
}

// ============================================================================================================
// placement wiring (SUGGESTION MODE) — reconcile → selectBackends → a coordinator advisory. PURE: the engine ADVISES,
// it NEVER spawns/reclaims (the autoscale-suggest ruling; real VM ops + spend are the user money gate, R16).
// ============================================================================================================

/** The declarative desired-state spec the coordinator/user authors (read-only INPUT, never written by the engine): the
 *  demand to satisfy, the reconcile config, the candidate backends (integer micro-USD cost + capacity), and the budget. */
export interface PlacementSpec {
  demand: Demand;
  cfg: ReconcileConfig;
  backends: BackendOption[];
  budgetMicroUsd: number;
}

export type PlacementSpecLoad = { ok: true; spec: PlacementSpec } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate an untrusted spec record and REBUILD it from the validated reads (never trust input methods/extra keys). Money is
 *  integer micro-USD throughout (PE2B-1). Fail-closed: any illegal field rejects the WHOLE spec (a bad desired-state must never
 *  drive an advisory). Pure. */
export function loadPlacementSpec(raw: unknown): PlacementSpecLoad {
  if (!isObj(raw)) return { ok: false, reason: "spec is not an object" };
  const d = raw.demand, c = raw.cfg, b = raw.backends;
  if (!isObj(d)) return { ok: false, reason: "demand missing" };
  if (!(Number.isFinite(d.boardUnits) && (d.boardUnits as number) >= 0)) return { ok: false, reason: "demand.boardUnits must be a finite >= 0 number" };
  if (!(Number.isInteger(d.fanoutMachines) && (d.fanoutMachines as number) >= 0)) return { ok: false, reason: "demand.fanoutMachines must be a whole >= 0 number" };
  if (!isObj(c)) return { ok: false, reason: "cfg missing" };
  if (!(Number.isFinite(c.perMachineCapacity) && (c.perMachineCapacity as number) > 0)) return { ok: false, reason: "cfg.perMachineCapacity must be > 0" };
  if (!(Number.isInteger(c.floor) && (c.floor as number) >= 0)) return { ok: false, reason: "cfg.floor must be a whole >= 0 number" };
  for (const k of ["reclaimIdleSec", "expiringSec", "minDwellSec"] as const) {
    if (!(Number.isFinite(c[k]) && (c[k] as number) >= 0)) return { ok: false, reason: `cfg.${k} must be a finite >= 0 number` };
  }
  if (!Array.isArray(b)) return { ok: false, reason: "backends must be an array" };
  const backends: BackendOption[] = [];
  for (let i = 0; i < b.length; i++) { // index walk — never iterate/spread untrusted input
    const o = b[i];
    if (!isObj(o)) return { ok: false, reason: `backends[${i}] is not an object` };
    if (!(typeof o.backend === "string" && o.backend.length > 0)) return { ok: false, reason: `backends[${i}].backend must be a non-empty string` };
    if (!(Number.isSafeInteger(o.costPerMachineMicroUsd) && (o.costPerMachineMicroUsd as number) >= 0)) return { ok: false, reason: `backends[${i}].costPerMachineMicroUsd must be a non-negative safe integer (micro-USD)` };
    if (!(Number.isInteger(o.freeSlots) && (o.freeSlots as number) >= 0)) return { ok: false, reason: `backends[${i}].freeSlots must be a whole >= 0 number` };
    if (!(o.priority === undefined || Number.isFinite(o.priority))) return { ok: false, reason: `backends[${i}].priority must be a finite number when present` };
    backends.push({ backend: o.backend, costPerMachineMicroUsd: o.costPerMachineMicroUsd as number, freeSlots: o.freeSlots as number, ...(o.priority === undefined ? {} : { priority: o.priority as number }) });
  }
  if (!(Number.isSafeInteger(raw.budgetMicroUsd) && (raw.budgetMicroUsd as number) >= 0)) return { ok: false, reason: "budgetMicroUsd must be a non-negative safe integer (micro-USD)" };
  const spec: PlacementSpec = {
    demand: { boardUnits: d.boardUnits as number, fanoutMachines: d.fanoutMachines as number },
    cfg: { perMachineCapacity: c.perMachineCapacity as number, floor: c.floor as number, reclaimIdleSec: c.reclaimIdleSec as number, expiringSec: c.expiringSec as number, minDwellSec: c.minDwellSec as number },
    backends,
    budgetMicroUsd: raw.budgetMicroUsd as number,
  };
  return { ok: true, spec };
}

/** The advisory the wiring delivers. `hasContent` false ⇒ a pure hold (nothing worth advising) ⇒ the caller sends nothing. */
export interface PlacementSuggestion {
  hasContent: boolean;
  text: string;
  spawnFunded: number;
  needUserGate: number; // unfundedByBudget — capacity exists but over budget ⇒ the R16 user money gate
  capacityGap: number;  // unplaceableByCapacity — no backend capacity at any price
  reclaims: number;
  rebuilds: number;
}

/** Fold reconcile's actions + the spawn's backend selection into a coordinator advisory. The spawn's three faces are reported
 *  distinctly: the FUNDED per-backend plan, the UNFUNDED-by-budget count (needs the R16 user money gate), and the capacity gap.
 *  reclaim/rebuild actions are advised, never executed. Pure. */
export function buildPlacementSuggestion(actions: readonly Action[], selection: BackendSelection | null): PlacementSuggestion {
  const spawn = actions.find((a): a is Extract<Action, { kind: "spawn" }> => a.kind === "spawn");
  const reclaims = actions.filter((a): a is Extract<Action, { kind: "reclaim" }> => a.kind === "reclaim");
  const rebuilds = actions.filter((a): a is Extract<Action, { kind: "rebuild" }> => a.kind === "rebuild");
  const sel = spawn ? selection : null;
  const spawnFunded = sel?.funded ?? 0;
  const needUserGate = sel?.unfundedByBudget ?? 0;
  const capacityGap = sel?.unplaceableByCapacity ?? 0;
  const lines: string[] = ["[placement suggestion] SUGGESTION MODE — the engine ADVISES; it never spawns/reclaims (R16: real VM ops + spend are the user's gate)."];
  if (sel) {
    if (sel.allocation.length) {
      lines.push(`spawn plan — funded ${spawnFunded} within budget ${sel.totalCostMicroUsd}µUSD:`);
      for (const a of sel.allocation) lines.push(`  - ${a.backend}: ${a.count} machine(s) @ ${a.costMicroUsd}µUSD`);
    }
    if (needUserGate > 0) lines.push(`USER MONEY GATE (R16): ${needUserGate} machine(s) have capacity but exceed the budget — approve spend to place them.`);
    if (capacityGap > 0) lines.push(`capacity shortfall: ${capacityGap} machine(s) cannot be placed on any backend at any price — add backend capacity.`);
  }
  for (const r of reclaims) lines.push(`advise reclaim ${r.id} (${r.reason})`);
  for (const r of rebuilds) lines.push(`advise rebuild ${r.id} (expiring)`);
  const hasContent = (!!sel && (spawnFunded > 0 || needUserGate > 0 || capacityGap > 0)) || reclaims.length > 0 || rebuilds.length > 0;
  return { hasContent, text: lines.join("\n"), spawnFunded, needUserGate, capacityGap, reclaims: reclaims.length, rebuilds: rebuilds.length };
}

/** The whole suggestion chain, PURE + end-to-end testable: reconcile (desired vs actual machines) → selectBackends on the
 *  spawn shortfall (cheapest-first within budget) → fold into an advisory. No IO, no spend, no VM ops.
 *
 *  PW-1: suggestion mode shows the COMPLETE desired plan, so reconcile is run with its action-dwell SATISFIED (`minDwellSec`
 *  passed as the since-last) — never the urgent-floor SUBSET that reconcile returns inside an unexpired action dwell. Mixing
 *  reconcile's action dwell with the wiring's notice timing (the first cut) let that floor subset re-fire and perpetually
 *  postpone the full-demand advisory. Here the engine always advises the full plan; HOW OFTEN it is delivered is the wiring's
 *  job (shouldSuggestPlacement), a responsibility kept entirely separate from reconcile's (signed, untouched) heal semantics. */
export function planPlacementSuggest(spec: PlacementSpec, machines: readonly MachineView[]): PlacementSuggestion {
  const actions = reconcile(spec.demand, machines, spec.cfg, spec.cfg.minDwellSec); // minDwellSec >= minDwellSec ⇒ dwellOk ⇒ full plan (not the urgent subset)
  const spawn = actions.find((a): a is Extract<Action, { kind: "spawn" }> => a.kind === "spawn");
  const selection = spawn ? selectBackends(spawn.n, spec.backends, spec.budgetMicroUsd) : null;
  return buildPlacementSuggestion(actions, selection);
}

/** PW-1: the NOTICE dwell — the wiring's OWN delivery throttle, independent of reconcile's action dwell. True ⇒ a suggestion
 *  may be delivered this tick. Non-finite clock ⇒ false (never fire without a clock); non-positive/invalid dwell ⇒ true (no
 *  throttle — every tick). Only a real "delivered" should advance `lastSuggestSec` (the caller's job), so a failed/unreported
 *  advisory retries next tick. Pure (mirrors shouldSampleGauge). */
export function shouldSuggestPlacement(nowSec: number, lastSuggestSec: number, minDwellSec: number): boolean {
  if (!Number.isFinite(nowSec)) return false;
  if (!(Number.isFinite(minDwellSec) && minDwellSec > 0)) return true;
  return nowSec - lastSuggestSec >= minDwellSec;
}

// ============================================================================================================
// IO shell — the reconcile loop (dormant: SWARM_PLACEMENT off; lives in the caller, exercised by live runs)
// ============================================================================================================

/** placement wiring flip, default OFF (dormant-ahead-of-use, like SWARM_VM_CTL / SWARM_SEAT_CAPS). */
export function placementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_PLACEMENT ?? "");
}

/** Read the declarative placement spec from `<home>/.agenthop/placement/spec.json`, validated through loadPlacementSpec.
 *  Fail-soft: absent / unreadable / malformed / invalid ⇒ null (the sweep simply advises nothing this tick). */
export function readPlacementSpec(home: string): PlacementSpec | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(home, ".agenthop", "placement", "spec.json"), "utf8"));
    const res = loadPlacementSpec(raw);
    return res.ok ? res.spec : null;
  } catch { return null; }
}

/** Observed actual machines (reconcile's ACTUAL state). SEAM: the vm-ctl ledger read lands HERE when vm-ctl is wired; until
 *  then there is no live machine ledger, so this is empty (⇒ the advisory recommends the full demand plan). Fail-soft. */
export function readLedgerMachines(_home: string): MachineView[] {
  return []; // no vm-ctl ledger merged yet — the one place a future ledger read plugs in (SWARM_PLACEMENT stays OFF until then)
}
