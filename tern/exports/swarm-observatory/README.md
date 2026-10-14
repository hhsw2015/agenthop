# Swarm Observatory (Tern plugin) — line② A6 + A8 v1

A Tern (closed-beta terminal multiplexer) plugin, written in Luau, that gives Carly a cold-start
view of the agenthop swarm. It implements **line②** of the Tern-adoption parallel contract
(`docs/swarm/tern-batch2-contracts.md` §2):

- **A6** — a cold-start **canvas** + an authoritative Markdown **snapshot**
  (`~/.agenthop/carly/canvas-snapshot.md`). The content is *summary + wayfinding*, and **every line
  carries a durable file path** ("the fact is always in the file"). The snapshot is the source of
  truth (canvas cross-restart is unproven); the canvas pane is a mirror of the same string
  (double-write). It refreshes on a 1-minute promptless check **or** an explicit command.
- **A8 v1** — four **read-only** Carly observation exports with **frozen signatures**, each capped
  at **16 KiB JSON** with a `truncated` flag.

Everything is read-only over `herdr` and the durable swarm files. The **only** thing this plugin
writes is the snapshot file it owns (plus the canvas pane).

## Files

| File | Purpose |
|------|---------|
| `plugin.toml` | Tern manifest (`schema`, `id`, `name`, `version`, `description`, `window` entry). |
| `window.luau` | Window-half entry (Carly is window-only). Wires tern/cx I/O to the pure modules: registers the 4 exports, the `refresh` command, the A6 canvas/snapshot, and arms the 1-minute check. |
| `budget.luau` | Pure 16 KiB JSON cap (`fitArray` / `fitMap`). Encoder injected — no `tern` dependency. |
| `parse.luau` | Pure parsers/shapers (seats, review queue, PROGRESS cycles, flags, inbox/board counts). No `tern`/`cx`. |
| `snapshot.luau` | Pure A6 Markdown builder (summary + wayfinding). |
| `snapshot-check.luau` | The 1-minute promptless `check` source handed to `tern.carly.schedule`; dispatches `plugin.swarm-observatory.refresh`. |
| `test/budget.test.lua` | 16 KiB boundary fixture (runs under Lua 5.5 / LuaJIT). |
| `test/parse.test.lua` | Parser fixtures over the real data shapes. |
| `test/run.sh` | Runs both fixtures. |

`budget.luau`, `parse.luau`, `snapshot.luau` are written in the Lua 5.1/5.5 ∩ Luau subset so the
**same files** are loaded by Tern (via `require`) and by the fixtures (via `loadfile` under stock
`lua`) — one source, no drift (the `agenthop-agents-bridge` rule).

## The four exports (frozen signatures)

All read-only. Each returns a JSON-safe table, capped at 16 KiB; when it must drop data it sets
`truncated: true` (the field is absent within budget).

```
swarm_status()    -> { seats:[{id,title,herdrState,inboxDepth,task}], ts, truncated? }
swarm_queue()     -> { reviews:[{item,sha,seat,round,state}], ts, truncated? }
swarm_progress(n) -> { cycles:[{num,title,lines}], ts, truncated? }     -- n clamped to 1..20
swarm_flags()     -> { flags:{<NAME>:"on"|"off"|"dormant"}, ts, truncated? }
```

### Data source + API map

