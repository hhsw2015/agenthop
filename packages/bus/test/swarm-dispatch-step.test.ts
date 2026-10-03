import { describe, expect, test } from "vitest";
import { branchFor, effectiveLive, handoffStep, type HandoffOps } from "../src/swarm/dispatch-step.js";
import type { ControlRecord } from "../src/swarm/control.js";
import { MAX_ALLOC_ATTEMPTS, PROVIDER_LIFETIME_SEC } from "../src/swarm/control.js";
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
    scrubReturn: false, // scrub is best-effort; true only when it RELIABLY terminated the VM
    scrubbed: [] as string[],
    removed: [] as string[],
    allocCalls: 0,
    resumeCalls: 0,
    notes: [] as string[],
  };
  const ops: HandoffOps = {
    nowSec: () => state.now,
    self: "disp1",
    cap: 3,
    budgetSec: BUDGET,
    physicalLifetimeSec: PROVIDER_LIFETIME_SEC,
    handoffLeadSec: LEAD,
    execEnabled: true,
    newLaunchId: () => state.nextLid,
    observeTip: async (branch) => state.tips.get(branch) ?? null,
    allocateSuccessor: async () => { state.allocCalls++; return state.allocReturn; },
    resumeSuccessor: async () => { state.resumeCalls++; return state.resumeReturn; },
    scrubBox: async (lid) => { state.scrubbed.push(lid); return state.scrubReturn; },
    notify: (m) => state.notes.push(m),
    persist: () => {},
    removeRecord: (lid) => { state.removed.push(lid); },
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

  test("a historical RESCUE tip does NOT mask the deadline; past deadline + only-rescue -> dead + successor removed (P2-1/P2-2)", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const { a, records } = reclaimedWithAttempt(1);
    records.set("rw-bbbb", { ...records.get("rw-bbbb")!, allocStart: T0 - BUDGET - 500 }); // physically expired
    state.tips.set(branchFor("rw-bbbb", 1), tip("r1", "rw-bbbb", 1, "rescue")); // only a supervisor rescue tip
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("CLAIMED");
    expect(out.attempt).toBeUndefined();        // not trapped alive-by-rescue -> declared dead
    expect(out.successor).toBeUndefined();       // dangling successor link cleared (P2-2)
    expect(state.removed).toContain("rw-bbbb");  // dead successor record removed from the mirror
    expect(records.has("rw-bbbb")).toBe(false);
  });

  test("unknown allocation whose successor RECORD was lost still terminates via parent attemptStartSec (P1-1)", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    // CLAIMED with a retained attempt but NO successor record (crash between pinning + placeholder persist); the attempt
    // was requested long ago, so its pinned attemptStartSec is already past the deadline.
    const a = rec({ state: "CLAIMED", generation: 2, sha: "fin0", handoffSha: "fin0", successor: "rw-ghost", successorGen: 1, attempt: "att-1", attemptStartSec: T0 - BUDGET - 500, owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("CLAIMED");
    expect(out.attempt).toBeUndefined(); // terminated via parent attemptStartSec, not inconclusive forever
  });
});

