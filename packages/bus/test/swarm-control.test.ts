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
/** drain + final-checkpoint(sha) + claim(owner,gen) + allocating(attempt). */
function toAllocating(sha = "c", owner = "disp1", gen = 1): ControlRecord {
  return run(rec(), [
    [{ type: "drain" }, T0 + 1],
    [{ type: "checkpoint", sha }, T0 + 2],
    [{ type: "claim", owner, generation: gen, leaseUntil: T0 + 300 }, T0 + 3],
    [{ type: "allocating", attempt: "att-1" }, T0 + 4],
  ]);
}

describe("happy-path chain", () => {
  test("RUNNING -> milestones -> drain -> checkpoint -> claim -> allocate -> resumed -> RETIRED", () => {
    const final = run(rec(), [
      [{ type: "milestone", sha: "aaa1" }, T0 + 60],
      [{ type: "milestone", sha: "aaa2", manifest: "m2" }, T0 + 120],
      [{ type: "drain" }, T0 + 3200],
      [{ type: "checkpoint", sha: "fin0" }, T0 + 3210],
      [{ type: "claim", owner: "disp1", generation: 1, leaseUntil: T0 + 3510 }, T0 + 3215],
      [{ type: "allocating", attempt: "att-1" }, T0 + 3216],
      [{ type: "resumed", successor: "rw-bbbb", sha: "fin0", generation: 1, attempt: "att-1" }, T0 + 3240],
      [{ type: "retire" }, T0 + 3245],
    ]);
    expect(final.state).toBe("RETIRED");
    expect(final.successor).toBe("rw-bbbb");
    expect(final.sha).toBe("fin0");
    expect(final.attemptCount).toBe(1);
    expect(needsRecovery(final)).toBe(false);
  });

  test("milestone records the confirmed sha (no-rollback is enforced upstream by the dispatcher's ancestry check)", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "s1", manifest: "man1" }, T0 + 10]]);
    expect(r.state).toBe("RUNNING");
    expect(r.sha).toBe("s1");
    expect(r.manifest).toBe("man1");
  });

  test("DONE is terminal", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "s1" }, T0 + 1], [{ type: "done", sha: "final" }, T0 + 2]]);
    expect(r.state).toBe("DONE");
    expect(needsRecovery(r)).toBe(false);
    expect(advance(r, { type: "milestone", sha: "x" }, T0 + 3).ok).toBe(false);
  });
});

describe("illegal transitions rejected", () => {
  test("checkpoint needs drain; allocate needs claim; retire needs resume", () => {
    expect(advance(rec(), { type: "checkpoint", sha: "x" }, T0 + 1).ok).toBe(false);
    const cp = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
    expect(advance(cp, { type: "allocating", attempt: "a" }, T0 + 3).ok).toBe(false);
    expect(advance(toAllocating(), { type: "retire" }, T0 + 5).ok).toBe(false);
  });
  test("resumed rejected on stale generation, stale attempt, OR wrong sha", () => {
    const r = toAllocating("fin0", "disp1", 1);
    expect(advance(r, { type: "resumed", successor: "x", sha: "fin0", generation: 0, attempt: "att-1" }, T0 + 10).ok).toBe(false);
    expect(advance(r, { type: "resumed", successor: "x", sha: "fin0", generation: 1, attempt: "GHOST" }, T0 + 10).ok).toBe(false);
    expect(advance(r, { type: "resumed", successor: "x", sha: "WRONG", generation: 1, attempt: "att-1" }, T0 + 10).ok).toBe(false);
    expect(advance(r, { type: "resumed", successor: "x", sha: "fin0", generation: 1, attempt: "att-1" }, T0 + 10).ok).toBe(true);
  });
});

describe("handoff target pinning (per ATTEMPT, not per claim — Codex #4)", () => {
  test("allocating pins handoffSha to the canonical sha; claim does NOT; resumed verifies against the pin", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "fin0" }, T0 + 2],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    expect(claimed.handoffSha).toBeUndefined(); // claim no longer pins
    const allocating = run(claimed, [[{ type: "allocating", attempt: "a" }, T0 + 4]]);
    expect(allocating.handoffSha).toBe("fin0"); // pinned at allocating
    expect(advance(allocating, { type: "resumed", successor: "x", sha: "OTHER", generation: 1, attempt: "a" }, T0 + 5).ok).toBe(false);
    const done = advance(allocating, { type: "resumed", successor: "x", sha: "fin0", generation: 1, attempt: "a" }, T0 + 5);
    expect(done.ok && done.record.state === "RESUMED" && done.record.successor === "x").toBe(true);
    if (done.ok) expect(done.record.sha).toBe("fin0"); // canonical unchanged by resumed
  });

  test("reconcile_alive keeps the attempt's original pin even after a later recover advanced canonical sha", () => {
    // drain->checkpoint(cp)->claim->allocating(X) pins handoffSha=cp; expire; recover B (sha=B, pin stays cp);
    // a reclaim (SAME generation path not needed — we only assert the pin is preserved, not re-pinned to B).
    let r = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "cp" }, T0 + 2],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
      [{ type: "allocating", attempt: "X" }, T0 + 4],
    ]);
    expect(r.handoffSha).toBe("cp");
    r = run(r, [[{ type: "alloc_unknown" }, T0 + 5], [{ type: "expire" }, T0 + 6], [{ type: "recover_sha", sha: "B" }, T0 + 7]]);
    expect(r.sha).toBe("B"); // canonical advanced
    expect(r.handoffSha).toBe("cp"); // attempt X's pin NOT moved to B
  });
});

