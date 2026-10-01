import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { startBusCore, type BusCore, type UnifiedPeer } from "./core.js";
import { formatHandoff } from "./handoff.js";
import { despawnAgent, readRegistry, spawnAgent, startClaimRetry } from "./spawn.js";
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
- agenthop_send(to, text): message a session by its handle (a prefix like "codex:Work" works when unambiguous; the native session id also works). Address by the STABLE PREFIX, not a full handle you memorized: a handle's short id comes from the session's native id, and for Codex that is its thread id, which changes on restart or a new thread — the prefix (e.g. "codex:Work") still finds it, the old full handle will not.
- agenthop_handoff(to, summary, next?): hand a task to another session so it continues where you left off — you write the summary, the bus attaches a git snapshot of your working directory. Use it instead of send when passing work along, not just chatting.
- agenthop_report_status(state): report THIS session's work state (working/idle/blocked/unknown) to peers; shows in agenthop_peers.
- agenthop_wait_peer(to, until?): wait until another session reaches a state — e.g. a sub-agent you dispatched goes idle (done) or blocked (needs input).
- agenthop_recv(timeout_seconds): fallback only — see below.
- agenthop_spawn(tool, cwd?, workspace?, visible?, task?): launch another agent (claude/codex/opencode) on this machine. YOU pick the mode per task: visible (default) = a VISIBLE window the user can watch — it joins the bus on its own, then hand it work with agenthop_handoff; visible:false = HEADLESS, no window — a detached one-shot run of the tool's non-interactive mode with the task argument as the prompt, output to a per-launch log file (the result channel), stoppable with agenthop_despawn. Rule of thumb: important or long-running work the user may want to watch → visible; minor/bulk/fire-and-forget checks, or a desktop already full of windows → headless. Any session can dispatch — a decentralized orchestration center.
- agenthop_wm(args): drive the OmniWM window manager (macOS) to arrange windows — a passthrough to omniwmctl (e.g. "query windows", "window move-to-workspace <id> 2").

