/**
 * Seat-shell record read-modify-write with a versioned CAS (coordinator ruling #1033 r7 / TBS-ORPHAN-GENERATION). ONE protocol for
 * every writer of ~/.agenthop/swarm/seat-shell/<sid>.json — the orphan marker here, and the #1034 worker start/stop + seat-shell
 * registration (Platform Dev) — so no writer can overwrite a record another writer published in between.
 *
 *   1. read the record, remember its top-level `rev` (absent = 0)
 *   2. compute the new record from what was read (pure `edit`)
 *   3. take `<sid>.json.lock` with O_EXCL (content: `<pid> <epoch ms>`); a lock older than LOCK_STALE_MS is dead and may be
 *      taken over (unlink + retry once); otherwise busy ⇒ "conflict" (caller re-reads and recomputes next round)
 *   4. under the lock RE-READ: rev differs from step 1 ⇒ release, "conflict" (someone published meanwhile — keep theirs)
 *   5. write rev+1 via an exclusive temp + rename, release the lock ⇒ "ok"
 * An unreadable / malformed record is "unknown" (never overwritten). `edit` returning null = "no change" (nothing written).
 */
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const LOCK_STALE_MS = 10_000;
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SeatRecord = Record<string, unknown> & { rev?: number };
export type CasResult = "ok" | "nochange" | "conflict" | "unknown";

export function seatRecordFile(home: string, sid: string): string {
  return path.join(home, ".agenthop", "swarm", "seat-shell", `${sid}.json`);
}

/** null = absent; "unknown" = exists but cannot be read / is not an object; else the record. */
export function readSeatRecord(file: string): SeatRecord | null | "unknown" {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unknown"; }
  try {
    const d = JSON.parse(raw) as unknown;
    if (typeof d !== "object" || d === null || Array.isArray(d)) return "unknown";
    const rev = (d as { rev?: unknown }).rev;
    if (rev !== undefined && !(Number.isSafeInteger(rev) && (rev as number) >= 0)) return "unknown";
    return d as SeatRecord;
  } catch { return "unknown"; }
}

const revOf = (r: SeatRecord | null): number => (r === null ? 0 : (r.rev ?? 0));

function takeLock(lock: string, now: () => number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try { writeFileSync(fd, `${process.pid} ${now()}\n`); } finally { closeSync(fd); }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      let age = 0;
      try { age = now() - statSync(lock).mtimeMs; } catch { continue; } // vanished meanwhile: retry
      if (age <= LOCK_STALE_MS) return false; // held by a live writer
      try { unlinkSync(lock); } catch { return false; } // dead lock: take over once
    }
  }
  return false;
}

/** Versioned CAS update of one seat record. `edit(current)` returns the new record (without caring about rev) or null for no
 *  change. `testHook` (tests only) runs between the first read and taking the lock, to simulate a concurrent publisher. */
export function casSeatRecord(
  home: string,
  sid: string,
  edit: (current: SeatRecord | null) => SeatRecord | null,
  now: () => number = Date.now,
  testHook?: () => void,
): CasResult {
  if (!SID_RE.test(sid)) return "unknown";
  const file = seatRecordFile(home, sid);
  const first = readSeatRecord(file);
  if (first === "unknown") return "unknown";
  const next = edit(first);
  if (next === null) return "nochange";
  testHook?.();
  try { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch { return "unknown"; }
  const lock = `${file}.lock`;
  if (!takeLock(lock, now)) return "conflict";
  try {
    const again = readSeatRecord(file);
    if (again === "unknown") return "unknown";
    if (revOf(again) !== revOf(first)) return "conflict"; // someone published between our read and the lock: keep theirs
    const out = { ...next, rev: revOf(first) + 1 };
    const tmp = `${file}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(out) + "\n"); } finally { closeSync(fd); }
      renameSync(tmp, file);
    } catch {
      try { unlinkSync(tmp); } catch { /* only our own temp */ }
      return "unknown";
    }
    return "ok";
  } finally {
    try { unlinkSync(lock); } catch { /* best-effort */ }
  }
}
