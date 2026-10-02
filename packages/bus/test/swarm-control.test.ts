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
/** Drive a record through a sequence of events, asserting each is legal; return the final record. */
function run(start: ControlRecord, steps: Array<[Parameters<typeof advance>[1], number]>): ControlRecord {
  let r = start;
  for (const [event, now] of steps) {
    const res = advance(r, event, now);
    if (!res.ok) throw new Error(`illegal transition at ${event.type}: ${res.error}`);
    r = res.record;
  }
  return r;
}
/** The canonical path up to a CLAIMED-by-`owner` / ALLOCATING state, for reuse across cases. */
function toAllocating(owner = "disp1", gen = 1): ControlRecord {
  return run(rec(), [
    [{ type: "drain" }, T0 + 1],
    [{ type: "checkpoint", sha: "c" }, T0 + 2],
    [{ type: "claim", owner, generation: gen, leaseUntil: T0 + 300 }, T0 + 3],
    [{ type: "allocating", attempt: "att-1" }, T0 + 4],
  ]);
}

describe("happy-path chain", () => {
  test("RUNNING -> ... -> RETIRED with milestone saves along the way", () => {
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
    expect(isTerminal(final.state)).toBe(true);
    expect(needsRecovery(final)).toBe(false);
  });

  test("milestone keeps state RUNNING (routine save, not a handoff cue)", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "s1", manifest: "man1" }, T0 + 10]]);
    expect(r.state).toBe("RUNNING");
    expect(r.sha).toBe("s1");
    expect(r.manifest).toBe("man1");
  });

  test("DONE is terminal and needs no recovery", () => {
    const r = run(rec(), [[{ type: "done", sha: "final" }, T0 + 500]]);
    expect(r.state).toBe("DONE");
    expect(needsRecovery(r)).toBe(false);
    expect(advance(r, { type: "milestone", sha: "x" }, T0 + 600).ok).toBe(false);
  });
});

describe("illegal / stale transitions are rejected (no silent coercion, no rollback)", () => {
  test("cannot checkpoint without draining first", () => {
    expect(advance(rec(), { type: "checkpoint", sha: "x" }, T0 + 1).ok).toBe(false);
  });
  test("cannot allocate before claiming", () => {
    const r = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
    expect(advance(r, { type: "allocating", attempt: "a" }, T0 + 3).ok).toBe(false);
  });
  test("cannot retire before successor resumed", () => {
    const r = toAllocating();
    expect(advance(r, { type: "retire" }, T0 + 5).ok).toBe(false);
  });
  test("resumed with a stale generation is rejected (successor superseded)", () => {
    const r = toAllocating("disp1", 1);
    const stale = advance(r, { type: "resumed", successor: "rw-x", sha: "c", generation: 0, attempt: "att-1" }, T0 + 10);
    expect(stale.ok).toBe(false);
  });
  test("resumed with a stale attempt is rejected (a previous allocation's successor)", () => {
    const r = toAllocating("disp1", 1);
    const stale = advance(r, { type: "resumed", successor: "rw-x", sha: "c", generation: 1, attempt: "att-GHOST" }, T0 + 10);
    expect(stale.ok).toBe(false);
  });
});

describe("expire branch: VM-terminal but task stays recoverable", () => {
  test("expire preserves the last confirmed sha and still needs recovery", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "saved7" }, T0 + 60]]);
    const e = advance(r, { type: "expire" }, T0 + 1800);
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.record.state).toBe("EXPIRED");
      expect(e.record.lastConfirmedSha).toBe("saved7");
      expect(needsRecovery(e.record)).toBe(true); // Codex: EXPIRED && workPending stays in the scan
      expect(isTerminal(e.record.state)).toBe(false);
    }
  });
  test("a dispatcher that comes up later can still claim an EXPIRED record's successor", () => {
    const expired = advance(rec({ sha: "s" }), { type: "expire" }, T0 + 9);
    expect(expired.ok).toBe(true);
    if (expired.ok) {
      expect(nextAction(expired.record, T0 + 10, { self: "d", cap: 3, liveCount: 1 })).toBe("claim");
      const claimed = advance(expired.record, { type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 310 }, T0 + 10);
      expect(claimed.ok).toBe(true);
    }
  });
});

