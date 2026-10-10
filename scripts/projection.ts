import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Reader for the swarm-brain PROJECTION — the read-only current-state view the brain writes once
 * brain-design §4.3 step A ships. The projection schema is frozen (consumer contract in
 * docs/swarm/viz-projection-contract.md); this module is the consumer half.
 *
 * Three disciplines, straight from the contract:
 *   C-1  read CURRENT STATE, never replay control-log. Re-deriving the reducer here would drift.
 *   C-2  read FILES, never import bus modules. The file shape is the whole interface.
 *   C-3  each file is atomic (temp+rename); cross-file is eventually consistent — tolerate skew, do
 *        not retry-assemble a consistent cut (that reimplements the barrier).
 *
 * JUDGMENT-SINK: `complete`, `jobStatus`, node終败 are computed by the authoritative reducer and arrive
 * in the projection. This module and the page CONSUME those booleans/enums and never re-derive
 * currentAccepted — doing so would show a green node whose upstream has gone stale, the hardest lie to
 * catch. Layout (assignLayers) is the only thing we compute, and layout is presentation, not judgment.
 */

// ---------------------------------------------------------------------------------------------
// Types (mirror the frozen schema; see docs/swarm/viz-projection-contract.md)
// ---------------------------------------------------------------------------------------------

export type JobStatus = "running" | "succeeded" | "failed" | "blocked";
export type NodeKind = "work" | "integration" | "synthesis" | "review" | "repair";
export type AttemptStatus =
  | "RUNNING"
  | "RESULT_PENDING_VALIDATION"
  | "SUCCEEDED"
  | "RETRY_WAIT"
  | "FAILED"
  | "ABANDONED";

/** The executor of a binding — a discriminated union (the stable part; publishKey shape is C0's). */
export type Executor =
  | { kind: "box"; launchId: string }
  | { kind: "member"; memberId: string; publishKey?: string };

export type ExecutionBinding = {
  bindingId: string;
  executor: Executor;
  publishGeneration?: number;
  continuationOf?: string | null;
  state?: "open" | "closing" | "closed";
};

export type TaskNode = {
  nodeId: string;
  kind: NodeKind;
  goal?: string;
  dependsOn: string[];
  required: boolean;
  runtime?: "ephemeral" | "durable";
  visibility?: string;
  specDigest?: string;
  /** View-computed topological depth (NOT from the projection). Added by assignLayers. */
  layer?: number;
};

export type TaskPlan = {
  jobId: string;
  planRevision: number;
  planDigest?: string;
  jobStatus: JobStatus;
  jobStatusNote?: string;
  nodes: TaskNode[];
};

export type AttemptCurrent = {
  attemptId: string;
  status: AttemptStatus;
  statusNote?: string;
  /** = currentAccepted(node) != null, computed by the authoritative reducer. Never re-derived here. */
  complete: boolean;
  role?: string;
  retriesUsed?: number;
  retryAt?: number | null;
  failureClass?: string | null;
  inputBindings?: Array<{ depNodeId: string; acceptedResultId: string }>;
  executionBindings?: ExecutionBinding[];
};

export type AttemptRecord = {
  nodeId: string;
  current?: AttemptCurrent;
  history?: Array<{ attemptId: string; status: AttemptStatus; failureClass?: string | null }>;
};

export type JobResults = {
  accepted?: Array<{
    acceptedResultId: string; nodeId: string; attemptId?: string; observedWorkCommit?: string; resultPath?: string;
    superseded?: boolean;
    /** rev2: who accepted it — the dual-judge structure (fe=conformance, codex=adversarial). */
    decidedBy?: string;
    /** rev2 (S8): the recall — who issued the supersede, and when. */
    supersededBy?: { issuedBy?: string; atSeq?: number } | null;
    decidedAtSeq?: number;
  }>;
  rejected?: Array<{ nodeId: string; attemptId?: string; reason?: string; decidedBy?: string; atSeq?: number }>;
  candidates?: Array<{ nodeId: string; attemptId?: string; note?: string }>;
  /** rev2 (S2): per-attempt observed commits — an attempt can land several (keyed by attemptId). */
  observed?: Array<{ attemptId: string; observedWorkCommit: string; resultPath?: string; note?: string }>;
  peerLate?: number;
};

