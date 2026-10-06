import { describe, expect, test } from "vitest";
import {
  boardItemsToPost, planBoardWrites, buildGrantBodies, grantWaitId, planClaimAdmission, parseClaimApplication, boardItemId,
  postedFileName, claimedFileName, grantedFileName, rejectedFileName, doneFileName,
  parseBoardItemName, isValidItemId, boardAdmitEnabled, type BoardItem, type AdmissionParams, type ExistingBoardFile, type ClaimApplication,
} from "../src/swarm/task-board.js";
import { commit, entityKeyOf, initialLogState, type ChangeBody, type LogState, type WaitRecord } from "../src/swarm/control-log.js";
import { loadPlan, type TaskPlan } from "../src/swarm/task-plan.js";
import { readyTasks, type ReadyTask } from "../src/swarm/task-ready.js";
import { buildSched } from "../src/swarm/task-pass.js";

// Minimal cast fixtures — boardItemsToPost reads only a few fields per node.
const node = (nodeId: string, over: Record<string, unknown> = {}): unknown => ({
  nodeId, kind: "work", goal: `do ${nodeId}`, dependsOn: [], outputContract: { requiredOutputs: [] }, acceptance: [],
  artifactScope: [`src/${nodeId}`], estimatedRuntimeSec: 60, retryBudget: 1, specDigest: `sd-${nodeId}`, ...over,
});
const plan = (nodes: unknown[], over: Record<string, unknown> = {}): TaskPlan =>
  ({ jobId: "J", planRevision: 3, nodes, jobBudget: {}, planDigest: "pd", ...over } as unknown as TaskPlan);
const ready = (nodeId: string): ReadyTask => ({ nodeId, proposedBindings: [], inputBindingDigest: `ibd-${nodeId}` });

describe("task-board boardItemsToPost (§2d-a curate: ready nodes → JOB-NAMESPACED board items)", () => {
  test("maps each ready node to a board item carrying spec summary / fit-domain / identity; itemId is <jobId>__<nodeId>", () => {
    const p = plan([
      node("a", { goal: "build A", dependsOn: ["x"], artifactScope: ["src/a"], sourceWriteScope: ["src/a", "docs"], roleProfile: "builder", modelTier: "heavy" }),
      node("b"),
    ]);
    const items = boardItemsToPost([ready("a"), ready("b")], p, { postedBy: "coord", nowSec: 1000 });
    expect(items.map((i) => i.itemId)).toEqual(["J__a", "J__b"]); // v2: job-namespaced so two jobs' same nodeId never collide
    const a = items[0]!;
    expect(a).toMatchObject({
      itemId: "J__a", jobId: "J", nodeId: "a", planRevision: 3, specDigest: "sd-a", inputBindingDigest: "ibd-a",
      goal: "build A", kind: "work", dependsOn: ["x"], fitProfile: "builder", modelTier: "heavy", postedBy: "coord", postedAtSec: 1000,
    });
    expect(a.fileDomain.sort()).toEqual(["docs", "src/a"]); // artifactScope ∪ sourceWriteScope, deduped
    expect(items[1]!.fitProfile).toBeUndefined(); // no roleProfile ⇒ omitted
    expect(items[1]!.priority).toBeUndefined();   // no TaskSpec source ⇒ absent
    expect(boardItemId("J", "a")).toBe("J__a");
  });

  test("a ready node absent from the plan is skipped (guard)", () => {
    expect(boardItemsToPost([ready("ghost")], plan([node("a")]), { postedBy: "c", nowSec: 1 })).toEqual([]);
  });
});

