import { describe, expect, test } from "vitest";
import { branchFor, handoffStep, type HandoffOps } from "../src/swarm/dispatch-step.js";
import type { ControlRecord } from "../src/swarm/control.js";
import { MAX_ALLOC_ATTEMPTS } from "../src/swarm/control.js";
import type { ObservedTip } from "../src/swarm/acceptance.js";
import type { Manifest, ManifestKind } from "../src/swarm/manifest.js";

const T0 = 1_000_000;
const BUDGET = 3480;
const LEAD = 180;

function tip(sha: string, launchId: string, generation: number, kind: ManifestKind = "milestone", opts: { desc?: boolean; next?: string } = {}): ObservedTip {
  const manifest: Manifest = { schemaVersion: 1, launchId, generation, kind, ...(opts.next ? { next: opts.next } : {}) };
  return { sha, manifest, isDescendantOfAccepted: opts.desc ?? true };
}

function makeOps(over: Partial<HandoffOps> = {}) {
  const state = {
    now: T0,
    tips: new Map<string, ObservedTip | null>(),
    nextLid: "rw-bbbb",
    allocReturn: "ok" as "ok" | "clean-fail" | "unknown",
    resumeReturn: true,
    scrubbed: [] as string[],
    allocCalls: 0,
    resumeCalls: 0,
    notes: [] as string[],
  };
  const ops: HandoffOps = {
    nowSec: () => state.now,
    self: "disp1",
    cap: 3,
    budgetSec: BUDGET,
    handoffLeadSec: LEAD,
    execEnabled: true,
    newLaunchId: () => state.nextLid,
    observeTip: async (branch) => state.tips.get(branch) ?? null,
    allocateSuccessor: async () => { state.allocCalls++; return state.allocReturn; },
    resumeSuccessor: async () => { state.resumeCalls++; return state.resumeReturn; },
    scrubBox: async (lid) => { state.scrubbed.push(lid); },
    notify: (m) => state.notes.push(m),
    persist: () => {},
    log: () => {},
    ...over,
  };
  return { ops, state };
}

function rec(partial: Partial<ControlRecord> = {}): ControlRecord {
  return { launchId: "rw-aaaa", state: "RUNNING", generation: 0, allocStart: T0, budgetSec: BUDGET, updatedAt: T0, ...partial };
}

describe("handoffStep: full near-death handoff timeline (offline)", () => {
  test("drain -> final -> claim -> allocate successor (CAS-then-IO) -> await its milestone -> resumed -> retire", async () => {
    const { ops, state } = makeOps();
    const records = new Map<string, ControlRecord>();
    let a = rec();
    records.set(a.launchId, a);

    state.now = T0 + BUDGET - LEAD;
    state.tips.set(branchFor("rw-aaaa", 0), tip("m1", "rw-aaaa", 0, "milestone"));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("DRAINING");

    state.tips.set(branchFor("rw-aaaa", 0), tip("fin0", "rw-aaaa", 0, "final"));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("CLAIMED");
    expect(a.generation).toBe(1);

    state.now = T0 + BUDGET - LEAD + 1;
    a = await handoffStep(a, records, ops); // allocate: pre-gen LID, allocating first, allocateSuccessor ok, resume
    expect(a.state).toBe("ALLOCATING");
    expect(a.successor).toBe("rw-bbbb");
    expect(a.handoffSha).toBe("fin0");
    expect(a.successorGen).toBe(1);
    expect(state.allocCalls).toBe(1);
    expect(state.resumeCalls).toBe(1);
    expect(records.get("rw-bbbb")?.state).toBe("RUNNING");

    // successor publishes a real worker milestone on swarm/rw-bbbb-g1 (descendant of handoffSha) -> resumed-ACK
    state.now = T0 + BUDGET - LEAD + 2;
    state.tips.set(branchFor("rw-bbbb", 1), tip("b1", "rw-bbbb", 1, "milestone", { desc: true }));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("RESUMED");

    state.now = T0 + BUDGET - LEAD + 3;
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("RETIRED");
    expect(state.scrubbed).toEqual(["rw-aaaa"]);
  });
});