Choosing a channel: agenthop reaches EVERY tool on the bus (Claude Code, Codex, OpenCode). If your host also has its OWN cross-session messaging (e.g. Claude Code's built-in), that only sees other sessions of the SAME tool — it cannot reach Codex or OpenCode. So use the host's native messaging for same-tool peers if you like, but use agenthop for ANY cross-tool peer: it is the only channel that bridges them, and agenthop_peers is where a different-tool session shows up at all.

Incoming messages arrive on their own: on agents with a native inbox (e.g. Claude Code) they surface in your session automatically as a cross-session message — you do NOT need to poll. To reply, agenthop_send back to the sender (its id is shown with the message). agenthop_recv is only for agents without native delivery.`;
}

/** Put the bus tools on an existing server. Returns a cleanup to run when the server closes. */
export function registerBusTools(server: McpServer, options: BusMcpOptions = {}): () => void {
  const core: BusCore = startBusCore(options);

  // If THIS session was launched by agenthop_spawn, self-register the Ghostty surface it runs in so
  // despawn has an authoritative (agent-claimed) target. Bounded retry; a no-op unless spawned.
  startClaimRetry();

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
    "agenthop_report_status",
    {
      description:
        "Report THIS session's work state to peers (working | idle | blocked | unknown). It shows in agenthop_peers and lets a dispatcher agenthop_wait_peer on it. `blocked` means you need input (a permission/approval/question). Usually driven by hooks, but an agent may set it directly.",
      inputSchema: {
        state: z.enum(["working", "idle", "blocked", "unknown"]).describe("This session's work state"),
        note: z.string().optional().describe("Optional short detail, e.g. what you're blocked on"),
        seq: z.number().int().optional().describe("Optional monotonic sequence (e.g. a timestamp); a report not newer than the last is ignored"),
      },
    },
    async ({ state, note, seq }, extra) => {
      noteCodex(core, extra);
      const r = core.setStatus(state, { text: note, seq });
      return reply(r.ok ? `Status set to ${state} (seq ${r.seq}).` : `Ignored: a newer status (seq ${r.seq}) is already set.`);
    },
  );

  server.registerTool(
    "agenthop_wait_peer",
    {
      description:
        "Wait until another session reaches a work state — e.g. wait for a sub-agent you dispatched to go idle (done) or blocked (needs input). Returns as soon as it reaches one of the states, or when it vanishes or the timeout elapses. Pins the target's exact run so a different/restarted session can't satisfy the wait.",
      inputSchema: {
        to: z.string().describe("Target session: handle/prefix or id (see agenthop_peers)"),
        until: z.array(z.enum(["working", "idle", "blocked", "unknown"])).optional().describe("States to wait for (default: idle, blocked)"),
        timeout_seconds: z.number().int().min(1).max(MAX_WAIT_S).optional().describe(`Seconds to wait, ${DEFAULT_WAIT_S} by default`),
      },
    },
    async ({ to, until, timeout_seconds }, extra) => {
      noteCodex(core, extra);
      const states = until && until.length ? until : (["idle", "blocked"] as const);
      const secs = timeout_seconds ?? DEFAULT_WAIT_S;
      const r = await core.waitForStatus(to, [...states], secs * 1000);
      if (r.error) return failure(`${r.error}\n${roster(core.peers(), core.self.id, core.status())}`);
      if (r.gone) return reply(`${r.label ?? to} is gone (left the bus) before reaching ${states.join("/")}.`);
      if (r.reached) return reply(`${r.label ?? to} is now ${r.status}.`);
      return reply(`Timed out after ${secs}s; ${r.label ?? to} is ${r.status ?? "unknown"}. Call agenthop_wait_peer again to keep waiting.`);
    },
  );

  server.registerTool(
    "agenthop_spawn",
    {
      description:
        "Launch another agent CLI (claude | codex | opencode) on this machine. YOU choose the mode per task: visible (default) opens a VISIBLE terminal window the user can watch (macOS + Ghostty), the session joins the bus — give it work with agenthop_handoff; visible:false runs it HEADLESS (no window, any platform) in the tool's native non-interactive mode with `task` as its prompt, output streaming to a per-launch log file. Prefer visible for important/watchable work, headless for minor/bulk runs or a full desktop. Sub-agents start in no-confirmation mode so they run unattended.",
      inputSchema: {
        tool: z.string().describe("Which agent to launch: claude | codex | opencode"),
        cwd: z.string().optional().describe("Working directory for the new session (default: this session's cwd)"),
        workspace: z.string().optional().describe("Visible only: WM workspace to move it to (default: current; or set AGENTHOP_SPAWN_WORKSPACE)"),
        visible: z.boolean().optional().describe("true (default) = visible terminal window; false = headless detached background run (requires task)"),
        task: z.string().optional().describe("The task. Headless: REQUIRED, becomes the one-shot prompt. Visible: not auto-delivered — send it with agenthop_handoff once the session appears in agenthop_peers"),
      },
    },
    async ({ tool, cwd, workspace, visible, task }, extra) => {
      noteCodex(core, extra);
      const result = await spawnAgent({ tool, cwd, workspace, visible, task });
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
      description: "List the sub-agents THIS machine's agenthop dispatched — visible windows (window id, tool, cwd) and headless runs (pid, exit state, output log). The only ones agenthop_despawn may close.",
      inputSchema: {},
    },
    async (_args, extra) => {
      noteCodex(core, extra);
      const rows = readRegistry().map((r) => {
        if (r.mode === "headless") {
          const state = r.exitedAt !== undefined ? `exited(${r.exitCode ?? "?"})` : `running pid ${r.pid ?? "?"}`;
          return `  [headless ${state}]  ${r.launchId}  ${r.tool}  ${r.cwd}${r.outputFile ? `  log: ${r.outputFile}` : ""}`;
        }
        return `  ${r.windowId ?? "(pending)"}  ${r.launchId}  ${r.tool}  ${r.cwd}`;
      });
      return reply(rows.length ? `spawned agents:\n${rows.join("\n")}` : "No agents spawned by agenthop on this machine.");
    },
  );

  server.registerTool(
    "agenthop_despawn",
    {
      description:
        "Close a sub-agent that agenthop spawned, by its window id or launch id (from agenthop_spawn / agenthop_spawned). Visible: closes only the exact terminal surface it recorded (by that surface's stable UUID), never a whole window by its reusable window id. Headless: terminates exactly the recorded pid after verifying it is still the launched process, never by name. An id it never recorded is refused. Prefer the launch id if a window id is ambiguous.",
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
    // you address. A [state] badge shows the self-reported work state. cwd for context; the per-run
    // id/pid in parens are only to pick a live session now.
    const state = p.status ? `[${p.status}${p.statusText ? `: ${p.statusText}` : ""}]` : "[unknown]";
    const run = `${p.id.slice(0, 8)}${p.pid ? ` pid ${p.pid}` : ""}`;
    return `  ${p.title}${where}${mine}  ${state}  ${p.cwd}  (run ${run})`;
  });
  return `${status}\n${rows.length ? rows.join("\n") : "  (no sessions)"}`;
}

function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
