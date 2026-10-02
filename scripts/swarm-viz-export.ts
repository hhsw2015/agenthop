// READ-ONLY swarm observability exporter. Joins the bus as a clean observer (no send, no status writes),
// polls the unified peer roster every ~2s, merges in any local lifecycle records, and serves a live
// snapshot to a single-file page.
//
//   tsx scripts/swarm-viz-export.ts                 # http://127.0.0.1:8791
//   tsx scripts/swarm-viz-export.ts --port 9000     # different port
//   tsx scripts/swarm-viz-export.ts --once          # write the snapshot file and exit
//   tsx scripts/swarm-viz-export.ts --selftest      # pure-logic checks, no bus
//
// To see the Railway boxes, run with the team secret in env and codex's socket unset:
//   AGENTHOP_TEAM=<team> AGENTHOP_RELAY=<relay> AGENTHOP_NO_CODEX=1 env -u CLAUDE_CODE_MESSAGING_SOCKET \
//     tsx scripts/swarm-viz-export.ts
//
// READ-ONLY: this process never calls core.send() and never calls setStatus(). It does register as a bus
// session (that is how discovery works), so it appears on other machines' rosters as a phantom node; we
// drop our own row from the snapshot and export observerId so the page can label it.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBusCore } from "../packages/bus/src/core.js";
import { readMsgLogDays, msgLogEnabled, payloadLoggingEnabled, type MsgLogEntry as BusMsgLogEntry } from "../packages/bus/src/msglog.js";
import { readTasks } from "../packages/bus/src/tasklog.js";
import type { UnifiedPeer } from "../packages/bus/src/resolve.js";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Mirrors packages/bus/src/swarm/control.ts ControlRecord. Declared locally so we never import swarm
 *  code being actively edited elsewhere. Fields beyond launchId/state may be absent on older writes. */
export type ControlRecord = {
  launchId: string;
  state: "RUNNING" | "DRAINING" | "CHECKPOINTED" | "CLAIMED" | "ALLOCATING" | "RESUMED" | "RETIRED" | "DONE" | "EXPIRED";
  generation?: number;
  sha?: string;
  manifest?: string;
  owner?: string;
  leaseUntil?: number;
  attempt?: string;
  successor?: string;
  lastConfirmedSha?: string;
  allocStart?: number;
  budgetSec?: number;
  updatedAt?: number;
  deadlineEpoch?: number;
};

export type ControlSlot = ControlRecord | null;

export type VizNode = UnifiedPeer & {
  /** Which machine card this node sits in (hostname, or "local"). */
  machine: string;
  /** Index into the boxes array when this peer maps to a Railway box, else -1. */
  boxIndex: number;
  /**
   * OPTIONAL bus-provided activity, absent until the bus records message metadata. When present the page
   * draws a live directional edge and a "talking now" indicator. Contract agreed with the bus owner:
   * added to the roster alongside the msglog writer.
   */
  lastMessageAt?: number;
  lastPeerId?: string;
};

/** One line of the opt-in, metadata-only message journal (shared definition lives in the bus). */
export type MsgLogEntry = BusMsgLogEntry;

/** A directed flow between two peers, folded from the journal. */
export type VizFlow = {
  from: string;
  to: string;
  via: "local" | "relay";
  count: number;
  lastTs: number;
  bytes: number;
};

/** A node that was present in the previous snapshot and is gone now — an event, not a missing row. */
export type VizDeparture = { id: string; title: string; machine: string; lastSeen: number };

export type VizBox = {
  launchId: string;
  shortId: string;
  /** Epoch SECONDS the box's allocation window ends, or null when unknown. */
  deadlineEpoch: number | null;
  /** Where deadlineEpoch came from: the record, or the local reuse-window file. */
  deadlineSource: "record" | "alloc-ts" | "none";
  /** Epoch seconds the box was allocated, if known. */
  allocStart: number | null;
  /** Full control record, or null when phase-2 has not written one for this launchId yet. */
  control: ControlSlot;
  /** Index of the peer node for this box, or -1 when no bus peer matched. */
  nodeIndex: number;
  /** Lifecycle generation, folded here so the page does not dig into control. */
  generation: number | null;
  /** Last confirmed checkpoint sha, for display. */
  sha: string | null;
  /** repo@branch this box is working on, when the record carries it. */
  repo: string | null;
  branch: string | null;
};

