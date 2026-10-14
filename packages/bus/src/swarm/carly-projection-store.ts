/**
 * Carly projection IO (dialog-officer M2-a, deliverable ③ — the store half of carly-projection.ts). Writes the SWARM-managed
 * region of Carly's `~/.agenthop/carly/HEARTBEAT.md` and `MEMORY.md`, preserving her own bytes outside the markers (dual-write
 * isolation). The write is atomic (temp + rename) so a crash mid-write never leaves a half file and two concurrent sweeps each
 * land a complete file (the 3-fixture law: idempotent byte-same / half-write-crash / concurrent single-win).
 *
 * `writeCarlyProjection(home, status)` takes an already-normalized CarlyStatus so the write path is unit-tested with no real
 * sources; `readCarlyStatus(home)` is the thin adapter that reads the live durable sources into that shape.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, openSync, closeSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import {
  type CarlyStatus,
  type HeartbeatEntry,
  buildHeartbeatBody,
  buildMemoryBody,
  wrapManagedBlock,
  spliceManagedBlock,
} from "./carly-projection.js";
import { listBatchesStrict, readBatch, readConsumedResult } from "./decision-batch-store.js";
import { readDigestProjection } from "./morning-digest-store.js";

/** Carly's home dir and her two managed files. `AH_HOME` overrides (tests + per-project durable roots), else the real home. */
export function carlyHome(home?: string): string { return home ?? process.env.AH_HOME ?? homedir(); }
export function carlyDir(home?: string): string { return path.join(carlyHome(home), ".agenthop", "carly"); }
export function heartbeatFile(home?: string): string { return path.join(carlyDir(home), "HEARTBEAT.md"); }
export function memoryFile(home?: string): string { return path.join(carlyDir(home), "MEMORY.md"); }

/** Read a managed file for a read-splice-write; a missing file is "" (first write creates it). Any OTHER read error propagates
 *  so the caller SKIPS rather than clobbering her content with an empty rewrite (FC-2: a transient fault is not "no file"). */
function readExisting(file: string): string {
  try { return readFileSync(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw e; }
}

/** Bounded synchronous sleep (no dep) for the lock spin. */
function sleepMs(ms: number): void { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best-effort */ } }

/**
 * DS-PROJ-CONFLICT — serialize the read-modify-write of a SHARED managed file behind an advisory lock (`<file>.lock`, O_EXCL).
 * The managed region is swarm-owned, the rest is Carly's; because the whole file is a shared surface, a read-then-rename can
 * clobber a concurrent writer's out-of-region edit. This lock makes the RMW a critical section: it is the "explicit + enforced
 * serialization constraint" — EVERY writer of these files (every swarm sweep here) acquires it, so two writers can never
 * interleave a lost update. A stale lock (holder crashed) older than STALE_MS is reclaimed so a crash can't wedge the projection;
 * if the lock stays held (another live writer), we return busy and the caller HOLDs (next tick retries) rather than clobber.
 * (A co-writer outside this module must honor the same lock — that is the documented contract; nothing else can protect a shared
 * file against an uncooperative editor.)
 */
function withManagedLock<T>(file: string, fn: () => T): T | { busy: true } {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const STALE_MS = 10000;
  let fd = -1;
  for (let t = 0; t < 100 && fd < 0; t++) {
    try { fd = openSync(lock, "wx", 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_MS) { unlinkSync(lock); continue; } } catch { /* vanished ⇒ retry */ }
      sleepMs(20);
    }
  }
  if (fd < 0) return { busy: true };
  try { return fn(); }
  finally { try { closeSync(fd); } catch { /* */ } try { unlinkSync(lock); } catch { /* */ } }
}

/** EXCLUSIVELY create the temp (wx ⇒ our own fresh inode — never truncate/follow a pre-existing temp or a planted symlink), then
 *  rename over the target; a fault removes only OUR temp (DS-TEMP-OWN). */
