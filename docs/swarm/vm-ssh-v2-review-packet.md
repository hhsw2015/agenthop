# vm-ssh v2 (GHA backend) review packet → 01a0ff49

**needs:** none (ready for review). **Verify against the CORRECTED contract** (coordinator ruling #R2 withdrew the
agent-forward-clone acceptance item — see Known gap), NOT the original dispatch.

**unverified surface:**
- One real run on **ubuntu-latest** only. macOS/windows are out of v2 scope (the workflow carries a `go install`
  fallback + `sshUserForOs("windows")=runneradmin`, both **unverified**).
- The **railway** path was not re-run live (real Railway allocation costs money); its regression is the in-file selftest
  (the seam change is additive + dispatched-by-backend, railway behavior untouched).
- Agent forwarding is a documented **known gap** (tailcat capability edge), not an implementation gap — see below.

## Scope / branch / commits
`vm-ssh` v2 GHA backend (vm-ssh-brief §v2; user ruled GHA in 2026-10-05). Single self-contained file
`scripts/vm-ssh.ts`, branch `feat/vm-ssh-primitive`. Review range over v1 baseline `7e1aca4`:
- `1dfd607` — Phase 1: `--backend railway|gha` seam + `init`/`down` verbs + embedded workflow + pure helpers/selftest.
- `3170262` — Phase 2: fixes hardened by a real run (input-default bug, artifact handoff, two-step workflow, fast install).
- `02cde41` — docs: the agent-forwarding known-gap + a stale-comment fix.

Home repo created for the real run: **hhsw2015/vm-ssh-home** (private; coordinator ruled a dedicated repo so
workflow/logs/quota decouple from business repos; user approved repo-create + Actions spend via a direct prompt).

