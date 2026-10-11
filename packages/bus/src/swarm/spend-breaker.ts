/**
 * FC-4 spend circuit-breaker (pure core). A per-task-ticket spend cap layered on the DA2 shared-budget pool
 * primitives: each ticket gets a budget pool (ceiling = the ticket's spend cap); every would-be spawn first
 * RESERVEs its estimate. It is a SOFT cap (shared-budget SB3): a reserve is admitted while committed +
 * in-flight is still under the ceiling, so the reserve that FIRST crosses the line is let through and the NEXT
 * one trips — the breaker then refuses further spawns, presents the trip to the coordinator (S19), and leaves
 * in-flight work ALONE (a reservation is never force-killed; it reconciles via commit, or on owner-timeout is
 * marked SETTLED with its estimate RETAINED as a conservative charge — SB3: never refunded). This is the
 * spend-AMOUNT dimension, distinct from the existing spawn-COUNT cap a runaway ticket would otherwise slip.
 *
 * DORMANT: gated behind SWARM_SPEND_BREAKER (default OFF). OFF ⇒ every request is allowed and NO pool is
 * touched (a true no-op); nothing here is wired into the real dispatcher — FC-4 is a filing, not a switch.
 * This module only CONSUMES the shared-budget API; it never changes signed shared-budget behavior.
 */
import { isValidPoolName, type PoolAdmission, type PoolCeiling } from "./shared-budget.js";
import { flagDefaultOn } from "./flag-default.js";

/** Is the breaker armed? LIVE BY DEFAULT (opt-out via [[flagDefaultOn]], flags-default-flip batch-2, user ruling 2026-10-11): on
 *  unless SWARM_SPEND_BREAKER=0. Tier A (safe direction — the breaker only PREVENTS spend, never authorizes it).
 *  NOTE: nothing wires spend-breaker-store into the real dispatcher yet (a filing, per the module header), so this flip is an
 *  honest no-op until it is wired — it only changes the DEFAULT the day it is. */
export function breakerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagDefaultOn(env.SWARM_SPEND_BREAKER);
}

// A ticketId maps to the pool name `task-<ticketId>`; 57 + "task-".length(5) = 62 ≤ the 64-char pool ceiling.
const SAFE_TICKET = /^[A-Za-z0-9_-]{1,57}$/;
/** The budget pool name (budgetRef) for a task ticket. Rejects an unsafe ticketId BEFORE any path is built —
 *  same fail-closed discipline as shared-budget's pool names (reject, never sanitize). */
export function budgetRefFor(ticketId: string): string {
  if (typeof ticketId !== "string" || !SAFE_TICKET.test(ticketId)) {
    throw new Error(`spend-breaker: unsafe ticketId ${JSON.stringify(ticketId)} — allowed [A-Za-z0-9_-], 1-57 chars`);
  }
  const ref = `task-${ticketId}`;
  if (!isValidPoolName(ref)) throw new Error(`spend-breaker: budgetRef ${JSON.stringify(ref)} is not a valid pool name`);
  return ref;
}

export type SpendVerdict =
  | { allowed: true; dormant?: true; remaining?: { usd: number | null; tokens: number | null } }
  | { allowed: false; tripped: true; remaining: { usd: number | null; tokens: number | null } };

/** Map a shared-budget admission to a breaker verdict: an admitted reserve ⇒ allowed; an exhausted pool ⇒
 *  TRIPPED (refuse the spawn). A null admission (the ticket's pool does not exist) is NOT allowed — a spawn
 *  must register its budgetRef via openTaskBudget first, so an unregistered ticket cannot bypass the cap. */
export function verdictFromAdmission(adm: PoolAdmission | null): SpendVerdict {
  if (adm === null) return { allowed: false, tripped: true, remaining: { usd: 0, tokens: 0 } };
  if (adm.ok) return { allowed: true, remaining: adm.remaining };
  return { allowed: false, tripped: true, remaining: adm.remaining };
}

/** A per-ticket cap as a PoolCeiling (usd and/or tokens; null = unbounded on that axis). */
export function ticketCeiling(maxUsd: number | null, maxTokens: number | null = null): PoolCeiling {
  return { maxUsd, maxTokens };
}
