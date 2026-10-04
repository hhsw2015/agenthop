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
