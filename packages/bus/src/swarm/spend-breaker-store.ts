/**
 * FC-4 spend circuit-breaker IO (dormant filing). CONSUMES the DA2 shared-budget-store API only — it never
 * touches shared-budget's files or behavior. One budget pool per task ticket (budgetRef = `task-<ticketId>`):
 * a ticket registers its budget, each spawn reserves its estimate, real spend is booked via commit. It is a
 * SOFT cap (shared-budget SB3): a reserve made once committed + in-flight is already at/over the ceiling is
 * refused — the reserve that first crosses is admitted, the one after it trips. In-flight reservations are
 * never force-killed on a trip, and a settled (owner-timed-out) reserve KEEPS its liability (never refunded);
 * only NEW spawns are refused until the coordinator rules (S19).
 */
import { createPool, readPool, reservePool, commitDraw } from "./shared-budget-store.js";
import { writeInbox, composeInboxMsg } from "../inbox.js";
import { breakerEnabled, budgetRefFor, verdictFromAdmission, type SpendVerdict } from "./spend-breaker.js";
import { spentOf, inflightOf, remainingOf, type PoolCeiling, type PoolDraw, type PoolState, type Reservation } from "./shared-budget.js";

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
  // SBK-P2-1: the card must NAME the dimension(s) that tripped and show per-axis balances WITH UNITS,
  // distinguishing committed spend from in-flight liability — and must NOT present an unbounded (null-ceiling)
  // axis as "the balance". Derive from the pool ledger; fall back to the verdict's remaining only if the pool
  // is ABSENT (the ticket was never registered — taskBudget returns null; a read error EACCES/… THROWS out of
  // taskBudget to the caller to retry, it does not reach this fallback).
  const st = taskBudget(home, ticketId);
  const lines: string[] = [];
  const tripped: string[] = [];
  if (st) {
    const spent = spentOf(st), inflight = inflightOf(st), rem = remainingOf(st), ceil = st.ceiling;
    if (ceil.maxUsd !== null) {
      const r = rem.usd ?? 0;
      lines.push(`USD $${spent.usd.toFixed(2)} committed + $${inflight.usd.toFixed(2)} in-flight of $${ceil.maxUsd} cap (remaining $${r.toFixed(2)})`);
      if (r <= 0) tripped.push("USD");
    }
    if (ceil.maxTokens !== null) {
      const r = rem.tokens ?? 0;
      lines.push(`tokens ${spent.tokens} committed + ${inflight.tokens} in-flight of ${ceil.maxTokens} cap (remaining ${r})`);
      if (r <= 0) tripped.push("tokens");
    }
  } else {
    // pool ABSENT (taskBudget → null: the ticket was never registered). A read error (EACCES/…) does NOT land
    // here — it throws out of taskBudget to the caller. Least-bad fallback from the verdict (no committed/
    // in-flight split, which only the ledger carries), still unit-tagged and still skipping any unbounded axis.
    if (v.remaining.usd !== null) { lines.push(`USD remaining $${v.remaining.usd.toFixed(2)}`); if (v.remaining.usd <= 0) tripped.push("USD"); }
    if (v.remaining.tokens !== null) { lines.push(`tokens remaining ${v.remaining.tokens}`); if (v.remaining.tokens <= 0) tripped.push("tokens"); }
  }
  const dims = tripped.length ? tripped.join(" + ") : "budget";
  const detail = lines.length ? " — " + lines.join("; ") : "";
  writeInbox(home, coordinatorId, composeInboxMsg({
    from: coordinatorId,
    fromLabel: "spend-breaker",
    text: `task ${ticketId} hit its ${dims} cap — further spawning refused${detail}. Raise the cap or halt the ticket; in-flight work keeps running.`,
    via: "spend-breaker",
    taskRef: `spend-breaker:${ticketId}`,
    title: `spend cap tripped (${dims}) — decide`,
  }));
}
