# Auto-Task Result-Return over the agenthop Bus

Status: DESIGN (research doc; no code changed)
Date: 2026-10-01
Scope: the "first brick" of collective intelligence on the bus — a dispatcher gives a
sub-agent a task and reliably gets a STRUCTURED RESULT back, correlated to the request,
over a distributed bus where requester and worker may sit on different machines, may
restart, and where delivery is eventual.
Builds on: docs/research/acp-integration.md (sec 5bis), whose verdict this doc accepts and
makes concrete: extend the handoff/task envelope with a taskId + reply convention, borrow
A2A's lifecycle VOCABULARY, skip A2A's express/AgentCard machinery, defer ACP.

---

TL;DR: Add three small pieces, all riding the EXISTING send path with zero new dependencies
and zero transport changes:

1. A **task envelope** — `[[agenthop:task]] {json}` — an ordinary bus message whose JSON
   header carries `{id, replyTo, text}`; the receiving bus node dedups by `id` and surfaces
   the human-readable `text` (the formatHandoff body plus a "report back with
   agenthop_task_result(<id>)" instruction).
2. A **result frame** — `[[agenthop:task-result]] {json}` — sent by the worker to the
   requester's restart-stable identity, carrying `{id, status: done|failed, result,
   artifacts?}`. The requester's bus node intercepts it BEFORE auto-surface, matches it to
   a pending-task table, and resolves any await on it; an UNMATCHED result is rendered and
   auto-surfaced like a normal message so it is never silently dropped.
3. An **await primitive** — `agenthop_task_await(task_ids?, timeout)` — a NEW tool (not an
   overload of agenthop_wait_peer: peer status is identity-level "idle", which is not
   "done WITH THIS TASK"), collecting any subset of outstanding results, re-callable, and
   able to REGISTER an id it has never seen (so a restarted dispatcher can re-await ids it
   still has in its transcript).

The hard distributed truth that shapes everything (verified in code, sec 2): **the bus has
NO store-and-forward.** Both transports fail fast when the recipient process is down — the
local broker drops DMs to absent roster ids, and the relay mailbox is a room HOSTED BY THE
RECIPIENT'S OWN PROCESS under an EPHEMERAL per-run key, so a dead or restarted recipient has
no mailbox at all until it re-announces (new key, new room). Therefore result-return
reliability = the WORKER retries delivery against the requester's stable identity until it
reappears, and every timeout must read "unknown", never "failed".

MVP (sec 8) is ~350 lines across a new lean `task.ts` + core/mcp/plugin wiring, no durable
spool; it unblocks gather/reduce and verify/critic immediately. The durable version (spool
files mirroring the statusfile/spawn-registry patterns, progress frames with per-task seq,
delivery acks) is specified but deferred until a real need shows.

## 1. The problem

Today the bus moves MESSAGES, not TASKS:

- `agenthop_send(to, text)` and `agenthop_handoff(to, summary, next?)` are fire-and-forget:
  they confirm (at best) that the transport accepted the payload, and nothing correlates a
  later reply to the request. `packages/bus/src/handoff.ts` builds a great task DESCRIPTION
  (author summary + bounded git snapshot) but carries no task id and expects no reply — by
  design, a handoff transfers OWNERSHIP of work.
- bus.6 peer status (`agenthop_report_status` / `agenthop_wait_peer`) approximates "the
  worker finished SOMETHING" (`idle`), but: idle is not "done with THIS task" (the worker
  may have gone idle for another reason, or finished a different task), and status carries
  no result payload. The acp-integration doc already called this gap out (sec 5bis.3).
- `agenthop_spawn` can launch a worker (visible Ghostty today; bus.7 Track A is adding a
  headless mode), but the dispatcher then has no way to get the worker's output back except
  reading its window — which a HEADLESS worker does not have at all.

Collective-intelligence patterns all reduce to the same primitive:

- gather/reduce: dispatch N tasks, await N results, aggregate.
- verify/critic: dispatch work to A, dispatch "review A's output" to B with A's result as
  input, await B's verdict.
- pipeline: result of task k is the input of task k+1.

All three need exactly one mechanism: **dispatch(task) → taskId; await(taskId) → structured
result**. This doc designs that mechanism and nothing more.

## 2. Ground truth: what the bus actually guarantees today (verified in code)

Every claim in this section was read from the source on 2026-10-01 (paths relative to
`/Volumes/Share/projects/dev/agenthop/packages/bus/src/` unless noted). The design in sec 3
leans on each one, so they are spelled out.

### 2.1 Send is transport-ack at best, never processing-ack

- Local (same machine): `core.ts send()` → `broker.ts send()` returns `true` after checking
  the roster and WRITING the line to the broker socket. The broker's `routeDm` silently
  drops a DM whose target disconnected in the failover window (comment: "Unknown target:
  dropped"); the client path returns `false` when its broker connection is gone. So `ok:true`
  means "handed to a live broker for a peer that was on the roster moments ago" — not
  "the recipient processed it".
- Cross-machine: `core.ts send()` → `relay.ts` → `mailbox.ts send()` → `cli/send.ts
  sendMessage`, which resolves "once the host has it in order" — the HOST here being the
  RECIPIENT session's own process (each session hosts its own mailbox room). So the relay
  path actually gives a stronger ack than local: the recipient PROCESS has the bytes. Still
  not an ack that the agent read or acted on them.
- Precedent for timeout honesty: the Phase-2 bridge resolves a timed-out send as
  **"unknown"**, not "failed" ("the gateway may have delivered; wording must not invite
  duplicate resend" — memory, P2-7). This design adopts that wording everywhere.

### 2.2 There is NO store-and-forward; delivery requires a live recipient

- The recv queue (`core.ts`: `const queue: BusMessage[]`) is in-memory in the bus node
  process. Process exit = queued messages gone.
- The relay mailbox key is EPHEMERAL per process: `relay.ts` calls `ephemeralKeys()` and
  `dm.ts` documents "Not persisted (a session is short-lived)". The mailbox room address is
  derived from the public key (`mailbox.ts mailboxAddress`), and the room is hosted by the
  recipient's own process. Consequences:
  - A restarted session has a NEW public key and a NEW mailbox room; its OLD room dies with
    the old process (plus `recoverMs: Infinity` keeps nothing alive for an absent host).
  - A DM sealed to a stale pub key is undeliverable and unreadable forever.
  - Therefore: **never embed a pub key (or per-run id) in a task envelope as the reply
    address. Resolve the reply target at SEND time, from the live roster/directory, by
    stable identity.** The directory re-publishes a restarted peer's fresh pub under the
    same `stableId` (announce every 60s, poll every 5s, TTL 150s — `directory.ts`), so a
    send-time resolve self-heals after a restart; a baked-in key never does.
- Local broker presence is live (socket drop = instant departure), so the same rule holds:
  resolve at send time.

### 2.3 Identity is restart-stable-ish — and exactly how stable matters here

From `label.ts` / `resolve.ts` / memory:

- `id` — per-run UUID, regenerated every process start. Routing token only.
- `stableId` — the host's native session id. Claude Code: `CLAUDE_CODE_SESSION_ID`, SAME
  across a restart/RESUME of the same conversation, different for a new conversation.
  Codex: the thread id, learned late (first bus call / daemon), survives app restarts of
  the same thread but a NEW thread gets a new id — the committed docs explicitly say the
  codex handle is NOT restart-stable and to address by the prefix `codex:Work`.
- `title` — `tool:dir-<shortId(stableId ?? id)>`; `resolvePeer` matches stableId/id exact
  → title exact → prefix, each tier required unique.

So the reply address for a result is a LADDER, not a single value: stableId when the task
knew it, else exact title, else nothing (prefix fallback is deliberately NOT used for
results — a prefix can legally match a DIFFERENT session in the same directory, and a
misdelivered "result" is worse than an undelivered one). Sec 6.4 works through the restart
cases this ladder does and does not cover.

### 2.4 Pieces already in the stack that this design reuses

- **Framed-payload convention**: `[[agenthop:bus-dm]] ` (`dm.ts`) and
  `[[agenthop:bus-presence]] ` (`directory.ts`) already establish the in-house pattern of a
  bracketed prefix + machine payload inside an ordinary message/room entry. The task and
  result frames follow it.
- **Monotonic per-source seq with drop-if-not-newer**: `core.ts setStatusImpl` (per-identity
  seq guard) and `statusfile.ts` (lock-free max-register of versioned files, seq = event
  time). Reused for progress updates in the full version; the MVP needs only
  dedup-by-taskId plus absorbing terminal states.
- **Pin-the-run waiting with gone-detection**: `core.ts waitForStatus` pins the resolved
  per-run id AND its identity, reports `gone` when the run leaves the roster. The await
  primitive reuses this internal shape for worker-death detection.
- **launchId + two-writer registry**: `spawn.ts` generates `agenthop-spawn:<tool>:<8hex>`,
  injects `AGENTHOP_LAUNCH_ID` into the child (Claude env inherit; codex `-c
  mcp_servers.agenthop.env...` leaf; OpenCode server env), and keeps one dispatcher-owned
  file + one child-owned claim file per launch so two writers never RMW-race. The full
  version's task spool copies this pattern exactly; spawn-with-task (sec 7) records the
  taskId in the launch record.
- **Bounded, author-written task text**: `handoff.ts formatHandoff` (summary ≤ 12k, next
  ≤ 4k, git status ≤ 40 lines/4k). The task envelope embeds this body unchanged.
- **A2A, already in the repo, as a counter-example**: `packages/cli/src/host.ts` wires
  `DefaultRequestHandler` with **`InMemoryTaskStore`**, and `room.ts` acks every inbound as
  an instantly-COMPLETED Task with an "Ack" artifact (acp doc 5bis.1: A2A is used as a dumb
  ack-transport, not real delegation). Two facts matter for sec 5: (a) making those tasks
  real means reworking the executor to hold a task open across an entire agent turn; (b)
  even then, the shipped task store is in-memory — "real A2A" as currently wired would lose
  all task state on restart too, so adopting it buys no durability for free.

## 3. The design: taskId correlation over the existing send path

### 3.1 Shape

Three frames, all ordinary bus messages (broker DM locally, sealed mailbox DM via relay —
the transports change NOT AT ALL), distinguished by a bracketed prefix in the established
house style:

```
[[agenthop:task]] {json}\n<human-readable task body>
[[agenthop:task-result]] {json}
[[agenthop:task-progress]] {json}          (full version only; not in the MVP)
```

The `task` frame keeps a human-readable body AFTER the JSON header line because the frame
must degrade gracefully: a worker running an OLD agenthop (or a human reading a raw recv
queue) still sees a legible handoff-style task with its taskId and reply instructions in
plain text. The `task-result` frame is machine-first (the dispatcher's node consumes it),
but an unmatched one is rendered legibly before auto-surfacing (sec 3.4).

### 3.2 The dispatch side: `agenthop_task` (new tool)

`agenthop_task(to, summary, next?, timeout_seconds?)`:

1. Generate `taskId = "t-" + randomBytes(6).toString("hex")` (same entropy family as
   launchId; globally unique enough for a roster-scale system, and the dispatcher only ever
   matches ids IT issued, so cross-dispatcher collision is harmless).
2. Resolve `to` via `resolvePeer` (existing precedence/ambiguity rules). Record the
   resolved worker's `{runId, stableId?, title}` in the in-memory pending-task table —
   this pin is what lets await detect worker death (sec 6.5).
3. Build the body with the EXISTING `formatHandoff` (summary + next + git snapshot — the
   task description problem is already solved; do not re-solve it), then prepend the header:

```json
{"v":1,"kind":"task","id":"t-9f2c01ab44de",
 "replyTo":{"stableId":"20cab0a5-...","title":"claude:Work-20cab0a5"},
 "ts":1767225600000}
