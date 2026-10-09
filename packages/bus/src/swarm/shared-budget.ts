/**
 * Shared-budget pool pure core (DA2, docker-agent borrow #2 — grounds in docs/research/docker-agent-eval.md axis-cost + Q⑤,
 * design docs/swarm/shared-budget-design.md). A NAMED pool = one ceiling, many consumers: N consumers referencing the same pool
 * name draw from the SAME ceiling, so a fan-out to N sub-tasks cannot spend N times the limit. The soft shared layer above
 * fan-out's per-run ticket caps.
 *
 * Coordinator rulings (DA2 APPROVED) + review fixes through DA2-R3:
 *  (3/A, SB3) Overshoot is bounded and provable AT ADMIT: `reserve` counts committed spend + in-flight reservations and refuses at
 *      `spent + inflight >= ceiling`, so the only overshoot is the single reservation that tips the pool (bound = ceiling + one max
 *      ticket, independent of consumer count). Unsettled liability is NEVER refunded: a reservation whose owner is gone is MARKED
 *      `settled` (its estimate stays counted as in-flight liability), never deleted and never converted into a draw — so it can't
 *      refund headroom and its internal key can't collide with a real drawKey (SB3/R3). A reservation is settled ONCE (idempotent),
 *      in a single liveness sample (SB3/R3: no double-sample can drop it). `commit` removes ONLY the committing consumer's own
 *      reservation (open or settled) and is a no-op on an already-committed drawKey, so a replay / cross-consumer commit can never
 *      erase another consumer's liability (SB3/R3). A live unit reconciles its estimate to the actual on commit.
 *  (3) Exhaustion = maxUsd OR maxTokens, whichever hits first (fail-closed).
 *  (5) Raising the ceiling is a money-gate (coordinator only) — enforced by the caller.
 *
 * Pure: no fs, no clock beyond injected timestamps / liveness. The IO half (lock, CAS, projection) is shared-budget-store.ts.
 */

export type PoolCeiling = { maxUsd: number | null; maxTokens: number | null };

/** An admitted unit's held liability (its ticket estimate). Idempotent by `reserveKey`. `settled` = its owner is gone and the
 *  estimate now stands as a conservative charge (still counted in-flight) until the real unit reconciles it via `commit`. */
export type Reservation = {
  reserveKey: string;
  consumer: string;
  estUsd: number;
  estTokens: number;
  pid: number;
  atSec: number;
  settled?: boolean;
};

/** One accounted (real) spend. Idempotent by `drawKey`. draws[] holds ONLY real commits — never a synthetic/presumed record. */
export type PoolDraw = {
  drawKey: string;
  consumer: string;
  usd: number;
  tokens: number;
  atSec: number;
  reserveKey?: string;
};

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

export type BudgetPoolProjection = {
  schema: 'budget-pool/v1';
  poolName: string;
  generatedAtSec: number;
  ceiling: PoolCeiling;
  spent: PoolSpent;        // committed (real) spend
  inflight: PoolSpent;     // reserved liability (open + settled estimates)
  remaining: { usd: number | null; tokens: number | null };
  state: 'open' | 'exhausted';
  drawCount: number;
  reservationCount: number;
  settledCount: number;    // reservations whose owner vanished; estimate held as a conservative charge
  consumers: { id: string; usd: number; tokens: number }[];
};

export const isValidPoolName = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name);

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

export function spentOf(state: PoolState): PoolSpent {
  let usd = 0, tokens = 0;
  for (const d of state.draws) { usd += d.usd; tokens += d.tokens; }
  return { usd, tokens };
}

/** In-flight liability = every reservation's estimate (open AND settled — a settled one still holds its charge until reconciled). */
export function inflightOf(state: PoolState): PoolSpent {
  let usd = 0, tokens = 0;
  for (const r of state.reservations) { usd += r.estUsd; tokens += r.estTokens; }
  return { usd, tokens };
}

export function remainingOf(state: PoolState): { usd: number | null; tokens: number | null } {
  const s = spentOf(state), f = inflightOf(state);
  return {
    usd: state.ceiling.maxUsd === null ? null : Math.max(0, state.ceiling.maxUsd - s.usd - f.usd),
    tokens: state.ceiling.maxTokens === null ? null : Math.max(0, state.ceiling.maxTokens - s.tokens - f.tokens),
  };
}

