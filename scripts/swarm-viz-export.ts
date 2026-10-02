// READ-ONLY swarm observability exporter. Joins the bus as a clean observer (no send, no status writes),
// polls the unified peer roster every ~2s, merges in any local lifecycle records, and serves a live
// snapshot to a single-file page.
//
//   tsx scripts/swarm-viz-export.ts                 # http://127.0.0.1:8790
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
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBusCore } from "../packages/bus/src/core.js";
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
  /** Index into the boxes array when this peer maps to a Railway box, else -1. */
  boxIndex: number;
  /** True for the observer's own row (filtered out before serialization; kept in the type for clarity). */
  isObserver: boolean;
};

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
};

export type Snapshot = {
  generatedAt: number;
  observerId: string;
  parser: "swarm-viz/1";
  /** Declared staleness ceiling for relay (cross-machine) presence; the page must label clocks apart. */
  relayStaleMs: number;
  pollMs: number;
  nodes: VizNode[];
  boxes: VizBox[];
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
// Snapshot assembly
// ---------------------------------------------------------------------------------------------

export function buildSnapshot(
  peers: UnifiedPeer[],
  observerId: string,
  home: string,
  pollMs: number,
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
    });
  }

  const nodes: VizNode[] = [];
  for (const p of peers) {
    if (p.id === observerId) continue; // do not show ourselves as a swarm node
    const boxIndex = boxes.findIndex((b) => matchNode([p], b.launchId) === 0);
    if (boxIndex >= 0) boxes[boxIndex]!.nodeIndex = nodes.length;
    nodes.push({ ...p, boxIndex, isObserver: false });
  }
  // A box with no matching peer still counts as a node-less box (nodeIndex stays -1).

  return {
    generatedAt: Date.now(),
    observerId,
    parser: "swarm-viz/1",
    relayStaleMs: 60_000, // directory ANNOUNCE_MS — remote status/statusText lag up to this
    pollMs,
    nodes,
    boxes,
  };
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
    "matchNode finds the peer whose title contains the launchId",
    matchNode([{ title: "railway:claude-edde1885" }, { title: "claude:Work-01a0" }], "rw-edde1885") === 0,
  );
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

  console.log("all selftests passed");
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    selftest();
    return;
  }
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.SWARM_VIZ_PORT ?? 8790);
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
  const page = loadPage();

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
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
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`port ${port} is in use — pick another with --port <n>`);
    } else {
      console.error("server error:", error);
    }
    void shutdown();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`swarm-viz on http://127.0.0.1:${port}  (observer ${core.self.title})`);
  });

  let lastWrite = 0;
  const timer = setInterval(() => {
    try {
      latest = buildSnapshot(core.peers(), core.self.id, home, pollMs);
      // Persist at most every 2s so headless viewers see the same data.
      if (Date.now() - lastWrite >= 2000) {
        writeSnapshot(latest);
        lastWrite = Date.now();
      }
    } catch (error) {
      console.error("snapshot failed:", error);
    }
  }, pollMs);

  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await core.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function writeSnapshot(snap: Snapshot): void {
  const home = snap.observerId ? resolveHome() : homedir();
  const file = path.join(home, ".agenthop", "swarm-viz.json");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
  } catch (error) {
    console.error(`could not write ${file}:`, error);
  }
}

// Only run when invoked directly (allow importing the pure functions in a test).
const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) void main();
