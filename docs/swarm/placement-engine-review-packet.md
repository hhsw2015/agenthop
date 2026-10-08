# placement-engine phase-2a — review packet (S14, owner 90b58f9c)

Branch `feat/placement-engine`, review range `c3439cd..HEAD` (merge-base with main = c3439cd). Verify: `npx tsx packages/bus/src/swarm/placement-engine.selftest.mts` → 27 cases green; `cd packages/bus && npx tsc --noEmit` → 0.

**Scope proof** (`git diff --name-status c3439cd..HEAD`): PURELY ADDITIVE — `placement-engine.{ts,selftest.mts}` + design doc + this packet. Modifies NO existing file; changes NO runtime (`SWARM_PLACEMENT` default OFF). No new dependency. Design coordinator-approved, no changes (`docs/swarm/placement-engine-design.md`).

## What it is

The UPPER layer of vm-ctl's two-layer architecture (phase-2a, single-backend scope): a K8s-controller-style reconcile that converges actual machines → a declarative desired state, calling the vm-ctl command family (one-way; vm-ctl is unaware).

| Module | lines | selftest | Purpose |
|---|---|---|---|
| `placement-engine.ts` | ~130 | 27 | pure: `classifyHealth`/`disposition` (liveness≠readiness), `binPack` (no oversubscribe), `desiredCount` (two consumers), `forkHealthGate` (Betabrand), `reconcile` (level-triggered heal + dwell-gated scale); IO: `placementEnabled` (dormant) |

## Invariant → where pinned (the review walk)

| Invariant | Implementation | Test |
|---|---|---|
| liveness ≠ readiness; dead-rebuild / booting-wait(not-kill) / ready-feed | `classifyHealth` / `disposition` | `non-live even if ready flag`, `booting->wait (not kill)` |
| bin-pack never oversubscribes; shortfall surfaces | `binPack` | `fills to capacity`, `shortfall = unplaceable` |
| desired = max(board/cap, fanout) — two consumers | `desiredCount` | `from board`, `from fanout`, `max of the two` |
| **Betabrand**: fork ONLY from a verified-healthy template (fail-closed) | `forkHealthGate` | `unverified -> REFUSE`, `null -> REFUSE` |
| heal is URGENT/ungated: dead → reclaim (spawn replaces) | `reconcile` heal block | `non-live -> reclaim`, `heal ungated by dwell` |
| expiring live → snapshot+rebuild before self-destruct | `reconcile` | `expiring -> rebuild` |
| scale is dwell-gated + hysteretic; surplus reclaim only idle+empty+non-floor | `reconcile` scale block | `surplus idle -> reclaim`, `busy -> NOT`, `floor never reclaimed`, `min-dwell holds scale` |
| level-triggered + idempotent (same in → same out, replay-safe) | `reconcile` | `idempotent (same in -> same out)` |

## Boundary (out of scope — do NOT chase)

- **IO not unit-tested** (convention): the live reconcile loop (read presence → decide → call vm-ctl), vm-ctl exec. The PURE decisions ARE tested.
- **phase-2a scope**: single-backend (Railway Free) reconcile. **phase-2b** (multi-backend + cost-aware bin-packing, CPA-budget-aware backend choice) is deferred.
- **Not wired**: `SWARM_PLACEMENT` OFF; the engine→vm-ctl call-site and presence-read are wiring flips. Budget gate (over-budget spawn = user money gate, R16) is applied by the live caller. The engine holds desired state; vm-ctl stays unaware (one-way seam).

Counterexamples welcome against the reconcile heal/scale split, the hysteresis/dwell gates, the two-consumer desired-count, and the Betabrand fork gate. 0/0 to sign off.
