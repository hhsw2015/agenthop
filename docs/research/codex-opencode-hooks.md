# Codex & OpenCode status-hook integration contracts

Research for agenthop Slice-B auto status-reporting. Target machine: **codex-cli 0.159.2**, **OpenCode 1.18.33** (`@opencode-ai/plugin` / `@opencode-ai/sdk` **1.18.26**).

Primary sources used (local, authoritative):

- Live Codex hook capture in an isolated `CODEX_HOME` (empirical stdin payload) — see PART A.
- `strings` on `/Users/wowdd1/.local/bin/codex` (crates `codex_hooks`, `codex_external_agent_migration`).
- Real `~/.codex/config.toml` (`[features]`, `[hooks.state]`) and `~/.codex/hooks.json`.
- A real rollout file `session_meta` header (id semantics).
- agenthop source: `packages/bus/src/{mcp,core,codex,opencode-plugin}.ts`.
- `@opencode-ai/plugin` `dist/index.d.ts` and `@opencode-ai/sdk` `dist/gen/{types,sdk}.gen.d.ts`.

---

## TL;DR

**Codex — YES, can be done cleanly (hooks.json).** Codex adopted Claude Code's hook system verbatim: same JSON schema, same event names, **payload delivered on stdin as JSON**, field `session_id`. Recommended wiring:

- `PermissionRequest` hook (with `"async": true`) → report `blocked`.
- `Stop` hook → report `idle` (turn end). Optionally `SessionEnd` → leave/idle on close.
- Each hook command runs `agenthop report-status <state> --session <id>` where `<id>` is read from **stdin JSON `session_id`**.
- **Critical identity result (empirically confirmed): the hook's `session_id` IS the thread id that agenthop publishes as `stableId`.** Same UUID as the rollout filename, the TUI "session id", and `x-codex-turn-metadata.thread_id`. No bridging needed. (`turn_id` is a *different* per-turn UUID — do not key on it.)
- Enable with `[features]\nhooks = true` in `config.toml`. hooks.json lives at `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`), is JSON, merge-friendly.
- **Deployment gotcha:** Codex requires per-hook *trust*. A freshly written/edited hooks.json will not run until the user approves trust once (interactive) or `--dangerously-bypass-hook-trust` is passed. agenthop's installer must surface this.

**OpenCode — YES, can be done cleanly, fully in-process.** The plugin already returns a `Hooks` object with an `event` handler (currently only handles `session.deleted`). Extend that same handler:

- `session.idle` → `idle`; `permission.updated` → `blocked`; `permission.replied` → back to `working`; `session.status`(busy) / `tool.execute.before` / `message.*` → `working`.
- Every session-scoped event carries `properties.sessionID` (or `Permission.sessionID`); call the existing `setStatus(busFor(sessionID), state)`. No external hook, no file, no SSE needed. (`client.event.subscribe()` exists as an SSE fallback but is unnecessary.)

---

## PART A — Codex `~/.codex/hooks.json`

### A1. Exact schema + available hook events

hooks.json is **JSON** and uses the **Claude Code hook schema verbatim**. Empirically-verified working file (an isolated `CODEX_HOME` with this file ran the hook):

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "",
        "hooks": [ { "type": "command", "command": "<cmd>", "timeout": 10, "async": true } ] }
    ],
    "Stop": [
      { "matcher": "",
        "hooks": [ { "type": "command", "command": "<cmd>", "timeout": 10 } ] }
    ]
  }
}
```

Top-level `"hooks"` → map of **EventName → array of matcher-groups**; each group has `"matcher"` (string; `""` = all) and `"hooks"` → array of hook entries. Hook entry fields: `"type": "command"`, `"command"` (string), `"timeout"` (seconds), optional `"async"` (bool). The real `~/.codex/hooks.json` on this machine (written by the "annotate" tool) is exactly this shape with `PreToolUse`/`Stop`/`SessionEnd`.

**Full event list** (from the binary's `HookEventNameWire` enum): `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`. (snake_case forms — `pre_tool_use`, `permission_request`, `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `session_end`, `user_prompt_submit`, `subagent_start`, `subagent_stop` — appear in the trust-state keys.)

