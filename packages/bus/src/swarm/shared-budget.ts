/**
 * Shared-budget pool pure core (DA2, docker-agent borrow #2 — grounds in docs/research/docker-agent-eval.md axis-cost + Q⑤,
 * design docs/swarm/shared-budget-design.md). A NAMED pool = one ceiling, many consumers: N concurrent consumers that reference
 * the same pool name draw from the SAME ceiling, so a fan-out to N sub-tasks cannot spend N times the limit (docker-agent's
 * `budgets` shared-pot semantics). The soft shared layer above fan-out's per-run ticket caps.
 *
 * Coordinator rulings (DA2 APPROVED) + DA2-R1/R2 review fixes:
 *  (3/A, SB3) Overshoot is BOUNDED and the bound is PROVABLE AT ADMIT: admission (`reserve`) counts committed spend PLUS reserved
 *      in-flight, refusing once `spent + inflight >= ceiling`, so the only overshoot is the single reservation that tips the pool —
 *      bound = ceiling + one max ticket, independent of consumer count. Unsettled liability is NEVER refunded: a reservation whose
 *      owner is gone is SETTLED to a presumed-spent draw at its estimate (`settleExpiredReservations`), never deleted (deleting
 *      would refund headroom the vanished unit may already have spent, reopening unbounded overshoot — SB3/R2). `commit` settles
 *      only the committing consumer's OWN reservation and is a pure no-op on an already-committed drawKey, so a replay or a
 *      cross-consumer commit can never erase another reservation (SB3/R2).
 *  (3) Exhaustion = maxUsd OR maxTokens, whichever hits first (fail-closed).
 *  (5) Raising the ceiling is a money-gate (coordinator only) — enforced by the caller.
 *
 * Pure: no fs, no clock beyond injected timestamps / liveness. The IO half (lock, CAS, projection) is shared-budget-store.ts.
 */

export type PoolCeiling = { maxUsd: number | null; maxTokens: number | null };

/** An admitted-but-not-yet-accounted unit (its ticket estimate held against the pool). Idempotent by `reserveKey`. */
export type Reservation = {
  reserveKey: string;
  consumer: string;
  estUsd: number;
  estTokens: number;
  pid: number;
  atSec: number;
};

/** One accounted spend. Idempotent by `drawKey`. `presumed` marks an estimate booked for a vanished reservation (SB3): it holds
 *  the liability until the real unit commits (which reconciles it to the actual) or stands as a conservative charge forever. */
