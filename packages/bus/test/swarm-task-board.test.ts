import { describe, expect, test } from "vitest";
import {
  boardItemsToPost, planBoardWrites, buildGrantBodies, grantWaitId, planClaimAdmission, postedFileName, claimedFileName, grantedFileName, rejectedFileName, doneFileName,
  parseBoardItemName, isValidItemId, boardAdmitEnabled, type BoardItem, type AdmissionParams,
} from "../src/swarm/task-board.js";
import { commit, entityKeyOf, initialLogState, type ChangeBody, type LogState, type WaitRecord } from "../src/swarm/control-log.js";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import type { ReadyTask } from "../src/swarm/task-ready.js";

// Minimal cast fixtures — boardItemsToPost reads only a few fields per node.
const node = (nodeId: string, over: Record<string, unknown> = {}): unknown => ({
  nodeId, kind: "work", goal: `do ${nodeId}`, dependsOn: [], outputContract: { requiredOutputs: [] }, acceptance: [],
  artifactScope: [`src/${nodeId}`], estimatedRuntimeSec: 60, retryBudget: 1, specDigest: `sd-${nodeId}`, ...over,
});
const plan = (nodes: unknown[], over: Record<string, unknown> = {}): TaskPlan =>
  ({ jobId: "J", planRevision: 3, nodes, jobBudget: {}, planDigest: "pd", ...over } as unknown as TaskPlan);
const ready = (nodeId: string): ReadyTask => ({ nodeId, proposedBindings: [], inputBindingDigest: `ibd-${nodeId}` });

describe("task-board boardItemsToPost (§2d-a curate: ready nodes → board items)", () => {
  test("maps each ready node to a board item carrying spec summary / fit-domain / identity", () => {
    const p = plan([
      node("a", { goal: "build A", dependsOn: ["x"], artifactScope: ["src/a"], sourceWriteScope: ["src/a", "docs"], roleProfile: "builder", modelTier: "heavy" }),
      node("b"),
    ]);
    const items = boardItemsToPost([ready("a"), ready("b")], p, { postedBy: "coord", nowSec: 1000 });
    expect(items.map((i) => i.itemId)).toEqual(["a", "b"]);
    const a = items[0]!;
    expect(a).toMatchObject({
      itemId: "a", jobId: "J", nodeId: "a", planRevision: 3, specDigest: "sd-a", inputBindingDigest: "ibd-a",
      goal: "build A", kind: "work", dependsOn: ["x"], fitProfile: "builder", modelTier: "heavy", postedBy: "coord", postedAtSec: 1000,
    });
    expect(a.fileDomain.sort()).toEqual(["docs", "src/a"]); // artifactScope ∪ sourceWriteScope, deduped
    expect(items[1]!.fitProfile).toBeUndefined(); // no roleProfile ⇒ omitted
    expect(items[1]!.priority).toBeUndefined();   // no TaskSpec source ⇒ absent
  });

  test("a ready node absent from the plan is skipped (guard)", () => {
    expect(boardItemsToPost([ready("ghost")], plan([node("a")]), { postedBy: "c", nowSec: 1 })).toEqual([]);
  });
});

describe("task-board planBoardWrites (§2d-a producer decision: post new ready, reap stale unclaimed)", () => {
  const p = plan([node("a"), node("b"), node("c")]);
  test("posts ready items not already on the board; an already-present item (any state) is skipped (idempotent)", () => {
    expect(planBoardWrites([ready("a"), ready("b")], p, ["b.json"], { postedBy: "c", nowSec: 1 }).post.map((i) => i.itemId)).toEqual(["a"]);
    expect(planBoardWrites([ready("a")], p, ["a.claimed.w.json"], { postedBy: "c", nowSec: 1 }).post).toEqual([]); // claimed ⇒ not re-posted
    expect(planBoardWrites([ready("a")], p, ["a.granted.w.json"], { postedBy: "c", nowSec: 1 }).post).toEqual([]); // granted ⇒ not re-posted
  });
  test("reaps a stale UNCLAIMED posted item whose node is no longer ready; never reaps a claimed/granted item", () => {
    const { post, reap } = planBoardWrites([ready("a")], p, ["a.json", "b.json", "c.claimed.w.json"], { postedBy: "c", nowSec: 1 });
    expect(post).toEqual([]);         // a already posted
    expect(reap).toEqual(["b.json"]); // b posted but not ready ⇒ reap; c is claimed ⇒ kept
  });
  test("an invalid (dotted) itemId is filtered out of post", () => {
    expect(planBoardWrites([ready("a.b")], plan([node("a.b")]), [], { postedBy: "c", nowSec: 1 }).post).toEqual([]);
  });
});

