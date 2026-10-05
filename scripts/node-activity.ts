import { openSync, readSync, closeSync, statSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * What a session is DOING, not just whether it is alive.
 *
 * A bus peer's row carries a self-reported status ("working") and an optional statusText, but that is a
 * summary the agent chose to publish. The host's own session transcript is the primary source: Claude Code
 * appends every turn there, so the last few tool calls are exactly "what this node is doing right now".
 *
 * Scope and stance:
 *   - LOCAL ONLY. This reads files on THIS machine. A remote peer's transcript is not here and cannot be
 *     fetched; its detail is limited to whatever its statusText carries. Say so rather than implying
 *     otherwise.
 *   - METADATA BY DEFAULT. We surface the tool name and its TARGET (a file path, a command's first line, a
 *     search pattern) — never file contents, never assistant text, never prompts. Those exist in the file;
 *     we do not read them out.
 *   - BOUNDED. Transcripts reach tens of megabytes. We read a fixed tail window, not the file.
 *
 * The join key is the bus stableId, which for Claude Code IS the transcript filename. When a peer was
 * started without one (a fresh process that has not adopted an id), there is nothing to look up and we
 * return undefined rather than guessing from a title.
 */

export type ToolActivity = {
  /** Tool name as the host logged it (Edit, Bash, Read, Grep, ...). */
  name: string;
  /** The tool's target, truncated for display: a path, a command's first line, or a pattern. */
  target: string;
  /** Epoch ms. */
  ts: number;
};

export type NodeActivity = {
  /** Most recent tool calls, newest first. */
  recent: ToolActivity[];
  /** Epoch ms of the newest transcript record of any type — i.e. when this session last did anything. */
  lastAt: number;
  /** Token usage from the newest assistant record that reported any. */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Where this came from, so a caller never presents a derived value as a reported one. */
  source: "transcript";
};

/** How much of the tail to read. Enough for many turns, small enough to be cheap on a 50 MB file. */
const TAIL_BYTES = 512 * 1024;
/** Cap on the tool calls we return. */
const MAX_RECENT = 8;
/** Target strings are for a one-line UI; do not carry a whole command. */
const MAX_TARGET = 96;

/**
 * The transcript path for a Claude Code session: ~/.claude/projects/<slug>/<stableId>.jsonl, where the slug
 * is the session's cwd with separators replaced by dashes. Both inputs are required: without the cwd we do
 * not know which project directory to look in.
 */
/**
 * The transcript path for a CODEX session. Codex dates its rollouts into nested directories and puts the
 * thread id in the FILENAME, not the path, so a lookup means walking the recent date directories.
 *   <home>/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<threadId>.jsonl
 * We only search the newest few day-directories: an id that is not there is either ancient or not a Codex
 * session, and an exhaustive walk over every historical rollout would be worse than returning nothing.
 */
export function codexRolloutPath(threadId: string, home: string = homedir(), days = 4): string | undefined {
  if (!threadId) return undefined;
  // CODEX_HOME overrides the default ~/.codex, and on a machine sharing agent data it is where the
  // rollouts actually are. Checking only ~/.codex silently finds nothing while the sessions sit elsewhere.
  const root = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  if (!existsSync(root)) return undefined;
  const d = new Date();
  for (let i = 0; i < days; i++) {
    const day = new Date(d.getTime() - i * 86400000);
    const dir = path.join(root, String(day.getFullYear()), pad2(day.getMonth() + 1), pad2(day.getDate()));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.endsWith(".jsonl") && n.includes(threadId));
    if (hit) return path.join(dir, hit);
  }
  return undefined;
}
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function transcriptPath(stableId: string, cwd: string, home: string = homedir()): string | undefined {
  if (!stableId || !cwd) return undefined;
  // Claude Code slugs the cwd by replacing every path separator and dot with a dash. Verify rather than
  // assume: a wrong slug means silently no data, which looks identical to "not doing anything".
  const slug = cwd.replace(/[/.]/g, "-");
  const p = path.join(home, ".claude", "projects", slug, `${stableId}.jsonl`);
  return existsSync(p) ? p : undefined;
}

/**
 * Read the last tool calls and the newest timestamp from a transcript. Bounded tail read; malformed or
 * torn lines are skipped. Returns undefined when the file is missing or holds nothing usable.
 */
/** Host that wrote a transcript, decided by the record shape rather than the caller's guess. */
export type HostKind = "claude" | "codex";

/**
 * Read a transcript from EITHER host. The two log different shapes:
 *   Claude — {type:"assistant", message:{content:[{type:"tool_use", name, input}], usage:{...}}}
 *   Codex  — {type:"response_item", payload:{type:"function_call"|"custom_tool_call", name, arguments|input}}
 *              plus {type:"token_usage_record", payload:{turn_token_usage|usage:{...}}}
 * We detect per line, so one reader serves both and a future host is a new branch, not a new module.
 */
