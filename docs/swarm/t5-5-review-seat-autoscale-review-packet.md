# T5-5 review-seat-autoscale — review packet (S14, owner 90b58f9c)

Branch `feat/review-seat-autoscale`, review range `c3439cd..cfa15fc` (merge-base with main = c3439cd). Verify: `npx tsx packages/bus/src/swarm/review-seat-autoscale.selftest.mts` → 39 cases green; `cd packages/bus && npx tsc --noEmit` → 0.

**Scope proof** (`git diff --name-status c3439cd..cfa15fc`): PURELY ADDITIVE — `review-seat-autoscale.{ts,selftest.mts}` + the design doc. Modifies NO existing file; touches NO dispatcher/launcher/control path. No new dependency. Design was coordinator-approved with two amendments (both implemented, see below).

## What it is

Scales the adversarial-review seat pool to queue depth (DHH baseline audit #5: reviewer seat = the real bottleneck; review is un-self-reviewable so cost is O(N) and incompressible — make "reviewers = agents = scale" practice-true).

| Module | lines | selftest | Purpose |
|---|---|---|---|
| `review-seat-autoscale.ts` | 223 | 39 | pure: queue-depth, scale decision (hysteresis+sustain+dwell+floor), seat selection ①, first-ticket band ②, birth cert, ledger parser; IO: dormant-gated ledger |

## Invariant → where pinned (the review walk)

| Invariant | Implementation | Test |
|---|---|---|
| phantom-depth guard: a dead author/seat's record never counts (two faces) | `filterLiveRecords` | `live filter drops dead author/seat/done` |
| **amendment ①**: reclaim ONLY an idle, in-flight=0, non-floor seat — never mid-review | `selectSeatToReclaim` | `NEVER a busy/non-idle/dead/floor seat`, `all busy -> null (wait)` |
| amendment ① tiebreak: newest among eligible (seniority preserved) | `selectSeatToReclaim` reduce | `reclaim newest among eligible` |
| **amendment ②**: a fresh seat (0 history) first ticket ≤P2 or small; P0/P1 blocked | `canRouteToSeat` | `fresh seat blocks P0/P1`, `allows P2/P3/small`, `experienced takes P0` |
| hysteresis: kUp>kDown band ⇒ no flap | `scaleDecision` wantUp/wantDown | `hysteresis band -> hold (no flap)` |
| debounce: not-sustained ⇒ hold; min-dwell between actions | `scaleDecision` | `hold when deep but NOT sustained`, `min-dwell not elapsed` |
| floor=2 never breached | `scaleDecision` `n > floor` | `hold at floor` |
| scale-down waits when no eligible seat | `scaleDecision` + `selectSeatToReclaim` | `down but no eligible seat -> hold+wait` |
| birth cert = reviewer/codex/heavy | `buildReviewSeatBirthCert` | `birth cert reviewer/codex/heavy` |

## Boundary (out of scope — do NOT chase)

- **IO is not unit-tested** (same convention as herdr.ts/remote-recycle.ts): ledger read/write, markOpen/markDone, and the live scaler loop (gather presence → decide → spawn/despawn). The PURE decision + parsers ARE tested.
- **Not wired live**: no production caller spawns/despawns yet — gated by `SWARM_REVIEW_AUTOSCALE` (default OFF, dormant-ahead-of-use). Enabling + the capacity-manager spawn/despawn integration is a separate flip, like SWARM_BOARD_ADMIT. Budget gate (over-budget spawn = a money gate → user, R16) is applied by the live caller.
- presence/idle + the actual spawn primitive are injected (SeatState) — the pure core does not read them itself.

Counterexamples welcome against the scale truth table, the amendment-① eligibility, the amendment-② band, and the hysteresis/debounce gates. 0/0 to sign off.

## SIGNED OFF — `8029fc4` (codex:happycapy, 0 REMAIN)

All three P2 CLOSED across cfa15fc → fea133f → 8029fc4 (3 rounds): P2-1 absent-priority fail-closed, P2-2 null-prototype per-seat counts, P2-3 round-trippable ids (validated in parser + both write entries). selftests 51/51, tsc 0, 17/17 reviewer probes. Sign-off bounds: pure core + parsers + write-guard static checks; live wiring / real seat spawn-despawn / budget gate belong to the future caller; autoscale NOT enabled (SWARM_REVIEW_AUTOSCALE dormant). Merge/install/enable remain separate approval gates (coordinator + user) — NOT pushed/merged.