describe("task-board file-name convention + parser (one canonical form, incl. granted/rejected)", () => {
  test("round-trips every state", () => {
    expect(parseBoardItemName(postedFileName("a"))).toEqual({ itemId: "a", state: "posted", who: "" });
    expect(parseBoardItemName(claimedFileName("a", "w1"))).toEqual({ itemId: "a", state: "claimed", who: "w1" });
    expect(parseBoardItemName(grantedFileName("a", "w1"))).toEqual({ itemId: "a", state: "granted", who: "w1" });
    expect(parseBoardItemName(rejectedFileName("a", "w1"))).toEqual({ itemId: "a", state: "rejected", who: "w1" });
    expect(parseBoardItemName(doneFileName("a", "w1"))).toEqual({ itemId: "a", state: "done", who: "w1" });
  });
  test("rejects unknown / malformed shapes rather than mis-splitting", () => {
    expect(parseBoardItemName("a.weird.w1.json")).toBeNull();   // unknown state token
    expect(parseBoardItemName("a.claimed.json")).toBeNull();    // missing who
    expect(parseBoardItemName("a.b.c.d.json")).toBeNull();      // too many segments
    expect(parseBoardItemName("a.txt")).toBeNull();             // not .json
    expect(parseBoardItemName(".json")).toBeNull();             // empty itemId
  });
  test("isValidItemId rejects ids that would break the convention", () => {
    expect(isValidItemId("build-a")).toBe(true);
    expect(isValidItemId("a.b")).toBe(false);  // dot collides with the separator
    expect(isValidItemId("a/b")).toBe(false);
    expect(isValidItemId("a b")).toBe(false);
    expect(isValidItemId("")).toBe(false);
  });
});

describe("task-board buildGrantBodies (§2d-b grant, option B: intent+attempt(+retired)+supervision wait, NO startTask)", () => {
  const prep = {
    intent: { intentId: "i1" } as unknown as import("../src/swarm/control-log.js").DispatchIntent,
    attempt: { attemptId: "at1", nodeId: "a" } as unknown as import("../src/swarm/task-state.js").TaskAttempt,
    retired: [{ attemptId: "old1" } as unknown as import("../src/swarm/task-state.js").TaskAttempt],
    binding: { bindingId: "b1" } as unknown as import("../src/swarm/task-state.js").ExecutionBinding,
  };
  test("produces intent + new attempt + retired attempts + a BUSINESS_EXEC supervision wait; no execution body", () => {
    const bodies = buildGrantBodies(prep, { waitId: grantWaitId("at1"), jobId: "J", owner: "w1", deadlineSec: 5000 });
    expect(bodies.map((b: ChangeBody) => b.put)).toEqual(["intent", "attempt", "attempt", "wait"]); // retired folded in; no startTask body
    const wait = (bodies.find((b) => b.put === "wait") as { wait: WaitRecord }).wait;
    expect(wait.subject).toEqual({ jobId: "J", attemptId: "at1", bindingId: "b1" }); // anchored to the admitted attempt+binding
    expect(wait.kind).toBe("wait");
    expect(wait.timeoutPolicy).toBe("escalate"); // sweep supervises the admitted work
    expect(wait.state).toBe("open");
    expect(wait.deadlineSec).toBe(5000);
    expect(wait.owner).toBe("w1");
    expect(grantWaitId("at1")).toBe("board-exec:at1"); // stable per attempt ⇒ re-grant replay is idempotent at the wait entity
  });
});