For agenthop:
- **`PermissionRequest` → `blocked`** (an approval/permission is being requested). Confirmed valid event name.
- **`Stop` → `idle`** (the agent finished its turn). Confirmed valid event name. This is the direct analogue of Claude Code's `Stop`.
- `SessionEnd` fires when the session closes (process exit) — useful to drop the peer.
- `SessionStart` (`source: "startup"|...`) fires at session open — useful to announce/seed `working`.

### A2. The `async` requirement (non-blocking PermissionRequest)

`async` is a **per-hook boolean field** on the hook entry (sibling of `type`/`command`/`timeout`). Confirmed in the binary's hook-definition struct, where the field sequence is `… handler_type  async  execution_mode  run_session_end_hooks …`, and the engine's `execution_mode` enum carries the values `sync` | `async`. Default is **sync** (Codex waits for the hook to return, which for `PermissionRequest` blocks the approval UI). `"async": true` makes it fire-and-forget (non-blocking).

- Empirically: `{"type":"command","command":"…","timeout":10,"async":true}` was accepted and the hook fired normally.
- Caveat I could not eliminate: hooks.json parsing is **lenient** (an unknown field `zzzbogus` was silently ignored and the hook still ran), so "it was accepted" alone does not prove recognition — but the binary struct does. I did **not** live-test the blocking-vs-nonblocking *difference* on a real approval prompt (hard to trigger non-interactively in `codex exec`). **Recommendation: always set `"async": true` on the `PermissionRequest` hook** so a slow/hung `agenthop report-status` can never stall the user's approval UI. For `Stop` it is less critical but still advisable.

### A3. How the hook command learns the session id — STDIN JSON (empirically proven)

The payload is written to the hook command's **stdin as a single JSON object**. Not argv, not env.

Live capture (isolated `CODEX_HOME`, `SessionStart` hook, stdin dumped verbatim):

```json
{"session_id":"01a0f4b9-51b6-7c53-82e2-15c5bf957e35",
 "transcript_path":".../rollout-2026-10-01T07-49-40-01a0f4b9-51b6-7c53-82e2-15c5bf957e35.jsonl",
 "cwd":"/private/tmp",
 "hook_event_name":"SessionStart",
 "model":"gpt-6.1-sol",
 "permission_mode":"bypassPermissions",
 "source":"startup"}
```

