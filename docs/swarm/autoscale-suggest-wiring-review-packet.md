# review-seat autoscale suggestion-mode wiring — review packet

owner f32a0507 · 2026-10-09 · branch `feat/autoscale-suggest-wiring` off main `3732f4b` · reviewer codex:happycapy-01a0ff49

Scope: wire the signed T5-5 `review-seat-autoscale` into the dispatcher in SUGGESTION mode (advise, never act) + add the
missing ledger producer. The pure decision core (`scaleDecision` etc.) is unchanged and already signed (`8029fc4`).

Files (`git diff --stat 3732f4b..HEAD`):
- `packages/bus/src/swarm/review-seat-autoscale.ts` — +3 PURE helpers (`planAutoscaleSuggestion`, `instantaneousWant`,
  `buildSeatStatesFromLedger`). No change to the signed deciders.
- `packages/bus/src/swarm/review-seat-autoscale.selftest.mts` — +19 cases (now 68, all green).
- `scripts/swarm-dispatch.ts` — CONSUMER: import, `SCALE_CFG` env consts, `runReviewAutoscaleSuggest()` + cross-tick state,
  one call in the sweep tick.
- `scripts/review-ledger.ts` — NEW producer CLI (`open`/`done`).
- `docs/swarm/autoscale-suggest-wiring-v1.md` (contract) + this packet.

## What to grill

1. **Never acts** — the dispatcher path only ever calls `notifyCoordinator`; there is NO spawn/despawn anywhere. Confirm the
   suggestion text + taskRef `autoscale-suggest`; confirm `planAutoscaleSuggestion` returns the action for logging only.
2. **Dormant** — `autoscaleEnabled()` (SWARM_REVIEW_AUTOSCALE) gates the whole consumer; default OFF ⇒ the sweep step is a
   no-op. The producer CLI is a separate manual entry (no live caller).
3. **Phantom-depth guard** — a record whose author or seat does not resolve to a live session is excluded (`resolveSession`
   over `listSessions`); `filterLiveRecords` then drops dead/done before `queueDepth`.
4. **Fail-soft** — the ledger scan + inbox write run in an isolated async IIFE with `.catch(log)`; an empty/missing ledger,
   an unreadable record, or an inbox fault never breaks the sweep. Empty ledger ⇒ no suggestion + want reset.
5. **Debounce/throttle** — `instantaneousWant` continuity feeds `sustainedSec` (no advice on a transient spike); min-dwell via
   `sinceLastActionSec` paces re-suggestions; `notifyCoordinator` also dedups identical text.
6. **buildSeatStatesFromLedger** — Map-based (prototype-key seat names are plain keys); inFlight/completed/spawnedSec/idle/floor
   derivation; the documented `n`-undercount and idle-proxy boundaries (advisory, coordinator verifies).
7. **Producer CLI** — wraps the signed `markReviewOpen`/`markReviewDone`; validates ids (dotted/`done` rejected, exit 1);
   `AH_HOME` honored; a standalone script so F44 `isDispatcherLoopCommand` needs no change.

## Verification already run

review-seat-autoscale selftest 68/68 · bus tsc 0 · scripts tsc 0 · producer CLI smoke (open → `<t>.<s>.json`, done → rename to
`.done.json`, dotted id → exit 1) · full bus 85 files / 1124 tests pass. Not pushed, not merged (merge/enable gate =
coordinator + user).
