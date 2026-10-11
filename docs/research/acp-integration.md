# ACP (Agent Client Protocol) Integration Study for agenthop

Status: FINAL (all empirical probes completed on this machine)
Date: 2026-10-01
Scope: ACP by Zed Industries (agentclientprotocol.com) — the editor<->agent JSON-RPC protocol.
NOT IBM's "Agent Communication Protocol", NOT Google A2A.

Decision this informs: bus.7 headless/invisible spawn + auto-task. Lazy baseline backend =
native non-interactive exec (`claude -p`, `codex exec`, `opencode run`). ACP was flagged as an
OPTIONAL alternative backend where agenthop acts as the ACP CLIENT, spawns the agent as an ACP
subprocess, drives it programmatically, and gets structured streaming + native permission handling.

---

TL;DR: ACP v1 (integer protocolVersion 1) is stdio ndjson JSON-RPC; a client drives one agent:
`initialize` -> `session/new {cwd, mcpServers}` -> `session/prompt` -> stream of
`session/update` notifications (message/thought chunks, tool_call/tool_call_update with
pending/in_progress/completed/failed, plan, usage) -> response `{stopReason}`; the agent asks
approval via the client method `session/request_permission` (auto-approve is spec-sanctioned);
cancel = `session/cancel` notification -> stopReason `cancelled`. All four local tools are
reachable over ACP TODAY (OpenCode + the Claude and Codex adapters verified end-to-end on this
machine; Gemini handshakes but its personal-oauth backend is cut off). RECOMMENDATION (sec 6):
bus.7 ships native-exec headless + an extended-handoff task envelope; ACP is the designed-for
bus.8 opt-in backend behind a `backend:"acp"` interface seam. Sources: agentclientprotocol.com
v1 pages (overview, initialization, session-setup, prompt-turn, tool-calls), npm metadata of
@agentclientprotocol/{sdk,claude-agent-acp,codex-acp} + acpx, the SDK 1.5.1 tarball's shipped
examples/types, local binaries, and live stdio probes (/tmp/acp-e2e/drive.mjs).

## 0. Local machine inventory (empirical, 2026-10-01)

Checked on this machine (macOS, Darwin 27):

| Tool | Installed version | ACP support found |
|---|---|---|
| Claude Code (`claude`) | 2.1.283 | No built-in ACP mode. Adapter NOT installed but `npx -y @agentclientprotocol/claude-agent-acp` VERIFIED E2E here (3.5) |
| Gemini CLI (`gemini`, `@google/gemini-cli`) | 0.41.2 | NATIVE: `gemini --acp` ("Starts the agent in ACP mode"); `--experimental-acp` deprecated alias. Handshake OK; session blocked by account offering (3.2) |
| Codex (`codex`) | 0.159.2 | NO `acp` subcommand (bare `codex acp` is parsed as a prompt for the interactive CLI -> "Error: stdin is not a terminal"). Adapter `npx -y @agentclientprotocol/codex-acp` VERIFIED E2E here (3.5) |
| OpenCode (`opencode`) | 1.18.33 | NATIVE: `opencode acp` ("start ACP (Agent Client Protocol) server") — VERIFIED E2E incl. tool-call turn (3.3) |

