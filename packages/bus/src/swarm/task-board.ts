/**
 * §2d "拉式领活" (pull-based claiming) — the PURE core of board admission (§2d-a board + §2d-b admission contract,
 * cluster-liveness-design.md §2d). This module holds ONLY pure logic: the on-disk board-item schema, the mapping from
 * ready plan-nodes to board items (the §2d-a "上板/curate" decision), the ONE canonical board file-name convention +
 * parser (so the two pre-existing readers — delegation-observer.parseBoardFile, projection.parseBoardFileName — can be
 * aligned on the states this emits), and the dormancy gate. All filesystem IO + the CONTROL-side admission (prepareDispatch
 * on the current log, the grant intent+binding+wait commit, the receipt) live in the dispatcher shell, gated.
 *
 * DORMANT-AHEAD-OF-USE (coordinator ruling, 3 hard boundaries): SWARM_BOARD_ADMIT defaults OFF and nothing in this batch
 * flips it on; when off the whole chain is dry (decision computable, nothing written to board or CONTROL); a grant's
 * commit happens only inside the gate-open branch; and a receipt never triggers execution (startTask/V8 is A2, a separate
 * gate). The board is an APPLICATION QUEUE + FACT PROJECTION, never a second execution ledger (§2d-b) — authority to run
 * comes ONLY from dispatcher admission on the current CONTROL, re-checked at claim time, not from holding a board file.
 *
 * v2 (codex review of 3fda743, 6P1+3P2) — admission is now CONSISTENT-CUT + JOB-ISOLATED + CLAIM-BODY-VALIDATED, matching
 * the liveness-review discipline: (BA1) the plan is resolved from the CURRENT CONTROL's PlanPut (currentPlan), never a stale
 * startup copy; (BA3) the scheduler input is isolated to the claim's OWN job, so a grant can never retire/charge another
 * job's attempts; (BA2) the claim FILE BODY is untrusted — its jobId/nodeId/specDigest/inputBindingDigest are validated
 * against the current plan and a requiresApproval flag is honored; (BA6) capacity (free physical slots) gates a grant;
 * (BA7) the current-generation LIVE attempt's owner — not the first historical grant — decides reconcile-vs-reject. Board
 * keys are JOB-NAMESPACED (`<jobId>__<nodeId>`, v2 since 3fda743) so two jobs' same nodeId never collide on the shared board
 * and a producer only reaps its own job's posts (BA4). BA9 (posted-but-unclaimed supervision) is DEFERRED under coordinator
 * ruling #R14 — a hard precondition before SWARM_BOARD_ADMIT is ever flipped on (tracked with envelope-open + §2d-c ping).
 */
import type { TaskPlan } from "./task-plan.js";
import { readyTasks, type ReadyTask } from "./task-ready.js";
import type { TaskAttempt, ExecutionBinding } from "./task-state.js";
import { liveEntities, type ChangeBody, type DispatchIntent, type LogState, type WaitRecord } from "./control-log.js";
import { openWait } from "./task-wait.js";
import { buildSched } from "./task-pass.js";
import { prepareDispatch, type DispatchParams } from "./task-dispatch.js";
import { currentPlan } from "./liveness-review.js";

/** An attempt holds no current execution once terminal — BA7 uses this to pick the CURRENT-generation attempt for a node. */
const TERMINAL_ATTEMPT: ReadonlySet<TaskAttempt["status"]> = new Set(["SUCCEEDED", "FAILED", "ABANDONED"]);

/** The board identity for a plan node, JOB-NAMESPACED (v2): `<jobId>__<nodeId>`. Two jobs' same nodeId must not collide on
 *  the ONE shared board dir, and a producer must be able to tell its own posts from another job's (BA4). `__` is dot/slash/
 *  whitespace-free so it survives isValidItemId + the `.`-separated file-name convention. The nodeId/jobId also live in the
 *  item body, so the consumer never has to split this back apart. */