export function readNodeActivity(file: string, tailBytes: number = TAIL_BYTES): NodeActivity | undefined {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return undefined;
  }
  if (size === 0) return undefined;
  const start = Math.max(0, size - tailBytes);
  let text: string;
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }

  // Drop a partial first line when we started mid-file.
  const lines = text.split("\n");
  if (start > 0) lines.shift();

  const recent: ToolActivity[] = [];
  let lastAt = 0;
  let usage: NodeActivity["usage"] | undefined;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(t) as TranscriptRecord;
    } catch {
      continue; // torn line under a concurrent append
    }
    const ts = parseTs(rec.timestamp);
    if (ts && ts > lastAt) lastAt = ts;

    // ---- Claude Code ----
    if (rec.type === "assistant") {
      const msg = rec.message;
      if (msg && Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (!item || item.type !== "tool_use" || typeof item.name !== "string") continue;
          recent.push({ name: item.name, target: describeTarget(item.name, item.input), ts: ts ?? 0 });
        }
      }
      if (msg?.usage && typeof msg.usage === "object") {
        usage = {
          inputTokens: num(msg.usage.input_tokens),
          outputTokens: num(msg.usage.output_tokens),
          cacheReadTokens: num(msg.usage.cache_read_input_tokens),
          cacheWriteTokens: num(msg.usage.cache_creation_input_tokens),
        };
      }
      continue;
    }

    // ---- Codex ----
    const payload = rec.payload;
    if (!payload) continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : payload.type;
      // Codex puts the arguments in a JSON string; parse for a path, else show the raw head.
      let input: unknown = payload.input ?? payload.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = { command: input };
        }
      }
      recent.push({ name, target: describeTarget(name, input), ts: ts ?? 0 });
      continue;
    }
    if (rec.type === "token_usage_record" || rec.type === "event_msg") {
      const u = payload.turn_token_usage ?? payload.usage;
      if (u && typeof u === "object") {
        const o = u as Record<string, unknown>;
        usage = {
          inputTokens: num(o.input_tokens ?? o.input),
          outputTokens: num(o.output_tokens ?? o.output),
          cacheReadTokens: num(o.cached_input_tokens ?? o.cache_read_input_tokens),
          cacheWriteTokens: num(o.cache_creation_input_tokens),
        };
      }
    }
  }

  if (!recent.length && !lastAt) return undefined;
  recent.reverse(); // newest first
  return { recent: recent.slice(0, MAX_RECENT), lastAt: lastAt || Date.now(), usage, source: "transcript" };
}

/** A one-line description of what a tool call acted on. Never the content, only the target. */
export function describeTarget(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pick =
    i.file_path ?? i.path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  if (typeof pick === "string" && pick.trim()) return clip(baseName(pick.trim()));
  // A shell command: show the first line only. The body can be long and can contain secrets.
  if (typeof i.command === "string" && i.command.trim()) return clip(i.command.trim().split("\n")[0]!);
  // Codex wraps shell work in a JS snippet (`tools.exec_command({cmd:"..."})`). Pull the first embedded
  // command out of it, or the "target" is an unreadable blob of script.
  if (typeof i.input === "string") {
    // Greedy to the LAST quote before the next `,` at the same nesting: the command itself routinely
    // contains quotes (`sed -n '1,22p' file`), so a lazy match to the first quote truncates it to junk.
    const m = i.input.match(/exec_command\(\s*\{[^}]*?cmd\s*:\s*["'`](.+?)["'`]\s*(?:,|\})/s);
    if (m) return clip(m[1]!.trim().split("\n")[0]!);
    const first = i.input.trim().split("\n")[0]!;
    if (first && !first.startsWith("{")) return clip(first);
  }
  if (typeof i.skill === "string") return clip(i.skill.trim());
  return "";
}

function baseName(s: string): string {
  // Keep the tail of a path (the filename) — the directory is usually the same for every call.
  const parts = s.split("/");
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : s;
}
function clip(s: string): string {
  return s.length > MAX_TARGET ? s.slice(0, MAX_TARGET - 1) + "…" : s;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
/** ISO string to epoch ms, or undefined. Tolerates a numeric timestamp too. */
export function parseTs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : v;
  if (typeof v !== "string" || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** The subset of a transcript record we read. Everything else in the record is ignored on purpose. */
type TranscriptRecord = {
  type?: string;
  timestamp?: string | number;
  /** Codex shape: the record body lives under `payload`. */
  payload?: {
    type?: string;
    name?: string;
    input?: unknown;
    arguments?: unknown;
    turn_token_usage?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  };
  message?: {
    role?: string;
    content?: Array<{ type?: string; name?: string; input?: unknown }>;
    usage?: Record<string, unknown>;
  };
};
