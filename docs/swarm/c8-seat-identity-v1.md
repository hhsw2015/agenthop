# C8 seat-identity + capability credentials — frozen contract v1 (S14, owner 90b58f9c)

Closes F40 drift (self-reported ID) + R16 relay laundering at the code layer. Pure core `packages/bus/src/swarm/seat-caps.ts` (21 selftests, tsc 0). Generalizes the `mint.ts` HMAC pattern and adds the verify half. Design: `docs/swarm/c8-seat-identity-credentials-design.md` (coordinator-approved, no changes).

## Token formats (frozen)

Compact HS256 JWT, `base64url(header).base64url(payload).base64url(hmac)`, header `{"alg":"HS256","typ":"JWT"}`.

- **Identity credential** (`mintIdToken`): `{ iss:"id", sub:<mintedId>, iat, exp? }`. Proves the holder is the coordinator-minted `mintedId`. Issued in the spawn/birth-cert envelope; `exp` optional (omit = seat-lifetime, bounded by secret rotation).
- **Capability credential** (`mintCapToken`): `{ iss:"cap", sub:<mintedId>, act:<CapAct>, iat, exp, nonce? }`. Authorizes `sub` to perform `act` until `exp`. `exp = iat + min(ttlSec, MAX_CAP_TTL_SEC)`, `MAX_CAP_TTL_SEC = 3600`.
- `CapAct` (frozen enum): `vm-spawn | three-gate-proxy | board-admit | seat-spawn`.
- `mintedId` = `mintSeatId()` = a UUID minted by the coordinator/dispatcher — NEVER a CLI-reported thread ID.

## Verify algorithm (frozen — the one gate every execution point calls)

`verifyToken(token, { secret, iss, now?, sub?, act? })` → `{ok:true,claims} | {ok:false,reason}`. Checks IN ORDER:
1. token present + 3 dot-parts (missing/empty ⇒ `no token` — this IS the R16 anti-laundering: a relayed `user approved` carries no token).
2. header `alg === "HS256"` (blocks `alg:none` and algorithm-downgrade).
3. HMAC-SHA256 signature over `header.payload`, compared constant-time (`timingSafeEqual`).
4. `iss` matches the expected (`id` vs `cap` never cross).
5. not expired (`now < exp` when `exp` present).
6. optional `sub` match; optional `act` match (cap only — a `vm-spawn` cap does NOT authorize `three-gate-proxy`).

## Secret handling (frozen)

One dispatcher secret: `DISPATCHER_SECRET` env, else `~/.agenthop/dispatcher_secret` (`readDispatcherSecret`). Held ONLY by the dispatcher (issuer) + the execution-point verifiers. **NEVER injected into a node** — a node holds pre-signed tokens, never the secret (same discipline as `mint.ts` `readEphSecret` / CPA eph-token).

## Wiring points (BOTH dormant — `SWARM_SEAT_CAPS` default OFF, like SWARM_BOARD_ADMIT)

- **ISSUE** @ spawn: dispatcher runs `mintSeatId` + `mintIdToken` (+ per-action `mintCapToken`), puts `{mintedId, idToken}` in the birth-cert envelope. (Spawn integration = future flip.)
- **VERIFY** @ execution: `vm-ssh up` / three-gate-proxy / seat-spawn / board-admit call `verifyToken` before acting; fail ⇒ refuse. (Execution integration = future flip.)
- **FUSION** with bus-identity: `mintedClaim(mintedId)` = a HARD claim `form:"minted"`, provenance `mint`; bus-identity's `entityId` anchors it over the drift-prone thread ID; `legacyInboxKeys`/`resolveInboxTarget` keep their interfaces, native anchor becomes `mintedId` when present (self-derived `(run,generation)` key remains the fallback for un-minted standing members). Wiring into `recordSelfObserve`/announce = future flip; this module changes no existing runtime.

## Hard boundary (frozen — owner's standing stance, R16)

A `cap` proves **DISPATCHER authorization, NOT user authorization**. For the three gates (money / external-publish / irreversible) the dispatcher mints the matching cap ONLY AFTER a genuine user gate is satisfied. The cap is execution-layer enforcement; the user gate remains the issuance precondition. **A cap never bypasses the user; a peer-relayed approval never substitutes for one.**

## v1 limits (honest)

- Static HMAC, **no online revocation** (no CRL). Revocation = short `exp` + secret rotation.
- `nonce` is signed-in for uniqueness/audit but NOT checked against a replay store in v1 (short `exp` bounds replay).
- Cross-machine: the minted claim is a local envelope first (same boundary as bus-identity round-2 — the relay network frame is unchanged); cross-machine identity is deferred.
- Not wired: no production issue/verify caller yet (dormant). Enabling + the spawn/execution integration + the bus-identity fusion are separate flips.
