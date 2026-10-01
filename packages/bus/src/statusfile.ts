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
 * Write a session's status atomically (temp + rename). Correctness rests on the SEQ being the EVENT time
 * (captured in the hook shell and passed as --seq — see installClaudeStatusHooks; a manual or degraded
 * run falls back to report-status's own start time), NOT the write time: a delayed or
 * reordered write then carries an OLDER seq, so (a) writeStatusFile refuses to regress a disk entry that
 * already has a >= seq, and (b) the reader's per-identity monotonic guard drops it even if a concurrent
 * write momentarily lands it on disk. So no lock is needed: a "losing" concurrent write is by definition
 * an older event, harmless to a live reader, and corrected by the next event. (Residual, same self-healing
 * class as the broker/bridge locks: a fresh reader starting in the exact sub-millisecond of a concurrent
 * write could read the older entry; two DISTINCT events in the same millisecond can't be ordered by a
 * ms clock and the later may be dropped — turn-boundary events are seconds apart in practice.)
 * Returns whether the intended state is now, or already was, the recorded one.
 */
export function writeStatusFile(home: string, key: string, state: string, opts?: { seq?: number; text?: string }): boolean {
  if (!STATES.has(state)) return false;
  const p = statusFile(home, key);
  const seq = opts?.seq ?? Date.now(); // event time; do NOT bump above the previous — ordering is by event
  const tmp = `${p}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    const prev = readStatusFile(home, key);
    if (prev && prev.seq >= seq) return true; // a newer (or equal) event is already recorded — don't regress
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
    // A watcher 'error' (e.g. EIO) would be an uncaught exception that kills the process; swallow it and
    // let the poll fallback below keep working.
    watcher.on("error", () => {});
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
