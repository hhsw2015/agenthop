/**
 * control-store — the thin IO shell over the pure commitControl engine (control-log.ts), brain §4.3 step A. Ownership
 * split (B): the pure Change/commit/replay engine is control-log.ts; this module only DURABLY WRITES each committed
 * batch and REBUILDS state from the on-disk log. Local-only (one dispatcher machine); the cross-machine CONTROL ref +
 * awaitable barrier are step B / Phase T3.
 *
 * Persistence model: one file per batch, `<seq>.json` = CommittedBatch {seq, changes}, written atomically + durably
 * (temp → fsync → rename → dir fsync, 0600). A fresh process enumerates + replays them (replayLog asserts contiguous seq,
 * catching a gap/corruption). The write IS the CAS-then-IO barrier for step A ("本机 fsync 即屏障"): commitControl fsyncs
 * the batch to disk before it returns, so a caller that does `commitControl(...); startTask(...)` has the intent durable
 * BEFORE the allocate IO — a sync return alone proves program order + atomic visibility, NOT on-disk survival across a
 * power loss (Codex review P2-6: the fsyncs are what make the claimed barrier real). Cross-machine CONTROL = step B / T3.
 */

import { mkdirSync, readdirSync, readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import {
  commit, replayLog, initialLogState,
  type Change, type CommitResult, type CommittedBatch, type LogState,
} from "./control-log.js";
import { worklogLinesFromBatch, WORKLOG_FILE } from "./worklog.js";

/** Atomic + durable publish of a NEW file; throws EEXIST if it already exists — a disk-level CAS so a stale in-memory
 *  writer can NEVER overwrite an already-committed <seq>.json (R2). temp → fsync → hard-link into place → dir fsync. Any
 *  failure PROPAGATES (R4: a non-durable barrier must fail the commit, not be swallowed). */
function atomicWriteNew(file: string, data: string): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, file); } finally { try { unlinkSync(tmp); } catch { /* tmp already gone */ } } // atomic; EEXIST ⇒ seq taken
  const dfd = openSync(path.dirname(file), "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

function maxSeqOnDisk(dir: string): number {
  try { return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).reduce((m, f) => Math.max(m, Number(f.slice(0, -".json".length))), 0); }
  catch { return 0; }
}

/** The on-disk log as its ordered CommittedBatch list (seq-ascending). A missing dir = no batches. Exposed for consumers that
 *  need per-batch SEQs (not just the folded projection) — e.g. §2c-b evidence renewal deriving a subject's progress seq. */
export function readControlBatches(dir: string): CommittedBatch[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f)) // ignore `<seq>.json.tmp.<pid>` partials from a crashed write
    .map((f) => ({ f, seq: Number(f.slice(0, -".json".length)) }))
    .sort((a, b) => a.seq - b.seq)
    .map(({ f }) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as CommittedBatch);
}

/** Rebuild LogState from the on-disk log. A missing dir = the initial (seq 0) state. */
export function loadControlLog(dir: string): LogState {
  return replayLog(readControlBatches(dir));
}

/**
 * Commit one batch and, if it newly advanced the log, persist it before returning (CAS-then-IO barrier). A full replay
 * (idempotent no-op) and any rejection write nothing. Single-active dispatcher ⇒ expectedSeq is always the current seq.
 * Pure-state-wise this delegates to commit(); the only side effect is the durable write of an accepted new batch.
 */
export function commitControl(dir: string, state: LogState, changes: Change[]): { result: CommitResult; state: LogState } {
  const r = commit(state, state.seq, changes);
  if (r.result.ok && !r.result.replay) {
    mkdirSync(dir, { recursive: true });
    const batch: CommittedBatch = { seq: r.result.newSeq, changes };
    try { atomicWriteNew(path.join(dir, `${r.result.newSeq}.json`), JSON.stringify(batch)); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        // disk-CAS conflict (R2): another writer already committed this seq — our in-memory snapshot is stale. Do NOT
        // overwrite; report a seq conflict with the on-disk head so the caller reloads + retries. State returned unadvanced.
        return { result: { ok: false, reason: "seq", currentSeq: maxSeqOnDisk(dir) }, state };
      }
      throw e; // a real durable-write failure (R4) — propagate; never report ok on a non-durable barrier
    }
    // worklog-timeline hook (brain worklog-timeline; pure builder owner 90b58f9c): the control batch is durable now, so
    // mirror it into the work TIMELINE (a projection of the log, NOT a second ledger). ONE hook covers both the dispatcher
    // and the sweep (every wait transition goes through commitControl). BEST-EFFORT: an append failure must NEVER fail an
    // already-durable control commit; any gap is rebuilt by scripts/worklog-backfill.ts from the authoritative control-log.
    try {
      const lines = worklogLinesFromBatch(changes, Math.floor(Date.now() / 1000));
      if (lines.length) appendFileSync(path.join(path.dirname(dir), WORKLOG_FILE), lines.join(""));
    } catch { /* worklog is derived + rebuildable; never break the authoritative commit for it */ }
  }
  return r;
}
