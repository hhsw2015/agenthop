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