npm global (nvm node v20.19.5): no @zed-industries/* and no @agentclientprotocol/* packages installed.

npm registry facts (checked 2026-10-01):
- `@agentclientprotocol/sdk` 1.5.1 - Apache-2.0 - ZERO runtime deps - unpacked 5.8 MB - published 3 days ago (actively maintained, 52 versions). Repo: github.com/agentclientprotocol/typescript-sdk.
- `@zed-industries/claude-code-acp` 0.16.2 - Apache-2.0 - unpacked ~174 KB - deps: @agentclientprotocol/sdk 0.14.1 (NOTE: old major!), @anthropic-ai/claude-agent-sdk 0.2.44, @modelcontextprotocol/sdk 1.26.0, diff, minimatch.
- `agent-client-protocol` (old package name) = 404, does NOT exist on npm (it exists as the Rust crate name).

(Sections below filled in as verified.)

## 1. Protocol mechanics for a client driving one agent

Source: agentclientprotocol.com protocol docs (v1 pages: /protocol/v1/initialization,
/protocol/v1/prompt-turn, /protocol/v1/tool-calls, /protocol/overview), fetched 2026-10-01.
ACP is JSON-RPC 2.0, two message types (methods = request/response; notifications = one-way).
The protocol version is a single INTEGER major version; current = `1`.

### 1.1 Method inventory (exact names)

Agent-side (the client CALLS these on the agent):
- baseline: `initialize`, `authenticate`, `session/new`, `session/prompt`
- optional: `session/load`, `session/set_mode`, `logout`
- notification to agent: `session/cancel`

Client-side (the agent CALLS these on the client — we must implement/handle these):
- baseline: `session/request_permission`
- optional: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`,
  `terminal/release`, `terminal/wait_for_exit`, `terminal/kill`, `elicitation/create`
- notifications from agent: `session/update`, `elicitation/complete`

Conventions: absolute file paths required; camelCase keys; snake_case discriminator values;
extensibility via `_meta` fields and underscore-prefixed custom methods.

### 1.2 Handshake / capability negotiation

Client sends `initialize` with `protocolVersion: 1`, `clientCapabilities`, `clientInfo`:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true},
  "clientInfo":{"name":"agenthop","title":"agenthop","version":"..."}}}
```

Client capabilities: `fs.readTextFile`, `fs.writeTextFile`, `terminal` (enables all
`terminal/*`), `auth.terminal`, `elicitation` (form/url), `session.configOptions.boolean`.
Everything omitted = unsupported, so a MINIMAL headless client can advertise `{}` (no fs, no
terminal) and the agent must cope — it will use its own internal tools instead of delegating
reads/writes/terminals to the client. (Claude Code adapter behavior under missing caps: see 3.1.)

Agent replies with `protocolVersion` (echoes 1 if supported, else its own latest — client SHOULD
close if incompatible), `agentCapabilities` (`loadSession`, `promptCapabilities.{image,audio,
embeddedContext}`, `mcpCapabilities.{http,sse}`), `agentInfo`, `authMethods` (array; empty when
no auth step needed; otherwise call `authenticate` before sessions).

### 1.3 Session setup

`session/new` params include `cwd` (absolute working directory) and `mcpServers` (a list of MCP
servers the AGENT should connect to — this is how a client injects extra tools into the agent;
see 5.x for the agenthop implication). Result: `{ "sessionId": "..." }`. Optional
`session/load` replays history for resumable agents (capability `loadSession`).

### 1.4 Prompt turn

- Client calls `session/prompt` with `{ sessionId, prompt: ContentBlock[] }` (baseline content:
  `text` and `resource_link`; `image`/`audio`/`embeddedContext` only if advertised in
  `promptCapabilities`).
- Agent streams `session/update` notifications. `update.sessionUpdate` discriminator variants
  (complete v1 list): `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`,
  `config_option_update`, `session_info_update`, `usage_update`.
- THE TURN ENDS when the agent responds to the original `session/prompt` request with
  `{ "stopReason": ... }`. StopReason values (complete): `end_turn`, `max_tokens`,
  `max_turn_requests`, `refusal`, `cancelled`.
- There is NO separate "final result" payload: the final answer is the accumulated
  `agent_message_chunk` stream; the `session/prompt` response only carries the stop reason.
  A headless driver must therefore CONCATENATE agent_message_chunks itself to get the result text.

### 1.5 Tool calls and status

`tool_call` update fields: `toolCallId` (required), `title` (required), optional `name` (the
programmatic tool name), `kind` (one of `read`, `edit`, `delete`, `move`, `search`, `execute`,
`think`, `fetch`, `switch_mode`, `other`; default `other`), `status` (default `pending`),
`content` (content blocks | `diff {path, oldText|null, newText}` | `terminal {terminalId}`),
`locations` (`{path, line?}` follow-along), `rawInput`/`rawOutput`.

`tool_call_update`: same fields, everything optional except `toolCallId`; only deltas are sent.

ToolCallStatus (complete): `pending` (streaming input or awaiting approval), `in_progress`,
`completed`, `failed`. (Plus the client marks unfinished calls `cancelled` on cancellation.)

### 1.6 Permission requests and auto-approval (the unattended-run key)

The agent calls the CLIENT method `session/request_permission`:

```json
{"method":"session/request_permission","params":{
  "sessionId":"...",
  "toolCall":{"toolCallId":"call_001"},
  "options":[
    {"optionId":"allow-once","name":"Allow","kind":"allow_once"},
    {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
```

PermissionOption kinds (complete): `allow_once`, `allow_always`, `reject_once`, `reject_always`.
Response outcome: `{"outcome":{"outcome":"selected","optionId":"..."}}` or
`{"outcome":{"outcome":"cancelled"}}`.

Auto-approval is EXPLICITLY sanctioned by the spec: "Clients MAY automatically allow or reject
permission requests according to the user settings." For an unattended agenthop run the client
handler just picks the first option whose `kind` is `allow_once`/`allow_always` (optionally
filtered by a policy on `toolCall.kind`/`title`) and returns it immediately — this is the ACP
equivalent of `--dangerously-skip-permissions`, but PER-CALL and policy-filterable (e.g.
auto-allow `read`/`search`/`execute`, auto-reject `delete` outside cwd).

### 1.7 Cancellation

`session/cancel` is a NOTIFICATION (no id) with `{ sessionId }`. Obligations:
- Client: immediately respond `cancelled` to all pending `session/request_permission` requests;
  preemptively mark unfinished tool calls cancelled.
- Agent: abort LLM/tool work, MUST still respond to the original `session/prompt` with
  `stopReason: "cancelled"` (not a JSON-RPC error). Late `session/update`s may still arrive until
  that response; client should accept them.

This gives agenthop a clean, protocol-level "stop that headless task" primitive (vs SIGKILL of a
native-exec child).

## 2. Transport + lifecycle

- Canonical transport: the CLIENT SPAWNS THE AGENT AS A SUBPROCESS and speaks newline-delimited
  JSON-RPC 2.0 over the agent's stdin/stdout (ndjson; the TS SDK calls the primitive
  `ndJsonStream(writableToAgentStdin, readableFromAgentStdout)`). Agent logging must go to
  stderr. Verified empirically here: piping a raw one-line `initialize` into `opencode acp` and
  `gemini --acp` returned one-line JSON responses (section 0/3).
- Lifecycle: spawn -> `initialize` -> (`authenticate` if `authMethods` non-empty and no ambient
  creds) -> `session/new {cwd, mcpServers}` -> one or more `session/prompt` turns -> kill the
  subprocess (or `session/close` where `sessionCapabilities.close` is advertised). The agent's
  lifetime is OWNED by the client; there is no daemon/registry.
- `cwd` on `session/new` MUST be absolute and governs the session regardless of where the
  subprocess was spawned. `[cwd, ...additionalDirectories]` SHOULD bound tool operations.
- Remote/HTTP: NOT part of stable v1. The spec v1 pages only describe the subprocess/JSON-RPC
  model. The TS SDK ships EXPERIMENTAL extras — exports `./experimental/server` (HTTP/SSE +
  WebSocket-upgrade server), `./experimental/ws-client`, `./experimental/http-client` — verified
  in `@agentclientprotocol/sdk@1.5.1`'s `exports` map and dist files (`server-sse.js`,
  `http-stream.js`, `ws-stream.js`). Treat remote transport as unstable; for agenthop's
  same-machine headless spawn, stdio is the right (and stable) layer anyway.
- Sessions survive across prompts within one subprocess (multi-turn: just call `session/prompt`
  again with the same `sessionId`). Resumability across subprocess restarts exists behind
  capabilities: `loadSession` (full replay via `session/load`), and newer
  `sessionCapabilities.resume` (no replay) / `.fork` / `.list` / `.close` — OpenCode 1.18.33
  advertises all four (empirical, section 3.3).

## 3. ACP-compatible agents and how to launch each (with THIS machine's status)

### 3.1 Claude Code — via adapter (NOT installed here yet)

- There is NO ACP mode in the `claude` CLI itself (v2.1.283 here). The adapter is a separate npm
  package that wraps the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and exposes it as an
  ACP agent.
- IMPORTANT RENAME: `@zed-industries/claude-code-acp` is DEPRECATED on npm — "This package has
  been renamed to @agentclientprotocol/claude-agent-acp. Please migrate to continue receiving
  updates." (deprecation notice verified via `npm view`, last modified 2026-03-26; final version
  0.16.2 pinned ANCIENT `@agentclientprotocol/sdk@0.14.1`).
- Current adapter: `@agentclientprotocol/claude-agent-acp` 0.84.0 (checked 2026-10-01; repo
  github.com/agentclientprotocol/claude-agent-acp, Apache-2.0, ~1.2 MB unpacked, actively
  released — last publish 2026-09-28). Deps: `@agentclientprotocol/sdk@1.5.1`,
  `@anthropic-ai/claude-agent-sdk@0.3.284`, zod, diff. Bin name: `claude-agent-acp`.
- Invocation: `npx @agentclientprotocol/claude-agent-acp` or install -g and run
  `claude-agent-acp`; the process speaks ACP on stdio. Auth rides on the Claude Agent SDK's
  ambient auth (the same `claude login` credentials / ANTHROPIC_API_KEY the SDK resolves) —
  the adapter README does not document a separate auth step.
- Feature surface (from the adapter README): tool calls with permission requests, plan/TODO
  updates, nested subagent transcripts, terminals, client MCP servers (MCP passthrough),
  custom slash commands, images/@-mentions.
- LOCAL STATUS: not installed (`which claude-code-acp`/`claude-agent-acp` = none; not in npm -g).
  `npx -y` works but downloads on first use. Empirical E2E result: see 3.5.

### 3.2 Gemini CLI — NATIVE, installed, but account-blocked here

- `gemini --acp` — "Starts the agent in ACP mode". (`--experimental-acp` still accepted, marked
  deprecated; verified in `gemini --help` of the installed 0.41.2.)
- Empirical handshake on this machine SUCCEEDED: `initialize` returned protocolVersion 1,
  `agentCapabilities: { loadSession: true, promptCapabilities: {image,audio,embeddedContext:
  true}, mcpCapabilities: {http,sse: true} }`, `authMethods: [oauth-personal, gemini-api-key,
  vertex-ai, gateway]`.
- BUT `session/new` failed with JSON-RPC error -32000: "This client is no longer supported for
  Gemini Code Assist for individuals ... migrate to the Antigravity suite" — i.e. the ACP
  plumbing works, the backing ACCOUNT/offering on this machine is cut off (oauth-personal path
  deprecated by Google). Would need `gemini-api-key`/`vertex-ai` auth to be usable here.

### 3.3 OpenCode — NATIVE, installed, FULLY VERIFIED end-to-end

- `opencode acp` — "start ACP (Agent Client Protocol) server" (in `opencode --help`, v1.18.33).
- Empirical handshake: protocolVersion 1; `agentCapabilities: { loadSession: true,
  mcpCapabilities: {http:true, sse:true}, promptCapabilities: {embeddedContext:true,
  image:true}, sessionCapabilities: { close:{}, fork:{}, list:{}, resume:{} } }`;
  `authMethods: [opencode-login]` (ambient `opencode auth login` creds were enough; no
  `authenticate` call needed).
- FULL PROMPT TURN VERIFIED with a 60-line hand-rolled Node client (no SDK):
  `initialize` -> `session/new {cwd:"/tmp/acp-e2e", mcpServers:[]}` -> returned
  `{sessionId:"ses_...", configOptions:[...]}` -> `session/prompt` ("reply pong") -> updates
  `available_commands_update`, `agent_message_chunk` x2, `usage_update` -> response
  `{stopReason:"end_turn"}` in 4.6 s; accumulated answer == "pong".
- TOOL-CALL TURN VERIFIED: a file-write task streamed
  `tool_call (pending, kind:edit)` -> `tool_call_update (in_progress)` ->
  `tool_call_update (completed)` -> final chunk; `stopReason:"end_turn"` in 15.9 s; the file was
  really created. NOTE: NO `session/request_permission` arrived — OpenCode's ACP server applied
  its own permission config (this host's opencode is configured permissive). Unattended clients
  must still implement the handler; whether it fires depends on the agent's own permission mode.

### 3.4 Codex — NO native ACP; third-party adapter exists

- `codex` 0.159.2 has NO acp subcommand (full subcommand list checked; bare `codex acp` is
  parsed as an interactive prompt). OpenAI ships `codex app-server` (its own JSON-RPC protocol,
  which agenthop already talks to for `codex queue`) — related in spirit, NOT ACP.
- Adapter: `@agentclientprotocol/codex-acp` 2.1.0 (npm, Apache-2.0, ~1.5 MB unpacked, published
  2026-10-01, repo github.com/agentclientprotocol/codex-acp; bin `codex-acp`). Deps include
  `@openai/codex` (the npm distribution of the codex binary), `vscode-jsonrpc`,
  `@agentclientprotocol/sdk@^1.5.0`. So Codex IS reachable over ACP, via adapter only.
  (Historical note: Zed originally maintained a Rust codex adapter; the npm
  `@agentclientprotocol/codex-acp` is the current actively-published one.)
- LOCAL STATUS: not installed. Empirical E2E: see 3.5.

### 3.5 Adapter empirical results (this machine)

- `npx -y @agentclientprotocol/codex-acp` (2.1.0) VERIFIED: initialize -> agentInfo
  `{name:"@agentclientprotocol/codex-acp", title:"Codex", version:"2.1.0"}`, authMethods
  `[api-key, chat-gpt]` (ambient codex login was accepted, no authenticate call needed).
  `session/new` returned `sessionId` PLUS `models`, `configOptions`, and `modes`:
  `availableModes = [read-only, workspace-write, agent ("Auto review"), agent-full-access]`,
  `currentModeId: "agent"` — i.e. the adapter exposes Codex approval/sandbox policy as ACP
  session modes, switchable via `session/set_mode`; `agent-full-access` is the ACP equivalent
  of `--dangerously-bypass-approvals-and-sandbox` for unattended runs. Prompt turn completed
  `end_turn` in 8.9 s with `agent_message_chunk` + `session_info_update` updates. (The answer
  TEXT was an upstream error from this machine's local CLIProxyAPI model backend — a local
  model-proxy config issue, not an ACP failure; the protocol path is fully functional.)
- `npx -y @agentclientprotocol/claude-agent-acp` VERIFIED end-to-end (npx resolved a cached
  0.49.0 — note npx caching can lag; latest is 0.84.0): initialize -> agentInfo
  `{title:"Claude Agent"}`, `authMethods: []` — ambient `claude login` credentials just worked,
  no authenticate step. `session/new` returned `sessionId`, `configOptions`, and `modes` =
  Claude Code's OWN permission modes surfaced as ACP session modes:
  `[auto, default, acceptEdits, plan, dontAsk, bypassPermissions]`, `currentModeId:"default"`.
  So for unattended runs the client can `session/set_mode` -> `bypassPermissions` (exact
  equivalent of `--dangerously-skip-permissions`) or stay in `default` and auto-approve via
  `session/request_permission` per-call. Prompt turn: `end_turn` in 7.7 s, updates
  `available_commands_update | usage_update | agent_message_chunk x3 | usage_update x2`,
  accumulated answer == "pong".

## 4. Building an ACP client in TypeScript/Node

### 4.1 The official SDK

- Package: `@agentclientprotocol/sdk` (npm). v1.5.1 as of 2026-10-01; Apache-2.0; ZERO runtime
  dependencies; 52 published versions, last publish 3 days before this check (very active).
  Repo: github.com/agentclientprotocol/typescript-sdk. ESM (`exports` map, `import` conditions;
  no CJS entry observed). Supports BOTH roles: "TypeScript SDK for ACP clients and agents".
- Size: 5.8 MB unpacked — BUT that includes `.test.js` files, source maps, the dist for the
  experimental v2, examples, and a 780 KB JSON schema directory. The actual client-relevant
  runtime core (acp.js + connection.js + jsonrpc.js + line-buffer.js + schema guards) is a few
  hundred KB of plain JS with no deps; a bun bundle tree-shakes the rest. For the compiled
  agenthop binary (58 MB) this is noise; for the OpenCode plugin it would be a real but
  acceptable cost IF the plugin ever needed it (it does not — headless spawn runs in the CLI
  binary, not the plugin).
- Current API shape (v1.5.x, verified from the shipped `dist/examples/client.js`): builder
  style, not the old `ClientSideConnection` class:

  ```js
  import * as acp from "@agentclientprotocol/sdk";
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const result = await acp.client({ name: "agenthop" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => autoApprove(ctx.params))
    .onRequest(acp.methods.client.fs.readTextFile, ...)        // optional
    .connectWith(stream, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {...} });
      return ctx.buildSession(cwd).withSession(async (session) => {
        session.prompt("...");                                  // session/prompt
        for (;;) {
          const m = await session.nextUpdate();                 // pull session/update stream
          if (m.kind === "stop") return m.response;             // { stopReason }
          handle(m.notification);
        }
      });
    });
  ```

  Experimental extras (exports map): `./experimental/v2` (draft next protocol),
  `./experimental/node` (node stream adapter), `./experimental/server`, `./experimental/ws-client`,
  `./experimental/http-client`, plus the raw JSON schema at `./schema/schema.json`.
- The old npm name `agent-client-protocol` does NOT exist (404) — that is the Rust crate's name.

### 4.2 Hand-rolling (no SDK) — measured

A complete working client is ~60 lines of zero-dep Node (written and run during this study,
/tmp/acp-e2e/drive.mjs): spawn, ndjson framing, an id->promise map for requests, a dispatch
for `session/update` notifications and incoming `session/request_permission` requests
(auto-approve = reply `{outcome:{outcome:"selected",optionId:<first allow_*>}}`), reply
`-32601` to unsupported client methods (fs/terminal). That client drove OpenCode through plain
and tool-call turns successfully.

Trade-off: hand-rolling avoids the dep entirely and matches agenthop's existing style (the bus
already hand-rolls WS-over-unix and the codex app-server protocol); the SDK buys typed schemas,
future protocol-rev tracking, and the TCK-tested edge cases (cancellation ordering, late
updates). Recommendation in section 6.

### 4.3 Prior art: acpx

`acpx` 0.19.4 (npm, MIT, github.com/openclaw/acpx) is exactly the "headless CLI client for ACP"
shape — talk to coding agents from the command line, built on `@agentclientprotocol/sdk`.
Worth skimming for client ergonomics (its deps are heavier than agenthop would want: tsx,
commander, zod). It also demonstrates the ecosystem is already using ACP for the
dispatcher-drives-headless-agent use case, not just editors.

## 5. Concrete integration design: agenthop_spawn headless backend = ACP

### 5.1 Flow

`agenthop_spawn(tool, task, visible:false, backend:"acp")` in the DISPATCHER'S bus node
(packages/bus — the CLI binary, NOT the OpenCode plugin):

1. Resolve the agent command per tool (section 3): claude -> `claude-agent-acp`,
   codex -> `codex-acp`, opencode -> `opencode acp`, gemini -> `gemini --acp`.
2. `spawn(cmd, args, { cwd, stdio: pipe/pipe/pipe })`; stderr -> a log file under the existing
   launch registry dir (`<lid>.acp.log`). Record `launchId -> pid` exactly like the planned
   native-exec headless registry; cleanup = `session/cancel` then SIGTERM/SIGKILL the pid
   (still "only ever agenthop-spawned pids").
3. `initialize { protocolVersion: 1, clientCapabilities: {} }` (advertise nothing: no fs, no
   terminal — the agent then uses its own tools, which is what we want; verified OpenCode and
   codex-acp work fine with empty client caps). If `authMethods` is non-empty AND the first
   prompt fails with auth_required, fail the spawn with a human-readable "run <tool> login".
4. `session/new { cwd: <absolute task cwd>, mcpServers: [...] }`.
   OPTION: inject agenthop itself as an MCP server here (`{name:"agenthop", command:
   <agenthop bin>, args:["mcp"], env:[...]}`) so the headless agent JOINS THE BUS like a
   visible spawn does — this answers bus.7's "can the exec mode still load agenthop MCP?"
   question for the ACP backend affirmatively and uniformly: WE pass the MCP server in-band,
   no per-tool config files touched. (Caveat 7.x: per-agent MCP passthrough fidelity.)
5. For codex-acp: optionally `session/set_mode { sessionId, modeId: "agent-full-access" }` for
   unattended full-auto (empirically the adapter starts in "agent"/Auto-review mode).
6. `session/prompt { sessionId, prompt: [{type:"text", text: task}] }`.
7. Consume `session/update`s:
   - accumulate `agent_message_chunk` -> the RESULT text;
   - `tool_call` / `tool_call_update` / `plan` -> progress + status mapping (5.2);
   - answer `session/request_permission` by POLICY (default unattended: first `allow_*` option;
     configurable deny-list by `toolCall.kind`, e.g. never auto-allow `delete`);
   - reply `-32601` to `fs/*`, `terminal/*` (not advertised, shouldn't arrive).
8. Turn ends when `session/prompt` resolves `{stopReason}`. `end_turn` => success; `refusal`,
   `max_tokens`, `max_turn_requests` => structured failure reasons; `cancelled` => we cancelled.
9. Deliver the accumulated answer (+stopReason) back over the bus to the dispatcher as a normal
   bus message (same surface as agenthop_recv/auto-surface), or return it directly as the tool
   result for a synchronous one-shot.
10. Multi-turn option (ACP's unique win): KEEP the subprocess + sessionId; a follow-up task is
    just another `session/prompt` on the same session — true continuation with full context,
    something `claude -p`/`codex exec` one-shots cannot do without resume flags and new procs.

### 5.2 Status mapping: ACP as a work-status source

bus.6 peer status (working/idle/blocked) is fed by per-tool HOOKS (claude settings hooks, codex
hooks.json, opencode plugin events). For an ACP-DRIVEN agent the client sees a STRICTLY RICHER,
in-band, ordered signal — no hook config, no status files, no seq workarounds:

| ACP signal | bus status |
|---|---|
| `session/prompt` sent | working |
| `tool_call`/`tool_call_update` status `pending` with a pending `session/request_permission` | blocked (we even know WHICH tool and can auto-unblock) |
| `tool_call_update` in_progress/completed/failed, message/thought chunks | working (+ statusText from tool `title`) |
| `session/prompt` resolved (any stopReason) | idle |

Ordering is guaranteed by the JSON-RPC stream itself (single pipe, in-order), vs the hook path's
cross-process seq files. ANSWER to the question posed: yes — for ACP-driven agents, ACP is a
richer AND more reliable status source than the hook adapters; the dispatcher can call
`agenthop_report_status` on the child's behalf, or the child (if bus-joined via injected MCP)
still self-reports. Caveat: it only covers agents WE spawned over ACP; hooks remain the source
for free-standing sessions.

### 5.3 How an ACP child differs from a bus peer

- CLIENT-OWNED: lifecycle, permissions and transcript belong to the dispatcher. It is NOT a
  peer unless we inject the agenthop MCP server (step 4) — then it is BOTH: an owned subprocess
  AND a bus peer that other sessions can message. Without injection it never appears in
  `agenthop_peers` (invisible in both senses).
- Cleanup is trivial and safe by construction: close stdin / kill the subprocess. No Ghostty
  surface UUIDs, no claim files — the whole 12-round despawn-safety problem does not exist for
  headless ACP children.
- Identity: no native TUI session; stableId could be the ACP `sessionId` (and codex-acp's
  sessionId appears to BE the codex thread id format, so `codex resume <id>` interop may work —
  unverified, 7.x).

## 5bis. Three-way comparison for headless auto-task: A2A vs ACP vs handoff

The auto-task shape is: dispatcher gives a sub-agent a task, gets a result. Three mechanisms sit
in/near the stack already; they live on DIFFERENT axes (wire protocol between peers / control
protocol over an owned subprocess / message convention over the existing bus).

### 5bis.1 A2A task delegation — already IN agenthop (classic layer)

Verified in-repo (2026-10-01): classic agenthop IS an A2A implementation. `packages/cli`
depends on `@a2a-js/sdk` ^1.1.0 (1.2.0 installed). `packages/cli/src/host.ts` imports
`A2A_PROTOCOL_VERSION`, `AGENT_CARD_PATH`, `AgentCard` and serves the card + JSON-RPC via
`DefaultRequestHandler`, `InMemoryTaskStore`, and the express `agentCardHandler`/
`jsonRpcHandler`. `packages/agent/src/executor.ts` implements `AgentExecutor` (`HopExecutor`)
publishing `Task` events; `packages/cli/src/send.ts` is the A2A client side (`ClientFactory`
from `@a2a-js/sdk/client`); `packages/cli/src/room.ts` wraps replies as completed `Task`s with
artifacts (`openTask` -> `TaskState.TASK_STATE_COMPLETED` + an "Ack" artifact);
`packages/cli/src/inbox.ts` uses `AGENT_CARD_PATH`. The relay pairs NAT'd A2A agents by short
code. So "adopt A2A" is NOT a new dependency — it is already the classic wire format.

A2A's native task lifecycle (installed SDK's `TaskState`): `TASK_STATE_SUBMITTED`, `WORKING`,
`INPUT_REQUIRED`, `COMPLETED`, `FAILED`, `CANCELLED`/`CANCELED`, `REJECTED`, `AUTH_REQUIRED`,
`UNSPECIFIED` — plus artifacts on the Task. That is literally the "delegate a task, track it,
get a result with artifacts" shape, and `INPUT_REQUIRED` maps 1:1 to bus "blocked".

BUT: current agenthop uses A2A as a dumb TRANSPORT, not its task semantics — `HopExecutor`
marks every inbound WORKING immediately and room.ts acks COMPLETED instantly; the "result" is
whatever the human/agent later says. Real A2A delegation would mean the RECEIVING session hosts
a task that stays WORKING until its local agent actually finishes, then completes with the
result as an artifact. That's a meaningful rework of the receive path (executor must hold the
task open across an entire agent turn and the bus must feed completion back), and A2A's
client/server + AgentCard + express machinery is exactly the 2.1 MB/464-module layer that was
deliberately kept OUT of the bus/plugin (Phase 2 gateway decision). A2A also solves
agent<->agent ACROSS a network; it does NOT solve "start a headless local agent" — something
must still spawn and drive the child (native exec or ACP). A2A would only be the RESULT-
REPORTING envelope between dispatcher and an already-running peer.

### 5bis.2 ACP client-driving (this doc's main body)

Solves the OTHER half: how the dispatcher runs and controls the child it spawned. Structured
streaming, permission interception, protocol-level cancel, multi-turn on one session. Costs: a
client impl (or dep), per-tool adapter availability (Codex/Claude via npx adapters), and it is
local-subprocess only (no cross-machine in stable v1).

### 5bis.3 `agenthop_handoff` — the current task-passing mechanism

Verified in-repo: `packages/bus/src/handoff.ts` (`formatHandoff` = author-written summary
capped 12k + optional next-steps + `gitSnapshotText` of the sender's cwd) delivered via
`core.send` as an ORDINARY bus message (mcp.ts `agenthop_handoff` tool; opencode-plugin.ts has
the same via the shared `deliver` helper). Strengths: shipped, tool-agnostic, zero new deps,
works cross-machine over the existing gateway/relay. Gaps for AUTO-task: fire-and-forget — no
task id, no lifecycle states, no structured result or artifacts, no completion signal (bus.6
status + `agenthop_wait_peer(to, until: idle)` approximates "done", but "idle" is not "done
WITH THIS task" and carries no result payload; the result comes back only if the receiver
chooses to send a message).

### 5bis.4 Verdict for headless auto-task

Decisive recommendation: **compose, don't pick one layer for everything.**

- SPAWN+DRIVE the headless child: native exec now, ACP later (section 6). A2A cannot do this.
- TASK ENVELOPE dispatcher<->child: extend HANDOFF, not A2A, for bus.7. Concretely: a
  `taskId` on the handoff + a tiny `task-result` reply convention (child sends
  `[task-result <taskId>] ...` or a structured bus frame; dispatcher's spawn call correlates).
  This is ~tens of lines on shipped code, works for visible AND headless spawns, and keeps the
  bus/plugin lean. Borrow A2A's VOCABULARY (submitted/working/input-required/completed +
  result text as the single artifact) without its machinery — bus.6 status already provides
  working/blocked/idle live.
- Do NOT route local auto-tasks through the A2A/room layer: it is cross-machine relay plumbing
  (express + AgentCard + relay pairing), its current executor fakes the lifecycle anyway, and
  reworking it buys nothing for same-machine dispatch that the broker doesn't already do
  better. REVISIT A2A-proper only if cross-MACHINE auto-task with durable lifecycle becomes a
  requirement — then the right move is to make the relay's existing A2A tasks real (hold
  WORKING until done, return the result as an artifact), since the dep and wire format are
  already there.

Cost summary: handoff-extension = tiny, no deps, result is convention-based; A2A-proper =
zero NEW deps but a real rework of executor/room semantics + heavy layer in the wrong place
for local; ACP = new (zero-dep) client lib or ~200-line hand-rolled client + per-tool adapter
availability, and only pays off when you need streaming/permission/multi-turn control.

## 6. Recommendation: ACP vs native-exec for bus.7 headless

SHORT: build bus.7 on NATIVE EXEC + an extended handoff/task envelope now; DEFER the ACP
backend to a bus.8+ opt-in (`backend:"acp"`), designed-for but not shipped in bus.7.

Why native-exec first:
- Zero new deps; `claude -p` / `codex exec` / `opencode run` are first-party, already on PATH,
  already proven under agenthop's spawn env-scrub + registry machinery; one-shot run-and-return
  matches the bus.7 "minor/bulk" use case exactly.
- Uniformity: all three tools (plus anything future) have a non-interactive mode; ACP coverage
  is uneven (OpenCode native; Claude/Codex via third-party-maintained npx adapters whose
  versions move fast — adapter 0.84.0/2.1.0 within days of this check; Gemini native but
  account-gated here).
- The permission problem is already solved the blunt way for spawns
  (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` /
  `opencode --auto` precedent from visible spawn).

When ACP wins (the triggers that justify bus.8):
1. MULTI-TURN headless control — keep one child, send follow-up prompts with full context.
2. POLICY-level unattended permissions — auto-allow reads/execute but refuse deletes, instead
   of all-or-nothing bypass flags.
3. LIVE progress/status — in-band tool_call stream beats parsing exec stdout and beats hooks
   for spawned children (5.2).
4. Clean mid-task CANCEL with a defined protocol outcome.

Cost of ACP when adopted: `@agentclientprotocol/sdk` (zero-dep, Apache-2.0, ESM, actively
maintained, backed by the agentclientprotocol org) in the CLI binary only — or a ~200-line
hand-rolled client in agenthop's existing zero-dep style (proven feasible here in 60 lines);
plus per-tool launch matrix maintenance + adapter version watching. Keep it OUT of the OpenCode
plugin either way.

Design hook to keep now (cheap): make bus.7's headless backend an interface
(`run(task) -> {updates$, result}`) so `exec` and `acp` are two implementations; store
`backend` in the launch registry record.

## 7. Residual uncertainties / version flags

- Versions checked 2026-10-01 and moving fast: spec protocolVersion 1 (v1 docs); SDK 1.5.1
  (published days earlier; `experimental/v2` draft exists and WILL change); claude adapter
  0.84.0; codex adapter 2.1.0; opencode 1.18.33; gemini-cli 0.41.2. Re-verify before building.
- `@agentclientprotocol/claude-agent-acp` E2E: RESOLVED — verified in 3.5 (ambient claude
  login creds worked, full turn OK). Residual: the npx-cached version here was 0.49.0 while
  latest is 0.84.0; pin the adapter version when integrating.
- `session/request_permission` was NEVER triggered in local probes (OpenCode permissive config;
  codex-acp "agent" mode did not prompt on a trivial task). The auto-approve handler is spec-
  correct but untested against a real prompt-producing agent config here.
- Whether each tool's ACP agent honors client-supplied `mcpServers` (step 4 bus-join injection)
  is documented capability-wise (stdio MCP is mandatory per spec) but not verified per-agent;
  codex-acp/claude adapter MCP passthrough fidelity needs a probe before relying on it.
- codex-acp sessionId <-> `codex resume` thread-id interop: plausible (UUID shape matches), not
  verified.
- Remote/HTTP ACP: experimental SDK exports exist (server/ws/http streams); no stability
  commitment found; not in the v1 spec pages. Do not architect on it.
- Gemini: ACP mode works but `session/new` is blocked for oauth-personal accounts on this
  machine ("migrate to Antigravity"); api-key/vertex auth untested.
- The spec site's v1 pages also document newer `sessionCapabilities` (resume/close/fork/list)
  that postdate some blog coverage; exact SDK-vs-spec drift was not fully audited — the SDK is
  release-synced with the schema, so trust `acp.PROTOCOL_VERSION` + typed schema over prose.
