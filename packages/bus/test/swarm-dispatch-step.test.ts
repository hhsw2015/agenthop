import { describe, expect, test } from "vitest";
import { branchFor, handoffStep, type HandoffOps } from "../src/swarm/dispatch-step.js";
import type { ControlRecord } from "../src/swarm/control.js";
import { MAX_ALLOC_ATTEMPTS } from "../src/swarm/control.js";
import type { ObservedTip } from "../src/swarm/acceptance.js";
import type { Manifest, ManifestKind } from "../src/swarm/manifest.js";

const T0 = 1_000_000;
const BUDGET = 3480;
const LEAD = 180;

function tip(sha: string, launchId: string, generation: number, kind: ManifestKind, opts: { desc?: boolean; next?: string } = {}): ObservedTip {
  const manifest: Manifest = { schemaVersion: 1, launchId, generation, kind, ...(opts.next ? { next: opts.next } : {}) };
  return { sha, manifest, isDescendantOfAccepted: opts.desc ?? true };
}

function makeOps(over: Partial<HandoffOps> = {}) {
  const state = {
    now: T0,
    tips: new Map<string, ObservedTip | null>(),
    allocReturn: "rw-bbbb" as string | null,
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
  test("drain -> final checkpoint -> claim -> allocate successor -> await first publish -> resumed -> retire", async () => {
    const { ops, state } = makeOps();
    const records = new Map<string, ControlRecord>();
    let a = rec();
    records.set(a.launchId, a);

    // Pass 1: near deadline. Observe a milestone on A's branch, then drain.
    state.now = T0 + BUDGET - LEAD; // == deadline - lead
    state.tips.set(branchFor("rw-aaaa", 0), tip("m1", "rw-aaaa", 0, "milestone"));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("DRAINING");
    expect(a.sha).toBe("m1");

    // Pass 2: observe the drained FINAL -> CHECKPOINTED -> claim (cap has room) -> CLAIMED gen1.
    state.tips.set(branchFor("rw-aaaa", 0), tip("fin0", "rw-aaaa", 0, "final", { desc: true }));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("CLAIMED");
    expect(a.sha).toBe("fin0");
    expect(a.generation).toBe(1);

    // Pass 3: allocate the successor + run resume IO -> ALLOCATING, successor+handoffSha pinned, successor record born.
    state.now = T0 + BUDGET - LEAD + 1;
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("ALLOCATING");
    expect(a.successor).toBe("rw-bbbb");
    expect(a.handoffSha).toBe("fin0");
    expect(state.allocCalls).toBe(1);
    expect(state.resumeCalls).toBe(1);
    const succ = records.get("rw-bbbb");
    expect(succ?.state).toBe("RUNNING");
    expect(succ?.generation).toBe(1);
    expect(succ?.handoffSha).toBe("fin0");

    // Pass 4: successor publishes its first snapshot (descendant of handoffSha) on swarm/rw-bbbb-g1 -> resumed-ACK.
    state.now = T0 + BUDGET - LEAD + 2;
    state.tips.set(branchFor("rw-bbbb", 1), tip("b1", "rw-bbbb", 1, "milestone", { desc: true }));
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("RESUMED");
    expect(a.successor).toBe("rw-bbbb");

    // Pass 5: retire the predecessor (scrub + RETIRED).
    state.now = T0 + BUDGET - LEAD + 3;
    a = await handoffStep(a, records, ops);
    expect(a.state).toBe("RETIRED");
    expect(state.scrubbed).toEqual(["rw-aaaa"]);

    // The successor, stepped on its own, accepts its branch and runs as the live generation.
    let b = records.get("rw-bbbb")!;
    b = await handoffStep(b, records, ops);
    expect(b.state).toBe("RUNNING");
    expect(b.sha).toBe("b1");
  });
});

describe("handoffStep: crash / failure edges", () => {
  function claimed(): { a: ControlRecord; records: Map<string, ControlRecord> } {
    const records = new Map<string, ControlRecord>();
    const a = rec({ state: "CLAIMED", generation: 1, sha: "fin0", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    return { a, records };
  }

  test("successor allocation fails -> stays CLAIMED, notified, no successor record, retried next pass", async () => {
    const { ops, state } = makeOps({});
    state.allocReturn = null;
    state.now = T0 + 10;
    const { a, records } = claimed();
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("CLAIMED");
    expect(records.has("rw-bbbb")).toBe(false);
    expect(state.notes.some((n) => /allocation failed/.test(n))).toBe(true);
  });

  test("resume IO result unknown -> ALLOCATING marked resultUnknown (reconciled, not blind-retried)", async () => {
    const { ops, state } = makeOps({});
    state.resumeReturn = false;
    state.now = T0 + 10;
    const { a, records } = claimed();
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("ALLOCATING");
    expect(out.resultUnknown).toBe(true);
    expect(out.successor).toBe("rw-bbbb");
  });

  test("await_resume with no successor publish yet -> stays ALLOCATING (waits)", async () => {
    const { ops, state } = makeOps({});
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ state: "ALLOCATING", generation: 1, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    // no tip for swarm/rw-bbbb-g1
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("ALLOCATING");
  });

  test("reconcile a reclaimed in-flight attempt: branch dead -> reconcile_dead clears attempt; alive -> back to ALLOCATING", async () => {
    // dead: successor branch has no tip -> reconcile_dead -> CLAIMED with attempt cleared
    {
      const { ops, state } = makeOps({});
      state.now = T0 + 10;
      const records = new Map<string, ControlRecord>();
      const a = rec({ state: "CLAIMED", generation: 2, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
      records.set(a.launchId, a);
      const out = await handoffStep(a, records, ops); // nextAction(CLAIMED,own,attempt) -> reconcile
      expect(out.state).toBe("CLAIMED");
      expect(out.attempt).toBeUndefined();
    }
    // alive: successor branch has a descendant tip -> reconcile_alive -> ALLOCATING (same attempt)
    {
      const { ops, state } = makeOps({});
      state.now = T0 + 10;
      const records = new Map<string, ControlRecord>();
      const a = rec({ state: "CLAIMED", generation: 2, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
      records.set(a.launchId, a);
      state.tips.set(branchFor("rw-bbbb", 2), tip("b9", "rw-bbbb", 2, "milestone", { desc: true }));
      const out = await handoffStep(a, records, ops);
      expect(out.state).toBe("ALLOCATING");
      expect(out.attempt).toBe("att-1");
    }
  });

  test("give_up: attempt cap exhausted -> notified, no allocate", async () => {
    const { ops, state } = makeOps({});
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