| Export | Data source (read-only) | Tern / herdr API used |
|--------|-------------------------|------------------------|
| `swarm_status` | `herdr api snapshot` → `.result.snapshot.agents[]` (`agent_session.value`→id, `terminal_title_stripped`→title/task, `agent_status`→herdrState); `inboxDepth` = top-level `*.json` in `~/.agenthop/inbox/<sid>/` (bus semantics: unclaimed messages, excludes `.claim-*` and the quarantine/.pubcred/.published dirs — `packages/bus/src/inbox.ts`). | `tern.process.run({HERDR,"api","snapshot"}, {timeout_ms=8000}, cb)` (async; `ExportCall:wait`/`:reply`); `tern.fs.list`; `tern.json.decode`. |
| `swarm_queue` | `~/Work/review-reports/<seat>-active-review-queue.json` (pending/active/seat2/completedCurrent buckets; `item`+`round` parsed off the `-rN` task suffix; `seat` = reviewer, from the file name); plus `~/.agenthop/swarm/review-queue/*.json` (future rows). | `tern.fs.list`, `tern.fs.read`, `tern.json.decode`. |
| `swarm_progress` | `~/.agenthop/swarm/PROGRESS.md` — the last *n* `## … #NNN(…)` cycle blocks; `lines` = that cycle's raw content lines. | `tern.fs.read` (whole file; parser keeps only the last *n* cycles in memory). |
| `swarm_flags` | **Authoritative runtime source:** the last `flags:` line of `~/.agenthop/swarm/dispatcher.log` (the dispatcher logs its live flag states). Fallback: the plugin process env. opt-out flags → `on` unless killed (`off`); opt-in flags (`TG_ENTRY`, `FANOUT`) → `dormant` until explicitly on. | `tern.fs.read`; `tern.getenv` (fallback). |

### §2 addendum — A8+context and A6+route

**① A8+context** — `tern.carly.context(fn)` registers a one-line swarm status for Carly:
`在审N|候裁M|告警K` (≤400 chars). The 4 ms budget forbids live computation, so `fn` only **reads a
KV cache** and formats the line. The cache (`tern.kv` key `counts = {review, ruling, alerts, ts}`) is
written by every `refresh()` (the 1-minute patrol tick, `window_start`, and the explicit command).
- `在审` = reviews with `state == "reviewing"`; `候裁` = reviews awaiting a ruling/merge = *total −
  reviewing* (there is no structured merge-pool source — `review-queue/` is empty and `board/*.json`
  are work items; documented as an assumption); `告警` = `*.json` count in `~/.agenthop/carly/alerts/`.
- **KV scope:** `tern.kv` persists to the plugin **data dir** (`<plugin.data>/kv.json`, i.e.
  `~/Library/Application Support/Tern/plugins/…`), **not** a new file under `~/.agenthop/carly/` — this
  honors contract §0 (only `canvas-snapshot.md` is writable there). (`tern.kv` is the data-dir
  mechanism; no manual data-dir path handling needed.)
- APIs: `tern.carly.context`, `tern.kv.get`/`tern.kv.set`.

