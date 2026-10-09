/**
 * FC-4 spend circuit-breaker IO (dormant filing). CONSUMES the DA2 shared-budget-store API only — it never
 * touches shared-budget's files or behavior. One budget pool per task ticket (budgetRef = `task-<ticketId>`):
 * a ticket registers its budget, each spawn reserves its estimate, real spend is booked via commit, and a
 * reserve that would exceed the cap trips the breaker. In-flight reservations are never force-killed on a
 * trip (pool semantics); only NEW spawns are refused until the coordinator rules (S19).
 */
import { createPool, readPool, reservePool, commitDraw } from "./shared-budget-store.js";
import { writeInbox, composeInboxMsg } from "../inbox.js";
import { breakerEnabled, budgetRefFor, verdictFromAdmission, type SpendVerdict } from "./spend-breaker.js";
import { spentOf, type PoolCeiling, type PoolDraw, type PoolState, type Reservation } from "./shared-budget.js";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Register a task ticket's budget: create its pool with the per-ticket cap. Idempotent (createPool is — an
 *  existing pool is returned unchanged, only its projection re-converges). */
export function openTaskBudget(home: string, ticketId: string, cap: PoolCeiling): PoolState {
  return createPool(home, budgetRefFor(ticketId), cap);
}

export type SpawnRequest = { reserveKey: string; consumer: string; estUsd: number; estTokens?: number; pid?: number };

/**
 * Ask the breaker whether a would-be spawn may proceed. OFF ⇒ always allowed, NO pool touched (dormant
 * no-op). ON ⇒ RESERVE the estimate against the ticket's pool; an admission ⇒ allowed, an exhausted pool ⇒
 * TRIPPED (refuse). Idempotent by reserveKey (shared-budget reserve is). A trip never removes in-flight
 * reservations — it only withholds admission for THIS new unit.
 */
export function requestSpawn(home: string, ticketId: string, req: SpawnRequest): SpendVerdict {
  if (!breakerEnabled()) return { allowed: true, dormant: true };
  const res: Reservation = {
    reserveKey: req.reserveKey,
    consumer: req.consumer,
    estUsd: req.estUsd,
    estTokens: req.estTokens ?? 0,
    pid: req.pid ?? process.pid,
    atSec: nowSec(),
  };
  return verdictFromAdmission(reservePool(home, budgetRefFor(ticketId), res));
}

/** Book a real spend against a ticket (reconciles its matching reserve via shared-budget commit). A no-op
 *  when the breaker is OFF (there is no ticket pool to book into). Returns the new ledger, or null when OFF. */
export function recordSpend(home: string, ticketId: string, draw: PoolDraw): PoolState | null {
  if (!breakerEnabled()) return null;
  return commitDraw(home, budgetRefFor(ticketId), draw);
}

/** Read a ticket's budget ledger (null when the ticket was never registered). */
export function taskBudget(home: string, ticketId: string): PoolState | null {
  return readPool(home, budgetRefFor(ticketId));
}

/**
 * S19 — present a trip to the coordinator (dormant seam). When the breaker refuses a spawn, the ticket needs
 * a human call (raise the cap or halt the ticket); this writes ONE durable-inbox card to the coordinator via
 * the existing inbox transport. It is NOT auto-wired: a dispatcher that arms the breaker calls it on a tripped
 * verdict. In-flight work keeps running — only new spawns are withheld until the coordinator rules.
 */
export function presentTripToCoordinator(
  home: string,
  coordinatorId: string,
  ticketId: string,
  v: Extract<SpendVerdict, { allowed: false }>,
): void {
  const st = taskBudget(home, ticketId);
  const spent = st ? spentOf(st) : { usd: 0, tokens: 0 };
  const rem = v.remaining.usd === null ? "∞" : `$${v.remaining.usd}`;
  writeInbox(home, coordinatorId, composeInboxMsg({
    from: coordinatorId,
    fromLabel: "spend-breaker",
    text: `task ${ticketId} hit its spend cap — further spawning refused (spent $${spent.usd.toFixed(2)} / ${spent.tokens} tok; remaining ${rem}). Raise the cap or halt the ticket; in-flight work keeps running.`,
    via: "spend-breaker",
    taskRef: `spend-breaker:${ticketId}`,
    title: "spend cap tripped — decide",
  }));
}
