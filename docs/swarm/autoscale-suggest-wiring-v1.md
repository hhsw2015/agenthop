---
contract: review-seat-autoscale-suggest-wiring
version: 1
status: proposed
authority: backend owner f32a0507
last_updated: 2026-10-09
---

# review-seat autoscale — suggestion-mode wiring v1

Coordinator dispatch (feat/autoscale-suggest-wiring off main `3732f4b`). The T5-5 `review-seat-autoscale` pure core + ledger IO
is signed (`8029fc4`) but sat at a ZERO-consumption point in the dispatcher — flipping its flag did nothing. User ruling
(2026-10-08): the flag is **half-flipped** = SUGGESTION mode. The dispatcher now reads the review-queue ledger and ADVISES the
coordinator on seat scaling; it **never spawns or reclaims a seat** (that stays the coordinator's call — the spawn money gate
is R16, the user's). Master switch `SWARM_REVIEW_AUTOSCALE` stays **default OFF** (dormant-ahead-of-use, like SWARM_BOARD_ADMIT).

## Consumer — the suggestion step (`scripts/swarm-dispatch.ts`, sweep tick)

Each sweep tick, when `autoscaleEnabled()` and no read is already in flight (single-flight, AS-P2-4):
1. `readReviewLedger(reviewQueueDir(HOME))` — the durable review-queue records.
2. Phantom-depth guard (AS-P2-1 + AS-P2-2) via `canonicalizeLiveRecords`: `resolveLive(id)` resolves an identity to its
   CANONICAL native sid AND confirms the process is actually ALIVE — `makeFileLiveness` `kill(0)`, ESRCH ⇒ dead (a pid file
   alone is not life). Aliases of one seat collapse to one canonical id (capacity never inflated by an alias); all ticket work
   is kept.
3. `buildSeatStatesFromLedger(canon.records, canon.liveSeats, …)` → `filterLiveRecords` → `queueDepth` → `instantaneousWant`
   (tracked across ticks for the sustain window) → `planAutoscaleSuggestion`.
4. A non-null suggestion is delivered via `notifyCoordinator(text, { taskRef: "autoscale-suggest", title: "autoscale" })` —
   an **S11** durable-inbox message (`{via, taskRef, title, text}`, team-collab-design §133).

Cross-tick state: `autoscaleReadInFlight` (single-flight), the raw want's continuity (→ `sustainedSec`, debounces a transient
spike), and the last-DELIVERED time (→ `sinceLastActionSec`). The cooldown advances **only on a real `"delivered"`** (AS-P2-3):
a log-only (coordinator unresolved) or deduped result is not a successful report, so a still-standing suggestion re-delivers
once the coordinator is reachable — and `notifyCoordinator` no longer records dedup on its log-only path, so the recovery
delivery is not suppressed. Fully fail-soft: the ledger scan + inbox write are isolated and never break the sweep.

`SCALE_CFG` is TUNABLE via env (defaults): `SWARM_REVIEW_KUP`=2, `SWARM_REVIEW_KDOWN`=1 (kUp>kDown ⇒ hysteresis),
`SWARM_REVIEW_FLOOR`=2, `SWARM_REVIEW_SUSTAIN_SEC`=60, `SWARM_REVIEW_MIN_DWELL_SEC`=300.

## Producer — the ledger write point (`scripts/review-ledger.ts`)

The ledger had **no producer** (the signed `markReviewOpen`/`markReviewDone` had only the selftest as a caller). The minimal
"各一行" write point the adversarial-review dispatch workflow runs:

- `node <tsx> scripts/review-ledger.ts open <ticket> <seat> [author] [sha]` at 派单 → `markReviewOpen`.
- `node <tsx> scripts/review-ledger.ts done <ticket> <seat>` at 交付 → `markReviewDone` (atomic rename → `.done`).

It wraps the SIGNED ledger primitives (which validate ids + write atomically); a bad id fails loud (exit 1). A standalone CLI
(not a `swarm-dispatch.ts` one-shot mode) so F44's `isDispatcherLoopCommand` one-shot set needs no change.

**`author` is optional syntax but REQUIRED to count** (AS-N1): the consumer counts an open record only when BOTH its seat AND
its author resolve to a live session. An empty/unresolvable author ⇒ the record is written (audit) but excluded from the
queue-depth signal. Pass the submitting session's native sid. Full counting example:
`review-ledger.ts open feat-autoscale <reviewer-sid> <author-sid> <sha>` then `review-ledger.ts done feat-autoscale <reviewer-sid>`.

## New pure helpers (`review-seat-autoscale.ts`, selftested)

- `planAutoscaleSuggestion(input) → { action, text } | null` — composes filter→depth→`scaleDecision`→render; null on hold.
  **Never acts** (the action is returned only so a caller can log/key on it).
- `instantaneousWant(signal, seats, cfg) → "up"|"down"|"none"` — the raw want before the sustain/dwell gates (for cross-tick
  continuity tracking); mirrors `scaleDecision`'s guards exactly.
- `buildSeatStatesFromLedger(records, liveSeats, cfg, now) → SeatState[]` — derive seat states for suggestion mode from the
  ledger + presence (Map-based, so a seat named `toString`/`__proto__` is a plain key).

## KNOWN BOUNDARIES (seam, advisory)

- **n undercounts**: only seats that appear in the ledger are built, so a live reviewer seat that has never held a review is
  not counted — biasing the signal toward a scale-UP suggestion. Acceptable: the output is advisory and the coordinator
  confirms the real seat count.
- **idle is a ledger proxy**: `idle = inFlight === 0` (a seat with no open review record). The coordinator verifies true idle
  before acting on a reclaim suggestion.
- **DAG task-exec is NOT the producer**: its workers are ephemeral VM boxes (`launchId`), not reviewer-seat bus sessions, so
  their `seat` would never resolve live and `filterLiveRecords` would drop them. The review-queue tracks the adversarial-review
  seat flow (bus sessions), populated by the producer CLI above.
- Suggestion-only; no spawn/despawn; `SWARM_REVIEW_AUTOSCALE` default OFF. Verification/enable + merge remain coordinator+user.
