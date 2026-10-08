# S14 remote-herdr unified view — design + progress (90b58f9c, 2026-10-07)

Goal: a remote VM runs herdr; the local herdr shows/controls its agents in one unified view; when the VM is recycled, the local side disappears. Layout (user-set): **one machine = one workspace** (local=w1; each remote machine mounts a dedicated workspace named by its label; its agent tabs within; recycle → the whole workspace closes with the machine). Capacity (user-set): N agents per machine, N = `max(1, min(cores-1, memGB/4))`.

## ① Link-up — PROVEN LIVE (authorized Railway VM, evidence/01-live-proof.md)

Chain, end to end, verified on a real Railway short-lived VM (`vm-railway-rhv1`, root@x86_64 Linux):
1. `vm-ssh up --backend railway --name <label>` → VM + tailcat ECH/Tailscale-dataplane address (addrFile).
2. **ssh bridge (the crux):** herdr's `machine add`/`--machine` use the *system* ssh; vm-ssh reaches the VM via `tailcat ssh` (not standard ssh). Bridge with an ssh-config Host whose ProxyCommand runs tailcat's stdio pipe:
   ```
   Host <label>
     User root
     ProxyCommand sh -c 'exec tailcat $(cat ~/.vm-ssh/<label>.addr) 22'
     StrictHostKeyChecking no
     UserKnownHostsFile /dev/null
   ```
   (`ssh root@<label>` over tailcat:22 works; the local ssh key is authorized by vm-ssh keyed mode.)
