import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { startBusCore, type BusCore, type UnifiedPeer } from "./core.js";
import { formatHandoff } from "./handoff.js";
import { claimOwnSpawn, despawnAgent, readRegistry, spawnAgent } from "./spawn.js";
import { omniwmctl, splitArgs } from "./wm.js";
import { version } from "./version.js";

/**
 * The bus tools — agenthop_peers / send / recv — that make every session discoverable and reachable
 * with no pairing code, across Claude Code, Codex or anything else, on this machine and (with a team
 * secret) others. registerBusTools puts them on any server, so the enhanced agenthop carries these
 * and the classic conversation tools together.
 */

const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 290;

export type BusMcpOptions = { home?: string; relay?: string; pass?: string };

export function busInstructions(): string {
  return `Discover and message other agent sessions (Claude Code, Codex, or any other) with no pairing code:

- agenthop_peers(): list sessions reachable now, each shown by its handle (tool:dir-<shortSessionId>, e.g. codex:Work-01a0ead5). Same-machine sessions appear automatically; other machines appear when a shared AGENTHOP_TEAM is set.
- agenthop_send(to, text): message a session by its handle (a prefix like "codex:Work" works when unambiguous; the native session id also works). The handle is restart-stable, so you can reach the same session again after it restarts without being told.
- agenthop_handoff(to, summary, next?): hand a task to another session so it continues where you left off — you write the summary, the bus attaches a git snapshot of your working directory. Use it instead of send when passing work along, not just chatting.
- agenthop_recv(timeout_seconds): fallback only — see below.
- agenthop_spawn(tool, cwd?, workspace?): launch another agent (claude/codex/opencode) in a VISIBLE window on this machine; it joins the bus on its own, then hand it work with agenthop_handoff. Any session can dispatch — a decentralized, visible orchestration center.
- agenthop_wm(args): drive the OmniWM window manager (macOS) to arrange windows — a passthrough to omniwmctl (e.g. "query windows", "window move-to-workspace <id> 2").

Incoming messages arrive on their own: on agents with a native inbox (e.g. Claude Code) they surface in your session automatically as a cross-session message — you do NOT need to poll. To reply, agenthop_send back to the sender (its id is shown with the message). agenthop_recv is only for agents without native delivery.`;
}