export type JobBudget = {
  jobBudget?: { maxTotalAttempts?: number; maxWallClockSec?: number; maxModelUsd?: number | null };
  used?: { totalAttempts?: number; wallClockSec?: number; modelUsd?: number | null };
  perNode?: Array<{ nodeId: string; attempts?: number; retriesUsed?: number; retryBudget?: number }>;
};

export type Member = {
  memberId: string;
  class: "durable";
  visibility?: string;
  reachability?: "ok" | "suspected";
  role?: string;
  activeBindings?: string[];
  /** rev2 (S5/F1): identity drift — how many times this member's underlying run id changed. */
  runDrift?: { count?: number; lastChangeAtSec?: number | null };
};

export type ProjectionMeta = { schemaVersion?: number; lastAppliedSeq?: number; rebuiltAt?: number };

/** One job, assembled from its files. The page renders the DAG from this. */
export type VizJob = {
  plan: TaskPlan;
  attempts: Record<string, AttemptRecord>; // keyed by nodeId
  results: JobResults;
  budget: JobBudget | null;
};

export type Projection = {
  present: boolean; // false when no projection dir exists yet (the normal state today)
  meta: ProjectionMeta | null;
  jobs: VizJob[];
  members: Member[];
};

// ---------------------------------------------------------------------------------------------
// Paths — relocatable independently of AH_HOME (lesson: AH_HOME also moves the bus home, which hides
// the live roster; a read source must have its own knob).
// ---------------------------------------------------------------------------------------------

export function projectionDir(home: string = homedir()): string {
  const explicit = process.env.SWARM_PROJECTION_DIR;
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(home, explicit);
  return path.join(home, ".agenthop", "swarm", "projection");
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined; // missing or torn — C-3 tolerates it
  }
}

// ---------------------------------------------------------------------------------------------
// Topological layering — the one thing we compute. Pure, cycle-safe, selftest-covered.
// ---------------------------------------------------------------------------------------------

/**
 * Assign each node a layer = longest dependency path from a root, so the DAG draws left→right by
 * dependency flow and nodes in the same layer with no path between them sit side-by-side (= visible
 * parallelism). Returns a NEW nodes array with `layer` set; never mutates the input.
 *
 * Cycle-safe: the plan is a DAG by construction (brain loads reject cycles), but a torn/partial read
 * could present one. A node still unresolved after V passes is forced to layer 0 rather than looping
 * forever — a defensive floor, not a correctness claim about the data.
 */
export function assignLayers(nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const layer = new Map<string, number>();

  const resolve = (id: string, seen: Set<string>): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle or dangling — floor it
    const node = byId.get(id);
    if (!node) return 0; // dependency points outside the plan (dangling) — treat as a root
    seen.add(id);
    const deps = node.dependsOn.filter((d) => byId.has(d));
    const l = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => resolve(d, seen)));
    seen.delete(id);
    layer.set(id, l);
    return l;
  };

  return nodes.map((n) => ({ ...n, layer: resolve(n.nodeId, new Set()) }));
}

/** Edges of the DAG as (from dep -> to node) pairs, dropping any that point outside the plan. */
export function planEdges(plan: TaskPlan): Array<{ from: string; to: string }> {
  const ids = new Set(plan.nodes.map((n) => n.nodeId));
  const edges: Array<{ from: string; to: string }> = [];
  for (const n of plan.nodes) for (const d of n.dependsOn) if (ids.has(d)) edges.push({ from: d, to: n.nodeId });
  return edges;
}

// ---------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------

