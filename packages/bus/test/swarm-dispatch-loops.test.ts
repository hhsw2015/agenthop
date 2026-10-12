import { describe, expect, test } from "vitest";
import { runDispatchLoops } from "../src/swarm/dispatch-loops.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** R1: the sweep loop must not be starved by a slow pass — it runs concurrently, so a sweep disposition is observed WHILE
 *  the slow pass is still in flight (the original bug deferred all sweeps until the long pass returned). */

describe("runDispatchLoops", () => {
  test("the sweep runs WHILE a slow pass tick is still in flight (not deferred to its completion)", async () => {
    let passDone = false;
    let sweepCount = 0;
    let sweepsDuringPass = 0;
    await runDispatchLoops({
      passTick: async () => { await sleep(200); passDone = true; }, // one slow prefix pass
      sweepTick: async () => { sweepCount += 1; if (!passDone) sweepsDuringPass += 1; },
      sleep,
      passIntervalMs: 1000,
      sweepIntervalMs: 10,
      shouldStop: () => sweepCount >= 3,
      onError: () => {},
    });
    expect(sweepsDuringPass).toBeGreaterThanOrEqual(2); // sweeps happened before the slow pass finished — not starved
  });

  test("onTick fires start/end per loop; sweep beats faster than the slower pass loop (per-loop heartbeat)", async () => {
    const beats: string[] = [];
    let sweepCount = 0;
    await runDispatchLoops({
      passTick: async () => { await sleep(1); },
      sweepTick: async () => { sweepCount += 1; },
      sleep,
      passIntervalMs: 5,   // pass re-checks shouldStop every ~5ms (so the loop exits promptly, no hang)
      sweepIntervalMs: 1,  // sweep ticks faster
      shouldStop: () => sweepCount >= 5,
      onError: () => {},
      onTick: (loop, phase) => beats.push(`${loop}:${phase}`),
    });
    const n = (b: string) => beats.filter((x) => x === b).length;
    expect(n("sweep:start")).toBe(n("sweep:end"));                 // every started sweep tick also ended (none wedged)
    expect(n("sweep:end")).toBeGreaterThanOrEqual(4);             // sweep advanced several ticks
    expect(beats).toContain("pass:start");                        // pass beat too
    expect(n("sweep:start")).toBeGreaterThan(n("pass:start"));    // the two loops beat at independent rates
  });

  test("a throwing tick is reported and does not kill the loop (the other loop keeps running)", async () => {
    const errors: string[] = [];
    let sweepCount = 0;
    await runDispatchLoops({
      passTick: async () => { throw new Error("boom"); },
      sweepTick: async () => { sweepCount += 1; },
      sleep,
      passIntervalMs: 5,
      sweepIntervalMs: 5,
      shouldStop: () => sweepCount >= 2,
      onError: (where, e) => errors.push(`${where}:${e instanceof Error ? e.message : e}`),
    });
    expect(sweepCount).toBeGreaterThanOrEqual(2);          // sweep loop unaffected by the pass loop throwing
    expect(errors.some((s) => s.startsWith("pass:boom"))).toBe(true); // the error was surfaced, not swallowed
  });
});

import { loadControlOrEscalate } from "../src/swarm/dispatch-loops.js";

describe("loadControlOrEscalate (DISP-1: control-load fail-soft)", () => {
  test("a throwing load ⇒ returns null and escalates ONCE (tick skips control work, never wedges)", () => {
    let faults = 0; let seen: unknown;
    const r = loadControlOrEscalate<{ seq: number }>(() => { throw new Error("EACCES: open '5.json'"); }, (e) => { faults++; seen = e; });
    expect(r).toBe(null);
    expect(faults).toBe(1);                                  // escalated exactly once (caller dedups the coordinator notice)
    expect(seen).toBeInstanceOf(Error);                     // the fault is handed to the escalator for logging
  });

  test("a successful load ⇒ returns the state, never escalates", () => {
    let faults = 0;
    const r = loadControlOrEscalate(() => ({ seq: 7 }), () => { faults++; });
    expect(r).toEqual({ seq: 7 });
    expect(faults).toBe(0);
  });

  test("the escalator is NOT called on success and the state is passed through by reference", () => {
    const state = { seq: 1, records: new Map() };
    let faults = 0;
    const r = loadControlOrEscalate(() => state, () => { faults++; });
    expect(r).toBe(state);                                  // same reference (no copy): sweepStateRef.s = it
    expect(faults).toBe(0);
  });
});

import { runSweepTick, runRenewThenSweep } from "../src/swarm/dispatch-loops.js";

