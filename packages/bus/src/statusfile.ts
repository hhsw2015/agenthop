import { watch, type FSWatcher } from "node:fs";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The bridge between EXTERNAL hooks and a live bus node's work-status. A hook (which runs as its own
 * process and cannot call into the bus node) writes a session's state to ~/.agenthop/status/<key>.json
 * via `agenthop report-status`; the bus node for that same session watches the file and calls setStatus.
 * Keyed by the session's native id so the hook (which knows it from its env) and the bus node (whose
 * stableId is that id) agree without any shared socket. Slice B of peer-status.
 */

export type StatusFile = { state: string; seq: number; text?: string };
const STATES = new Set(["working", "idle", "blocked", "unknown"]);

function statusDir(home: string): string {
  return path.join(home, ".agenthop", "status");
}
function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function statusFile(home: string, key: string): string {
  return path.join(statusDir(home), `${safeKey(key)}.json`);
}

/** Read a session's current status file, or undefined if absent/malformed. Pure. */
export function readStatusFile(home: string, key: string): StatusFile | undefined {
  try {
    const r = JSON.parse(readFileSync(statusFile(home, key), "utf8")) as Record<string, unknown>;
    if (r && typeof r === "object" && typeof r.state === "string" && STATES.has(r.state) && typeof r.seq === "number" && Number.isFinite(r.seq)) {
      return { state: r.state, seq: r.seq, text: typeof r.text === "string" ? r.text : undefined };
    }
  } catch {
    // absent / partial / invalid
  }
  return undefined;
}

/**
 * Write a session's status atomically (temp + rename). The seq is a monotonic timestamp: at least the
 * previous seq + 1, so two writes in the same millisecond still advance and the reader's monotonic guard
 * never wrongly drops a newer report. Returns whether it was written.
 */
export function writeStatusFile(home: string, key: string, state: string, opts?: { seq?: number; text?: string }): boolean {
  if (!STATES.has(state)) return false;
  const p = statusFile(home, key);
  const tmp = `${p}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    const seq = opts?.seq ?? Math.max(Date.now(), (readStatusFile(home, key)?.seq ?? 0) + 1);
    const rec: StatusFile = { state, seq, ...(opts?.text?.trim() ? { text: opts.text.trim() } : {}) };
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmp, p);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // leftover temp is harmless
    }
    return false;
  }
}

/**
 * Watch the status directory and call `onChange` whenever any status file changes (writes are atomic
 * renames, so watching the DIR is more reliable than watching one file). The caller re-reads the file
 * for its current key inside `onChange`. Returns a close fn; a no-op if the dir can't be watched.
 */
export function watchStatusDir(home: string, onChange: () => void): () => void {
  const dir = statusDir(home);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return () => {};
  }
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, () => onChange());
  } catch {
    // fall back to the poll below
  }
  // Poll fallback: fs.watch can miss events under load or on some filesystems. A low-frequency re-read
  // guarantees pickup within ~1s; a re-read that hasn't changed is dropped by the monotonic seq guard,
  // so this never re-broadcasts. unref so it never keeps the process alive.
  const timer = setInterval(() => onChange(), 1000);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    try {
      watcher?.close();
    } catch {
      // already closed
    }
    clearInterval(timer);
  };
}

export function statusHome(): string {
  return process.env.HOME || homedir();
}
