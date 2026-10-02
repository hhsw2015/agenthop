import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The message journal: a METADATA-ONLY, OPT-IN append log of who talked to whom, so an observer can show
 * a swarm's traffic without ever holding its contents.
 *
 * Why this exists at all: the bus deliberately keeps no message history (the broker drops a routed dm, the
 * relay mailbox is read-and-discard), so nothing anywhere could answer "who has this session talked to".
 * This is the smallest thing that answers it: one appended line per send/receive, carrying ids, direction
 * and size. Message BODIES are not written unless the operator explicitly turns on payload logging, and
 * even then they stay local to this machine.
 *
 * Privacy stance, in order:
 *   - AGENTHOP_MSGLOG is unset  -> nothing is ever written (the default).
 *   - AGENTHOP_MSGLOG=1         -> ids + direction + size only.
 *   - AGENTHOP_MSGLOG_PAYLOAD=1 -> additionally `text`. Both flags are off by default; neither is implied.
 * The relay never sees any of this — it is a local file, written by the local bus node.
 *
 * Written as its own module (no imports from core/broker) so the call sites are three lines and this never
 * couples to the transport. Deliberately NOT a lock-free multi-version scheme like statusfile.ts: a journal
 * is append-only and every line is independent, so a torn tail is the only failure mode and the reader drops it.
 */

export type MsgLogEntry = {
  /** Event time, ms epoch. */
  ts: number;
  /** Sender: the emitting session's own id for "out", the peer's id for "in". */
  from: string;
  /** Recipient: the peer's id for "out", the emitting session's own id for "in". */
  to: string;
  via: "local" | "relay";
  direction: "in" | "out";
  /** Free-form tag (e.g. "task", "handoff"); omitted when not set. */
  kind?: string;
  /** UTF-8 byte length of the body. */
  size?: number;
  /** ONLY present when AGENTHOP_MSGLOG_PAYLOAD=1. Stays on this machine. */
  text?: string;
};

/** Metadata-only by default; payload requires an explicit second flag. */
export function msgLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.AGENTHOP_MSGLOG);
}
export function payloadLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return msgLogEnabled(env) && truthy(env.AGENTHOP_MSGLOG_PAYLOAD);
}
function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** <home>/.agenthop/msglog — `home` is the home DIR, ".agenthop" appended here (same as statusfile.ts). */
export function msgLogDir(home: string = homedir()): string {
  return path.join(home, ".agenthop", "msglog");
}

/** Local calendar date, so a day's file matches the operator's day, not UTC's. */
export function msgLogFileName(at: number = Date.now()): string {
  return `${localDate(at)}.jsonl`;
}
function localDate(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Append one line. Returns false when logging is off, the entry is unusable, or the write failed — a
 * journal must never take down the thing it observes.
 *
 * `text` is stripped unless payload logging is on, so a caller can pass the body unconditionally and
 * still not leak it.
 */
export function writeMsgLog(home: string, entry: MsgLogEntry, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!msgLogEnabled(env)) return false;
  const clean = sanitize(entry, payloadLoggingEnabled(env));
  if (!clean) return false;
  try {
    const dir = msgLogDir(home);
    mkdirSync(dir, { recursive: true });
    // One atomic-ish append. A crash mid-write can leave a partial final line; readMsgLog drops it.
    appendFileSync(path.join(dir, msgLogFileName(clean.ts)), `${JSON.stringify(clean)}\n`);
    return true;
  } catch {
    return false; // logging must never break delivery
  }
}

/** Validate and normalize. Returns undefined for a line we should not write. Pure. */
export function sanitize(entry: MsgLogEntry, withPayload: boolean): MsgLogEntry | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const { ts, from, to, via, direction } = entry;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  if (typeof from !== "string" || !from.trim()) return undefined;
  if (typeof to !== "string" || !to.trim()) return undefined;
  if (via !== "local" && via !== "relay") return undefined;
  if (direction !== "in" && direction !== "out") return undefined;
  const out: MsgLogEntry = { ts, from: from.trim(), to: to.trim(), via, direction };
  if (typeof entry.kind === "string" && entry.kind.trim()) out.kind = entry.kind.trim();
  if (typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0) out.size = entry.size;
  if (withPayload && typeof entry.text === "string") out.text = entry.text;
  return out;
}

/**
 * Read one day's journal (default: today). Malformed and torn lines are skipped, never fatal. Missing
 * file -> []. Newest event first, since every consumer of this is a "what just happened" view.
 */
export function readMsgLog(home: string, at: number = Date.now()): MsgLogEntry[] {
  const file = path.join(msgLogDir(home), msgLogFileName(at));
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return []; // no journal yet — the normal state until the call sites are wired
  }
  return parseMsgLog(raw).sort((a, b) => b.ts - a.ts);
}

/**
 * Read the last `days` daily files (today backwards), newest event first. Stepping by CALENDAR day rather
 * than by 86400000 ms keeps a DST shift from skipping or repeating a file. A session that ran across
 * midnight reads both days instead of losing the earlier half.
 */
export function readMsgLogDays(home: string, days = 2, at: number = Date.now()): MsgLogEntry[] {
  const out: MsgLogEntry[] = [];
  const base = new Date(at);
  base.setHours(12, 0, 0, 0); // midday anchor so subtracting days cannot land on the wrong date
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const file = path.join(msgLogDir(home), msgLogFileName(d.getTime()));
    try {
      out.push(...parseMsgLog(readFileSync(file, "utf8")));
    } catch {
      // absent day is fine
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Parse journal text into entries, skipping blank/torn/malformed lines. Pure. */
export function parseMsgLog(raw: string): MsgLogEntry[] {
  const out: MsgLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as MsgLogEntry;
      if (e && typeof e.ts === "number" && typeof e.from === "string" && typeof e.to === "string") out.push(e);
    } catch {
      // a torn tail while the writer appends — skip it
    }
  }
  return out;
}

/** Days that have a journal file, newest first. Useful for a UI that offers a date picker. */
export function msgLogDaysPresent(home: string): string[] {
  try {
    return readdirSync(msgLogDir(home))
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .map((n) => n.replace(/\.jsonl$/, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Size of a day's journal in bytes, or 0. Lets the exporter report logging is on without reading it. */
export function msgLogSize(home: string, at: number = Date.now()): number {
  try {
    return statSync(path.join(msgLogDir(home), msgLogFileName(at))).size;
  } catch {
    return 0;
  }
}

// Self-tests live in test/msglog.test.ts (vitest) — this module MUST have NO top-level side effects: core.ts
// imports it, and when the bus is bundled to a single file an import.meta/argv entry-guard fires on every startup,
// printing to stdout (which corrupts the MCP protocol). Keep it side-effect-free. (Codex P1.)
