import { watch, type FSWatcher } from "node:fs";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
/** The fixed prefix every versioned status file for a key shares: "<safeKey>.json". */
function baseName(key: string): string {
  return `${safeKey(key)}.json`;
}

/**
 * This key's on-disk versions as {seq, name}, newest first. Each status write lands in its OWN file named
 * `<safeKey>.json.<seq>` (see writeStatusFile), so the current status is the highest-seq version. Pure; []
 * on any error. Entries whose suffix is not all-digits (e.g. a `.tmp.<rand>` staging file) are skipped.
 */
function versions(home: string, key: string): Array<{ seq: number; name: string }> {
  const prefix = `${baseName(key)}.`;
  let names: string[];
  try {
    names = readdirSync(statusDir(home));
  } catch {
    return [];
  }
  const out: Array<{ seq: number; name: string }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const rem = name.slice(prefix.length);
    if (!/^\d+$/.test(rem)) continue; // skip staging temps and anything non-numeric
    const seq = Number(rem);
    if (Number.isSafeInteger(seq)) out.push({ seq, name });
  }
  out.sort((a, b) => b.seq - a.seq);
  return out;
}

/** Read a session's current status (the highest-seq version), or undefined if absent/malformed. Pure. */
export function readStatusFile(home: string, key: string): StatusFile | undefined {
  const dir = statusDir(home);
  // Re-list on a VANISHED file: versions() is a one-shot directory snapshot, and a concurrent writer renames
  // the new max into place BEFORE pruning the old (see writeStatusFile), so if the version we picked was GC'd
  // out from under this read, re-listing is guaranteed to find the newer one. Bounded against a pathological
  // write storm. A parse error (a corrupt/partial version) instead falls through to the next-newest in the
  // CURRENT listing — without it, a torn newest file could mask a good older one.
  for (let attempt = 0; attempt < 5; attempt++) {
    let vanished = false;
    for (const { name } of versions(home, key)) {
      let raw: string;
      try {
        raw = readFileSync(path.join(dir, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          vanished = true; // GC'd under us — a newer version exists; re-list to find it
          break;
        }
        continue; // some other read error on this version — try the next-newest
      }
      try {
        const r = JSON.parse(raw) as Record<string, unknown>;
        if (r && typeof r === "object" && typeof r.state === "string" && STATES.has(r.state) && typeof r.seq === "number" && Number.isFinite(r.seq)) {
          return { state: r.state, seq: r.seq, text: typeof r.text === "string" ? r.text : undefined };
        }
      } catch {
        // truncated/partial/invalid — fall through to the next-newest version
      }
    }
    if (!vanished) break; // finished the listing with no vanished-file race — nothing newer to chase
  }
  return undefined;
}

/**
 * Record a session's status as a LOCK-FREE monotonic max-register. Each event writes its OWN immutable file
 * `<safeKey>.json.<seq>` (staged temp + atomic rename), and readStatusFile returns the highest-seq version.
 *
 * Why not one file overwritten in place: that has a read→check→rename TOCTOU — a stale (lower-seq) writer
 * that already passed the no-regress check can still rename AFTER a newer writer, leaving an OLDER state on
 * disk that a reader which never saw the newer value then accepts, with no next event to correct it. Writing
 * each seq to its own name removes that race entirely: two writers never target the same path, and the
 * on-disk max is provably non-decreasing — the globally-highest-seq writer always leaves its file present
 * (it writes it unless an even-higher one already exists), and a lower-seq writer only ever prunes versions
 * strictly below its own contribution, so it can never remove the max. A reader therefore never regresses.
 *
 * The SEQ only APPROXIMATES the event time: it is sampled as early as a self-reported hook can — in the
 * hook shell, passed as --seq (see installClaudeStatusHooks; a manual/degraded run falls back to
 * report-status's own start time). It is NOT the kernel-level event instant: a hook shell scheduled out
 * before it samples can still carry a later seq than a strictly-later event, so ordering is best-effort, not
 * total. The reader's per-identity monotonic guard, the ~1s re-read, and the next turn-boundary event
 * re-settle any transient inversion; the only unrecovered residual is a session whose VERY LAST event is a
 * reordered one (the same class herdr absorbs with debounce). Returns false only on invalid input or I/O.
 */
export function writeStatusFile(home: string, key: string, state: string, opts?: { seq?: number; text?: string }): boolean {
  if (!STATES.has(state)) return false;
  const seq = opts?.seq ?? Date.now(); // event time; ordering is by event, never bumped
  if (!Number.isSafeInteger(seq) || seq < 0) return false;
  const dir = statusDir(home);
  const base = baseName(key);
  const tmp = path.join(dir, `${base}.${seq}.tmp.${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(dir, { recursive: true });
    const existing = versions(home, key);
    const maxSeq = existing.length ? existing[0].seq : -1;
    // Only write when ours is strictly newer than every version present. An equal/older seq is redundant —
    // the max already holds the winning state — and skipping it is just an optimization; correctness comes
    // from readStatusFile taking the max, not from this check.
    if (maxSeq < seq) {
      const rec: StatusFile = { state, seq, ...(opts?.text?.trim() ? { text: opts.text.trim() } : {}) };
      writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
      renameSync(tmp, path.join(dir, `${base}.${seq}`));
    }
    // Prune every version below the one that now wins. Best-effort and safe under concurrency: `keep` is at
    // most the on-disk max we observed, so we never unlink the winning version; a failed unlink just leaves
    // harmless clutter that the next write prunes. A lower-seq writer racing in afterward can re-create a
    // sub-max file, but that never shadows the max (reader takes the max) and is cleaned on the next event.
    const keep = Math.max(maxSeq, seq);
    for (const v of existing) {
      if (v.seq < keep) {
        try {
          rmSync(path.join(dir, v.name), { force: true });
        } catch {
          // harmless clutter — the reader still takes the max
        }
      }
    }
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
