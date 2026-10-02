// Single-active swarm dispatcher (git-channel pivot). The AUTHORITY: its trusted off-box clock drives the hard
// deadline, it OBSERVES each box's WORK branch (pin a SHA -> fetch it -> read manifest FROM it -> merge-base
// ancestry guard) through the pure acceptance guard, maintains the control records, and orchestrates handoff. The
// box supervisor only publishes; the dispatcher decides.
//
// SCOPE (v1, honest): control state is kept in a LOCAL mirror (~/.agenthop/swarm/control, also read by swarm-viz)
// and is authoritative for THIS machine / a same-machine restart. The cross-machine CONTROL ref + expected-OID CAS
// (so a box allocated-but-not-yet-pushed survives a dispatcher-MACHINE loss, and concurrent dispatchers are safe)
// is a documented follow-up — this build assumes a single dispatcher instance. The handoff EXEC path calls
// swarm-launch.sh and awaits the successor's resumed ACK on the bus; it needs the launcher's resume wiring and is
// validated only in the gated live run.
//
// Usage:
//   npx tsx scripts/swarm-dispatch.ts                 # run the loop (single-active)
//   npx tsx scripts/swarm-dispatch.ts --observe-once <workRepo> <branch> <launchId> <generation> [lastSha]
//     # dev: observe one branch, print the acceptance decision, exit (offline-smoke-testable)
//
// env: AGENTHOP_TEAM, AGENTHOP_RELAY, SWARM_WORK_REPO (git URL / path), SWARM_CAP (3), SWARM_BUDGET_SEC (3480),
//      SWARM_HANDOFF_LEAD_SEC (180), SWARM_LAUNCH (scripts/swarm-launch.sh), AH_HOME, SWARM_SELF.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  advance,
  type ControlEvent,
  type ControlRecord,
  likelyExpired,
  nextAction,
} from "../packages/bus/src/swarm/control.js";
import { parseManifest } from "../packages/bus/src/swarm/manifest.js";
import { type ObservedTip, tipToEvent } from "../packages/bus/src/swarm/acceptance.js";

const HOME = process.env.AH_HOME ?? homedir();
const MIRROR_DIR = path.join(HOME, ".agenthop", "swarm", "control");
const KEYDIR_GLOB = "/tmp"; // throwaway keydirs live at /tmp/ah-rwkey-rw-*
const SELF = process.env.SWARM_SELF || `disp-${process.pid}`;
const CAP = Number(process.env.SWARM_CAP || "3");
const BUDGET_SEC = Number(process.env.SWARM_BUDGET_SEC || "3480");
const HANDOFF_LEAD_SEC = Number(process.env.SWARM_HANDOFF_LEAD_SEC || "180");
const WORK_REPO = process.env.SWARM_WORK_REPO || "";
const GIT_TIMEOUT_MS = 25_000;

function log(m: string): void { console.error(`[dispatch ${SELF}] ${m}`); }
function nowSec(): number { return Math.floor(Date.now() / 1000); }
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

// --- async bounded git ---
function git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: opts.cwd });
    let stdout = "", stderr = "", done = false;
    const finish = (code: number) => { if (!done) { done = true; resolve({ code, stdout, stderr }); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", () => finish(-1));
    child.on("close", (c) => { clearTimeout(timer); finish(c ?? -1); });
  });
}