Corroboration: the binary string `failed to write hook stdin:` (codex writes to the child's stdin); and **no** `CODEX_*` session/thread env var exists in the hook's environment (only `CODEX_HOME`, `CODEX_SQLITE_HOME` were present — verified by dumping `env` inside the hook). So the command **must read its own stdin** and parse `session_id` (plus `hook_event_name`, `tool_name`, etc.).

Payload fields by event (SessionStart fields proven above; the rest from the binary's `*CommandOutputWire`/input structs — same stdin channel):
- Common: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `model`.
- `SessionStart`: + `source` (`startup` | …).
- `PreToolUse` / `PermissionRequest` / `PostToolUse`: + `tool_name`, `tool_input`, `tool_use_id` (and `tool_response` on PostToolUse); `PermissionRequest` also relates to `turn_id`.
- `Stop` / `SubagentStop`: + `stop_hook_active`, `last_assistant_message`; subagent events + `agent_type` / `agent_id`.
- `UserPromptSubmit`: + `trigger`.

(Hooks may optionally *return* a JSON decision on stdout — `PermissionRequestDecisionWire{behavior: approve|block, updatedInput, updatedPermissions}`, `PreToolUseHookSpecificOutputWire{permissionDecision: allow|deny|ask, …}`, etc. For status reporting, **ignore this** — emit nothing.)

### A4. Identity match — hook `session_id` == agenthop `stableId` (CONFIRMED)

This was the make-or-break question. **They are equal.** Evidence chain:

1. **Hook payload** `session_id = 01a0f4b9-…` (A3).
2. **TUI banner** for the same run printed `session id: 01a0f4b9-…`.
3. **Rollout filename** for the same run embeds the same UUID: `rollout-…-01a0f4b9-….jsonl`.
4. **Rollout `session_meta` header** (a real older rollout) shows the id is one UUID under multiple names:
   `"session_id":"01a0718d-…"`, `"id":"01a0718d-…"` (identical), and the filename embeds `01a0718d-…`. `turn_id` is a **different** UUID (`01a0718d-719f-…`), per turn.
5. **agenthop's own stableId source** (`packages/bus/src/mcp.ts:235-236`):
   ```ts
   const tm = meta?.["x-codex-turn-metadata"] as { thread_id?: string; session_id?: string } | undefined;
   const tid = tm?.thread_id ?? tm?.session_id;
   ```
   i.e. agenthop adopts `thread_id` (fallback `session_id`) from turn metadata as `ownCodexThread`, which becomes `self.stableId` (`core.ts` `learnStableId`). The daemon path (`codex.ts`) keys threads by the same `threadId`/`id`. Rollouts are keyed by this UUID (binary: `no rollout found for thread id …`).

So Codex uses **one UUID per conversation**, exposed as `session_id` == `id` == `thread_id` == rollout-filename id == TUI "session id" == agenthop `stableId`. **A hook that writes a status file keyed by stdin `session_id` matches exactly what the bus node watches.** `turn_id` must NOT be used as the key.

> Minor version note: `thread`/`session` terminology is being unified in current Codex; the value is identical today (0.159.2). If a future version ever diverges `session_id` from `thread_id`, agenthop already prefers `thread_id` from turn metadata, so the hook should also read `session_id` (the only id in the hook payload) and the bus's `thread_id` must continue to equal it — worth a guard/regression check on upgrade.

### A5. Execution model (cwd, timeout, stdout/exit, side-effect-only, substitution)

- **cwd**: the hook runs in the **session's working directory** (empirical: `cwd` was `/private/tmp`, the exec cwd). The payload also carries `cwd` explicitly, so don't rely on `process.cwd()` — read it from stdin if needed.
- **Shell**: the `command` string is run via a shell (`-lc` seen in the binary's `command_runner`). So normal shell quoting applies.
- **timeout**: per-hook, in **seconds** (`"timeout": 10`). Codex prints `hook: <Event>` / `hook: <Event> Completed` to stderr around execution.
- **stdout / exit code**: for status reporting, make the hook **side-effect-only** — exit `0` and print nothing. (Non-zero/`block` decisions only matter for PreToolUse/PermissionRequest control flow, which we don't want to touch.) Combined with `"async": true`, the hook cannot interfere with Codex.
- **Variable substitution: NONE.** There is no `${session_id}`-style templating in the `command`. The command must read stdin and parse the JSON itself. (So the agenthop hook is e.g. a tiny wrapper: `agenthop report-status-from-stdin` that reads stdin, extracts `session_id` + `hook_event_name`, maps to a state, and writes `~/.agenthop/status/<session_id>.json`.)

### A6. Enabling + merging

- **Enable the feature** in `config.toml` (TOML): under `[features]`, `hooks = true`.
  Empirically required: a top-level `hooks = true` fails with `invalid type: boolean true, expected struct HooksToml` (the top-level `[hooks]` table is reserved for trust state). The real config has:
  ```toml
  [features]
  hooks = true
  ```
- **hooks.json is JSON** at `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`; `CODEX_HOME` overrides — this machine also uses `/Volumes/Share/agent-data/codex/hooks.json`). Merge by adding entries under `hooks.<Event>[].hooks[]` without clobbering existing groups (the installed file already stacks multiple consumers under `PreToolUse`/`Stop`/`SessionEnd`).
- **Hook trust (critical for install):** Codex records a `trusted_hash` per hook in `config.toml`:
  ```toml
  [hooks.state."<hooks.json path>:<event_snake>:<group_idx>:<hook_idx>"]
  trusted_hash = "sha256:…"
  ```
  Editing hooks.json changes the hash → the hook is **untrusted and will not run** until re-approved (interactive prompt) or run with `--dangerously-bypass-hook-trust`. agenthop's installer should either (a) instruct the user to approve the hook once, or (b) document the bypass flag for automation. There is no supported way to pre-seed trust without the correct sha256.

### A7. `notify` program as an idle-only fallback

`config.toml` key `notify` is a **TOML array**: `notify = ["<program>", "<arg1>", …]` (this machine chains one via a wrapper). Codex runs `program + configured args + <json-payload-as-LAST-argv-arg>`, **stdin null** (the documented Codex `notify` contract; distinct from hooks, which use stdin — the latter I proved empirically).

The `agent-turn-complete` notify payload (binary string set) carries: `thread-id`, `turn-id`, `cwd`, `client`, `input-messages`, `last-assistant-message`, plus `type`. **It does carry `thread-id`** (hyphenated keys) == the same UUID == agenthop `stableId`. So notify *can* key correctly.

Viability: a usable **idle-only** fallback (fires on turn end → `idle`). Limitations vs hooks: (1) only one `notify` program is allowed, so agenthop would have to *chain* any existing one (the machine already does this), fragile; (2) no `blocked` signal (no permission event); (3) payload-as-argv, not stdin. **Prefer hooks.json; use `notify` only if hooks are unavailable/disabled.**

---

## PART B — OpenCode plugin event subscription

The plugin is `AgenthopBusPlugin = async ({ client, directory }) => ({ tool, event, ... })`. The returned object is typed `Hooks` from `@opencode-ai/plugin` (v1.18.26, `dist/index.d.ts`).

### B1. Plugin `Hooks` API (what the returned object supports)

Besides `tool`, the `Hooks` interface supports (exact keys + signatures from `dist/index.d.ts`):

```ts
interface Hooks {
  dispose?: () => Promise<void>;
  event?: (input: { event: Event }) => Promise<void>;          // <-- all server events, in-process
  config?: (input: Config) => Promise<void>;
  tool?: { [key: string]: ToolDefinition };
  auth?: AuthHook;
  provider?: ProviderHook;
  "chat.message"?: (input: { sessionID: string; ... }, output) => Promise<void>;
  "chat.params"?:  (input: { sessionID; agent; model; ... }, output) => Promise<void>;
  "chat.headers"?: (input: { sessionID; ... }, output) => Promise<void>;
  "permission.ask"?: (input: Permission, output: { status: "ask"|"deny"|"allow" }) => Promise<void>;
  "command.execute.before"?: (input: { command; sessionID; arguments }, output) => Promise<void>;
  "tool.execute.before"?: (input: { tool; sessionID; callID }, output: { args }) => Promise<void>;
  "tool.execute.after"?:  (input: { tool; sessionID; callID; args }, output: { title; output; metadata }) => Promise<void>;
  "shell.env"?: (input: { cwd; sessionID?; callID? }, output) => Promise<void>;
  // experimental.* (compaction, text.complete, tool.definition, …)
}
```

So the names you asked about: `event` ✔, `"tool.execute.before"` ✔, `"tool.execute.after"` ✔ exist. There is **no `"permission.asked"` hook name**; the dedicated hook is **`"permission.ask"`** (input is a `Permission`, has `sessionID`). The broad `event` hook is the one that also delivers permission/idle/status events.

The agenthop plugin **already** uses this: it returns an `event` handler (currently only `session.deleted` cleanup) and `"chat.message"` (`opencode-plugin.ts:323-337`). Extending the existing `event` handler is the recommended, minimal change.

### B2. Event → state map (exact event `type` strings + payloads)

The `event` hook receives the v1 SDK `Event` union (`@opencode-ai/sdk/dist/gen/types.gen.d.ts`). Each event is `{ type: "<dotted>", properties: {...} }`. Relevant members:

| agenthop state | event `type` | `properties` shape | notes |
|---|---|---|---|
| `idle` | `session.idle` | `{ sessionID: string }` | `EventSessionIdle`. Turn finished. |
| `blocked` | `permission.updated` | `Permission` (see below; has `sessionID`) | `EventPermissionUpdated`. A permission was raised/awaiting. |
| `working` (resume) | `permission.replied` | `{ sessionID, permissionID, response }` | `EventPermissionReplied`. Approval answered → back to work. |
| `working` / `idle` | `session.status` | `{ sessionID, status: SessionStatus }` | `EventSessionStatus`. `status.type` ∈ `"idle"` \| `"busy"` \| `"retry"` → busy=working. |
| `working` | `message.updated` / `message.part.updated` / `tool.execute.before` | each has `sessionID` | optional finer-grained "is actively working" signals |
| (cleanup) | `session.deleted` | `{ info: { id } }` | already handled |

`Permission` payload (`types.gen.d.ts`):
```ts
type Permission = { id: string; type: string; pattern?: string|string[];
  sessionID: string; messageID: string; callID?: string;
  title: string; metadata: {...}; time: { created: number } };
```
`SessionStatus` = `{type:"idle"} | {type:"retry"; attempt; message; next} | {type:"busy"}`.

Minimal recommended mapping inside the existing `event` handler:
```ts
event: async ({ event }) => {
  const p: any = event?.properties;
  switch (event?.type) {
    case "session.idle":       if (p?.sessionID) setStatus(busFor(p.sessionID), "idle"); break;
    case "permission.updated": if (p?.sessionID) setStatus(busFor(p.sessionID), "blocked"); break;
    case "permission.replied": if (p?.sessionID) setStatus(busFor(p.sessionID), "working"); break;
    case "session.status":
      if (p?.sessionID) setStatus(busFor(p.sessionID), p.status?.type === "busy" ? "working" : "idle");
      break;
    case "session.deleted": /* existing cleanup */ break;
  }
}
```
(`setStatus(b, state)` and `busFor(sessionID)` already exist in the plugin; `AgentStatus = "working"|"idle"|"blocked"|"unknown"`, `label.ts:43`.)

> Which permission signal: prefer the **`event`-based `permission.updated`/`permission.replied`** pair over the dedicated `"permission.ask"` hook. `"permission.ask"` is intended to *decide* a permission (its `output.status`) and is synchronous; using `event` keeps agenthop purely observational and non-interfering. If you want the clearest "working" baseline, also set `working` on `chat.message` (already creates the bus) or `tool.execute.before`.

### B3. SSE alternative (`client.event.subscribe`)

Not needed, but available. The passed `client` (`PluginInput.client`, `createOpencodeClient`) exposes:
```ts
client.event.subscribe(options?) : Promise<ServerSentEventsResult<...>>   // GET /event
```
(`@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:375`; endpoint `"/event"`, and a `"/global/event"` variant). It streams the **same `Event` union** as the in-process hook. Use only if you ever run the bus **out-of-process** against `opencode serve`; for the loaded plugin, the in-process `event` hook is strictly simpler (no reconnect/backpressure handling) and is already wired.

### B4. Attribution (per-session)

Every session-scoped event carries its own `sessionID` in `properties` (and `Permission.sessionID` for permission events), so each event maps to exactly one session. The plugin already keys per-session buses via `busFor(sessionID)` (sets `stableId: sessionID`, `opencode-plugin.ts:291-315`) and `ToolContext.sessionID` for tool calls. OpenCode child/sub-agent sessions get their own `sessionID` in their events, so each updates its own peer correctly. No cross-session leakage.

---

## Residual uncertainties / version flags

- **Codex `async` blocking behavior** on a *real* approval prompt was not live-reproduced (hard to trigger in non-interactive `codex exec`); the field's existence is confirmed in the binary and `async:true` runs fine. Set it on `PermissionRequest` regardless.
- **Codex non-SessionStart payload fields** (`tool_name`, `turn_id`, `stop_hook_active`, …) are taken from the binary wire structs, not each live-captured; `session_id` + `hook_event_name` + stdin delivery are live-proven and are all agenthop needs.
- **Hook trust** (A6) is the main install friction — needs user approval or the bypass flag.
- **OpenCode `session.status` emission frequency** depends on the server version; `session.idle` + `permission.updated`/`replied` are the reliable core. All event `type` strings here are from the installed 1.18.26 generated types.
