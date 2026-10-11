/**
 * executor-digest (mirror-15 ② borrow) — a STRUCTURED view of an executor's recent state, parsed from its Claude Code transcript
 * `~/.claude/projects/<proj>/<sid>.jsonl`, to enrich a blocked / round-doctor alert beyond a raw herdr screen-read.
 *
 * parseExecutorDigest is PURE over the last-N-lines TAIL of the transcript; the IO shell (loadExecutorDigest) locates the file and
 * bounded-tail-reads it. FC-7 conservative: an unrecognised line or shape is SKIPPED (fail-soft), never an error — a transcript
 * format change degrades the digest fields to their defaults, it does not break the sentinel. A session with NO such file (e.g. a
 * Codex member, which has no Claude transcript) ⇒ null ⇒ the caller renders an HONEST "no transcript" annotation. Advisory only:
 * the raw screen-read is left untouched for content-filter detection; the digest never changes disposition (R16).
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { flagDefaultOn } from "./flag-default.js";

export interface ToolCallBrief { tool: string; summary: string; }
export interface ExecutorDigest {
  lastActivityTs: number | null;       // epoch ms of the latest line timestamp, or null when none parsed
  lastThreeToolCalls: ToolCallBrief[]; // up to 3, chronological (oldest → newest)
  lastUtterance: string;               // the last assistant natural-language text, clipped; "" when none
}

/** SWARM_EXECUTOR_DIGEST — live by default (opt-out; kill with =0). A pure advisory enrichment, so it follows the flag-default rule. */
export function executorDigestEnabled(env: string | undefined): boolean { return flagDefaultOn(env); }

function clip(s: string, n: number): string { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; }

/** A one-line brief of a tool call from its input: prefer a human description, else a representative string arg, clipped. Pure. */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["description", "command", "file_path", "pattern", "query", "prompt", "path"]) {
    const v = o[k];
    if (typeof v === "string" && v) return clip(v, 80);
  }
  for (const v of Object.values(o)) if (typeof v === "string" && v) return clip(v, 80);
  return "";
}

/**
 * Parse the digest from a transcript TAIL (the last lines of the JSONL, oldest→newest). Bad/partial lines are skipped (the first
 * line of a byte-bounded tail is usually partial); an unrecognised shape contributes nothing. Only `type:"assistant"` entries with
 * an array `message.content` yield tool calls / utterances; the latest `timestamp` across ALL lines is the activity clock. Pure;
 * non-string / empty input ⇒ all defaults. */
export function parseExecutorDigest(jsonlTail: string): ExecutorDigest {
  if (typeof jsonlTail !== "string" || !jsonlTail) return { lastActivityTs: null, lastThreeToolCalls: [], lastUtterance: "" };
  let lastActivityTs: number | null = null;
  const tools: ToolCallBrief[] = [];
  let lastUtterance = "";
  for (const raw of jsonlTail.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; } // partial first line / corrupt ⇒ skip (fail-soft)
    if (!o || typeof o !== "object") continue;
    const rec = o as { type?: unknown; timestamp?: unknown; message?: unknown };
    if (typeof rec.timestamp === "string") { const ts = Date.parse(rec.timestamp); if (Number.isFinite(ts)) lastActivityTs = lastActivityTs === null ? ts : Math.max(lastActivityTs, ts); }
    const msg = rec.message as { content?: unknown } | undefined;
    if (rec.type === "assistant" && msg && Array.isArray(msg.content)) {
      for (const c of msg.content as Array<{ type?: unknown; name?: unknown; input?: unknown; text?: unknown }>) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "tool_use" && typeof c.name === "string") tools.push({ tool: c.name, summary: toolSummary(c.input) });
        else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) lastUtterance = clip(c.text, 200);
      }
    }
  }
  return { lastActivityTs, lastThreeToolCalls: tools.slice(-3), lastUtterance };
}

/** A relative "<n><unit> 前" for a past epoch-ms, or "未知" when null/invalid. Pure. */
function ago(ts: number | null, nowMs: number): string {
  if (ts === null || !Number.isFinite(ts)) return "未知";
  const sec = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.round(sec / 60)}m 前`;
  return `${Math.round(sec / 3600)}h 前`;
}

/** Render the digest as ONE alert-annotation block. `null` ⇒ the honest "no transcript" note (a Codex member / missing file).
 *  Advisory text only; never a verdict. Pure (now injected). */
export function formatExecutorDigest(digest: ExecutorDigest | null, nowMs: number): string {
  if (digest === null) return "执行器摘要:无 transcript(非 Claude 会话或文件缺失,honest 缺省)";
  const tools = digest.lastThreeToolCalls.length
    ? digest.lastThreeToolCalls.map((t) => (t.summary ? `${t.tool}(${t.summary})` : t.tool)).join(" / ")
    : "(无)";
  const utter = digest.lastUtterance ? `「${digest.lastUtterance}」` : "(无)";
  return `执行器摘要:最后活动 ${ago(digest.lastActivityTs, nowMs)};最近工具 ${tools};最后发言 ${utter}`;
}

// ---- IO shell (fail-soft; never throws) ----

const TAIL_BYTES = 65536; // read at most the last 64 KiB — a bounded tail (the first partial line is skipped by the parser)

/** The last `maxBytes` of a file as utf8. Pure-ish IO; caller wraps in try/catch. */
function readTail(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

/** Locate `<projectsRoot>/<proj>/<sid>.jsonl` for a session id (one readdir of the projects root; file name is `<sid>.jsonl`).
 *  `sid` must be a plain id (no path separators) — guards against traversal. First match or null. Fail-soft. */
export function findTranscript(sid: string, projectsRoot: string): string | null {
  if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid)) return null;
  let projs: string[];
  try { projs = readdirSync(projectsRoot); } catch { return null; }
  const name = `${sid}.jsonl`;
  for (const proj of projs) {
    const candidate = path.join(projectsRoot, proj, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Load + parse a session's executor digest, or null when there is no transcript (Codex member / not found) OR on ANY IO error
 *  (fail-soft — the sentinel must never break). `projectsRoot` defaults to `~/.claude/projects`. */
export function loadExecutorDigest(sid: string, projectsRoot: string = path.join(homedir(), ".claude", "projects")): ExecutorDigest | null {
  try {
    const file = findTranscript(sid, projectsRoot);
    if (!file) return null;
    return parseExecutorDigest(readTail(file, TAIL_BYTES));
  } catch { return null; }
}
