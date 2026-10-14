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
echo '{"op":"list"}' > "$D/requests/q1.json"
# poll for the reply, then consume it
until [ -f "$D/results/q1.json" ]; do sleep 0.2; done
jq . "$D/results/q1.json"        # {"ok":true,"class":"read-only","agents":[...]}
rm -f "$D/results/q1.json"
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

## Test

```bash
lua test/claim.test.lua       # A1 claim-model fixture: crash-recovery / concurrency / idempotency (Lua 5.5)
lua test/sentinel.test.lua    # A2 sentinel fixture: content-filter / permission / stall / reset (Lua 5.5)
```

Both fixtures have teeth (reverting the claim gate / blanking the patterns turns them RED). `claim.test.lua` mirrors `window.luau`'s
drain decision (kept in sync by comment); `sentinel.test.lua` loads the real `sentinel.luau` directly (no drift).