/** Every job directory under projection/jobs, each assembled from its files. Absent dir -> []. */
export function readJobs(dir: string): VizJob[] {
  const jobsDir = path.join(dir, "jobs");
  let ids: string[];
  try {
    ids = readdirSync(jobsDir).filter((n) => {
      try {
        return statSync(path.join(jobsDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const out: VizJob[] = [];
  for (const jobId of ids) {
    const jobDir = path.join(jobsDir, jobId);
    const plan = readJson<TaskPlan>(path.join(jobDir, "plan.json"));
    if (!plan || !Array.isArray(plan.nodes)) continue; // a job with no readable plan is not drawable
    plan.nodes = assignLayers(plan.nodes);
    // Attempt files are driven by the plan's nodes (contract commitment: no dir glob).
    const attempts: Record<string, AttemptRecord> = {};
    for (const node of plan.nodes) {
      const rec = readJson<AttemptRecord>(path.join(jobDir, "attempts", `${node.nodeId}.json`));
      if (rec) attempts[node.nodeId] = rec;
    }
    const results = readJson<JobResults>(path.join(jobDir, "results.json")) ?? {};
    const budget = readJson<JobBudget>(path.join(jobDir, "budget.json")) ?? null;
    out.push({ plan, attempts, results, budget });
  }
  return out;
}

export function readMembers(dir: string): Member[] {
  const m = readJson<{ members?: Member[] }>(path.join(dir, "members.json"));
  return Array.isArray(m?.members) ? m!.members : [];
}

/** The whole projection, or { present:false } when the brain has not written one yet. */
export function readProjection(home: string = homedir()): Projection {
  const dir = projectionDir(home);
  if (!existsSync(dir)) return { present: false, meta: null, jobs: [], members: [] };
  return {
    present: true,
    meta: readJson<ProjectionMeta>(path.join(dir, "meta.json")) ?? null,
    jobs: readJobs(dir),
    members: readMembers(dir),
  };
}

// ---------------------------------------------------------------------------------------------
// Progress board (board-viz) — the three TRANSITIONAL durable sources the board spec names:
//   ① control-log/   wait entities; we fold put-wait changes to current state and consume the wait's
//                     `state` verbatim (judgment stays sunk — we never decide "expired" ourselves).
//   ② board/         claimable/claimed items; STATUS IS THE FILENAME (x.json open, x.claimed.<id>.json,
//                     x.done.<id>.json) — the claim protocol is an atomic rename, so the name is the truth.
//   ③ PROGRESS.md    the human summary, passed through as text, never parsed for state.
// Once projection-impl ships waits/<waitId>.json (schema §8c), readWaits switches source automatically
// and the render side does not change — that is the promised zero-change migration for source ①.
// ---------------------------------------------------------------------------------------------

export type WaitState = "open" | "action_pending" | "resolved" | string; // tolerate future states (§8c: fields may appear)
export type WaitRecord = {
  waitId: string;
  kind?: string;
  subject?: { jobId?: string; attemptId?: string };
  state: WaitState;
  deadlineSec?: number;
  owner?: string;
  timeoutPolicy?: string;
  escalatedAt?: number;
  /** §8c: set ⇒ "automation stopped, waiting for a human" — a legal long-lived state, not a fault. */
  automationExhausted?: boolean;
  [k: string]: unknown;
};

export type BoardItemStatus = "open" | "claimed" | "granted" | "rejected" | "done" | "reclaimed";
export type BoardItem = {
  itemId: string;
  status: BoardItemStatus;
  /** The sessionId from the filename, for claimed/done items. */
  claimant: string | null;
  file: string;
  mtimeMs: number | null;
  priority?: string;
  spec?: string;
  dependsOn: string[];
  conflictsWith: string[];
  fileDomain: string[];
  fitProfile?: string;
  postedBy?: string;
  postedAtSec?: number;
};

/** INV-2b-c: an artifact that exists (done-file mtime = production instant) with consumption not yet
 *  visible. waitId null = no wait references the item at all (consumer unknown, shown as such). A
 *  RESOLVED related wait = consumption happened, so no gap row. */
export type ArtifactGap = {
  itemId: string;
  doneAtMs: number;
  waitId: string | null;
  waitState: WaitState | null;
};

/** The stall theorem (全静默红态): everyone idle + nothing supervised + work unfinished = silence over
 *  unfinished business. DERIVED from observable files/statuses (like isAllocExhausted); the UI labels it. */
export type StallVerdict = {
  stalled: boolean;
  peersSeen: number;
  allIdle: boolean;
  unresolvedWaits: number;
  openBoardItems: number;
  incompleteJobs: number;
  reason: string;
};

export type BoardView = {
  items: BoardItem[];
  waits: WaitRecord[];
  waitsSource: "projection" | "control-log" | "none";
  progress: { text: string; mtimeMs: number } | null;
  gaps: ArtifactGap[];
};

function swarmRoot(home: string): string {
  return path.join(home, ".agenthop", "swarm");
}

export type WaitLogEntry = { seq?: number; changes?: Array<Record<string, unknown>> };

/** Fold control-log entries to the CURRENT state of each wait: apply put-wait changes in seq order,
 *  last write wins per waitId. Non-wait changes and malformed records are skipped, never thrown. */
export function foldWaitLog(entries: WaitLogEntry[]): WaitRecord[] {
  const sorted = [...entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const byId = new Map<string, WaitRecord>();
  for (const e of sorted) {
    for (const c of e.changes ?? []) {
      if (c.put !== "wait") continue;
      const w = c.wait as WaitRecord | undefined;
      if (!w || typeof w.waitId !== "string" || typeof w.state !== "string") continue;
      byId.set(w.waitId, w);
    }
  }
  return [...byId.values()];
}

/** Parse a board filename into (itemId, status, claimant). Mirrors the canonical task-board.parseBoardItemName discipline:
 *  a recognized shape only — `<itemId>.json` (open/posted) or `<itemId>.<status>.<who>.json` where status is a real lifecycle
 *  state. Any OTHER shape returns null (NOT a task), so an evidence file like `<itemId>.report.json` is never surfaced as a
 *  fake open TODO (B6-1): the canonical parser already excludes it, and the two classifications must agree. itemId/who are
 *  dot-free by construction (postedFileName requires it; `who` is a hex id), so a multi-dot name is never a real board item. */
export function parseBoardFileName(name: string): { itemId: string; status: BoardItemStatus; claimant: string | null } | null {
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -".json".length);
  const parts = stem.split(".");
  if (parts.length === 1 && parts[0]) return { itemId: parts[0], status: "open", claimant: null };
  if (parts.length === 3 && parts[0] && parts[2] && (parts[1] === "claimed" || parts[1] === "granted" || parts[1] === "rejected" || parts[1] === "done" || parts[1] === "reclaimed")) {
    return { itemId: parts[0], status: parts[1], claimant: parts[2] };
  }
  return null; // unrecognized shape (incl. `<itemId>.report.json` evidence) — never a fake open item (B6-1)
}

export function readBoard(home: string = homedir()): BoardItem[] {
  const dir = path.join(swarmRoot(home), "board");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const out: BoardItem[] = [];
  for (const name of names.sort()) {
    const parsed = parseBoardFileName(name);
    if (!parsed) continue;
    const full = path.join(dir, name);
    const body = readJson<Record<string, unknown>>(full) ?? {}; // unreadable body ⇒ filename still carries the state
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      // renamed between readdir and stat — the next snapshot sees the new name
    }
    out.push({
      ...parsed,
      file: name,
      mtimeMs,
      priority: typeof body.priority === "string" ? body.priority : undefined,
      spec: typeof body.spec === "string" ? body.spec : undefined,
      dependsOn: strs(body.dependsOn),
      conflictsWith: strs(body.conflictsWith),
      fileDomain: strs(body.fileDomain),
      fitProfile: typeof body.fitProfile === "string" ? body.fitProfile : undefined,
      postedBy: typeof body.postedBy === "string" ? body.postedBy : undefined,
      postedAtSec: typeof body.postedAtSec === "number" ? body.postedAtSec : undefined,
    });
  }
  return out;
}

/** Wait current-state. Source precedence: projection/waits/ WITH files (the §8c formal source) else the
 *  control-log fold. "Dir exists but is empty" does NOT win — trusting an empty half-written directory
 *  while the log clearly holds open waits would flip the stall banner red by mistake. */
export function readWaits(home: string = homedir()): { waits: WaitRecord[]; source: BoardView["waitsSource"] } {
  const projWaits = path.join(projectionDir(home), "waits");
  try {
    const files = readdirSync(projWaits).filter((n) => n.endsWith(".json"));
    if (files.length) {
      const waits = files
        .map((n) => readJson<WaitRecord>(path.join(projWaits, n)))
        .filter((w): w is WaitRecord => !!w && typeof w.waitId === "string" && typeof w.state === "string");
      return { waits, source: "projection" };
    }
  } catch {
    // no projection waits yet — the normal state until projection-impl ships §8c
  }
  const logDir = path.join(swarmRoot(home), "control-log");
  let names: string[];
  try {
    names = readdirSync(logDir).filter((n) => n.endsWith(".json"));
  } catch {
    return { waits: [], source: "none" };
  }
  // ponytail: refold the whole log every snapshot (~hundreds of tiny files today); cache by mtime if it grows.
  const entries = names.map((n) => readJson<WaitLogEntry>(path.join(logDir, n))).filter((e): e is WaitLogEntry => !!e);
  return { waits: foldWaitLog(entries), source: "control-log" };
}

export function readProgressDoc(home: string = homedir()): { text: string; mtimeMs: number } | null {
  const file = path.join(swarmRoot(home), "PROGRESS.md");
  try {
    return { text: readFileSync(file, "utf8").slice(0, 20_000), mtimeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** Done items whose consumption is not visible yet. Relation rule: a wait "consumes" an item when its
 *  waitId contains the itemId (the coord-<itemId> convention) — stated here because it is a naming
 *  convention, not a schema field; a done item no wait ever mentions is shown as "consumer unknown". */
export function artifactGaps(items: BoardItem[], waits: WaitRecord[]): ArtifactGap[] {
  const out: ArtifactGap[] = [];
  for (const it of items) {
    if (it.status !== "done" || it.mtimeMs == null) continue;
    const related = waits.filter((w) => w.waitId.includes(it.itemId));
    const unresolved = related.find((w) => w.state === "open" || w.state === "action_pending");
    if (unresolved) {
      out.push({ itemId: it.itemId, doneAtMs: it.mtimeMs, waitId: unresolved.waitId, waitState: unresolved.state });
    } else if (related.length === 0) {
      out.push({ itemId: it.itemId, doneAtMs: it.mtimeMs, waitId: null, waitState: null });
    }
    // a resolved related wait = consumed; no row
  }
  return out;
}

/** 停摆定理. All-idle requires ≥1 peer and EVERY status === "idle" — an unknown status means we cannot
 *  see, and "cannot see" must not scream red. Incomplete = board item not done, or job not succeeded
 *  (a failed job is unfinished business too; assumption recorded in the done-report). */
export function stallVerdict(
  peerStatuses: string[],
  waits: WaitRecord[],
  items: BoardItem[],
  jobStatuses: string[],
): StallVerdict {
  const peersSeen = peerStatuses.length;
  const allIdle = peersSeen > 0 && peerStatuses.every((s) => s === "idle");
  const unresolvedWaits = waits.filter((w) => w.state === "open" || w.state === "action_pending").length;
  const openBoardItems = items.filter((i) => i.status !== "done").length;
  const incompleteJobs = jobStatuses.filter((s) => s !== "succeeded").length;
  const stalled = allIdle && unresolvedWaits === 0 && (openBoardItems > 0 || incompleteJobs > 0);
  return {
    stalled,
    peersSeen,
    allIdle,
    unresolvedWaits,
    openBoardItems,
    incompleteJobs,
    reason: stalled
      ? `all ${peersSeen} peer(s) idle, no unresolved wait, yet ${openBoardItems} board item(s) + ${incompleteJobs} job(s) unfinished`
      : "",
  };
}

/** The whole board view, assembled from the three transitional sources. Pure reads; never throws. */
export function readBoardView(home: string = homedir()): BoardView {
  const items = readBoard(home);
  const { waits, source } = readWaits(home);
  return { items, waits, waitsSource: source, progress: readProgressDoc(home), gaps: artifactGaps(items, waits) };
}

// --------------------------------------------------------------------------------------------------
// kanban-view (board-viz's second view): three columns + member swimlanes, over the SAME four read-only
// sources (board filenames / waits / status dir / heartbeat). Judgment-sink: columns, dep-gates, swimlane
// grouping and durations are all DERIVED here from observable files — the renderer only draws.
// --------------------------------------------------------------------------------------------------

/** status dir = <home>/.agenthop/status, files `<sessionId>.json.<seq>` (highest seq = current, same
 *  lock-free register as statusfile.ts). Returns the current {state,seq} per sessionId. Defensive. */
export function readStatuses(home: string = homedir()): Map<string, { state: string; seq: number }> {
  const dir = path.join(home, ".agenthop", "status");
  const cur = new Map<string, { state: string; seq: number }>();
  let names: string[];
  try { names = readdirSync(dir); } catch { return cur; }
  for (const name of names) {
    const m = /^(.+)\.json\.(\d+)$/.exec(name);
    if (!m) continue;
    const sessionId = m[1]!, seq = Number(m[2]);
    const prev = cur.get(sessionId);
    if (prev && prev.seq >= seq) continue;
    const body = readJson<{ state?: unknown }>(path.join(dir, name));
    const state = body && typeof body.state === "string" ? body.state : "unknown";
    cur.set(sessionId, { state, seq });
  }
  return cur;
}

export type Heartbeat = { instance?: string; pass?: { lastTickSec?: number; inFlight?: unknown; mode?: string }; sweep?: { lastTickSec?: number; inFlight?: unknown; mode?: string } };
/** dispatcher heartbeat (L1): <home>/.agenthop/swarm/heartbeat.json. null if absent. */
export function readHeartbeat(home: string = homedir()): Heartbeat | null {
  return readJson<Heartbeat>(path.join(swarmRoot(home), "heartbeat.json")) ?? null;
}

export type KanbanCard = {
  id: string;
  kind: "item" | "wait";
  owner: string | null;
  startSec: number | null;      // claim/post instant (item) or escalation instant (wait)
  deadlineSec: number | null;
  deps: string[];
  blocked: boolean;             // open item with an unmet dependency, or a wait awaiting a human
  status: string;               // board status or wait state
  note?: string;                // human-readable reason (dep-gate / automation-exhausted)
};
export type KanbanSwimlane = {
  member: string;               // claimant id (as on the board filename)
  state: string;                // live status (working/idle/…) or "unknown"
  sinceSec: number | null;      // working-since = oldest in-flight card's startSec (not a verified-output claim)
  cards: KanbanCard[];
};
export type KanbanView = {
  columns: { todo: KanbanCard[]; inProgress: KanbanCard[]; done: KanbanCard[] };
  swimlanes: KanbanSwimlane[];
  heartbeat: { passAgeSec: number | null; sweepAgeSec: number | null; inFlight: boolean } | null;
  generatedAtSec: number;
};

/** Compose the kanban view. Pure given the four sources; `nowSec` injectable for tests. */
export function readKanbanView(home: string = homedir(), nowSec: number = Math.floor(Date.now() / 1000)): KanbanView {
  const items = readBoard(home);
  const { waits } = readWaits(home);
  const statuses = readStatuses(home);
  const hb = readHeartbeat(home);
  const doneIds = new Set(items.filter((i) => i.status === "done").map((i) => i.itemId));

  // resolve a board claimant (short id on the filename) to a live status, matching by sessionId prefix.
  const statusOf = (who: string | null): { state: string; seq: number } | undefined => {
    if (!who) return undefined;
    if (statuses.has(who)) return statuses.get(who);
    for (const [sid, st] of statuses) if (sid.startsWith(who)) return st;
    return undefined;
  };

  const itemCard = (it: BoardItem): KanbanCard => {
    const unmet = it.status === "open" ? it.dependsOn.filter((d) => !doneIds.has(d)) : [];
    return {
      id: it.itemId, kind: "item", owner: it.claimant ?? it.postedBy ?? null,
      startSec: it.status === "open" ? (it.postedAtSec ?? null) : it.mtimeMs != null ? Math.floor(it.mtimeMs / 1000) : null,
      deadlineSec: null, deps: it.dependsOn, blocked: unmet.length > 0, status: it.status,
      ...(unmet.length ? { note: `waiting on ${unmet.join(", ")}` } : {}),
    };
  };
  const waitCard = (w: WaitRecord): KanbanCard => ({
    id: w.waitId, kind: "wait", owner: w.owner ?? null,
    startSec: typeof w.escalatedAt === "number" ? w.escalatedAt : null,
    deadlineSec: typeof w.deadlineSec === "number" ? w.deadlineSec : null, deps: [],
    blocked: !!w.automationExhausted, status: w.state,
    ...(w.automationExhausted ? { note: "automation stopped — awaiting a human (a legal state)" } : {}),
  });

  const openItems = items.filter((i) => i.status === "open").map(itemCard);
  // claimed = reservation applied; granted = admission committed (in-flight admitted work). Both are in-progress swimlane work;
  // rejected is a dead claim (re-posted/reaped next tick) ⇒ not a column. (admission 5/n; live by default — SWARM_BOARD_ADMIT=0 to kill.)
  const claimedItems = items.filter((i) => i.status === "claimed" || i.status === "granted").map(itemCard);
  const doneItems = items.filter((i) => i.status === "done").map(itemCard).sort((a, b) => (b.startSec ?? 0) - (a.startSec ?? 0));
  const openWaits = waits.filter((w) => w.state === "open" || w.state === "action_pending").map(waitCard);
  const resolvedWaits = waits.filter((w) => w.state === "resolved").map(waitCard);

  // swimlanes: in-flight ITEMS grouped by owner, plus members reporting "working" with no board item.
  const byOwner = new Map<string, KanbanCard[]>();
  for (const c of claimedItems) { const k = c.owner ?? "?"; (byOwner.get(k) ?? byOwner.set(k, []).get(k)!).push(c); }
  for (const [sid, st] of statuses) {
    if (st.state !== "working") continue;
    const short = sid.split("-")[0]!;
    const already = [...byOwner.keys()].some((k) => k === sid || k === short || sid.startsWith(k));
    if (!already) byOwner.set(short, []); // working but holding no board item — still "who's active"
  }
  const swimlanes: KanbanSwimlane[] = [...byOwner.entries()].map(([member, cards]) => {
    const st = statusOf(member);
    const starts = cards.map((c) => c.startSec).filter((s): s is number => s != null);
    return { member, state: st?.state ?? "unknown", sinceSec: starts.length ? Math.min(...starts) : st ? Math.floor(st.seq / 1000) : null, cards };
  }).sort((a, b) => b.cards.length - a.cards.length || a.member.localeCompare(b.member));

  const hbView = hb ? {
    passAgeSec: hb.pass?.lastTickSec != null ? nowSec - hb.pass.lastTickSec : null,
    sweepAgeSec: hb.sweep?.lastTickSec != null ? nowSec - hb.sweep.lastTickSec : null,
    inFlight: hb.pass?.inFlight != null || hb.sweep?.inFlight != null,
  } : null;

  return {
    columns: { todo: openItems, inProgress: [...claimedItems, ...openWaits], done: [...doneItems, ...resolvedWaits] },
    swimlanes, heartbeat: hbView, generatedAtSec: nowSec,
  };
}

// =============================================================================================
// worklog-timeline: the third viz view. worklog.jsonl is a time-axis PROJECTION of the control-log
// (written by the machine at its existing transform points via packages/bus/src/swarm/worklog.ts).
// Discipline C-2 still holds: this reader parses the FILE shape independently, it does not import bus.
// Judgment-sink: the builder emits faithful per-change lines; HERE we collapse flaps into bars + roll
// up "where did the time go" + flag stall blanks. (brain worklog-timeline, author 90b58f9c.)
// =============================================================================================

export interface WorklogEntry {
  ts: number; event: string; taskId: string; who: string; project: string; title: string; outcome?: string;
}
/** One task's life as a single bar: first start -> last done, with the flap count kept as a liveness hint. */
export interface TimelineBar {
  taskId: string; project: string; who: string; title: string;
  startSec: number; endSec: number | null; outcome: string | null;
  durationSec: number | null; progressTicks: number; stale: boolean; // open > 24h: factorylog auto-close hint
}
export interface TimelineGap { startSec: number; endSec: number; durationSec: number; }
export interface TimelineProjectTotal { project: string; totalSec: number; count: number; }
export interface TimelineDay { date: string; startSec: number; bars: TimelineBar[]; }
export interface TimelineView {
  bars: TimelineBar[]; // every task, newest start first
  days: TimelineDay[]; // grouped by LOCAL date, newest first (timeline / swimlane render)
  byProject: TimelineProjectTotal[]; // closed-duration rollup = the pie, "where did the time go"
  gaps: TimelineGap[]; // windows with nothing in progress, longer than the threshold (render red)
  spanSec: { from: number; to: number } | null;
  generatedAtSec: number;
}

const STALL_GAP_SEC = 15 * 60; // 15 min with nothing in progress = a blank worth flagging red
const STALE_OPEN_SEC = 24 * 3600; // factorylog: an entry still open after 24h is treated as auto-closed

/** unix seconds -> local YYYY-MM-DD (the log is for humans, so group by the machine's calendar day). */
function localDate(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse worklog.jsonl (file shape = the whole contract). Torn/malformed tail lines are skipped, the rest kept. */
export function readWorklog(home: string = homedir()): WorklogEntry[] {
  const f = path.join(home, ".agenthop", "swarm", "worklog.jsonl");
  if (!existsSync(f)) return [];
  const out: WorklogEntry[] = [];
  for (const raw of readFileSync(f, "utf8").split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (o && typeof o.ts === "number" && typeof o.event === "string" && typeof o.taskId === "string") {
        out.push({
          ts: o.ts, event: o.event, taskId: o.taskId,
          who: typeof o.who === "string" ? o.who : "",
          project: typeof o.project === "string" ? o.project : "",
          title: typeof o.title === "string" ? o.title : o.taskId,
          ...(o.outcome != null ? { outcome: String(o.outcome) } : {}),
        });
      }
    } catch {
      /* a half-written append tail: skip this line, keep the rest */
    }
  }
  return out;
}

/** Collapse per-task flaps into bars, roll up project time, and find the stall blanks. Pure (selftestable). */
export function foldTimeline(entries: WorklogEntry[], nowSec: number): TimelineView {
  const byTask = new Map<string, WorklogEntry[]>();
  for (const e of entries) (byTask.get(e.taskId) ?? byTask.set(e.taskId, []).get(e.taskId)!).push(e);

  const bars: TimelineBar[] = [];
  for (const [taskId, evs] of byTask) {
    const sorted = [...evs].sort((a, b) => a.ts - b.ts);
    const starts = sorted.filter((e) => e.event === "start");
    const dones = sorted.filter((e) => e.event === "done");
    const progress = sorted.filter((e) => e.event === "progress");
    const first = starts[0] ?? sorted[0]!;
    const last = dones.length ? dones[dones.length - 1]! : null;
    const startSec = first.ts;
    const endSec = last ? last.ts : null;
    const stale = endSec == null && nowSec - startSec > STALE_OPEN_SEC;
    bars.push({
      taskId, project: first.project, who: first.who, title: first.title || taskId,
      startSec, endSec, outcome: last?.outcome ?? null,
      durationSec: endSec != null ? Math.max(0, endSec - startSec) : null,
      progressTicks: progress.length, stale,
    });
  }
  bars.sort((a, b) => b.startSec - a.startSec);

  // project rollup: sum CLOSED durations (an open bar contributes no measurable time, only a count).
  const proj = new Map<string, { totalSec: number; count: number }>();
  for (const b of bars) {
    const p = proj.get(b.project) ?? { totalSec: 0, count: 0 };
    p.count++;
    p.totalSec += b.durationSec ?? 0;
    proj.set(b.project, p);
  }
  const byProject = [...proj.entries()]
    .map(([project, v]) => ({ project, ...v }))
    .sort((a, b) => b.totalSec - a.totalSec || b.count - a.count);

  // gaps: merge every [start, end] interval (open bars extend to now); a hole wider than the threshold is a stall.
  const iv = bars
    .map((b) => [b.startSec, b.endSec ?? nowSec] as [number, number])
    .filter(([s, e]) => e >= s)
    .sort((a, b) => a[0] - b[0]);
  const gaps: TimelineGap[] = [];
  if (iv.length) {
    let curEnd = iv[0]![1];
    for (let i = 1; i < iv.length; i++) {
      const [s, e] = iv[i]!;
      if (s > curEnd) {
        if (s - curEnd >= STALL_GAP_SEC) gaps.push({ startSec: curEnd, endSec: s, durationSec: s - curEnd });
        curEnd = e;
      } else if (e > curEnd) {
        curEnd = e;
      }
    }
  }

  const dayMap = new Map<string, TimelineBar[]>();
  for (const b of bars) (dayMap.get(localDate(b.startSec)) ?? dayMap.set(localDate(b.startSec), []).get(localDate(b.startSec))!).push(b);
  const days: TimelineDay[] = [...dayMap.entries()]
    .map(([date, bs]) => ({ date, startSec: Math.min(...bs.map((b) => b.startSec)), bars: bs }))
    .sort((a, b) => b.startSec - a.startSec);

  const allTs = entries.map((e) => e.ts);
  const spanSec = allTs.length ? { from: Math.min(...allTs), to: Math.max(...allTs) } : null;
  return { bars, days, byProject, gaps, spanSec, generatedAtSec: nowSec };
}

export function readTimelineView(home: string = homedir(), nowSec: number = Math.floor(Date.now() / 1000)): TimelineView {
  return foldTimeline(readWorklog(home), nowSec);
}
