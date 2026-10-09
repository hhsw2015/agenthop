/**
 * Shared-budget pool pure core (DA2, docker-agent borrow #2 — grounds in docs/research/docker-agent-eval.md axis-cost + Q⑤,
 * design docs/swarm/shared-budget-design.md). A NAMED pool = one ceiling, many consumers: N concurrent consumers that reference
 * the same pool name draw from the SAME ceiling, so a fan-out to N sub-tasks cannot spend N times the limit (docker-agent's
 * `budgets` shared-pot semantics). It is the shared layer above fan-out's PER-RUN ticket caps, not a replacement for them.
 *
 * Two levels compose: fan-out's per-run breaker is HARD (aborts in-flight on its own cap — already signed, untouched); this
 * shared-pool ceiling is SOFT — pool-full REFUSES new dispatch, never kills in-flight.
 *
 * Coordinator rulings folded (2026-10-09, DA2 APPROVED) + DA2-R1 review fixes:
 *  (1) CAS = single-file optimistic CAS under a holder-identity lock (the store's job).
 *  (3) Exhaustion = maxUsd OR maxTokens, whichever hits first (fail-closed).
 *  (5) Raising the ceiling is a money-gate action (coordinator only) — enforced by the caller, not here.
 *  (A, SB3) Overshoot is BOUNDED, and the bound is PROVABLE AT ADMIT: admission counts committed spend PLUS reserved-in-flight
 *      (admitted-but-not-yet-accounted). We refuse once `spent + inflight >= ceiling`, so the only overshoot is the single
 *      reservation that tipped the pool over — bound = ceiling + one max ticket, independent of consumer count. Admission is thus
 *      a RESERVE (a write under the lock), not a lock-free read of `spent`.
 *
 * Flow: `reserve` before dispatching a unit (records an in-flight reservation = its ticket estimate); `commit` after it completes
 * (replaces the reservation with the ACTUAL spend). A dead consumer's reservation is reclaimed by `pruneStaleReservations`
 * (pid-liveness + TTL) so a crashed unit never strands the pool as falsely full.
 *
 * Pure: no fs, no clock beyond injected timestamps. The IO half (lock, CAS read-modify-write, projection) is shared-budget-store.ts.
 */

/** A pool ceiling. At least one dimension must be set; a null dimension is unbounded on that axis. */
export type PoolCeiling = { maxUsd: number | null; maxTokens: number | null };

/** An admitted-but-not-yet-accounted unit. `estUsd/estTokens` = the unit's ticket estimate (its per-run cap), held against the
 *  pool until the unit commits its actual spend or is reclaimed. Idempotent by `reserveKey`. */
export type Reservation = {
  reserveKey: string;
  consumer: string;
  estUsd: number;
  estTokens: number;
  pid: number;   // owning process, for liveness-based reclaim of a crashed unit
  atSec: number; // when reserved, for TTL-based reclaim backstop
};

/** One accounted spend. Idempotent by `drawKey` (content-addressed, like fan-out's runKey). */
export type PoolDraw = {
  drawKey: string;
  consumer: string;
  usd: number;
  tokens: number;
  atSec: number;
  reserveKey?: string; // the reservation this draw settles (removed on commit); absent = a direct draw
};

/** The durable pool state (read/written under the store's CAS lock). */
export type PoolState = {
  poolName: string;
  ceiling: PoolCeiling;
  draws: PoolDraw[];
  reservations: Reservation[];
};

export type PoolSpent = { usd: number; tokens: number };
export type PoolAdmission =
  | { ok: true; remaining: { usd: number | null; tokens: number | null } }
  | { ok: false; exhausted: true; remaining: { usd: number | null; tokens: number | null } };

/** Frozen read projection (budget-pool/v1). */
export type BudgetPoolProjection = {
  schema: 'budget-pool/v1';
  poolName: string;
  generatedAtSec: number;
  ceiling: PoolCeiling;
  spent: PoolSpent;                 // committed (accounted) spend
  inflight: PoolSpent;              // reserved-but-not-yet-committed (estimates)
  remaining: { usd: number | null; tokens: number | null }; // ceiling - spent - inflight (>= 0)
  state: 'open' | 'exhausted';
  drawCount: number;
  reservationCount: number;
  consumers: { id: string; usd: number; tokens: number }[];
};

/** A pool name is a safe locator: rejected, never sanitized. Case is significant; the store additionally binds the on-disk body
 *  name to the requested name so a case-insensitive filesystem alias (Shared vs shared) can never cross budgets. */
export const isValidPoolName = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name);