```

   `replyTo` carries the DISPATCHER's stable identity ladder (stableId when it has one,
   title always) — never its per-run id and never a pub key (sec 2.2/2.3). `v` is the frame
   schema version so a future field is additive.
4. Send via `core.send` exactly like a handoff. The appended plain-text body ends with the
   contract line, e.g.:

   > When you finish, call `agenthop_task_result(task_id: "t-9f2c01ab44de", status:
   > "done"|"failed", result: <your findings>)`. Do this even on failure — a failure report
   > is a result. If you cannot, say so in a normal reply mentioning the task id.

5. Return `{taskId}` to the calling agent immediately (dispatch is NOT await; a dispatcher
   fans out N tasks, then awaits).

Pending-table entry: `{taskId, to:{runId, stableId?, title}, sentAt, state:"dispatched"}`.
In-memory in the MVP; mirrored to a spool file in the full version (sec 8.2).

### 3.3 The worker side: `agenthop_task_result` (new tool)

`agenthop_task_result(task_id, status, result, artifacts?)`:

1. Validate `status ∈ {done, failed}` and non-empty `result` (a bare "done" with no content
   is rejected with a hint — the whole point is a structured result; for a genuinely
   empty-output task the worker writes "no findings" and that IS the result).
2. Resolve the reply target AT SEND TIME from the live roster, by the task's `replyTo`
   ladder: exact `stableId` match first, then exact `title` match. NO prefix fallback for
   results (a prefix may match a different live session; misdelivery is worse than retry).
   The worker's bus node remembers `taskId → replyTo` from the inbound task frame when it
   saw one, so the agent only has to pass the id; if the node has no memory of the id
   (node restarted mid-task), the tool accepts an explicit `reply_to` argument, and the
   task body's visible header lets the agent supply it.
3. Send the frame:

```json
{"v":1,"kind":"task-result","id":"t-9f2c01ab44de","from":"codex:Work-01a0ead5",
 "status":"done",
 "result":"<the worker-authored result text, capped (64k)>",
 "artifacts":[{"name":"review.md","path":"/tmp/ahreview-x/review.md"}],
 "ts":1767226200000}
