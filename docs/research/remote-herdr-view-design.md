# S14 remote-herdr unified view — design + progress (90b58f9c, 2026-10-07)

Goal: a remote VM runs herdr; the local herdr shows/controls its agents in one unified view; when the VM is
recycled, the local side disappears. Layout (user-set): **one machine = one workspace** (local=w1; each remote
machine mounts a dedicated workspace named by its label; its agent tabs within; recycle → the whole workspace closes
with the machine). Capacity (user-set): N agents per machine, N = `max(1, min(cores-1, memGB/4))`.

## ① Link-up — PROVEN LIVE (authorized Railway VM, evidence/01-live-proof.md)

Chain, end to end, verified on a real Railway short-lived VM (`vm-railway-rhv1`, root@x86_64 Linux):
1. `vm-ssh up --backend railway --name <label>` → VM + tailcat ECH/Tailscale-dataplane address (addrFile).
2. **ssh bridge (the crux):** herdr's `machine add`/`--machine` use the *system* ssh; vm-ssh reaches the VM via
   `tailcat ssh` (not standard ssh). Bridge with an ssh-config Host whose ProxyCommand runs tailcat's stdio pipe:
   ```
   Host <label>
     User root
     ProxyCommand sh -c 'exec tailcat $(cat ~/.vm-ssh/<label>.addr) 22'
     StrictHostKeyChecking no
     UserKnownHostsFile /dev/null
   ```
   (`ssh root@<label>` over tailcat:22 works; the local ssh key is authorized by vm-ssh keyed mode.)
3. **Remote herdr install** (machine add won't auto-install non-interactively): `curl -fsSL https://herdr.dev/install.sh | sh`
   → remote `herdr 0.9.3` (must match the local version, else machine add refuses).
4. `herdr machine add <label> --label <label>` → "Saved SSH machine … Remote server is ready." `machine status` →
   reachable.
5. **Cross-machine control verified:** `herdr --machine <label> agent list` / `pane list` / `status server` all reach
   the remote herdr from local (remote running 0.9.3; remote pane `w1:p1` /root). Unified view works.

## ③ Capacity — DONE (code + selftest + live-validated)

`packages/bus/src/swarm/remote-capacity.ts` (+selftest): `CAPACITY_PROBE_CMD="nproc; free -b"` →
`agentCapacity = max(1, min(cores-1, floor(memGB/4)))`. Live: the Railway box probed nproc=2, Mem≈2.21 GB → capacity
**1** (matches "Railway small = 1-2"). The dispatcher (future board-admission) feeds work up to this cap per machine.

## ④ Security surface

`herdr machine add`/`--machine` ride the **system ssh** (here tunneled over tailcat's Tailscale/WireGuard dataplane —
encrypted, NAT-traversed, no central control plane). No plaintext credential surface observed: auth is ssh keys
(vm-ssh keyed mode authorizes the local pubkey on the VM); the tailcat address is a secret kept in the addrFile (not
echoed to logs) and referenced from ssh-config via `$(cat …)`, not duplicated. The temporary ssh-config Host is
removed with the machine. (Full source audit of herdr's machine transport pending; CLI/behavior consistent with
ssh-only.)

## ② Lifecycle alignment — DESIGN (to build)

When the VM recycles (Railway self-destructs ~1h; `vm-ssh down` is a no-op for railway), the local machine becomes
unreachable. Cleaner (workspace granularity, not per-tab):
- signal: `herdr machine status` = unreachable AND `vm-ssh ls` no longer lists the VM (recycled, not a transient net
  blip) → treat as recycled.
- action: `herdr machine remove <id>` (verified live — removes the saved machine) + close the machine's workspace
  (`workspace close --group`, per the herdr skill's constraint). "Recycle = disappears."
- guard: unreachable-but-still-in-`vm-ssh ls` = transient → keep (maybe `machine disable`), do not remove.
Build as a pure predicate (recycled? from {machineReachable, vmListed}) + selftest, + an IO sweep reusing herdr.ts
helpers + vm-ssh ls. `machine remove` is proven; the detection predicate is the new code.

## ③ Boot template (to add to vm-ssh docs)

One-shot remote bootstrap: `curl -fsSL https://herdr.dev/install.sh | sh` (herdr) + the `exec -a claude` launcher
(F?/herdr-args-fix: argv0=claude so herdr identifies it) + the claude/codex integration hooks + write the capacity
(from CAPACITY_PROBE_CMD) into the machine's workspace metadata. Then local `machine add`.

## Remaining to doneLine + stopSet

- [x] ① link-up proven live. [x] ③ capacity (code+live).
- [ ] ② cleaner (predicate+selftest+IO sweep). [ ] ③ boot-template script + capacity-into-workspace-metadata.
- [ ] ④ finish source audit note. [ ] workspace-per-machine wiring in the add/cleaner flow.
- Spend: one Railway VM used (authorized R19, user-channel); auto-expires ~1h; test machine removed, ssh-config
  restored. Reuse-first honored (none was live). Send-review (f39ddc91) when doneLine met.