export function boardItemId(jobId: string, nodeId: string): string { return `${jobId}__${nodeId}`; }

/** The lifecycle states a board item's FILE NAME encodes. `posted` = `<itemId>.json` (unclaimed); the rest are
 *  `<itemId>.<state>.<who>.json`. `claimed` is a RESERVATION application (not authority); `granted`/`rejected` are the
 *  dispatcher's admission verdict; `done` is the member's completion. granted/rejected are NEW states the two legacy
 *  readers do not classify yet — align them on this set when wiring. */
export type BoardItemState = "posted" | "claimed" | "granted" | "rejected" | "done";

/** The content of a posted board file (`~/.agenthop/swarm/board/<itemId>.json`). Carries §2d-a's "spec 摘要/适配域/优先级"
 *  plus the identity an admission needs to re-check on the CURRENT CONTROL: a board file is a stale snapshot, so admission
 *  re-resolves by nodeId and compares specDigest/inputBindingDigest to detect a plan/input drift since posting. */
export type BoardItem = {
  itemId: string;             // board identity, JOB-NAMESPACED `<jobId>__<nodeId>` (v2) — one item per job-node, collision-free on the shared board
  jobId: string;
  nodeId: string;
  planRevision: number;       // the plan revision this item was posted from (admission uses the CURRENT plan, not this)
  specDigest: string;         // node identity at post time — admission detects a spec drift vs the current plan
  inputBindingDigest: string; // input identity at post time — admission detects an input drift vs the current ready set
  goal: string;               // §2d-a "spec 摘要"
  kind: string;               // node kind (work|integration|synthesis|review|repair|design)
  dependsOn: string[];
  fileDomain: string[];       // §2d-a "适配域" — artifactScope ∪ sourceWriteScope (what the work touches; fit-matching)
  fitProfile?: string;        // roleProfile (role inference), when the plan carries one
  modelTier?: string;         // planner hint
  priority?: number;          // §2d-a "优先级" — no TaskSpec source; a curator/planner may supply it, else absent
  postedBy: string;           // the curator identity that posted it
  postedAtSec: number;
};

/** The §2d-a "上板/curate" DECISION (pure): map each READY plan-node to the board item that represents it. The board is
 *  "与 readyTasks 同构" — ready nodes are exactly the admittable ones (deps accepted, no active attempt, within budget).
 *  Idempotency (do not re-post a node already on the board) is an IO concern (diff against existing files); this only says
 *  WHICH items the current ready set wants on the board. A ready node absent from the plan is skipped (cannot happen for a
 *  readyTasks output, but guarded). */
export function boardItemsToPost(ready: readonly ReadyTask[], plan: TaskPlan, opts: { postedBy: string; nowSec: number }): BoardItem[] {
  const specByNode = new Map(plan.nodes.map((n) => [n.nodeId, n]));
  const out: BoardItem[] = [];
  for (const r of ready) {
    const spec = specByNode.get(r.nodeId);
    if (spec === undefined) continue; // not in the plan — never happens for a readyTasks output, guarded anyway
    const fileDomain = [...new Set([...(spec.artifactScope ?? []), ...(spec.sourceWriteScope ?? [])])];
    out.push({
      itemId: boardItemId(plan.jobId, spec.nodeId), jobId: plan.jobId, nodeId: spec.nodeId, planRevision: plan.planRevision,
      specDigest: spec.specDigest, inputBindingDigest: r.inputBindingDigest,
      goal: spec.goal, kind: spec.kind, dependsOn: [...spec.dependsOn], fileDomain,
      ...(spec.roleProfile !== undefined ? { fitProfile: spec.roleProfile } : {}),
      ...(spec.modelTier !== undefined ? { modelTier: spec.modelTier } : {}),
      postedBy: opts.postedBy, postedAtSec: opts.nowSec,
    });
  }
  return out;
}

/** One existing board file as the producer sees it: its name + its parsed body (null if unreadable). The producer reads the
 *  body so it can detect a stale-revision post (BA8b) and tell its own job's entries apart from another job's (BA4). */