describe("expire branch: VM-terminal, task recoverable; sha is the single canonical anchor", () => {
  test("expire keeps the canonical sha and still needs recovery", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "saved7" }, T0 + 60]]);
    const e = advance(r, { type: "expire" }, T0 + 1800);
    expect(e.ok && e.record.state === "EXPIRED" && e.record.sha === "saved7" && needsRecovery(e.record)).toBe(true);
  });

  test("recovery invariant: expire(A) -> recover_sha(B) -> claim -> expire keeps B, never regresses to A (Codex)", () => {
    const r = run(rec(), [
      [{ type: "milestone", sha: "A" }, T0 + 10],
      [{ type: "expire" }, T0 + 20],
      [{ type: "recover_sha", sha: "B" }, T0 + 30],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 330 }, T0 + 40],
      [{ type: "expire" }, T0 + 50], // re-expire from CLAIMED
    ]);
    expect(r.state).toBe("EXPIRED");
    expect(r.sha).toBe("B"); // NOT regressed to A
  });

  test("recover_sha only advances in EXPIRED; rejected elsewhere", () => {
    expect(advance(rec({ sha: "A" }), { type: "recover_sha", sha: "B" }, T0).ok).toBe(false); // RUNNING
  });
});

describe("crash timelines", () => {
  test("claim owner crashes pre-allocate -> reclaim (uncapped) -> allocate", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "disp-dead", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    expect(nextAction(claimed, T0 + 400, { self: "n", cap: 3, liveCount: 3 })).toBe("reclaim"); // not cap-gated
    const taken = advance(claimed, { type: "reclaim", owner: "n", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok && taken.record.attempt === undefined).toBe(true);
    if (taken.ok) expect(nextAction(taken.record, T0 + 401, { self: "n", cap: 3, liveCount: 3 })).toBe("allocate");
  });

  test("owner crashes mid-allocate -> reclaim RETAINS attempt -> reconcile -> dead clears -> allocate", () => {
    const allocating = toAllocating("c", "disp-dead", 1);
    const unknown = advance(allocating, { type: "alloc_unknown" }, T0 + 5);
    const r = unknown.ok ? unknown.record : allocating;
    const taken = advance(r, { type: "reclaim", owner: "n", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok && taken.record.attempt === "att-1").toBe(true);
    if (taken.ok) {
      expect(nextAction(taken.record, T0 + 401, { self: "n", cap: 3, liveCount: 1 })).toBe("reconcile");
      expect(advance(taken.record, { type: "allocating", attempt: "att-2" }, T0 + 402).ok).toBe(false); // blocked until reconciled
      const dead = advance(taken.record, { type: "reconcile_dead" }, T0 + 403);
      expect(dead.ok && dead.record.attempt === undefined).toBe(true);
      if (dead.ok) expect(nextAction(dead.record, T0 + 404, { self: "n", cap: 3, liveCount: 1 })).toBe("allocate");
    }
  });

  test("reconcile finds the box ALIVE -> re-enter await-resume (NOT straight to RESUMED); only a real resumed ACK finishes", () => {
    const allocating = toAllocating("fin9", "n", 1);
    const unknown = advance(allocating, { type: "alloc_unknown" }, T0 + 5);
    const taken = advance(unknown.ok ? unknown.record : allocating, { type: "reclaim", owner: "n", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      const alive = advance(taken.record, { type: "reconcile_alive" }, T0 + 401);
      expect(alive.ok && alive.record.state === "ALLOCATING").toBe(true); // NOT RESUMED
      if (alive.ok) {
        expect(alive.record.attempt).toBe("att-1"); // same attempt reused
        expect(alive.record.attemptCount).toBe(1); // NOT bumped
        // a wrong-sha / wrong-gen resume is still rejected; the correct one (gen 2, att-1, sha fin9) completes it
        expect(advance(alive.record, { type: "resumed", successor: "rw-live", sha: "WRONG", generation: 2, attempt: "att-1" }, T0 + 402).ok).toBe(false);
        const done = advance(alive.record, { type: "resumed", successor: "rw-live", sha: "fin9", generation: 2, attempt: "att-1" }, T0 + 403);
        expect(done.ok && done.record.state === "RESUMED" && done.record.successor === "rw-live").toBe(true);
      }
    }
  });

  test("reclaim rejected while lease valid (no double-owner)", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "disp1", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    expect(nextAction(claimed, T0 + 100, { self: "disp2", cap: 3, liveCount: 1 })).toBe("none");
    expect(advance(claimed, { type: "reclaim", owner: "disp2", generation: 2, leaseUntil: T0 + 600 }, T0 + 100).ok).toBe(false);
  });

  test("DRAINING that never checkpoints then EXPIREs is recovered from the canonical sha", () => {
    const draining = run(rec(), [[{ type: "milestone", sha: "m9" }, T0 + 50], [{ type: "drain" }, T0 + 3000]]);
    const e = advance(draining, { type: "expire" }, T0 + 3480);
    expect(e.ok && e.record.state === "EXPIRED" && e.record.sha === "m9").toBe(true);
  });

  test("attempt cap bounds re-allocation: give_up after MAX", () => {
    let r = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
    let t = T0 + 3;
    for (let i = 1; i <= MAX_ALLOC_ATTEMPTS; i++) {
      const claim = i === 1
        ? { type: "claim", owner: `d${i}`, generation: i, leaseUntil: t + 300 } as const
        : { type: "reclaim", owner: `d${i}`, generation: i, leaseUntil: t + 300 } as const;
      r = run(r, [[claim, t]]);
      if (i > 1) r = run(r, [[{ type: "reconcile_dead" }, t]]);
      r = run(r, [[{ type: "allocating", attempt: `att-${i}` }, t + 1], [{ type: "alloc_unknown" }, t + 2]]);
      t += 400;
    }
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
  const checkpointed = () => run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
  test("fresh claim is cap-gated", () => {
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 2 })).toBe("claim");
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 3 })).toBe("none");
  });
  test("RESUMED -> retire; re-retire rejected (no double slot-decrement)", () => {
    const resumed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
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
  test("isCurrentGeneration / leaseExpired / thresholds / constants", () => {
    expect(isCurrentGeneration(rec({ generation: 5 }), 5)).toBe(true);
    expect(isCurrentGeneration(rec({ generation: 5 }), 4)).toBe(false);
    expect(leaseExpired(rec(), T0)).toBe(true);
    expect(leaseExpired(rec({ leaseUntil: T0 + 100 }), T0 + 50)).toBe(false);
    expect(thresholdsDue(300, new Set())).toEqual([300]);
    expect(thresholdsDue(100, new Set())).toEqual([120, 300]);
    expect(DEFAULT_LEASE_SEC).toBeGreaterThan(60);
    expect(MAX_ALLOC_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(isTerminal("RETIRED")).toBe(true);
  });
  test("parseHandoff parses repo@branch + sha + gen; tolerates omissions", () => {
    const h = parseHandoff("NEED HANDOFF: goal=x repo=me/w@swarm/rw-a sha=deadbeef12 gen=3");
    expect(h?.repo).toBe("me/w");
    expect(h?.branch).toBe("swarm/rw-a");
    expect(h?.sha).toBe("deadbeef12");
    expect(h?.generation).toBe(3);
    expect(parseHandoff("hi")).toBeNull();
    expect(parseHandoff("NEED HANDOFF: goal=y")?.repo).toBeUndefined();
  });
});

describe("at-cap reconciliation of a retained in-flight attempt (Codex P2)", () => {
  test("EXPIRED with an attempt reconciles even at the cap (claim -> CLAIMED keeps attempt -> reconcile)", () => {
    const expired = advance(toAllocating("fin9", "n", 1), { type: "expire" }, T0 + 10);
    expect(expired.ok).toBe(true);
    if (expired.ok) {
      expect(expired.record.attempt).toBe("att-1"); // expire retains the in-flight attempt
      // At the cap a NEW allocation is forbidden, but reconciling the ALREADY-counted attempt must still proceed.
      expect(nextAction(expired.record, T0 + 11, { self: "n", cap: 3, liveCount: 3 })).toBe("claim");
      const claimed = advance(expired.record, { type: "claim", owner: "n", generation: 2, leaseUntil: T0 + 311 }, T0 + 12);
      expect(claimed.ok && claimed.record.attempt === "att-1").toBe(true); // claim from EXPIRED preserves the attempt
      if (claimed.ok) expect(nextAction(claimed.record, T0 + 13, { self: "n", cap: 3, liveCount: 3 })).toBe("reconcile");
    }
  });

  test("EXPIRED WITHOUT an attempt stays cap-gated (a fresh claim IS a new slot)", () => {
    const expired = advance(rec({ sha: "s1" }), { type: "expire" }, T0 + 10);
    expect(expired.ok).toBe(true);
    if (expired.ok) {
      expect(expired.record.attempt).toBeUndefined();
      expect(nextAction(expired.record, T0 + 11, { self: "n", cap: 3, liveCount: 3 })).toBe("none");  // at cap -> wait
      expect(nextAction(expired.record, T0 + 11, { self: "n", cap: 3, liveCount: 2 })).toBe("claim"); // slot free -> claim
    }
  });
});