function atomicReplace(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let tmp = "";
  for (let t = 0; ; t++) {
    tmp = `${file}.wtmp-${randomBytes(8).toString("hex")}`;
    try { writeFileSync(tmp, data, { flag: "wx", mode: 0o600 }); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST" && t < 8) continue; throw e; }
  }
  try { renameSync(tmp, file); }
  catch (e) { try { unlinkSync(tmp); } catch { /* only our own temp */ } throw e; }
}

/** Splice-write of ONE managed file under the serialization lock: read her current bytes, replace only the managed block, write via
 *  an exclusive temp + rename. Returns true on write, false if the lock is BUSY (another writer active ⇒ HOLD, retry next tick —
 *  never clobber). The read-splice-rename all happen INSIDE the lock so a co-writer honoring the lock cannot interleave. */
export function writeManagedFile(file: string, body: string): boolean {
  const r = withManagedLock(file, () => {
    const existing = readExisting(file);
    atomicReplace(file, spliceManagedBlock(existing, wrapManagedBlock(body)));
    return true;
  });
  return r === true;
}

/** Write BOTH managed files from a normalized status. HEARTBEAT.md carries the FROZEN 4-field awaiting-ruling queue (Carly scans
 *  it model-free); MEMORY.md carries alerts + the one-line digest + the usage note (deliverable ④) — all INSIDE the managed
 *  region so they are swarm-owned and regenerated, never hand-edited. Idempotent: equal status ⇒ byte-identical files. */
export function writeCarlyProjection(home: string | undefined, status: CarlyStatus): { heartbeat: string; memory: string; wroteHeartbeat: boolean; wroteMemory: boolean } {
  const hb = heartbeatFile(home);
  const mem = memoryFile(home);
  const wroteHeartbeat = writeManagedFile(hb, buildHeartbeatBody(status.heartbeat));
  const wroteMemory = writeManagedFile(mem, buildMemoryBody(status) + "\n\n" + CARLY_USAGE_NOTE);
  return { heartbeat: hb, memory: mem, wroteHeartbeat, wroteMemory };
}

/** Deliverable ④: the usage note written into Carly's MEMORY managed region. Addresses are ROLES (resolved via the F40 layer),
 *  never raw sids — a sid drifts on a shell swap, a role is stable. To hand anything to the swarm she runs swarm-carly-send. */
export const CARLY_USAGE_NOTE = [
  "### How to reach the swarm (managed)",
  "- To hand a message to a coordinator, run: `swarm-carly-send <role> <text>` (e.g. `swarm-carly-send coordinator \"...\"`).",
  "- Address by ROLE, never a raw sid — a sid changes when a seat swaps shells; the role resolves through the F40 layer.",
  "- A relayed message is passed VERBATIM (the swarm sees your exact text) and echoed back for a trace (「已转达:原文」).",
  "- The message is stamped from Carly (envelope via:carly) and lands in the target's durable inbox (it waits there if the seat is offline) and pings its pane.",
  "- Your switchboard view of projects is `~/.agenthop/projects.json` (read-only; the swarm maintains it).",
].join("\n");

// ---------------------------------------------------------------------------------------------------------------------
// Live-source adapter: read the real durable sources into a normalized CarlyStatus, FC-2 safe.
// ---------------------------------------------------------------------------------------------------------------------

/** One-line digest from the morning-digest projection: "title (n); title (n); ...". */
function oneLineDigest(sections: { title: string; lines: string[] }[]): string {
  return sections.map((s) => `${s.title} (${s.lines.length})`).join("; ");
}

/**
 * Read the live sources into a CarlyStatus + a `certain` flag. The HEARTBEAT queue (候裁) is the NOT-yet-consumed decision batches'
 * items (awaiting the user's ruling); alerts come from the idle-explainer; the digest is the morning-digest projection folded to one
 * line. FC-2: a decision-store enumerate fault ⇒ `certain=false` (the caller must KEEP her last-good files, never clear the queue on
 * a transient fault). A per-batch "unknown" consumed-state is OVER-shown (a pending ruling is never hidden), an unprovable batch is
 * skipped. Alerts/digest are advisory — an unreadable one degrades to empty, not to uncertainty.
 */
export function readCarlyStatus(home: string): { status: CarlyStatus; certain: boolean } {
  let certain = true;
  const heartbeat: HeartbeatEntry[] = [];
  try {
    for (const id of listBatchesStrict(home)) {
      const c = readConsumedResult(home, id);
      if (c.consumed === true) continue;            // terminal ⇒ not awaiting
      const b = readBatch(home, id);
      if (!b) { certain = false; continue; }         // DS-PROJ-SOURCE: an enumerated, not-consumed batch we CANNOT decode is
                                                     // UNCERTAIN — it may be a pending ruling; mark uncertain so the caller HOLDs
                                                     // (keeps the last-good queue) instead of silently clearing it to "(none)".
      for (const it of b.items) heartbeat.push({ id: it.id, deadlineISO: "", waitingFor: "user", ask: it.summary });
    }
  } catch { certain = false; }                       // enumerate/consumed stat fault ⇒ uncertain ⇒ caller keeps last good

  const alerts: string[] = [];
  try {
    const raw = readFileSync(path.join(carlyHome(home), ".agenthop", "swarm", "console", "idle-explainer.json"), "utf8");
    const ie = JSON.parse(raw) as { anomaly?: unknown; reason?: unknown };
    if (ie && ie.anomaly === true && typeof ie.reason === "string" && ie.reason !== "") alerts.push(ie.reason);
  } catch { /* absent/unreadable/corrupt ⇒ no alerts (advisory, never a certainty-breaker) */ }

  let digest: string | null = null;
  try {
    const p = readDigestProjection(carlyHome(home));
    if (p.kind === "valid") digest = oneLineDigest(p.projection.sections);
  } catch { /* advisory */ }

  return { status: { heartbeat, alerts, digest }, certain };
}

/** SWARM sweep entry: read the live sources and write Carly's managed regions. On source UNCERTAINTY (a decision-store fault) it
 *  SKIPS the write (keeps her last-good HEARTBEAT/MEMORY — never clears the queue on a transient fault). Returns what it did. */
export function runCarlyProjection(home?: string): { wrote: boolean; reason?: string } {
  const h = carlyHome(home);
  const { status, certain } = readCarlyStatus(h);
  if (!certain) return { wrote: false, reason: "source-uncertain" }; // keep her last-good files (never clear the queue on a fault)
  const w = writeCarlyProjection(h, status);
  if (!w.wroteHeartbeat || !w.wroteMemory) return { wrote: false, reason: "write-lock-busy" }; // another writer holds the lock ⇒ retry next tick
  return { wrote: true };
}

export { type CarlyStatus } from "./carly-projection.js";
