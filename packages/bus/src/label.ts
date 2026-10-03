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
  /**
   * The host's PERMISSION MODE in Claude Code's vocabulary (default | acceptEdits | plan | bypassPermissions). Codex
   * reports the same strings on its hook stdin (it adopted CC's hook schema), so no mapping is needed. Learned by the
   * presence hook from the SessionStart stdin `permission_mode` and injected as AGENTHOP_MODE. Rides the roster so a
   * delivery to a Claude host can stamp the SENDER's real mode on the cross-session frame (from-mode) instead of a
   * hardcoded "default" — otherwise a bypass receiver gates every peer message for approval regardless of the sender's
   * actual trust level. Undefined => unknown => treated as "default" (the safe, gated side).
   */
  mode?: string;
  cwd: string;
  pid: number;
  /** Human label for the roster, e.g. "codex:agenthop". */
  title: string;
  startedAt: number;
  /**
   * Self-reported work state, for orchestration (an idea borrowed from herdr). A session sets its own
   * status (via agenthop_status / hooks); it rides the roster like the rest of SelfInfo. `statusSeq` is
   * a per-session monotonic counter so an out-of-order or duplicate report is dropped (never applied on
   * top of a newer one). All optional: absent means "unknown".
   */
  status?: AgentStatus;
  statusSeq?: number;
  statusText?: string;
  statusAt?: number;
};

/** Working = actively doing a turn; idle = waiting for its next instruction; blocked = needs input
 *  (a permission/approval/question prompt); unknown = not reported. */
export type AgentStatus = "working" | "idle" | "blocked" | "unknown";

export const AGENT_STATUSES: readonly AgentStatus[] = ["working", "idle", "blocked", "unknown"];

/** The host's native session id if it publishes one in the env at startup. Extensible per tool. Claude Code exposes
 *  CLAUDE_CODE_SESSION_ID in the env; Codex has none, so its SessionStart presence hook parses the id from the hook's
 *  stdin JSON and passes it as AGENTHOP_SESSION — the one durable identity a Codex presence daemon has at startup
 *  (before it has made any MCP call), which equals its thread id, so delivery via `codex queue --thread` works. */
export function nativeSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_CODE_SESSION_ID?.trim() || env.AGENTHOP_SESSION?.trim() || undefined;
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
 * The readable handle for a session: `tool:dir-<shortId>`, e.g. `codex:Work-01a0ead5`. The dir makes it
 * legible; the short id makes it unique across concurrent same-dir sessions. `idForSuffix` should be the
 * most durable id available — the native session id when known (then the handle is the SAME across a
 * restart/resume), else the per-run id as a fallback so the handle is STILL uniquely suffixed. This matters
 * for resolution: a bare `tool:dir` (no suffix) would exact-match — and silently shadow — a suffixed sibling
 * in resolvePeer's title tier, so callers must always pass an id (stableId ?? runId), never nothing. Falls
 * back to bare `tool:dir` only if no id at all is given, and to AGENTHOP_TITLE when set.
 */
export function sessionTitle(tool: string, cwd: string, idForSuffix?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENTHOP_TITLE?.trim();
  if (explicit) return explicit;
  const base = `${tool}:${basename(cwd) || cwd}`;
  return idForSuffix ? `${base}-${shortId(idForSuffix)}` : base;
}

export function selfInfo(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): SelfInfo {
  const tool = detectTool(env);
  // stableId is the host's native session id when it is in the env (Claude Code); otherwise it is filled in
  // later once known (Codex learns its thread id on connect). id stays a fresh per-run token.
  const stableId = nativeSessionId(env);
  const id = randomUUID();
  // Suffix the handle with the native session id when known (restart-stable), else the per-run id — NEVER a
  // bare `tool:dir`, which would exact-match and silently shadow a suffixed same-dir sibling in resolution.
  const title = sessionTitle(tool, cwd, stableId ?? id, env);
  // The host permission mode the presence hook learned from SessionStart stdin (see SelfInfo.mode). Undefined = unknown.
  const mode = env.AGENTHOP_MODE?.trim() || undefined;
  return { id, stableId, tool, mode, cwd, pid: process.pid, title, startedAt: Date.now() };
}