export type PoolDraw = {
  drawKey: string;
  consumer: string;
  usd: number;
  tokens: number;
  atSec: number;
  reserveKey?: string;
  presumed?: boolean;
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
  spent: PoolSpent;
  inflight: PoolSpent;
  remaining: { usd: number | null; tokens: number | null };
  state: 'open' | 'exhausted';
  drawCount: number;
  reservationCount: number;
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

/** Admit + reserve atomically (store calls this under the lock). Refuses once spent+inflight >= ceiling. Idempotent by reserveKey. */
export function reserve(state: PoolState, r: Reservation): { ok: boolean; exhausted?: true; state: PoolState } {
  validateReservation(r);
  if (state.reservations.some((x) => x.reserveKey === r.reserveKey)) return { ok: true, state }; // already reserved
  if (state.draws.some((d) => d.reserveKey === r.reserveKey)) return { ok: true, state }; // already committed/settled under this key
  if (isExhausted(state)) return { ok: false, exhausted: true, state };
  return { ok: true, state: { ...state, reservations: [...state.reservations, r] } };
}

function validateDraw(d: PoolDraw): void {
  if (typeof d.drawKey !== 'string' || d.drawKey.length === 0) throw new Error('shared-budget: draw.drawKey must be a non-empty string');
  if (typeof d.consumer !== 'string' || d.consumer.length === 0) throw new Error('shared-budget: draw.consumer must be a non-empty string');
  if (!Number.isFinite(d.usd) || d.usd < 0) throw new Error(`shared-budget: draw.usd must be a non-negative finite number (got ${String(d.usd)})`);
  if (!Number.isInteger(d.tokens) || d.tokens < 0) throw new Error(`shared-budget: draw.tokens must be a non-negative integer (got ${String(d.tokens)})`);
  if (!Number.isFinite(d.atSec)) throw new Error(`shared-budget: draw.atSec must be a finite number (got ${String(d.atSec)})`);
  // SB2: the optional association fields must be write-valid, or the ledger becomes unreadable by the same-version reader.
  if (d.reserveKey !== undefined && (typeof d.reserveKey !== 'string' || d.reserveKey.length === 0)) throw new Error('shared-budget: draw.reserveKey, when present, must be a non-empty string');
  if (d.presumed !== undefined && typeof d.presumed !== 'boolean') throw new Error('shared-budget: draw.presumed, when present, must be a boolean');
}

/** Commit an actual spend. Settles ONLY the committing consumer's own matching reservation (ownership binding) and reconciles a
 *  prior presumed-spent estimate for the same reserveKey (replaces the estimate with the actual). A pure no-op when the (real)
 *  drawKey is already committed — a replay or cross-consumer commit therefore never erases another reservation (SB3/R2). */
export function commit(state: PoolState, draw: PoolDraw): PoolState {
  validateDraw(draw);
  if (state.draws.some((d) => d.drawKey === draw.drawKey && !d.presumed)) return state; // already committed (real) => no-op, strips nothing
  let reservations = state.reservations;
  let draws = state.draws;
  if (draw.reserveKey !== undefined) {
    reservations = reservations.filter((r) => !(r.reserveKey === draw.reserveKey && r.consumer === draw.consumer)); // settle only our own
    draws = draws.filter((d) => !(d.presumed && d.reserveKey === draw.reserveKey)); // reconcile a presumed estimate with the actual
  }
  if (draws.some((d) => d.drawKey === draw.drawKey)) return { ...state, reservations, draws }; // settled, but the draw already exists
  return { ...state, reservations, draws: [...draws, draw] };
}

/** Direct accounting with no prior reservation (reconciliation import). Idempotent by drawKey. */
export function applyDraw(state: PoolState, draw: PoolDraw): PoolState {
  return commit(state, draw);
}

/** Settle reservations whose owner is gone: dead pid (liveness) OR older than ttlSec (backstop). A gone reservation is NOT
 *  refunded — it is CONVERTED to a presumed-spent draw at its estimate, so committed+inflight never drops without evidence of
 *  settlement and the overshoot bound holds (SB3/R2). The real unit, if still alive, reconciles it later via `commit`. Pure:
 *  caller injects `isAlive` + `nowSec`. */
export function settleExpiredReservations(
  state: PoolState,
  isAlive: (pid: number) => boolean,
  nowSec: number,
  ttlSec: number,
): PoolState {
  const isStale = (r: Reservation) => !isAlive(r.pid) || (Number.isFinite(nowSec) && nowSec - r.atSec > ttlSec);
  const stale = state.reservations.filter(isStale);
  if (stale.length === 0) return state;
  const live = state.reservations.filter((r) => !isStale(r));
  const alreadyPresumed = new Set(state.draws.filter((d) => d.presumed && d.reserveKey !== undefined).map((d) => d.reserveKey));
  const committedKeys = new Set(state.draws.map((d) => d.reserveKey).filter((k): k is string => k !== undefined));
  const presumed: PoolDraw[] = stale
    .filter((r) => !alreadyPresumed.has(r.reserveKey) && !committedKeys.has(r.reserveKey)) // don't double-book or override a real commit
    .map((r) => ({
      drawKey: `presumed:${r.reserveKey}`,
      consumer: r.consumer,
      usd: r.estUsd,
      tokens: r.estTokens,
      atSec: Number.isFinite(nowSec) ? nowSec : r.atSec,
      reserveKey: r.reserveKey,
      presumed: true,
    }));
  return { ...state, reservations: live, draws: [...state.draws, ...presumed] };
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
    consumers: [...byConsumer.entries()].map(([id, v]) => ({ id, usd: v.usd, tokens: v.tokens })).sort((a, b) => b.usd - a.usd),
  };
}