**② A6+route** — `tern.route.link(fn)` claims `swarm://` link clicks (v1, two types):
- `swarm://file/<abspath>` → `return { path = abspath }` (Tern's built-in opens the durable file).
- `swarm://pane/<herdr-pane-id>` → resolve to a Tern pane and `cx.layout:focus`; `return {handled=true}`.
- non-`swarm://` url → `return nil` (Tern's built-in handles it — never claim others' links).
- unknown `swarm://` subtype → `cx:toast("error", …)` + `return {handled=true}` (surfaced, not swallowed).

  Every durable file/seat reference the A6 canvas + snapshot emit is written as a `swarm://` link
  (`[visible path](swarm://file/<abspath>)`); the visible label stays the plain path, so `cat`-ing the
  snapshot still shows the fact.

  **Pane resolution** (`swarm://pane/<id>`): a bare number → that Tern pane; otherwise the herdr pane id
  (e.g. `w1:p1`) is mapped to its terminal title via the `tern.kv` `paneMap` cache (written by
  `swarm_status` from the herdr snapshot) and resolved with `cx.session:resolve`. **Best-effort**: the
  herdr snapshot carries no Tern pane number, and the A1 bridge `agents.json` is currently empty
  (`{"agents":{}}`) — the swarm agents appear to run outside Tern today — so pane-focus is forward-looking
  (it works once the agents are Tern panes and `swarm_status` has populated `paneMap`); a failed resolve
  raises an error toast rather than focusing the wrong pane. File-open works today.
  APIs: `tern.route.link`, `cx.session:resolve`, `cx.layout:focus`, `cx:toast`, `tern.kv.get`.

### A6 snapshot / canvas

- `refresh(cx)` builds the Markdown (`snapshot.buildMarkdown` over cheap fs-only counts), writes it to
  `~/.agenthop/carly/canvas-snapshot.md` (**authoritative**), then mirrors it into the canvas pane
  (`cx.canvas:set` on the existing owned canvas, else `cx.canvas:open`).
- Triggers: `window_start` (cold-start render), the explicit palette command **"Swarm: refresh
  cold-start snapshot"** (`plugin.swarm-observatory.refresh`), and the 1-minute `tern.carly.schedule`
  check (`snapshot-check.luau`, deduped by title across reloads/windows).
- APIs: `tern.on("window_start")`, `tern.carly.schedule`/`tasks`/`cancel`, `cx.canvas:list/open/set`,
  `tern.command`, `cx:action`, `tern.fs.*`, `tern.timer`.

## Verify the plugin loads

```sh
tern plugin link /Users/wowdd1/Dev/agenthop-wt/tern-line2/tern/exports/swarm-observatory
tern plugin list --json      # expect: swarm-observatory -> "ready", problems: []
```

Result on this machine: **`swarm-observatory -> ready`, `problems: []`, `window=true`** (no load
errors). With a Tern window open, `window_start` writes `~/.agenthop/carly/canvas-snapshot.md` with
live data (verified: cycle #877, 6 active reviews, 4 claimed / 17 done, 13 on / 0 off / 1 dormant).

The live Carly export call (`await(plugins["swarm-observatory"].swarm_status())` etc.) is driven from
Carly — not scriptable from the CLI.

## Run the 16 KiB boundary fixture

```sh
bash test/run.sh        # needs lua 5.x or luajit (set LUA_BIN to override)
# or individually:
lua test/budget.test.lua
lua test/parse.test.lua
```

`budget.test.lua` proves, for each export shape (array end-drop, array keep-newest, map), that an
over-budget result is trimmed to ≤ 16384 bytes **and** carries `truncated:true` (with maximal
retention), and that a within-budget result is returned untouched with no flag. `parse.test.lua`
checks the parsers against the real captured data shapes. Both pass (0 failures).

## Enabling / backout

`tern plugin link …` registers the plugin in the user's Tern and (once a window runs it) arms a
durable 1-minute task **"swarm observatory snapshot"**. To back out:

```sh
tern plugin unlink swarm-observatory
```

then delete the **"swarm observatory snapshot"** task in **Tern → Settings → Carly → Scheduled**
(the scheduled task is durable and outlives an unlink; the check is a no-op once unlinked, but remove
it to keep the list clean).

## Assumptions / notes

- Manifest format, `require("./mod")`, and the `tern.carly.schedule` 1-minute check pattern were taken
  from the shipped `agenthop-agents-bridge` plugin and the embedded `plugin.toml` validation.
- `swarm_queue`: there is no single canonical review-queue projection; `review-queue/` is empty today,
  and `board/*.json` are *work* items (not reviews). The richest review-shaped source is the
  per-reviewer `*-active-review-queue.json`, so that is primary (generalized by file-name glob, not
  hard-coded to happycapy). `seat` = the reviewer seat.
- `swarm_flags`: the dispatcher.log line reports `on`/`off` only; the `dormant` state is applied to the
  two opt-in flags (`TG_ENTRY`, `FANOUT`) when not on. The full SWARM_* superset is larger; the
  runtime projection (what the dispatcher actually logged) is reported, not the superset.
- `ts` is epoch seconds via `os.time()` (falls back to a `tern.now()`-derived value if `os` is absent
  in the sandbox).
- `HERDR` defaults to `~/.local/bin/herdr` (override with `HERDR_BIN`); review-reports defaults to
  `~/Work/review-reports` (override with `SWARM_REVIEW_REPORTS`).
- Multi-window: the single deduped 1-minute task keeps the authoritative snapshot **file** fresh; other
  windows' canvas panes refresh on their own `window_start` / the explicit command.
