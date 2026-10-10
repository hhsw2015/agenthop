# placement wiring (suggestion mode) — review packet (S14, owner 90b58f9c)

Branch `feat/placement-wiring`, STACKED on `feat/placement-phase2b @1b1f763` (baseline for THIS review = 1b1f763; batch-10 merges the stack together). Verify:
`packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/placement-engine.selftest.mts` → 113 cases green;
`cd packages/bus && npx tsc --noEmit` → 0; scripts `tsc -p scripts/tsconfig.json --noEmit` → 0.

**Scope** (`git diff --name-status 1b1f763..HEAD`): `placement-engine.ts` gains the wiring (pure `loadPlacementSpec` / `buildPlacementSuggestion` / `planPlacementSuggest` + IO `readPlacementSpec` / `readLedgerMachines`); `placement-engine.selftest.mts` +34; `scripts/swarm-dispatch.ts` gains `runPlacementSuggest()` + its sweep call + one import; design-doc section + this packet. phase-2b's `selectBackends`/`reconcile`/the 8 earlier exports are byte-unchanged. `SWARM_PLACEMENT` default OFF (unchanged) — ZERO runtime change until enabled.

## What it is

The deferred wiring: reconcile → selectBackends → a **coordinator advisory**, SUGGESTION MODE (the autoscale-suggest ruling) — the engine ADVISES, it never spawns/reclaims/spends (real VM ops + budget are the user money gate, R16).

- **Desired** = a read-only declarative spec `<home>/.agenthop/placement/spec.json` (`{demand, cfg, backends[int µUSD], budgetMicroUsd}`), validated+rebuilt by `loadPlacementSpec` (fail-closed). **Actual** machines = `readLedgerMachines` — a labeled SEAM returning `[]` until the vm-ctl ledger lands (so the advisory recommends the full demand plan today).
- `planPlacementSuggest(spec, machines, sinceLast)` (pure, end-to-end tested) = reconcile → selectBackends on the spawn shortfall → `buildPlacementSuggestion`, which reports the three spawn faces distinctly: FUNDED per-backend plan, `unfundedByBudget` (→ R16 user money gate), `unplaceableByCapacity` (capacity gap); reclaim/rebuild advised, never executed; a pure hold ⇒ no content.
- `runPlacementSuggest()` (dispatcher sweep tick, gauge-sampling/autoscale style): gated on `placementEnabled()` (OFF), single-flight, reads the spec (none ⇒ silent), runs the pure chain, and `notifyCoordinator(text, {taskRef:"placement-suggest"})` (reusing the signed S19 delivery; only a real "delivered" advances the min-dwell slot). Fully fail-soft.

## Invariant → where pinned

| Invariant | Implementation | Test |
|---|---|---|
| never auto-acts (advise only; R16) | `runPlacementSuggest` calls `notifyCoordinator` only; no vm-ctl call | `SUGGESTION MODE banner always present`, `reclaim + rebuild advised (never executed)` |
| three spawn faces reported distinctly | `buildPlacementSuggestion` | `funded plan`, `over-budget -> R16 line`, `capacity gap -> shortfall line` |
| full chain correct | `planPlacementSuggest` | `funded 10 ($7)`, `funded 8 + 2 need gate ($5)`, `6 capacity gap`, `zero demand -> hold` |
| spec fail-closed (bad desired-state never advises) | `loadPlacementSpec` validate+rebuild | `float cost/NaN priority/float budget/negative -> reject`, `extra keys dropped` |
| money integer µUSD (phase-2b carried) | spec cost/budget safe-integer | `FLOAT cost in backend -> reject` |
| **notice dwell is a SEPARATE clock from reconcile's action dwell** (PW-1) | `shouldSuggestPlacement` (wiring) + `planPlacementSuggest` runs reconcile with dwell SATISFIED ⇒ always the FULL plan, never the urgent-floor subset | `PW-1: full demand advised regardless of floor/minDwell`, `PW-1 pinned: delivers ONLY at t=1000 & t=1300`, `zero-floor control same cadence` |
| only a real "delivered" advances the notice window (failed/unreported retries) | sweep advances `lastPlacementSuggestSec` only on `"delivered"` | `PW-1 pinned` simulation (last advances on delivery only) |
| dormant + fail-soft | `placementEnabled` gate, try/catch in sweep | (IO boundary — convention, not unit-tested) |

## Constant gates (self-checked)

- **FC-6** PASS — no timestamp decides anything; the sweep uses a dwell DURATION (`nowSec - lastPlacementSuggestSec`); the pure fns are timestamp-free; order is phase-2b's cost→priority→name.
- **FC-7** N/A — `spec.json` is a brand-new READ-ONLY input format (no prior records to import); the engine writes no store/serialization format; the S19 advisory reuses the existing `writeInbox`.

## Boundary (out of scope)

- **IO not unit-tested** (convention): `readPlacementSpec`/`readLedgerMachines` file IO, the sweep tick, `notifyCoordinator` delivery. The PURE chain IS tested end-to-end.
- **`readLedgerMachines` returns [] (seam)**: no vm-ctl ledger is merged; this is the single place the real ledger read plugs in later. Until then the advisory recommends the full demand (correct for suggestion mode).
- **No spend / no VM ops / no auto-scale**: suggestion only; `unfundedByBudget` is handed to the user money gate (R16). `SWARM_PLACEMENT` OFF.

0/0 to sign off.


## Round-1 fix (reviewer codex:Work 01a1208e, 1 P2 → resolved)

- **PW-1** (notice dwell conflated with reconcile's action dwell — the signed urgent-FLOOR subset re-fired every notice-dedup window and reset `lastPlacementSuggestSec`, perpetually postponing the full-demand advisory): the two clocks are now separate.
  - `planPlacementSuggest` runs reconcile with its action-dwell SATISFIED (passes `minDwellSec` as the since-last), so suggestion mode always advises the **FULL** desired plan — the urgent-floor subset (which only exists inside an unexpired action dwell) never appears. reconcile's signed heal/urgent semantics are untouched.
  - A new pure `shouldSuggestPlacement(now, last, minDwellSec)` is the wiring's OWN notice throttle; `runPlacementSuggest` advances `lastPlacementSuggestSec` only on a real `"delivered"`.
  - The reviewer's counterexample is PINNED: the positive-floor timeline now delivers ONLY at t=1000 and t=1300 (every delivery the full demand funded 3 / gate 7, never the floor subset 2 / 0), identical to the zero-floor control.