/**
 * Shared-budget pool pure core (DA2, docker-agent borrow #2 — grounds in docs/research/docker-agent-eval.md axis-cost + Q⑤,
 * design docs/swarm/shared-budget-design.md). A NAMED pool = one ceiling, many consumers: N concurrent consumers that reference
 * the same pool name draw from the SAME ceiling, so a fan-out to N sub-tasks cannot spend N times the limit (docker-agent's
 * `budgets` shared-pot semantics). It is the shared layer above fan-out's PER-RUN ticket caps, not a replacement for them.
 *
 * Two levels compose (design §两级预算): fan-out's per-run breaker is HARD (aborts in-flight on its own cap — already signed,
 * untouched); this shared-pool ceiling is SOFT — pool-empty REFUSES new dispatch, never kills in-flight.
 *
 * Coordinator rulings folded (2026-10-09, DA2 APPROVED):
 *  (1) CAS = single-file optimistic CAS (the store's job; this core is pure).
 *  (2) v0 TOLERATES small overshoot: spend is accounted AFTER it actually happens (LLM cost is known only post-response), so a
 *      burst of admits can pass before any is accounted. A draw is ALWAYS recorded even when it pushes spent past the ceiling —
 *      the in-flight unit already spent it. Overshoot is bounded by one max ticket; the projection shows spent>ceiling, never hides it.
 *  (3) Exhaustion = maxUsd OR maxTokens, whichever hits first (fail-closed).
 *  (5) Raising the ceiling is a money-gate action (coordinator only) — enforced at the dispatch/store layer, not here.
 *
 * Pure: no fs, no clock beyond an injected `nowSec` (for the projection). Fully unit-testable; the IO half (CAS read-modify-write
 * of the pool file + projection write) lives in shared-budget-store.ts.
 */

/** A pool ceiling. At least one dimension must be set; a null dimension is unbounded on that axis. */
export type PoolCeiling = { maxUsd: number | null; maxTokens: number | null };

/** One accounted spend against the pool. Idempotent by `drawKey` (content-addressed, like fan-out's runKey): the same key is
 *  never recorded twice, so a reconnect/retry cannot double-count. */
export type PoolDraw = {
  drawKey: string;   // content-addressed idempotency key (poolName is the scope; this is unique within it)
  consumer: string;  // consumer id (which fan-out run / sub-task spent)
  usd: number;       // actual USD spent by this draw (>= 0)
  tokens: number;    // actual tokens spent by this draw (>= 0, integer)
  atSec: number;     // when it was accounted (epoch sec)
};

/** The durable pool state (what the store reads/writes under a CAS lock). `draws` is the append-only audit + idempotency record. */
export type PoolState = {
  poolName: string;
  ceiling: PoolCeiling;
  draws: PoolDraw[];
};

export type PoolSpent = { usd: number; tokens: number };

/** Admission result for a consumer about to dispatch NEW work. */
export type PoolAdmission =
  | { ok: true; remaining: { usd: number | null; tokens: number | null } }
  | { ok: false; exhausted: true; remaining: { usd: number | null; tokens: number | null } };

/** The frozen read projection (budget-pool/v1) the console/coordinator renders. */
export type BudgetPoolProjection = {
  schema: 'budget-pool/v1';
  poolName: string;
  generatedAtSec: number;
  ceiling: PoolCeiling;
  spent: PoolSpent;
  remaining: { usd: number | null; tokens: number | null };
  state: 'open' | 'exhausted';
  drawCount: number;
  consumers: { id: string; usd: number; tokens: number }[];
};

/** Validate a pool name is a safe locator (same rule family as roomId/batchId): rejected, never sanitized. */
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

/** A fresh, empty pool. */
export function emptyPool(poolName: string, ceiling: PoolCeiling): PoolState {
  if (!isValidPoolName(poolName)) throw new Error(`shared-budget: invalid pool name ${JSON.stringify(poolName)}`);
  return { poolName, ceiling: resolveCeiling(ceiling), draws: [] };
}

/** Total accounted spend. */
export function spentOf(state: PoolState): PoolSpent {
  let usd = 0;
  let tokens = 0;
  for (const d of state.draws) {
    usd += d.usd;
    tokens += d.tokens;
  }
  return { usd, tokens };
}