```

   `artifacts` are PATH REFERENCES, not inline blobs: the relay path caps a DM at 1 MiB
   (`mailbox.ts textBytes`) and the broker line-protocol is not a file channel. Same-machine
   paths just work; cross-machine artifacts are declared but must be fetched by other means
   (honest limitation, stated in the tool description; the classic agenthop file-send is the
   escape hatch). `result` itself is capped at 64k — larger output goes to a file and the
   result says where.
4. If the resolve finds no live match: **retry with backoff, bounded by a TTL** (sec 6.4) —
   the requester may be restarting; its directory/broker re-announce will bring the stable
   identity back. The tool returns "accepted; requester not reachable right now, will keep
   trying for <TTL>" rather than failing the worker's turn.

### 3.4 The return path: interception before auto-surface

In `core.ts handleInbound`, BEFORE `pushToHost`:

- A `[[agenthop:task-result]]` frame whose `id` is in the pending table: mark the entry
  `state:"completed"`, store the payload, resolve any in-flight await, and DO NOT
  auto-surface the raw frame (await's return is the surface). Duplicate arrivals of the
  same `id` after a terminal state are dropped (idempotent receive, sec 6.6).
- A result frame whose `id` is UNKNOWN (dispatcher node restarted and lost the table, or a
  worker replying to a transcript-recovered id): render it legibly —
  `[task-result t-... from codex:Work-01a0ead5] status=done\n<result>` — and let it
  auto-surface like any message. **Never silently drop a result**: the agent reading its
  TUI still gets the content, which is the actual goal; correlation is an optimization.
  Additionally, park it in a small "orphan results" buffer (bounded, e.g. last 32) so a
  subsequent `agenthop_task_await(task_ids:[...])` that registers the id late can still
  claim it without a resend.
- A `[[agenthop:task]]` frame on the RECEIVING side: record `taskId → replyTo` (for sec
  3.3's resolve), dedup by taskId (sec 6.3), strip the JSON header, and surface the
  human-readable body through the normal push path. To the receiving agent it looks exactly
  like today's handoff plus a reply contract — no new behavior to learn beyond one tool.

### 3.5 The await side: `agenthop_task_await` (new tool)

`agenthop_task_await(task_ids?, timeout_seconds?)`:

- No `task_ids`: wait on ALL outstanding dispatched tasks; return as soon as AT LEAST ONE
  reaches a terminal state (the gather loop calls it repeatedly — same re-call idiom as
  `agenthop_recv`/`agenthop_wait_peer`, which also keeps each MCP call under host tool
  timeouts, max 290s).
- With `task_ids`: wait on that subset. Ids not in the pending table are REGISTERED as
  awaited-but-unknown (and immediately satisfied from the orphan buffer when present) —
  this is the restart recovery path: a restarted dispatcher re-awaits ids from its
  transcript (sec 6.4).
- Return value per task: `{taskId, state}` where state is one of
  - `done` / `failed` — worker's own report, with `result` (+ `artifacts`);
  - `worker-gone` — the PINNED worker run left the roster with no result (sec 6.5): the
    task outcome is UNKNOWN (it may have completed and failed only to deliver; a restarted
    worker may yet deliver via the replyTo ladder) — the wording mirrors waitForStatus's
    `gone` and the bridge's "unknown";
  - `pending` — timeout elapsed; explicitly worded "still unknown — the worker may still
    finish; call agenthop_task_await again, or check the worker with agenthop_wait_peer /
    agenthop_peers. Do NOT re-dispatch the same work without checking" (sec 6.2).

Why a new tool rather than extending `agenthop_wait_peer`: wait_peer's domain is a PEER
reaching an identity-level STATUS; await's domain is a TASK reaching a terminal state with
a payload. Overloading one tool with both ("to or task_ids, until or none, returns status
or result...") would make both harder to use correctly, and the two genuinely compose:
status is the live heartbeat ("is it working?"), await is the outcome ("what did it
produce?"). The gather pattern uses both (sec 9). wait_peer DOES grow one small thing in
the full version: `until:["idle"]` plus the pending table lets the dispatcher print "went
idle but no result for t-... yet" — a cheap cross-check, not a merge of the tools.

### 3.6 What deliberately does NOT exist

- No task QUEUE on the worker, no acceptance/claim step, no scheduling: a task is a message
  that asks for a correlated reply. The worker's agent decides what to do with it, exactly
  as with a handoff today. (A2A's `submitted → working` transition is collapsed into
  bus.6's existing status heartbeat.)
- No `canceled` wire state in the MVP: cancel = the dispatcher sends an ordinary message
  ("drop t-...; reply failed/acknowledged") and/or despawns a spawned worker. A protocol
  cancel joins the full version only if real usage shows the convention failing.
- No dispatcher-side re-dispatch automation: retries of the TASK are an agent decision
  (needs judgment about idempotency of the work itself, sec 6.3); the bus only retries
  RESULT DELIVERY, which is safe because receive is idempotent by taskId.

## 4. The message envelope, precisely

One TypeScript module (`task.ts`, lean — importable by core.ts AND the OpenCode plugin,
like resolve.ts: no relay/codex/fs imports for the frame functions):

```ts
export const TASK_PREFIX = "[[agenthop:task]] ";
export const RESULT_PREFIX = "[[agenthop:task-result]] ";

