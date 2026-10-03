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
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { type ControlRecord, PROVIDER_LIFETIME_SEC } from "../packages/bus/src/swarm/control.js";
import { parseManifest } from "../packages/bus/src/swarm/manifest.js";
import { type ObservedTip, tipToEvent } from "../packages/bus/src/swarm/acceptance.js";
import { type HandoffOps, handoffStep } from "../packages/bus/src/swarm/dispatch-step.js";
import { loadControlLog, commitControl } from "../packages/bus/src/swarm/control-store.js";
import { entityKeyOf, type ChangeBody, type CommitResult, type LogState } from "../packages/bus/src/swarm/control-log.js";
import { loadPlan, type TaskPlan, type TaskSpec } from "../packages/bus/src/swarm/task-plan.js";
import type { TaskAttempt, ExecutionBinding } from "../packages/bus/src/swarm/task-state.js";
import type { Assignment } from "../packages/bus/src/swarm/task-assignment.js";
import { taskPass, type TaskOps, type GitFacts } from "../packages/bus/src/swarm/task-pass.js";
import { observeResultOnBranch } from "../packages/bus/src/swarm/task-observe.js";
import { mintEphToken, readEphSecret } from "../packages/bus/src/swarm/mint.js";
import { sweepPass, type SweepOps } from "../packages/bus/src/swarm/task-sweep.js";
import { fileIsAlive, resolveSession, listSessions, makeFileLiveness } from "../packages/bus/src/swarm/task-liveness.js";
import type { WaitRecord } from "../packages/bus/src/swarm/control-log.js";
import { writeInbox } from "../packages/bus/src/inbox.js";

const HOME = process.env.AH_HOME ?? homedir();
const MIRROR_DIR = path.join(HOME, ".agenthop", "swarm", "control");
const KEYDIR_GLOB = "/tmp"; // throwaway keydirs live at /tmp/ah-rwkey-rw-*
const SELF = process.env.SWARM_SELF || `disp-${process.pid}`;
const CAP = Number(process.env.SWARM_CAP || "3");
const BUDGET_SEC = Number(process.env.SWARM_BUDGET_SEC || "3480");
// The PROVIDER's physical VM lifetime bound (s) — SEPARATE from the work budget: physical death / slot-free is proven by
// this, never the (possibly shorter) work budget (Codex P1-2). Default = PROVIDER_LIFETIME_SEC (Railway ~60min).
const VM_LIFETIME_SEC = Number(process.env.SWARM_VM_LIFETIME_SEC || String(PROVIDER_LIFETIME_SEC));
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

// --- business-task layer (brain §4.5). The control-log is authoritative for the task axis (intents/attempts/accepted);
// the per-record mirror above stays the LIFECYCLE axis for now (its migration to commitControl is a separate step). The
// task pass runs only with a plan AND SWARM_TASK_EXEC (it allocates real boxes + mints CPA tokens — opt-in like SWARM_EXEC).
const CONTROL_LOG_DIR = path.join(HOME, ".agenthop", "swarm", "control-log");
const PLAN_FILE = process.env.SWARM_PLAN || "";
const TASK_EXEC = /^(1|true|yes|on)$/i.test(process.env.SWARM_TASK_EXEC ?? "");
const CPA_BASE_URL = process.env.SWARM_CPA_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
const CHECKPOINT_BUDGET_SEC = Number(process.env.SWARM_CHECKPOINT_BUDGET_SEC || "300");
const TOKEN_MARGIN_SEC = Number(process.env.SWARM_TOKEN_MARGIN_SEC || "300");
// liveness sweep (team-collab §0b R2) — the coordinator-replacement pass step. Gated on SWARM_SWEEP (it writes to peer
// inboxes). SWARM_WAIT_SEED = a JSON file of {put:"wait"} entries to seed the control-log (the migrated coordinator waits).
const SWEEP_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SWARM_SWEEP ?? "");
const WAIT_SEED_FILE = process.env.SWARM_WAIT_SEED || "";
const SWEEP_STALE_MS = Number(process.env.SWARM_SWEEP_STALE_MS || "120000");

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