/** One "task" as it can be known TODAY: the lifecycle of a single launch. The richer fan-out / gather /
 *  verdict layer (roadmap Layer 1/2) has no data yet — see TaskFile for the slot it will land in. */
export type VizTask = {
  taskId: string;
  assignees: string[];
  state: string;
  createdAt: number | null;
  /** Last state change. The task river draws a band from createdAt to here; without it a finished
   *  task has no span and collapses to a zero-width sliver. */
  updatedAt: number | null;
  goal?: string;
  role?: string;
  results: Array<{ launchId: string; state: string; sha?: string; costUsd?: number }>;
  /** True for a row synthesized from the control mirror — the only kind that exists today. */
  fromControlMirror: boolean;
};

/** The future task-envelope file (roadmap Layer 1/2), read as a passthrough so the page renders it the
 *  moment it appears. Shape agreed with the bus owner: metadata-only, at <home>/.agenthop/swarm/tasks/. */
export type TaskFile = {
  taskId: string;
  dispatchedBy?: string;
  assignees?: string[];
  state?: string;
  createdAt?: number;
  updatedAt?: number;
  goal?: string;
  role?: string;
  results?: Array<{
    launchId: string;
    state: string;
    sha?: string;
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  }>;
  [k: string]: unknown;
};

export type VizEdge = {
  from: string; // launchId
  to: string; // successor launchId
};

export type Snapshot = {
  generatedAt: number;
  observerId: string;
  parser: "swarm-viz/3";
  /** The machine this exporter runs on, so the page can label the local group. */
  localMachine: string;
  /** Declared staleness ceiling for relay (cross-machine) presence; the page must label clocks apart. */
  relayStaleMs: number;
  pollMs: number;
  nodes: VizNode[];
  boxes: VizBox[];
  edges: VizEdge[];
  /** Message journal folded into per-pair flows. Empty until the bus writes the journal. */
  flows: VizFlow[];
  /** Total journal lines considered (0 when the journal does not exist yet). */
  msgLogCount: number;
  /** Peers seen in the previous snapshot and absent now. */
  departures: VizDeparture[];
  /** Tasks. Today these are the lifecycle mirror, one per launchId; richer fan-out lands in tasks/*.json. */
  tasks: VizTask[];
  /** The raw journal lines for today, so the page can show a per-pair history without a second endpoint.
   *  Metadata only; `text` is present only when the bus was explicitly told to log payloads. */
  events: MsgLogEntry[];
  /** True when the journal carried payloads — lets the page say why bodies are missing. */
  payloadLogged: boolean;
  /** Whether the bus has message logging switched on here. Distinguishes "off" from "on but quiet". */
  msgLogEnabled: boolean;
};

// ---------------------------------------------------------------------------------------------
// Pure logic (selftest-covered)
// ---------------------------------------------------------------------------------------------

/**
 * Match a control record to a bus peer. The peer's title carries the launchId's SHORT id, not the full
 * one (title "railway:claude-edde1885" vs launchId "rw-edde1885") — so match the full launchId first
 * (in case a title ever carries it), then fall back to the short segment after the last "-". Returns the
 * index into `peers`, or -1.
 */
export function matchNode(peers: Pick<UnifiedPeer, "title">[], launchId: string): number {
  const full = peers.findIndex((p) => p.title.includes(launchId));
  if (full >= 0) return full;
  const short = shortId(launchId);
  return peers.findIndex((p) => p.title.includes(short));
}

/** The display short id for a launchId: the segment after the last "-". */
export function shortId(launchId: string): string {
  const i = launchId.lastIndexOf("-");
  return i >= 0 ? launchId.slice(i + 1) : launchId;
}

/**
 * A box's deadline in epoch SECONDS, or null. Precedence: an explicit record deadlineEpoch, else the
 * record's allocStart+budgetSec, else the local allocation timestamp file (alloc-ts + 3600). The local
 * file is the fallback that makes the countdown work before phase-2 ships.
 */