describe("handoffStep: resumed-ACK is a REAL worker publish, not the seed / a rescue / a wrong gen", () => {
  function allocating(over: Partial<ControlRecord> = {}): { a: ControlRecord; records: Map<string, ControlRecord> } {
    const records = new Map<string, ControlRecord>();
    const a = rec({ state: "ALLOCATING", generation: 1, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: 1, attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300, ...over });
    records.set(a.launchId, a);
    records.set("rw-bbbb", { launchId: "rw-bbbb", state: "RUNNING", generation: 1, handoffSha: "fin0", allocStart: T0, budgetSec: BUDGET, updatedAt: T0 });
    return { a, records };
  }
  const run1 = async (t: ObservedTip | null) => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const { a, records } = allocating();
    if (t) state.tips.set(branchFor("rw-bbbb", 1), t);
    return (await handoffStep(a, records, ops)).state;
  };

  test("seed tip (predecessor manifest) -> NOT resumed", async () => {
    expect(await run1(tip("fin0", "rw-pred", 0, "final"))).toBe("ALLOCATING");
  });
  test("wrong publish generation -> NOT resumed", async () => {
    expect(await run1(tip("b1", "rw-bbbb", 2, "milestone"))).toBe("ALLOCATING");
  });
  test("a supervisor rescue (not worker-driven) -> NOT resumed", async () => {
    expect(await run1(tip("b1", "rw-bbbb", 1, "rescue"))).toBe("ALLOCATING");
  });
  test("non-descendant of handoffSha -> NOT resumed", async () => {
    expect(await run1(tip("b1", "rw-bbbb", 1, "milestone", { desc: false }))).toBe("ALLOCATING");
  });
  test("a real worker milestone at the pinned gen, descending -> RESUMED", async () => {
    expect(await run1(tip("b1", "rw-bbbb", 1, "milestone", { desc: true }))).toBe("RESUMED");
  });
});

