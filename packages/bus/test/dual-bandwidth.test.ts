import { describe, expect, test } from "vitest";
import { computeDualBandwidth, type DualBandwidthInput } from "../src/swarm/dual-bandwidth.js";

const NOW = 1_000_000; // sec
// n timestamps evenly inside the last hour (all > now-3600), so rate == n/hour for the default window.
const inLastHour = (n: number): number[] => Array.from({ length: n }, (_, i) => NOW - (i + 1) * 10);
const run = (p: Partial<DualBandwidthInput>) =>
  computeDualBandwidth({ nowSec: NOW, produceAtSec: [], consumeAtSec: [], backlog: 0, ...p });

describe("dual-bandwidth pure core", () => {
  test("idle (no events, no backlog) ⇒ green, ratio/tDrain conventions", () => {
    const r = run({});
    expect(r.bProd1h).toBe(0);
    expect(r.bCons1h).toBe(0);
    expect(r.ratio).toBeNull(); // bCons1h === 0 ⇒ ratio undefined
    expect(r.tDrainHours).toBe(0); // backlog 0 ⇒ nothing to drain
    expect(r.dBacklogDtPerHour).toBe(0);
    expect(r.zone).toBe("green");
  });

  test("balanced (r = 1.0 > amber) ⇒ amber; counts are per-hour over the 1h window", () => {
    const r = run({ produceAtSec: inLastHour(10), consumeAtSec: inLastHour(10) });
    expect(r.bProd1h).toBe(10);
    expect(r.bCons1h).toBe(10);
    expect(r.ratio).toBe(1);
    expect(r.dBacklogDtPerHour).toBe(0);
    expect(r.zone).toBe("amber"); // 1.0 is in (0.8, 1.2]
  });

  test("comfortably under consume (r = 0.5 ≤ 0.8), no backlog ⇒ green", () => {
    const r = run({ produceAtSec: inLastHour(5), consumeAtSec: inLastHour(10) });
    expect(r.ratio).toBe(0.5);
    expect(r.dBacklogDtPerHour).toBe(-5); // draining faster than producing
    expect(r.zone).toBe("green");
  });

  test("overload (r = 2.0 > 1.2) ⇒ red", () => {
    const r = run({ produceAtSec: inLastHour(20), consumeAtSec: inLastHour(10) });
    expect(r.ratio).toBe(2);
    expect(r.dBacklogDtPerHour).toBe(10); // backlog growing
    expect(r.zone).toBe("red");
  });

  test("producing with ZERO consumption ⇒ red (max imbalance; ratio stays null, never Infinity)", () => {
    const r = run({ produceAtSec: inLastHour(3), consumeAtSec: [] });
    expect(r.bCons1h).toBe(0);
    expect(r.ratio).toBeNull();
    expect(r.zone).toBe("red");
  });

  test("backlog present with ZERO consumption ⇒ red (never drains); tDrain null", () => {
    const r = run({ produceAtSec: [], consumeAtSec: [], backlog: 1 });
    expect(r.tDrainHours).toBeNull();
    expect(r.zone).toBe("red");
  });

  test("backlog over hard cap ⇒ red even when ratio is calm", () => {
    const r = run({ produceAtSec: inLastHour(1), consumeAtSec: inLastHour(10), backlog: 51 });
    expect(r.ratio).toBeCloseTo(0.1, 10);
    expect(r.zone).toBe("red"); // backlog 51 > hard cap 50
  });

  test("backlog at soft cap (calm ratio, not rising) ⇒ amber", () => {
    const r = run({ produceAtSec: inLastHour(2), consumeAtSec: inLastHour(10), backlog: 20 });
    expect(r.dBacklogDtPerHour).toBe(-8); // not rising
    expect(r.zone).toBe("amber"); // backlog 20 >= soft cap 20
  });

  test("ratio 0.9 (just over amber threshold) ⇒ amber", () => {
    const r = run({ produceAtSec: inLastHour(9), consumeAtSec: inLastHour(10) });
    expect(r.ratio).toBeCloseTo(0.9, 10);
    expect(r.zone).toBe("amber");
  });

  test("tDrain over horizon ⇒ red (slow consume, big-ish backlog within caps)", () => {
    // bCons1h = 2/hour, backlog = 30 ⇒ tDrain = 15h > 8h horizon. backlog 30 < hard cap 50, r small.
    const r = run({ produceAtSec: inLastHour(1), consumeAtSec: inLastHour(2), backlog: 30 });
    expect(r.bCons1h).toBe(2);
    expect(r.tDrainHours).toBe(15);
    expect(r.zone).toBe("red");
  });

  test("rolling window: events older than the window are excluded from the rate but still count in totals", () => {
    const old = [NOW - 7200, NOW - 5000]; // outside the 1h window
    const r = run({ produceAtSec: [...old, ...inLastHour(4)], consumeAtSec: inLastHour(8) });
    expect(r.bProd1h).toBe(4); // only the 4 recent ones in the rate
    expect(r.bProdTotal).toBe(6); // all 6 in the cumulative count
    expect(r.bConsTotal).toBe(8);
  });

  test("non-default window normalizes to a per-hour rate", () => {
    // 30-min window: 5 events in the last 30 min ⇒ 10/hour.
    const recent30 = Array.from({ length: 5 }, (_, i) => NOW - (i + 1) * 60);
    const r = run({ produceAtSec: recent30, consumeAtSec: recent30, config: { windowSec: 1800 } });
    expect(r.bProd1h).toBe(10);
    expect(r.bCons1h).toBe(10);
  });

  test("tunable thresholds: a stricter redRatio flips a 1.0 ratio to red", () => {
    const r = run({ produceAtSec: inLastHour(10), consumeAtSec: inLastHour(10), config: { amberRatio: 0.5, redRatio: 0.9 } });
    expect(r.zone).toBe("red");
  });

  test("config validation rejects nonsense loudly", () => {
    expect(() => run({ config: { windowSec: 0 } })).toThrow(/windowSec/);
    expect(() => run({ config: { redRatio: 0.8, amberRatio: 0.8 } })).toThrow(/redRatio/);
    expect(() => run({ config: { backlogHardCap: 5, backlogSoftCap: 10 } })).toThrow(/backlogHardCap/);
    expect(() => run({ config: { tDrainHorizonHours: -1 } })).toThrow(/tDrainHorizon/);
    expect(() => computeDualBandwidth({ nowSec: NOW, produceAtSec: [], consumeAtSec: [], backlog: -1 })).toThrow(/backlog/);
    expect(() => computeDualBandwidth({ nowSec: NaN, produceAtSec: [], consumeAtSec: [], backlog: 0 })).toThrow(/nowSec/);
  });
});