/** Validate + normalize a ceiling. Throws LOUDLY on an invalid one (never silently unbounded). */
export function resolveCeiling(c: PoolCeiling): PoolCeiling {
  const okDim = (v: number | null, label: string): number | null => {
    if (v === null) return null;
    if (!Number.isFinite(v) || v <= 0) throw new Error(`shared-budget: ${label} must be null or a positive finite number (got ${String(v)})`);
    return v;
  };
  const maxUsd = okDim(c.maxUsd, 'maxUsd');
  const maxTokens = okDim(c.maxTokens, 'maxTokens');
  if (maxTokens !== null && !Number.isInteger(maxTokens)) throw new Error(`shared-budget: maxTokens must be an integer (got ${String(c.maxTokens)})`);
  if (maxUsd === null && maxTokens === null) throw new Error('shared-budget: a ceiling needs at least one of maxUsd / maxTokens');
  return { maxUsd, maxTokens };
}

export function emptyPool(poolName: string, ceiling: PoolCeiling): PoolState {
  if (!isValidPoolName(poolName)) throw new Error(`shared-budget: invalid pool name ${JSON.stringify(poolName)}`);
  return { poolName, ceiling: resolveCeiling(ceiling), draws: [], reservations: [] };
}

/** Committed (accounted) spend. */
export function spentOf(state: PoolState): PoolSpent {
  let usd = 0, tokens = 0;
  for (const d of state.draws) { usd += d.usd; tokens += d.tokens; }
  return { usd, tokens };
}

/** Reserved-but-not-yet-committed estimate (in-flight responsibility). */
export function inflightOf(state: PoolState): PoolSpent {
  let usd = 0, tokens = 0;
  for (const r of state.reservations) { usd += r.estUsd; tokens += r.estTokens; }
  return { usd, tokens };
}

/** Headroom = ceiling - committed - inflight, never negative; null = unbounded. */
export function remainingOf(state: PoolState): { usd: number | null; tokens: number | null } {
  const s = spentOf(state), f = inflightOf(state);
  return {
    usd: state.ceiling.maxUsd === null ? null : Math.max(0, state.ceiling.maxUsd - s.usd - f.usd),
    tokens: state.ceiling.maxTokens === null ? null : Math.max(0, state.ceiling.maxTokens - s.tokens - f.tokens),
  };
}

/** Exhausted when committed+inflight reaches EITHER ceiling dimension (ruling 3 + A: the admit gate counts in-flight). */
export function isExhausted(state: PoolState): boolean {
  const s = spentOf(state), f = inflightOf(state);
  if (state.ceiling.maxUsd !== null && s.usd + f.usd >= state.ceiling.maxUsd) return true;
  if (state.ceiling.maxTokens !== null && s.tokens + f.tokens >= state.ceiling.maxTokens) return true;
  return false;
}

/** Read-only advisory view of admission. The BINDING gate is `reserve` (a write under the store lock); a bare read can race. */
export function admit(state: PoolState): PoolAdmission {
  const remaining = remainingOf(state);
  return isExhausted(state) ? { ok: false, exhausted: true, remaining } : { ok: true, remaining };
}

function validateReservation(r: Reservation): void {
  if (typeof r.reserveKey !== 'string' || r.reserveKey.length === 0) throw new Error('shared-budget: reservation.reserveKey must be a non-empty string');
  if (typeof r.consumer !== 'string' || r.consumer.length === 0) throw new Error('shared-budget: reservation.consumer must be a non-empty string');
  if (!Number.isFinite(r.estUsd) || r.estUsd < 0) throw new Error(`shared-budget: reservation.estUsd must be a non-negative finite number (got ${String(r.estUsd)})`);
  if (!Number.isInteger(r.estTokens) || r.estTokens < 0) throw new Error(`shared-budget: reservation.estTokens must be a non-negative integer (got ${String(r.estTokens)})`);
  if (!Number.isInteger(r.pid) || r.pid <= 0) throw new Error(`shared-budget: reservation.pid must be a positive integer (got ${String(r.pid)})`);
  if (!Number.isFinite(r.atSec)) throw new Error(`shared-budget: reservation.atSec must be a finite number (got ${String(r.atSec)})`);
}

/** Admit + reserve atomically (the store calls this under the lock). Refuses once spent+inflight >= ceiling, so the overshoot is
 *  bounded by the single reservation that tips it. Idempotent by reserveKey (a replay returns ok against the existing reservation). */
export function reserve(state: PoolState, r: Reservation): { ok: boolean; exhausted?: true; state: PoolState } {
  validateReservation(r);
  if (state.reservations.some((x) => x.reserveKey === r.reserveKey)) return { ok: true, state }; // already reserved (idempotent)
  if (state.draws.some((d) => d.reserveKey === r.reserveKey)) return { ok: true, state }; // already committed under this key
  if (isExhausted(state)) return { ok: false, exhausted: true, state };
  return { ok: true, state: { ...state, reservations: [...state.reservations, r] } };
}

