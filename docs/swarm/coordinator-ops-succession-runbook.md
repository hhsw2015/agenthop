# coordinator-ops-receipt (F53) — succession + ops-receipt runbook

owner 90b58f9c · reviewer codex:Work (01a1208e). This is the prose half of the F53 wiring (the code half is the pure core
`packages/bus/src/swarm/coordinator-ops-receipt.ts` + the three dormant seams). The reflexive north star: the coordinator's OWN
operations are "done" only when DURABLE evidence proves it — never because an API returned ok instantly.

## ① Succession shell-swap bus-join — the new shell's first action is `agenthop install`

When a member's shell is swapped (restart / replacement), the NEW shell must (re)install the swarm status/presence hooks before
it is trusted on the bus. `agenthop install` is idempotent (a no-op when the hook config is already current — `agents.ts`), so it
is always safe to run.

- **Spawned/remote shells (code):** `buildBootPlan` (`packages/bus/src/swarm/vm-ctl.ts`) now emits `agenthop install` right after
  the herdr-install step, so a freshly booted remote shell installs the hooks as part of its boot plan. This rides the existing
  `SWARM_VM_CTL` gate (default OFF) — the whole boot path is dormant until a live run enables it.
- **Local restart/adopt (runbook — human/coordinator step):** after swapping or restarting a member shell locally, its FIRST
  action is `agenthop install`. This is a runbook step, NOT a presence-daemon action: `node presence.mjs` is not the agent and
  must not rewrite the agent's hook config (it does not reliably know the agent kind/bin). Bus-join itself is already automatic —
  `reportCheckIn` (`checkin.ts`, called from `core.ts`) writes a `[checkin]` to the coordinator inbox on every bus start — so
  `agenthop install` only matters when the hook config itself has drifted.

## ② Ops-receipt — verify the coordinator's own spawn/inject by durable evidence

`verifyOpsAction(action, evidence)` → `confirmed | failed | unknown` (the API's instant return is never evidence). The dispatcher
sub-step `runOpsReceipt` (sweep, gated on **SWARM_OPS_RECEIPT**, default OFF) reads the OPEN `opsReceipt` control-log records,
gathers durable evidence for each target (bus visibility, a `[checkin]` / receipt in the coordinator inbox via the read-only
`scanInboxMessages`, a board report file), and advances each record's status — committing ONLY on a status change (FC-6).

- **confirmed** ⇒ discharged.
- **unknown / failed** ⇒ ACCOUNT: `notifyCoordinator` surfaces it; the dispatcher does **not** auto-redo. Re-firing an op is only
  safe if `swarm-launch` is idempotent for an already-allocated `launchId`, which the dispatcher cannot prove — so v1 reports and
  leaves the redo decision to the coordinator. (Auto-redo can land later, behind proof of re-fire idempotency.)

Fire-site recording (writing the `pending` receipt when an op fires at `allocateSuccessor` / `resumeSuccessor` / `startTaskIO`,
all behind `SWARM_EXEC` / `SWARM_TASK_EXEC`) is marked as a TODO seam in `swarm-dispatch.ts` (`pendingOpsReceipt(...)`): the op
fns do not hold the control-log state, so the minimal correct placement is the pass's commit point. Until it lands, `runOpsReceipt`
finds no pending records and is a safe no-op.

## ③ Succession-heartbeat — a swapped member that never comes back

On adopt, `presence.ts` writes `~/.agenthop/swarm/succession/<sid>.json {swappedAtSec}` (under the existing **SWARM_SUCCESSION**
gate, so a swap is always recorded even if the heartbeat sentinel is off). The dispatcher sub-step `runSuccessionHeartbeat` (sweep,
gated on **SWARM_SUCCESSION_HEARTBEAT**, default OFF, independent of SWARM_SENTINEL) builds `SuccessionLiveness{member, swappedAtSec,
lastBusSec (presence pid mtime), lastCheckinSec (coordinator-inbox [checkin])}` and calls `successionHeartbeatDue(m, now,
successionHeartbeatSec())` (window `SWARM_SUCCESSION_HEARTBEAT_SEC`, default 600). On a due member — swapped, past the window, and
NO bus heartbeat NOR check-in since the swap — it raises S19 via `notifyCoordinator` (`taskRef: succession:heartbeat:<member>`),
one-shot per episode, re-armed on recovery. A member with no swap record is never checked (the pure core fail-closes on a
non-finite `swappedAtSec`).

## Flags (all default OFF; opt-in, plain-boolean idiom — NOT flagDefaultOn)

| flag | gates |
|---|---|
| `SWARM_OPS_RECEIPT` | ② `runOpsReceipt` |
| `SWARM_SUCCESSION_HEARTBEAT` | ③ `runSuccessionHeartbeat` (consumption) |
| `SWARM_SUCCESSION_HEARTBEAT_SEC` | ③ window (default 600; pure core) |
| `SWARM_SUCCESSION` (existing) | ③ swap-record WRITE on adopt |
| `SWARM_VM_CTL` (existing) | ① `agenthop install` boot line |

With all new flags OFF, run-time behavior is byte-identical to before: `runOpsReceipt`/`runSuccessionHeartbeat` return immediately,
the swap-record write only happens when `SWARM_SUCCESSION` is on (as today), and the boot line only composes under `SWARM_VM_CTL`.

FC-6: statuses advance by explicit transition keyed on `opId` (never latest-wins). FC-7: the `opsReceipt` put kind and the swap
side file are additive — a legacy control-log with no opsReceipt records and a roster with no swap records keep working unchanged.
