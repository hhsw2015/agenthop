/**
 * control-store — the thin IO shell over the pure commitControl engine (control-log.ts), brain §4.3 step A. Ownership
 * split (B): the pure Change/commit/replay engine is control-log.ts; this module only DURABLY WRITES each committed
 * batch and REBUILDS state from the on-disk log. Local-only (one dispatcher machine); the cross-machine CONTROL ref +
 * awaitable barrier are step B / Phase T3.
 *
 * Persistence model: one file per batch, `<seq>.json` = CommittedBatch {seq, changes}, written atomically (temp+rename,
 * 0600). A fresh process enumerates + replays them (replayLog asserts contiguous seq, catching a gap/corruption). The
 * synchronous write IS the CAS-then-IO barrier for step A ("本机 fsync 即屏障"): commitControl persists before it
 * returns, so a caller that does `commitControl(...); startTask(...)` has the intent durable BEFORE the allocate IO.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import {
  commit, replayLog, initialLogState,
  type Change, type CommitResult, type CommittedBatch, type LogState,
} from "./control-log.js";

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
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