/** Remaining headroom per dimension (never negative even on overshoot; null = unbounded on that axis). */
export function remainingOf(state: PoolState): { usd: number | null; tokens: number | null } {
  const spent = spentOf(state);
  return {
    usd: state.ceiling.maxUsd === null ? null : Math.max(0, state.ceiling.maxUsd - spent.usd),
    tokens: state.ceiling.maxTokens === null ? null : Math.max(0, state.ceiling.maxTokens - spent.tokens),
  };
}

/** Exhausted when EITHER dimension is at/over its ceiling (ruling 3: usd OR tokens, fail-closed). */
export function isExhausted(state: PoolState): boolean {
  const spent = spentOf(state);
  if (state.ceiling.maxUsd !== null && spent.usd >= state.ceiling.maxUsd) return true;
  if (state.ceiling.maxTokens !== null && spent.tokens >= state.ceiling.maxTokens) return true;
  return false;
}

/** Admission check a consumer runs BEFORE dispatching new work. Refuses only when already exhausted (soft: in-flight is untouched). */
export function admit(state: PoolState): PoolAdmission {
  const remaining = remainingOf(state);
  return isExhausted(state) ? { ok: false, exhausted: true, remaining } : { ok: true, remaining };
}

/** Record an actual spend. Idempotent by drawKey (same key => unchanged state). Validates the draw loudly. A draw that pushes
 *  spent past the ceiling is STILL recorded (ruling 2: the in-flight unit already spent it; overshoot is shown, never hidden). */
export function applyDraw(state: PoolState, draw: PoolDraw): PoolState {
  if (typeof draw.drawKey !== 'string' || draw.drawKey.length === 0) throw new Error('shared-budget: draw.drawKey must be a non-empty string');
  if (typeof draw.consumer !== 'string' || draw.consumer.length === 0) throw new Error('shared-budget: draw.consumer must be a non-empty string');
  if (!Number.isFinite(draw.usd) || draw.usd < 0) throw new Error(`shared-budget: draw.usd must be a non-negative finite number (got ${String(draw.usd)})`);
  if (!Number.isInteger(draw.tokens) || draw.tokens < 0) throw new Error(`shared-budget: draw.tokens must be a non-negative integer (got ${String(draw.tokens)})`);
  if (!Number.isFinite(draw.atSec)) throw new Error(`shared-budget: draw.atSec must be a finite number (got ${String(draw.atSec)})`);
  if (state.draws.some((d) => d.drawKey === draw.drawKey)) return state; // idempotent: already recorded
  return { ...state, draws: [...state.draws, draw] };
}

/** Raise the ceiling (ruling 5: coordinator-only — the CALLER is responsible for that gate; this pure fn just applies it).
 *  A raise never lowers a dimension below the current one, and never removes a bound that exists. */
export function raiseCeiling(state: PoolState, next: PoolCeiling): PoolState {
  const n = resolveCeiling(next);
  const notLower = (cur: number | null, nv: number | null, label: string): number | null => {
    if (cur === null) return nv; // was unbounded; allow setting a bound
    if (nv === null) return cur;  // keep the existing bound (never drop it via a raise)
    if (nv < cur) throw new Error(`shared-budget: raiseCeiling cannot lower ${label} (${cur} -> ${nv})`);
    return nv;
  };
  return { ...state, ceiling: { maxUsd: notLower(state.ceiling.maxUsd, n.maxUsd, 'maxUsd'), maxTokens: notLower(state.ceiling.maxTokens, n.maxTokens, 'maxTokens') } };
}

/** Build the frozen read projection. Deterministic in `nowSec`. */
export function project(state: PoolState, nowSec: number): BudgetPoolProjection {
  if (!Number.isFinite(nowSec)) throw new Error(`shared-budget: nowSec must be a finite number (got ${String(nowSec)})`);
  const spent = spentOf(state);
  const byConsumer = new Map<string, { usd: number; tokens: number }>();
  for (const d of state.draws) {
    const c = byConsumer.get(d.consumer) ?? { usd: 0, tokens: 0 };
    c.usd += d.usd;
    c.tokens += d.tokens;
    byConsumer.set(d.consumer, c);
  }
  return {
    schema: 'budget-pool/v1',
    poolName: state.poolName,
    generatedAtSec: nowSec,
    ceiling: state.ceiling,
    spent,
    remaining: remainingOf(state),
    state: isExhausted(state) ? 'exhausted' : 'open',
    drawCount: state.draws.length,
    consumers: [...byConsumer.entries()].map(([id, v]) => ({ id, usd: v.usd, tokens: v.tokens })).sort((a, b) => b.usd - a.usd),
  };
}
