import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
// `tool` (and its bundled zod at `tool.schema`) come from OpenCode at load time; kept external in the
// build. This file is excluded from the package tsconfig since @opencode-ai/plugin isn't a bus dep.
import { tool } from "@opencode-ai/plugin";
import { bridgeSocketPath, startLocalBus, type Inbound, type LocalBus } from "./broker.js";
import { formatHandoff } from "./handoff.js";
import { sessionTitle, type AgentStatus, type SelfInfo } from "./label.js";
import { resolvePeer, type UnifiedPeer } from "./resolve.js";
import { despawnAgent, readRegistry, spawnAgent, startClaimRetry } from "./spawn.js";
import { loadTeam } from "./team.js";
import { omniwmctl, splitArgs } from "./wm.js";

/**
 * The agenthop session bus, as an OpenCode server plugin. It makes each OpenCode session a first-class
 * bus peer: the session joins the same-machine broker (~/.agenthop/bus.sock), exposes
 * agenthop_peers/send/recv, and — the whole point — AUTO-SURFACES an inbound message straight into that
 * running session via client.session.promptAsync (no polling), matching Claude Code's cc-socks and
 * Codex's `codex queue`. OpenCode hands a plugin the authenticated `client` and the session id per hook,
 * which the MCP path can't get — so a plugin is the only way to get idle-push for OpenCode.
 *
 * PER-SESSION: one plugin instance runs per OpenCode server, but a single server can hold several
 * sessions, so we keep a SEPARATE bus peer (own broker connection, own identity = that session id, own
 * fallback queue) per session, keyed by session id. A session's inbound injects only into that same
 * session, and every tool operates on the caller's own session (ToolContext.sessionID).
 *
 * CROSS-MACHINE: the relay half pulls in ~2 MB of deps (express + a2a sdk), too heavy to bundle into a
 * plugin. So when a team is configured, each session also connects to the per-machine GATEWAY (the
 * native `agenthop bus-bridge` daemon, spawned on demand) over a unix socket: the gateway runs the
 * relay for this session's identity, pushes the remote roster down, and forwards remote DMs back here
 * to inject. The plugin stays lean — just a socket client.
 */

/** Minimal shapes of the OpenCode client + tool context we use (kept local to avoid a type dep). */
type PromptResult = { error?: unknown; response?: { ok?: boolean } } | undefined;
type OpencodeClient = {
  session: { promptAsync(opts: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }): Promise<PromptResult> };
};
type PluginInput = { client: OpencodeClient; directory?: string };
type ToolContext = { sessionID: string };

type SessionBus = { local: LocalBus; self: SelfInfo; queue: Inbound[]; bridge?: BridgeClient };

/** Talks to the cross-machine gateway for one session. Lean: a socket, a cached roster, a send RPC. */
type SendResult = "sent" | "failed" | "unknown";
type BridgeClient = {
  /** Latest remote roster the gateway pushed (empty until it connects). */
  roster(): UnifiedPeer[];
  /**
   * Seal+relay to a remote peer's public key via the gateway. "sent"/"failed" are confirmed by the
   * gateway; "unknown" means no ack within the timeout — it may or may not have been delivered.
   */
  send(pub: string, text: string): Promise<SendResult>;
  close(): void;
};

/** Resolve the native agenthop binary to spawn the gateway with. Mirrors push.ts's codexBin(). */
function agenthopBin(): string {
  const candidates = [
    process.env.AGENTHOP_BIN,
    path.join(path.dirname(process.execPath), "agenthop"),
    path.join(homedir(), ".local", "bin", "agenthop"),
    "/usr/local/bin/agenthop",
    "/opt/homebrew/bin/agenthop",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // keep looking
    }
  }
  return "agenthop";
}

