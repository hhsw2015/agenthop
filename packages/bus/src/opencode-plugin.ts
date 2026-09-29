import { randomUUID } from "node:crypto";
// `tool` (and its bundled zod at `tool.schema`) come from OpenCode at load time; kept external in the
// build. This file is excluded from the package tsconfig since @opencode-ai/plugin isn't a bus dep.
import { tool } from "@opencode-ai/plugin";
import { startLocalBus, type Inbound, type LocalBus } from "./broker.js";
import { sessionTitle, type SelfInfo } from "./label.js";
import { resolvePeer, type UnifiedPeer } from "./resolve.js";

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
 * session, and every tool operates on the caller's own session (ToolContext.sessionID). This avoids the
 * cross-session mis-injection / identity churn a single shared peer would cause.
 */

/** Minimal shapes of the OpenCode client + tool context we use (kept local to avoid a type dep). */
type PromptResult = { error?: unknown; response?: { ok?: boolean } } | undefined;
type OpencodeClient = {
  session: { promptAsync(opts: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }): Promise<PromptResult> };
};
type PluginInput = { client: OpencodeClient; directory?: string };
type ToolContext = { sessionID: string };

type SessionBus = { local: LocalBus; self: SelfInfo; queue: Inbound[] };

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

  const unified = (b: SessionBus): UnifiedPeer[] =>
    b.local.peers().map((p) => ({ id: p.id, stableId: p.stableId, tool: p.tool, cwd: p.cwd, title: p.title, via: "local", pid: p.pid }));

  const labelFor = (b: SessionBus, id: string): string => {
    const p = unified(b).find((x) => x.id === id || x.stableId === id);
    return p ? p.title : id.slice(0, 8);
  };

  // Lazily create a distinct bus peer for a session. Its identity IS the session id (handle
  // opencode:<dir>-<shortId>), and its inbound injects only into that same session.
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
    b.local = startLocalBus(self, undefined, (m) => {
      void inject(sessionID, labelFor(b, m.from), m.payload).then((ok) => {
        if (!ok) b.queue.push(m); // no session to inject into yet / promptAsync failed -> agenthop_recv
      });
    });
    buses.set(sessionID, b);
    return b;
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
        await b.local.close();
      }
    },
    tool: {
      agenthop_peers: tool({
        description:
          "List agent sessions reachable right now (Claude Code, Codex, OpenCode, or any other) with no pairing code. Same-machine sessions appear automatically.",
        args: {},
        async execute(_args: unknown, context: ToolContext): Promise<string> {
          const b = busFor(context.sessionID);
          const rows = unified(b)
            .filter((p) => p.id !== b.self.id)
            .map((p) => `  ${p.title}  ${p.cwd}  (run ${p.id.slice(0, 8)})`);
          return `${b.local.role()} bus; ${rows.length} other session(s)\n${rows.join("\n") || "  (no other sessions)"}`;
        },
      }),
      agenthop_send: tool({
        description:
          "Send a message to another agent session by its handle (tool:dir-<shortId>; a prefix like 'claude:Work' works when unambiguous) or its session id. It surfaces in that session automatically.",
        args: {
          to: tool.schema.string().describe("Target: a session handle/prefix or session id (see agenthop_peers)"),
          text: tool.schema.string().describe("The message to send"),
        },
        async execute({ to, text }: { to: string; text: string }, context: ToolContext): Promise<string> {
          if (!text || !text.trim()) return "Nothing to send.";
          const b = busFor(context.sessionID);
          const peer = resolvePeer(unified(b), b.self.id, to);
          if ("error" in peer) return peer.error;
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
      for (const b of buses.values()) await b.local.close();
      buses.clear();
    },
  };
};
