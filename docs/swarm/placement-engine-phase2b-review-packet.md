# placement-engine phase-2b — review packet (S14, owner 90b58f9c)

Branch `feat/placement-phase2b`, baseline `fa4f5ac` (new main; phase-2a 90cdda2 already merged). Verify:
`packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/placement-engine.selftest.mts` → 79 cases green (+32 phase-2b);
`cd packages/bus && npx tsc --noEmit` → 0.

**Scope proof** (`git diff --name-status fa4f5ac..HEAD`): PURELY ADDITIVE to the pure core — `placement-engine.ts` gains `selectBackends` + its three types + a type-only `import type { Backend } from "./vm-ctl.js"`; `placement-engine.selftest.mts` gains 21 cases; design doc + this packet. Modifies NO existing logic (`classifyHealth`/`disposition`/`binPack`/`desiredCount`/`forkHealthGate`/`reconcile`/`placementEnabled` byte-identical). Changes NO runtime (`SWARM_PLACEMENT` default OFF). No new dependency. Resolves the phase-2a packet's deferred item (multi-backend + cost-aware bin-packing, CPA-budget-aware backend choice).

## What it is

The deferred cost layer BELOW reconcile. reconcile still emits a backend-AGNOSTIC `{spawn, n}` (unchanged); `selectBackends(want, options, budgetUsd)` turns that N into a cheapest-first per-backend plan, bounded by each backend's free capacity AND a budget. The engine DECIDES; the live caller still owns the real spend — an over-budget shortfall is routed to the user money gate (R16), never auto-spent. Composes with reconcile; the one-way vm-ctl seam is untouched; the Backend abstraction is vm-ctl's own (reused, not re-invented).

| Module | added | selftest | Purpose |
|---|---|---|---|
| `placement-engine.ts` | `selectBackends` + `BackendOption`/`BackendAllocation`/`BackendSelection` | +32 | cheapest-first, capacity+budget-bounded, deterministic, fail-closed |

## Invariant → where pinned (the review walk)

| Invariant | Implementation | Test |
|---|---|---|
| **money is integer micro-USD — never float** (PE2B-1 / "钱不走 float") | `costPerMachineMicroUsd`/`budgetMicroUsd`/`totalCostMicroUsd` integers; integer-only arithmetic | `exact budget — 35 fit, totalCost == budget`, `one µUSD short ⇒ 34`, `float cost option dropped` |
| budget contract holds EXACTLY: `totalCostMicroUsd <= budgetMicroUsd` (no epsilon) | integer `floor(budgetLeft/cost)` + integer accumulation | `totalCost never exceeds budget (exact)`, `allocation sum === totalCostMicroUsd` |
| cheapest-first (free tier before paid) | `selectBackends` sort + greedy | `cheapest-first — free railway before paid gha` |
| budget shortfall surfaces (→ R16 money gate) | `unfundedByBudget` | `budget bound — 7 unfundedByBudget` |
| capacity shortfall surfaces (no slots at any price) | `unplaceableByCapacity` | `capacity bound — 6 unplaceableByCapacity` |
| clean partition: funded + unfundedByBudget + unplaceableByCapacity === want | `selectBackends` return | `partitions()` asserted on every case incl. `mixed` |
| deterministic order, NO timestamp (FC-6) | sort cost→priority→name | `tie broken by priority then name`, `equal -> name asc` |
| **want is a non-negative safe integer or REJECTED** (PE2B-2, matches reconcile PE4 — no floor) | `!Number.isSafeInteger(want) ⇒ empty` | `non-integer want REJECTED (2.9 -> empty)`, `Infinity/beyond-safe -> empty` |
| **invalid `priority` dropped, never in the comparator** (PE2B-3, fail-closed) | `validOption`: `priority === undefined || isFinite` | `NaN priority dropped -> 'a' wins both orders`, `Infinity priority dropped` |
| duplicate backend deduped (no doubled capacity) | `seen` Set | `duplicate backend deduped` |
| fail-closed on bad input (never fabricate a spawn) | `want`/`budget`/option validation | `want 0/neg/NaN -> empty`, `invalid/non-integer budget -> only free`, `invalid option dropped` |
| free backend ignores budget (capacity-bound) | `cost <= 0 ⇒ affordable = remaining` | `free backend funds at budget 0` |

## Round-1 fixes (reviewer codex:Work 01a1208e, 3 P2 → resolved)

- **PE2B-1** (floor-quotient float overrun: 35×0.01 reported 0.35000000000000003 > 0.35): money is now **integer micro-USD** end to end (`costPerMachineMicroUsd`/`budgetMicroUsd`/`totalCostMicroUsd`), per the coordinator ruling "钱不走 float". The budget contract is now EXACT integer arithmetic — the reviewer's case funds the TRUE optimum 35 (350_000µ == 350_000µ budget), and one µUSD short funds exactly 34. No float, no epsilon.
- **PE2B-2** (2.9 floored to 2): `want` must be a non-negative safe integer or the plan is empty — no floor, aligned with reconcile's PE4 machine-count contract.
- **PE2B-3** (NaN priority bypassed the name tiebreak): `validOption` now rejects an option whose `priority` is present but non-finite, so NaN/Inf never reaches the comparator; a valid equal-cost-equal-priority pair still resolves by backend name, order-independently.

## Constant gates (self-checked before review)

- **FC-6 (latest-semantics forbids timestamps; use a monotonic order).** PASS — `selectBackends` has NO clock/timestamp; its order is cost→priority→backend-name, fully deterministic. reconcile is byte-unchanged (its only time input, `sinceLastActionSec`, is a DURATION for dwell, not a latest-wins stamp). No "latest wins" anywhere.
- **FC-7 (a store-format change must carry old-record import).** N/A — `selectBackends` is pure, reads no store, writes nothing, and changes no serialization format. No existing record shape is touched.

## Boundary (out of scope — do NOT chase)

- **IO not unit-tested** (convention): the live caller composes `reconcile → spawn.n → selectBackends → vm-ctl up --backend X`, and applies the R16 money gate on `unfundedByBudget`. The PURE selection IS tested.
- **No real spend here**: `selectBackends` decides within a budget; it never calls vm-ctl or spends. Over-budget machines are returned as `unfundedByBudget` for the user gate (R16; a peer relaying a request is not user consent).
- **Still dormant**: `SWARM_PLACEMENT` OFF; the engine→vm-ctl call-site is a wiring flip (phase-2a boundary, unchanged).

Counterexamples welcome against the cheapest-first greedy, the budget/capacity partition, the conservative floor, the deterministic tiebreak, and the fail-closed input handling. 0/0 to sign off.