function startBridgeClient(self: SelfInfo, onInbound: (from: string, text: string) => void, teamId: string): BridgeClient {
  const sock = bridgeSocketPath();
  let socket: net.Socket | undefined;
  let closed = false;
  let rejected = false; // the gateway serves a different team -> stop reconnecting (fail safe)
  let roster: UnifiedPeer[] = [];
  let lastSpawn = 0;
  let rid = 0;
  const pending = new Map<number, { resolve: (r: SendResult) => void; timer: NodeJS.Timeout }>();

  const onLine = (line: string): void => {
    let msg: { t?: string; peers?: UnifiedPeer[]; from?: string; text?: string; rid?: number; ok?: boolean };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.t === "roster" && Array.isArray(msg.peers)) roster = msg.peers;
    else if (msg.t === "inbound" && typeof msg.text === "string") onInbound(String(msg.from ?? ""), msg.text);
    else if (msg.t === "rejected") {
      rejected = true; // a different-team gateway holds the socket; do not fight it
      roster = [];
      socket?.destroy();
    } else if (msg.t === "sent" && typeof msg.rid === "number") {
      const p = pending.get(msg.rid);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.rid);
        p.resolve(msg.ok ? "sent" : "failed");
      }
    }
  };

  const ensureBridge = (): void => {
    // Spawn the gateway if we cannot reach one. Rate-limited: a live bridge makes a duplicate launch
    // exit at once (it holds the socket), so an occasional extra spawn is harmless.
    if (Date.now() - lastSpawn < 3_000) return;
    lastSpawn = Date.now();
    try {
      const child = spawn(agenthopBin(), ["bus-bridge"], { detached: true, stdio: "ignore" });
      // A ChildProcess emits 'error' asynchronously (e.g. the binary is missing/not executable); with
      // no listener that becomes an uncaught exception in the host. Swallow it — the reconnect retries.
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // best effort; the next reconnect tries again
    }
  };

  const connect = (): void => {
    if (closed || rejected) return;
    const s = net.connect(sock);
    socket = s; // track immediately, so close() before 'connect' still tears this socket down
    let buffer = "";
    s.setEncoding("utf8");
    s.on("connect", () => {
      if (closed) {
        s.destroy();
        return;
      }
      s.write(`${JSON.stringify({ t: "hello", self, team: teamId })}\n`);
    });
    s.on("data", (chunk: string) => {
      if (closed) return;
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    s.on("error", () => undefined); // handled by 'close'
    s.once("close", () => {
      if (socket === s) socket = undefined;
      roster = [];
      if (closed || rejected) return;
      ensureBridge(); // no bridge there (or it died) -> (re)spawn, then retry
      setTimeout(connect, 500);
    });
  };
  connect();

  return {
    roster: () => roster,
    send: (pub, text) =>
      new Promise<SendResult>((resolve) => {
        if (!socket || socket.destroyed || closed) {
          resolve("failed");
          return;
        }
        const id = ++rid;
        // Timeout resolves "unknown", never "failed": the gateway may have delivered it and only the
        // ack is slow, so the caller must not be told it certainly failed (which would invite a
        // duplicate resend). Cleared when the ack arrives.
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve("unknown");
        }, 10_000);
        pending.set(id, { resolve, timer });
        socket.write(`${JSON.stringify({ t: "send", rid: id, pub, text })}\n`);
      }),
    close: () => {
      closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        // These were written to the gateway and may well have been delivered; closing before the ack is
        // "unknown", not a confirmed failure — the caller must not be told it certainly did not send.
        p.resolve("unknown");
      }
      pending.clear();
      socket?.destroy(); // destroys a connected OR still-connecting socket
      socket = undefined;
    },
  };
}

