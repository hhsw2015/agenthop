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

import { mkdirSync, readdirSync, readFileSync, renameSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import {
  commit, replayLog, initialLogState,
  type Change, type CommitResult, type CommittedBatch, type LogState,
} from "./control-log.js";

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp.${process.pid}`;
  // Write + fsync the data, then rename, then fsync the directory so the rename's directory entry also survives power
  // loss. Only with both fsyncs is this the durable barrier the step-A contract claims (P2-6).
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  try { const dfd = openSync(path.dirname(file), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } }
  catch { /* directory fsync is best-effort — some platforms disallow fsync on a dir fd; the file fsync is the barrier */ }
}

/** Rebuild LogState from the on-disk log. A missing dir = the initial (seq 0) state. */
export function loadControlLog(dir: string): LogState {
  if (!existsSync(dir)) return initialLogState();
  const batches: CommittedBatch[] = readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f)) // ignore `<seq>.json.tmp.<pid>` partials from a crashed write
    .map((f) => ({ f, seq: Number(f.slice(0, -".json".length)) }))
    .sort((a, b) => a.seq - b.seq)
    .map(({ f }) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as CommittedBatch);
  return replayLog(batches);
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
    atomicWrite(path.join(dir, `${r.result.newSeq}.json`), JSON.stringify(batch));
  }
  return r;
}