export type ExistingBoardFile = { file: string; body: BoardItem | null };

/** The §2d-a producer DECISION (pure, v2): given the current READY set and the board dir's existing files (name + body),
 *  decide which items to POST and which to REAP — scoped to THIS plan's job only (BA4: another job's entries are NEVER
 *  touched; two jobs' same nodeId no longer collide thanks to the job-namespaced itemId). Rules:
 *    - a FRESH posted file (same spec+input digest) ⇒ idempotent skip;
 *    - a STALE posted file (digest drifted from the current revision) ⇒ reap + re-post fresh (BA8b);
 *    - a claimed/granted file ⇒ in-flight, skip (never double-post, never reap);
 *    - a rejected file is TERMINAL and does NOT block a node that is READY again ⇒ re-post, reaping the stale rejection (BA8a);
 *    - a posted file whose node is no longer ready ⇒ reap (push-dispatched / completed / deps changed).
 *  The caller performs the thin IO (atomic-write `post`, unlink `reap`). Pure ⇒ unit-tested. */
export function planBoardWrites(ready: readonly ReadyTask[], plan: TaskPlan, existing: readonly ExistingBoardFile[], opts: { postedBy: string; nowSec: number }): { post: BoardItem[]; reap: string[] } {
  const jobPrefix = `${plan.jobId}__`;
  const readyIds = new Set(ready.map((r) => boardItemId(plan.jobId, r.nodeId)));
  const posted = new Map<string, ExistingBoardFile>();  // itemId -> posted (unclaimed) file, MY job only
  const active = new Set<string>();                      // itemIds claimed/granted (in-flight) — skip, never reap
  const rejected = new Map<string, string>();           // itemId -> terminal rejected file name — does NOT block re-post (BA8a)
  for (const e of existing) {
    const p = parseBoardItemName(e.file);
    if (p === null || !p.itemId.startsWith(jobPrefix)) continue; // other job / unparseable ⇒ leave it ENTIRELY alone (BA4)
    if (p.state === "posted") posted.set(p.itemId, e);
    else if (p.state === "claimed" || p.state === "granted") active.add(p.itemId);
    else if (p.state === "rejected") rejected.set(p.itemId, e.file);
    // done ⇒ terminal; a done node is not READY, so it never reaches the post loop anyway
  }
  const post: BoardItem[] = [];
  const reap: string[] = [];
  for (const item of boardItemsToPost(ready, plan, opts)) {
    if (!isValidItemId(item.itemId)) continue;
    const pf = posted.get(item.itemId);
    if (pf !== undefined) {
      if (pf.body !== null && pf.body.specDigest === item.specDigest && pf.body.inputBindingDigest === item.inputBindingDigest) continue; // fresh ⇒ idempotent
      reap.push(pf.file); post.push(item); // BA8b: stale revision ⇒ replace content
      continue;
    }
    if (active.has(item.itemId)) continue;            // claimed/granted in-flight
    const rej = rejected.get(item.itemId);
    if (rej !== undefined) reap.push(rej);            // BA8a: clear the stale rejection as we re-post
    post.push(item);
  }
  const slated = new Set(reap);
  for (const [itemId, e] of posted) if (!readyIds.has(itemId) && !slated.has(e.file)) reap.push(e.file); // stale unclaimed, node no longer ready
  return { post, reap };
}

/** Assemble the §2d-b GRANT commit bodies (option B, coordinator ruling 2026-10-06): the dispatch intent + the new attempt
 *  (+ any retired attempts) from prepareDispatch — which IS the 派发即登记 receipt per §2b-b — PLUS a BUSINESS_EXEC-style
 *  SUPERVISION wait (the "信封 wait"), subject-anchored to the admitted attempt+binding, timeoutPolicy=escalate so the sweep
 *  watches the admitted work. There is NO execution body: startTask/V8 is A2 (boundary #3 — a grant admits, it does not run).
 *  The full §2b delegation envelope (openDelegation) is a SEPARATE batch (its open side is unwired today). Pure ⇒ the exact
 *  grant shape is unit-tested; the dispatcher commits these atomically inside the gate-open branch (boundary #2). */