/** Reply address ladder: resolved against the LIVE roster at send time, never baked keys. */
export type TaskReplyTo = { stableId?: string; title: string };

export type TaskFrame = {
  v: 1;
  kind: "task";
  id: string;              // "t-<12 hex>", dispatcher-issued, the correlation key
  replyTo: TaskReplyTo;    // the DISPATCHER's stable identity ladder
  ts: number;              // dispatcher clock, informational only (never ordering)
};
// wire: TASK_PREFIX + JSON.stringify(TaskFrame) + "\n" + formatHandoff(...) body + contract line

export type TaskArtifact = { name: string; path?: string; note?: string };

export type TaskResultFrame = {
  v: 1;
  kind: "task-result";
  id: string;              // echoes TaskFrame.id
  from: string;            // the worker's title (handle) at completion time, for display
  status: "done" | "failed";
  result: string;          // worker-authored, capped 64k; larger output -> artifact path
  artifacts?: TaskArtifact[];
  ts: number;
};
// wire: RESULT_PREFIX + JSON.stringify(TaskResultFrame)   (machine-first, no body)

// Full version only (NOT MVP):
export type TaskProgressFrame = {
  v: 1; kind: "task-progress"; id: string; seq: number; // monotonic PER TASK (event-time ms,
  note: string; ts: number;                              // same discipline as statusfile.ts)
};
```

Parsing is total and defensive (house style: a malformed frame is treated as plain text and
surfaced, never thrown on): `parseTaskFrame(text)` returns
`{frame, body} | undefined`; a prefix match with bad JSON surfaces as-is. Caps: result 64k,
note 1k, artifacts ≤ 16. Frames bigger than the relay's 1 MiB textBytes are rejected at the
tool with a "move it to a file and reference it" hint rather than failing in the mailbox.

Status vocabulary — borrowed from A2A (per the acp doc's advice), mapped, not imported:

| A2A TaskState           | here                                   | why |
|---|---|---|
| submitted               | pending-table `dispatched`             | local bookkeeping; no wire state needed |
| working                 | bus.6 status heartbeat (`working`)     | already shipped; identity-level, free |
| input-required          | bus.6 `blocked`                        | already shipped via hooks |
| completed               | `task-result status:"done"`            | the payload-carrying terminal |
| failed                  | `task-result status:"failed"`          | worker-REPORTED failure (it ran, it says no) |
| canceled / rejected     | (none in MVP)                          | convention via ordinary message; sec 3.6 |
| (no A2A equivalent)     | await-side `worker-gone`, `pending`    | OBSERVER states, deliberately not wire states: they describe the dispatcher's knowledge ("unknown"), not the task's truth |

That last row is the key honesty rule: wire states are things the WORKER asserts about the
task; `worker-gone`/`pending` are things the DISPATCHER failed to learn. Keeping them out
of the wire format makes it impossible to serialize "failed" when the truth is "unknown".

## 5. Reuse vs new: the three candidates, decided

### 5.a Extend handoff/send with taskId + reply convention — CHOSEN

What it is: sections 3–4. New frames over the existing send path; `formatHandoff` reused
verbatim for the body; ~1 new lean module + wiring in core.ts/mcp.ts/opencode-plugin.ts.

- Cost: smallest by far (~350 lines + tests, MVP). Zero new dependencies. Zero transport
  change — works today over broker AND relay, visible AND (future) headless workers, and
  for tasks given to sessions nobody spawned (a live peer can be a worker too, which
  neither A2A-rework nor ACP covers for free).
- Fit: matches every established pattern in this codebase — framed payloads, send-time
  resolve, stable-identity addressing, monotonic seq, "unknown not failed", bounded
  author-written text, two-writer files when durability arrives.
- Risk: the reply contract is CONVENTION — a worker agent can simply not call
  `agenthop_task_result`. Mitigations: the contract line travels IN the task body (the
  worker cannot miss it); bus.6 status gives the dispatcher an independent "went idle
  without reporting" signal; and the failure mode is a timeout reading "unknown", which
  the gather loop already must handle for crashes anyway. A convention that fails loudly
  into an already-handled path is acceptable for brick one.

### 5.b Rework the in-repo A2A task lifecycle into real delegation — REJECTED for this brick

The acp doc (5bis.1/5bis.4) already examined this; re-verified here: `@a2a-js/sdk` is a
real dependency of `packages/cli`, `host.ts` serves AgentCard + JSON-RPC with
`InMemoryTaskStore`, and `room.ts` completes every task instantly with an "Ack" artifact.
Making it real means:

- Holding a Task open in the RECEIVER across an entire agent turn and feeding the agent's
  eventual completion back into the executor — a rework of the receive path that today
  terminates at "surface the text in the TUI"; there is currently NO programmatic signal
  "the agent finished responding to message X" to complete the task with (the closest is
  the bus.6 idle hook, which is identity-level, not per-message).
- Dragging the express/AgentCard/relay-room layer (measured 2.1 MB / 464 modules in the
  Phase-2 decision) into the LOCAL dispatch path where the broker already does the job, or
  running two different task mechanisms for local vs remote.
- No durability gain: `InMemoryTaskStore` dies with the process, same as the MVP table.

What survives from A2A: its lifecycle VOCABULARY (sec 4's table) and the artifact concept.
REVISIT trigger (unchanged from the acp doc, made precise): adopt real A2A tasks only when
cross-machine tasks need a lifecycle that outlives BOTH endpoints simultaneously (a durable
third-party store) — i.e. when the relay itself must remember tasks. Nothing in
gather/reduce or verify/critic needs that.

### 5.c ACP — correctly DEFERRED (different axis)

ACP solves "drive an agent subprocess you own" (structured streaming, permission policy,
protocol cancel, multi-turn). It does not address dispatcher↔peer result-return over the
bus at all — an ACP child is not a bus peer unless injected (acp doc 5.3). When bus.8
adds an ACP backend to headless spawn, the integration point with THIS design is one line:
the ACP driver already accumulates the result text in-process, so the spawn machinery
calls the same completion path a `task-result` frame would (sec 7.3) — the task envelope
is the UNIFORM outer layer; ACP is one of several ways a worker produces the bytes.

### Verdict

(a), decisively. It is the only option that is small, transport-agnostic, worker-agnostic
(spawned or not, visible or headless, any tool), and shippable before bus.7 Track A lands.
(b) duplicates it at 10x cost for a durability it does not actually deliver; (c) is a
worker-side execution backend, not a result-return mechanism.

## 6. Distributed-systems concerns, one by one

### 6.1 Correlation across machines

The taskId is minted by the dispatcher and travels inside the sealed payload, so it is
end-to-end: the broker, bridge, directory and relay never parse it (they move opaque
text — `dm.ts` explicitly promises "do not assume any structure"). Correlation therefore
works identically local and cross-machine, including through the OpenCode gateway (the
bridge forwards opaque text both ways). The only cross-machine difference is LATENCY:
directory announce/poll makes peer discovery ~5s eventual and a restarted peer's fresh
mailbox takes up to ~60s (next announce) to republish — which is why result delivery
retries (6.4) and why timeouts mean "unknown" (6.2). Clocks are never compared across
machines: `ts` fields are informational, ordering is per-source seq only (6.6).

### 6.2 Timeouts — and what a timeout MEANS

A timeout is a statement about the DISPATCHER's knowledge, not the task: the worker may
still be working (long task), may have finished but be unable to deliver yet (requester
mid-restart, relay blip), or may be dead. These are indistinguishable from the waiting
side at timeout instant — so the await return for an un-terminal task is `pending` with
exactly the bridge's "unknown" discipline:

> Timed out; t-... is still UNKNOWN — not failed. The worker may still finish and its
> result will be collected by the next await. Check the worker (agenthop_peers /
> agenthop_wait_peer) before re-dispatching; re-dispatching duplicates the WORK.

Two timers, two meanings, kept separate:
- the AWAIT timeout (caller-chosen, ≤ 290s per MCP call, re-callable forever): purely "how
  long this tool call blocks";
- the task TTL (full version; pending entries garbage-collect after e.g. 24h): purely
  "when the dispatcher stops holding table/spool state", at which point a late result
  degrades to the orphan/auto-surface path (3.4) — still never dropped.

Nothing ever auto-transitions a task to `failed`. `failed` is worker-asserted only.

### 6.3 Retries + idempotency — never double-run a task

Split the problem by which leg retries:

- **Task delivery (dispatcher → worker):** `agenthop_task` does NOT auto-retry a send the
  transport reported ok (that ok is weak — 2.1 — but a retry would be worse: the message
  may well have arrived, and a duplicate task frame is a duplicate INSTRUCTION to an
  agent). When send fails outright (peer unresolvable / broker write failed), the tool
  reports it and the dispatcher re-dispatches — safe because nothing was delivered. For
  the ambiguous middle (transport ok, no progress/status ever observed), re-dispatch is an
  AGENT decision; the defense in depth is receive-side dedup: the worker's bus node keeps
  a seen-taskId set (bounded LRU; spool-backed in the full version) and drops a duplicate
  `task` frame for an id it already surfaced — so even a wrongly-repeated dispatch of the
  SAME taskId does not become two instructions. (A re-dispatch with a FRESH taskId is by
  definition a new task; no mechanism can or should stop an agent that chooses that.)
- **Result delivery (worker → dispatcher):** retried FREELY with backoff until the TTL,
  because receive is idempotent: the pending table resolves a taskId once; later
  duplicates of a terminal frame are dropped (3.4). This asymmetry is the heart of the
  design — make the leg that must be reliable idempotent, leave the leg with side effects
  un-retried by default.
- **Exactly-once execution is NOT claimed.** The system provides at-most-once instruction
  per taskId (receive dedup) and at-least-once result delivery attempt per taskId (worker
  retry + orphan surfacing). The agent-level loop on top (don't re-dispatch on "unknown"
  without checking) is guidance in the tool text, enforced by nothing — honest limit.

### 6.4 Result delivery when the requester RESTARTED

The case the stable-identity model was built for; walk every scenario:

1. **Requester process restarts, SAME native session (Claude resume: same
   CLAUDE_CODE_SESSION_ID; Codex: same thread id).** Its new run re-announces the same
   stableId on the broker (instant) and directory (≤ 60s). The worker's send-time resolve
   (3.3) finds it: locally via the roster, cross-machine via the fresh directory entry
   whose pub key is NEW — which is exactly why the frame carries no key. Result arrives.
   BUT the new run's pending table is EMPTY, so the frame takes the orphan path (3.4):
   rendered + auto-surfaced into the requester's TUI, claimable by a late
   `agenthop_task_await(task_ids:[...])`. The requester knows its outstanding ids — they
   are in its own transcript, written there when `agenthop_task` returned. Net: the result
   routes back AND reaches the agent; only the silent-resolve nicety is lost. (Full
   version: the spool makes even the table survive, 8.2.)
2. **Requester restarts as a NEW session (new conversation → new stableId).** The ladder's
   stableId rung fails; the title rung — `tool:dir-<shortId(stableId)>` — ALSO fails,
   because the suffix derives from the old stableId. The result cannot route; it expires
   at the worker's TTL with the worker's node noting "requester gone". This is CORRECT
   behavior, not a gap: a new conversation has no memory of dispatching the task, and
   pushing an unrequested result into an unrelated session would be misdelivery. The
   human/agent recovery is manual and legible: the worker's transcript holds the result;
   the memory doc's standing rule "address by stable PREFIX" does NOT get a prefix rung
   here on purpose (3.3) — prefix match may hit a different same-dir session.
3. **Requester is down AT completion time, back later.** Worker retry (backoff up to TTL,
   e.g. 1s → 2s → ... capped 60s, for 24h) bridges any outage shorter than the TTL. No
   relay-side mailbox persistence exists to lean on (2.2) — the worker process IS the
   durable buffer, which also means: **if the worker exits before the requester returns,
   the undelivered result dies with it** in the MVP. The worker's visible transcript (or
   headless capture, 7.2) remains the backstop. Full version: the worker spools
   undelivered results to disk and a restarted worker NODE re-attempts them (same
   two-file discipline as spawn registry) — but note a restarted worker AGENT is a new
   conversation; only the node-level spool survives, so this is a bus.8 nicety, not MVP.

### 6.5 Partial failure — worker dies mid-task

The dispatcher pinned the worker's run id + identity at dispatch (3.2, reusing the
waitForStatus pin). Await distinguishes:

- pinned run leaves roster, no result, no same-identity successor → `worker-gone`
  (outcome UNKNOWN — it may have delivered to disk/transcript before dying; wording per
  6.2). For a SPAWNED worker the dispatcher can additionally check the launch registry /
  window (7.1).
- pinned run leaves, a NEW run with the SAME stableId appears (worker restarted/resumed) →
  await keeps waiting and notes "worker restarted; same session". Its agent may or may not
  still have the task in context — for a resumed Claude session it does (transcript);
  dispatcher judgment applies at timeout.
- bus.6 status gives the early warning long before timeout: a worker that died stops
  being on the roster at all (local, instant) or TTLs out of the directory (≤ 150s);
  a worker that is stuck shows `working` forever or `blocked` (needs approval). The
  gather loop's cheap health probe is `agenthop_peers`, no new mechanism.

### 6.6 Ordering + duplicates

- **Correlation does the heavy lifting**: results are matched by taskId, so cross-task
  ordering is irrelevant (gather is unordered by nature). No global order is needed or
  pretended.
- **Per-task duplicates**: terminal frames are absorbing — first `task-result` for an id
  wins; any later frame for the same id (duplicate retry, or a confused worker sending
  done after failed) is dropped with a debug note. This is the drop-if-not-newer idea in
  its simplest form (terminal beats everything).
- **Progress frames (full version) reuse the monotonic-seq discipline literally**:
  `seq` = event-time ms captured at the source (statusfile.ts precedent), per-task,
  drop-if-not-newer, and a terminal state ignores any late progress. Without this, a
  delayed "working on step 2" could arrive after "done" and confuse a UI; with it, the
  pattern is already proven in-repo.
- **Duplicate TASK frames**: receive-side seen-id dedup (6.3). The seen set must survive
  what the pending table survives: in-memory MVP (a worker node restart could in theory
  re-surface a re-sent duplicate — accepted; task delivery is not auto-retried, so this
  requires a manual re-dispatch of the same id, which nothing does today), spooled in the
  full version.

## 7. Interaction with agenthop_spawn and headless mode

### 7.1 Visible spawn (shipped, bus.5)

Today's flow is spawn → wait for the peer to appear → handoff. With tasks it becomes
spawn → wait for peer → `agenthop_task` → `agenthop_task_await`. Two cheap integrations:

- **Record the association**: when a dispatcher tasks a session whose stableId/claim maps
  to one of ITS launch records, note `taskIds` on the dispatcher side keyed by launchId
  (dispatcher-owned file, never the child's claim file — same two-writer rule). Then
  `agenthop_spawned` can show "window ..., tool codex, 2 tasks outstanding", and despawn
  can warn "t-... still pending on this worker — await or accept unknown before closing".
- **Lifecycle hygiene**: the natural collective loop is spawn → task → await →
  (optionally task again — a visible worker is multi-turn for free, it is a live session)
  → despawn. The despawn-side warning is the only guard needed; no auto-despawn on result
  (the user watches these windows by design).

An optional later convenience — `agenthop_spawn(..., task: "...")` that injects the task
frame as the child's first input — is deliberately NOT in the MVP: the shipped visible
flow already has the "wait for peer then send" step, and fusing spawn+task hides the
one failure mode (child never joins the bus) that the two-step flow surfaces naturally.

### 7.2 Headless spawn (bus.7 Track A, being built) — the case that NEEDS this brick

A headless worker has no window to read, so result-return is not a nicety but the only
output channel. Two sub-cases, per the bus.7 design note (native non-interactive exec:
`claude -p` / `codex exec` / `opencode run`):

- **The headless child CAN load the agenthop MCP and join the bus** (to be verified per
  tool at build time, per the bus.7 note): then nothing special — the task frame goes in
  as (or with) the prompt, the child calls `agenthop_task_result` like any worker, and
  the same envelope covers visible and headless uniformly. The prompt handed to the exec
  backend is simply the task frame's human body (formatHandoff output + contract line) —
  one representation everywhere.
- **It cannot** (exec mode without MCP, or a tool whose exec mode blocks it): the
  DISPATCHER's spawn machinery owns the child's stdout anyway (bus.7 fallback: "parent
  captures stdout"). Then the spawn layer SYNTHESIZES the result frame: on child exit,
  build `task-result` with `status: exitCode === 0 ? "done" : "failed"`, `result` =
  captured stdout (capped; overflow to a file artifact under the launch registry dir),
  `from` = the launch handle — and feed it into the SAME completion path as a received
  frame. The pending table cannot tell the difference, and `agenthop_task_await` just
  works. One caveat to encode: exit 0 with empty stdout becomes `done` with result
  "(no output)" — never invented content.

This synthesized path is also exactly where a future ACP backend plugs in (5.c): the ACP
driver's accumulated agent_message_chunks + stopReason map to `result` + `status`
(`end_turn` → done; `refusal`/`max_tokens`/`max_turn_requests` → failed with the reason;
`cancelled` → the dispatcher knows, it cancelled). The task envelope is the stable outer
interface; exec/ACP/bus-joined are three interchangeable producers.

### 7.3 Who correlates for spawned workers

For spawned workers the dispatcher holds BOTH ends (it minted the taskId and owns the
launchId), so the full version records `taskId ↔ launchId` and gains for free: despawn
warnings (7.1), headless result synthesis targeting the right task (7.2), and a precise
`worker-gone` (launch registry + claim file say more than roster absence — e.g. "child
pid exited code 137"). None of this is needed for correctness; it sharpens diagnostics.

## 8. Minimal viable version vs full version

### 8.1 MVP — unblocks gather/reduce + verify/critic; shippable next

Scope (one PR-sized slice, mirrors how bus.6 Slice A shipped):

- `task.ts` (lean): frame types, build/parse, caps. Pure functions, direct tests.
- `core.ts`: pending table (in-memory Map), inbound interception (task-frame dedup +
  replyTo memory on the worker side; result matching + orphan buffer, cap 32, on the
  dispatcher side), result-send-with-retry (backoff 1s..60s, TTL 1h in MVP), awaitTasks()
  with run-pin + gone-detection (reuse waitForStatus's internals).
- `mcp.ts`: three tools — `agenthop_task`, `agenthop_task_result`,
  `agenthop_task_await` — plus busInstructions() text teaching the contract.
- `opencode-plugin.ts`: same three tools via the shared deliver/resolve helpers (the
  frame functions live in the lean module precisely so the plugin can import them).
- Timeout wording audits: every path says "unknown", never "failed", unless the worker
  said failed.

Explicitly OUT of the MVP: progress frames; spool/durability (a dispatcher node restart
degrades to orphan-surface + re-await, 6.4.1 — acceptable); cancel protocol; spawn
integration beyond what already works by composition (spawn → task → await needs zero
spawn.ts changes); taskId↔launchId records; cross-machine artifact transfer.

Size estimate: ~350 lines of src + tests in the existing suites' style. No version bump
coupling: old nodes receiving a task frame surface it as readable text with the contract
line intact (graceful degradation by construction, 3.1) — the worker agent can still
reply with a plain message quoting the task id; only auto-correlation needs both ends
upgraded.

### 8.2 Full version — durable-ish lifecycle (bus.8+, build on demonstrated need)

- **Task spool**: `~/.agenthop/tasks/<taskId>.json` dispatcher-owned +
  `<taskId>.result.json` worker-node-owned where local (two-writer discipline from
  spawn.ts; versioned-file max-register from statusfile.ts for state transitions). Gives:
  pending table that survives dispatcher node restarts; worker-side undelivered-result
  retry across node restarts; seen-id dedup that survives restarts.
- **Progress frames** with per-task monotonic seq (6.6) + `agenthop_task_await` returning
  interim progress — the UX for long tasks.
- **taskId ↔ launchId** association + despawn warnings + headless synthesis precision (7).
- **Delivery acks**: dispatcher node sends a tiny `task-result-ack` so the worker can stop
  retrying early (pure optimization; the TTL bounds it anyway).
- **Cancel**: a `task-cancel` frame with the same best-effort semantics as a message
  ("please stop; reply failed/acknowledged"), still never auto-failing the task.
- **Revisit-A2A checkpoint** (from 5.b): only if tasks must outlive both endpoints —
  i.e. a third place (relay) must hold task state. That is a different product
  (durable job queue), and the honest move then is real A2A tasks on the relay layer,
  per the acp doc.

## 9. Worked end-to-end example: 3 workers → gather → aggregator

Dispatcher D is `claude:Work-20cab0a5` on machine A. Workers: W1 spawned headless-local,
W2 spawned visible-local, W3 a live Codex session on machine B (team relay on).

```
# 1. Fan out (W1/W2 spawned; W3 already live)
D: agenthop_spawn(tool:"codex",  cwd:"/repo", visible:false)   -> launchId L1
D: agenthop_spawn(tool:"claude", cwd:"/repo")                  -> launchId L2, window w42
D: agenthop_peers()        # wait until L1/L2's sessions appear (and W3 is listed @machineB)

