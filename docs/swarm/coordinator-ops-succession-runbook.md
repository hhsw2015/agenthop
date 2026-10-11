# coordinator-ops-receipt (F53) — succession + ops-receipt runbook

owner 90b58f9c · reviewer codex:Work (01a1208e). This is the prose half of the F53 wiring (the code half is the pure core
`packages/bus/src/swarm/coordinator-ops-receipt.ts` + the three dormant seams). The reflexive north star: the coordinator's OWN
operations are "done" only when DURABLE evidence proves it — never because an API returned ok instantly.

## ① Succession shell-swap bus-join — the new shell's first action is `agenthop install --mcp <kind>`

When a member's shell is swapped (restart / replacement), the NEW shell must (re)install the swarm status/presence hooks before it
is trusted on the bus. **The `--mcp <kind>` argument is REQUIRED: a bare `agenthop install` only PRINTS setup hints and registers
nothing — `registerMcp` (the real hook writer) runs only under `--mcp` (`install.ts`).** `agenthop install --mcp <kind>` is
idempotent (a no-op when the hook config is already current — `agents.ts`), so it is always safe to run.

- **Spawned/remote shells (code):** `buildBootPlan` (`packages/bus/src/swarm/vm-ctl.ts`) now emits `agenthop install --mcp claude`
  (the spawned box is a claude agent) right after the herdr-install step, so a freshly booted remote shell actually registers the
  hooks as part of its boot plan. This rides the existing `SWARM_VM_CTL` gate (default OFF) — the whole boot path is dormant until
  a live run enables it.
- **Local restart/adopt (runbook — human/coordinator step):** after swapping or restarting a member shell locally, its FIRST
  action is `agenthop install --mcp <agent-kind>` — name the member's kind (`claude`/`codex`/…); a bare `agenthop install` only
  prints hints and registers nothing. This is a runbook step, NOT a presence-daemon action: `node presence.mjs` is not the agent
  and must not rewrite the agent's hook config (it does not reliably know the agent kind/bin). Bus-join itself is already automatic
  — `reportCheckIn` (`checkin.ts`, called from `core.ts`) writes a `[checkin]` to the coordinator inbox on every bus start — so
  `agenthop install --mcp <agent-kind>` only matters when the hook config itself has drifted.

## ② Ops-receipt — verify the coordinator's own spawn/inject by durable evidence

`verifyOpsAction(action, evidence)` → `confirmed | failed | unknown` (the API's instant return is never evidence). ops-receipt is
a **verifier, not a recorder** (coordinator ruling C): the dispatcher sub-step `runOpsReceipt` (sweep, gated on **SWARM_OPS_RECEIPT**,
default OFF) DERIVES its verify-set from the **live box mirror** (`loadMirror()` — the dispatcher's own durable fire record), so
there is no fire-site recording. A mirror `ControlRecord` carries no bus session id, so each box is verified as `kind:"inject"`:
its durable NEW output is a confirmed checkpoint `sha` that has **advanced beyond the IMMUTABLE birth anchor `incomingSha`** (set
once at creation = the record's initial sha; a fresh box's is `""`). Crucially it is NOT compared against `handoffSha`:
`allocating` re-pins `handoffSha` to this box's OWN sha for its outgoing handoff, so a box that produced output and is handing off
would read `sha === handoffSha` and be wrongly judged unproven — `incomingSha` never moves, so `sha !== incomingSha` cleanly means
"this box checkpointed past its birth point". A **legacy pre-field** record (no `incomingSha`) is skipped conservatively — no
verdict, no notice — so enabling the feature never false-alarms on an existing mirror (a one-time migration window, FC-7).
`runOpsReceipt` writes ONLY the verdict to the control-log `opsReceipt` kind (audit), committing on a status change (FC-6).

- **confirmed** ⇒ discharged (terminal).
- **unknown** ⇒ ACCOUNT: `notifyCoordinator` surfaces it; the dispatcher does **not** auto-redo (re-firing is only safe if
  `swarm-launch` is idempotent for an already-allocated `launchId`, which the dispatcher cannot prove — the redo decision is the
  coordinator's). The duty discharges only when the notice is actually **delivered**; a logged/failed notify retries each tick. A
  **grace window** (`SWARM_OPS_RECEIPT_GRACE_SEC`, default 600) holds a young box that simply has not checkpointed past its anchor
  yet, so a fresh spawn never spams the coordinator.

## ③ Succession-heartbeat — a swapped member that never comes back

On adopt, `presence.ts` writes `~/.agenthop/swarm/succession/<sid>.json {swappedAtSec}` (under the existing **SWARM_SUCCESSION**
gate, so a swap is always recorded even if the heartbeat sentinel is off). The dispatcher sub-step `runSuccessionHeartbeat` (sweep,
gated on **SWARM_SUCCESSION_HEARTBEAT**, default OFF, independent of SWARM_SENTINEL) takes its candidate set from the **swap records
themselves** (`listSuccessionSwaps` — NOT `listSessions`/roster, whose `resolveSession` needs a live PID file and would wrongly
drop a dead successor that never came up) and builds `SuccessionLiveness{member, swappedAtSec, lastBusSec (presence pid mtime)}`,
then calls `successionHeartbeatDue(m, now, successionHeartbeatSec())` (window `SWARM_SUCCESSION_HEARTBEAT_SEC`, default 600).
Proof-of-life is the **durable presence pid mtime ONLY** — check-in evidence was withdrawn (coordinator ruling): a consumable
`[checkin]` can be drained by the coordinator between ticks and misread as silence (a false alert), so it is not consulted. On a
due member — swapped, past the window, with NO bus heartbeat since the swap — it raises S19 via `notifyCoordinator`
(`taskRef: succession:heartbeat:<member>`), one-shot per episode (latched only on a real **delivery**), re-armed on recovery. A
member with no swap record is never checked (the pure core fail-closes on a non-finite `swappedAtSec`).

## Flags (the two NEW consumers default OFF, plain-boolean idiom — NOT flagDefaultOn; existing gates as noted)

| flag | gates |
|---|---|
| `SWARM_OPS_RECEIPT` | ② `runOpsReceipt` |
| `SWARM_SUCCESSION_HEARTBEAT` | ③ `runSuccessionHeartbeat` (consumption) |
| `SWARM_SUCCESSION_HEARTBEAT_SEC` | ③ window (default 600; pure core) |
| `SWARM_SUCCESSION` (existing) | ③ swap-record WRITE on adopt |
| `SWARM_VM_CTL` (existing) | ① `agenthop install` boot line |

With the two new CONSUMER flags OFF (`SWARM_OPS_RECEIPT` / `SWARM_SUCCESSION_HEARTBEAT`), `runOpsReceipt` / `runSuccessionHeartbeat`
return immediately and the boot line only composes under `SWARM_VM_CTL` (default OFF). The ONE behavior that is NOT gated by a new
flag is the swap-record WRITE on adopt: it rides the existing `SWARM_SUCCESSION` (default ON) as an adoption side-effect — a new
`~/.agenthop/swarm/succession/<sid>.json` file appears on a swap. It is inert (nothing reads it until `SWARM_SUCCESSION_HEARTBEAT`
is on) but it is a real new write, so the "byte-identical with everything off" claim holds only for the two consumer flags, not for
this write.

FC-6: statuses advance by explicit transition keyed on `opId` (never latest-wins). FC-7: the `opsReceipt` put kind and the swap
side file are additive — a legacy control-log with no opsReceipt records and a roster with no swap records keep working unchanged.