export function buildGrantBodies(
  prep: { intent: DispatchIntent; attempt: TaskAttempt; retired: TaskAttempt[]; binding: ExecutionBinding },
  sup: { waitId: string; jobId: string; owner: string; deadlineSec: number },
): ChangeBody[] {
  const wait = openWait({
    waitId: sup.waitId, kind: "wait",
    subject: { jobId: sup.jobId, attemptId: prep.attempt.attemptId, bindingId: prep.binding.bindingId },
    deadlineSec: sup.deadlineSec, owner: sup.owner, timeoutPolicy: "escalate",
  });
  return [
    { put: "intent", intent: prep.intent },
    { put: "attempt", attempt: prep.attempt },
    ...prep.retired.map((a) => ({ put: "attempt", attempt: a }) as ChangeBody),
    { put: "wait", wait },
  ];
}

/** The supervision-wait id for an admitted attempt (stable per attempt ⇒ a re-grant replay is idempotent at the wait entity). */
export function grantWaitId(attemptId: string): string { return `board-exec:${attemptId}`; }

/** Inputs an admission decision needs beyond the CONTROL+claim: the clock, the job's start (for wall-clock budget), a fresh
 *  launch id, the dispatch margins (same bundle taskPass passes to prepareDispatch), and `freeSlots` = the GLOBAL physical
 *  capacity left right now (CAP − physicalSlotsOccupied), so a grant cannot over-commit the VM pool (BA6). All from the shell. */
export type AdmissionParams = {
  nowSec: number; jobStartSec: number; launchId: string; freeSlots: number;
  remainingLifeSec: number; checkpointBudgetSec: number; handoffMarginSec: number; tokenMarginSec: number; budgetSec: number;
};

/** A member's claim as an ADMISSION APPLICATION: the identity the board file BODY asserts (untrusted — validated against the
 *  current plan, BA2) plus the `who` from the file name. jobId/nodeId drive the per-job cut; the digests detect spec/input
 *  drift since posting; requiresApproval (if the body sets it) forces an approval gate this v1 does not auto-satisfy. */
export type ClaimApplication = { who: string; jobId: string; nodeId: string; specDigest: string; inputBindingDigest: string; requiresApproval?: boolean };

/** Validate + narrow an untrusted claim-file body into a ClaimApplication (BA2: the body is attacker-controllable — a member
 *  may write any file into the shared board dir). null ⇒ unreadable/malformed ⇒ the shell rejects the claim. */
export function parseClaimApplication(body: unknown, who: string): ClaimApplication | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.jobId !== "string" || typeof b.nodeId !== "string" || typeof b.specDigest !== "string" || typeof b.inputBindingDigest !== "string") return null;
  if (!b.jobId || !b.nodeId) return null;
  return { who, jobId: b.jobId, nodeId: b.nodeId, specDigest: b.specDigest, inputBindingDigest: b.inputBindingDigest, ...(b.requiresApproval === true ? { requiresApproval: true } : {}) };
}

/** The §2d-b admission VERDICT for one claim (pure). grant ⇒ commit these bodies then (receipt-first, BA5) mark granted;
 *  reject ⇒ mark rejected with the reason (TERMINAL); reconcile ⇒ the node was ALREADY granted to THIS member (its live
 *  attempt carries our board-exec wait) but the board rename/receipt was lost — re-deliver the receipt and fix the board, do
 *  NOT re-grant; defer ⇒ TRANSIENT (no authoritative plan yet / capacity full) ⇒ leave the claim untouched for re-review. */
export type ClaimAdmission =
  | { verdict: "grant"; bodies: ChangeBody[]; attemptId: string; bindingId: string; waitId: string }
  | { verdict: "reject"; reason: string }
  | { verdict: "reconcile"; attemptId: string }
  | { verdict: "defer"; reason: string };

