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
 */
import type { TaskPlan } from "./task-plan.js";
import type { ReadyTask } from "./task-ready.js";
import type { TaskAttempt, ExecutionBinding } from "./task-state.js";
import type { ChangeBody, DispatchIntent } from "./control-log.js";
import { openWait } from "./task-wait.js";

/** The lifecycle states a board item's FILE NAME encodes. `posted` = `<itemId>.json` (unclaimed); the rest are
 *  `<itemId>.<state>.<who>.json`. `claimed` is a RESERVATION application (not authority); `granted`/`rejected` are the
 *  dispatcher's admission verdict; `done` is the member's completion. granted/rejected are NEW states the two legacy
 *  readers do not classify yet — align them on this set when wiring. */
export type BoardItemState = "posted" | "claimed" | "granted" | "rejected" | "done";

/** The content of a posted board file (`~/.agenthop/swarm/board/<itemId>.json`). Carries §2d-a's "spec 摘要/适配域/优先级"
 *  plus the identity an admission needs to re-check on the CURRENT CONTROL: a board file is a stale snapshot, so admission
 *  re-resolves by nodeId and compares specDigest/inputBindingDigest to detect a plan/input drift since posting. */
export type BoardItem = {
  itemId: string;             // board identity = the plan node id (one item per node; node single-active blocks dups at admit)
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
      itemId: spec.nodeId, jobId: plan.jobId, nodeId: spec.nodeId, planRevision: plan.planRevision,
      specDigest: spec.specDigest, inputBindingDigest: r.inputBindingDigest,
      goal: spec.goal, kind: spec.kind, dependsOn: [...spec.dependsOn], fileDomain,
      ...(spec.roleProfile !== undefined ? { fitProfile: spec.roleProfile } : {}),
      ...(spec.modelTier !== undefined ? { modelTier: spec.modelTier } : {}),
      postedBy: opts.postedBy, postedAtSec: opts.nowSec,
    });
  }
  return out;
}

/** The §2d-a producer DECISION (pure): given the current READY set and the board dir's existing file names, decide which
 *  items to POST (ready, valid id, not already on the board in ANY state — idempotent) and which stale UNCLAIMED `posted`
 *  files to REAP (a `posted` item whose node is no longer ready — it was push-dispatched, completed, or its deps changed).
 *  A claimed/granted/rejected/done file is an in-flight application and is NEVER reaped here (that is the consumer's/
 *  supervision's concern). The caller performs the thin IO (atomic-write `post`, unlink `reap`). Pure ⇒ unit-tested. */
export function planBoardWrites(ready: readonly ReadyTask[], plan: TaskPlan, existingFiles: readonly string[], opts: { postedBy: string; nowSec: number }): { post: BoardItem[]; reap: string[] } {
  const readyIds = new Set(ready.map((r) => r.nodeId));
  const onBoard = new Set<string>();
  const postedFiles = new Map<string, string>(); // itemId -> its posted (unclaimed) file name
  for (const f of existingFiles) {
    const p = parseBoardItemName(f);
    if (p === null) continue;
    onBoard.add(p.itemId);
    if (p.state === "posted") postedFiles.set(p.itemId, f);
  }
  const post = boardItemsToPost(ready, plan, opts).filter((i) => isValidItemId(i.itemId) && !onBoard.has(i.itemId));
  const reap: string[] = [];
  for (const [itemId, file] of postedFiles) if (!readyIds.has(itemId)) reap.push(file);
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
