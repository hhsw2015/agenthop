import { describe, expect, test } from "vitest";
import {
  advance,
  allocExhausted,
  type ControlRecord,
  DEFAULT_LEASE_SEC,
  isCurrentGeneration,
  isTerminal,
  leaseExpired,
  likelyExpired,
  MAX_ALLOC_ATTEMPTS,
  needsRecovery,
  nextAction,
  parseHandoff,
  thresholdsDue,
} from "../src/swarm/control.js";

const T0 = 1_000_000;
function rec(partial: Partial<ControlRecord> = {}): ControlRecord {
  return { launchId: "rw-aaaa", state: "RUNNING", generation: 0, allocStart: T0, budgetSec: 3480, updatedAt: T0, ...partial };
}
function run(start: ControlRecord, steps: Array<[Parameters<typeof advance>[1], number]>): ControlRecord {
  let r = start;
  for (const [event, now] of steps) {
    const res = advance(r, event, now);
    if (!res.ok) throw new Error(`illegal transition at ${event.type}: ${res.error}`);
    r = res.record;
  }
  return r;
}
/** Drain + final-checkpoint(sha,seq) + claim(owner,gen) + allocating(attempt). */
function toAllocating(sha = "c", owner = "disp1", gen = 1, seq = 3): ControlRecord {
  return run(rec(), [
    [{ type: "drain" }, T0 + 1],
    [{ type: "checkpoint", sha, seq }, T0 + 2],
    [{ type: "claim", owner, generation: gen, leaseUntil: T0 + 300 }, T0 + 3],
    [{ type: "allocating", attempt: "att-1" }, T0 + 4],
  ]);
}

describe("happy-path chain", () => {
  test("RUNNING -> ... -> RETIRED with monotonic milestone saves", () => {
    const final = run(rec(), [
      [{ type: "milestone", sha: "aaa1", seq: 1 }, T0 + 60],
      [{ type: "milestone", sha: "aaa2", seq: 2, manifest: "m2" }, T0 + 120],
      [{ type: "drain" }, T0 + 3200],
      [{ type: "checkpoint", sha: "fin0", seq: 3 }, T0 + 3210],
      [{ type: "claim", owner: "disp1", generation: 1, leaseUntil: T0 + 3510 }, T0 + 3215],
      [{ type: "allocating", attempt: "att-1" }, T0 + 3216],
      [{ type: "resumed", successor: "rw-bbbb", sha: "fin0", generation: 1, attempt: "att-1" }, T0 + 3240],
      [{ type: "retire" }, T0 + 3245],
    ]);
    expect(final.state).toBe("RETIRED");
    expect(final.successor).toBe("rw-bbbb");
    expect(final.sha).toBe("fin0");
    expect(final.lastSeq).toBe(3);
    expect(final.attemptCount).toBe(1);
    expect(needsRecovery(final)).toBe(false);
  });

  test("milestone keeps RUNNING and advances only on a higher seq (no rollback)", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "s1", seq: 1, manifest: "man1" }, T0 + 10]]);
    expect(r.state).toBe("RUNNING");
    expect(r.sha).toBe("s1");
    expect(r.lastSeq).toBe(1);
    // A replayed/older milestone seq is rejected -> sha cannot roll back.
    expect(advance(r, { type: "milestone", sha: "OLD", seq: 1 }, T0 + 11).ok).toBe(false);
    expect(advance(r, { type: "milestone", sha: "OLDER", seq: 0 }, T0 + 11).ok).toBe(false);
    const r2 = advance(r, { type: "milestone", sha: "s2", seq: 2 }, T0 + 12);
    expect(r2.ok && r2.record.sha === "s2").toBe(true);
  });

  test("DONE requires a higher seq and is terminal", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "s1", seq: 1 }, T0 + 1], [{ type: "done", sha: "final", seq: 2 }, T0 + 2]]);
    expect(r.state).toBe("DONE");
    expect(needsRecovery(r)).toBe(false);
    expect(advance(r, { type: "milestone", sha: "x", seq: 3 }, T0 + 3).ok).toBe(false);
  });
});

