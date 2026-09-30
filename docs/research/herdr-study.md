# herdr study — orchestration ideas for agenthop

Design research on **herdr** (https://github.com/herdrdev/herdr), a terminal
workspace manager ("multiplexer") for AI coding agents. Goal: mine transferable
ideas for **agenthop** (a decentralized cross-tool session bus that does NOT own
PTYs). Sources: full shallow clone at `/tmp/herdr-study` (commit `331775c`,
2026-09-30), plus its bundled docs. All `file:line` cites are from that clone.

Repo facts (verified, not marketing):
- GitHub: **41,578 stars**, 3,203 forks, Apache-2.0, Rust, pushed 2026-09-30 (very active). `herdr` v0.9.3 (`Cargo.toml:3`).
- ~272k LOC Rust. It DOES own PTYs: `portable-pty` (vendored), an embedded terminal emulator (`ghostty-vt` crate + `src/pane/terminal.rs`, 264 KB), `ratatui` TUI. This is the core paradigm mismatch — see "What NOT to copy".
- Local control plane: `interprocess` local socket (`Cargo.toml:35`), env var `HERDR_SOCKET_PATH`. The **agent API is line-delimited JSON** over that socket (a hook sends `json.dumps(req)+"\n"`, `src/integration/assets/claude/herdr-agent-state.sh:126`). The client<->server *rendering* stream is a separate binary/bincode wire (`src/protocol/wire.rs`) — not the agent API.
- 22 agent detection manifests shipped (`distribution/agent-detection/index.toml`); `agent start --kind` supports 24 CLIs incl. claude, codex, opencode, cursor, gemini, grok, copilot (docs/agent-automation.mdx).

---

## TL;DR — ideas worth stealing

1. **Dual status source with a clean precedence rule.** herdr accepts a *self-reported* state (`working`/`idle`/`blocked`) over the socket AND, for tools that can't report, *scrapes* the terminal. agenthop already has the self-report half; steal the **precedence + safety-override + monotonic-seq** design, drop all scraping.
2. **Monotonic per-source sequence numbers make state reports idempotent and reorder-safe.** `--seq` must strictly increase per `--source`; stale/duplicate reports are dropped (`src/terminal/state.rs:1965`). This is the single most portable primitive. agenthop should require it on every status message.
3. **A real "wait until another agent is blocked/idle" primitive**, server-owned and *event-driven* (not polling), with **occupant pinning** so a replacement agent can't satisfy your wait, and **replay-from-sequence** to close the submit→wait race (`src/api/wait.rs:364`). agenthop's `recv`/notify layer should offer the same `wait --until <state>` semantics.
4. **`idle` vs `done` = "ready" vs "ready-and-not-yet-seen"** — a per-observer "seen" bit turns completion into a first-class, dedup-able notification (`completion_seq` vs `state_change_seq`, `src/app/actions.rs:1740`). Great fit for a bus that fans notifications to many peers.
5. **Extensibility with zero central release coupling:** any agent vendor adds first-class support *from their own code* by calling `pane report-agent` — "no PR to herdr, no waiting for a release" (docs/add-herdr-support.mdx). agenthop's node/hook model should be exactly this open.

---

## Q1. Status model (working / blocked / idle) — highest priority

**Two independent producers, merged with priority + safety override.**

### (a) Self-reported ("hook authority") — the portable path
An in-pane process calls `pane report-agent … --state working|idle|blocked --seq N --source <id> --agent <name> [--message …]` (docs/add-herdr-support.mdx). Handler: `src/app/api/panes.rs:1547` (`handle_pane_report_agent`). It maps to internal `AppEvent::HookStateReported` → `src/app/actions.rs:1491`.

Two source *classes* decide whether a report can set state:
- **Session-identity-only** sources (herdr's own `herdr:claude`, `herdr:codex` state path): return early and only record a resume/session ref — they do **not** override state (`src/terminal/state.rs:711`, `session_identity_only_integration`). For these, live state still comes from scraping.
- **Full-lifecycle** sources (a cooperating vendor using its own non-`herdr:` source): become the pane's `hook_authority` and their reported state wins (`set_hook_authority_at`, `src/terminal/state.rs:700-790`).

The shipped Claude/Codex hooks (`src/integration/assets/claude/herdr-agent-state.sh`) only report the **session id at `SessionStart`** (for resume) — NOT live state — because Claude Code has no reliable per-turn state hook. So **Claude's working/blocked/idle is scraped**, not self-reported. This is the key real-world nuance: herdr self-reports where it can, scrapes where it must.

### (b) Screen scraping — declarative TOML rule engine
Per-agent manifests: `distribution/agent-detection/*.toml`. Engine: `src/detect/manifest.rs`, `src/detect/mod.rs`. State enum `Idle|Working|Blocked|Unknown` (`src/detect/manifest.rs:219`).

Each `[[rules]]` entry has: `id`, `state`, integer `priority`, a `region` selector, matchers (`regex`/`line_regex`/`contains`/`any`/`all`/`not`), visibility flags (`visible_working`/`visible_blocker`/`visible_idle`), and `skip_state_update` (classify without changing state, e.g. transcript viewers). Highest-priority matching rule wins (`src/detect/manifest.rs:456-503`).

**Region** = which slice of the terminal snapshot a rule sees (parsed `src/detect/manifest.rs:1101-1114`, extracted `:1284-1296`): `osc_title`, `osc_progress`, `whole_recent`, `after_last_prompt_marker`, `whole_recent_without_current_prompt_marker`, `prompt_box_body`, `last_non_empty_above_prompt_box`, `after_last_horizontal_rule`, `top_non_empty_lines(N)`, `bottom_non_empty_lines(N)`. Manifests are versioned (`min_engine_version`) so new region kinds gate cleanly (`src/detect/manifest.rs:951`). Manifests are hot-reloadable at runtime (`server.reload_agent_manifests`).

**What the signals actually are** (from `claude.toml`/`codex.toml`):
- *working*: OSC-title spinner glyphs (braille `⠋⠙…`, half-circles), a live turn line with `esc to interrupt` + an elapsed timer `(12s)`, progress bars.
- *blocked* = "genuinely needs input": recognized approval/question UI — `do you want to proceed?` + a `❯`/`1. Yes` option row + `esc to cancel`; MCP elicitation dialogs; trust-directory prompts. Heavily guarded with `not`-clauses so user-typed text can't impersonate a prompt (e.g. `claude.toml` `bash_permission_prompt`, `generic_permission_prompt`).
- *idle*: an empty prompt box `❯` with none of the blocker hints present.

So "blocked vs idle" is decided by matching the specific approval-UI shape, not a timer. There is **no** "idle too long ⇒ blocked" heuristic.

### (c) Reliability heuristics (worth copying regardless of scraping)
- **Idle debounce:** a `working → idle` flip is *held* until confirmed 3× within a 700 ms cap (100 ms recheck), to kill flapping when a tool briefly clears its status line (`PendingIdleConfirmation`, `src/pane/agent_detection.rs:24-79`).
- **Startup grace window** 3 s; **stable-signal refresh** 800 ms (`src/pane/agent_detection.rs:8-12`).
- **Safety override:** a *scraped* visible blocker overrides a *hook-reported* `working` (and fires the notification) — test `visible_blocker_overrides_hook_working_and_notifies` (`src/app/actions.rs:3879`). Screen-visible "needs you" always wins.
- **Per-CLI quirks exist:** e.g. `Unknown` is treated as a stable resting state only for Codex (`src/pane/agent_detection.rs:92`); Codex uses a distinct `min_engine_version=3` region (`top_non_empty_lines`). Detection is meaningfully tool-specific.

**Reliability verdict:** the self-report path is exact; the scrape path is a best-effort, per-CLI, regex-brittle layer that they actively version and patch (see CHANGELOG churn around prompt shapes). `unknown` is an explicit "present but can't classify" escape hatch and, per docs, "does not prove completion."

---

## Q2. Agent-facing API (spawn / prompt / wait-until-blocked)

Raw socket methods are dot-namespaced; CLI wraps them 1:1 (docs/socket-api.mdx "Raw methods"). Relevant surface:

Agent lifecycle: `agent.start`, `agent.prompt`, `agent.wait`, `agent.read`, `agent.send_keys`, `agent.list`, `agent.get`, `agent.explain`, `agent.rename`, `agent.focus`. Pane/raw-terminal: `pane.split/run/send_text/send_keys/read/wait_for_output`. Self-report: `pane.report_agent`, `pane.report_agent_session`, `pane.release_agent`, `pane.clear_agent_authority`. Events: `events.subscribe`, `events.wait`. Bootstrap cache: `session.snapshot`.

CLI equivalents (docs/agent-automation.mdx, skills/herdr/SKILL.md):
```
herdr agent start reviewer --kind codex --pane w1:p2 -- -m gpt-5.4
herdr agent prompt reviewer "Review the diff" --wait --until idle --timeout 120000
herdr agent wait reviewer --until blocked --timeout 120000
herdr agent read reviewer --source recent-unwrapped --lines 120
herdr agent send-keys reviewer esc
```
States accepted by `--until`: `idle`, `done`, `blocked`, `unknown` (repeatable). Default set = `idle,done,blocked`.

**The "wait until blocked/idle" primitive — how it's built** (`src/api/wait.rs`):
- Server-owned, **event-driven long-lived request** (docs: "server-owned and event-driven"), not client polling. `wait_for_resolved_agent` (`:364`) loops over `event_hub.events_after(last_event_sequence)` and reacts to `PaneAgentStatusChanged` / `PaneAgentDetected` / pane-close/move events, then probes `agent.get` to confirm.
- **Race-free submit+wait:** `agent.prompt --wait` captures `last_event_sequence` *before* sending input (`:219`) and waits from there, so a state change between submit and wait isn't missed. It also gates on `after_state_change_seq = prompt_state_change_seq` (`:249,274`) so unrelated prior `idle` can't satisfy the wait; after submit it requires observing `working|blocked` within 5 s or returns `agent_prompt_stalled`.
- **Occupant pinning:** the wait pins the resolved pane's `terminal_id` + name + agent kind; if a *different* agent takes the pane, it returns `agent_not_running` rather than falsely matching (`src/api/wait.rs:377-421`). Directly relevant to agenthop where a session handle must not be satisfied by a restarted/replaced session.
- **Sequences:** `state_change_seq` (monotonic per transition) and `completion_seq` (set only when an idle transition is genuine completed work, not startup/session-switch) — `src/app/actions.rs:1740-1745`, surfaced on agent records `src/app/agents.rs:397`.
- `agent.prompt` refuses an already-`blocked` agent with `agent_blocked` (no input sent) — forces the caller to inspect and use `send_keys` deliberately.

---

## Q3. Extensibility — adding a new agent CLI

**Two independent mechanisms; status detection is part of the contract in both.**

1. **Built-in detection manifest (no code):** drop a `distribution/agent-detection/<id>.toml` with `[[rules]]`, register it in `index.toml`. Versioned (`version`, `min_engine_version`, `updated_at`), hot-reloadable (`server.reload_agent_manifests`). This is pure screen-scraping config — the contract is "write regexes that classify your TUI's states per region." Brittle but requires nothing from the agent.

2. **Self-report from the agent's own code (recommended, no herdr PR):** the agent detects `HERDR_ENV=1` + `HERDR_SOCKET_PATH`/`HERDR_PANE_ID`/`HERDR_BIN_PATH` (injected into every pane process) and calls three things (docs/add-herdr-support.mdx):
   - `pane report-agent … --state <s> --seq <n> --source <id> --agent <name>` on every state change,
   - `pane report-agent-session … --agent-session-id … -- <resume argv>` (resume command),
   - `pane release-agent …` on exit.
   Rules of the contract: `--seq` strictly increases per `--source` forever (timestamp works); `--source` is stable/unique and must not start with `herdr:`; resume argv is validated (plain command name on PATH, no apostrophes/control chars, ≤64 args / ≤8 KiB, else `invalid_resume_argv`); you must hold the pane (send a state report) before a resume command is accepted (`resume_not_accepted`, `src/app/api/panes.rs:1681`). Reference implementations live in `src/integration/assets/<agent>/herdr-agent-state.{sh,ps1,js}`.

**Contract essence for agenthop:** identity (`source`+`agent`+session id) + ordered state (`seq`) + resume command + release. Status *is* the contract.

---

## Q4. Layout / window & pane model (for comparison — agenthop uses an external WM)

- Hierarchy: **machine → workspace → tab → pane**, panes tiled as a **BSP tree** of `pane` and `split` nodes (`direction: right|down`, `ratio`, `first`, `second`). Public IDs `w1`, `w1:t1`, `w1:p1`, opaque and non-reused.
- Declarative import/export: `layout.export` returns the portable tree; `layout.apply` builds a fresh tab from a tree (labels, cwd, env, optional argv per pane) but does **not** preserve live PTYs; `layout.set_split_ratio` tweaks one split (docs/socket-api.mdx). Code: `src/workspace/tab.rs`, `src/pane/`, snapshots in `src/persist/snapshot.rs`.
- Zoom, swap (same-tab, preserves ids/processes), move (cross-tab/workspace assigns a new pane id but keeps the process alive). Worktree = a git checkout mapped to a workspace (`worktree.create/open/remove`).

For agenthop this is mostly *not* applicable — OmniWM owns geometry and Ghostty owns the surface. The transferable bit is the **declarative layout tree as data** (export/apply) if agenthop ever wants to persist "which sessions in which OS windows."

---

## Q5. Cross-machine / federation

- **Transport = SSH.** Each machine runs its **own independent herdr server**; a lost link to one doesn't drop others (docs/connecting-machines.mdx). herdr requests SSH compression, reuses OpenSSH `ControlMaster`/`ControlPersist 600` connections when `remote.manage_ssh_config=true`. Code: `src/remote/attach.rs` (198 KB), `saved.rs`, `ssh_agent.rs`, `restart_policy.rs`, `host.rs`.
- **Auth is fully delegated to OpenSSH** — herdr stores only an opaque profile (id, label, SSH target, remote session name, enabled bit); no keys/passwords/tickets. Host-key checking unchanged.
- **Aggregation:** the client keeps each machine's connection independent and shows a **combined agent list**; only the *selected* machine streams pane screens, others just push agent state + notifications.
- **Addressing remote agents:** IDs and names are **scoped per server** (two machines can both have `w1:p1` / an agent `reviewer`). You target a machine explicitly: `herdr --machine <label-or-id> agent list|prompt …`. Selecting a machine in the TUI does *not* retarget CLI commands running inside a pane.
- **Discovery:** `herdr machine add <host>` probes running remote sessions over SSH; there is no zero-config LAN discovery — it's SSH-config-driven.

Contrast with agenthop: herdr federation is **hub-per-machine over SSH with explicit machine selectors**, whereas agenthop aims for auto-discovery + a relay. herdr's useful lesson is the **per-server ID scoping + explicit machine-qualified addressing** (agenthop's handles already do this) and **treating auth as entirely the transport's problem**.

---

## Q6. Lifecycle / persistence — what survives

Four distinct paths (docs/session-state.mdx; code `src/persist/`):
1. **Live detach/reattach (strongest):** server keeps running; PTYs, shells, agents all survive; screen returns from the live terminal. `ctrl+b q` detaches.
2. **Snapshot restore (server restart):** processes are GONE; only **layout** (workspaces/tabs/panes/cwd/focus) is rebuilt from `session.json`. Panes come back as fresh shells in their saved dirs. Up to 48 rolling snapshots in `session-snapshots/` (≥15 min apart), failed-load originals preserved in `session-backups/` (`src/persist/snapshot.rs`, `restore.rs`, `writer.rs`, `io.rs`).
3. **Native agent session restore (opt-in-ish, on by default):** after a server restart herdr re-runs the agent's **reported resume command** (e.g. `claude --resume <id>`, `codex resume <id>`) in the saved dir — reconstructs the *conversation*, not the process. Per-agent min integration versions table in the doc.
4. **Pane screen-history replay:** opt-in (`[experimental] pane_history=true`), stored in `session-history.json`, replayed only if layout matches exactly (secrets warning).
5. **Live handoff (experimental):** on update/remote-attach, the old server transfers live PTYs to the new one so processes survive a binary swap; transient state (in-flight waits, subscriptions, pane-to-pane msgs) is dropped and clients must reconnect/retry.

**Persists vs resumed:** layout + cwd + agent *session references* + resume argv persist to disk; running processes only persist via live-detach or handoff. Everything else is *resumed* (new process, possibly resumed conversation) or lost.

---

## Portability to agenthop (we do NOT own PTYs)

| herdr idea | Transfers? | How, given no PTY ownership |
| --- | --- | --- |
| Self-reported state `working/idle/blocked` over local socket | **Yes, easy** — this is agenthop's native model already. Each bus node reports its tool's state from a hook/event, exactly like `pane report-agent`. | Adopt the API shape: `state`, `source`, `agent`, `message`, `seq`. |
| **Monotonic per-source `seq`, drop-if-not-newer** | **Yes, easy — highest value.** Makes reports idempotent + reorder-safe with no locking. | Require a strictly-increasing seq (timestamp ns) on every status message; ignore `<= last`. `src/terminal/state.rs:1965`. |
| **`wait --until <state>`, event-driven, occupant-pinned, replay-from-seq** | **Yes, medium.** agenthop already has recv/notify; add a first-class "wait until peer reaches state X" that pins the *session identity* so a restarted session doesn't falsely satisfy it, and replays from a captured event seq to avoid the submit→wait race. | Model on `src/api/wait.rs:364`. Pin on agenthop's stable session handle, not a terminal id. |
| **`idle` vs `done` (seen bit) + `completion_seq`** | **Yes, easy and valuable for a bus.** Turns "turn finished" into a dedup-able, per-observer notification — perfect when many peers watch one session. | Track a per-observer "seen" and a completion sequence distinct from state-change sequence. |
| **Idle debounce (3 confirmations / 700 ms) + startup grace** | **Yes, easy.** Even self-reported states flap (tools emit transient idle between tool calls). | Debounce `working→idle` before broadcasting; keep it in the bus node or broker. |
| **Safety override (visible blocker beats reported working)** | **Partial.** We have no screen to scrape, so there's no independent signal to override a lying node. | The only agenthop analog: trust the node, but let a *user* or a secondary signal (e.g. a "needs approval" hook event) force `blocked`. Don't build screen-scraping to get it. |
| **Extensibility = report from your own code, no central PR** | **Yes — this is the philosophy to copy wholesale.** | Keep agenthop nodes/hooks open: any tool ships a small reporter; agenthop never needs a per-tool release. |
| Declarative layout export/apply (BSP tree as data) | **Optional.** Only if agenthop wants to persist "which sessions in which OS windows." | Store a small JSON layout doc; let OmniWM/AppleScript reconstruct. |
| SSH-per-machine federation + machine-qualified addressing | **Partially.** agenthop uses a relay + auto-discovery, not SSH hubs. Keep only the **per-server/per-machine ID scoping + explicit qualified handles** (already present). | Don't adopt SSH-hub topology; do keep "auth is the transport's problem." |
| Resume-command persistence | **Yes, conceptually.** A node can report the command that re-opens its session so agenthop can respawn it into a fresh Ghostty window after a crash. | Persist `{cwd, resume argv, session id}`; on respawn, run it via AppleScript into a new pane. Mirror herdr's argv validation. |

---

## What NOT to copy (paradigm conflicts)

- **PTY ownership / terminal emulation.** herdr *is* a multiplexer — it forks the agent, owns the PTY, runs a full VT emulator (`ghostty-vt`, `src/pane/terminal.rs` 264 KB) and a `ratatui` TUI. agenthop deliberately owns none of this; adopting it would rebuild tmux. Skip entirely.
- **Screen scraping for status.** The whole `src/detect/` engine + per-CLI TOML regex manifests exist *only because* herdr can read the pixels/cells. With no PTY, agenthop can't and shouldn't scrape. Rely on self-report; the regex manifests are a maintenance treadmill (constant CHANGELOG churn chasing prompt-string changes) we avoid by design.
- **Central server that owns processes.** herdr's persistence/handoff complexity (`src/persist/`, live handoff, snapshot rotation) flows from one server owning all processes on a machine. agenthop is decentralized: sessions are owned by their own tools, the broker only routes. Don't centralize lifecycle.
- **Client<->server binary rendering protocol** (`src/protocol/wire.rs`, surface deltas, kitty graphics). That's for streaming terminal frames — irrelevant to a message bus.
- **SSH-hub federation topology** as the primary transport (see Q5). Keep agenthop's relay/auto-discovery instead.

Net: steal the **status/report/seq/wait/seen** control-plane semantics; leave the **terminal-multiplexer substrate** behind.