export function deadlineOf(
  control: ControlSlot,
  allocTsSec: number | null,
): { deadlineEpoch: number | null; source: "record" | "alloc-ts" | "none" } {
  if (control?.deadlineEpoch && Number.isFinite(control.deadlineEpoch)) {
    return { deadlineEpoch: control.deadlineEpoch, source: "record" };
  }
  if (control?.allocStart && control.budgetSec && Number.isFinite(control.allocStart + control.budgetSec)) {
    return { deadlineEpoch: control.allocStart + control.budgetSec, source: "record" };
  }
  if (allocTsSec && Number.isFinite(allocTsSec)) {
    return { deadlineEpoch: allocTsSec + 3600, source: "alloc-ts" };
  }
  return { deadlineEpoch: null, source: "none" };
}

/** Parse a control-record JSON blob. Malformed/partial (a reader racing a rename) degrades to null. */
export function parseControl(raw: string): ControlSlot {
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (!r || typeof r !== "object") return null;
    if (typeof r.launchId !== "string" || typeof r.state !== "string") return null;
    return r as unknown as ControlRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------------------------

/** home = AH_HOME ?? homedir(), ".agenthop" appended by us — matches statusfile.ts / core.ts. */
export function resolveHome(): string {
  return process.env.AH_HOME || homedir();
}

function controlDir(home: string): string {
  return path.join(home, ".agenthop", "swarm", "control");
}

/** Every readable control record, keyed by launchId. Absent dir / malformed file -> skipped. */
export function readControlRecords(home: string): Map<string, ControlSlot> {
  const out = new Map<string, ControlSlot>();
  const dir = controlDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // phase-2 not shipped yet
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp.")) continue;
    let rec: ControlSlot;
    try {
      rec = parseControl(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // read error / vanished mid-rename
    }
    if (rec) out.set(rec.launchId, rec);
  }
  return out;
}

/** launchIds that have a local allocation keydir on this machine, with their alloc timestamp (epoch s). */
export function readLocalAllocs(): Map<string, number> {
  const out = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync("/tmp").filter((n) => n.startsWith("ah-rwkey-"));
  } catch {
    return out;
  }
  for (const name of names) {
    const launchId = name.replace(/^ah-rwkey-/, "");
    try {
      const ts = Number(readFileSync(path.join("/tmp", name, "alloc-ts"), "utf8").trim());
      if (Number.isFinite(ts)) out.set(launchId, ts);
    } catch {
      // no alloc-ts yet (keydir created, box not confirmed)
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Message journal (metadata only) and future task envelopes
// ---------------------------------------------------------------------------------------------

/** Fold journal lines into directed per-pair flows, newest activity last. Pure. */
export function foldFlows(entries: MsgLogEntry[], limit = 60): VizFlow[] {
  const byPair = new Map<string, VizFlow>();
  // Both ends write a line for the same delivery when they share a home (sender "out", receiver "in"), so
  // fold each delivery once or every count and byte total reads 2x.
  const seen = new Set<string>();
  for (const e of entries) {
    const dk = `${e.from}|${e.to}|${e.size ?? ""}|${Math.round((e.ts ?? 0) / 500)}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    const via = e.via ?? "local";
    const key = `${e.from}\u0000${e.to}`;
    const prev = byPair.get(key);
    if (prev) {
      prev.count++;
      prev.bytes += e.size ?? 0;
      if (e.ts > prev.lastTs) prev.lastTs = e.ts;
    } else {
      byPair.set(key, { from: e.from, to: e.to, via, count: 1, lastTs: e.ts, bytes: e.size ?? 0 });
    }
  }
  return [...byPair.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, limit);
}

/** The newest result timestamp in ms epoch, or undefined. Task files carry seconds for the control
 *  mirror and ms for envelope files; callers normalize before passing. Pure. */
export function newestResultAt(results?: Array<{ at?: number; ts?: number }>): number | undefined {
  if (!Array.isArray(results) || !results.length) return undefined;
  const vals = results.map((r) => (typeof r.ts === "number" ? r.ts : r.at)).filter((v): v is number => typeof v === "number");
  return vals.length ? Math.max(...vals) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------------------------

export function buildSnapshot(
  peers: UnifiedPeer[],
  observerId: string,
  home: string,
  pollMs: number,
  prev?: Snapshot,
): Snapshot {
  const controls = readControlRecords(home);
  const allocs = readLocalAllocs();

  // Boxes = every launchId we know a record for OR a local keydir for. Control first (authoritative), then locals.
  const launchIds = new Set<string>([...controls.keys(), ...allocs.keys()]);
  const boxes: VizBox[] = [];
  for (const launchId of launchIds) {
    const control = controls.get(launchId) ?? null;
    const allocTs = allocs.get(launchId) ?? null;
    const { deadlineEpoch, source } = deadlineOf(control, allocTs);
    boxes.push({
      launchId,
      shortId: shortId(launchId),
      deadlineEpoch,
      deadlineSource: source,
      allocStart: control?.allocStart ?? allocTs,
      control,
      nodeIndex: -1,
      generation: control?.generation ?? null,
      sha: control?.sha ?? control?.lastConfirmedSha ?? null,
      repo: typeof (control as Record<string, unknown> | null)?.repo === "string" ? ((control as Record<string, unknown>).repo as string) : null,
      branch: typeof (control as Record<string, unknown> | null)?.branch === "string" ? ((control as Record<string, unknown>).branch as string) : null,
    });
  }

  const nodes: VizNode[] = [];
  for (const p of peers) {
    if (p.id === observerId) continue; // do not show ourselves as a swarm node
    const boxIndex = boxes.findIndex((b) => matchNode([p], b.launchId) === 0);
    if (boxIndex >= 0) boxes[boxIndex]!.nodeIndex = nodes.length;
    nodes.push({ ...p, machine: p.machine ?? "local", boxIndex });
  }

  // Handoff edges: the full predecessor -> successor SET, not just the first. A record whose successor
  // also has a record produces a chain the page can walk.
  const edges: VizEdge[] = [];
  for (const b of boxes) {
    if (b.control?.successor) edges.push({ from: b.launchId, to: b.control.successor });
  }

  // Message flows. Empty until the bus writes the journal; the page shows that honestly.
  // Two days so a session that ran across midnight does not lose the earlier half.
  const msgLog = readMsgLogDays(home, 2) as MsgLogEntry[];
  const flows = foldFlows(msgLog);

  // Departures: a peer in the previous snapshot that is absent now. An event, not just a missing row —
  // without this the page cannot distinguish "left" from "was never there".
  const nowIds = new Set(nodes.map((n) => n.id));
  const departures: VizDeparture[] = (prev?.nodes ?? [])
    .filter((p) => !nowIds.has(p.id))
    .map((p) => ({ id: p.id, title: p.title, machine: p.machine, lastSeen: p.statusAt ?? prev?.generatedAt ?? Date.now() }));

  const tasks = tasksFromSources(controls, readTasks(home) as unknown as TaskFile[]);

  return {
    generatedAt: Date.now(),
    observerId,
    parser: "swarm-viz/3",
    localMachine: hostname(),
    relayStaleMs: 60_000, // directory ANNOUNCE_MS — remote status/statusText lag up to this
    pollMs,
    nodes,
    boxes,
    edges,
    flows,
    msgLogCount: msgLog.length,
    departures,
    tasks,
    events: msgLog,
    payloadLogged: msgLog.some((e) => typeof e.text === "string" && e.text.length > 0),
    msgLogEnabled: msgLogEnabled(),
  };
}

/**
 * Tasks from the two sources that exist: the richer task-envelope files (empty today) and the control
 * mirror (one task per launchId). Files win; a launchId that already has a file task is not duplicated
 * from the mirror. Pure, so it is selftest-covered.
 */
export function tasksFromSources(controls: Map<string, ControlSlot>, files: TaskFile[]): VizTask[] {
  const out: VizTask[] = [];
  const covered = new Set<string>();
  for (const f of files) {
    out.push({
      taskId: f.taskId,
      assignees: f.assignees ?? [],
      state: f.state ?? "unknown",
      createdAt: f.createdAt ?? null,
      // Fall back to the newest result time when a file lacks updatedAt — an end is what the band needs.
      updatedAt: f.updatedAt ?? newestResultAt(f.results) ?? f.createdAt ?? null,
      ...(f.goal ? { goal: f.goal } : {}),
      ...(f.role ? { role: f.role } : {}),
      results: (f.results ?? []).map((r) => ({ launchId: r.launchId, state: r.state, sha: r.sha, costUsd: r.usage?.costUsd })),
      fromControlMirror: false,
    });
    for (const a of f.assignees ?? []) covered.add(a);
  }
  for (const [launchId, control] of controls) {
    if (covered.has(launchId)) continue;
    out.push({
      taskId: launchId,
      assignees: [launchId],
      state: control?.state ?? "unknown",
      createdAt: control?.allocStart != null ? control.allocStart * 1000 : null,
      updatedAt: control?.updatedAt != null ? control.updatedAt * 1000 : null,
      results: control ? [{ launchId, state: control.state, sha: control.sha ?? control.lastConfirmedSha }] : [],
      fromControlMirror: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTTP: serve the page at / and the snapshot at /state.json
// ---------------------------------------------------------------------------------------------

function loadPage(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.join(here, "..", "web", "swarm-viz.html");
  try {
    return readFileSync(p, "utf8");
  } catch {
    return `<h1>swarm-viz</h1><p>Page not found at ${p}. Fetch <a href="/state.json">/state.json</a> directly.</p>`;
  }
}

// ---------------------------------------------------------------------------------------------
// Selftest: the pure matching + deadline logic
// ---------------------------------------------------------------------------------------------

function selftest(): void {
  const t = (name: string, cond: boolean) => {
    if (!cond) throw new Error(`selftest FAILED: ${name}`);
    console.log(`ok  ${name}`);
  };

  t("shortId takes the last segment", shortId("rw-edde1885") === "edde1885" && shortId("edde1885") === "edde1885");
  t(
    "matchNode finds the peer whose title carries the short id",
    matchNode([{ title: "railway:claude-edde1885" }, { title: "claude:Work-01a0" }], "rw-edde1885") === 0,
  );
  t("matchNode also accepts a title carrying the full launchId", matchNode([{ title: "box rw-edde1885" }], "rw-edde1885") === 0);
  t("matchNode misses cleanly", matchNode([{ title: "claude:Work-01a0" }], "rw-nope") === -1);

  const rec: ControlRecord = { launchId: "rw-x", state: "RUNNING", allocStart: 1000, budgetSec: 3600 };
  t("deadline from allocStart+budgetSec", deadlineOf(rec, null).deadlineEpoch === 4600);
  t("explicit deadlineEpoch wins", deadlineOf({ ...rec, deadlineEpoch: 9999 }, 500).deadlineEpoch === 9999);
  t("alloc-ts fallback when no record", deadlineOf(null, 2000).deadlineEpoch === 5600);
  t("no data -> null", deadlineOf(null, null).deadlineEpoch === null && deadlineOf(null, null).source === "none");
  t("partial record (no budget) falls through to alloc-ts", deadlineOf({ launchId: "rw-y", state: "RUNNING" }, 100).source === "alloc-ts");

  t("parseControl rejects malformed JSON", parseControl("{ not json") === null);
  t("parseControl rejects a missing id", parseControl('{"state":"RUNNING"}') === null);
  t("parseControl accepts a record", parseControl('{"launchId":"rw-z","state":"RUNNING"}')?.launchId === "rw-z");

  // Message flows: fold journal lines into directed per-pair counts, newest first.
  const j: MsgLogEntry[] = [
    { ts: 100, from: "a", to: "b", direction: "out", size: 10 },
    { ts: 200, from: "a", to: "b", direction: "out", size: 5 },
    { ts: 300, from: "b", to: "a", direction: "in", size: 2 },
  ];
  const flows = foldFlows(j);
  t("foldFlows makes one entry per ordered pair", flows.length === 2);
  t("foldFlows counts repeats and sums bytes", flows.find((f) => f.from === "a" && f.to === "b")!.count === 2 && flows.find((f) => f.from === "a" && f.to === "b")!.bytes === 15);
  t("foldFlows orders by last activity", flows[0]!.from === "b" && flows[0]!.to === "a");
  t("a direction is preserved (a->b is not the same flow as b->a)", flows.every((f) => f.from !== f.to));

  // A shared-home exchange is logged twice (sender "out", receiver "in"); folding must count it once.
  const dup = foldFlows([
    { ts: 500, from: "a", to: "b", direction: "out", size: 10, via: "local" },
    { ts: 520, from: "a", to: "b", direction: "in", size: 10, via: "local" },
  ]);
  t("a double-logged delivery folds to ONE flow", dup.length === 1);
  t("its count is 1, not 2", dup[0]!.count === 1);
  t("its bytes are not doubled", dup[0]!.bytes === 10);
  const far = foldFlows([
    { ts: 500, from: "a", to: "b", direction: "out", size: 10, via: "local" },
    { ts: 9000, from: "a", to: "b", direction: "out", size: 10, via: "local" },
  ]);
  t("two genuinely separate sends are NOT merged", far[0]!.count === 2);

  // Tasks: files win over the control mirror; a covered assignee is not duplicated.
  const files: TaskFile[] = [{ taskId: "t1", assignees: ["rw-a"], state: "RUNNING", results: [{ launchId: "rw-a", state: "working" }] }];
  const controls = new Map<string, ControlSlot>([
    ["rw-a", { launchId: "rw-a", state: "RUNNING" }],
    ["rw-b", { launchId: "rw-b", state: "EXPIRED" }],
  ]);
  const tasks = tasksFromSources(controls, files);
  t("task files win; the mirror fills the rest", tasks.length === 2);
  t("a file task is marked as such", tasks.find((x) => x.taskId === "t1")!.fromControlMirror === false);
  t("the mirror task is marked as such", tasks.find((x) => x.taskId === "rw-b")!.fromControlMirror === true);
  t("a covered launchId is not duplicated from the mirror", tasks.filter((x) => x.taskId === "rw-a" && x.fromControlMirror).length === 0);

  console.log("all selftests passed");
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

function writeSnapshot(snap: Snapshot): void {
  const file = path.join(resolveHome(), ".agenthop", "swarm-viz.json");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
  } catch (error) {
    console.error(`could not write ${file}:`, error);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    selftest();
    return;
  }
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.SWARM_VIZ_PORT ?? 8791);
  const once = args.includes("--once");
  const pollMs = 2000;
  const home = resolveHome();

  if (once) {
    const core = startBusCore({ home: process.env.AH_HOME });
    // A brief settle so the local broker + one relay announce land before we read the roster.
    await new Promise((r) => setTimeout(r, 1500));
    const snap = buildSnapshot(core.peers(), core.self.id, home, pollMs);
    writeSnapshot(snap);
    await core.close();
    process.exit(0);
  }

  const core = startBusCore({ home: process.env.AH_HOME });
  let latest: Snapshot = buildSnapshot(core.peers(), core.self.id, home, pollMs);

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/index")) {
      // Read per request, not once at startup: editing the page then reloading the browser is the whole
      // edit loop, and a cached copy silently serves the old layout.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loadPage());
      return;
    }
    if (req.url?.startsWith("/state.json")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(latest));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });

  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await core.close();
    process.exit(0);
  };
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") console.error(`port ${port} is in use — pick another with --port <n>`);
    else console.error("server error:", error);
    void shutdown();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`swarm-viz on http://127.0.0.1:${port}  (observer ${core.self.title})`);
  });

  let lastWrite = 0;
  const timer = setInterval(() => {
    try {
      latest = buildSnapshot(core.peers(), core.self.id, home, pollMs, latest);
      // Persist at most every 2s so headless viewers see the same data.
      if (Date.now() - lastWrite >= 2000) {
        writeSnapshot(latest);
        lastWrite = Date.now();
      }
    } catch (error) {
      console.error("snapshot failed:", error);
    }
  }, pollMs);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when invoked directly (allow importing the pure functions in a test).
const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) void main();
