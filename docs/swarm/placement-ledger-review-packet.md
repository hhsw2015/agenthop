# placement ledger seam → real read — review packet (S14, owner 90b58f9c, r4)

Branch `feat/placement-ledger` off main `@8b1892c`. Verify:
`packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/placement-engine.selftest.mts` → 132 cases green;
`cd packages/bus && npx tsc --noEmit` → 0; scripts `tsc -p scripts/tsconfig.json --noEmit` → 0.

**Scope** (`git diff --name-status 8b1892c..HEAD`): `placement-engine.ts` — `readLedgerMachines` reads the vm-ssh META STORE directly (+ pure `fleetFromMetas` / `vmIdToView` + `FleetRead`); `placement-engine.selftest.mts` +19; `scripts/swarm-dispatch.ts` — `runPlacementSuggest` awaits the async read + consumes the three-state. Placement pure core (reconcile/selectBackends/the 14 earlier exports) byte-unchanged; still advise-only; `SWARM_PLACEMENT` default OFF.

## Trail (r1 → r2 → r3)

- r1 read `herdr machine list` → mapped `enabled`→health (WRONG: a registration toggle).
- r2 read `vm-ssh ls --json` → but the reviewer's real-producer run showed `vm-ssh ls` enumerates LOCAL meta incl. `phase:"reserved"` (not provisioned) and `allIds()` swallows readdir errors into `[]` exit-0 — so it proves neither provisioning (PL-1) nor read-success (PL-2). PL-3 (async) CLOSED and kept.
- r3: read the vm-ssh META STORE directly, filter by `phase:"ready"`; dir-read error seen (PL-2 CLOSED), async (PL-3 CLOSED).
- r4 (coordinator direction — "mirror the producer semantics COMPLETELY"): the `phase:"ready"`-only filter missed two vm-ssh capacity semantics — an EXPIRED railway `ready` record still counted (over-count), and a LEGACY record (no phase/backend) was excluded (under-count). r4 mirrors both.

## What it is

- **PL-1 (state face, not registration/reservation):** `readLedgerMachines` reads `<VM_SSH_DIR | ~/.vm-ssh>/*.meta.json` (mirrors vm-ssh.ts `addrDir()`/`Meta.phase`). A machine is counted LIVE **only** when `phase === "ready"` — the state vm-ssh sets (via `commitReadyIfOwner`) AFTER the address is captured, i.e. the backend confirmed the VM exists. `reserved`/`requesting`/`running` are in-flight/unproven and EXCLUDED (never counted as capacity). Over-advising spawn is safe (the money gate is the user's). `vmIdToView`: readiness/idle/in-flight have no evidence face ⇒ UNASSERTED (`ready=false` ⇒ never a surplus-reclaim candidate even at `reclaimIdleSec=0`; `remainingSec=null` ⇒ never "expiring") ⇒ the advisory is strictly SPAWN-ONLY; reconcile never advises reclaim/rebuild from health the ledger does not prove.
- **PL-2 (dir-read error propagates as unknown):** reading the dir ourselves, a dir-read failure is SEEN, not swallowed. `readdir` ENOENT ⇒ `empty` (dir absent = no VMs); any other errno (EACCES/ENOTDIR/…) ⇒ `unknown` (the caller skips the tick, never fabricating empty/capacity). A genuinely-empty dir ⇒ `empty`. A single garbled `.meta.json` ⇒ that record is skipped (the DIR read still succeeded — not a set-level error). `fleetFromMetas(null)` is the pure "dir unreadable ⇒ unknown".
- **PL-3 (async, CLOSED, kept):** `readLedgerMachines` is async (`fs/promises`), never a blocking subprocess; `runPlacementSuggest` awaits it inside its single-flight detached worker.

## Invariant → where pinned

| Invariant | Implementation | Test |
|---|---|---|
| PL-1: only `phase:"ready"` (backend-confirmed) is live; reserved/requesting/running excluded | `fleetFromMetas` | `reserved -> empty`, `requesting/running -> empty`, `mixed -> only ready counts` |
| PL-1: reserved no longer suppresses the suggestion | `fleetFromMetas([reserved]) -> empty` | `reserved-only + demand 1 -> full demand` |
| PL-1: readiness unasserted ⇒ never reclaim (even reclaimIdleSec=0) | `vmIdToView` ready=false | `reclaimIdleSec=0 + demand 0 -> NO reclaim`, `5 live > 2 want -> no reclaim` |
| r4 PL-1 lifetime: an EXPIRED railway `ready` (createdSec+3600 ≤ now) is NOT live; GHA never time-excluded | `metaIsLive` (mirrors vm-ssh TTL_SEC / timePrunable) | `EXPIRED railway -> empty`, `FRESH railway -> live`, `EXPIRED GHA -> still live`, `NaN createdSec -> not excluded` |
| r4 PL-1 legacy: missing `phase`=ready, missing `backend`=railway (vm-ssh back-compat) | `metaIsLive` (phase undefined ⇒ committed; backend ?? "railway") | `legacy fresh -> live`, `legacy expired railway -> excluded` |
| PL-2: dir-read error ⇒ unknown, NOT empty | `readdir` errno split / `fleetFromMetas(null)` | `metas null -> unknown`, `three facts DISTINCT` |
| PL-2: genuinely-empty dir ⇒ empty; garbled single meta skipped | `readdir` ENOENT / per-file try | `dir ok no metas -> empty`, `mixed (garbled skipped)` |
| PL-3: async, non-blocking, single-flight | `fs/promises` + worker await | (IO boundary — convention; CLOSED r2) |
| the point of 接真: confirmed machines reduce the shortfall | `planPlacementSuggest` with real machines | `3 confirmed-ready -> funded 7 (demand 10)` |

## Constant gates (self-checked)

- **FC-6** PASS — no timestamp decides anything; `fleetFromMetas`/`vmIdToView` deterministic.
- **FC-7** N/A — placement READS vm-ssh's existing `.meta.json` store (no write, no format change); it adds no persisted format of its own.

## Boundary (out of scope)

- **IO not unit-tested** (convention): the async `readdir`/`readFile` of the meta dir + the errno split. The PURE classifier (`fleetFromMetas`) + mapping (`vmIdToView`) + the three-state ARE tested.
- **Coupling (coordinator-directed):** placement reads vm-ssh's meta store directly (dir path + `Meta.phase`), mirroring `scripts/vm-ssh.ts`. A shared vm-ssh reader / a vm-ctl ledger module is a future refactor; the alternative (changing the vm-ssh producer, another owner's merged module) was not taken.
- **Readiness is a further face**: `phase:"ready"` proves provisioning (address committed); reachability/idle/in-flight are not read ⇒ `ready=false` ⇒ spawn-only. No spend / no VM ops; `SWARM_PLACEMENT` OFF.

0/0 to sign off.
