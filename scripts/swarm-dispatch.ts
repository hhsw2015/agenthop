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
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ControlRecord } from "../packages/bus/src/swarm/control.js";
import { parseManifest } from "../packages/bus/src/swarm/manifest.js";
import { type ObservedTip, tipToEvent } from "../packages/bus/src/swarm/acceptance.js";
import { type HandoffOps, handoffStep } from "../packages/bus/src/swarm/dispatch-step.js";

const HOME = process.env.AH_HOME ?? homedir();
const MIRROR_DIR = path.join(HOME, ".agenthop", "swarm", "control");
const KEYDIR_GLOB = "/tmp"; // throwaway keydirs live at /tmp/ah-rwkey-rw-*
const SELF = process.env.SWARM_SELF || `disp-${process.pid}`;
const CAP = Number(process.env.SWARM_CAP || "3");
const BUDGET_SEC = Number(process.env.SWARM_BUDGET_SEC || "3480");
const HANDOFF_LEAD_SEC = Number(process.env.SWARM_HANDOFF_LEAD_SEC || "180");
const WORK_REPO = process.env.SWARM_WORK_REPO || "";
const GIT_TIMEOUT_MS = 25_000;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SWARM_LAUNCH = process.env.SWARM_LAUNCH || path.join(SCRIPTS_DIR, "swarm-launch.sh");
const SWARM_TASK = process.env.SWARM_TASK || path.join(SCRIPTS_DIR, "swarm-task.sh");
const SWARM_TEAM = process.env.SWARM_TEAM || "";
// Gate the handoff ACTIONS (claim/allocate/resume/retire). Default OFF: the dispatcher observes + drives the
// lifecycle record (drain/expire/milestone/checkpoint) to the mirror, but allocates no VM until SWARM_EXEC=1.
// Only explicit enabling values count — `!!"0"`/`!!"false"` are truthy, so SWARM_EXEC=0 must NOT enable (Codex P1).
const EXEC_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SWARM_EXEC ?? "");

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

function scratchPath(launchId: string): string { return path.join(HOME, ".agenthop", "swarm", "scratch", launchId); }

// --- handoff-action IO (Phase 2). observe/clock/record are LIVE; allocate/resume spawn the box-side scripts and are
// gated behind SWARM_EXEC (default off). Live-validated only in the gated run. ---
function runScript(file: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [file, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = "", stderr = "", done = false;
    const finish = (code: number) => { if (!done) { done = true; resolve({ code, stdout, stderr }); } };
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", () => finish(-1));
    child.on("close", (c) => finish(c ?? -1));
  });
}
async function allocateSuccessor(_pred: ControlRecord): Promise<string | null> {
  // Allocate a fresh box via swarm-launch with AGENTHOP_ALLOCATE_ONLY (allocate + key-bind + stamp, no worker TUI —
  // the successor is provisioned by swarm-task --resume). Parse the minted launchId from its "NEW box rw-..." line.
  // SWARM_TEAM still matters for swarm-task --resume (the successor's worker joins the team); warn if unset.
  if (!SWARM_TEAM) log("allocateSuccessor: SWARM_TEAM is unset — the resumed successor would join teamless/invisible");
  const r = await runScript(SWARM_LAUNCH, ["claude", SWARM_TEAM, "new"], { AGENTHOP_ALLOCATE_ONLY: "1" });
  const m = (r.stdout + r.stderr).match(/NEW box (rw-[0-9a-f]+)/);
  if (r.code !== 0 || !m) { log(`allocateSuccessor: swarm-launch failed (code ${r.code})`); return null; }
  log(`allocateSuccessor: allocated ${m[1]}`);
  return m[1];
}
async function resumeSuccessor(a: { successor: string; handoffSha: string; generation: number; branch: string }): Promise<boolean> {
  // swarm-task --resume seeds the successor branch at a resume-marker from handoffSha + starts supervisor/worker.
  const r = await runScript(SWARM_TASK, [a.successor, "--resume", a.handoffSha, String(a.generation)]);
  if (r.code !== 0) { log(`resumeSuccessor ${a.successor}: swarm-task --resume failed (code ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`); return false; }
  return true;
}
async function scrubBox(launchId: string): Promise<void> {
  // The box self-scrubs on its own deadline (swarm-scrub, driven by the supervisor). A dispatcher-driven scrub needs
  // box access (the railway key or the tailcat channel) and lands with that wiring. Best-effort no-op for now.
  log(`scrubBox ${launchId}: box self-scrubs on deadline; dispatcher-driven scrub pending`);
}

