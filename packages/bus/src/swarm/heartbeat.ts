/**
 * Per-loop dispatcher heartbeat (cluster-liveness L1, the uncontroversial subset — the INV-1 validator / livenessVerdict
 * are NOT here, they await rev3). The dispatcher runs two INDEPENDENT loops (pass, sweep — runDispatchLoops); a single
 * whole-process heartbeat can't tell "the sweep is wedged while the pass ticks fine". So each loop records its OWN field:
 * lastTickSec (last completed tick) + inFlight ({step, startedSec} while a tick is running, null when idle between ticks).
 * A reader detects a wedged loop by a stale lastTickSec OR a long-running inFlight — but the verdict logic is deferred.
 *
 * Independence is the point: each update is a synchronous read-modify-write of ONLY that loop's field (atomic temp+rename),
 * so one loop freezing never stops the other's field from advancing, and the two concurrent loops (same process, single
 * JS thread) can't clobber each other mid-write. Fail-soft — the heartbeat is observability, never a barrier.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

export type InFlight = { step: string; startedSec: number };
export type LoopBeat = { lastTickSec: number | null; inFlight: InFlight | null; mode?: string };
export type LoopName = "pass" | "sweep";
export type Heartbeat = { instance: string; pid: number; pass: LoopBeat; sweep: LoopBeat };

export type BeatMeta = { instance: string; pid: number };

const emptyLoop = (): LoopBeat => ({ lastTickSec: null, inFlight: null });
const emptyBeat = (meta: BeatMeta): Heartbeat => ({ instance: meta.instance, pid: meta.pid, pass: emptyLoop(), sweep: emptyLoop() });

export type ReadFile = (file: string) => string;
const defaultRead: ReadFile = (f) => readFileSync(f, "utf8");

/**
 * Read the current heartbeat for a read-modify-write. Three distinct cases (review P2 — a transient read error must NOT be
 * conflated with "no file", which would reset the OTHER loop's field):
 *   - ENOENT (file absent)         ⇒ emptyBeat (this is the first write).
 *   - any OTHER read error         ⇒ THROW — the caller SKIPS this beat rather than clobber the other loop with an empty.
 *   - present but corrupt JSON     ⇒ re-initialize (the file was unusable anyway).
 */
function readBeat(file: string, meta: BeatMeta, readFile: ReadFile): Heartbeat {
  let raw: string;
  try { raw = readFile(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyBeat(meta); throw e; } // transient ⇒ propagate (skip)
  try {
    const hb = JSON.parse(raw) as Partial<Heartbeat>;
    return { instance: meta.instance, pid: meta.pid, pass: hb.pass ?? emptyLoop(), sweep: hb.sweep ?? emptyLoop() };
  } catch { return emptyBeat(meta); } // corrupt content ⇒ re-initialize
}

function writeAtomic(file: string, hb: Heartbeat): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(hb, null, 2), { mode: 0o644 });
  renameSync(tmp, file);
}

/** Apply a mutation to ONE loop's field, preserving the other loop (synchronous RMW — no clobber). A transient read error
 *  SKIPS the beat (no write) rather than clobber the other loop with an empty record; the next beat retries. */
function update(file: string, meta: BeatMeta, loop: LoopName, patch: Partial<LoopBeat>, readFile: ReadFile): void {
  let hb: Heartbeat;
  try { hb = readBeat(file, meta, readFile); }
  catch { return; } // transient read error ⇒ skip this beat; do NOT write (would clobber the other loop)
  hb[loop] = { ...hb[loop], ...patch };
  writeAtomic(file, hb);
}

/** Mark a loop's tick as in-flight (start): records the step + when it began, so a long tick is visible, not silent. */
export function beatStart(file: string, meta: BeatMeta, loop: LoopName, step: string, nowSec: number, mode?: string, readFile: ReadFile = defaultRead): void {
  update(file, meta, loop, { inFlight: { step, startedSec: nowSec }, ...(mode !== undefined ? { mode } : {}) }, readFile);
}

/** Mark a loop's tick as complete: advances lastTickSec + clears inFlight. */
export function beatEnd(file: string, meta: BeatMeta, loop: LoopName, nowSec: number, mode?: string, readFile: ReadFile = defaultRead): void {
  update(file, meta, loop, { lastTickSec: nowSec, inFlight: null, ...(mode !== undefined ? { mode } : {}) }, readFile);
}
