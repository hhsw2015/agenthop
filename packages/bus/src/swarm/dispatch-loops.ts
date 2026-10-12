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

/**
 * DISP-1 (infra audit): load the control log FAIL-SOFT. `loadControlLog` THROWS on a corrupt / EACCES / gapped `<seq>.json`,
 * and the dispatcher ticks called it UNGUARDED at the head — so ONE bad batch made every tick throw at line 1, wedging ALL
 * supervision AND the control-INDEPENDENT run* after it, forever, with only a 5s error log and no escalation. This wraps the
 * load: on a fault it calls `onFault` (the caller escalates to the coordinator + logs) and returns null, so the tick SKIPS
 * control-dependent work this round but still runs the independent observability (gauge/console/digest/wake); a later tick
 * that reads a repaired log resumes normally. Pure + injectable (generic over the state type, so no control-store coupling). */
export function loadControlOrEscalate<T>(load: () => T, onFault: (e: unknown) => void): T | null {
  try { return load(); }
  catch (e) { onFault(e); return null; }
}

/**
 * DISP1-2/DISP1-3 (codex:Work): the sweep tick, grouped by ACTUAL control-log dependency rather than by position. `independent`
 * run* read their OWN sources (inbox dirs, swap/PID records, review/round/placement ledgers), NOT the control log, so they run
 * EVERY tick — a corrupt control log must never silence them. `loadControl` is the fail-soft load (returns true iff the control
 * log is readable; it sets the shared state as a side effect and has already escalated on a fault). `dependent` run* (sweepPass,
 * projection/verdict, observer, dead-letter, live-sentinel, ops-receipt, approval) run ONLY when the control log loaded. `tail`
 * is the control-INDEPENDENT observability (gauge/console/digest/wake), also every tick. Each step is isolated (its throw is
 * reported via onError and never skips the remaining steps or the tail), so one faulty duty can't starve the others. Pure
 * scheduling — all work is injected, so the grouping + fail-soft behavior is offline-testable. */
export async function runSweepTick(p: {
  independent: Array<() => void | Promise<void>>;
  loadControl: () => boolean;
  dependent: Array<() => void | Promise<void>>;
  tail: Array<() => void | Promise<void>>;
  onError: (where: string, e: unknown) => void;
}): Promise<void> {
  const step = async (where: string, f: () => void | Promise<void>): Promise<void> => { try { await f(); } catch (e) { p.onError(where, e); } };
  for (let i = 0; i < p.independent.length; i++) await step(`sweep.independent[${i}]`, p.independent[i]!);
  let loaded = false;
  try { loaded = p.loadControl(); } catch (e) { p.onError("sweep.loadControl", e); loaded = false; } // loadControl is already fail-soft; this is belt-and-suspenders
  if (loaded) for (let i = 0; i < p.dependent.length; i++) await step(`sweep.dependent[${i}]`, p.dependent[i]!);
  for (let i = 0; i < p.tail.length; i++) await step(`sweep.tail[${i}]`, p.tail[i]!);
}

export type LoopName = "pass" | "sweep";

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
  /** Per-loop heartbeat beat — fired "start" BEFORE each tick and "end" AFTER it (even if the tick threw). A tick that
   *  NEVER settles never fires "end", so its heartbeat stays in-flight while the OTHER loop's beats keep advancing
   *  (per-loop liveness, L1). Optional + must not throw (the caller makes it fail-soft). */
  onTick?: (loop: LoopName, phase: "start" | "end") => void;
};

export async function runDispatchLoops(fns: LoopFns): Promise<void> {
  const loop = async (name: LoopName, tick: () => Promise<void>, intervalMs: number): Promise<void> => {
    while (!fns.shouldStop()) {
      fns.onTick?.(name, "start");
      try { await tick(); } catch (e) { fns.onError(name, e); }
      fns.onTick?.(name, "end");
      if (fns.shouldStop()) break;
      await fns.sleep(intervalMs);
    }
  };
  // Concurrent, independent loops — a slow passTick does not block the sweep loop (R1).
  await Promise.all([loop("pass", fns.passTick, fns.passIntervalMs), loop("sweep", fns.sweepTick, fns.sweepIntervalMs)]);
}