describe("handoffStep: allocate failure modes (CAS-then-IO + retain)", () => {
  function claimed() {
    const records = new Map<string, ControlRecord>();
    const a = rec({ state: "CLAIMED", generation: 1, sha: "fin0", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    return { a, records };
  }

  test("clean-fail -> alloc_failed -> CLAIMED, attempt cleared, attemptCount kept, no phantom successor record", async () => {
    const { ops, state } = makeOps();
    state.allocReturn = "clean-fail";
    state.now = T0 + 10;
    const { a, records } = claimed();
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("CLAIMED");
    expect(out.attempt).toBeUndefined();
    expect(out.attemptCount).toBe(1); // bounded
    expect(records.has("rw-bbbb")).toBe(false); // no phantom slot for a box that was never created
  });

  test("unknown -> ALLOCATING resultUnknown + successor record created (reserve slot, pin gen)", async () => {
    const { ops, state } = makeOps();
    state.allocReturn = "unknown";
    state.now = T0 + 10;
    const { a, records } = claimed();
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("ALLOCATING");
    expect(out.resultUnknown).toBe(true);
    expect(out.successorGen).toBe(1);
    expect(records.get("rw-bbbb")?.state).toBe("RUNNING");
    expect(state.resumeCalls).toBe(0); // no resume on an unknown allocate
  });

  test("ok but resume unknown -> ALLOCATING resultUnknown", async () => {
    const { ops, state } = makeOps();
    state.resumeReturn = false;
    state.now = T0 + 10;
    const { a, records } = claimed();
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("ALLOCATING");
    expect(out.resultUnknown).toBe(true);
  });
});

describe("handoffStep: reconcile retains unless RELIABLE death; uses the pinned successor gen", () => {
  function reclaimedWithAttempt(succGen: number) {
    // CLAIMED with a retained attempt (post-reclaim): owner gen bumped to 2, successor still publishes at succGen.
    const records = new Map<string, ControlRecord>();
    const a = rec({ state: "CLAIMED", generation: 2, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: succGen, attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    records.set("rw-bbbb", { launchId: "rw-bbbb", state: "RUNNING", generation: succGen, handoffSha: "fin0", allocStart: T0, budgetSec: BUDGET, updatedAt: T0 });
    return { a, records };
  }

  test("successor publishing at its PINNED gen (g1, not the bumped owner g2) -> reconcile_alive -> ALLOCATING", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const { a, records } = reclaimedWithAttempt(1);
    state.tips.set(branchFor("rw-bbbb", 1), tip("b9", "rw-bbbb", 1, "milestone")); // on g1
    const out = await handoffStep(a, records, ops); // nextAction(CLAIMED,own,attempt) -> reconcile
    expect(out.state).toBe("ALLOCATING");
    expect(out.attempt).toBe("att-1");
  });

  test("not published + not expired -> RETAIN attempt (no reconcile_dead on a transient / not-yet-published)", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10; // successor far from its deadline
    const { a, records } = reclaimedWithAttempt(1); // no tip set -> observeTip null
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("CLAIMED");
    expect(out.attempt).toBe("att-1"); // retained, not cleared
  });

  test("not published + successor PHYSICALLY expired -> reconcile_dead -> attempt cleared", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10; // lease (T0+300) still VALID -> reconcile path (not reclaim)
    const { a, records } = reclaimedWithAttempt(1);
    // the successor was allocated long ago and is now well past its own deadline+skew (reliable physical death)
    records.set("rw-bbbb", { ...records.get("rw-bbbb")!, allocStart: T0 - BUDGET - 500 });
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("CLAIMED");
    expect(out.attempt).toBeUndefined(); // reliable death -> cleared
  });
});

describe("handoffStep: cap reservation + gate + give_up", () => {
  test("two checkpointed predecessors can't both claim the last slot (successor reserved at claim)", async () => {
    const { ops, state } = makeOps({ cap: 3 });
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    // 1 extra live box fills the cap to 2; two checkpointed predecessors want to hand off into the 1 free slot.
    records.set("rw-live", rec({ launchId: "rw-live", state: "RUNNING" }));
    const a = rec({ launchId: "rw-aaaa", state: "CHECKPOINTED", sha: "ca" });
    const b = rec({ launchId: "rw-aaab", state: "CHECKPOINTED", sha: "cb" });
    records.set(a.launchId, a); records.set(b.launchId, b);
    // effectiveLive = 3 (rw-live, a, b) -> already at cap -> neither claims
    const oa = await handoffStep(a, records, ops);
    expect(oa.state).toBe("CHECKPOINTED");
    // free a slot: rw-live done
    records.set("rw-live", { ...records.get("rw-live")!, state: "DONE" });
    const oa2 = await handoffStep(records.get("rw-aaaa")!, records, ops); // effectiveLive now 2 -> a claims
    expect(oa2.state).toBe("CLAIMED");
    // now a is CLAIMED (reserves its successor) -> b sees effectiveLive 3 -> cannot claim
    const ob = await handoffStep(records.get("rw-aaab")!, records, ops);
    expect(ob.state).toBe("CHECKPOINTED");
  });

  test("execEnabled=false: observe + clock run, but no handoff action executes", async () => {
    const { ops, state } = makeOps({ execEnabled: false });
    state.now = T0 + BUDGET - LEAD;
    const records = new Map<string, ControlRecord>();
    let a = rec();
    records.set(a.launchId, a);
    state.tips.set(branchFor("rw-aaaa", 0), tip("m1", "rw-aaaa", 0, "milestone"));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("DRAINING");
    state.tips.set(branchFor("rw-aaaa", 0), tip("fin0", "rw-aaaa", 0, "final"));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("CHECKPOINTED"); // would claim, but gated
    expect(state.allocCalls).toBe(0);
  });

  test("give_up: attempt cap exhausted -> notified, no allocate", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ state: "CLAIMED", generation: 5, sha: "fin0", owner: "disp1", leaseUntil: T0 + 300, attemptCount: MAX_ALLOC_ATTEMPTS });
    records.set(a.launchId, a);
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("CLAIMED");
    expect(state.allocCalls).toBe(0);
    expect(state.notes.some((n) => /exhausted/.test(n))).toBe(true);
  });
});
