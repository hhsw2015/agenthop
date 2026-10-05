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
| `up --backend gha` → dispatch → run-id lock → capture | `cmdUpGha` → `ghaDispatch`/`ghaLockRunId` (pre-dispatch timestamp)/`ghaCaptureAddr` (artifact) |
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
private repo via the laptop's forwarded agent. Per the primitive's cut line, a box that must clone injects a
**short-lived, narrowly-scoped credential via `up --init`** (never a long-lived key baked into the box). The connect path
stays `tailcat ssh` (reliable); the ProxyCommand route was rejected (transient ping timeouts, and its `ForwardAgent` is
ignored by the server anyway).

## Tests
- In-file selftest (`vm-ssh --selftest`, pure, no network): v1 assertions + v2 — `parseLogAddr`, `normalizeOs`
  (map + reject), `sshUserForOs`, `openRefusedOnPublic` (public forbids `--open` only), `backendOf` default,
  `ttlSec` (gha honors ttlMin), `WORKFLOW_YAML` shape (dispatch inputs + keyed key-fetch + addr marker + sentinel +
  `contents: read`). All pass. `tsc --noEmit` clean.
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

## Seams to probe
- `ghaLockRunId` identifies the run by the `run_tag` nonce in `displayTitle` — not a timestamp (ownership is exact).
- The tailcat address never touches stdout/argv: captured from the artifact file (0600 addr file), and the connect passes
  it only to tailcat's argv (its documented interface). Workflow inputs travel over gh's stdin, not argv.
- `init` is the only persistent external write; it prints the full workflow before committing via the gh contents API.
- Not merged to main (user/coordinator gate).
