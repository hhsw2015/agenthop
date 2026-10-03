/**
 * Dispatcher loop scheduling (team-collab §0b R2, Codex review P1-3/R1). The supervision sweep must NOT be starved by a
 * slow lifecycle/task pass: it runs on its OWN loop, CONCURRENTLY with the pass loop, so a long pass (e.g. a box
 * allocation awaiting IO) does not defer the sweep until the pass completes. The sweep therefore has execution opportunity
 * WHILE slow lifecycle/task IO is in flight.
 *
 * Single-writer safety across the two in-process loops is NOT a shared mutex — it is the control-store's disk-CAS (a stale
 * snapshot can never overwrite a committed <seq>.json, R2) plus the wait reducer's actionId-matched confirm: each loop
 * reloads from disk each tick, and a stale commit is rejected + retried next tick. Cross-process single-active is the
 * dispatcher lock (single-flight). This module is pure scheduling — all work + sleep + stop are injected, so the
 * non-starvation property is offline-testable without real timers-in-production.
 */

export type LoopFns = {
  /** One lifecycle + task pass tick (may be slow — awaits provisioning IO). */
  passTick: () => Promise<void>;
  /** One supervision sweep tick. */
  sweepTick: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  passIntervalMs: number;
  sweepIntervalMs: number;
  /** Loop-exit predicate (always false in production; a test flips it to stop). */
  shouldStop: () => boolean;
  onError: (where: string, e: unknown) => void;
};

export async function runDispatchLoops(fns: LoopFns): Promise<void> {
  const loop = async (name: string, tick: () => Promise<void>, intervalMs: number): Promise<void> => {
    while (!fns.shouldStop()) {
      try { await tick(); } catch (e) { fns.onError(name, e); }
      if (fns.shouldStop()) break;
      await fns.sleep(intervalMs);
    }
  };
  // Concurrent, independent loops — a slow passTick does not block the sweep loop (R1).
  await Promise.all([loop("pass", fns.passTick, fns.passIntervalMs), loop("sweep", fns.sweepTick, fns.sweepIntervalMs)]);
}