// --- git observation of a WORK branch: pin the tip SHA, fetch it, read manifest FROM it, ancestry-guard ---
async function observeTip(workRepo: string, branch: string, lastAcceptedSha: string | undefined, scratchDir: string): Promise<ObservedTip | null> {
  const ls = await git(["ls-remote", workRepo, `refs/heads/${branch}`]);
  if (ls.code !== 0) { log(`ls-remote ${branch}: ${ls.stderr.trim()}`); return null; }
  const sha = ls.stdout.split(/\s+/)[0]?.trim();
  if (!sha) return null; // branch does not exist yet

  // a bare scratch repo per work repo to fetch objects into (so we can read a pinned sha + check ancestry)
  mkdirSync(scratchDir, { recursive: true });
  if (!existsSync(path.join(scratchDir, "HEAD"))) await git(["init", "-q", "--bare", scratchDir]);
  const fetch = await git(["fetch", "-q", workRepo, sha], { cwd: scratchDir });
  if (fetch.code !== 0) {
    // some servers refuse fetch-by-sha; fall back to fetching the branch ref
    const fb = await git(["fetch", "-q", workRepo, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: scratchDir });
    if (fb.code !== 0) { log(`fetch ${sha}: ${fetch.stderr.trim()}`); return null; }
  }
  const show = await git(["show", `${sha}:.swarm/manifest.json`], { cwd: scratchDir });
  const manifest = show.code === 0 ? parseManifest(show.stdout) : null;

  let isDescendant = true;
  if (lastAcceptedSha && lastAcceptedSha !== sha) {
    const anc = await git(["merge-base", "--is-ancestor", lastAcceptedSha, sha], { cwd: scratchDir });
    // exit 0 => ancestor (descendant tip); exit 1 => not; other => unknown -> be safe, reject
    isDescendant = anc.code === 0;
  }
  return { sha, manifest, isDescendantOfAccepted: isDescendant };
}

// --- local mirror (authoritative for v1; also what swarm-viz reads) ---
function mirrorPath(launchId: string): string { return path.join(MIRROR_DIR, `${launchId}.json`); }
function loadMirror(): Map<string, ControlRecord> {
  const m = new Map<string, ControlRecord>();
  if (!existsSync(MIRROR_DIR)) return m;
  for (const f of readdirSync(MIRROR_DIR)) {
    if (!f.endsWith(".json")) continue;
    try { const r = JSON.parse(readFileSync(path.join(MIRROR_DIR, f), "utf8")) as ControlRecord; m.set(r.launchId, r); } catch {}
  }
  return m;
}
function saveRecord(r: ControlRecord): void { mkdirSync(MIRROR_DIR, { recursive: true }); atomicWrite(mirrorPath(r.launchId), JSON.stringify(r)); }

function applyEvent(r: ControlRecord, ev: ControlEvent): ControlRecord {
  const res = advance(r, ev, nowSec());
  if (!res.ok) { log(`event ${ev.type} on ${r.launchId} rejected: ${res.error}`); return r; }
  saveRecord(res.record);
  return res.record;
}

// --- discover boxes this dispatcher launched (keydirs carry launchId + alloc-ts) ---
function discoverBoxes(): Array<{ launchId: string; allocTs: number }> {
  const out: Array<{ launchId: string; allocTs: number }> = [];
  for (const d of readdirSync(KEYDIR_GLOB)) {
    if (!d.startsWith("ah-rwkey-rw-")) continue;
    const dir = path.join(KEYDIR_GLOB, d);
    const tsFile = path.join(dir, "alloc-ts");
    if (!existsSync(tsFile)) continue;
    try { out.push({ launchId: d.replace("ah-rwkey-", ""), allocTs: Number(readFileSync(tsFile, "utf8").trim()) }); } catch {}
  }
  return out;
}