3. **Remote herdr install** (machine add won't auto-install non-interactively): `curl -fsSL https://herdr.dev/install.sh | sh` → remote `herdr 0.9.3` (must match the local version, else machine add refuses).
4. `herdr machine add <label> --label <label>` → "Saved SSH machine … Remote server is ready." `machine status` → reachable.
5. **Cross-machine control verified:** `herdr --machine <label> agent list` / `pane list` / `status server` all reach the remote herdr from local (remote running 0.9.3; remote pane `w1:p1` /root). Unified view works.

## ③ Capacity — DONE (code + selftest + live-validated)

`packages/bus/src/swarm/remote-capacity.ts` (+selftest): `CAPACITY_PROBE_CMD="nproc; free -b"` → `agentCapacity = max(1, min(cores-1, floor(memGB/4)))`. Live: the Railway box probed nproc=2, Mem≈2.21 GB → capacity **1** (matches "Railway small = 1-2"). The dispatcher (future board-admission) feeds work up to this cap per machine.

## ④ Security surface

`herdr machine add`/`--machine` ride the **system ssh** (here tunneled over tailcat's Tailscale/WireGuard dataplane — encrypted, NAT-traversed, no central control plane). No plaintext credential surface observed: auth is ssh keys (vm-ssh keyed mode authorizes the local pubkey on the VM); the tailcat address is a secret kept in the addrFile (not echoed to logs) and referenced from ssh-config via `$(cat …)`, not duplicated. The temporary ssh-config Host is removed with the machine.

**Source audit — DONE as far as the source permits (honest limit):** a full source audit of herdr's `machine` transport is NOT possible from the local checkout — it is herdr **0.7.1** (HEAD iter37), and the `machine` add/list/status/remove feature is a **0.9.x** addition absent from that source. So the audit is BEHAVIORAL + CLI-surface, not line-level:
- auth = ssh keys only (vm-ssh keyed mode authorizes the local pubkey on the VM); no password/token prompt in the non-interactive path (and `machine add` explicitly refuses to auto-install remote herdr non-interactively — it will not silently fetch+run code).
- transport = the **system ssh**, here tunneled over tailcat's Tailscale/WireGuard ECH dataplane (encrypted, NAT-traversed, no central control plane).
- secret handling = the tailcat address lives in the addrFile, referenced via `$(cat …)` in the ssh-config ProxyCommand, never duplicated into logs; `vm-ssh ls` does not echo it; `--machine` JSON receipts carry no secret.
- residue = the temp ssh-config Host is removed with the machine; ② additionally removes the saved machine + closes the workspace on recycle.
- **Unverifiable without 0.9.x source (stated, not assumed):** whether `machine add` persists any credential material to disk beyond the ssh-config Host; the exact `machine status` wording (② `parseReachable` is fail-closed to cover this). Resolve by obtaining 0.9.x source or a one-time live strace/fs-diff on an authorized VM.

## ② Lifecycle alignment — DONE (code + selftest; `packages/bus/src/swarm/remote-recycle.ts` + `.selftest.mts`)

When the VM recycles (Railway self-destructs ~1h; `vm-ssh down` is a no-op for railway), the saved herdr machine becomes a dangling entry. Cleaner at workspace granularity (not per-tab), built as a pure verdict + a thin IO sweep.

**Pure verdict (`recycleVerdict`) — two evidence faces, fail-closed (CORE iron law 4: 单信号不定罪; 两证据面):**
- `machineReachable` (from `herdr machine status`) AND `vmListed` (label in `vm-ssh ls`) — recycled = BOTH say gone.
- reachable=true ⇒ `live` (never remove). unreachable + still listed ⇒ `transient` (net blip, keep). unreachable + absent ⇒ `recycled`. ANY missing/ambiguous face ⇒ `unknown` ⇒ keep. `shouldRemove` triggers ONLY on `recycled`.
- 32/32 selftests (full 3×3 truth table incl. the `unreachable`⊃`reachable` substring trap) + tsc 0.

**IO sweep (`sweepRecycled`) — exercised by live runs, three independent safety layers:**
- ephemeral-gated: acts only on machines whose label is a key of the `ephemeral` linkage map (the vm-ssh VMs this flow provisioned) — a permanent SSH box is never touched. VM presence is matched by the registered `vmId`, NOT the label (they can differ — RH3). Seam to ③ (the linkage ledger).
- fail-closed: `vm-ssh ls` unavailable ⇒ vmListed=null ⇒ every verdict `unknown` ⇒ nothing removed.
- dry-run default (`act` defaults false): the sweep only REPORTS unless explicitly enabled.
- recycled + act ⇒ `herdr machine remove <id>` then `herdr workspace close <workspace_id>`.

**CLI-shape corrections (verified against live herdr 0.9.3 help, read-only):**
- `herdr workspace close <workspace_id>` is POSITIONAL — there is no `--group` flag (earlier design note was wrong). The workspace is mapped by `workspace list` JSON `label` == machine label (one machine = one workspace by label).
- `herdr machine remove <PROFILE_ID>` (the id hash), `machine list` plain-text rows `<id>\t<label>\t<host>\t<group>\t<enabled>`, `vm-ssh ls --json` = `[{id,...}]`.
- Honest gap: the exact `machine status` wording for a LIVE reachable machine was not captured offline (no VM provisioned — no-spend). `parseReachable` keyword set is best-effort; fail-closed makes a wrong guess safe (keeps, never wrongly removes). Confirm/trim on the next live run.

## ③ Boot template — DONE (code + selftest; `packages/bus/src/swarm/remote-bootstrap.ts` + `.selftest.mts`)

One-shot remote bootstrap, built as pure builders + an ephemeral-linkage ledger (16/16 selftests, tsc 0):
- `buildBootstrapScript()` → the `vm-ssh up --init` payload: `curl -fsSL https://herdr.dev/install.sh | sh` (herdr must match the local version or `machine add` refuses) + the `CAPACITY_PROBE_CMD` to stdout + a documented requirement that remote agent launchers `exec -a claude <real-binary>` (herdr-args-fix F③: herdr identifies by argv0 basename).
- `buildCapacityMetadataArgs(workspaceId, capacity)` → `herdr workspace report-metadata --source remote-herdr-view --token capacity=<n> <workspaceId>` (CLI shape verified vs live 0.9.3). Local flow: probe → `capacityFromProbe` (remote-capacity.ts) → this → metadata.
- **Ephemeral linkage ledger** (`~/.agenthop/swarm/remote-herdr/ephemeral.json`, atomic write): records machine label ↔ vm-ssh id on provision. `parseLinkage` validates EACH entry (an invalid body grants no cleanup authority — RH4). `readLinkage()` IS the `ephemeral` map the ② sweep acts within — this closes the ②↔③ seam (without it ② stays inert, by design: a recycled VM is indistinguishable from a down permanent box).
- Live acceptance (real `vm-ssh up --init` → `machine add` → metadata write) rides a future authorized VM; no-spend now.

## Workspace-per-machine wiring (the ②↔③ seam, one line)

The recycle sweep consumes the linkage ledger directly — no new entrypoint needed:
```ts
import { sweepRecycled } from "./remote-recycle.js";
import { readLinkage } from "./remote-bootstrap.js";
await sweepRecycled({ ephemeral: await readLinkage(), act: /* dormant default false */ });
```
One machine = one workspace (named by the machine label); ③ provisions + links, ② sweeps recycled links + closes the workspace by label. Enabling `act` is the single flip (dormant-ahead-of-use, like SWARM_BOARD_ADMIT).

## Remaining to doneLine + stopSet

- [x] ① link-up proven live. [x] capacity (code+live, df18775). [x] ② cleaner (verdict+32 selftests+IO sweep, d7b69b9).
- [x] ③ boot-template + capacity-into-metadata + ephemeral-linkage ledger (16 selftests, tsc 0). [x] ②↔③ wiring (one line).
- [x] ④ source audit (behavioral + CLI; line-level BLOCKED — local herdr source is 0.7.1, machine feat is 0.9.x).
- **Code-complete. Remaining = live-acceptance riders only (need an authorized VM; no-spend now):**
  - ② real recycle: provision → let Railway self-destruct → sweep; confirms `parseReachable` wording + end-to-end remove+close.
  - ③ real `vm-ssh up --init` → `machine add` → `report-metadata`; confirms the bootstrap + metadata write live.
  - ④ residual: 0.9.x source OR a one-time strace/fs-diff on an authorized VM for the credential-persistence question.
- **SIGNED OFF `facdac9` by codex:Work (0 REMAIN, RH1–RH6 all CLOSED, 3 adversarial rounds; 27/27 probes, selftests 11/52/28, tsc 0, zh-lint 0).** Merge/push is a separate gate (coordinator + user) — NOT done. Live-acceptance riders ride the next authorized-VM window.
- Spend: one Railway VM used (authorized R19, user-channel); auto-expires ~1h; test machine removed, ssh-config restored. Reuse-first honored (none was live). Send-review (f39ddc91) when doneLine met.