describe("task-board planBoardWrites (§2d-a producer: job-scoped post/reap, stale-revision refresh, terminal states)", () => {
  const p = plan([node("a"), node("b"), node("c")]);
  const item = (nodeId: string, over: Partial<BoardItem> = {}): BoardItem => ({ ...boardItemsToPost([ready(nodeId)], p, { postedBy: "c", nowSec: 1 })[0]!, ...over });
  const ex = (file: string, body: BoardItem | null): ExistingBoardFile => ({ file, body });

  test("posts ready items not on the board; a FRESH posted file (matching digests) is an idempotent skip", () => {
    expect(planBoardWrites([ready("a"), ready("b")], p, [], { postedBy: "c", nowSec: 1 }).post.map((i) => i.itemId)).toEqual(["J__a", "J__b"]);
    const fresh = ex(postedFileName("J__a"), item("a"));
    expect(planBoardWrites([ready("a")], p, [fresh], { postedBy: "c", nowSec: 1 })).toEqual({ post: [], reap: [] }); // fresh ⇒ no-op
  });
  test("a claimed/granted file is in-flight ⇒ not re-posted, never reaped", () => {
    expect(planBoardWrites([ready("a")], p, [ex(claimedFileName("J__a", "w"), item("a"))], { postedBy: "c", nowSec: 1 })).toEqual({ post: [], reap: [] });
    expect(planBoardWrites([ready("a")], p, [ex(grantedFileName("J__a", "w"), item("a"))], { postedBy: "c", nowSec: 1 })).toEqual({ post: [], reap: [] });
  });
  test("BA8b: a STALE-revision posted file (digest drifted) is reaped and re-posted fresh", () => {
    const stale = ex(postedFileName("J__a"), item("a", { specDigest: "OLD" }));
    const { post, reap } = planBoardWrites([ready("a")], p, [stale], { postedBy: "c", nowSec: 1 });
    expect(post.map((i) => i.itemId)).toEqual(["J__a"]);
    expect(post[0]!.specDigest).toBe("sd-a"); // fresh content
    expect(reap).toEqual([postedFileName("J__a")]);
  });
  test("BA8a: a TERMINAL rejected file does NOT block a node that is READY again ⇒ re-post + clear the stale rejection", () => {
    const { post, reap } = planBoardWrites([ready("a")], p, [ex(rejectedFileName("J__a", "w"), item("a"))], { postedBy: "c", nowSec: 1 });
    expect(post.map((i) => i.itemId)).toEqual(["J__a"]);
    expect(reap).toEqual([rejectedFileName("J__a", "w")]);
  });
  test("reaps a stale UNCLAIMED posted item whose node is no longer ready", () => {
    const { post, reap } = planBoardWrites([ready("a")], p, [ex(postedFileName("J__a"), item("a")), ex(postedFileName("J__b"), item("b"))], { postedBy: "c", nowSec: 1 });
    expect(post).toEqual([]);                      // a is fresh
    expect(reap).toEqual([postedFileName("J__b")]); // b posted but not ready ⇒ reap
  });
  test("BA4: another job's entries are NEVER posted-over or reaped (job-scoped by itemId prefix)", () => {
    const other = ex(postedFileName("OTHER__x"), { ...item("a"), itemId: "OTHER__x", jobId: "OTHER", nodeId: "x" });
    const { post, reap } = planBoardWrites([ready("a")], p, [other], { postedBy: "c", nowSec: 1 });
    expect(post.map((i) => i.itemId)).toEqual(["J__a"]); // my job posts normally
    expect(reap).toEqual([]);                            // the OTHER job's post is left completely alone
  });
});

describe("task-board file-name convention + parser (one canonical form, incl. granted/rejected)", () => {
  test("round-trips every state (with a job-namespaced itemId)", () => {
    expect(parseBoardItemName(postedFileName("J__a"))).toEqual({ itemId: "J__a", state: "posted", who: "" });
    expect(parseBoardItemName(claimedFileName("J__a", "w1"))).toEqual({ itemId: "J__a", state: "claimed", who: "w1" });
    expect(parseBoardItemName(grantedFileName("J__a", "w1"))).toEqual({ itemId: "J__a", state: "granted", who: "w1" });
    expect(parseBoardItemName(rejectedFileName("J__a", "w1"))).toEqual({ itemId: "J__a", state: "rejected", who: "w1" });
    expect(parseBoardItemName(doneFileName("J__a", "w1"))).toEqual({ itemId: "J__a", state: "done", who: "w1" });
  });
  test("rejects unknown / malformed shapes rather than mis-splitting", () => {
    expect(parseBoardItemName("a.weird.w1.json")).toBeNull();   // unknown state token
    expect(parseBoardItemName("a.claimed.json")).toBeNull();    // missing who
    expect(parseBoardItemName("a.b.c.d.json")).toBeNull();      // too many segments
    expect(parseBoardItemName("a.txt")).toBeNull();             // not .json
    expect(parseBoardItemName(".json")).toBeNull();             // empty itemId
  });
  test("isValidItemId allows the __ namespace separator but rejects ids that break the convention", () => {
    expect(isValidItemId("J__build-a")).toBe(true);  // the v2 namespace form
    expect(isValidItemId("build-a")).toBe(true);
    expect(isValidItemId("a.b")).toBe(false);  // dot collides with the separator
    expect(isValidItemId("a/b")).toBe(false);
    expect(isValidItemId("a b")).toBe(false);
    expect(isValidItemId("")).toBe(false);
  });
});