// --- the --observe-once dev mode (offline-smoke-testable) ---
async function observeOnce(argv: string[]): Promise<void> {
  const [workRepo, branch, launchId, genStr, lastSha] = argv;
  if (!workRepo || !branch || !launchId || !genStr) { console.error("usage: --observe-once <workRepo> <branch> <launchId> <generation> [lastSha]"); process.exit(2); }
  const record: ControlRecord = { launchId: launchId!, state: "RUNNING", generation: Number(genStr), allocStart: nowSec(), budgetSec: BUDGET_SEC, updatedAt: nowSec(), sha: lastSha };
  const tip = await observeTip(workRepo!, branch!, lastSha, path.join(HOME, ".agenthop", "swarm", "scratch", launchId!));
  console.log(JSON.stringify({ tip, decision: tip ? tipToEvent(record, tip) : null }, null, 2));
}

// --- one control-loop pass: discover boxes + persisted records, step each through handoffStep (observe + authoritative
//     clock + gated handoff EXEC). handoffStep reads liveCount from `records` and mutates it (adds successors). ---
async function pass(records: Map<string, ControlRecord>, ops: HandoffOps): Promise<void> {
  const boxes = new Map(discoverBoxes().map((b) => [b.launchId, b]));
  // UNION of keydir-discovered boxes AND persisted mirror records (Codex #7): a box whose keydir vanished but whose
  // record is still non-terminal (e.g. EXPIRED needing a successor) must still be processed, incl. after a restart.
  const ids = new Set<string>([...boxes.keys(), ...records.keys()]);
  for (const launchId of ids) {
    const box = boxes.get(launchId);
    let r = records.get(launchId);
    if (!r) {
      if (!box) continue;
      r = { launchId, state: "RUNNING", generation: 0, allocStart: box.allocTs, budgetSec: BUDGET_SEC, updatedAt: nowSec(), deadlineEpoch: box.allocTs + BUDGET_SEC };
      records.set(launchId, r);
      saveRecord(r);
    }
    try {
      await handoffStep(r, records, ops);
    } catch (e) {
      log(`handoffStep ${launchId} error: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function buildOps(): HandoffOps {
  return {
    nowSec, self: SELF, cap: CAP, budgetSec: BUDGET_SEC, handoffLeadSec: HANDOFF_LEAD_SEC, execEnabled: EXEC_ENABLED,
    observeTip: (branch, lastSha, launchId) =>
      WORK_REPO ? observeTip(WORK_REPO, branch, lastSha, scratchPath(launchId)) : Promise.resolve(null),
    allocateSuccessor,
    resumeSuccessor,
    scrubBox,
    notify: notifyUser,
    persist: saveRecord,
    log,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--observe-once") { await observeOnce(argv.slice(1)); return; }

  log(`single-active dispatcher up (cap=${CAP}, budget=${BUDGET_SEC}s, workRepo=${WORK_REPO || "<unset>"}, exec=${EXEC_ENABLED})`);
  const records = loadMirror();
  const ops = buildOps();
  for (;;) {
    try { await pass(records, ops); } catch (e) { log(`pass error: ${e instanceof Error ? e.message : e}`); }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// Run the loop only when executed directly (not when imported, e.g. by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
