# agenthop agents-bridge (Tern plugin)

Mirrors Tern's native `cx.agents` layer to a **file-JSON control plane** the bash-driven agenthop swarm reads and writes, herdr-style. A thin shim: no detection logic of its own — state comes from Tern, judgement stays in the swarm.

Part of **tern-adoption**: A1 = this bridge; A2 (promptless patrol sentinel) and A3 (OSC 9;4 alert channel) extend the same plugin. Origin: tern-migration spike (`docs/research/tern-spike-report.md`, r1-r5 CLEARED).

## Install

```bash
tern plugin link    <repo>/tern/agenthop-agents-bridge   # use in place (dev / this repo)
# or
tern plugin install <repo>/tern/agenthop-agents-bridge   # copy into `tern plugin dir`
tern plugin reload
```

`tern plugin dir` = `~/Library/Application Support/Tern/plugins`. The plugin is a **window-half** plugin (runs in each Tern window VM). It is an **opt-in bypass**: it touches no herdr call and none of the existing swarm lifelines.

## Control plane

Directory: `~/.agenthop/tern-panes/`

- `agents.json` — status mirror (bridge writes every ~750ms; advisory snapshot, overwrite semantics)
- `requests/<id>.json` — bash writes a one-line-JSON request `{op, ...}`
- `results/<id>.json` — bridge writes a one-line-JSON reply `{ok, class, ...}`

Full wire contract + claim/recovery semantics: **[PROTOCOL.md](PROTOCOL.md)** (authoritative).

### Quick example

```bash
D=~/.agenthop/tern-panes
id="q-$$-$(date +%s%N)"                       # unique id
# ATOMIC publish: write a temp name the bridge does not list, then mv it into place (see PROTOCOL.md §2.0).
# Do NOT `echo > requests/$id.json` directly — the bridge can read the half-written file and destroy the request.
printf '%s' '{"op":"list"}' > "$D/requests/.$id.tmp"
mv -f "$D/requests/.$id.tmp" "$D/requests/$id.json"
# poll for the reply, then consume it
until [ -f "$D/results/$id.json" ]; do sleep 0.2; done
jq . "$D/results/$id.json"        # {"ok":true,"class":"read-only","agents":[...]}
rm -f "$D/results/$id.json"
```

### Ops

`list`, `transcript` (omp-only), `wait` (async) — **read-only**; `ask`, `start`, `interrupt`, `stop` — **non-idempotent**. Each reply echoes its `class`.

## Recovery (IMPORTANT — PROTOCOL.md §3)

Execution is claimed by an atomic `remove`; a read failure never deletes the request. This is **at-most-once per claim, not crash-safe exactly-once** (`tern.fs` has no rename/O_EXCL). A missing `results/<id>.json` after a bounded wait = **UNKNOWN**:

- **read-only** ops: re-issue with a new id (a repeat is just another observation).
- **non-idempotent** ops: **HOLD — never blind-reissue**. The op may have run and only the receipt was lost. Verify the effect (e.g. `list`), carry a business idempotency key, or escalate to a human.

## A2 — promptless patrol sentinel

A `tern.carly.schedule` task runs every minute with **no model turn**, reads every agent pane, and raises three alert classes —
`content_filter`, `permission`, `stall` (busy + unchanged **tail-hash** ≥ 3 min; a hash of the tail, because byte offsets fail under
TUI redraw). Alerts go two ways: a durable `~/.agenthop/carly/alerts/<kind>-<pane>-<ts>.json` (the swarm scans it) and a one-line
string shown directly by Carly. Each run self-times (`check_ms`). Arming status: `~/.agenthop/tern-panes/sentinel.json`. Logic lives in
`sentinel.luau`; see [PROTOCOL.md §7](PROTOCOL.md). Tuning (patterns, `stall_ms`, `tail_lines`) is the `CONFIG` table in `sentinel.luau`.

## A3 — OSC 9;4 alert channel

Gives a **bare (non-ACP) Claude Code seat** a "needs-human" signal. `osc-alert-hook.sh` (a Claude Code hook) emits OSC 9;4;4 on
`Notification` (and clears on `Stop`/`UserPromptSubmit`) to the pane's PTY (`/dev/tty`); Tern sets `pane.alert`, which the A2 sentinel
folds in as an `osc_alert`. Only emits inside a Tern pane (no-op elsewhere, so it's safe on every seat). Register via
`osc-alert-hook.settings.json`. Empirical basis: Carly V6 (OSC 9;4;4 → alert=true, focus clears). See [PROTOCOL.md §8](PROTOCOL.md).

**Scope:** this emitter is delivered for **Claude Code only**. Codex is not wired yet (different event `PermissionRequest` + config
path; see `docs/research/codex-opencode-hooks.md`) — the Codex/opencode emitter is **to-verify**, tracked for a later batch.

For ACP-block seats (the migration main path) `waiting_input` + the permission surface come for free; the OSC channel is the
second-best signal for bare TUI seats.

## Test

```bash
lua  test/claim.test.lua       # A1 claim-model: crash-recovery / concurrency / idempotency (Lua 5.5)
lua  test/sentinel.test.lua    # A2 sentinel + A3 reader: content-filter / permission / stall / osc_alert (Lua 5.5)
bash test/osc-hook.test.sh     # A3 emitter: per-event OSC bytes + no-op-outside-Tern guard
```

All fixtures have teeth. `claim.test.lua` mirrors `window.luau`'s drain decision (kept in sync by comment); `sentinel.test.lua` loads
the real `sentinel.luau` directly (no drift); `osc-hook.test.sh` captures the emitted OSC via `AGENTHOP_OSC_TTY`.
