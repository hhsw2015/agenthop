import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { isValidSessionId } from "../send-fallback.js";
import { acquireHolderLock, releaseHolderLock, type LockSite } from "./holder-lock.js";

/**
 * The ONE write path for ~/.agenthop/swarm/seat-shell/<sid>.json (coordinator ruling, shared by #1033 r7 orphan markers, #1034
 * agenthop_tern workers, #1053 seat-presence). Several writers own different keys of the same record (shell/pid, workers[], orphan
 * markers); a plain read → modify → rename lets a writer rename an OLD snapshot over a record another writer just published.
 *
 *   updateSeatShell(home, sid, fn): take the per-seat lock → read UNDER the lock → fn(record) → rev+1 → O_EXCL temp + rename →
 *   release. `fn` only ever sees the record as it is under the lock, so no writer can rename a stale snapshot. The record carries
 *   a top-level `rev:number` (absent on pre-rev files = 0). Defensive check: just before the rename the file is read again; if its
 *   rev is no longer the one read under the lock (a writer that bypassed the lock), nothing is written ⇒ "conflict". A rev read
 *   BEFORE taking the lock is NOT compared: honest locked writers legitimately advance it while we wait (8-process test).
 *
 * Lock = the shared holder-lock primitive (holder-lock.ts: atomic-mkdir dir, identity in the file NAME, pre-mkdir hold intents),
 * NOT a timestamp lock file: a holder is reclaimed only when its pid is DEFINITELY dead (ESRCH), never after a fixed age — a live
 * but slow writer is never robbed. Contended ⇒ retried for up to ~2s, then "busy" (the caller decides; nothing is written).
 */

export type SeatRecord = Record<string, unknown> & { rev?: number };
export type UpdateResult =
  | { state: "ok"; rev: number; record: SeatRecord }
  | { state: "busy" | "conflict" | "unreadable" | "refused"; reason: string };

export function seatShellDir(home: string): string { return path.join(home, ".agenthop", "swarm", "seat-shell"); }
export function seatShellPath(home: string, sid: string): string {
  if (!isValidSessionId(sid) || sid.includes("/") || sid.includes("\\") || sid === "." || sid === "..") throw new Error(`invalid seat sid: ${sid}`);
  return path.join(seatShellDir(home), `${sid}.json`);
}
function lockSite(home: string, sid: string): LockSite {
  return { lockDir: path.join(seatShellDir(home), `${sid}.json.lockd`), intentDir: seatShellDir(home), intentPrefix: `${sid}.json.lockd.hold.` };
}

/** Three-state read (FC-2): absent ⇒ {} at rev 0; unreadable / not a JSON object / bad rev ⇒ unreadable (never "empty"). */
export function readSeatRecord(home: string, sid: string): { kind: "ok"; record: SeatRecord; rev: number } | { kind: "unreadable"; reason: string } {
  let raw: string;
  try { raw = readFileSync(seatShellPath(home, sid), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "ok", record: {}, rev: 0 };
    return { kind: "unreadable", reason: (e as Error).message };
  }
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { kind: "unreadable", reason: "seat file is not JSON" }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "unreadable", reason: "seat file is not an object" };
  const rev = (v as SeatRecord).rev;
  if (rev !== undefined && !(Number.isSafeInteger(rev) && (rev as number) >= 0)) return { kind: "unreadable", reason: "rev is not a non-negative integer" };
  return { kind: "ok", record: v as SeatRecord, rev: (rev as number | undefined) ?? 0 };
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `fn` returns the NEW record (it gets a copy; `rev` is managed here), or null to write nothing. It must not throw for a
 *  legitimate "no change"; a throw is reported as refused and nothing is written. Never throws itself. */
export function updateSeatShell(home: string, sid: string, fn: (record: SeatRecord) => SeatRecord | null, opts: { waitMs?: number } = {}): UpdateResult {
  let dest: string;
  try { dest = seatShellPath(home, sid); } catch (e) { return { state: "refused", reason: (e as Error).message }; }
  try { mkdirSync(seatShellDir(home), { recursive: true, mode: 0o700 }); } catch (e) { return { state: "refused", reason: (e as Error).message }; }
  const site = lockSite(home, sid);
  const deadline = Date.now() + (opts.waitMs ?? 2000);
  let token: string | null = null;
  for (;;) {
    try { token = acquireHolderLock(site); } catch (e) { return { state: "refused", reason: `lock: ${(e as Error).message}` }; }
    if (token) break;
    if (Date.now() >= deadline) return { state: "busy", reason: "seat-shell record lock is held by another writer" };
    sleepSync(25);
  }
  try {
    const cur = readSeatRecord(home, sid);
    if (cur.kind === "unreadable") return { state: "unreadable", reason: cur.reason };
    let next: SeatRecord | null;
    try { next = fn({ ...cur.record }); } catch (e) { return { state: "refused", reason: (e as Error).message }; }
    if (next === null) return { state: "ok", rev: cur.rev, record: cur.record };
    const rev = cur.rev + 1;
    const out: SeatRecord = { ...next, rev };
    const tmp = `${dest}.tmp-${randomBytes(8).toString("hex")}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(out)}\n`); closeSync(fd);
      const again = readSeatRecord(home, sid);
      if (again.kind !== "ok" || again.rev !== cur.rev) {
        unlinkSync(tmp);
        return { state: "conflict", reason: `record changed under the lock (rev ${cur.rev} -> ${again.kind === "ok" ? again.rev : "unreadable"}): a writer bypassed the lock` };
      }
      renameSync(tmp, dest);
    }
    catch (e) { try { closeSync(fd); } catch { /* closed */ } try { unlinkSync(tmp); } catch { /* own temp */ } return { state: "refused", reason: (e as Error).message }; }
    return { state: "ok", rev, record: out };
  } catch (e) {
    return { state: "refused", reason: (e as Error).message };
  } finally {
    try { releaseHolderLock(site, token); } catch { /* the next acquirer reclaims a dead holder */ }
  }
}