function validateDraw(d: PoolDraw): void {
  if (typeof d.drawKey !== 'string' || d.drawKey.length === 0) throw new Error('shared-budget: draw.drawKey must be a non-empty string');
  if (typeof d.consumer !== 'string' || d.consumer.length === 0) throw new Error('shared-budget: draw.consumer must be a non-empty string');
  if (!Number.isFinite(d.usd) || d.usd < 0) throw new Error(`shared-budget: draw.usd must be a non-negative finite number (got ${String(d.usd)})`);
  if (!Number.isInteger(d.tokens) || d.tokens < 0) throw new Error(`shared-budget: draw.tokens must be a non-negative integer (got ${String(d.tokens)})`);
  if (!Number.isFinite(d.atSec)) throw new Error(`shared-budget: draw.atSec must be a finite number (got ${String(d.atSec)})`);
}

/** Commit an actual spend, settling its reservation if any. Idempotent by drawKey. A draw that overshoots is STILL recorded
 *  (the unit already spent it); the bound on that overshoot is enforced at `reserve`, not here. */
export function commit(state: PoolState, draw: PoolDraw): PoolState {
  validateDraw(draw);
  const withoutRes = draw.reserveKey
    ? { ...state, reservations: state.reservations.filter((r) => r.reserveKey !== draw.reserveKey) }
    : state;
  if (withoutRes.draws.some((d) => d.drawKey === draw.drawKey)) {
    // Already committed: keep the idempotency, but still drop the (now-settled) reservation if the replay carried one.
    return withoutRes === state ? state : withoutRes;
  }
  return { ...withoutRes, draws: [...withoutRes.draws, draw] };
}

/** Direct accounting with no prior reservation (e.g. a reconciliation import). Idempotent by drawKey. */
export function applyDraw(state: PoolState, draw: PoolDraw): PoolState {
  return commit(state, draw);
}

/** Reclaim reservations whose owner is gone: dead pid (liveness) OR older than ttlSec (backstop against pid reuse). Pure: the
 *  caller injects `isAlive` and `nowSec`. */
export function pruneStaleReservations(
  state: PoolState,
  isAlive: (pid: number) => boolean,
  nowSec: number,
  ttlSec: number,
): PoolState {
  const kept = state.reservations.filter((r) => isAlive(r.pid) && !(Number.isFinite(nowSec) && nowSec - r.atSec > ttlSec));
  return kept.length === state.reservations.length ? state : { ...state, reservations: kept };
}

/** Raise the ceiling (ruling 5: coordinator-only — the CALLER owns that gate). Never lowers a dimension or drops an existing bound. */
export function raiseCeiling(state: PoolState, next: PoolCeiling): PoolState {
  const n = resolveCeiling(next);
  const notLower = (cur: number | null, nv: number | null, label: string): number | null => {
    if (cur === null) return nv;
    if (nv === null) return cur;
    if (nv < cur) throw new Error(`shared-budget: raiseCeiling cannot lower ${label} (${cur} -> ${nv})`);
    return nv;
  };
  return { ...state, ceiling: { maxUsd: notLower(state.ceiling.maxUsd, n.maxUsd, 'maxUsd'), maxTokens: notLower(state.ceiling.maxTokens, n.maxTokens, 'maxTokens') } };
}

export function project(state: PoolState, nowSec: number): BudgetPoolProjection {
  if (!Number.isFinite(nowSec)) throw new Error(`shared-budget: nowSec must be a finite number (got ${String(nowSec)})`);
  const spent = spentOf(state);
  const inflight = inflightOf(state);
  const byConsumer = new Map<string, { usd: number; tokens: number }>();
  for (const d of state.draws) {
    const c = byConsumer.get(d.consumer) ?? { usd: 0, tokens: 0 };
    c.usd += d.usd; c.tokens += d.tokens;
    byConsumer.set(d.consumer, c);
  }
  return {
    schema: 'budget-pool/v1',
    poolName: state.poolName,
    generatedAtSec: nowSec,
    ceiling: state.ceiling,
    spent,
    inflight,
    remaining: remainingOf(state),
    state: isExhausted(state) ? 'exhausted' : 'open',
    drawCount: state.draws.length,
    reservationCount: state.reservations.length,
    consumers: [...byConsumer.entries()].map(([id, v]) => ({ id, usd: v.usd, tokens: v.tokens })).sort((a, b) => b.usd - a.usd),
  };
}
