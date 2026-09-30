import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { codexDaemonPresent } from "./codex.js";

/**
 * Who this session is, as the bus advertises it. Nothing here is load-bearing for delivery — the
 * session id is what messages are addressed to; `tool`/`title` are for a person reading the roster.
 * The tool is sniffed best-effort and falls back to "unknown"; a wrong guess never breaks routing.
 */

export type SelfInfo = {
  /** Per-run routing token (regenerated each process start). What the broker routes on. */
  id: string;
  /**
   * The host's OWN native session id — the durable address. Unlike `id`, it is the SAME across a
   * restart/resume of the same conversation and DIFFERENT between concurrent sessions, so peers can
   * find each other by it without a pairing code and without being told about a restart. Claude Code
   * exposes it in the env at startup (CLAUDE_CODE_SESSION_ID); Codex has no env for it, so its bus
   * learns the thread id on connect and fills this in then (see core.ts). Undefined until known.
   */
  stableId?: string;
  /** claude | codex | gemini | cursor | grok | unknown. Cosmetic. */
  tool: string;
  cwd: string;
  pid: number;
  /** Human label for the roster, e.g. "codex:agenthop". */
  title: string;
  startedAt: number;
  /**
   * If this session was launched by agenthop_spawn, the AGENTHOP_LAUNCH_ID that was injected into its
   * env. It is the ONLY durable proof of "which spawned window this live session is": a Ghostty window
   * id is an object address that gets reused after the window closes, so despawn confirms ownership by
   * checking a live peer still carries this launchId before closing the stored id. Undefined for
   * sessions a person opened themselves.
   */
  launchId?: string;
};

/** The host's native session id if it publishes one in the env at startup. Extensible per tool. */
export function nativeSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_CODE_SESSION_ID?.trim() || undefined;
}

/** Best-effort: an explicit override wins, otherwise a few known env markers, otherwise unknown. */
export function detectTool(env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.AGENTHOP_TOOL?.trim().toLowerCase();
  if (forced) return forced;
  // Explicit host markers first — they identify the ACTUAL host. Several of these tools can run on a
  // machine that also has a Codex daemon, so every one of them must win over mere daemon presence;
  // otherwise a Cursor/Gemini/Grok session would be mislabeled codex and could have its inbound
  // pushed into a Codex thread (see core.ts's self.tool === "codex" delivery guard).
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_MESSAGING_SOCKET) return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_MCP) return "codex";
  if (env.CURSOR_TRACE_ID || env.CURSOR) return "cursor";
  if (env.GEMINI_CLI || env.GEMINI_API_KEY) return "gemini";
  if (env.GROK_CLI || env.GROK) return "grok";
  // Only now, with no explicit marker, fall back to daemon presence: Codex spawns its MCP with a
  // clean env (no CODEX_* markers), so a reachable daemon socket is the last tell that this is Codex.
  // This decides only between "codex" and "unknown", never overriding another tool's own marker.
  if (codexDaemonPresent()) return "codex";
  return "unknown";
}

/** First 8 alphanumerics of a session id — readable and near-unique, for the roster handle. */
export function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

/**
 * The readable, restart-stable handle for a session: `tool:dir-<shortSessionId>`, e.g.
 * `codex:Work-01a0ead5`. The dir makes it legible; the short native session id makes it unique across
 * concurrent same-dir sessions and the SAME across a restart/resume. Falls back to `tool:dir` until a
 * stableId is known, and to AGENTHOP_TITLE when set. Kept in sync when a session learns its stableId.
 */
export function sessionTitle(tool: string, cwd: string, stableId?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENTHOP_TITLE?.trim();
  if (explicit) return explicit;
  const base = `${tool}:${basename(cwd) || cwd}`;
  return stableId ? `${base}-${shortId(stableId)}` : base;
}

export function selfInfo(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): SelfInfo {
  const tool = detectTool(env);
  // stableId is the host's native session id when it is in the env (Claude Code); otherwise it is
  // filled in later once known (Codex learns its thread id on connect). id stays a fresh per-run token.
  const stableId = nativeSessionId(env);
  const title = sessionTitle(tool, cwd, stableId, env);
  const launchId = env.AGENTHOP_LAUNCH_ID?.trim() || undefined;
  return { id: randomUUID(), stableId, tool, cwd, pid: process.pid, title, startedAt: Date.now(), launchId };
}
