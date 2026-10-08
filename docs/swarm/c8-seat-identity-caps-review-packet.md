# C8 seat-identity-caps — review packet (S14, owner 90b58f9c)

Branch `feat/seat-identity-caps`, review range `c3439cd..HEAD` (merge-base with main = c3439cd). Verify: `npx tsx packages/bus/src/swarm/seat-caps.selftest.mts` → 20 cases green; `cd packages/bus && npx tsc --noEmit` → 0.

**Scope proof** (`git diff --name-status c3439cd..HEAD`): PURELY ADDITIVE — `seat-caps.{ts,selftest.mts}` + 3 docs (design, frozen contract `c8-seat-identity-v1.md`, this packet). Modifies NO existing file; changes NO runtime (both wiring points dormant, `SWARM_SEAT_CAPS` default OFF). No new dependency (node:crypto only).

## What it is

Closes F40 drift (coordinator-minted `mintedId`, not the CLI's drifting thread ID) + R16 relay laundering (an authorized action needs an HMAC `cap` the dispatcher signs; a relayed `user approved` carries none ⇒ fails verify). Generalizes the proven `mint.ts` HMAC pattern and ADDS the verify half.

| Module | lines | selftest | Purpose |
|---|---|---|---|
| `seat-caps.ts` | 144 | 20 | pure: `mintSeatId` / `mintIdToken` / `mintCapToken` / `verifyToken` / `mintedClaim` / `CapAct`; IO: `readDispatcherSecret` (unwired), `seatCapsEnabled` |

## Invariant → where pinned (the review walk)

| Invariant | Implementation | Test |
|---|---|---|
| R16: a token-less (relayed) call cannot authorize | `verifyToken` step-1 `no token` | `empty token -> reject`, `arbitrary string -> reject` |
| cap is act-scoped: a vm-spawn cap ≠ three-gate-proxy | `verifyToken` act match | `cap for vm-spawn does NOT authorize three-gate-proxy` |
| forgery: wrong secret / tampered sig rejected (constant-time) | `verifyToken` HMAC + `timingSafeEqual` | `wrong secret rejected`, `tampered signature rejected` |
| alg-downgrade blocked | `verifyToken` `alg==="HS256"` | `alg:none downgrade rejected` |
| `id`≠`cap` never cross | `verifyToken` iss match | `idToken verified as cap rejected` |
| sub binding (one token = one seat) | `verifyToken` sub match | `cap wrong sub rejected`, `idToken wrong sub rejected` |
| exp enforced + TTL clamped to MAX | `mintCapToken` clamp, `verifyToken` exp | `cap expired rejected`, `cap ttl clamped to MAX` |
| `mintedId` independent of any CLI ID | `mintSeatId` (injectable UUID) | `mintSeatId uses injected rand` |
| fusion seam = a hard claim from the mint event | `mintedClaim` | `mintedClaim is a hard claim` |

## Hard boundary (owner stance, frozen in the contract)

A `cap` proves DISPATCHER authorization, NOT user authorization. The three gates (money / external / irreversible) still require a genuine user gate BEFORE the dispatcher mints the matching cap; the cap is enforcement, not a user-gate bypass. A peer-relayed approval never substitutes for one. (Stated so the reviewer checks the design does not launder the user gate.)

## Boundary (out of scope — do NOT chase)

- **IO not unit-tested** (convention): `readDispatcherSecret`, and the two wiring points (issue @ spawn, verify @ execution) — both dormant (`SWARM_SEAT_CAPS` OFF). The PURE mint/verify IS tested.
- **v1 limits (frozen, honest)**: static HMAC, no online revocation (short exp + rotation); `nonce` signed but not replay-checked; cross-machine identity deferred (local envelope only); bus-identity fusion is a seam (`mintedClaim` shape), not yet wired into recordSelfObserve/announce.

Counterexamples welcome against the verify order, the anti-laundering property, the act/sub/iss scoping, and the alg-downgrade / forgery gates. 0/0 to sign off.

## SIGNED OFF — `1cee8d6` behavior (codex:Work, 0 REMAIN); N1 doc nit cleared @ `b3c2b13`

SC1-SC3 all CLOSED across 2 rounds (3852f90 -> 1cee8d6): SC1 frozen payload-shape validation after signature (never throws), SC2 verifier rejects empty secret, SC3 non-finite clock + non-positive TTL rejected. N1 (verify-step list order vs code + duplicate) cleared via S27 nit waiver (b3c2b13, no re-review). selftests 37, tsc 0, zh-lint 0. Sign-off bounds: pure mint/verify + write-guard static checks; IO / the two wiring points (issue @ spawn, verify @ execution) / bus-identity fusion remain dormant (SWARM_SEAT_CAPS off). Merge/enable = separate gate (coordinator + user) — NOT pushed/merged.
