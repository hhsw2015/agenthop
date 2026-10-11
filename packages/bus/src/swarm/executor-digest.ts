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
import { constants as fsConstants } from "node:fs";
import { open as fsOpen, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
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

/** The last-activity time as a STABLE absolute ISO instant, or "未知" when null/invalid. ED-2: a stable fact (not a relative
 *  "Ns 前" that changes every call), so an unchanged digest renders identical text — the coordinator's `taskRef+text` dedup is not
 *  bypassed by the display clock. Pure. */
function whenIso(ts: number | null): string {
  return ts !== null && Number.isFinite(ts) ? new Date(ts).toISOString() : "未知";
}

/** Render the digest as ONE alert-annotation block. `null` ⇒ an HONEST "transcript unavailable" note — it does NOT claim the file
 *  is MISSING, because a read FAILURE (ED-4) also maps to null; the merged wording covers "missing OR unreadable". Advisory text
 *  only; never a verdict. Pure + STABLE (no wall-clock), so identical state ⇒ identical text (ED-2). */
export function formatExecutorDigest(digest: ExecutorDigest | null): string {
  if (digest === null) return "执行器摘要:transcript 不可用(缺失或读取失败,honest 缺省)";
  const tools = digest.lastThreeToolCalls.length
    ? digest.lastThreeToolCalls.map((t) => (t.summary ? `${t.tool}(${t.summary})` : t.tool)).join(" / ")
    : "(无)";
  const utter = digest.lastUtterance ? `「${digest.lastUtterance}」` : "(无)";
  return `执行器摘要:最后活动 ${whenIso(digest.lastActivityTs)};最近工具 ${tools};最后发言 ${utter}`;
}

// ---- IO shell (ASYNC + fail-soft; never throws, never blocks the event loop) ----

const TAIL_BYTES = 65536; // read at most the last 64 KiB — a bounded tail (the first partial line is skipped by the parser)

/** The last `maxBytes` of a file as utf8. ED-3: opens with O_NONBLOCK so a FIFO/device never blocks the open, and reads ONLY after
 *  confirming a REGULAR file (fstat isFile) — a non-regular entry returns "" instead of a blocking read. Bounded + async. */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const fh = await fsOpen(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); // O_NONBLOCK: opening a FIFO returns at once, never waits
  try {
    const st = await fh.stat();
    if (!st.isFile()) return ""; // FIFO / device / dir / socket ⇒ not a transcript; never do a blocking read on it
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString("utf8");
  } finally { await fh.close(); }
}

/** Locate `<projectsRoot>/<proj>/<sid>.jsonl` for a session id (one readdir of the projects root; file name is `<sid>.jsonl`).
 *  `sid` must be a plain id (no path separators) — guards against traversal. Only a REGULAR file matches (a dir/FIFO named like the
 *  transcript is skipped). First match or null. Async + fail-soft. Note: the CALLER resolves a bus handle → native sid first
 *  (ED-1); this takes a resolved native session id. */
export async function findTranscript(sid: string, projectsRoot: string): Promise<string | null> {
  if (!sid || !/^[A-Za-z0-9._-]+$/.test(sid)) return null;
  let projs: string[];
  try { projs = await fsReaddir(projectsRoot); } catch { return null; }
  const name = `${sid}.jsonl`;
  for (const proj of projs) {
    const candidate = path.join(projectsRoot, proj, name);
    try { if ((await fsStat(candidate)).isFile()) return candidate; } catch { /* missing/unreadable ⇒ try next */ }
  }
  return null;
}

/** Load + parse a session's executor digest, or null when there is no transcript (Codex member / not found) OR on ANY IO error
 *  (fail-soft — the sentinel must never break). Async so the bounded IO never stalls the dispatcher event loop (ED-3). `sid` is a
 *  resolved NATIVE session id (the caller maps a bus handle via resolveSession first, ED-1). `projectsRoot` defaults to
 *  `~/.claude/projects`. */
export async function loadExecutorDigest(sid: string, projectsRoot: string = path.join(homedir(), ".claude", "projects")): Promise<ExecutorDigest | null> {
  try {
    const file = await findTranscript(sid, projectsRoot);
    if (!file) return null;
    return parseExecutorDigest(await readTail(file, TAIL_BYTES));
  } catch { return null; }
}