describe("crash timelines (Codex pass-2 section 7)", () => {
  test("claim owner crashes before allocating -> lease expires -> reclaim, not a deadlock", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "disp-dead", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    expect(nextAction(claimed, T0 + 400, { self: "disp-new", cap: 3, liveCount: 1 })).toBe("reclaim");
    const taken = advance(claimed, { type: "reclaim", owner: "disp-new", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(taken.record.owner).toBe("disp-new");
      expect(taken.record.attempt).toBeUndefined(); // no allocation had happened, so nothing to reconcile
      expect(nextAction(taken.record, T0 + 401, { self: "disp-new", cap: 3, liveCount: 1 })).toBe("allocate");
    }
  });

  test("owner crashes MID-allocate -> reclaim RETAINS the attempt -> next action is reconcile, not a blind re-alloc", () => {
    const allocating = toAllocating("disp-dead", 1); // attempt=att-1, attemptCount=1
    const unknown = advance(allocating, { type: "alloc_unknown" }, T0 + 5);
    expect(unknown.ok && unknown.record.resultUnknown).toBe(true);
    const r = unknown.ok ? unknown.record : allocating;
    expect(nextAction(r, T0 + 400, { self: "disp-new", cap: 3, liveCount: 1 })).toBe("reclaim");
    const taken = advance(r, { type: "reclaim", owner: "disp-new", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(taken.record.attempt).toBe("att-1"); // RETAINED, not wiped (Codex: don't free an unknown reservation)
      expect(taken.record.attemptCount).toBe(1);
      expect(taken.record.resultUnknown).toBe(true);
      // Because an in-flight attempt is carried over, the dispatcher must RECONCILE before any new allocate.
      expect(nextAction(taken.record, T0 + 401, { self: "disp-new", cap: 3, liveCount: 1 })).toBe("reconcile");
    }
  });

  test("reclaim is rejected while the lease is still valid (no double-owner)", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "disp1", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    expect(nextAction(claimed, T0 + 100, { self: "disp2", cap: 3, liveCount: 1 })).toBe("none");
    expect(advance(claimed, { type: "reclaim", owner: "disp2", generation: 2, leaseUntil: T0 + 600 }, T0 + 100).ok).toBe(false);
  });

  test("DRAINING that never checkpoints then EXPIREs is still recovered from lastConfirmedSha (no fake handoff)", () => {
    const draining = run(rec(), [[{ type: "milestone", sha: "m9" }, T0 + 50], [{ type: "drain" }, T0 + 3000]]);
    // No final checkpoint arrives; the VM dies.
    const e = advance(draining, { type: "expire" }, T0 + 3480);
    expect(e.ok && e.record.state === "EXPIRED" && e.record.lastConfirmedSha === "m9").toBe(true);
    if (e.ok) expect(needsRecovery(e.record)).toBe(true);
  });

  test("attempt cap bounds re-allocation: after MAX attempts, give_up instead of looping", () => {
    // Simulate three failed allocate cycles (each: allocating -> alloc_unknown -> lease lapse -> reclaim).
    let r = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
    let owner = "d0";
    let t = T0 + 3;
    for (let i = 1; i <= MAX_ALLOC_ATTEMPTS; i++) {
      r = run(r, [[{ type: i === 1 ? "claim" : "reclaim", owner, generation: i, leaseUntil: t + 300 } as any, t]]);
      r = run(r, [[{ type: "allocating", attempt: `att-${i}` }, t + 1], [{ type: "alloc_unknown" }, t + 2]]);
      owner = `d${i}`;
      t += 400; // lease lapses before the next reclaim
    }
    expect(r.attemptCount).toBe(MAX_ALLOC_ATTEMPTS);
    expect(allocExhausted(r)).toBe(true);
    // A 4th allocating is refused by advance...
    const reclaimed = advance(r, { type: "reclaim", owner: "dX", generation: 99, leaseUntil: t + 300 }, t);
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) {
      expect(advance(reclaimed.record, { type: "allocating", attempt: "att-4" }, t + 1).ok).toBe(false);
      // ...and nextAction says give_up (dispatcher should alert + park), not spin.
      const parked = { ...reclaimed.record, attempt: undefined }; // reconcile determined the ghost attempt is dead
      expect(nextAction(parked, t + 2, { self: "dX", cap: 3, liveCount: 1 })).toBe("give_up");
    }
  });
});