describe("task-board parseClaimApplication (BA2: the claim body is an untrusted trust boundary)", () => {
  test("narrows a well-formed body; drops a malformed one; carries requiresApproval only when truthy", () => {
    const ok = parseClaimApplication({ jobId: "J", nodeId: "a", specDigest: "sd", inputBindingDigest: "ibd", extra: 1 }, "w1");
    expect(ok).toEqual({ who: "w1", jobId: "J", nodeId: "a", specDigest: "sd", inputBindingDigest: "ibd" });
    expect(parseClaimApplication({ jobId: "J", nodeId: "a", specDigest: "sd", inputBindingDigest: "ibd", requiresApproval: true }, "w1")!.requiresApproval).toBe(true);
    expect(parseClaimApplication({ jobId: "J", nodeId: "a", specDigest: "sd" }, "w1")).toBeNull(); // missing inputBindingDigest
    expect(parseClaimApplication({ jobId: "", nodeId: "a", specDigest: "s", inputBindingDigest: "i" }, "w1")).toBeNull(); // empty jobId
    expect(parseClaimApplication("not-json", "w1")).toBeNull();
    expect(parseClaimApplication(null, "w1")).toBeNull();
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

describe("task-board planClaimAdmission (§2d-b admit v2: consistent-cut + job-isolated + body-validated, real engine)", () => {
  // Real plans + the real control-log engine. currentPlan resolves from a committed PlanPut, so every state carries one.
  const loaded = (jobId: string, goal = "g"): TaskPlan => {
    const res = loadPlan({
      jobId, planRevision: 1,
      nodes: [{ nodeId: "build", kind: "work", goal, dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] }, acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral" }],
      jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 },
    });
    if (!res.ok) throw new Error(res.reason);
    return res.plan;
  };
  const stamp = (state: LogState, bodies: ChangeBody[]): LogState => {
    const changes = bodies.map((b) => { const key = entityKeyOf(b); const rev = state.revisions[key] ?? 0; return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev }; });
    const r = commit(state, state.seq, changes);
    if (!r.result.ok) throw new Error(`commit rejected: ${r.result.reason}`);
    return r.state;
  };
  const withPlans = (...plans: TaskPlan[]): LogState => plans.reduce((s, p) => stamp(s, [{ put: "plan", plan: p }]), initialLogState());
  const jobAttempts = (plan: TaskPlan, s: LogState) => buildSched(plan, s).attempts.filter((a) => a.jobId === plan.jobId);
  // The claim a member holds = a posted BoardItem for the node, narrowed. Its identity (job/node/spec/input digests) is STABLE
  // across generations, so build it from the node on a clean cut — usable even when the node is currently single-active.
  const claimFor = (plan: TaskPlan, who: string): ClaimApplication => {
    const rt = readyTasks({ plan, attempts: [], acceptedResults: [], now: 1000, jobUsage: { totalAttempts: 0, wallClockSec: 0 } }).find((r) => r.nodeId === "build")!;
    const item = boardItemsToPost([rt], plan, { postedBy: "c", nowSec: 1000 })[0]!;
    return parseClaimApplication(item, who)!;
  };
  const params = (over: Partial<AdmissionParams> = {}): AdmissionParams => ({
    nowSec: 1000, jobStartSec: 1000, launchId: "rw-t1", freeSlots: 3,
    remainingLifeSec: 3000, checkpointBudgetSec: 300, handoffMarginSec: 180, tokenMarginSec: 600, budgetSec: 3480, ...over,
  });

  test("a ready claim GRANTS: intent + attempt + supervision wait (NO startTask), wait owned by the claimant", () => {
    const p = loaded("J");
    const s = withPlans(p);
    const v = planClaimAdmission(s, claimFor(p, "w1"), params());
    expect(v.verdict).toBe("grant");
    if (v.verdict !== "grant") throw new Error("not a grant");
    expect(v.bodies.map((b) => b.put)).toEqual(["intent", "attempt", "wait"]);
    const wait = (v.bodies.find((b) => b.put === "wait") as { wait: WaitRecord }).wait;
    expect(wait.owner).toBe("w1");
    expect(wait.timeoutPolicy).toBe("escalate");
  });

  test("BA1: a job with NO authoritative PlanPut in the current CONTROL DEFERS (never grants off a stale startup copy)", () => {
    const v = planClaimAdmission(initialLogState(), { who: "w1", jobId: "J", nodeId: "build", specDigest: "x", inputBindingDigest: "y" }, params());
    expect(v).toEqual({ verdict: "defer", reason: "no authoritative plan for job J in current CONTROL" });
  });

  test("a node not in the current plan REJECTS", () => {
    const s = withPlans(loaded("J"));
    expect(planClaimAdmission(s, { who: "w1", jobId: "J", nodeId: "ghost", specDigest: "x", inputBindingDigest: "y" }, params())).toEqual({ verdict: "reject", reason: "node not in current plan" });
  });

  test("BA2: a requiresApproval claim REJECTS (board admission does not auto-grant approval-gated work)", () => {
    const p = loaded("J"); const s = withPlans(p);
    const v = planClaimAdmission(s, { ...claimFor(p, "w1"), requiresApproval: true }, params());
    expect(v.verdict).toBe("reject");
    if (v.verdict === "reject") expect(v.reason).toMatch(/requires approval/);
  });

  test("BA2: a spec-drifted claim REJECTS; an input-drifted claim REJECTS", () => {
    const p = loaded("J"); const s = withPlans(p);
    const spec = planClaimAdmission(s, { ...claimFor(p, "w1"), specDigest: "STALE" }, params());
    expect(spec.verdict).toBe("reject");
    if (spec.verdict === "reject") expect(spec.reason).toMatch(/spec drifted/);
    const input = planClaimAdmission(s, { ...claimFor(p, "w1"), inputBindingDigest: "STALE" }, params());
    expect(input.verdict).toBe("reject");
    if (input.verdict === "reject") expect(input.reason).toMatch(/input drifted/);
  });

  test("BA6: a grant is DEFERRED when no physical slot is free (capacity, not just token TTL)", () => {
    const p = loaded("J"); const s = withPlans(p);
    const v = planClaimAdmission(s, claimFor(p, "w1"), params({ freeSlots: 0 }));
    expect(v).toEqual({ verdict: "defer", reason: "capacity reached (no free physical slot)" });
  });

  test("BA7: reconcile/reject follow the CURRENT live attempt's owner, not a retired historical grant", () => {
    const p = loaded("J");
    let s = withPlans(p);
    const g1 = planClaimAdmission(s, claimFor(p, "alice"), params());
    if (g1.verdict !== "grant") throw new Error("gen1 not grant");
    s = stamp(s, g1.bodies); // a0 RUNNING, wait owner alice
    // retire a0 so the node is admittable again, then grant a SECOND generation to bob
    const a0 = jobAttempts(p, s).find((a) => a.attemptId === g1.attemptId)!;
    s = stamp(s, [{ put: "attempt", attempt: { ...a0, status: "ABANDONED", abandonReason: "retry-succession" } }]);
    const g2 = planClaimAdmission(s, claimFor(p, "bob"), params({ launchId: "rw-t2" }));
    if (g2.verdict !== "grant") throw new Error("gen2 not grant");
    s = stamp(s, g2.bodies); // a1 RUNNING, wait owner bob; a0 ABANDONED, wait owner alice still open
    expect(g2.attemptId).not.toBe(g1.attemptId);
    // The CURRENT owner is bob (the live a1), NOT alice (the first historical grant on a0).
    expect(planClaimAdmission(s, claimFor(p, "bob"), params({ launchId: "rw-t3" }))).toEqual({ verdict: "reconcile", attemptId: g2.attemptId });
    const ralice = planClaimAdmission(s, claimFor(p, "alice"), params({ launchId: "rw-t4" }));
    expect(ralice.verdict).toBe("reject");
    if (ralice.verdict === "reject") expect(ralice.reason).toMatch(/already granted to bob/);
  });

  test("BA3: granting one job never retires or budget-charges another job's attempt", () => {
    const pJ = loaded("J", "goal J"); const pK = loaded("K", "goal K"); // different goals ⇒ different specDigests
    let s = withPlans(pJ, pK);
    const gK = planClaimAdmission(s, claimFor(pK, "wk"), params());
    if (gK.verdict !== "grant") throw new Error("K not grant");
    s = stamp(s, gK.bodies); // K/build RUNNING
    const gJ = planClaimAdmission(s, claimFor(pJ, "wj"), params({ launchId: "rw-tj" }));
    expect(gJ.verdict).toBe("grant");
    if (gJ.verdict !== "grant") throw new Error("J not grant");
    // J's grant bodies touch ONLY job J's attempts — K/build (RUNNING) is neither retired nor referenced.
    for (const b of gJ.bodies) if (b.put === "attempt") expect(b.attempt.jobId).toBe("J");
    // K/build survives as a live attempt.
    expect(jobAttempts(pK, s).some((a) => a.status === "RUNNING")).toBe(true);
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
