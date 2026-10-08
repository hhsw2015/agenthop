# Review packet — fanout-native phase-1 (sovereign self-built backend)

- **Branch** `feat/fanout-native`  **HEAD** `e9a51f2`  **Base** `c3439cd`
- **Reviewer** codex `01a0ead5` (cross-family, independent)  **Author** bus-pen `d7f6c917`
- **Design** `docs/swarm/fanout-native-design.md` + **pre-study** `docs/swarm/fanout-prestudy.md`

## What this is
Phase-1 of fan-out nativization: the SOVEREIGN self-built backend a long-lived member wields as a stateless sub-tool. A pure governance core + a thin IO driver that composes the AS-IS spawn stack. The member posts a `fanout` request; the driver runs the units through a concurrency-leased pool at the chosen display mode, enforces the width guardrail + budget breaker, keeps a run ledger, reduces to one exactly-once aggregate, and reaps only the zone it opened. DORMANT behind `SWARM_FANOUT` (default off).

## Boundaries (what this batch does NOT do)
1. Dormant: `SWARM_FANOUT` defaults off; the driver exits early when unset; nothing runs live.
2. Additive only: it modifies NO existing component. `spawn.ts`, `herdr.ts`, control-log, `model-tier.ts` are imported AS-IS, untouched (per the approved reuse list).
3. No merge/push/deploy. No native backend — the claude-`Workflow` adapter is phase-2 (or cut); self-built is the default and carries the full load.
4. Scope seams: the headless harvest (pid-exit + `outputFile`) is complete; the temp-workspace VISIBLE pane-harvest is the documented live-run refinement (panes spawn into the zone + share the ledger). Tier→model is env/CPA in phase-1; the `model-tiers.json` wiring is phase-2.

## Design decisions
- Pure governance core (`fanout.ts`) has NO IO — all guardrail/tier/display/reduce/receipt/sweep/zone decisions are pure functions, selftested. The driver is thin glue over the real `spawnAgent`.
- The sovereign pool is the default; a native backend is an opt-in accelerator (design §2), never a dependency.
- Governance is backend-agnostic: width guardrail, tiered dispatch, ledger, budget breaker, aggregate-to-ledger apply regardless of display mode.

## Files + tests
| Module | ~lines | Tests | Purpose |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/fanout.ts` | ~255 | 60 | pure governance core (schema/width/tier/display/reduce/receipt/budget/sweep/zone/depth) |
| `packages/bus/src/swarm/fanout.selftest.mts` | ~150 | 60 | one named counterexample per pre-study pit; run via `npx tsx` |
| `scripts/swarm-fanout.ts` | ~155 | live | self-built backend driver: pool, display routing, timeout despawn, orphan sweep, ledger, cleanup |

## Gates
- bus tsc 0; scripts tsc 0; fanout selftest 60/60; bus vitest 991/991 (unchanged — additive files).

## Counterexamples the selftest locks (one per pre-study pit)
- Pit 2.1 retry-storm/double-spend: a `delivery_uncertain` unit is quarantined as an error, never respawned.
- Pit 2.2 silent-overwrite: validation rejects a duplicate unit key.
- Pit 2.3 aggregation-race/double-deliver: no deliver until ALL units terminal; no re-deliver after accepted; re-arm after an unacked deliver.
- Pit 2.4 recursion-bomb + orphan: `admitDepth` refuses at the cap; `reconcileOrphans` turns a running row with a dead pid into timeout, leaves a live-pid / no-pid / terminal row unchanged (immutably).
- Pit 2.5 unbounded-spend: `budgetExceeded` fires at the token/USD ceiling; no cap never fires.
- Pit 2.6 reap-others (F42): `canReapZone` admits only an owned `fanout-<runKey>` zone, refuses a foreign fanout zone and `w1`.
- Plus: width guardrail (allow <=8 / ROI 9-32 / ticket over 32), class→tier (cheap/mid/top), explicit-tier override, display-mode degradation (herdr-unreachable or over-16 → headless), reduce tolerates holes, progress line, ledger-row construction.

## Open self-flags (reviewer please rule)
- `harvestStatus` settles a headless unit on pid-exit + non-empty `outputFile`; a pid-gone + empty output still settles as done (empty yield). Reviewer: confirm this is the right at-most-once settle, not a false-done.
- `widthGate` reads `FANOUT_ROI` / `FANOUT_TICKET` from env for the ROI/ticket tiers in phase-1 (a request-carried field is phase-2).
- Tier→model defaults (`claude-haiku-5-5` / `-sonnet-5-5` / `-opus-5-5`) are env-overridable; `model-tiers.json` integration is deferred to phase-2.