describe("runSweepTick (DISP1-2/DISP1-3: group by control-dependency, isolate each step)", () => {
  const rec = () => { const log: string[] = []; const mk = (n: string) => () => { log.push(n); }; return { log, mk }; };

  test("control loads ⇒ independent + dependent + tail ALL run", async () => {
    const { log, mk } = rec();
    await runSweepTick({
      independent: [mk("i1"), mk("i2")],
      loadControl: () => { log.push("load:ok"); return true; },
      dependent: [mk("d1"), mk("d2")],
      tail: [mk("t1")],
      onError: () => { throw new Error("no error expected"); },
    });
    expect(log).toEqual(["i1", "i2", "load:ok", "d1", "d2", "t1"]); // independent BEFORE load, dependent only after, tail last
  });

  test("control FAILS ⇒ independent + tail still run, dependent SKIPPED (DISP1-2: a corrupt log never silences independent duties)", async () => {
    const { log, mk } = rec();
    await runSweepTick({
      independent: [mk("inboxSentinel"), mk("successionHeartbeat")],
      loadControl: () => { log.push("load:FAIL"); return false; },
      dependent: [mk("sweepPass"), mk("approval")],
      tail: [mk("gauge"), mk("digest")],
      onError: () => {},
    });
    expect(log).toEqual(["inboxSentinel", "successionHeartbeat", "load:FAIL", "gauge", "digest"]); // NO sweepPass/approval
  });

  test("a DEPENDENT step throwing is isolated — later dependents AND the tail still run (tail never starved, DISP1-1 promise)", async () => {
    const { log, mk } = rec(); const errs: string[] = [];
    await runSweepTick({
      independent: [mk("i1")],
      loadControl: () => true,
      dependent: [() => { throw new Error("deadletter boom"); }, mk("afterThrow")],
      tail: [mk("gauge")],
      onError: (where) => errs.push(where),
    });
    expect(log).toEqual(["i1", "afterThrow", "gauge"]);        // the throw did NOT skip the next dependent or the tail
    expect(errs).toEqual(["sweep.dependent[0]"]);              // reported, named
  });

  test("an INDEPENDENT step throwing is isolated — the rest of the tick still runs", async () => {
    const { log, mk } = rec(); const errs: string[] = [];
    await runSweepTick({
      independent: [() => { throw new Error("sentinel boom"); }, mk("i2")],
      loadControl: () => true,
      dependent: [mk("d1")],
      tail: [mk("t1")],
      onError: (where) => errs.push(where),
    });
    expect(log).toEqual(["i2", "d1", "t1"]);
    expect(errs).toEqual(["sweep.independent[0]"]);
  });

  test("recovery: a failed-load tick skips dependents; the NEXT tick with a readable log resumes them", async () => {
    const seq: boolean[] = [false, true]; let tick = 0;
    const runs: string[] = [];
    const once = () => runSweepTick({
      independent: [() => { runs.push("indep"); }],
      loadControl: () => seq[tick++]!,
      dependent: [() => { runs.push("dep"); }],
      tail: [() => { runs.push("tail"); }],
      onError: () => {},
    });
    await once(); // control unreadable ⇒ no dep
    await once(); // control repaired ⇒ dep resumes
    expect(runs).toEqual(["indep", "tail", "indep", "dep", "tail"]);
  });

  test("async steps are awaited in order (a slow dependent completes before the tail)", async () => {
    const log: string[] = [];
    await runSweepTick({
      independent: [],
      loadControl: () => true,
      dependent: [async () => { await new Promise((r) => setTimeout(r, 20)); log.push("slow-dep"); }],
      tail: [() => { log.push("tail"); }],
      onError: () => {},
    });
    expect(log).toEqual(["slow-dep", "tail"]);
  });
});

describe("runRenewThenSweep (DISP1-1: a half-read renewal fault SKIPS the expiry sweep)", () => {
  test("renew completes + control reloads ⇒ sweep runs", async () => {
    const seen: string[] = [];
    await runRenewThenSweep({ renew: () => { seen.push("renew"); return true; }, reload: () => { seen.push("reload"); return true; }, sweep: () => { seen.push("sweep"); } });
    expect(seen).toEqual(["renew", "reload", "sweep"]);
  });

  test("renew returns false (a control read faulted) ⇒ NO reload, NO sweep — never escalate a wait we failed to renew", async () => {
    const seen: string[] = [];
    await runRenewThenSweep({ renew: () => { seen.push("renew"); return false; }, reload: () => { seen.push("reload"); return true; }, sweep: () => { seen.push("sweep"); } });
    expect(seen).toEqual(["renew"]); // a clean reload is NOT a substitute for the missed renewal phase
  });

  test("renew completes but control reload is unreadable ⇒ sweep skipped this tick", async () => {
    const seen: string[] = [];
    await runRenewThenSweep({ renew: () => { seen.push("renew"); return true; }, reload: () => { seen.push("reload"); return false; }, sweep: () => { seen.push("sweep"); } });
    expect(seen).toEqual(["renew", "reload"]);
  });

  test("an async sweep is awaited", async () => {
    const seen: string[] = [];
    await runRenewThenSweep({ renew: () => true, reload: () => true, sweep: async () => { await new Promise((r) => setTimeout(r, 10)); seen.push("sweep-done"); } });
    expect(seen).toEqual(["sweep-done"]);
  });
});
