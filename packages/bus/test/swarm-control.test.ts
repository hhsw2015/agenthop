import { describe, expect, test } from "vitest";
import {
  advance,
  type ControlRecord,
  DEFAULT_LEASE_SEC,
  isTerminal,
  leaseExpired,
  likelyExpired,
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

describe("happy-path chain", () => {
  test("RUNNING -> ... -> RETIRED with milestone saves along the way", () => {
    const final = run(rec(), [
      [{ type: "milestone", sha: "aaa1" }, T0 + 60],
      [{ type: "milestone", sha: "aaa2", manifest: "m2" }, T0 + 120],
      [{ type: "drain" }, T0 + 3200],
      [{ type: "checkpoint", sha: "fin0" }, T0 + 3210],
      [{ type: "claim", owner: "disp1", generation: 1, leaseUntil: T0 + 3510 }, T0 + 3215],
      [{ type: "allocating", attempt: "att-1" }, T0 + 3216],
      [{ type: "resumed", successor: "rw-bbbb", sha: "fin0" }, T0 + 3240],
      [{ type: "retire" }, T0 + 3245],
    ]);
    expect(final.state).toBe("RETIRED");
    expect(final.successor).toBe("rw-bbbb");
    expect(final.sha).toBe("fin0"); // milestones updated sha but final checkpoint is authoritative
    expect(isTerminal(final.state)).toBe(true);
  });

  test("milestone keeps state RUNNING (routine save, not a handoff cue)", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "s1", manifest: "man1" }, T0 + 10]]);
    expect(r.state).toBe("RUNNING");
    expect(r.sha).toBe("s1");
    expect(r.manifest).toBe("man1");
  });

  test("DONE is a terminal branch carrying the final sha", () => {
    const r = run(rec(), [[{ type: "done", sha: "final" }, T0 + 500]]);
    expect(r.state).toBe("DONE");
    expect(r.sha).toBe("final");
    expect(advance(r, { type: "milestone", sha: "x" }, T0 + 600).ok).toBe(false); // terminal accepts nothing
  });
});

describe("illegal transitions are rejected (no silent coercion)", () => {
  test("cannot checkpoint without draining first", () => {
    const res = advance(rec(), { type: "checkpoint", sha: "x" }, T0 + 1);
    expect(res.ok).toBe(false);
  });
  test("cannot allocate before claiming", () => {
    const r = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
    expect(advance(r, { type: "allocating", attempt: "a" }, T0 + 3).ok).toBe(false);
  });
  test("cannot retire before successor resumed", () => {
    const r = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
      [{ type: "allocating", attempt: "a" }, T0 + 4],
    ]);
    expect(advance(r, { type: "retire" }, T0 + 5).ok).toBe(false); // must RESUME first
  });
});

describe("expire branch (box died without clean handoff)", () => {
  test("expire preserves the last confirmed sha for successor allocation", () => {
    const r = run(rec(), [[{ type: "milestone", sha: "saved7" }, T0 + 60]]);
    const e = advance(r, { type: "expire" }, T0 + 1800);
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.record.state).toBe("EXPIRED");
      expect(e.record.lastConfirmedSha).toBe("saved7"); // not lost
    }
  });
  test("a CHECKPOINTED record can still expire if the dispatcher never claimed it", () => {
    const r = run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "fin" }, T0 + 2]]);
    const e = advance(r, { type: "expire" }, T0 + 3);
    expect(e.ok && e.record.state === "EXPIRED" && e.record.lastConfirmedSha === "fin").toBe(true);
  });
});

describe("crash-timeline: dispatcher dies at each stage, another resumes", () => {
  // Codex's requirement: every stage must be resumable from the persisted record by a (possibly different) dispatcher.
  test("claim owner crashes before allocating -> lease expires -> reclaim, not skipped forever", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "disp-dead", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    // A fresh dispatcher at T0+400: lease lapsed, slot free -> reclaim (NOT "none", which would deadlock).
    expect(nextAction(claimed, T0 + 400, { self: "disp-new", cap: 3, liveCount: 1 })).toBe("reclaim");
    const taken = advance(claimed, { type: "reclaim", owner: "disp-new", generation: 2, leaseUntil: T0 + 700 }, T0 + 400);
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(taken.record.owner).toBe("disp-new");
      expect(taken.record.attempt).toBeUndefined(); // stale attempt cleared on takeover
      expect(nextAction(taken.record, T0 + 401, { self: "disp-new", cap: 3, liveCount: 1 })).toBe("allocate");
    }
  });

  test("owner crashes mid-allocate -> reclaim allowed; a stale attempt is reconcilable", () => {
    const allocating = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "disp-dead", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
      [{ type: "allocating", attempt: "att-ghost" }, T0 + 4],
    ]);
    expect(allocating.attempt).toBe("att-ghost"); // recorded, so a successor-check can reconcile it
    expect(nextAction(allocating, T0 + 400, { self: "disp-new", cap: 3, liveCount: 1 })).toBe("reclaim");
    expect(advance(allocating, { type: "reclaim", owner: "disp-new", generation: 2, leaseUntil: T0 + 700 }, T0 + 400).ok).toBe(true);
  });

  test("reclaim is rejected while the lease is still valid (no double-owner)", () => {
    const claimed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "disp1", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
    ]);
    // Valid lease at T0+100: a second dispatcher must NOT take over.
    expect(nextAction(claimed, T0 + 100, { self: "disp2", cap: 3, liveCount: 1 })).toBe("none");
    expect(advance(claimed, { type: "reclaim", owner: "disp2", generation: 2, leaseUntil: T0 + 600 }, T0 + 100).ok).toBe(false);
  });
});