describe("illegal / stale transitions rejected", () => {
  test("cannot checkpoint without draining", () => {
    expect(advance(rec(), { type: "checkpoint", sha: "x", seq: 1 }, T0 + 1).ok).toBe(false);
  });
  test("cannot allocate before claiming", () => {
    const r = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c", seq: 1 }, T0 + 2]]);
    expect(advance(r, { type: "allocating", attempt: "a" }, T0 + 3).ok).toBe(false);
  });
  test("cannot retire before successor resumed", () => {
    expect(advance(toAllocating(), { type: "retire" }, T0 + 5).ok).toBe(false);
  });
  test("resumed rejected on stale generation, stale attempt, OR wrong sha", () => {
    const r = toAllocating("fin0", "disp1", 1, 3); // record.sha = fin0, attempt att-1, gen 1
    expect(advance(r, { type: "resumed", successor: "x", sha: "fin0", generation: 0, attempt: "att-1" }, T0 + 10).ok).toBe(false);
    expect(advance(r, { type: "resumed", successor: "x", sha: "fin0", generation: 1, attempt: "GHOST" }, T0 + 10).ok).toBe(false);
    expect(advance(r, { type: "resumed", successor: "x", sha: "WRONG", generation: 1, attempt: "att-1" }, T0 + 10).ok).toBe(false);
    expect(advance(r, { type: "resumed", successor: "x", sha: "fin0", generation: 1, attempt: "att-1" }, T0 + 10).ok).toBe(true);
  });
});

describe("expire branch: VM-terminal, task recoverable", () => {
  test("expire preserves last confirmed sha and still needs recovery", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "saved7", seq: 1 }, T0 + 60]]);
    const e = advance(r, { type: "expire" }, T0 + 1800);
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.record.state).toBe("EXPIRED");
      expect(e.record.lastConfirmedSha).toBe("saved7");
      expect(needsRecovery(e.record)).toBe(true);
    }
  });
});

describe("crash timelines", () => {
  test("claim owner crashes pre-allocate -> lease expires -> reclaim (uncapped), then allocate", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c", seq: 1 }, T0 + 2],
      [{ type: "claim", owner: "disp-dead", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    // Reclaim is NOT cap-gated (takes an already-counted reservation) — allowed even at cap.
    expect(nextAction(claimed, T0 + 400, { self: "n", cap: 3, liveCount: 3 })).toBe("reclaim");
    const taken = advance(claimed, { type: "reclaim", owner: "n", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(taken.record.attempt).toBeUndefined();
      expect(nextAction(taken.record, T0 + 401, { self: "n", cap: 3, liveCount: 3 })).toBe("allocate");
    }
  });

  test("owner crashes mid-allocate -> reclaim RETAINS attempt -> reconcile required, then reconcile_dead -> allocate", () => {
    const allocating = toAllocating("c", "disp-dead", 1, 1);
    const unknown = advance(allocating, { type: "alloc_unknown" }, T0 + 5);
    const r = unknown.ok ? unknown.record : allocating;
    expect(nextAction(r, T0 + 400, { self: "n", cap: 3, liveCount: 1 })).toBe("reclaim");
    const taken = advance(r, { type: "reclaim", owner: "n", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(taken.record.attempt).toBe("att-1"); // RETAINED
      expect(nextAction(taken.record, T0 + 401, { self: "n", cap: 3, liveCount: 1 })).toBe("reconcile");
      // allocating is BLOCKED while an in-flight attempt is unreconciled
      expect(advance(taken.record, { type: "allocating", attempt: "att-2" }, T0 + 402).ok).toBe(false);
      // reconcile finds the box dead -> clears attempt -> allocate is now the action
      const dead = advance(taken.record, { type: "reconcile_dead" }, T0 + 403);
      expect(dead.ok).toBe(true);
      if (dead.ok) {
        expect(dead.record.attempt).toBeUndefined();
        expect(nextAction(dead.record, T0 + 404, { self: "n", cap: 3, liveCount: 1 })).toBe("allocate");
      }
    }
  });

  test("reconcile finds the box ALIVE -> adopt as successor (sha-checked) -> RESUMED", () => {
    const allocating = toAllocating("fin9", "n", 1, 1);
    const unknown = advance(allocating, { type: "alloc_unknown" }, T0 + 5);
    const taken = advance(unknown.ok ? unknown.record : allocating, { type: "reclaim", owner: "n", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(advance(taken.record, { type: "reconcile_alive", successor: "rw-live", sha: "WRONG" }, T0 + 401).ok).toBe(false);
      const alive = advance(taken.record, { type: "reconcile_alive", successor: "rw-live", sha: "fin9" }, T0 + 402);
      expect(alive.ok && alive.record.state === "RESUMED" && alive.record.successor === "rw-live").toBe(true);
    }
  });

  test("reclaim rejected while lease valid (no double-owner)", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c", seq: 1 }, T0 + 2],
      [{ type: "claim", owner: "disp1", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    expect(nextAction(claimed, T0 + 100, { self: "disp2", cap: 3, liveCount: 1 })).toBe("none");
    expect(advance(claimed, { type: "reclaim", owner: "disp2", generation: 2, leaseUntil: T0 + 600 }, T0 + 100).ok).toBe(false);
  });

  test("DRAINING that never checkpoints then EXPIREs is still recovered (no fake handoff)", () => {
    const draining = run(rec(), [[{ type: "milestone", sha: "m9", seq: 1 }, T0 + 50], [{ type: "drain" }, T0 + 3000]]);
    const e = advance(draining, { type: "expire" }, T0 + 3480);
    expect(e.ok && e.record.state === "EXPIRED" && e.record.lastConfirmedSha === "m9").toBe(true);
  });

  test("attempt cap bounds re-allocation: give_up after MAX, no infinite loop", () => {
    let r = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c", seq: 1 }, T0 + 2]]);
    let t = T0 + 3;
    for (let i = 1; i <= MAX_ALLOC_ATTEMPTS; i++) {
      const claim = i === 1
        ? { type: "claim", owner: `d${i}`, generation: i, leaseUntil: t + 300 } as const
        : { type: "reclaim", owner: `d${i}`, generation: i, leaseUntil: t + 300 } as const;
      r = run(r, [[claim, t]]);
      if (i > 1) r = run(r, [[{ type: "reconcile_dead" }, t]]); // clear the retained attempt from the reclaim
      r = run(r, [[{ type: "allocating", attempt: `att-${i}` }, t + 1], [{ type: "alloc_unknown" }, t + 2]]);
      t += 400;
    }
    expect(r.attemptCount).toBe(MAX_ALLOC_ATTEMPTS);
    expect(allocExhausted(r)).toBe(true);
    const reclaimed = advance(r, { type: "reclaim", owner: "dX", generation: 99, leaseUntil: t + 300 }, t);
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) {
      const cleared = advance(reclaimed.record, { type: "reconcile_dead" }, t + 1);
      expect(cleared.ok).toBe(true);
      if (cleared.ok) {
        expect(advance(cleared.record, { type: "allocating", attempt: "att-X" }, t + 2).ok).toBe(false);
        expect(nextAction(cleared.record, t + 3, { self: "dX", cap: 3, liveCount: 1 })).toBe("give_up");
      }
    }
  });
});

describe("cap + retire", () => {
  const checkpointed = () => run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c", seq: 1 }, T0 + 2]]);
  test("fresh claim is cap-gated", () => {
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 2 })).toBe("claim");
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 3 })).toBe("none");
  });
  test("RESUMED -> retire; re-retire rejected (no double slot-decrement)", () => {
    const resumed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c", seq: 1 }, T0 + 2],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
      [{ type: "allocating", attempt: "a" }, T0 + 4],
      [{ type: "resumed", successor: "rw-bbbb", sha: "c", generation: 1, attempt: "a" }, T0 + 20],
    ]);
    expect(nextAction(resumed, T0 + 21, { self: "d", cap: 3, liveCount: 2 })).toBe("retire_predecessor");
    const retired = advance(resumed, { type: "retire" }, T0 + 22);
    expect(retired.ok).toBe(true);
    if (retired.ok) expect(advance(retired.record, { type: "retire" }, T0 + 23).ok).toBe(false);
  });
});