function notifyUser(msg: string): void {
  log(`NOTIFY: ${msg}`);
  if (process.platform === "darwin") spawn("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "swarm"`]).unref?.();
}

function branchFor(r: ControlRecord): string { return `swarm/${r.launchId}-g${r.generation}`; }

// --- the --observe-once dev mode (offline-smoke-testable) ---
async function observeOnce(argv: string[]): Promise<void> {
  const [workRepo, branch, launchId, genStr, lastSha] = argv;
  if (!workRepo || !branch || !launchId || !genStr) { console.error("usage: --observe-once <workRepo> <branch> <launchId> <generation> [lastSha]"); process.exit(2); }
  const record: ControlRecord = { launchId: launchId!, state: "RUNNING", generation: Number(genStr), allocStart: nowSec(), budgetSec: BUDGET_SEC, updatedAt: nowSec(), sha: lastSha };
  const tip = await observeTip(workRepo!, branch!, lastSha, path.join(HOME, ".agenthop", "swarm", "scratch", launchId!));
  console.log(JSON.stringify({ tip, decision: tip ? tipToEvent(record, tip) : null }, null, 2));
}

// --- one control-loop pass (observe + authoritative clock + nextAction) ---
async function pass(records: Map<string, ControlRecord>): Promise<void> {
  const boxes = new Map(discoverBoxes().map((b) => [b.launchId, b]));
  // Iterate the UNION of keydir-discovered boxes AND persisted mirror records (Codex #7): a box whose keydir
  // vanished but whose record is still non-terminal (e.g. EXPIRED needing a successor) must still be processed,
  // including after a same-machine restart.
  const ids = new Set<string>([...boxes.keys(), ...records.keys()]);
  const liveCount = [...records.values()].filter((r) => r.state !== "RETIRED" && r.state !== "DONE").length;

  for (const launchId of ids) {
    const box = boxes.get(launchId);
    let r = records.get(launchId);
    if (!r) {
      if (!box) continue; // id came from neither source somehow
      r = { launchId, state: "RUNNING", generation: 0, allocStart: box.allocTs, budgetSec: BUDGET_SEC, updatedAt: nowSec(), deadlineEpoch: box.allocTs + BUDGET_SEC };
    }
    records.set(launchId, r);
    if (r.state === "RETIRED" || r.state === "DONE") continue; // terminal: nothing to do

    // 1) observe the WORK branch and accept forward progress. `sha` is the single canonical confirmed checkpoint
    //    (monotonic via the dispatcher's ancestry guard; recover_sha advances it even after EXPIRED).
    if (WORK_REPO) {
      const tip = await observeTip(WORK_REPO, branchFor(r), r.sha, path.join(HOME, ".agenthop", "swarm", "scratch", r.launchId));
      if (tip) {
        const dec = tipToEvent(r, tip);
        if (dec.kind === "advance") r = applyEvent(r, dec.event);
      }
    }

    // 2) authoritative clock: near the (dispatcher-owned) deadline, begin draining for handoff
    const deadline = r.allocStart + r.budgetSec;
    if (r.state === "RUNNING" && nowSec() >= deadline - HANDOFF_LEAD_SEC) {
      r = applyEvent(r, { type: "drain" });
      log(`${r.launchId} entering DRAINING (T-${deadline - nowSec()}s)`);
      // nudge the worker over the bus to drain+final (best-effort; the supervisor also rescues independently)
    }
    // 3) if the box is likely physically gone, record EXPIRED so recovery still runs
    if (r.state !== "RETIRED" && r.state !== "DONE" && r.state !== "EXPIRED" && likelyExpired(r, nowSec())) {
      r = applyEvent(r, { type: "expire" });
      notifyUser(`box ${r.launchId} expired; recoverySha=${r.sha ?? "none"}`);
    }

    // 4) drive handoff via the pure decision
    const action = nextAction(r, nowSec(), { self: SELF, cap: CAP, liveCount });
    if (action === "claim") { log(`${r.launchId}: would claim + allocate successor (handoff exec — gated live wiring)`); }
    else if (action === "give_up") { notifyUser(`box ${r.launchId}: allocation attempts exhausted; manual attention`); }
    // claim/allocate/reconcile/retire EXEC (swarm-launch + resumed-ACK barrier) lands with the launcher wiring.

    // Persist the ADVANCED record back into the Map so the next pass sees DRAINING/CHECKPOINTED/... (Codex #3:
    // without this the Map kept the stale RUNNING record and re-DRAINed forever, never accepting a final).
    records.set(launchId, r);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--observe-once") { await observeOnce(argv.slice(1)); return; }

  log(`single-active dispatcher up (cap=${CAP}, budget=${BUDGET_SEC}s, workRepo=${WORK_REPO || "<unset>"})`);
  const records = loadMirror();
  for (;;) {
    try { await pass(records); } catch (e) { log(`pass error: ${e instanceof Error ? e.message : e}`); }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

void main();