// A TOMBSTONE suppresses keydir-driven RESURRECTION of a deliberately-removed record: discovery re-reads the box's
// alloc-ts keydir every pass, so without this a just-removed dead/never-created successor is immediately recreated as a
// fresh RUNNING record (Codex P2-3). The tombstone lives exactly as long as the stale keydir — gcTombstones drops it
// once the keydir is gone (no resurrection source left), so tombstones don't accumulate.
function tombstonePath(launchId: string): string { return path.join(MIRROR_DIR, `${launchId}.tombstone`); }
function isTombstoned(launchId: string): boolean { return existsSync(tombstonePath(launchId)); }
function writeTombstone(launchId: string): void { mkdirSync(MIRROR_DIR, { recursive: true }); atomicWrite(tombstonePath(launchId), String(nowSec())); }
/** The discovery keydir that would resurrect a removed record (discoverBoxes reads /tmp/ah-rwkey-<launchId>/alloc-ts). */
function keydirPath(launchId: string): string { return path.join(KEYDIR_GLOB, `ah-rwkey-${launchId}`); }
function gcTombstones(): void {
  if (!existsSync(MIRROR_DIR)) return;
  for (const f of readdirSync(MIRROR_DIR)) {
    if (!f.endsWith(".tombstone")) continue;
    const id = f.slice(0, -".tombstone".length);
    // GC only when the keydir ITSELF is gone (no resurrection source). Keying off the SUCCESSFULLY-read box set would
    // drop the tombstone on a transient alloc-ts read failure (EACCES/IO) while the keydir still exists, then the next
    // readable pass resurrects the removed record as generation 0 (Codex P2-01). Existence, not readability.
    if (!existsSync(keydirPath(id))) { try { unlinkSync(tombstonePath(id)); } catch {} }
  }
}