D: agenthop_task(to:"codex:repo-a1b2c3d4",  summary:"Audit packages/bus/src/broker.ts for
     races; list findings as P1/P2/P3 with line refs", next:"...")        -> t-aaaa...
D: agenthop_task(to:"claude:repo-e5f6a7b8", summary:"Same audit, directory.ts")-> t-bbbb...
D: agenthop_task(to:"codex:Work",           summary:"Same audit, mailbox.ts") -> t-cccc...
     # W3 resolved by stable prefix at DISPATCH (fine for tasks; results come back on the
     # full ladder). Each worker's TUI/exec-prompt shows the handoff body + contract line.

# 2. Workers work. Status heartbeat is free (bus.6 hooks): D can glance at
D: agenthop_peers()        # ... codex:repo-a1b2 [working] ... claude:repo-e5f6 [blocked: approval]

# 3. Gather loop — re-callable await, collect as they land
D: agenthop_task_await(timeout_seconds: 240)
   -> t-bbbb: done  result:"P2: directory.ts pull() epoch ... (3 findings)"
D: agenthop_task_await(timeout_seconds: 240)
   -> t-aaaa: done  result:"P1: broker routeDm drops ... (5 findings)"
      t-cccc: pending ("still unknown — worker may still finish; not failed")
D: agenthop_wait_peer(to:"codex:Work", until:["idle"], timeout_seconds: 120)
   -> reached: idle        # W3 finished its turn but maybe forgot the contract...
D: agenthop_task_await(task_ids:["t-cccc"], timeout_seconds: 60)
   -> t-cccc: done  result:"mailbox.ts: 2 findings..."   # it reported; relay took ~5s
      # (If it truly forgot: D sends an ordinary nudge "please agenthop_task_result
      #  t-cccc"; if W3's RUN had vanished instead: worker-gone — outcome unknown.)

# 4. Aggregate — the reduce step is itself just another task
D: agenthop_task(to:"claude:repo-e5f6a7b8", summary:"Merge these three audit reports,
     dedupe overlapping findings, rank: <t-aaaa result> <t-bbbb result> <t-cccc result>")
   -> t-dddd
D: agenthop_task_await(task_ids:["t-dddd"], timeout_seconds: 240) -> done: merged report

# 5. Tear down what D spawned (and only that)
D: agenthop_despawn(L1); agenthop_despawn(L2)   # full version would warn if tasks pending
```

Failure drill, same scenario: machine B reboots after W3 computed its result but before
delivery. W3's node (if still alive) retries toward `replyTo` — if D meanwhile restarted
as a RESUMED session, the retry lands on D's re-announced stableId and auto-surfaces as an
orphan result; D re-claims it with `agenthop_task_await(task_ids:["t-cccc"])` (ids from
its transcript). If W3's process died with the result undelivered: MVP answer is
`worker-gone` → UNKNOWN; D checks W3's transcript or re-dispatches with a fresh taskId,
knowing the receive-side dedup makes the old id inert either way.

## 10. Recommendation and summary

Build option (a): the `[[agenthop:task]]` / `[[agenthop:task-result]]` envelope over the
existing send path, with `agenthop_task` / `agenthop_task_result` / `agenthop_task_await`
as the three new tools and A2A's lifecycle words as vocabulary only. Ship the sec 8.1 MVP
(in-memory pending table, send-time ladder resolve, worker-side bounded retry, orphan
surfacing, "unknown never failed" wording) before or alongside bus.7 Track A, because
headless spawn is unusable without a result channel; wire the headless stdout-synthesis
path (7.2) into the same completion function from day one.

The top distributed-systems gotcha, worth repeating because it silently shapes every other
decision: **the bus has no store-and-forward and relay mailboxes are keyed to ephemeral
per-run keys — a result can only ever be delivered to a LIVE run of the requester, found
by resolving its stable identity at send time.** Any design that bakes a reply address
(key, run id, or mailbox room) into the task frame is wrong on this bus; any timeout
message that says "failed" instead of "unknown" invites the double-dispatch bug the
Phase-2 bridge review already taught us to avoid.

Unverified claims, flagged: whether each tool's headless exec mode can load the agenthop
MCP (bus.7's own open verification item — 7.2 works either way); worker-agent compliance
rates with the reply contract in practice (mitigations in 5.a, measurable only by
dogfooding); the exact TTL/backoff constants (placeholders; tune on real gather runs).
Everything in sec 2 is code-verified as of 2026-10-01.