export const AgenthopBusPlugin = async ({ client, directory }: PluginInput) => {
  const cwd = directory || process.cwd();
  const buses = new Map<string, SessionBus>();

  // If this OpenCode server was launched by agenthop_spawn, self-register the Ghostty surface it runs in
  // so despawn has an authoritative (agent-claimed) target. Bounded retry; a no-op unless spawned.
  startClaimRetry();

  const inject = async (sessionID: string, from: string, text: string): Promise<boolean> => {
    try {
      // OpenCode's loader builds the SDK client WITHOUT throwOnError, so an HTTP failure RESOLVES as
      // { error, response } rather than throwing. Inspect the resolved result (and still catch a thrown
      // one) — otherwise a failed inject would be reported as success and skip the fallback queue.
      const r = await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: `[bus] ${from}: ${text}` }] } });
      if (r?.error) return false;
      if (r?.response && r.response.ok === false) return false;
      return true;
    } catch {
      return false;
    }
  };

  // Local broker peers plus, when a team is set, the gateway's remote roster. A same-machine session
  // wins over a relay row with the same id (dedup), matching core.ts's unified().
  const unified = (b: SessionBus): UnifiedPeer[] => {
    const out = new Map<string, UnifiedPeer>();
    for (const p of b.local.peers()) out.set(p.id, { id: p.id, stableId: p.stableId, tool: p.tool, cwd: p.cwd, title: p.title, via: "local", pid: p.pid, status: p.status, statusSeq: p.statusSeq, statusText: p.statusText, statusAt: p.statusAt });
    if (b.bridge) for (const p of b.bridge.roster()) if (!out.has(p.id)) out.set(p.id, p);
    return [...out.values()];
  };

  // Set this session's own work state; it rides the roster to peers. Monotonic seq drops stale reports.
  const setStatus = (b: SessionBus, state: AgentStatus, opts?: { seq?: number; text?: string }): { ok: boolean; seq?: number } => {
    const seq = opts?.seq;
    if (seq !== undefined && b.self.statusSeq !== undefined && seq <= b.self.statusSeq) return { ok: false, seq: b.self.statusSeq };
    if (seq === undefined && b.self.statusSeq !== undefined && b.self.statusSeq >= Number.MAX_SAFE_INTEGER) return { ok: false, seq: b.self.statusSeq };
    const text = opts?.text?.trim() || undefined;
    const unchanged = state === b.self.status && text === b.self.statusText;
    b.self.status = state;
    b.self.statusSeq = seq ?? (b.self.statusSeq ?? 0) + 1;
    b.self.statusText = text;
    b.self.statusAt = Date.now();
    // Skip the roster re-announce when neither state nor text changed (only the seq advanced) — a repeated
    // session.status(busy)/working signal from the event feed must not spam peers.
    if (unchanged) return { ok: true, seq: b.self.statusSeq };
    b.local.updateSelf(b.self); // local roster; cross-machine status propagation is a follow-up
    return { ok: true, seq: b.self.statusSeq };
  };

  // Wait until `target` reaches one of `until` states (or vanishes / times out), pinning its identity.
  const waitForStatus = async (b: SessionBus, target: string, until: AgentStatus[], timeoutMs: number): Promise<{ status?: AgentStatus; reached: boolean; gone?: boolean; error?: string; label?: string }> => {
    const peer = resolvePeer(unified(b), b.self.id, target);
    if ("error" in peer) return { reached: false, error: peer.error };
    const pin = peer.id; // the exact run; a restart or same-stableId sibling won't satisfy the wait
    let pinIdentity = peer.stableId; // the native identity resolved; guards a mid-wait identity switch
    const label = labelFor(b, peer.id);
    const wanted = new Set(until);
    const deadline = Date.now() + timeoutMs;
    let last: AgentStatus | undefined;
    for (;;) {
      const now = unified(b).find((p) => p.id === pin);
      if (!now) return { reached: false, gone: true, label };
      // Lock onto the first concrete identity observed if we resolved before adoption (else a later
      // switch to a different identity would still satisfy).
      if (pinIdentity === undefined && now.stableId !== undefined) pinIdentity = now.stableId;
      const sameIdentity = pinIdentity === undefined || now.stableId === undefined || now.stableId === pinIdentity;
      if (sameIdentity) {
        last = now.status ?? "unknown"; // an unreported peer is "unknown", and matchable as such
        if (wanted.has(last)) return { reached: true, status: last, label };
      }
      if (Date.now() >= deadline) return { reached: false, status: last, label };
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const labelFor = (b: SessionBus, id: string): string => {
    const p = unified(b).find((x) => x.id === id || x.stableId === id || x.pub === id);
    if (!p) return id.slice(0, 8);
    return `${p.title}${p.via === "relay" ? `@${p.machine ?? "remote"}` : ""}`;
  };

  // Resolve `to` and deliver `text` (local broker or the cross-machine gateway). `label` phrases the
  // result ("Sent" / "Handed off"). Shared by agenthop_send and agenthop_handoff.
  const deliver = async (b: SessionBus, to: string, text: string, label: string): Promise<string> => {
    const peer = resolvePeer(unified(b), b.self.id, to);
    if ("error" in peer) return peer.error;
    if (peer.via === "relay") {
      if (!b.bridge || !peer.pub) return `Cannot reach ${peer.title} — no team relay configured here (set AGENTHOP_TEAM).`;
      const r = await b.bridge.send(peer.pub, text);
      if (r === "sent") return `${label} to ${peer.title}.`;
      if (r === "unknown") return `${label} to ${peer.title}, but no delivery confirmation within 10s — it may or may not have arrived; check before resending.`;
      return `Not delivered to ${peer.title} — not reachable right now.`;
    }
    const ok = b.local.send(peer.id, text);
    return ok ? `${label} to ${peer.title}.` : `Not delivered to ${peer.title} — not reachable right now.`;
  };

  // Lazily create a distinct bus peer for a session. Its identity IS the session id (handle
  // opencode:<dir>-<shortId>), its inbound injects only into that same session, and — when a team is
  // configured — it joins the cross-machine gateway under that same identity.
  const busFor = (sessionID: string): SessionBus => {
    const existing = buses.get(sessionID);
    if (existing) return existing;
    const self: SelfInfo = {
      id: randomUUID(),
      stableId: sessionID,
      tool: "opencode",
      cwd,
      pid: process.pid,
      title: sessionTitle("opencode", cwd, sessionID),
      startedAt: Date.now(),
    };
    const b = { self, queue: [] as Inbound[] } as SessionBus;
    const deliver = (from: string, text: string): void => {
      void inject(sessionID, labelFor(b, from), text).then((ok) => {
        if (!ok) b.queue.push({ from, payload: text, via: "local" }); // could not inject yet -> agenthop_recv
      });
    };
    b.local = startLocalBus(self, undefined, (m) => deliver(m.from, m.payload));
    // Cross-machine is opt-in: only when a team secret exists (env or ~/.agenthop/bus.json). The
    // team's public nsId (not the secret) is handed to the gateway so it only serves our own team.
    const team = loadTeam();
    if (team) b.bridge = startBridgeClient(self, deliver, team.nsId);
    buses.set(sessionID, b);
    return b;
  };

  const closeBus = async (b: SessionBus): Promise<void> => {
    b.bridge?.close();
    await b.local.close();
  };

  return {
    // A message in a session guarantees that session's bus peer exists and is announced.
    "chat.message": async (input: { sessionID: string }): Promise<void> => {
      busFor(input.sessionID);
    },
    // OpenCode's in-process event firehose. Two jobs: (1) tear a deleted session's bus down so it leaves the
    // roster promptly; (2) Slice B's status feed — map session/permission events to this session's work state
    // (fully in-process, no external hook or file — see docs/research/codex-opencode-hooks.md). Every
    // session-scoped event carries its own sessionID, so each updates exactly one peer.
    event: async ({ event }: { event: { type: string; properties?: { sessionID?: string; info?: { id?: string }; status?: { type?: string } } } }): Promise<void> => {
      const type = event?.type;
      const props = event?.properties ?? {};
      if (type === "session.deleted") {
        const id = props.info?.id;
        const b = id ? buses.get(id) : undefined;
        if (b && id) {
          buses.delete(id);
          await closeBus(b);
        }
        return;
      }
      const sid = props.sessionID;
      if (typeof sid !== "string" || !sid) return;
      const apply = (state: AgentStatus): void => void setStatus(busFor(sid), state);
      switch (type) {
        case "session.idle":
          apply("idle"); // turn finished
          break;
        // A permission is being awaited. The event name drifts across OpenCode SDK versions — the installed
        // 1.18.x emits "permission.asked" (older v1 d.ts had "permission.updated", the v2 union adds
        // "permission.v2.asked"), so accept all three to stay version-robust.
        case "permission.asked":
        case "permission.updated":
        case "permission.v2.asked":
          apply("blocked");
          break;
        case "permission.replied":
        case "permission.v2.replied":
          apply("working"); // approval answered -> back to work
          break;
        case "session.status":
          if (props.status?.type === "busy") apply("working");
          else if (props.status?.type === "idle") apply("idle");
          break;
      }
    },
    tool: {
      agenthop_peers: tool({
        description:
          "List agent sessions reachable right now (Claude Code, Codex, OpenCode, or any other). Same-machine sessions appear automatically; sessions on other machines appear when a shared AGENTHOP_TEAM is set.",
        args: {},
        async execute(_args: unknown, context: ToolContext): Promise<string> {
          const b = busFor(context.sessionID);
          const rows = unified(b)
            .filter((p) => p.id !== b.self.id)
            .map((p) => `  ${p.title}${p.via === "relay" ? `@${p.machine ?? "remote"}` : ""}  [${p.status ?? "unknown"}${p.statusText ? `: ${p.statusText}` : ""}]  ${p.cwd}  (run ${p.id.slice(0, 8)})`);
          const scope = b.bridge ? "broker + team relay" : "broker (same-machine)";
          return `${b.local.role()} bus; ${scope}; ${rows.length} other session(s)\n${rows.join("\n") || "  (no other sessions)"}`;
        },
      }),
      agenthop_report_status: tool({
        description:
          "Report THIS session's work state to peers (working | idle | blocked | unknown). Shows in agenthop_peers and lets a dispatcher agenthop_wait_peer on it. `blocked` = needs input (permission/approval/question).",
        args: {
          state: tool.schema.enum(["working", "idle", "blocked", "unknown"]).describe("This session's work state"),
          note: tool.schema.string().optional().describe("Optional short detail"),
          seq: tool.schema.number().int().optional().describe("Optional monotonic sequence (e.g. a timestamp); a report not newer than the last is ignored"),
        },
        async execute({ state, note, seq }: { state: AgentStatus; note?: string; seq?: number }, context: ToolContext): Promise<string> {
          const r = setStatus(busFor(context.sessionID), state, { text: note, seq });
          return r.ok ? `Status set to ${state} (seq ${r.seq}).` : `Ignored: a newer status (seq ${r.seq}) is already set.`;
        },
      }),
      agenthop_wait_peer: tool({
        description:
          "Wait until another session reaches a work state — e.g. a sub-agent you dispatched goes idle (done) or blocked (needs input). Returns when it reaches one of the states, vanishes, or times out. Pins the target's exact run.",
        args: {
          to: tool.schema.string().describe("Target session: handle/prefix or id (see agenthop_peers)"),
          until: tool.schema.array(tool.schema.enum(["working", "idle", "blocked", "unknown"])).optional().describe("States to wait for (default: idle, blocked)"),
          timeout_seconds: tool.schema.number().int().min(1).max(290).optional().describe("Seconds to wait, 30 by default"),
        },
        async execute({ to, until, timeout_seconds }: { to: string; until?: AgentStatus[]; timeout_seconds?: number }, context: ToolContext): Promise<string> {
          const states: AgentStatus[] = until && until.length ? until : ["idle", "blocked"];
          const secs = timeout_seconds ?? 30;
          const r = await waitForStatus(busFor(context.sessionID), to, states, secs * 1000);
          if (r.error) return r.error;
          if (r.gone) return `${r.label ?? to} is gone (left the bus) before reaching ${states.join("/")}.`;
          if (r.reached) return `${r.label ?? to} is now ${r.status}.`;
          return `Timed out after ${secs}s; ${r.label ?? to} is ${r.status ?? "unknown"}. Call agenthop_wait_peer again to keep waiting.`;
        },
      }),
      agenthop_send: tool({
        description:
          "Send a message to another agent session by its handle (tool:dir-<shortId>; a prefix like 'claude:Work' works when unambiguous) or its session id. It surfaces in that session automatically. Works across machines when a shared AGENTHOP_TEAM is set.",
        args: {
          to: tool.schema.string().describe("Target: a session handle/prefix or session id (see agenthop_peers)"),
          text: tool.schema.string().describe("The message to send"),
        },
        async execute({ to, text }: { to: string; text: string }, context: ToolContext): Promise<string> {
          if (!text || !text.trim()) return "Nothing to send.";
          return deliver(busFor(context.sessionID), to, text, "Sent");
        },
      }),
      agenthop_handoff: tool({
        description:
          "Hand a task off to another agent session so it can continue where you left off. You write the summary (goal, what's done, current state); the bus attaches a git snapshot of this session's directory and delivers it — it surfaces in the target session automatically. `to` is a session handle/prefix or session id (see agenthop_peers).",
        args: {
          to: tool.schema.string().describe("Target: a session handle/prefix or session id (see agenthop_peers)"),
          summary: tool.schema.string().describe("The task: goal, what you've done, and current state — the visible context the receiver needs to continue"),
          next: tool.schema.string().optional().describe("Explicit next steps for the receiver (optional)"),
        },
        async execute({ to, summary, next }: { to: string; summary: string; next?: string }, context: ToolContext): Promise<string> {
          if (!summary || !summary.trim()) return "Nothing to hand off (empty summary).";
          const b = busFor(context.sessionID);
          return deliver(b, to, formatHandoff(b.self.title, { summary, next }, cwd), "Handed off");
        },
      }),
      agenthop_recv: tool({
        description:
          "Fallback only: take bus messages that could not auto-surface. Incoming messages normally appear in this session on their own, so you rarely need this.",
        args: { timeout_seconds: tool.schema.number().int().min(1).max(290).optional().describe("Seconds to wait (default 5)") },
        async execute({ timeout_seconds }: { timeout_seconds?: number }, context: ToolContext): Promise<string> {
          const b = busFor(context.sessionID);
          const secs = timeout_seconds ?? 5;
          const deadline = Date.now() + secs * 1000;
          let batch = b.queue.splice(0, b.queue.length);
          while (batch.length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
            batch = b.queue.splice(0, b.queue.length);
          }
          if (batch.length === 0) return `No messages in ${secs}s.`;
          return batch.map((m) => `[from ${labelFor(b, m.from)}] ${m.payload}`).join("\n\n");
        },
      }),
      agenthop_spawn: tool({
        description:
          "Launch another agent CLI (claude | codex | opencode) in a VISIBLE terminal window on this machine, best-effort arranged via the window manager. The new session joins the bus on its own — hand it work with agenthop_handoff once it appears in agenthop_peers. Sub-agents start in no-confirmation mode so they run unattended. macOS + Ghostty.",
        args: {
          tool: tool.schema.string().describe("Which agent to launch: claude | codex | opencode"),
          cwd: tool.schema.string().optional().describe("Working directory for the new session (default: this session's dir)"),
          workspace: tool.schema.string().optional().describe("WM workspace to move it to (default: current; or AGENTHOP_SPAWN_WORKSPACE)"),
        },
        async execute({ tool: agent, cwd: dir, workspace }: { tool: string; cwd?: string; workspace?: string }): Promise<string> {
          // Resolve a relative cwd against THIS session's project dir, not the OpenCode server's cwd
          // (which may be elsewhere and hold a same-named subdir → wrong project).
          const resolved = dir ? path.resolve(cwd, dir) : cwd;
          const r = await spawnAgent({ tool: agent, cwd: resolved, workspace });
          return r.windowId ? `${r.note} (window ${r.windowId} — close later with agenthop_despawn)` : r.note;
        },
      }),
      agenthop_spawned: tool({
        description: "List the sub-agent windows agenthop dispatched on this machine (window id, tool, cwd) — the only ones agenthop_despawn may close.",
        args: {},
        async execute(): Promise<string> {
          const rows = readRegistry().map((r) => `  ${r.windowId ?? "(pending)"}  ${r.launchId}  ${r.tool}  ${r.cwd}`);
          return rows.length ? `spawned windows:\n${rows.join("\n")}` : "No agents spawned by agenthop on this machine.";
        },
      }),
      agenthop_despawn: tool({
        description:
          "Close a sub-agent agenthop spawned, by its window id or launch id (from agenthop_spawn / agenthop_spawned). Closes only the exact terminal surface it recorded (by that surface's stable UUID), never a whole window by its reusable window id; an id it never recorded is refused. Prefer the launch id if a window id is ambiguous.",
        args: { window_id: tool.schema.string().describe("The window id or launch id from agenthop_spawn / agenthop_spawned") },
        async execute({ window_id }: { window_id: string }): Promise<string> {
          // despawn closes only the recorded surface UUID (never a window by its reusable id); an
          // unrecorded id is refused. See spawn.ts for the capture-provenance residual (Phase-1 limit).
          const r = await despawnAgent(window_id);
          return r.note;
        },
      }),
      agenthop_wm: tool({
        description:
          'Drive the OmniWM window manager (macOS) to arrange windows — pass an omniwmctl command line, e.g. "query windows", "command focus left", "window move-to-workspace <id> 2", "workspace focus-name agents". One-shot only (no subscribe/watch). Includes window-closing ops; acts on your live desktop.',
        args: { args: tool.schema.string().describe('omniwmctl arguments, e.g. "query windows" or "window move-to-workspace <id> 2"') },
        async execute({ args }: { args: string }): Promise<string> {
          const r = await omniwmctl(splitArgs(args));
          return r.output;
        },
      }),
    },
    dispose: async (): Promise<void> => {
      for (const b of buses.values()) await closeBus(b);
      buses.clear();
    },
  };
};
