import { describe, expect, test } from "vitest";
import {
  boardItemsToPost, planBoardWrites, buildGrantBodies, grantWaitId, planClaimAdmission, parseClaimApplication, boardItemId,
  postedFileName, claimedFileName, grantedFileName, rejectedFileName, doneFileName, reclaimedFileName,
  parseBoardItemName, isValidItemId, boardAdmitEnabled, superviseBoardPost, planBoardSupervision, parsePolicyNum,
  repostTmpAction, suppressPendingReposts, boardFileIdentityVerified,
  type BoardItem, type AdmissionParams, type ExistingBoardFile, type ClaimApplication, type BoardSupervisionPolicy,
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

describe("task-board boardItemsToPost + boardItemId (§2d-a curate: ready nodes → injective job-namespaced items)", () => {
  test("maps each ready node to a board item carrying spec summary / fit-domain / identity; itemId is the v3 key", () => {
    const p = plan([
      node("a", { goal: "build A", dependsOn: ["x"], artifactScope: ["src/a"], sourceWriteScope: ["src/a", "docs"], roleProfile: "builder", modelTier: "heavy" }),
      node("b"),
    ]);
    const items = boardItemsToPost([ready("a"), ready("b")], p, { postedBy: "coord", nowSec: 1000 });
    expect(items.map((i) => i.itemId)).toEqual([boardItemId("J", "a"), boardItemId("J", "b")]);
    const a = items[0]!;
    expect(a).toMatchObject({
      itemId: boardItemId("J", "a"), jobId: "J", nodeId: "a", planRevision: 3, specDigest: "sd-a", inputBindingDigest: "ibd-a",
      goal: "build A", kind: "work", dependsOn: ["x"], fitProfile: "builder", modelTier: "heavy", postedBy: "coord", postedAtSec: 1000,
    });
    expect(a.fileDomain.sort()).toEqual(["docs", "src/a"]); // artifactScope ∪ sourceWriteScope, deduped
    expect(items[1]!.fitProfile).toBeUndefined(); // no roleProfile ⇒ omitted
    expect(items[1]!.priority).toBeUndefined();   // no TaskSpec source ⇒ absent
  });
  test("BA4: the key is INJECTIVE, FILESYSTEM-SAFE, and BOUNDED (v5 SHA-256)", () => {
    expect(boardItemId("A", "B__C")).not.toBe(boardItemId("A__B", "C")); // length-prefixed preimage => no collision
    expect(isValidItemId(boardItemId("J", "build-a"))).toBe(true);       // 64-hex => no ./ /whitespace
    const fold = (s: string) => s.normalize("NFC").toLowerCase();
    expect(fold(boardItemId("A", "build"))).not.toBe(fold(boardItemId("a", "build")));   // case-insensitive FS (jobs A vs a)
    expect(fold(boardItemId("J", "\u00e9"))).not.toBe(fold(boardItemId("J", "e\u0301"))); // NFC é vs NFD e+combining
    expect(/^[0-9a-f]{64}$/.test(boardItemId("A", "build"))).toBe(true);                  // single-case ASCII hex, constant 64
    // BA4/P2b: the key is BOUNDED - a long identity no longer grows the on-disk name into ENAMETOOLONG territory.
    expect(boardItemId("x".repeat(500), "y".repeat(500)).length).toBe(64);
    const claimed = claimedFileName(boardItemId("u".repeat(36), "n".repeat(67)), "w".repeat(36));
    expect(Buffer.byteLength(claimed, "utf8")).toBeLessThanOrEqual(255); // the v4 hex key overflowed here (257 bytes)
  });
  test("a ready node absent from the plan is skipped (guard)", () => {
    expect(boardItemsToPost([ready("ghost")], plan([node("a")]), { postedBy: "c", nowSec: 1 })).toEqual([]);
  });
});

describe("task-board planBoardWrites (§2d-a producer: body-owned job scope, stale refresh, terminal/revoked states)", () => {
  const p = plan([node("a"), node("b"), node("c")]);
  const iid = (n: string) => boardItemId("J", n);
  const item = (nodeId: string, over: Partial<BoardItem> = {}): BoardItem => ({ ...boardItemsToPost([ready(nodeId)], p, { postedBy: "c", nowSec: 1 })[0]!, ...over });
  const ex = (file: string, body: BoardItem | null): ExistingBoardFile => ({ file, body });

  test("posts ready items not on the board; a FRESH posted file (matching digests) is an idempotent skip", () => {
    expect(planBoardWrites([ready("a"), ready("b")], p, [], { postedBy: "c", nowSec: 1 }).post.map((i) => i.itemId)).toEqual([iid("a"), iid("b")]);
    expect(planBoardWrites([ready("a")], p, [ex(postedFileName(iid("a")), item("a"))], { postedBy: "c", nowSec: 1 })).toEqual({ post: [], reap: [] });
  });
  test("a claimed file is a PENDING application ⇒ not re-posted, never reaped", () => {
    expect(planBoardWrites([ready("a")], p, [ex(claimedFileName(iid("a"), "w"), item("a"))], { postedBy: "c", nowSec: 1 })).toEqual({ post: [], reap: [] });
  });
  test("BA8a: a STALE-revision posted file is OVERWRITTEN in place (post only, no self-deleting reap of the same path)", () => {
    const { post, reap } = planBoardWrites([ready("a")], p, [ex(postedFileName(iid("a")), item("a", { specDigest: "OLD" }))], { postedBy: "c", nowSec: 1 });
    expect(post.map((i) => i.itemId)).toEqual([iid("a")]);
    expect(post[0]!.specDigest).toBe("sd-a"); // fresh content
    expect(reap).toEqual([]);                  // same path ⇒ overwrite, NOT reap-then-post
  });
  test("BA8b: a granted file for a node that is READY again is a REVOKED/stale grant ⇒ reap + re-post", () => {
    const { post, reap } = planBoardWrites([ready("a")], p, [ex(grantedFileName(iid("a"), "w"), item("a"))], { postedBy: "c", nowSec: 1 });
    expect(post.map((i) => i.itemId)).toEqual([iid("a")]);
    expect(reap).toEqual([grantedFileName(iid("a"), "w")]);
  });
  test("BA8a: a TERMINAL rejected file does NOT block a READY node ⇒ re-post + clear the stale rejection", () => {
    const { post, reap } = planBoardWrites([ready("a")], p, [ex(rejectedFileName(iid("a"), "w"), item("a"))], { postedBy: "c", nowSec: 1 });
    expect(post.map((i) => i.itemId)).toEqual([iid("a")]);
    expect(reap).toEqual([rejectedFileName(iid("a"), "w")]);
  });
  test("reaps a stale UNCLAIMED posted item whose node is no longer ready", () => {
    const { post, reap } = planBoardWrites([ready("a")], p, [ex(postedFileName(iid("a")), item("a")), ex(postedFileName(iid("b")), item("b"))], { postedBy: "c", nowSec: 1 });
    expect(post).toEqual([]);                      // a is fresh
    expect(reap).toEqual([postedFileName(iid("b"))]); // b posted but not ready ⇒ reap
  });
  test("BA4: ownership is by BODY jobId — another job's entries (incl. a sibling job A__B) are never posted-over or reaped", () => {
    const foreign = ex(postedFileName(boardItemId("OTHER", "x")), { ...item("a"), itemId: boardItemId("OTHER", "x"), jobId: "OTHER", nodeId: "x" });
    const r1 = planBoardWrites([ready("a")], p, [foreign], { postedBy: "c", nowSec: 1 });
    expect(r1.post.map((i) => i.itemId)).toEqual([iid("a")]);
    expect(r1.reap).toEqual([]); // the OTHER job's post is left completely alone
    // A producer for job "A" must NOT treat job "A__B"'s files as its own (the v2 prefix bug).
    const pA = plan([node("a")], { jobId: "A" });
    const sibling = ex(postedFileName(boardItemId("A__B", "C")), { ...item("a"), itemId: boardItemId("A__B", "C"), jobId: "A__B", nodeId: "C" });
    const r2 = planBoardWrites([ready("a")], pA, [sibling], { postedBy: "c", nowSec: 1 });
    expect(r2.post.map((i) => i.itemId)).toEqual([boardItemId("A", "a")]);
    expect(r2.reap).toEqual([]);
  });
  test("BA2b-adjacent: a file whose NAME does not match its own body identity is left alone (not mis-owned)", () => {
    const mislabeled = ex(postedFileName(iid("a")), { ...item("b") }); // name says node a, body says node b
    expect(planBoardWrites([ready("a")], p, [mislabeled], { postedBy: "c", nowSec: 1 }).reap).toEqual([]); // not treated as a's posted file
  });
});

describe("task-board file-name convention + parser (one canonical form, incl. granted/rejected)", () => {
  test("round-trips every state", () => {
    expect(parseBoardItemName(postedFileName("1-J-a"))).toEqual({ itemId: "1-J-a", state: "posted", who: "" });
    expect(parseBoardItemName(claimedFileName("1-J-a", "w1"))).toEqual({ itemId: "1-J-a", state: "claimed", who: "w1" });
    expect(parseBoardItemName(grantedFileName("1-J-a", "w1"))).toEqual({ itemId: "1-J-a", state: "granted", who: "w1" });
    expect(parseBoardItemName(rejectedFileName("1-J-a", "w1"))).toEqual({ itemId: "1-J-a", state: "rejected", who: "w1" });
    expect(parseBoardItemName(doneFileName("1-J-a", "w1"))).toEqual({ itemId: "1-J-a", state: "done", who: "w1" });
  });
  test("rejects unknown / malformed shapes rather than mis-splitting", () => {
    expect(parseBoardItemName("a.weird.w1.json")).toBeNull();   // unknown state token
    expect(parseBoardItemName("a.claimed.json")).toBeNull();    // missing who
    expect(parseBoardItemName("a.b.c.d.json")).toBeNull();      // too many segments
    expect(parseBoardItemName("a.txt")).toBeNull();             // not .json
    expect(parseBoardItemName(".json")).toBeNull();             // empty itemId
  });
  test("isValidItemId allows the key's `-` chars but rejects ids that break the convention", () => {
    expect(isValidItemId("1-J-build-a")).toBe(true);
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
    expect(parseClaimApplication("not-json", "w1")).toBeNull();
    expect(parseClaimApplication(null, "w1")).toBeNull();
  });
  test("BA2a: a path-unsafe jobId/nodeId is rejected (no path is ever built from an untrusted traversal string)", () => {
    expect(parseClaimApplication({ jobId: "../../victim", nodeId: "build", specDigest: "s", inputBindingDigest: "i" }, "w1")).toBeNull();
    expect(parseClaimApplication({ jobId: "J", nodeId: "a/b", specDigest: "s", inputBindingDigest: "i" }, "w1")).toBeNull();
    expect(parseClaimApplication({ jobId: "", nodeId: "a", specDigest: "s", inputBindingDigest: "i" }, "w1")).toBeNull();
    expect(parseClaimApplication({ jobId: "a b", nodeId: "a", specDigest: "s", inputBindingDigest: "i" }, "w1")).toBeNull();
  });
  test("BA4/P2a: an ill-formed UTF-16 identifier (lone surrogate) is rejected so it cannot alias an accepted identity", () => {
    // A lone surrogate U+D800 encodes to the same UTF-8 bytes (U+FFFD) as the accepted replacement char — rejecting it at the
    // boundary prevents two distinct accepted identities from keying onto the same board file.
    expect(parseClaimApplication({ jobId: "\uD800", nodeId: "build", specDigest: "s", inputBindingDigest: "i" }, "w1")).toBeNull();
    expect(parseClaimApplication({ jobId: "J", nodeId: "a\uDC00b", specDigest: "s", inputBindingDigest: "i" }, "w1")).toBeNull();
    expect(parseClaimApplication({ jobId: "\uFFFD", nodeId: "build", specDigest: "s", inputBindingDigest: "i" }, "w1")).not.toBeNull(); // the real replacement char is well-formed ⇒ allowed
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

describe("task-board planClaimAdmission (§2d-b admit v3: consistent-cut + job-isolated + body-validated, real engine)", () => {
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
    const p = loaded("J"); const s = withPlans(p);
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

  test("BA2: a requiresApproval claim REJECTS; a spec-drifted claim REJECTS; an input-drifted claim REJECTS", () => {
    const p = loaded("J"); const s = withPlans(p);
    expect(planClaimAdmission(s, { ...claimFor(p, "w1"), requiresApproval: true }, params()).verdict).toBe("reject");
    const spec = planClaimAdmission(s, { ...claimFor(p, "w1"), specDigest: "STALE" }, params());
    expect(spec.verdict === "reject" && /spec drifted/.test(spec.reason)).toBe(true);
    const input = planClaimAdmission(s, { ...claimFor(p, "w1"), inputBindingDigest: "STALE" }, params());
    expect(input.verdict === "reject" && /input drifted/.test(input.reason)).toBe(true);
  });

  test("BA6: a grant is DEFERRED when no physical slot is free (capacity, not just token TTL)", () => {
    const p = loaded("J"); const s = withPlans(p);
    expect(planClaimAdmission(s, claimFor(p, "w1"), params({ freeSlots: 0 }))).toEqual({ verdict: "defer", reason: "capacity reached (no free physical slot)" });
  });

  test("BA7: reconcile/reject follow the CURRENT live attempt's owner, not a retired historical grant", () => {
    const p = loaded("J");
    let s = withPlans(p);
    const g1 = planClaimAdmission(s, claimFor(p, "alice"), params());
    if (g1.verdict !== "grant") throw new Error("gen1 not grant");
    s = stamp(s, g1.bodies);
    const a0 = jobAttempts(p, s).find((a) => a.attemptId === g1.attemptId)!;
    s = stamp(s, [{ put: "attempt", attempt: { ...a0, status: "ABANDONED", abandonReason: "retry-succession" } }]);
    const g2 = planClaimAdmission(s, claimFor(p, "bob"), params({ launchId: "rw-t2" }));
    if (g2.verdict !== "grant") throw new Error("gen2 not grant");
    s = stamp(s, g2.bodies);
    expect(g2.attemptId).not.toBe(g1.attemptId);
    expect(planClaimAdmission(s, claimFor(p, "bob"), params({ launchId: "rw-t3" }))).toEqual({ verdict: "reconcile", attemptId: g2.attemptId });
    const ralice = planClaimAdmission(s, claimFor(p, "alice"), params({ launchId: "rw-t4" }));
    expect(ralice.verdict === "reject" && /already granted to bob/.test(ralice.reason)).toBe(true);
  });

  test("BA2c: a same-owner reconcile carrying a DIFFERENT inputBindingDigest is rejected (not a replay of the committed grant)", () => {
    const p = loaded("J"); let s = withPlans(p);
    const g = planClaimAdmission(s, claimFor(p, "w1"), params());
    if (g.verdict !== "grant") throw new Error("not a grant");
    s = stamp(s, g.bodies); // a0 RUNNING owner w1 ⇒ node single-active (not ready) ⇒ reconcile branch
    const stale = planClaimAdmission(s, { ...claimFor(p, "w1"), inputBindingDigest: "DIFFERENT" }, params({ launchId: "rw-t2" }));
    expect(stale.verdict === "reject" && /input drifted vs committed grant/.test(stale.reason)).toBe(true);
    // a faithful replay (same input) still reconciles
    expect(planClaimAdmission(s, claimFor(p, "w1"), params({ launchId: "rw-t3" }))).toEqual({ verdict: "reconcile", attemptId: g.attemptId });
  });

  test("BA3: granting one job never retires or budget-charges another job's attempt", () => {
    const pJ = loaded("J", "goal J"); const pK = loaded("K", "goal K");
    let s = withPlans(pJ, pK);
    const gK = planClaimAdmission(s, claimFor(pK, "wk"), params());
    if (gK.verdict !== "grant") throw new Error("K not grant");
    s = stamp(s, gK.bodies);
    const gJ = planClaimAdmission(s, claimFor(pJ, "wj"), params({ launchId: "rw-tj" }));
    expect(gJ.verdict).toBe("grant");
    if (gJ.verdict !== "grant") throw new Error("J not grant");
    for (const b of gJ.bodies) if (b.put === "attempt") expect(b.attempt.jobId).toBe("J");
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


describe("task-board BA9 superviseBoardPost + planBoardSupervision (§2d-a escalation, R14 pre-flight)", () => {
  const POLICY: BoardSupervisionPolicy = { claimTtlSec: 100, maxReposts: 2, reportGraceSec: 50 };
  const mkPosted = (nodeId: string, postedAtSec: number, over: Partial<BoardItem> = {}): ExistingBoardFile => {
    const body = { ...boardItemsToPost([ready(nodeId)], plan([node(nodeId)]), { postedBy: "coord", nowSec: postedAtSec })[0]!, ...over };
    return { file: postedFileName(boardItemId("J", nodeId)), body };
  };

  test("within the claim deadline -> ok", () => {
    expect(superviseBoardPost(mkPosted("a", 1000).body!, 1050, POLICY)).toEqual({ kind: "ok" });
  });
  test("past deadline, under cap -> REPOST (fresh postedAtSec, repostCount+1, reportedAtSec cleared)", () => {
    const act = superviseBoardPost(mkPosted("a", 1000).body!, 1200, POLICY);
    expect(act.kind === "repost" && act.item.postedAtSec === 1200 && act.item.repostCount === 1 && act.item.reportedAtSec === undefined).toBe(true);
  });
  test("BP1: at cap with NO prior report -> REPORT first, even on a very late scan (never straight to reclaim)", () => {
    const act = superviseBoardPost(mkPosted("a", 1000, { repostCount: 2 }).body!, 99999, POLICY); // age huge, no reportedAtSec
    expect(act.kind === "report" && act.item.reportedAtSec === 99999).toBe(true);
  });
  test("BP1: reported, still within grace -> ok (grace runs from reportedAtSec, not postedAtSec)", () => {
    expect(superviseBoardPost(mkPosted("a", 1000, { repostCount: 2, reportedAtSec: 1100 }).body!, 1149, POLICY)).toEqual({ kind: "ok" }); // 1149 < 1100+50
  });
  test("BP1: reported + grace elapsed -> RECLAIM (full 50s from the report, not 2s from postedAtSec)", () => {
    expect(superviseBoardPost(mkPosted("a", 1000, { repostCount: 2, reportedAtSec: 1100 }).body!, 1150, POLICY)).toEqual({ kind: "reclaim", itemId: boardItemId("J", "a") });
  });

  test("planBoardSupervision: repost/report/reclaim, reports stamp reportedAtSec, all use the DERIVED id (BP4)", () => {
    const readyIds = new Set([boardItemId("J", "a"), boardItemId("J", "b"), boardItemId("J", "c")]);
    const overdue = mkPosted("a", 1000, { repostCount: 0 });
    const toReport = mkPosted("b", 1000, { repostCount: 2 });
    const toReclaim = mkPosted("c", 1000, { repostCount: 2, reportedAtSec: 1000 });
    const r = planBoardSupervision([overdue, toReport, toReclaim], readyIds, 1120, POLICY);
    expect(r.reposts.map((i) => i.nodeId)).toEqual(["a"]);
    expect(r.reports.length === 1 && r.reports[0]!.itemId === boardItemId("J", "b") && r.reports[0]!.reportedAtSec === 1120).toBe(true);
    expect(r.reclaims).toEqual([{ file: postedFileName(boardItemId("J", "c")), itemId: boardItemId("J", "c") }]);
  });
  test("BP4: a tampered body.itemId (`../foreign`) never reaches an output path — the DERIVED id is used", () => {
    const evil: ExistingBoardFile = { file: postedFileName(boardItemId("J", "a")), body: { ...mkPosted("a", 1000, { repostCount: 2, reportedAtSec: 1000 }).body!, itemId: "../foreign" } };
    const r = planBoardSupervision([evil], new Set([boardItemId("J", "a")]), 1120, POLICY);
    expect(r.reclaims).toEqual([{ file: postedFileName(boardItemId("J", "a")), itemId: boardItemId("J", "a") }]); // NOT "../foreign"
  });
  test("acts ONLY on still-ready posted files — not no-longer-ready, not claimed", () => {
    const overdue = mkPosted("a", 1000, { repostCount: 0 });
    expect(planBoardSupervision([overdue], new Set(), 1200, POLICY)).toEqual({ reposts: [], reports: [], reclaims: [] });
    const claimed: ExistingBoardFile = { file: claimedFileName(boardItemId("J", "a"), "w1"), body: overdue.body };
    expect(planBoardSupervision([claimed], new Set([boardItemId("J", "a")]), 1200, POLICY)).toEqual({ reposts: [], reports: [], reclaims: [] });
  });

  test("BP6: parsePolicyNum validates finiteness / non-negativity / integer, and preserves an explicit 0", () => {
    expect(parsePolicyNum("0", 2)).toBe(0);                         // explicit zero preserved (not the default)
    expect(parsePolicyNum(undefined, 2)).toBe(2);                   // absent -> default
    expect(parsePolicyNum("Infinity", 2, { integer: true })).toBe(2); // non-finite -> default (cap cannot be disabled)
    expect(parsePolicyNum("-1", 300)).toBe(300);                    // negative -> default
    expect(parsePolicyNum("1.5", 2, { integer: true })).toBe(2);    // non-integer count -> default
    expect(parsePolicyNum("3", 2, { integer: true })).toBe(3);      // valid
  });
});

describe("task-board BA9 reclaim is terminal: planBoardWrites never auto-re-posts a dead-lettered node", () => {
  test("a `reclaimed` file blocks re-post even when the node is READY (no reclaim->repost loop)", () => {
    const p = plan([node("a")]);
    const reclaimed: ExistingBoardFile = { file: reclaimedFileName(boardItemId("J", "a"), "coord"), body: boardItemsToPost([ready("a")], p, { postedBy: "coord", nowSec: 1000 })[0]! };
    const { post, reap } = planBoardWrites([ready("a")], p, [reclaimed], { postedBy: "coord", nowSec: 2000 });
    expect(post).toEqual([]);
    expect(reap).toEqual([]);
  });
});

describe("task-board BP3 repost-tmp recovery (crash between acquire + rewrite/restore must not revive a moved item or reset escalation)", () => {
  test("genuinely-missing item -> restore (no live state for its itemId)", () => {
    expect(repostTmpAction("item-a", new Set())).toBe("restore");
  });
  test("counterexample A: a claimed/moved item -> DROP the stale tmp (never revive -> claimed+posted coexisting)", () => {
    expect(repostTmpAction("item-a", new Set(["item-a"]))).toBe("drop"); // any live state (posted back / claimed / terminal)
    expect(repostTmpAction("item-b", new Set(["item-a"]))).toBe("restore"); // a different item's state does not block
  });
  test("counterexample B: a node with an UNRESTORED tmp is suppressed from a fresh first post (obligation retained)", () => {
    const post = [{ itemId: "item-a" }, { itemId: "item-b" }];
    expect(suppressPendingReposts(post, new Set(["item-a"]))).toEqual([{ itemId: "item-b" }]);
  });
  test("a successfully-restored (not pending) item is NOT suppressed", () => {
    const post = [{ itemId: "item-a" }, { itemId: "item-b" }];
    expect(suppressPendingReposts(post, new Set())).toEqual(post); // empty pending set -> nothing suppressed
  });
});

describe("task-board BP3 round-5 (body-verified eviction + obligation retained under a live/recycled writer pid)", () => {
  const itemId = boardItemId("J", "a");
  test("a body whose identity matches the filename itemId is VERIFIED", () => {
    expect(boardFileIdentityVerified(itemId, { jobId: "J", nodeId: "a" })).toBe(true);
  });
  test("counterexample A: a claim whose BODY is another job's entry is NOT verified (cannot evict a legit tmp)", () => {
    expect(boardFileIdentityVerified(itemId, { jobId: "OTHER", nodeId: "a" })).toBe(false); // body→different itemId
    expect(boardFileIdentityVerified(itemId, { nodeId: "a" })).toBe(false); // missing jobId
    expect(boardFileIdentityVerified(itemId, null)).toBe(false);
    // so liveItemIds (built from VERIFIED bodies only) would NOT contain itemId -> the tmp is restored, not dropped:
    expect(repostTmpAction(itemId, new Set())).toBe("restore");
  });
  test("a verified live state DOES evict (drop) the stale tmp", () => {
    const live = new Set(boardFileIdentityVerified(itemId, { jobId: "J", nodeId: "a" }) ? [itemId] : []);
    expect(repostTmpAction(itemId, live)).toBe("drop");
  });
  test("counterexample B: an unrestored tmp (live/recycled writer) still suppresses the fresh first post", () => {
    const post = [{ itemId }, { itemId: boardItemId("J", "b") }];
    expect(suppressPendingReposts(post, new Set([itemId]))).toEqual([{ itemId: boardItemId("J", "b") }]);
  });
});

describe("task-board BP3 round-6 (identity encoding: a lone surrogate cannot impersonate a real U+FFFD to evict a tmp)", () => {
  test("a genuine U+FFFD body is VERIFIED; a lone-surrogate body that hashes to the same key is REJECTED before it can evict", () => {
    const key = boardItemId("�", "a"); // a real replacement char — well-formed
    expect(boardItemId("\uD800", "a")).toBe(key); // the collision the fix defends against: a lone surrogate folds to U+FFFD bytes
    expect(boardFileIdentityVerified(key, { jobId: "�", nodeId: "a" })).toBe(true); // real U+FFFD stays legit
    expect(boardFileIdentityVerified(key, { jobId: "\uD800", nodeId: "a" })).toBe(false); // ill-formed -> not verified -> never evicts the legit tmp
  });
});
