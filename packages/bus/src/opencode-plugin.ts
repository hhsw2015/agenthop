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
import { sessionTitle, type SelfInfo } from "./label.js";
import { resolvePeer, type UnifiedPeer } from "./resolve.js";
import { loadTeam } from "./team.js";

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
type BridgeClient = {
  /** Latest remote roster the gateway pushed (empty until it connects). */
  roster(): UnifiedPeer[];
  /** Seal+relay to a remote peer's public key via the gateway. false if it did not go. */
  send(pub: string, text: string): Promise<boolean>;
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

function startBridgeClient(self: SelfInfo, onInbound: (from: string, text: string) => void): BridgeClient {
  const sock = bridgeSocketPath();
  let socket: net.Socket | undefined;
  let closed = false;
  let roster: UnifiedPeer[] = [];
  let lastSpawn = 0;
  let rid = 0;
  const pending = new Map<number, (ok: boolean) => void>();

  const onLine = (line: string): void => {
    let msg: { t?: string; peers?: UnifiedPeer[]; from?: string; text?: string; rid?: number; ok?: boolean };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.t === "roster" && Array.isArray(msg.peers)) roster = msg.peers;
    else if (msg.t === "inbound" && typeof msg.text === "string") onInbound(String(msg.from ?? ""), msg.text);
    else if (msg.t === "sent" && typeof msg.rid === "number") {
      const resolve = pending.get(msg.rid);
      if (resolve) {
        pending.delete(msg.rid);
        resolve(!!msg.ok);
      }
    }
  };

  const ensureBridge = (): void => {
    // Spawn the gateway if we cannot reach one. Rate-limited: a live bridge makes a duplicate launch
    // exit at once (it holds the socket), so an occasional extra spawn is harmless.
    if (Date.now() - lastSpawn < 3_000) return;
    lastSpawn = Date.now();
    try {
      spawn(agenthopBin(), ["bus-bridge"], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // best effort; the next reconnect tries again
    }
  };

  const connect = (): void => {
    if (closed) return;
    const s = net.connect(sock);
    let buffer = "";
    s.setEncoding("utf8");
    s.on("connect", () => {
      socket = s;
      s.write(`${JSON.stringify({ t: "hello", self })}\n`);
    });
    s.on("data", (chunk: string) => {
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
      if (closed) return;
      ensureBridge(); // no bridge there (or it died) -> (re)spawn, then retry
      setTimeout(connect, 500);
    });
  };
  connect();

  return {
    roster: () => roster,
    send: (pub, text) =>
      new Promise<boolean>((resolve) => {
        if (!socket || socket.destroyed) {
          resolve(false);
          return;
        }
        const id = ++rid;
        pending.set(id, resolve);
        socket.write(`${JSON.stringify({ t: "send", rid: id, pub, text })}\n`);
        setTimeout(() => {
          if (pending.delete(id)) resolve(false);
        }, 10_000);
      }),
    close: () => {
      closed = true;
      for (const resolve of pending.values()) resolve(false);
      pending.clear();
      socket?.destroy();
      socket = undefined;
    },
  };
}

export const AgenthopBusPlugin = async ({ client, directory }: PluginInput) => {
  const cwd = directory || process.cwd();
  const buses = new Map<string, SessionBus>();

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
    for (const p of b.local.peers()) out.set(p.id, { id: p.id, stableId: p.stableId, tool: p.tool, cwd: p.cwd, title: p.title, via: "local", pid: p.pid });
    if (b.bridge) for (const p of b.bridge.roster()) if (!out.has(p.id)) out.set(p.id, p);
    return [...out.values()];
  };

  const labelFor = (b: SessionBus, id: string): string => {
    const p = unified(b).find((x) => x.id === id || x.stableId === id || x.pub === id);
    if (!p) return id.slice(0, 8);
    return `${p.title}${p.via === "relay" ? `@${p.machine ?? "remote"}` : ""}`;
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
    // Cross-machine is opt-in: only when a team secret exists (env or ~/.agenthop/bus.json).
    if (loadTeam()) b.bridge = startBridgeClient(self, deliver);
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
    // Tear a session's bus peer down when the session is deleted, so it leaves the roster promptly.
    event: async ({ event }: { event: { type: string; properties?: { info?: { id?: string } } } }): Promise<void> => {
      if (event?.type !== "session.deleted") return;
      const id = event.properties?.info?.id;
      const b = id ? buses.get(id) : undefined;
      if (b && id) {
        buses.delete(id);
        await closeBus(b);
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
            .map((p) => `  ${p.title}${p.via === "relay" ? `@${p.machine ?? "remote"}` : ""}  ${p.cwd}  (run ${p.id.slice(0, 8)})`);
          const scope = b.bridge ? "broker + team relay" : "broker (same-machine)";
          return `${b.local.role()} bus; ${scope}; ${rows.length} other session(s)\n${rows.join("\n") || "  (no other sessions)"}`;
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
          const b = busFor(context.sessionID);
          const peer = resolvePeer(unified(b), b.self.id, to);
          if ("error" in peer) return peer.error;
          if (peer.via === "relay") {
            if (!b.bridge || !peer.pub) return `Cannot reach ${peer.title} — no team relay configured here (set AGENTHOP_TEAM).`;
            const ok = await b.bridge.send(peer.pub, text);
            return ok ? `Sent to ${peer.title}.` : `Not sent — ${peer.title} is not reachable right now.`;
          }
          const ok = b.local.send(peer.id, text);
          return ok ? `Sent to ${peer.title}.` : `Not sent — ${peer.title} is not reachable right now.`;
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
    },
    dispose: async (): Promise<void> => {
      for (const b of buses.values()) await closeBus(b);
      buses.clear();
    },
  };
};