/** Put the bus tools on an existing server. Returns a cleanup to run when the server closes. */
export function registerBusTools(server: McpServer, options: BusMcpOptions = {}): () => void {
  const core: BusCore = startBusCore(options);

  // If THIS session was launched by agenthop_spawn, self-register the Ghostty surface it runs in so
  // despawn has an authoritative (agent-claimed) target. Fire-and-forget; a no-op unless spawned.
  void claimOwnSpawn().catch(() => {});

  server.registerTool(
    "agenthop_peers",
    {
      description: "List agent sessions reachable right now (Claude Code, Codex, or any other) with no pairing code. Same-machine sessions are automatic; other machines appear with a shared AGENTHOP_TEAM.",
      inputSchema: {},
    },
    async (_args, extra) => {
      noteCodex(core, extra);
      return reply(roster(core.peers(), core.self.id, core.status()));
    },
  );

  server.registerTool(
    "agenthop_send",
    {
      description: "Send a message to another session with no pairing code. `to` is a session id (a unique id prefix or the session's title also work). The peer receives it on its next agenthop_recv.",
      inputSchema: {
        to: z.string().describe("Target session: its handle tool:dir-<shortSessionId> (a prefix like 'codex:Work' works when unambiguous), or the native session id (see agenthop_peers)"),
        text: z.string().describe("The message to send"),
      },
    },
    async ({ to, text }, extra) => {
      noteCodex(core, extra);
      if (!text.trim()) return failure("Nothing to send.");
      const result = await core.send(to, text);
      if (result.ok) return reply(`Sent to ${result.label}.`);
      return failure(`${result.error ?? "Not sent."}\n${roster(core.peers(), core.self.id, core.status())}`);
    },
  );

  server.registerTool(
    "agenthop_handoff",
    {
      description:
        "Hand a task off to another session so it can continue where you left off. You write the summary (goal, what's done, current state — the visible context the receiver needs); the bus adds a git snapshot of your working directory and delivers it as a message that surfaces in the target session. Cross-tool handoff carries only what you write plus git state, never your hidden context. `to` is a session handle/prefix or id (see agenthop_peers).",
      inputSchema: {
        to: z.string().describe("Target session: handle tool:dir-<shortId>, a prefix like 'codex:Work', or the session id"),
        summary: z.string().describe("The task: its goal, what you've done, and the current state — the visible context the receiver needs to continue"),
        next: z.string().optional().describe("Explicit next steps for the receiver (optional)"),
      },
    },
    async ({ to, summary, next }, extra) => {
      noteCodex(core, extra);
      if (!summary.trim()) return failure("Nothing to hand off (empty summary).");
      const text = formatHandoff(core.self.title, { summary, next }, core.self.cwd);
      const result = await core.send(to, text);
      if (result.ok) return reply(`Handed off to ${result.label}.`);
      return failure(`${result.error ?? "Not sent."}\n${roster(core.peers(), core.self.id, core.status())}`);
    },
  );

  server.registerTool(
    "agenthop_recv",
    {
      description: "Wait for and return messages other sessions have sent you. Returns as soon as anything arrives, or when the timeout elapses.",
      inputSchema: {
        timeout_seconds: z.number().int().min(1).max(MAX_WAIT_S).optional().describe(`Seconds to wait, ${DEFAULT_WAIT_S} by default`),
      },
    },
    async ({ timeout_seconds }, extra) => {
      noteCodex(core, extra);
      const secs = timeout_seconds ?? DEFAULT_WAIT_S;
      const batch = await core.recv(secs * 1000);
      if (batch.length === 0) return reply(`No messages in ${secs}s; call agenthop_recv again to keep waiting.`);
      return reply(batch.map((m) => `[from ${m.fromLabel}${m.via === "relay" ? "" : ""}] ${m.text}`).join("\n\n"));
    },
  );

  server.registerTool(
    "agenthop_spawn",
    {
      description:
        "Launch another agent CLI (claude | codex | opencode) in a VISIBLE terminal window on this machine, and best-effort arrange it via the window manager. The new session joins the bus on its own — give it work with agenthop_handoff once it shows up in agenthop_peers. Sub-agents start in no-confirmation mode so they run unattended. macOS + Ghostty.",
      inputSchema: {
        tool: z.string().describe("Which agent to launch: claude | codex | opencode"),
        cwd: z.string().optional().describe("Working directory for the new session (default: this session's cwd)"),
        workspace: z.string().optional().describe("WM workspace to move it to (default: current; or set AGENTHOP_SPAWN_WORKSPACE)"),
      },
    },
    async ({ tool, cwd, workspace }, extra) => {
      noteCodex(core, extra);
      const result = await spawnAgent({ tool, cwd, workspace });
      const note = result.windowId ? `${result.note} (window ${result.windowId} — close later with agenthop_despawn)` : result.note;
      return result.ok ? reply(note) : failure(note);
    },
  );

  server.registerTool(
    "agenthop_wm",
    {
      description:
        'Drive the OmniWM window manager (macOS) to arrange windows — pass an omniwmctl command line, e.g. "query windows", "command focus left", "window move-to-workspace <id> 2", "workspace focus-name agents". One-shot only (no subscribe/watch). Note: includes window-closing ops and acts on your live desktop.',
      inputSchema: {
        args: z.string().describe('omniwmctl arguments, e.g. "query windows" or "window move-to-workspace <id> 2"'),
      },
    },
    async ({ args }, extra) => {
      noteCodex(core, extra);
      const result = await omniwmctl(splitArgs(args));
      return result.ok ? reply(result.output) : failure(result.output);
    },
  );

  server.registerTool(
    "agenthop_spawned",
    {
      description: "List the sub-agent windows THIS machine's agenthop dispatched (window id, tool, cwd) — the only ones agenthop_despawn may close.",
      inputSchema: {},
    },
    async (_args, extra) => {
      noteCodex(core, extra);
      const rows = readRegistry().map((r) => `  ${r.windowId ?? "(pending)"}  ${r.launchId}  ${r.tool}  ${r.cwd}`);
      return reply(rows.length ? `spawned windows:\n${rows.join("\n")}` : "No agents spawned by agenthop on this machine.");
    },
  );

  server.registerTool(
    "agenthop_despawn",
    {
      description:
        "Close a sub-agent that agenthop spawned, by its window id or launch id (from agenthop_spawn / agenthop_spawned). It closes only the exact terminal surface it recorded (by that surface's stable UUID), never a whole window by its reusable window id; an id it never recorded is refused. Prefer the launch id if a window id is ambiguous.",
      inputSchema: { window_id: z.string().describe("The window id or launch id from agenthop_spawn / agenthop_spawned") },
    },
    async ({ window_id }, extra) => {
      noteCodex(core, extra);
      // despawn closes only the recorded surface UUID (never a window by its reusable id); an
      // unrecorded id is refused. See spawn.ts for the capture-provenance residual (Phase-1 limitation).
      const result = await despawnAgent(window_id);
      return result.ok ? reply(result.note) : failure(result.note);
    },
  );

  return () => void core.close();
}

/** Standalone bus MCP server (bus tools only). The enhanced agenthop composes registerBusTools instead. */
export async function startBusMcp(options: BusMcpOptions = {}, transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = new McpServer({ name: "agenthop", version }, { instructions: busInstructions() });
  const cleanup = registerBusTools(server, options);
  server.server.onclose = cleanup;
  await server.connect(transport);
  return server;
}

/** Codex tags every MCP call with x-codex-turn-metadata; capture the caller's own thread id so we
 *  can push inbound messages into it with `codex queue`. No-op for agents that don't send it. */
function noteCodex(core: BusCore, extra: unknown): void {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const tm = meta?.["x-codex-turn-metadata"] as { thread_id?: string; session_id?: string } | undefined;
  const tid = tm?.thread_id ?? tm?.session_id;
  if (typeof tid === "string") core.noteThread(tid);
}

function roster(peers: UnifiedPeer[], selfId: string, status: string): string {
  const rows = peers.map((p) => {
    const mine = p.id === selfId ? " (you)" : "";
    const where = p.via === "relay" ? `@${p.machine ?? "remote"}` : "";
    // Lead with the readable, restart-stable handle (title = tool:dir-<shortSessionId>) — that is what
    // you address. cwd for context; the per-run id/pid in parens are only to pick a live session now.
    const run = `${p.id.slice(0, 8)}${p.pid ? ` pid ${p.pid}` : ""}`;
    return `  ${p.title}${where}${mine}  ${p.cwd}  (run ${run})`;
  });
  return `${status}\n${rows.length ? rows.join("\n") : "  (no sessions)"}`;
}

function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