## Deliverables → where
| Item | Where |
|---|---|
| `--backend railway\|gha`, default railway, byte-identical railway behavior | `cmdUp` branch; `Meta.backend`; `backendOf`/`ttlSec` |
| Caller-chosen, NEVER auto-selected (coordinator division: railway=short/unbounded, gha=long/6h/single-acct-capped) | no auto-select anywhere; `ls` annotates the gha single-account Actions-quota semantics (no tracking) |
| Embedded box workflow (single-file) | `WORKFLOW_YAML` + `WORKFLOW_FILE` |
| `init [repo]` idempotent, print-before-write | `cmdInit` (gh contents API; identical-content = no-op) |
| `up --backend gha` → dispatch → run-id lock → capture | `cmdUpGha` → `ghaDispatch`/`ghaLockRunId` (exact `run_tag` nonce in displayTitle)/`ghaCaptureAddr` (artifact, status-gated) |
| credential channel (ruling #R3) | `gh secret set VMSSH_SECRET` → workflow masked env `$VMSSH_SECRET` to `--init`; `--init` is non-sensitive only (never a plaintext input) |
| keyed via `<user>@github` published keys (zero secret); public-repo `--open` refused | workflow `--ssh-authorized-keys`; `openRefusedOnPublic`; `ghaPreflightKeys` (non-fatal warn) |
| `down` (gha sentinel / cancel; railway no-op) | `cmdDown` |
| `ssh`/`ls`/`refresh` backend-aware | `cmdSsh` (gha `sshUser`), `cmdLs` (backend column + quota note), `cmdRefresh` (gha re-download) |

## Corrected contract (ruling #R2)
The original dispatch's acceptance copied ghostish's "clone a private repo via the forwarded agent" item. That conflicts
with the brief's own cut line ("the deliverable is a bare `tailcat ssh`-able machine; cloning/bootstrap is the CALLER's
job") and its exclusion ("no agent-forwarding details — ssh-agent is the established path"). The coordinator corrected the
contract: **withdraw the agent-forward-clone item; record a known gap; point callers at a short-lived credential via
`--init`.** Verify against this corrected contract.

## Acceptance results (corrected contract)
| Item | Result |
|---|---|
| `init <repo>` idempotent lands workflow | ✅ installed; re-run = `already identical (idempotent no-op)` |
| `up --backend gha` → addrFile within 90s | ✅ via artifact (box ready inside the target once its step runs; CLI tolerates queue) |
| `ssh` into a shell | ✅ `runner@<addr>`, interactive + remote-command |
| sentinel early stop | ✅ `down` touches `/tmp/ghostish.stop` → hold loop breaks → run `completed success` → bookkeeping pruned |
| 6h self-destruct documented | ✅ workflow hold loop bounded by `ttl_minutes` (≤360); documented |
| railway path regression | ✅ selftest green; seam additive, railway behavior untouched |
| one real run (Actions spend) | ✅ authorized + executed (box-test, ttl 15, then down) |
| ~~agent-forward clone~~ | withdrawn (ruling #R2) → **Known gap** |

## The three CONFIRMs (resolved on the real run)
1. **Address handoff** — `gh run view --log` **refuses an in-progress run** ("logs will be available when it is
   complete"); the jobs-API log blob **404s until the job ends**. So logs are unusable for live capture. Resolved with an
   **artifact**: the fast `start box` step uploads `vmssh-addr`, downloadable while the `hold` step still blocks. (More
   robust than ghostish's log-polling design.) A single blocking step would never surface the address — hence the split.
2. **Runner unix user** = `runner` (ubuntu/macos). `sshUserForOs("windows")="runneradmin"` is unverified.
3. **Agent forwarding** — see Known gap.

## Known gap (verbatim, per ruling #R2)
tailcat's **in-process SSH server does not implement SSH agent forwarding**. Verified on the live box: the client sends
`auth-agent-req@openssh.com`, but the remote `SSH_AUTH_SOCK` stays unset (both plain `tailcat ssh` and a self-built
`ProxyCommand=tailcat <addr> 22` + `ForwardAgent=yes` yield `SOCK=none`). `tailcat serve --help` exposes no agent/forward
surface. This is an **upstream tailcat capability edge, not an implementation gap**. Consequence: a box cannot clone a
private repo via the laptop's forwarded agent. Per the primitive's cut line, cloning/bootstrap is the caller's job. The
connect path stays `tailcat ssh` (reliable); the ProxyCommand route was rejected (transient ping timeouts, and its
`ForwardAgent` is ignored by the server anyway).

**Credential path (ruling #R3, supersedes the earlier `--init`-token note):** `--init` is a NON-SENSITIVE bootstrap
script only. A credential uses the supported secret channel — `gh secret set VMSSH_SECRET -R <home-repo>` → the workflow
exposes the masked env `$VMSSH_SECRET` to `--init`, never a plaintext workflow input/argv/log. "Short-lived" does not
substitute for confidential transport, and a private home repo is not permanently private.

## Tests
- In-file selftest (`vm-ssh --selftest`, pure, no network): v1 assertions + v2 — `normalizeOs` (map + reject + a
  prototype key like `constructor`), `sshUserForOs`, `openRefusedOnPublic` (public forbids `--open` only), `backendOf`
  default, `ttlSec` (gha honors ttlMin), `runTitleFor` exact-match (a `<tag>-other` title must not satisfy the lock),
  `WORKFLOW_YAML` shape (dispatch inputs + keyed key-fetch + addr marker + sentinel + `contents: read` + `run_tag` nonce +
  `secrets.VMSSH_SECRET` channel). All pass. `tsc --noEmit` clean.
- Real run (ubuntu): init → up → ssh → down full chain green (box-test on hhsw2015/vm-ssh-home).

## Round-2 disposition — reviewer 01a0ff49 (4 findings, all fixed in `9897e05`, re-validated on a real run)
| # | Finding | Fix |
|---|---|---|
| 1 | run-id ownership: a timestamp filter picks a newer foreign run, and a same-second no-fraction `…00Z` sorts after `…00.500Z` (lexical `>=`) — ownership unprovable | the CLI sets a random `run_tag` input echoed into `run-name`; `ghaLockRunId` locks the run whose `displayTitle` carries that nonce (exact, collision-free). Timestamp filter dropped. |
| 2 | capture timeout orphans a dispatched (billable, running) box — no cancel, no metadata, handle lost | meta is persisted right after the run-id lock (before capture); the timeout error points at `refresh`/`down`; `cmdSsh` no longer prunes a gha box that has a run id but no address yet |
| 3 | `user_script` (a caller credential, per the known-gap path) passed via gh argv + echoed in the local error on dispatch failure | inputs go to gh over **STDIN** (`--json`), never argv; the failure surfaces only gh's own stderr. Documented: a secret in `--init` still lands in the run's recorded inputs → real secrets via `gh secret set`, not `--init` |
| 4 | `normalizeOs('constructor')` hits `Object.prototype` → returns a truthy Function, passes validation, crashes a later `os.startsWith` after the gh call | `Object.hasOwn(OS_MAP, os)` guard — a prototype key is rejected up front (selftest pins it) |

Also removed the now-dead `parseLogAddr` (capture uses the artifact, not logs). The real re-run confirmed the nonce lock
(`displayTitle` = `vm-ssh-box vmssh-<nonce>`) and stdin dispatch end to end.

## Round-3 disposition — reviewer 01a0ff49 (9897e05: 3 REMAIN) + coordinator ruling #R3, fixed in `9209997`
| Finding | Fix |
|---|---|
| P1-1 residual: `displayTitle.includes(tag)` is substring (a `vm-ssh-box <tag>-other` title wins over the exact one); and a **completed** run's retained artifact is still reported ready | `ghaLockRunId` now matches the FULL run-name EXACTLY (`displayTitle === "vm-ssh-box <tag>"`). `ghaCaptureAddr` reads run **status first** each poll; a `completed` run returns `ended` (stale artifact, box gone) — `up`/`refresh` prune + report distinctly, never ready. |
| P2-1 residual: registration only moved to post-lock; the dispatch/list window still double-proceeds on a same `--name`, and a lock timeout leaves no durable handle | name is reserved **atomically before any side effect** (`reserveMeta`, exclusive `wx`). On dispatch success the `run_tag` nonce is persisted immediately; a lock timeout keeps a recoverable handle (`ensureGhaRunId` re-locks by nonce for `refresh`/`down`); `cmdUp` frees the name only when neither runId nor nonce survived. |
| P1-2 residual (ruling #R3): the credential still rode a plain workflow input/step env | **ruling #R3**: `--init` is non-sensitive only; the supported credential channel is `gh secret set VMSSH_SECRET` → masked `$VMSSH_SECRET` env (never a plaintext input/argv/log). Removed the `--init`-token recommendation from code + this packet + the brief; the stdin transport (local argv/error) stays closed. |

Real re-run (`9209997`) confirmed the exact-title lock + status-gated capture + `ssh`(`runner`) + sentinel `down`.

## Round-4 disposition — reviewer 01a0ff49 (9209997: 0 P1 / 2 P2), fixed in `cba55ed`
| Finding | Fix |
|---|---|
| R3-P2-1: a failed/empty run-status query (`.catch(()=>"")`) was treated as non-terminal → `up`/`refresh` could serve a stale artifact | `ghaCaptureAddr` serves the artifact ONLY on a CONFIRMED non-terminal status; an empty/errored status (unknown) retries, and times out as *not ready* if it never resolves. `completed` → `ended`. Unknown ≠ live. |
| R3-P2-2: the in-flight / nonce record was dropped by reads, cleanup, or a lost dispatch reply | a lifecycle `phase` (reserved→requesting→running→ready); repo+`run_tag` persisted **before** the dispatch request (a reply-lost dispatch keeps a recoverable handle; unknown result ≠ not-dispatched); `prunableOnNoAddr` — `ssh` never prunes a gha record or any in-flight reservation, only a once-ready railway box; `down` prunes ONLY after a confirmed stop (sentinel/cancel), else keeps the handle and reports honestly. |

Real re-run (`cba55ed`) confirmed the status-gated capture + `phase=ready` happy path (up/ssh/down). `prunableOnNoAddr`
matrix pinned in selftest.

## Round-5 disposition — reviewer 01a0ff49 (cba55ed: 0 P1 / 2 P2), fixed in `f293120`
| Finding | Fix |
|---|---|
| R4-P2-1: a late-resuming old `up` writes/prunes by alias → clobbers/deletes a reused name's new record (and the new run leaks) | each up stamps a per-generation `reqId` at reservation; every late write/prune (cmdUpGha requesting/running/ready, railway ready, up catch, down, `ensureGhaRunId` cache) is generation-guarded (`writeMetaIfOwner`/`pruneIfOwner`/`recordIsOwned`, re-checked after each await). A resumed old up whose name was reused aborts without touching the new record + best-effort cancels its own run. |
| R4-P2-2: `resolveId`/`ls` time-prune by `createdSec+ttl`, bypassing `phase` → a queued/requesting gha record is deleted before the runner's hold even starts | `timePrunable`: only railway is time-pruned (its ~1h platform destroy is the model); a gha record is NEVER time-pruned — released only on confirmed-terminal status (refresh/down). `remainingSec` stays a display estimate. |

New pure predicates `recordIsOwned` / `timePrunable` pinned in selftest; real re-run (`f293120`) confirmed up/ls/ssh/down
with the guards in place.

## Round-6 disposition — reviewer 01a0ff49 (f293120: 0 P1 / 3 P2), fixed in `cd18e13`
| Finding | Fix |
|---|---|
| R5-P2: `writeMetaIfOwner`'s read-check-write is not atomic across CLIs — a stale read passes the check, then blindly writes/clobbers | `withIdLock` — an O_EXCL per-id lock file (stale-steal after 10s) wraps the WHOLE read-check-write (and addr write) so a second CLI can't slip a down+reuse between the read and the write. Network awaits stay outside. All guards (`writeMetaIfOwner`/`pruneIfOwner`/`commitReadyIfOwner`/`commitAddrIfOwner`/`ensureGhaRunId` cache) go through it; the up ready path commits address+meta in one locked section. |
| R5-P2: `cmdRefresh` missing the generation guard — a refresh resuming after down+reuse writes a stale address onto / prunes the new record | refresh generation-guards its `ended` prune (`pruneIfOwner`) and its address write (`commitAddrIfOwner`); on takeover it aborts without touching the new record. |
| R5-P2 (tsc TS2345): `base: Meta` widened `reqId` to optional, breaking the `Meta & {reqId:string}` guard calls | `base` typed `OwnedMeta` (required `reqId`); strict/NodeNext typecheck stays on and passes. |

Real re-run (`cd18e13`) confirmed up/ssh/down under the lock with no lock-file leak.

## Round-7 disposition — reviewer 01a0ff49 (cd18e13: 0 P1 / 2 P2), fixed in `95bf0d5`
| Finding | Fix |
|---|---|
| R6-P2-1: `withIdLock` reclaims by `mtime>10s` — steals a still-LIVE holder's lock (age ≠ death) | the lock holds `<pid>.<nonce>`; a held lock is reclaimed ONLY when the holder pid is provably DEAD (`pidAlive` = `kill(pid,0)`: ESRCH dead, EPERM alive). A live holder we can't reclaim → bounded wait then error (never two critical sections). The finally releases ONLY our own lock token. (Applies the F33 bus `claimInbox` wx + `kill -0` liveness criterion.) |
| R6-P2-2: `reserveMeta` bypasses `withIdLock` — an old cleanup holding the lock can delete a new reservation | `reserveMeta` now runs inside `withIdLock`; the `wx`-create can't race the lock, and an old generation's cleanup can't delete a new reservation. |

`pidAlive` pinned in selftest; real re-run (`95bf0d5`) confirmed up/ssh/down with no lock-file leak.

## Seams to probe
- `ghaLockRunId` identifies the run by the `run_tag` nonce in `displayTitle` — not a timestamp (ownership is exact).
- The tailcat address never touches stdout/argv: captured from the artifact file (0600 addr file), and the connect passes
  it only to tailcat's argv (its documented interface). Workflow inputs travel over gh's stdin, not argv.
- `init` is the only persistent external write; it prints the full workflow before committing via the gh contents API.
- Not merged to main (user/coordinator gate).