function findWait(state: LogState, waitId: string): WaitRecord | undefined {
  for (const b of Object.values(liveEntities(state))) if (b.put === "wait" && b.wait.waitId === waitId) return b.wait;
  return undefined;
}

/** The §2d-b admission DECISION (pure, v2): re-run admission for a claim on the CURRENT CONTROL. A claim is a reservation
 *  APPLICATION, not authority. Consistent cut + job isolation + body validation:
 *    (BA1) resolve the plan from the CONTROL's authoritative PlanPut for the claim's job — a missing plan DEFERS (never grant
 *          off a stale startup copy);
 *    (BA2) validate the untrusted body's node / specDigest / inputBindingDigest against that plan (drift ⇒ reject); a
 *          requiresApproval claim is rejected (board admission does not auto-satisfy an approval gate in v1);
 *    (BA3) build the scheduler input (attempts/accepted/usage) from THIS job's entities only, so readyTasks/prepareDispatch
 *          can never retire or budget-charge another job;
 *    (BA7) when the node is no longer ready, the CURRENT-generation LIVE attempt's supervision-wait owner — not the first
 *          historical grant — decides reconcile (same member, idempotent) vs reject (a different member lost the race);
 *    (BA6) a grant is gated on free physical capacity (defer when the pool is full).
 *  Returns grant | reject | reconcile | defer. Pure ⇒ unit-tested against the real control engine; the shell does the IO. */
export function planClaimAdmission(state: LogState, claim: ClaimApplication, params: AdmissionParams): ClaimAdmission {
  const plan = currentPlan(state, claim.jobId);
  if (plan === undefined) return { verdict: "defer", reason: `no authoritative plan for job ${claim.jobId} in current CONTROL` }; // BA1
  const spec = plan.nodes.find((n) => n.nodeId === claim.nodeId);
  if (spec === undefined) return { verdict: "reject", reason: "node not in current plan" };
  if (claim.requiresApproval === true) return { verdict: "reject", reason: "claim requires approval; board admission does not auto-grant approval-gated work" }; // BA2
  if (claim.specDigest !== spec.specDigest) return { verdict: "reject", reason: `spec drifted (claim ${claim.specDigest} vs current ${spec.specDigest})` }; // BA2

  // BA3: per-job scheduler input — isolate attempts/accepted/usage to the claim's job (attempt/accepted carry jobId).
  const all = buildSched(plan, state);
  const attempts = all.attempts.filter((a) => a.jobId === claim.jobId);
  const acceptedResults = all.acceptedResults.filter((r) => r.jobId === claim.jobId);
  const usage = { totalAttempts: attempts.length, wallClockSec: Math.max(0, params.nowSec - params.jobStartSec) };
  const rt = readyTasks({ plan, attempts, acceptedResults, now: params.nowSec, jobUsage: usage }).find((r) => r.nodeId === claim.nodeId);
  if (rt === undefined) {
    // BA7: match the CURRENT live attempt's owner (not a retired historical grant). A live attempt with no board-exec wait
    // was push-dispatched (or claimed by someone else) ⇒ reject; with our wait ⇒ same owner reconcile, else reject.
    const live = attempts.find((a) => a.nodeId === claim.nodeId && !TERMINAL_ATTEMPT.has(a.status));
    if (live !== undefined) {
      const w = findWait(state, grantWaitId(live.attemptId));
      if (w !== undefined) return w.owner === claim.who ? { verdict: "reconcile", attemptId: live.attemptId } : { verdict: "reject", reason: `already granted to ${w.owner}` };
    }
    return { verdict: "reject", reason: "node no longer admittable (already dispatched / completed / deps or budget changed)" };
  }
  if (claim.inputBindingDigest !== rt.inputBindingDigest) return { verdict: "reject", reason: `input drifted (claim ${claim.inputBindingDigest} vs current ${rt.inputBindingDigest})` }; // BA2
  if (params.freeSlots <= 0) return { verdict: "defer", reason: "capacity reached (no free physical slot)" }; // BA6

  const dp: DispatchParams = {
    remainingLifeSec: params.remainingLifeSec, checkpointBudgetSec: params.checkpointBudgetSec, handoffMarginSec: params.handoffMarginSec,
    tokenMarginSec: params.tokenMarginSec, budgetSec: params.budgetSec, nowSec: params.nowSec, atSeq: state.seq + 1,
  };
  const prep = prepareDispatch(plan, rt, attempts, params.launchId, `${params.launchId}@${claim.nodeId}`, dp);
  if (!prep.ok) return { verdict: "reject", reason: prep.reason };
  const waitId = grantWaitId(prep.attempt.attemptId);
  const bodies = buildGrantBodies(prep, { waitId, jobId: plan.jobId, owner: claim.who, deadlineSec: params.nowSec + spec.estimatedRuntimeSec + params.handoffMarginSec });
  return { verdict: "grant", bodies, attemptId: prep.attempt.attemptId, bindingId: prep.binding.bindingId, waitId };
}

