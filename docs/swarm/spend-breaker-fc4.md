# FC-4 spend circuit-breaker (filing)

owner aad02248 · 2026-10-09 · 协调者派单(二巡预防 F 立案 FC-4)· 基线 feat/shared-budget @ddb8cda(见末节基线接缝)· 状态:**纯核 + dormant,待复审**

## Problem

The swarm caps only spawn-COUNT (how many sub-units a ticket may launch). There is no spend-AMOUNT circuit: a runaway ticket can keep each spawn under the count cap yet burn through the budget. FC-4 adds the missing dimension.

## Design (reuses the DA2 shared-budget primitives — consumes, never modifies)

Per TASK TICKET, one shared-budget pool (`budgetRef = task-<ticketId>`, ceiling = the ticket's spend cap):

- **Register:** `openTaskBudget(home, ticketId, cap)` → `createPool`. A ticket registers its budgetRef when it first reserves.
- **Reserve-on-spawn:** `requestSpawn(home, ticketId, {reserveKey, consumer, estUsd, estTokens?})` → `reservePool`. Admitted ⇒ `{allowed:true}`; the pool's committed + in-flight at/over the cap ⇒ `{allowed:false, tripped:true}` — **refuse further spawning**.
- **Book real spend:** `recordSpend(home, ticketId, draw)` → `commitDraw` (reconciles the reserve to actual).
- **In-flight is never killed on a trip** — a trip only withholds admission for the NEW unit; existing reservations/draws reconcile or expire via pool semantics (== shared-budget SB3). Same as the pool's "settled, not refunded" discipline.
- **S19 present:** `presentTripToCoordinator(home, coordinatorId, ticketId, verdict)` writes ONE durable-inbox card ("raise the cap or halt; in-flight keeps running") via the existing inbox transport. The coordinator rules (HITL).
- An **unregistered ticket cannot bypass the cap**: a reserve against a nonexistent pool returns null ⇒ tripped (must `openTaskBudget` first).

Judgment stays in shared-budget (admission/exhaustion); FC-4 only maps the admission to a spawn verdict and frames it per-ticket.

## Dormant (a filing, not a switch)

- Gated behind `SWARM_SPEND_BREAKER` (default **OFF**). OFF ⇒ `requestSpawn` always allows and **touches no pool** (true no-op); `recordSpend` is a no-op.
- **Not wired** into any dispatcher. The seams below are where a future dispatcher would arm it.

## API (3 new files, no changes to signed modules)

- `packages/bus/src/swarm/spend-breaker.ts` (pure): `breakerEnabled`, `budgetRefFor`, `verdictFromAdmission`, `ticketCeiling`, `SpendVerdict`.
- `packages/bus/src/swarm/spend-breaker-store.ts` (IO, consumes shared-budget-store): `openTaskBudget`, `requestSpawn`, `recordSpend`, `taskBudget`, `presentTripToCoordinator`, `SpawnRequest`.
- `packages/bus/src/swarm/spend-breaker.selftest.mts` (18 assertions).

## Wiring seams (for whoever enables it later — out of this filing)

1. At dispatch, before launching a ticket's sub-unit: `requestSpawn`; on `allowed:false` skip the spawn and `presentTripToCoordinator`.
2. On a unit's real-cost report: `recordSpend`.
3. On ticket open: `openTaskBudget` with the ticket's cap (policy source TBD — e.g. T3 plan budget).
4. Arm via `SWARM_SPEND_BREAKER=1` once wired + validated.

## Gates

- spend-breaker selftest 18/18; **shared-budget selftest unchanged 39/39**; **decision-batch unchanged 34/34**; bus `tsc --noEmit` = 0. Only 3 new files; zero diff to shared-budget / holder-lock / decision-batch.

## Base-branch seam

The shared-budget primitives this consumes are on `feat/shared-budget @ddb8cda` (0 REMAIN, awaiting coordinator integration), NOT on `main` (which has diverged). So FC-4 is branched **off feat/shared-budget** (the only base that carries the API), not off main as the dispatch said. The two integrate as a stack; rebase onto main after shared-budget lands there. Raised to the coordinator.
