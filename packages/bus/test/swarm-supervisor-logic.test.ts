import { describe, expect, test } from "vitest";
import { conservativeRemainingSec, pastDeadline, type RemainingInput } from "../src/swarm/supervisor-logic.js";
import { thresholdsDue } from "../src/swarm/control.js";

const W0 = 1_000_000; // wall epoch at injection
function inp(p: Partial<RemainingInput> = {}): RemainingInput {
  // budget 3480s; injected at wall W0 so wallDeadline = W0 + 3480; clocks agree unless overridden.
  return { budgetSec: 3480, monotonicElapsedSec: 0, wallNowSec: W0, wallDeadlineSec: W0 + 3480, ...p };
}

describe("conservative dual-clock deadline", () => {
  test("clocks agree: remaining tracks elapsed", () => {
    expect(conservativeRemainingSec(inp({ monotonicElapsedSec: 480, wallNowSec: W0 + 480 }))).toBe(3000);
    expect(pastDeadline(inp({ monotonicElapsedSec: 480, wallNowSec: W0 + 480 }))).toBe(false);
  });

  test("VM suspended: monotonic stalls but WALL advances past the deadline -> caught", () => {
    // 3600s of real time passed (wall), but the monotonic clock only counted 1200s (suspended ~2400s).
    const i = inp({ monotonicElapsedSec: 1200, wallNowSec: W0 + 3600 });
    expect(conservativeRemainingSec(i)).toBe(-120); // wall says -120, monotonic says +2280 -> min = -120
    expect(pastDeadline(i)).toBe(true); // we do NOT wrongly believe 2280s remain
  });

  test("wall clock rolled BACKWARD: monotonic catches the true elapsed", () => {
    // Someone set the wall clock back an hour; wall would claim lots of time left, but monotonic advanced normally.
    const i = inp({ monotonicElapsedSec: 3480, wallNowSec: W0 - 3600 });
    expect(conservativeRemainingSec(i)).toBe(0); // monotonic says 0, wall says +7080 -> min = 0
    expect(pastDeadline(i)).toBe(true); // a backward wall step cannot extend the box's life
  });

  test("forward wall jump fires early (safe), never late", () => {
    const i = inp({ monotonicElapsedSec: 100, wallNowSec: W0 + 3600 });
    expect(pastDeadline(i)).toBe(true);
  });

  test("exactly at deadline is past-due (fire, don't gamble on the boundary)", () => {
    expect(pastDeadline(inp({ monotonicElapsedSec: 3480, wallNowSec: W0 + 3480 }))).toBe(true);
  });
});

describe("threshold firing drives off the conservative remaining", () => {
  test("T-5 then T-2 fire once each as conservative-remaining crosses them", () => {
    const fired = new Set<number>();
    // 5m1s left: nothing yet
    let rem = conservativeRemainingSec(inp({ monotonicElapsedSec: 3480 - 301, wallNowSec: W0 + (3480 - 301) }));
    expect(thresholdsDue(rem, fired)).toEqual([]);
    // 5m left: T-5
    rem = conservativeRemainingSec(inp({ monotonicElapsedSec: 3480 - 300, wallNowSec: W0 + (3480 - 300) }));
    const due1 = thresholdsDue(rem, fired);
    expect(due1).toEqual([300]);
    due1.forEach((t) => fired.add(t));
    // 2m left: T-2 (T-5 already fired)
    rem = conservativeRemainingSec(inp({ monotonicElapsedSec: 3480 - 120, wallNowSec: W0 + (3480 - 120) }));
    expect(thresholdsDue(rem, fired)).toEqual([120]);
  });

  test("a suspend that jumps us straight past both thresholds fires both at once (most-urgent first)", () => {
    const rem = conservativeRemainingSec(inp({ monotonicElapsedSec: 100, wallNowSec: W0 + (3480 - 90) }));
    expect(rem).toBe(90);
    expect(thresholdsDue(rem, new Set())).toEqual([120, 300]);
  });
});
