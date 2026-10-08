# remote-herdr-view — whole-ticket review packet (S14, owner 90b58f9c)

Branch `feat/remote-herdr-view`, review range `c3439cd..4676b00` (merge-base with main = c3439cd). Verify: `npx tsx packages/bus/src/swarm/remote-{capacity,recycle,bootstrap}.selftest.mts` → 11 / 45 / 24 cases green (80 total); `cd packages/bus && npx tsc --noEmit` → 0.

**Scope proof** (`git diff --name-status c3439cd..4676b00`): PURELY ADDITIVE — adds only `docs/research/remote-*` + `packages/bus/src/swarm/remote-{capacity,recycle,bootstrap}.{ts,selftest.mts}`. Modifies NO existing file; touches NO dispatcher/launcher/herdr.ts/control path. No new dependency.

## Modules

| Module | lines | selftest | Purpose |
|---|---|---|---|
| `remote-capacity.ts` | 61 | 11 | `agentCapacity = max(1, min(cores-1, floor(memGB/4)))`; probe parsers (explicit unit, not header-sniffed) |
| `remote-recycle.ts` | 236 | 45 | ② recycle verdict (two evidence faces, fail-closed) + ephemeral-gated dry-run-default IO sweep |
| `remote-bootstrap.ts` | 150 | 24 | ③ bootstrap-script + capacity-metadata builders + ephemeral-linkage ledger (producer for ②'s `ephemeralLabels`) |

## Key invariants → where pinned (the review walk)

| Invariant | Implementation | Test |
|---|---|---|
| recycled requires BOTH faces gone (unreachable AND absent from `vm-ssh ls`) | `recycleVerdict` | full 3×3 truth table |
| any missing/ambiguous face ⇒ keep (CORE law 4: 单信号不定罪; suspected≠dead) | `recycleVerdict` null branches | `reachable=false,listed=null -> unknown` etc. |
| never remove a reachable box (even if not in `vm-ssh ls`) | `machineReachable===true ⇒ live` | `reachable=true,listed=false -> live` |
| `parseReachable` false-patterns BEFORE true (`unreachable`⊃`reachable`) | `parseReachable` ordering | `'unreachable' -> false (NOT true)` |
| sweep fail-closed when `vm-ssh ls` unavailable | `vmIds===null ⇒ every verdict unknown` | (IO; argued, not unit — see boundary) |
| sweep never touches a non-ephemeral machine | `filter(ephemeralLabels.has)` | (IO; gated by linkage ledger) |
| linkage updates immutable (coding-style) | `addLinkage`/`removeLinkage` spread | `add second -> base UNCHANGED` |
| ②↔③ seam | `linkageLabels(readLinkage())` → `sweepRecycled({ephemeralLabels})` | `seam: labels is a Set…` |
| capacity metadata CLI shape | `buildCapacityMetadataArgs` | `capacity meta args exact` |

## Boundary (deliberately out of scope — do NOT chase)

- **IO shells are not unit-tested** (same convention as herdr.ts): `sweepRecycled`, `writeCapacityMetadata`, `readLinkage/writeLinkage`, `writeMetadata`. The PURE verdict/parsers/builders they call ARE tested.
- **Live-acceptance riders (need an authorized VM; no-spend now):** ② real recycle (confirm `parseReachable` wording + end-to-end remove+close); ③ real `vm-ssh up --init`→`machine add`→`report-metadata`.
- **④ source audit is BEHAVIORAL, line-level BLOCKED:** local herdr source is 0.7.1; `machine` feature is 0.9.x (absent). Credential-persistence question flagged, not claimed resolved.
- `act` defaults false (dormant-ahead-of-use); enabling it is the single future flip.

## Honesty notes (pre-empting the adversarial pass)

- `parseReachable` keyword set is UNVERIFIED against a live reachable machine (offline, no VM). Fail-closed makes a wrong guess safe: it keeps, never wrongly removes. Stated in-code + design §②.
- ① link-up + capacity were ALREADY proven live on an authorized Railway VM (evidence/01-live-proof.md); ②③④ are the code this review covers, with the live riders above.

Counterexamples welcome against the verdict truth table, the `parseReachable` ordering, the linkage immutability, and the fail-closed claims. 0/0 to sign off.


## Round 2 — codex:Work RH1–RH6 fixed (one pass, S27)

All six were fail-OPEN bugs (a false/absent signal could wrongly remove a machine/workspace). Each is now fail-CLOSED and pinned by a regression test named `RHn`.

| # | Pri | Fix | Pinned test |
|---|---|---|---|
| RH1 | P1 | `parseReachable`: false ONLY on explicit unreachable; execution-failure / `last_error:null` / contradictory / unrecognized ⇒ null; structured `reachable` flag wins; dropped bare `error`/`failed` tokens | `RH1: 'permission denied' -> null`, `reachable JSON with last_error:null -> true`, `contradictory -> null` |
| RH2 | P1 | `parseVmSshIds`: ANY malformed element ⇒ null (no partial "absent" set); legit `[]` ⇒ empty set | `RH2: [null,{}] -> null`, `valid+missing-id -> null`, `legit [] -> empty` |
| RH3 | P1 | sweep matches the registered `vmId` (not the label); `sweepRecycled` now takes the `ephemeral` linkage map | `seam: entry carries vmId (RH3)` + sweep uses `ephemeral[label].vmId` |
| RH4 | P1 | `parseLinkage` validates EACH entry (`isLinkageEntry`); invalid body grants no cleanup authority | `RH4: {permanent-main:null} -> dropped`, `valid+invalid -> only valid` |
| RH5 | P2 | `workspaceIdForLabel`: require `Array.isArray` + UNIQUE match, else null (no throw on `{}`, no close on ambiguity) | `RH5: workspaces:{} -> null`, `two same-label -> null`, `unique still returns` |
| RH6 | P2 | bootstrap downloads to a temp file then runs (`curl -o … && sh …`) — never pipes into a shell, so a failed download exits non-zero | `RH6: no \`| sh\` pipe`, `downloads to temp then runs` |

Unchanged: the verdict truth table, immutability, dry-run/dormant defaults, the live-acceptance + ④-source-blocked boundary. New counts: recycle 32→45, bootstrap 16→24 (the added RHn regressions). tsc 0. 0/0 to sign off.