describe("task-board planClaimAdmission (§2d-b admit: re-admit a claim on the CURRENT CONTROL, real engine)", () => {
  // A real one-node plan + the real control-log engine (mirrors swarm-task-pass.test): drive the admission DECISION end to end.
  const plan1 = (): TaskPlan => {
    const res = loadPlan({
      jobId: "job", planRevision: 1,
      nodes: [{ nodeId: "build", kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }],
      jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
    });
    if (!res.ok) throw new Error(res.reason);
    return res.plan;
  };
  // The real shell's commit stamping: operationId = entityKey#targetRev, expectedEntityRevision = current rev.
  const stampCommit = (state: LogState, bodies: ChangeBody[]): LogState => {
    const changes = bodies.map((b) => { const key = entityKeyOf(b); const rev = state.revisions[key] ?? 0; return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev }; });
    const r = commit(state, state.seq, changes);
    if (!r.result.ok) throw new Error(`commit rejected: ${r.result.reason}`);
    return r.state;
  };
  const params = (over: Partial<AdmissionParams> = {}): AdmissionParams => ({
    nowSec: 1000, jobStartSec: 1000, launchId: "rw-t1",
    remainingLifeSec: 3000, checkpointBudgetSec: 300, handoffMarginSec: 180, tokenMarginSec: 600, budgetSec: 3480, ...over,
  });

  test("a ready claim GRANTS: intent + attempt + supervision wait (NO startTask), wait owned by the claimant, escalate policy", () => {
    const v = planClaimAdmission(plan1(), initialLogState(), { itemId: "build", who: "w1" }, params());
    expect(v.verdict).toBe("grant");
    if (v.verdict !== "grant") throw new Error("not a grant");
    expect(v.bodies.map((b) => b.put)).toEqual(["intent", "attempt", "wait"]); // no retired (fresh lineage), no execution body
    expect(v.waitId).toBe(grantWaitId(v.attemptId));
    const wait = (v.bodies.find((b) => b.put === "wait") as { wait: WaitRecord }).wait;
    expect(wait.owner).toBe("w1");
    expect(wait.timeoutPolicy).toBe("escalate");
    expect(wait.subject.attemptId).toBe(v.attemptId);
  });

  test("a node not in the current plan REJECTS", () => {
    expect(planClaimAdmission(plan1(), initialLogState(), { itemId: "ghost", who: "w1" }, params())).toEqual({ verdict: "reject", reason: "node not in current plan" });
  });

  test("after a grant commits: the SAME member's re-claim RECONCILES (idempotent lost-rename); a DIFFERENT member's claim REJECTS (single-active race lost)", () => {
    let s = initialLogState();
    const g = planClaimAdmission(plan1(), s, { itemId: "build", who: "w1" }, params());
    if (g.verdict !== "grant") throw new Error("expected grant");
    s = stampCommit(s, g.bodies); // the attempt is now RUNNING ⇒ node single-active, no longer ready

    const again = planClaimAdmission(plan1(), s, { itemId: "build", who: "w1" }, params({ launchId: "rw-t2" }));
    expect(again).toEqual({ verdict: "reconcile", attemptId: g.attemptId });

    const other = planClaimAdmission(plan1(), s, { itemId: "build", who: "w2" }, params({ launchId: "rw-t3" }));
    expect(other.verdict).toBe("reject");
    if (other.verdict !== "reject") throw new Error("expected reject");
    expect(other.reason).toMatch(/already granted to w1/);
  });
});

describe("task-board dormancy gate (coordinator boundary #1: default OFF)", () => {
  test("SWARM_BOARD_ADMIT default-off; only explicit truthy enables", () => {
    expect(boardAdmitEnabled({})).toBe(false);
    expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: "" })).toBe(false);
    expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: "0" })).toBe(false);
    expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: "off" })).toBe(false);
    for (const v of ["1", "true", "yes", "on", "ON", "True"]) expect(boardAdmitEnabled({ SWARM_BOARD_ADMIT: v })).toBe(true);
  });
});