describe("effectiveLive: physical-slot occupancy, not task state (Codex P1-1/P1-2)", () => {
  test("RETIRED box still occupies until reliable termination; DONE/past-deadline frees", () => {
    const recs = new Map<string, ControlRecord>();
    recs.set("a", rec({ launchId: "a", state: "RETIRED", allocStart: T0 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(1); // RETIRED but VM may still be alive -> occupies (P1-2)
    recs.set("a", { ...recs.get("a")!, reliablyTerminated: true });
    expect(effectiveLive(recs, T0 + 10)).toBe(0); // scrub confirmed termination -> freed
    recs.set("a", rec({ launchId: "a", state: "DONE", allocStart: T0 - BUDGET - 500 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(0); // DONE + past physical deadline -> freed
  });

  test("EXPIRED frees the slot (VM believed gone) even though the task still needs recovery", () => {
    const recs = new Map<string, ControlRecord>();
    recs.set("a", rec({ launchId: "a", state: "EXPIRED", allocStart: T0 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(0);
  });

  test("ALLOCATING with a pinned successor but no successor record reserves a slot; no double-count once the record exists (P1-1)", () => {
    const recs = new Map<string, ControlRecord>();
    recs.set("p", rec({ launchId: "p", state: "ALLOCATING", successor: "ghost", attemptStartSec: T0, allocStart: T0 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(2); // parent(1) + reservation for the maybe-existing successor VM(1)
    recs.set("ghost", rec({ launchId: "ghost", state: "RUNNING", allocStart: T0 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(2); // parent(1) + successor record(1); reservation no longer added
  });

  test("CLAIMED without a successor reserves the slot it is about to allocate (P1-6)", () => {
    const recs = new Map<string, ControlRecord>();
    recs.set("p", rec({ launchId: "p", state: "CLAIMED", allocStart: T0 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(2); // self + reservation
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
    // free a slot: rw-live's VM is now past its physical deadline. NOTE task-DONE alone does NOT free the slot anymore
    // (Codex P1-2: cap = physical boxes, held until reliable termination / deadline), so we also expire it physically.
    records.set("rw-live", { ...records.get("rw-live")!, state: "DONE", allocStart: T0 - BUDGET - 500 });
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

describe("recovery-protocol re-review fixes (Codex 01ea35b: P1-1/P1-2/P1-3, P2-2, P2-5)", () => {
  test("P1-2: a short work budget does NOT free the physical slot early (physical lifetime governs occupancy)", () => {
    const recs = new Map<string, ControlRecord>();
    // work budget 60s, but the provider VM lives ~PROVIDER_LIFETIME_SEC: past the work budget it must STILL occupy.
    recs.set("a", rec({ launchId: "a", state: "RUNNING", allocStart: T0, budgetSec: 60, physicalLifetimeSec: PROVIDER_LIFETIME_SEC }));
    expect(effectiveLive(recs, T0 + 300)).toBe(1); // 300 > work 60+120, but << physical -> still occupies (P1-2)
    expect(effectiveLive(recs, T0 + PROVIDER_LIFETIME_SEC + 200)).toBe(0); // past physical lifetime + skew -> freed
  });

  test("P1-1: a reclaimed CLAIMED that retained attempt+successor reserves the slot while the successor record is missing", () => {
    const recs = new Map<string, ControlRecord>();
    // post-reclaim: CLAIMED (owner gen bumped), attempt+successor retained, but the successor's own record is lost (crash).
    recs.set("p", rec({ launchId: "p", state: "CLAIMED", allocStart: T0, attempt: "att-1", successor: "ghost", successorGen: 1 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(2); // parent(1) + reservation for the maybe-alive successor VM(1)
    recs.set("ghost", rec({ launchId: "ghost", state: "RUNNING", allocStart: T0 }));
    expect(effectiveLive(recs, T0 + 10)).toBe(2); // the successor record now counts; no double reservation
  });

  test("P2-2: an attempt-cap-exhausted CLAIMED (give_up) reserves NO successor slot", () => {
    const recs = new Map<string, ControlRecord>();
    recs.set("a", rec({ launchId: "a", state: "CLAIMED", allocStart: T0, attemptCount: MAX_ALLOC_ATTEMPTS }));
    expect(effectiveLive(recs, T0 + 10)).toBe(1); // its own box only — no phantom "about to allocate" reservation
  });

  test("P1-3: a dead child's confirmed recovery point is carried onto the parent before the record is removed", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ launchId: "rw-aaaa", state: "CLAIMED", generation: 2, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: 1, attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    // the successor advanced to its OWN confirmed milestone "b5" (anchored earlier from a verified tip), then its VM died
    records.set("rw-bbbb", rec({ launchId: "rw-bbbb", state: "RUNNING", generation: 1, handoffSha: "fin0", sha: "b5", allocStart: T0 - PROVIDER_LIFETIME_SEC - 500 }));
    const out = await handoffStep(a, records, ops); // no tip -> not alive; past physical deadline -> dead
    expect(out.state).toBe("CLAIMED");
    expect(out.attempt).toBeUndefined();        // attempt cleared (declared dead)
    expect(out.sha).toBe("b5");                 // the child's newest confirmed work carried forward, not stale fin0 (P1-3)
    expect(state.removed).toContain("rw-bbbb");
  });

  test("P2-5a: a persist failure on the child anchor leaves the parent ALLOCATING (retryable barrier, no RESUMED)", async () => {
    let throwOnce = true;
    const { ops, state } = makeOps({ persist: (r) => { if (throwOnce && r.launchId === "rw-bbbb") { throwOnce = false; throw new Error("disk full"); } } });
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ launchId: "rw-aaaa", state: "ALLOCATING", generation: 1, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: 1, attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    records.set("rw-bbbb", rec({ launchId: "rw-bbbb", state: "RUNNING", generation: 1, handoffSha: "fin0", allocStart: T0 }));
    state.tips.set(branchFor("rw-bbbb", 1), tip("b1", "rw-bbbb", 1, "milestone", { desc: true }));
    await expect(handoffStep(a, records, ops)).rejects.toThrow("disk full"); // propagates -> pass() catches + retries
    expect(records.get("rw-aaaa")?.state).toBe("ALLOCATING");  // parent NOT retired on a stranded anchor
    expect(records.get("rw-bbbb")?.sha).toBeUndefined();        // Map not updated (persist-first)
  });

  test("P2-5c: a missing child record is rebuilt + anchored before the parent goes RESUMED", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ launchId: "rw-aaaa", state: "ALLOCATING", generation: 1, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: 1, attempt: "att-1", attemptStartSec: T0, owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a); // NO rw-bbbb record (crash lost it)
    state.tips.set(branchFor("rw-bbbb", 1), tip("b1", "rw-bbbb", 1, "milestone", { desc: true }));
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("RESUMED");
    expect(records.get("rw-bbbb")?.sha).toBe("b1");      // rebuilt + anchored at the verified tip (P2-5c)
    expect(records.get("rw-bbbb")?.state).toBe("RUNNING");
  });

  test("P2-5b: a child already at a NON-SEED sha still advances to a newer verified tip (not blocked by 'non-seed')", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ launchId: "rw-aaaa", state: "ALLOCATING", generation: 1, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: 1, attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    records.set("rw-bbbb", rec({ launchId: "rw-bbbb", state: "RUNNING", generation: 1, handoffSha: "fin0", sha: "c3", allocStart: T0 })); // non-seed anchor
    state.tips.set(branchFor("rw-bbbb", 1), tip("c7", "rw-bbbb", 1, "milestone", { desc: true }));
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("RESUMED");
    expect(records.get("rw-bbbb")?.sha).toBe("c7"); // advanced past the non-seed anchor (old code skipped this)
  });
});

describe("recovery re-review round 2 (Codex: P1-01 persist-order, P1-02 lifetime pin, P1-03 gen correction)", () => {
  test("P1-01: reconcile persists the parent's recovery point BEFORE deleting the child (no loss if delete fails)", async () => {
    const { ops, state } = makeOps({ removeRecord: () => { throw new Error("unlink EACCES"); } });
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ launchId: "rw-aaaa", state: "CLAIMED", generation: 2, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: 1, attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    records.set("rw-bbbb", rec({ launchId: "rw-bbbb", state: "RUNNING", generation: 1, handoffSha: "fin0", sha: "b5", allocStart: T0 - PROVIDER_LIFETIME_SEC - 500 })); // confirmed point b5, physically dead
    await expect(handoffStep(a, records, ops)).rejects.toThrow("unlink EACCES"); // delete throws AFTER the parent advanced
    expect(records.get("rw-aaaa")?.sha).toBe("b5");         // parent already carries the recovery point (persisted first)
    expect(records.get("rw-aaaa")?.attempt).toBeUndefined(); // attempt cleared on the parent before the failed delete
  });

  test("P1-02: a normally-allocated successor placeholder gets the attempt's physical lifetime; parent's own is untouched", async () => {
    const { ops, state } = makeOps({ physicalLifetimeSec: 7200 });
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ launchId: "rw-aaaa", state: "CLAIMED", generation: 1, sha: "fin0", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    await handoffStep(a, records, ops); // allocate -> creates the successor placeholder
    expect(records.get("rw-bbbb")?.physicalLifetimeSec).toBe(7200);  // the VM's own lifetime, not the 3600 default (P1-02a)
    expect(records.get("rw-aaaa")?.attemptPhysicalSec).toBe(7200);   // attempt lifetime pinned in its OWN field
    expect(records.get("rw-aaaa")?.physicalLifetimeSec).toBeUndefined(); // parent's own VM lifetime NOT overwritten (P1-02b)
  });

  test("P1-03: a discovery-created gen0 child is corrected to the pinned successorGen on ACK", async () => {
    const { ops, state } = makeOps();
    state.now = T0 + 10;
    const records = new Map<string, ControlRecord>();
    const a = rec({ launchId: "rw-aaaa", state: "ALLOCATING", generation: 1, sha: "fin0", handoffSha: "fin0", successor: "rw-bbbb", successorGen: 1, attempt: "att-1", owner: "disp1", leaseUntil: T0 + 300 });
    records.set(a.launchId, a);
    records.set("rw-bbbb", rec({ launchId: "rw-bbbb", state: "RUNNING", generation: 0, allocStart: T0 })); // discovery recreated it at gen 0
    state.tips.set(branchFor("rw-bbbb", 1), tip("b1", "rw-bbbb", 1, "milestone", { desc: true }));
    const out = await handoffStep(a, records, ops);
    expect(out.state).toBe("RESUMED");
    expect(records.get("rw-bbbb")?.generation).toBe(1); // corrected 0 -> pinned sgen so it observes the right branch (P1-03)
    expect(records.get("rw-bbbb")?.sha).toBe("b1");
  });
});