describe("math + parse", () => {
  test("likelyExpired only past deadline + skew", () => {
    const r = rec({ allocStart: T0, budgetSec: 3480 });
    expect(likelyExpired(r, T0 + 3480 + 120, 120)).toBe(false);
    expect(likelyExpired(r, T0 + 3480 + 121, 120)).toBe(true);
  });
  test("isCurrentGeneration fences stale commands", () => {
    expect(isCurrentGeneration(rec({ generation: 5 }), 5)).toBe(true);
    expect(isCurrentGeneration(rec({ generation: 5 }), 4)).toBe(false);
  });
  test("leaseExpired / thresholds / constants", () => {
    expect(leaseExpired(rec(), T0)).toBe(true);
    expect(leaseExpired(rec({ leaseUntil: T0 + 100 }), T0 + 50)).toBe(false);
    expect(thresholdsDue(300, new Set())).toEqual([300]);
    expect(thresholdsDue(100, new Set())).toEqual([120, 300]);
    expect(DEFAULT_LEASE_SEC).toBeGreaterThan(60);
    expect(MAX_ALLOC_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });
  test("parseHandoff parses repo@branch + sha + gen, tolerates omissions", () => {
    const h = parseHandoff("NEED HANDOFF: goal=x repo=me/w@swarm/rw-a sha=deadbeef12 gen=3");
    expect(h?.repo).toBe("me/w");
    expect(h?.branch).toBe("swarm/rw-a");
    expect(h?.sha).toBe("deadbeef12");
    expect(h?.generation).toBe(3);
    expect(parseHandoff("hi")).toBeNull();
    expect(parseHandoff("NEED HANDOFF: goal=y")?.repo).toBeUndefined();
  });
});