// --- the ONE canonical board file-name convention (so producer, consumer, observer + projection all agree, incl. the new
//     granted/rejected states) ---

const CLAIMABLE_STATES = new Set<BoardItemState>(["claimed", "granted", "rejected", "done"]);

/** The posted (unclaimed) file name for an item: `<itemId>.json`. itemId (= nodeId) must be dot-free (plan node ids are
 *  identifiers) so the parser's last-two-segments rule is unambiguous — asserted by the caller via sanitizeItemId. */
export function postedFileName(itemId: string): string { return `${itemId}.json`; }
export function claimedFileName(itemId: string, who: string): string { return `${itemId}.claimed.${who}.json`; }
export function grantedFileName(itemId: string, who: string): string { return `${itemId}.granted.${who}.json`; }
export function rejectedFileName(itemId: string, who: string): string { return `${itemId}.rejected.${who}.json`; }
export function doneFileName(itemId: string, who: string): string { return `${itemId}.done.${who}.json`; }

/** Parse a board file name into {itemId, state, who}. Convention: `<itemId>.json` (posted) or `<itemId>.<state>.<who>.json`
 *  where state ∈ {claimed,granted,rejected,done}. Explicit about the state token (unlike delegation-observer.parseBoardFile,
 *  which blindly takes the last two segments, and projection.parseBoardFileName, which only knows claimed/done) — an
 *  unrecognized shape returns null rather than being mis-split. itemId/who are assumed dot-free. */
export function parseBoardItemName(file: string): { itemId: string; state: BoardItemState; who: string } | null {
  if (!file.endsWith(".json")) return null;
  const segs = file.slice(0, -".json".length).split(".");
  if (segs.length === 1 && segs[0]) return { itemId: segs[0], state: "posted", who: "" };
  if (segs.length === 3 && CLAIMABLE_STATES.has(segs[1] as BoardItemState) && segs[0] && segs[2]) {
    return { itemId: segs[0], state: segs[1] as BoardItemState, who: segs[2] };
  }
  return null; // unknown / malformed shape — never silently mis-attributed
}

/** Reject a nodeId that would break the file-name convention (dots collide with the state/who separators). Pure guard the
 *  producer uses before posting; a plan node id is normally a plain identifier, so this only catches a malformed plan. */
export function isValidItemId(itemId: string): boolean {
  return itemId.length > 0 && !itemId.includes(".") && !itemId.includes("/") && !/\s/.test(itemId);
}

/** The dormancy gate (coordinator boundary #1): board admission is OFF unless SWARM_BOARD_ADMIT is explicitly truthy. Same
 *  pattern as SWARM_EXEC/SWARM_TASK_EXEC/SWARM_SWEEP. Nothing in this batch sets it; turning it on is the A2 gate. */
export function boardAdmitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_BOARD_ADMIT ?? "");
}