// Remove a record from the mirror (a successor whose box was RELIABLY never created, or a dead in-flight allocation) and
// tombstone it so discovery can't resurrect it. A non-ENOENT unlink failure (EACCES/EIO) is NOT success — it is thrown
// so the caller does NOT advance the dependent transition / register the delete as done (the disk record would survive a
// restart and be reloaded); the pass() try/catch logs + retries next pass (Codex P2-4).
function removeRecord(launchId: string): void {
  try {
    unlinkSync(mirrorPath(launchId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e instanceof Error ? e : new Error(String(e));
    // ENOENT => already absent (the desired state); fall through to the tombstone so resurrection is still suppressed.
  }
  writeTombstone(launchId);
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

function scratchPath(launchId: string): string { return path.join(HOME, ".agenthop", "swarm", "scratch", launchId); }

// --- handoff-action IO (Phase 2). observe/clock/record are LIVE; allocate/resume spawn the box-side scripts and are
// gated behind SWARM_EXEC (default off). Live-validated only in the gated run. ---
// repo slug (owner/name) from a git URL or an already-slug value, so swarm-task (which wants a slug + builds the URL)
// gets a slug even though the dispatcher holds WORK_REPO as a git URL for ls-remote (Codex: URL-vs-slug double-prefix).
function repoSlug(repo: string): string {
  return repo.replace(/\.git$/, "").replace(/^.*[:/]([^/]+\/[^/]+)$/, "$1");
}
const SCRIPT_TIMEOUT_MS = 300_000; // bound a box-provisioning spawn so a hung swarm-launch/swarm-task can't block forever
function runScript(file: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [file, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = "", stderr = "", done = false;
    const finish = (code: number) => { if (!done) { done = true; resolve({ code, stdout, stderr }); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, SCRIPT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", () => { clearTimeout(timer); finish(-1); });
    child.on("close", (c) => { clearTimeout(timer); finish(c ?? -1); });
  });
}
async function allocateSuccessor(_pred: ControlRecord, successorId: string): Promise<"ok" | "clean-fail" | "unknown"> {
  // Allocate the PRE-GENERATED successor box via swarm-launch (allocate-only, given launchId). Map swarm-launch's exit
  // codes to a reliability status: 0 = created, 3 = provider refusal (reliably NOT created), anything else = unknown
  // (box may exist). SWARM_TEAM still matters for swarm-task --resume (the successor's worker joins the team).
  if (!SWARM_TEAM) log("allocateSuccessor: SWARM_TEAM is unset — the resumed successor would join teamless/invisible");
  const r = await runScript(SWARM_LAUNCH, ["claude", SWARM_TEAM, "new"], { AGENTHOP_ALLOCATE_ONLY: "1", AGENTHOP_LAUNCH_ID: successorId });
  if (r.code === 0) { log(`allocateSuccessor: allocated ${successorId}`); return "ok"; }
  if (r.code === 3) { log(`allocateSuccessor ${successorId}: clean refusal (not created)`); return "clean-fail"; }
  log(`allocateSuccessor ${successorId}: result unknown (exit ${r.code})`);
  return "unknown";
}
async function resumeSuccessor(a: { successor: string; handoffSha: string; generation: number; branch: string }): Promise<boolean> {
  // swarm-task --resume seeds the successor branch at handoffSha + starts supervisor/worker. Pass the repo as a SLUG
  // (swarm-task builds the URL itself) even though WORK_REPO here is a git URL for ls-remote (Codex URL-vs-slug fix).
  const r = await runScript(SWARM_TASK, [a.successor, "--resume", a.handoffSha, String(a.generation)],
    WORK_REPO ? { SWARM_WORK_REPO: repoSlug(WORK_REPO) } : {});
  if (r.code !== 0) { log(`resumeSuccessor ${a.successor}: swarm-task --resume failed (code ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`); return false; }
  return true;
}
async function scrubBox(launchId: string): Promise<boolean> {
  // The box self-scrubs on its own deadline (swarm-scrub, driven by the supervisor). A dispatcher-driven scrub needs
  // box access (the railway key or the tailcat channel) and lands with that wiring. We CANNOT confirm termination here,
  // so return false: the slot stays occupied until the box's deadline passes rather than be freed on an unproven scrub
  // (Codex P1-2). When dispatcher-driven termination lands, return true on a confirmed kill.
  log(`scrubBox ${launchId}: box self-scrubs on deadline; dispatcher-driven scrub pending (slot held until deadline)`);
  return false;
}

// --- the --observe-once dev mode (offline-smoke-testable) ---
async function observeOnce(argv: string[]): Promise<void> {
  const [workRepo, branch, launchId, genStr, lastSha] = argv;
  if (!workRepo || !branch || !launchId || !genStr) { console.error("usage: --observe-once <workRepo> <branch> <launchId> <generation> [lastSha]"); process.exit(2); }
  const record: ControlRecord = { launchId: launchId!, state: "RUNNING", generation: Number(genStr), allocStart: nowSec(), budgetSec: BUDGET_SEC, physicalLifetimeSec: VM_LIFETIME_SEC, updatedAt: nowSec(), sha: lastSha };
  const tip = await observeTip(workRepo!, branch!, lastSha, path.join(HOME, ".agenthop", "swarm", "scratch", launchId!));
  console.log(JSON.stringify({ tip, decision: tip ? tipToEvent(record, tip) : null }, null, 2));
}

// --- one control-loop pass: discover boxes + persisted records, step each through handoffStep (observe + authoritative
//     clock + gated handoff EXEC). handoffStep reads liveCount from `records` and mutates it (adds successors). ---
async function pass(records: Map<string, ControlRecord>, ops: HandoffOps): Promise<void> {
  const boxes = new Map(discoverBoxes().map((b) => [b.launchId, b]));
  gcTombstones(); // drop tombstones whose keydir is actually gone (by existence, not a readable-this-pass set) (Codex P2-3/P2-01)
  // UNION of keydir-discovered boxes AND persisted mirror records (Codex #7): a box whose keydir vanished but whose
  // record is still non-terminal (e.g. EXPIRED needing a successor) must still be processed, incl. after a restart.
  const ids = new Set<string>([...boxes.keys(), ...records.keys()]);
  for (const launchId of ids) {
    const box = boxes.get(launchId);
    let r = records.get(launchId);
    if (!r) {
      if (!box) continue;
      if (isTombstoned(launchId)) continue; // deliberately removed (dead/never-created) — do NOT resurrect it (Codex P2-3)
      r = { launchId, state: "RUNNING", generation: 0, allocStart: box.allocTs, budgetSec: BUDGET_SEC, physicalLifetimeSec: VM_LIFETIME_SEC, updatedAt: nowSec(), deadlineEpoch: box.allocTs + BUDGET_SEC };
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
    nowSec, self: SELF, cap: CAP, budgetSec: BUDGET_SEC, physicalLifetimeSec: VM_LIFETIME_SEC, handoffLeadSec: HANDOFF_LEAD_SEC, execEnabled: EXEC_ENABLED,
    newLaunchId: () => `rw-${randomBytes(4).toString("hex")}`,
    observeTip: (branch, lastSha, launchId) =>
      WORK_REPO ? observeTip(WORK_REPO, branch, lastSha, scratchPath(launchId)) : Promise.resolve(null),
    allocateSuccessor,
    resumeSuccessor,
    scrubBox,
    notify: notifyUser,
    persist: saveRecord,
    removeRecord,
    log,
  };
}

// --- business-task IO (the real TaskOps wired to git / mint / scp / swarm-launch / swarm-task + the control-log) ---

/** Stamp operationId (= entityKey#targetRev, deterministic + replay-idempotent) + expectedEntityRevision, persist. */
function commitTask(state: LogState, bodies: ChangeBody[]): { state: LogState; result: CommitResult } {
  const changes = bodies.map((b) => {
    const key = entityKeyOf(b);
    const rev = state.revisions[key] ?? 0;
    return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev };
  });
  const r = commitControl(CONTROL_LOG_DIR, state, changes);
  return { state: r.state, result: r.result };
}

function loadPlanFile(): TaskPlan | null {
  if (!PLAN_FILE) return null;
  try {
    const res = loadPlan(JSON.parse(readFileSync(PLAN_FILE, "utf8")));
    if (!res.ok) { log(`plan ${PLAN_FILE}: ${res.reason}`); return null; }
    return res.plan;
  } catch (e) { log(`plan read ${PLAN_FILE}: ${e instanceof Error ? e.message : e}`); return null; }
}

// O1: observe a binding's WORK branch for a result candidate. Thin wrapper — the logic lives in task-observe.ts
// (observeResultOnBranch) so it is exercised against REAL git in tests; here we only bind the real git() + scratch dir.
async function observeGitFor(a: { attempt: TaskAttempt; spec: TaskSpec; binding: ExecutionBinding }): Promise<GitFacts | null> {
  if (!WORK_REPO) return null;
  const branch = `swarm/${a.binding.launchId}-g${a.binding.publishGeneration}`;
  const scratch = scratchPath(a.binding.launchId);
  mkdirSync(scratch, { recursive: true });
  return observeResultOnBranch({
    git: (args, cwd) => git(args, cwd ? { cwd } : {}),
    workRepo: WORK_REPO,
    scratch,
    branch,
    resultPath: `out/results/${a.attempt.attemptId}/result.json`,
    identity: { jobId: a.attempt.jobId, nodeId: a.attempt.nodeId, attemptId: a.attempt.attemptId, assignmentId: a.binding.assignmentId },
    acceptanceEmpty: a.spec.acceptance.length === 0,
  });
}

// startTask IO: mint the CPA token, write assignment.json + worker-env as 0600 temp files, swarm-launch allocate-only,
// then (only if created) fire swarm-task --task. The token rides a FILE (never argv — §4.5-3). Returns the BOX outcome
// (alloc) AND whether the worker actually STARTED (delivered) separately (Codex P2): alloc exit 0 but swarm-task failing
// before the worker starts = a box that occupies a slot with no worker — it must NOT be reported as a confirmed dispatch.
async function startTaskIO(a: { assignment: Assignment; launchId: string }): Promise<{ alloc: "created" | "clean-fail" | "unknown"; delivered: boolean }> {
  let token = "";
  try { token = mintEphToken({ sub: a.launchId, ttlSec: VM_LIFETIME_SEC, secret: readEphSecret() }); }
  catch (e) { log(`startTask ${a.launchId}: token mint failed (worker will have no CPA token): ${e instanceof Error ? e.message : e}`); }
  const dir = mkdtempSync(path.join(tmpdir(), "ah-task-"));
  const asgPath = path.join(dir, "assignment.json");
  const envPath = path.join(dir, "worker-env");
  try {
    writeFileSync(asgPath, JSON.stringify(a.assignment), { mode: 0o600 });
    if (token && CPA_BASE_URL) {
      const sq = (v: string) => v.replace(/'/g, "'\\''");
      writeFileSync(envPath, `export ANTHROPIC_BASE_URL='${sq(CPA_BASE_URL)}'\nexport ANTHROPIC_AUTH_TOKEN='${sq(token)}'\n`, { mode: 0o600 });
    }
    const allocRes = await runScript(SWARM_LAUNCH, ["claude", SWARM_TEAM, "new"], { AGENTHOP_ALLOCATE_ONLY: "1", AGENTHOP_LAUNCH_ID: a.launchId });
    const alloc: "created" | "clean-fail" | "unknown" = allocRes.code === 0 ? "created" : allocRes.code === 3 ? "clean-fail" : "unknown";
    let delivered = false;
    if (alloc === "created") {
      const env: Record<string, string> = { SWARM_ASSIGNMENT: asgPath };
      if (token && CPA_BASE_URL) env.SWARM_WORKER_ENV = envPath;
      if (WORK_REPO) env.SWARM_WORK_REPO = repoSlug(WORK_REPO);
      const t = await runScript(SWARM_TASK, [a.launchId, "--task"], env);
      delivered = t.code === 0;
      if (!delivered) log(`startTask ${a.launchId}: box created but swarm-task --task exit ${t.code} (worker not started): ${(t.stderr || t.stdout).trim().slice(0, 200)}`);
    }
    return { alloc, delivered };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// The job wall-clock budget start = when the plan was first committed (PlanPut), PERSISTED so a dispatcher restart does
// NOT reset it (fe0376cd T1 review A / T2 review #1). Write-once per jobId; later reads return the original epoch.
function jobStartSec(jobId: string): number {
  const dir = path.join(HOME, ".agenthop", "swarm", "jobs");
  const file = path.join(dir, `${jobId}.started`);
  try { const v = Number(readFileSync(file, "utf8").trim()); if (Number.isFinite(v) && v > 0) return v; } catch { /* first run */ }
  const now = nowSec();
  mkdirSync(dir, { recursive: true });
  atomicWrite(file, String(now));
  return now;
}

function buildTaskOps(stateRef: { s: LogState }, planCommittedAtSec: number): TaskOps {
  return {
    nowSec, cap: CAP, budgetSec: BUDGET_SEC, planCommittedAtSec, remainingLifeSec: VM_LIFETIME_SEC,
    checkpointBudgetSec: CHECKPOINT_BUDGET_SEC, handoffMarginSec: HANDOFF_LEAD_SEC, tokenMarginSec: TOKEN_MARGIN_SEC,
    jitterSec: () => 0, // deterministic (single-node T1; a non-zero thundering-herd jitter is sampled+persisted at T2)
    newLaunchId: () => `rw-${randomBytes(4).toString("hex")}`,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { const r = commitTask(state, bodies); stateRef.s = r.state; return r; },
    observeGit: observeGitFor,
    startTask: startTaskIO,
    log,
  };
}

// Seed the control-log with migrated {put:"wait"} entries (the coordinator's real waits) once, if absent (first input).
function loadWaitSeed(stateRef: { s: LogState }): void {
  if (!WAIT_SEED_FILE) return;
  try {
    const entries = JSON.parse(readFileSync(WAIT_SEED_FILE, "utf8")) as Array<{ put: string; wait: WaitRecord }>;
    for (const e of entries) {
      if (e.put !== "wait" || !e.wait?.waitId) continue;
      if (stateRef.s.revisions[`wait:${e.wait.waitId}`] !== undefined) continue; // already in the log
      stateRef.s = commitTask(stateRef.s, [{ put: "wait", wait: e.wait }]).state;
      log(`wait seed: loaded ${e.wait.waitId} (owner ${e.wait.owner})`);
    }
  } catch (e) { log(`wait seed ${WAIT_SEED_FILE}: ${e instanceof Error ? e.message : e}`); }
}

function buildSweepOps(stateRef: { s: LogState }): SweepOps {
  const liveness = makeFileLiveness(HOME);
  return {
    nowSec,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { const r = commitTask(state, bodies); stateRef.s = r.state; return r; },
    // Two-evidence file liveness (task-liveness; bus-identity replaces the impl). An unresolvable owner ⇒ dead.
    isAlive: (owner) => { const sid = resolveSession(owner, listSessions(HOME)); return sid ? fileIsAlive(sid, liveness, SWEEP_STALE_MS) : "dead"; },
    // v1: no idle-same-role picker yet (that is the R8 overload rule, next) ⇒ a dead owner is left for escalation.
    pickReassignee: () => null,
    newWaitId: (base) => `${base}/r-${randomBytes(3).toString("hex")}`,
    newActionId: () => `swp-${randomBytes(4).toString("hex")}`,
    freshDeadlineSec: () => nowSec() + 1800,
    // R5 channel: deliver the ping/escalation/reassign-notice to the owner's durable inbox (filesystem — part of bus
    // delivery; the owner's bus node claims it). Thin v1; bus-identity formalizes handle→delivery.
    doAction: async (w, action) => {
      const sid = resolveSession(w.owner, listSessions(HOME));
      if (!sid) return false;
      const text = action.actionKind === "bypass" ? `[sweep] progress on ${w.waitId}? (subject ${JSON.stringify(w.subject)}) — past deadline`
        : action.actionKind === "escalation" ? `[sweep] ESCALATION: ${w.waitId} past deadline, needs a decision`
        : `[sweep] ${w.waitId}: ${action.actionKind}`;
      try { writeInbox(HOME, sid, { from: SELF, fromLabel: "swarm-sweep", text, via: "local", ts: Date.now() }); return true; }
      catch (e) { log(`sweep doAction ${w.waitId}: inbox write failed: ${e instanceof Error ? e.message : e}`); return false; }
    },
    log,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--observe-once") { await observeOnce(argv.slice(1)); return; }

  const plan = loadPlanFile();
  const taskOn = plan !== null && TASK_EXEC;
  log(`single-active dispatcher up (cap=${CAP}, budget=${BUDGET_SEC}s, workRepo=${WORK_REPO || "<unset>"}, exec=${EXEC_ENABLED}, task=${taskOn ? `on:${plan!.jobId}` : "off"})`);
  const records = loadMirror();
  const ops = buildOps();
  const taskStateRef = { s: loadControlLog(CONTROL_LOG_DIR) };
  const taskOps = plan ? buildTaskOps(taskStateRef, jobStartSec(plan.jobId)) : null;
  loadWaitSeed(taskStateRef); // seed the migrated coordinator waits (first sweep input), if any
  const sweepOps = buildSweepOps(taskStateRef);
  if (SWEEP_ENABLED) log(`liveness sweep ON (staleMs=${SWEEP_STALE_MS}${WAIT_SEED_FILE ? `, seed=${WAIT_SEED_FILE}` : ""})`);
  for (;;) {
    try { await pass(records, ops); } catch (e) { log(`pass error: ${e instanceof Error ? e.message : e}`); }
    // The business-task pass runs AFTER the lifecycle handoff pass (§4.5: handoff advances lifecycle, then task pass
    // observes/accepts/dispatches). Gated on a plan + SWARM_TASK_EXEC (allocates boxes). Reloads the log each round so a
    // crash-restart picks up where it left off.
    // T1.5 RED LINE (fe0376cd): until the resume adapter + lifecycle→commitControl migration land, do NOT enable --task
    // dispatch for any task that may undergo a handoff — the lifecycle resume half is not yet wired to continue the
    // business task. Live gating (SWARM_TASK_EXEC) is off by default, so this is a zero-cost operational constraint.
    if (plan && taskOn && taskOps) {
      try { taskStateRef.s = loadControlLog(CONTROL_LOG_DIR); await taskPass(plan, taskOps); }
      catch (e) { log(`taskPass error: ${e instanceof Error ? e.message : e}`); }
    }
    // The liveness sweep (§0b R2) runs after the task pass: scan durable waits + member liveness, auto-handle expired
    // waits (ping/escalate) + dead owners (reassign). This is the coordinator-replacement step. Gated on SWARM_SWEEP.
    if (SWEEP_ENABLED) {
      try { taskStateRef.s = loadControlLog(CONTROL_LOG_DIR); await sweepPass(sweepOps); }
      catch (e) { log(`sweep error: ${e instanceof Error ? e.message : e}`); }
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// Run the loop only when executed directly (not when imported, e.g. by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