describe("cap enforcement (single counter; claim/reclaim is the only slot-consuming step)", () => {
  const checkpointed = () => run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
  test("claim allowed under cap, refused at cap", () => {
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 2 })).toBe("claim");
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 3 })).toBe("none");
  });
  test("RESUMED -> retire predecessor; terminal states need no action", () => {
    const resumed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
      [{ type: "allocating", attempt: "a" }, T0 + 4],
      [{ type: "resumed", successor: "rw-bbbb", sha: "c", generation: 1, attempt: "a" }, T0 + 20],
    ]);
    expect(nextAction(resumed, T0 + 21, { self: "d", cap: 3, liveCount: 2 })).toBe("retire_predecessor");
    const retired = advance(resumed, { type: "retire" }, T0 + 22);
    expect(retired.ok && nextAction(retired.record, T0 + 23, { self: "d", cap: 3, liveCount: 1 })).toBe("none");
  });
  test("re-retiring a RETIRED record is rejected (idempotent; no double slot-decrement)", () => {
    const retired = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
      [{ type: "allocating", attempt: "a" }, T0 + 4],
      [{ type: "resumed", successor: "rw-bbbb", sha: "c", generation: 1, attempt: "a" }, T0 + 20],
      [{ type: "retire" }, T0 + 22],
    ]);
    expect(advance(retired, { type: "retire" }, T0 + 23).ok).toBe(false);
  });
});

describe("deadline / lease / generation / thresholds math", () => {
  test("likelyExpired only past deadline + skew; a work-deadline alone is not VM-destroyed", () => {
    const r = rec({ allocStart: T0, budgetSec: 3480 });
    expect(likelyExpired(r, T0 + 3480, 120)).toBe(false);
    expect(likelyExpired(r, T0 + 3480 + 120, 120)).toBe(false);
    expect(likelyExpired(r, T0 + 3480 + 121, 120)).toBe(true);
  });
  test("isCurrentGeneration fences stale commands", () => {
    const r = rec({ generation: 5 });
    expect(isCurrentGeneration(r, 5)).toBe(true);
    expect(isCurrentGeneration(r, 4)).toBe(false);
  });
  test("leaseExpired true when unset or past", () => {
    expect(leaseExpired(rec(), T0)).toBe(true);
    expect(leaseExpired(rec({ leaseUntil: T0 + 100 }), T0 + 50)).toBe(false);
    expect(leaseExpired(rec({ leaseUntil: T0 + 100 }), T0 + 100)).toBe(true);
  });
  test("thresholds fire once each, most-urgent first, respecting alreadyFired", () => {
    expect(thresholdsDue(301, new Set())).toEqual([]);
    expect(thresholdsDue(300, new Set())).toEqual([300]);
    expect(thresholdsDue(299, new Set([300]))).toEqual([]);
    expect(thresholdsDue(119, new Set([300]))).toEqual([120]);
    expect(thresholdsDue(100, new Set())).toEqual([120, 300]);
  });
  test("DEFAULT_LEASE_SEC / MAX_ALLOC_ATTEMPTS are sane", () => {
    expect(DEFAULT_LEASE_SEC).toBeGreaterThan(60);
    expect(MAX_ALLOC_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });
});

describe("handoff parse (structured, not free text)", () => {
  test("parses summary + repo@branch + sha + gen", () => {
    const h = parseHandoff("NEED HANDOFF: goal=build next=tests repo=me/work@swarm/rw-aaaa sha=deadbeef12 gen=3");
    expect(h).not.toBeNull();
    expect(h!.repo).toBe("me/work");
    expect(h!.branch).toBe("swarm/rw-aaaa");
    expect(h!.sha).toBe("deadbeef12");
    expect(h!.generation).toBe(3);
  });
  test("null when not a handoff; tolerates missing repo/sha/gen", () => {
    expect(parseHandoff("just a normal reply")).toBeNull();
    const h = parseHandoff("NEED HANDOFF: goal=x next=y");
    expect(h).not.toBeNull();
    expect(h!.repo).toBeUndefined();
    expect(h!.sha).toBeUndefined();
    expect(h!.generation).toBeUndefined();
  });
});