export function isExhausted(state: PoolState): boolean {
  const s = spentOf(state), f = inflightOf(state);
  if (state.ceiling.maxUsd !== null && s.usd + f.usd >= state.ceiling.maxUsd) return true;
  if (state.ceiling.maxTokens !== null && s.tokens + f.tokens >= state.ceiling.maxTokens) return true;
  return false;
}

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

/** Admit + reserve atomically (store calls under the lock). Refuses once spent+inflight >= ceiling. Idempotent by reserveKey. */
export function reserve(state: PoolState, r: Reservation): { ok: boolean; exhausted?: true; state: PoolState } {
  validateReservation(r);
  if (state.reservations.some((x) => x.reserveKey === r.reserveKey)) return { ok: true, state }; // already reserved
  if (state.draws.some((d) => d.reserveKey === r.reserveKey)) return { ok: true, state }; // already committed under this key
  if (isExhausted(state)) return { ok: false, exhausted: true, state };
  return { ok: true, state: { ...state, reservations: [...state.reservations, { ...r, settled: false }] } };
}

function validateDraw(d: PoolDraw): void {
  if (typeof d.drawKey !== 'string' || d.drawKey.length === 0) throw new Error('shared-budget: draw.drawKey must be a non-empty string');
  if (typeof d.consumer !== 'string' || d.consumer.length === 0) throw new Error('shared-budget: draw.consumer must be a non-empty string');
  if (!Number.isFinite(d.usd) || d.usd < 0) throw new Error(`shared-budget: draw.usd must be a non-negative finite number (got ${String(d.usd)})`);
  if (!Number.isInteger(d.tokens) || d.tokens < 0) throw new Error(`shared-budget: draw.tokens must be a non-negative integer (got ${String(d.tokens)})`);
  if (!Number.isFinite(d.atSec)) throw new Error(`shared-budget: draw.atSec must be a finite number (got ${String(d.atSec)})`);
  if (d.reserveKey !== undefined && (typeof d.reserveKey !== 'string' || d.reserveKey.length === 0)) throw new Error('shared-budget: draw.reserveKey, when present, must be a non-empty string');
}

/** Commit an actual spend. Removes ONLY the committing consumer's own reservation (open or settled) and books the real draw. A pure
 *  no-op on an already-committed drawKey, so a replay / cross-consumer commit never erases another consumer's reservation (SB3/R3). */
export function commit(state: PoolState, draw: PoolDraw): PoolState {
  validateDraw(draw);
  if (state.draws.some((d) => d.drawKey === draw.drawKey)) return state; // real drawKey already present => no-op, strips nothing
  const reservations = draw.reserveKey === undefined
    ? state.reservations
    : state.reservations.filter((r) => !(r.reserveKey === draw.reserveKey && r.consumer === draw.consumer)); // own only (consumer-bound)
  return { ...state, reservations, draws: [...state.draws, draw] };
}

/** Direct accounting with no prior reservation (reconciliation import). Idempotent by drawKey. */
export function applyDraw(state: PoolState, draw: PoolDraw): PoolState {
  return commit(state, draw);
}

/** Mark reservations whose owner is gone as `settled` — a SINGLE liveness sample per reservation (SB3/R3: no double-sample can
 *  drop one), and NEVER deleted or refunded (its estimate stays counted in-flight). Already-settled reservations are left as-is
 *  (idempotent). The real unit, if alive, reconciles its estimate via `commit`. Pure: caller injects `isAlive` + `nowSec`. */
export function settleExpiredReservations(
  state: PoolState,
  isAlive: (pid: number) => boolean,
  nowSec: number,
  ttlSec: number,
): PoolState {
  let changed = false;
  const reservations = state.reservations.map((r) => {
    if (r.settled) return r; // settle once
    const gone = !isAlive(r.pid) || (Number.isFinite(nowSec) && nowSec - r.atSec > ttlSec); // ONE sample
    if (!gone) return r;
    changed = true;
    return { ...r, settled: true };
  });
  return changed ? { ...state, reservations } : state;
}

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
    settledCount: state.reservations.filter((r) => r.settled).length,
    consumers: [...byConsumer.entries()].map(([id, v]) => ({ id, usd: v.usd, tokens: v.tokens })).sort((a, b) => b.usd - a.usd),
  };
}