describe("cap enforcement (single counter; claim is the only slot-consuming step)", () => {
  const checkpointed = () =>
    run(rec(), [[{ type: "drain" }, T0 + 1], [{ type: "checkpoint", sha: "c" }, T0 + 2]]);
  test("claim allowed under cap, refused at cap", () => {
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 2 })).toBe("claim");
    expect(nextAction(checkpointed(), T0 + 3, { self: "d", cap: 3, liveCount: 3 })).toBe("none"); // at cap -> wait
  });
  test("expired box also gates successor allocation on the cap", () => {
    const expired = advance(rec({ sha: "s" }), { type: "expire" }, T0 + 9);
    expect(expired.ok).toBe(true);
    if (expired.ok) {
      expect(nextAction(expired.record, T0 + 10, { self: "d", cap: 2, liveCount: 1 })).toBe("claim");
      expect(nextAction(expired.record, T0 + 10, { self: "d", cap: 2, liveCount: 2 })).toBe("none");
    }
  });
  test("RESUMED -> retire predecessor; terminal states need no action", () => {
    const resumed = run(rec(), [
      [{ type: "drain" }, T0 + 1],
      [{ type: "checkpoint", sha: "c" }, T0 + 2],
      [{ type: "claim", owner: "d", generation: 1, leaseUntil: T0 + 300 }, T0 + 3],
      [{ type: "allocating", attempt: "a" }, T0 + 4],
      [{ type: "resumed", successor: "rw-bbbb", sha: "c" }, T0 + 20],
    ]);
    expect(nextAction(resumed, T0 + 21, { self: "d", cap: 3, liveCount: 2 })).toBe("retire_predecessor");
    const retired = advance(resumed, { type: "retire" }, T0 + 22);
    expect(retired.ok && nextAction(retired.record, T0 + 23, { self: "d", cap: 3, liveCount: 1 })).toBe("none");
  });
});

describe("deadline / lease / thresholds math", () => {
  test("likelyExpired only past deadline + skew (never early on a fast dispatcher clock)", () => {
    const r = rec({ allocStart: T0, budgetSec: 3480 });
    expect(likelyExpired(r, T0 + 3480, 120)).toBe(false); // exactly at budget: not yet (within skew)
    expect(likelyExpired(r, T0 + 3480 + 120, 120)).toBe(false); // at the edge
    expect(likelyExpired(r, T0 + 3480 + 121, 120)).toBe(true);
  });
  test("leaseExpired true when unset or past", () => {
    expect(leaseExpired(rec(), T0)).toBe(true); // no lease
    expect(leaseExpired(rec({ leaseUntil: T0 + 100 }), T0 + 50)).toBe(false);
    expect(leaseExpired(rec({ leaseUntil: T0 + 100 }), T0 + 100)).toBe(true);
  });
  test("thresholds fire once each, most-urgent first, respecting alreadyFired", () => {
    expect(thresholdsDue(301, new Set())).toEqual([]); // not yet at T-5
    expect(thresholdsDue(300, new Set())).toEqual([300]); // T-5 crosses
    expect(thresholdsDue(299, new Set([300]))).toEqual([]); // already fired T-5
    expect(thresholdsDue(119, new Set([300]))).toEqual([120]); // T-2 crosses
    expect(thresholdsDue(100, new Set())).toEqual([120, 300]); // late start: both due, most-urgent first
  });
  test("DEFAULT_LEASE_SEC is a sane positive window", () => {
    expect(DEFAULT_LEASE_SEC).toBeGreaterThan(60);
  });
});

describe("handoff parse (structured, not free text)", () => {
  test("parses summary + repo@branch + sha", () => {
    const h = parseHandoff("NEED HANDOFF: goal=build next=tests repo=me/work@swarm/rw-aaaa sha=deadbeef12");
    expect(h).not.toBeNull();
    expect(h!.repo).toBe("me/work");
    expect(h!.branch).toBe("swarm/rw-aaaa");
    expect(h!.sha).toBe("deadbeef12");
    expect(h!.summary).toContain("goal=build");
  });
  test("null when not a handoff; tolerates missing repo/sha", () => {
    expect(parseHandoff("just a normal reply")).toBeNull();
    const h = parseHandoff("NEED HANDOFF: goal=x next=y");
    expect(h).not.toBeNull();
    expect(h!.repo).toBeUndefined();
    expect(h!.sha).toBeUndefined();
  });
});
