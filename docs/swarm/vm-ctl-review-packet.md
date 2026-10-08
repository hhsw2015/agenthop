# vm-ctl — review packet (S14, owner 90b58f9c)

Branch `feat/vm-ctl`, review range `c3439cd..HEAD` (merge-base with main = c3439cd). Verify: `npx tsx packages/bus/src/swarm/vm-ctl.selftest.mts` → 80 cases green; `cd packages/bus && npx tsc --noEmit` → 0.

**Scope proof** (`git diff --name-status c3439cd..HEAD`): PURELY ADDITIVE — `vm-ctl.{ts,selftest.mts}` + design doc + this packet. Modifies NO existing file; changes NO runtime (`SWARM_VM_CTL` default OFF). No new dependency. Design coordinator-approved + user positioning ruling (`docs/swarm/vm-ctl-design.md`).

## What it is

Elevates vm-ssh into a backend-agnostic machine-management command family. **Constitution (user):** vm-ctl commands bind to SSH reachability, NOT a vendor account — a machine is valid with `{addr+key}`, any origin.

| Module | lines | selftest | Purpose |
|---|---|---|---|
| `vm-ctl.ts` | 284 | 80 | pure: Machine shape, `verbNeedsBackend` (decoupling invariant), `adoptMachine`, `readyVerdict`, `nextBackoffSec`, `buildCredSeed`+`credDeliveryOk` (hard gate), `buildForwardArgs`, snapshot genealogy (`snapshotRef`/`restorePlan`/`forkPlan`, checkpoint/template/fork), `buildCodePlan` (code facade), `buildBootPlan`; IO: `vmCtlEnabled` (dormant) |

## Invariant → where pinned (the review walk)

| Invariant | Implementation | Test |
|---|---|---|
| decoupling ①: ONLY up/down touch a vendor API | `BACKEND_ONLY_VERBS` / `verbNeedsBackend` | `only up/down need a backend`, `all other verbs backend-agnostic` |
| adopt ②/③: any addr → Machine, accountless, lifetimeSec=null | `adoptMachine` | `adopt: backend=adopted`, `lifetimeSec=null`, `capacity null until probed` |
| credential hard gate: stdin→0600, argv = refuse (fail-closed) | `buildCredSeed` + `credDeliveryOk` | `codex seed via stdin`, `sets 0600`, `argv -> REFUSE`, `not-stdin -> REFUSE` |
| ready fail-closed: exit-fail=unknown, explicit-only, never ready on doubt | `readyVerdict` | `exit-failed -> unknown`, `refused -> down`, `noise -> unknown` |
| bounded backoff | `nextBackoffSec` | `clamps to last`, `attempt<1 -> first` |
| poor-man's-sleep = external snapshot + restore+succession | `snapshotRef` / `restorePlan` | `branch+breakpoint`, `checkpoint restore -> succession` |
| snapshot genealogy: template SKIPS boot; fork amortizes 1 install over N | `restorePlan` / `forkPlan` | `template restore SKIPS bootstrap`, `fork: one install amortized across N` |
| code facade = position transparency (remote member == local) | `buildCodePlan` | `5 steps up->ready->creds->boot->machine-add`, `remote==local noted` |
| boot plan download-then-run (never curl\|sh), re-runnable | `buildBootPlan` | `downloads then runs (RH6)`, `exec -a claude` |

## Hard boundary (owner stance)

Credential discipline is the security hard-gate (constitution + design ③): a credential rides stdin into a 0600 file, NEVER argv (argv leaks to `ps`); Codex `cat > ~/.codex/auth.json`, Claude prefers a minted one-time setup token. `credDeliveryOk` rejects any argv path fail-closed. (Stated so the reviewer checks the gate can't be bypassed.)

## Boundary (out of scope — do NOT chase)

- **IO not unit-tested** (convention): ssh/git/herdr exec, the real `up`/`reclaim` backend impls, the ready-probe/snapshot/restore IO. The PURE builders/verdicts/invariants ARE tested.
- **Decoupling live-rider**: the design's `pure sshd container passes the full family (adopt→ready→creds→boot→snapshot→restore→forward→ssh)` is an IO integration test — the PURE decoupling invariant (`verbNeedsBackend` + accountless `adoptMachine`) is unit-proven here; the container run rides a future wiring.
- **Not wired**: `SWARM_VM_CTL` OFF; absorbing vm-ssh's up/ls/ssh + the herdr-machine-add / remote-recycle mesh are wiring flips (those live on unmerged branches). `buildBootPlan` converges with remote-bootstrap at merge.
- **Phase boundary**: this is **phase-1 = the command family (the wrench)**. The **phase-2 placement engine** (the user-facing `just run a member`; auto spawn-on-capacity + snapshot-on-expiry, feeding board-admission + fanout) is a SEPARATE future ticket — out of scope here. Design ⓪ frames both layers.

Counterexamples welcome against the decoupling invariant, the credential gate, the ready fail-closed verdict, and the adopt accountless shape. 0/0 to sign off.

## SIGNED OFF — `605712e` (codex:happycapy, 0 REMAIN)

All 4 findings CLOSED across 5 rounds (469b939→0d54e3f→b0e9530→51ac192→605712e): VMC-P1-1 ready evidence (JSON-structural-only + anchored success whitelist), VMC-P1-2 cred 0600-before-first-byte + delivery check, VMC-P2-1 URL single-literal-arg, VMC-P2-2 sparse/empty/illegal backoff safe fallback. selftests 80, tsc 0, boundary probes 21/21. Sign-off bounds: phase-1 pure core / classification / plan builders / isolated-command checks; NOT verified — real SSH, vendor API, container flow, token mint, client auth (phase-2 placement = separate ticket). Text whitelist extensions need live-probe evidence. Merge/wire = separate gate (coordinator + user) — NOT pushed/merged.
