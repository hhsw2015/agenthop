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
import { randomBytes, createHash } from "node:crypto";
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
import { acquireSingleFlight } from "../packages/bus/src/swarm/single-flight.js";
import { validSeedWait } from "../packages/bus/src/swarm/wait-seed.js";
import { runDispatchLoops } from "../packages/bus/src/swarm/dispatch-loops.js";
import { writeProjection } from "../packages/bus/src/swarm/projection.js";
import { beatStart, beatEnd } from "../packages/bus/src/swarm/heartbeat.js";
import { buildControlCut, heartbeatObservations } from "../packages/bus/src/swarm/liveness-review.js";
import { assertLiveness, type LivenessVerdict, type ControlCut, type ObservationFact } from "../packages/bus/src/swarm/task-liveness-inv1.js";
import { reconcileIncident, reconcileRegistryWithControl, readIncidents, writeIncidents, type IncidentRegistry } from "../packages/bus/src/swarm/incident-episode.js";
import { isRepairWaitId } from "../packages/bus/src/swarm/repair-wait-id.js";
import { observeCandidate, readDelegations, writeDelegations, type DelegationRegistry } from "../packages/bus/src/swarm/delegation-envelope.js";
import { scanCompletionSlots, detectWatchEvents, readWatchSnapshot, writeWatchSnapshot, type ReadArtifact, type WatchSnapshot } from "../packages/bus/src/swarm/delegation-observer.js";
import { advanceWait } from "../packages/bus/src/swarm/task-wait.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import { whois, buildProjection, readIdentityLog, probeTargets, liveness as busLiveness, type ProbeFact, type ProbeResultKind } from "../packages/bus/src/bus-identity.js";
import { liveEntities, type WaitRecord } from "../packages/bus/src/swarm/control-log.js";
import { writeInbox } from "../packages/bus/src/inbox.js";

const HOME = process.env.AH_HOME ?? homedir();
const MIRROR_DIR = path.join(HOME, ".agenthop", "swarm", "control");
// Single-active-dispatcher lock (P2-1): one sweep/writer in flight at a time (a 2nd dispatcher or an overlapping
// --sweep-once would double-deliver + overwrite same-seq batches).
const DISPATCHER_LOCK = path.join(HOME, ".agenthop", "swarm", "dispatcher.lock");
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
// Read-only consumer view (projection-schema v1); rewritten by the commitControl apply hook (projection write is fail-soft).
const PROJECTION_DIR = path.join(HOME, ".agenthop", "swarm", "projection");
// Per-loop dispatcher heartbeat (cluster-liveness L1 subset); each loop records its own tick independently (fail-soft).
const HEARTBEAT_FILE = path.join(HOME, ".agenthop", "swarm", "heartbeat.json");
// How long a heartbeat sample is treated as fresh (INV-1 observation window). A loop ticks ~every 5s; a gap beyond this ⇒ stale ⇒ UNVERIFIABLE.
const LIVENESS_WINDOW_SEC = Number(process.env.SWARM_LIVENESS_WINDOW_SEC || "120");
// Durable incident-episode registry (cluster-liveness L1-tail): STALL episodes + their repair-waits. IO-owned file (not a
// control-log entity). REPAIR_WAIT_SEC = the repair-wait's deadline window (the sweep escalates an un-handled repair).
const INCIDENTS_FILE = path.join(HOME, ".agenthop", "swarm", "incidents.json");
const REPAIR_WAIT_SEC = Number(process.env.SWARM_REPAIR_WAIT_SEC || "600");
// The repair-wait's responsible party (review P2-2): DISTINCT from SELF (the dispatcher's observation-instance id, `disp-<pid>`,
// which is not a routable bus session). Set SWARM_REPAIR_OWNER to a routable bus handle so the sweep's escalation reaches a
// repairer. Until it is set (or the deferred roster lands), the repair-wait is still RECORDED + supervised, but escalation
// delivery is best-effort — we label that honestly rather than claim it routes.
const REPAIR_OWNER = process.env.SWARM_REPAIR_OWNER || "";
const REPAIR_OWNER_ROUTABLE = REPAIR_OWNER !== "";
// Durable-state observer (L2-struct 2/n, §2b-c/§2c + F25): delegation completion-slot registry + the board/PROGRESS watch
// snapshot (so events fire only on change). COORDINATOR = the routable handle the observer pushes durable-change events to
// (unset ⇒ events are logged, best-effort — not silently claimed delivered). CONSUMPTION_WINDOW = the acceptor's wait deadline.
const DELEGATIONS_FILE = path.join(HOME, ".agenthop", "swarm", "delegations.json");
const OBSERVER_SNAPSHOT_FILE = path.join(HOME, ".agenthop", "swarm", "observer-snapshot.json");
const BOARD_DIR = path.join(HOME, ".agenthop", "swarm", "board");
const PROGRESS_FILE = path.join(HOME, ".agenthop", "swarm", "PROGRESS.md");
const COORDINATOR = process.env.SWARM_COORDINATOR || "";
const CONSUMPTION_WINDOW_SEC = Number(process.env.SWARM_CONSUMPTION_WINDOW_SEC || "600");
const PLAN_FILE = process.env.SWARM_PLAN || "";
const TASK_EXEC = /^(1|true|yes|on)$/i.test(process.env.SWARM_TASK_EXEC ?? "");
const CPA_BASE_URL = process.env.SWARM_CPA_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
const CHECKPOINT_BUDGET_SEC = Number(process.env.SWARM_CHECKPOINT_BUDGET_SEC || "300");
const TOKEN_MARGIN_SEC = Number(process.env.SWARM_TOKEN_MARGIN_SEC || "300");
// liveness sweep (team-collab §0b R2) — the coordinator-replacement pass step. Gated on SWARM_SWEEP (it writes to peer
// inboxes). SWARM_WAIT_SEED = a JSON file of {put:"wait"} entries to seed the control-log (the migrated coordinator waits).
const SWEEP_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SWARM_SWEEP ?? "");
const WAIT_SEED_FILE = process.env.SWARM_WAIT_SEED || "";

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
  // Projection apply hook (projection-schema §8): after a batch newly advances the log, rewrite the read-only view so viz +
  // fast-startup see current state. Fail-soft — the projection is derived (rebuilt by replay), never the barrier; a write
  // error must not break the commit.
  if (r.result.ok && !r.result.replay) {
    try { writeProjection(PROJECTION_DIR, r.state, { nowSec: nowSec(), jobStartSec }); }
    catch (e) { log(`projection write failed: ${e instanceof Error ? e.message : e}`); }
  }
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

// Seed the control-log with migrated wait entities (the coordinator's real waits) once, if absent (first input). Each
// entry is validated BEFORE commit (validSeedWait, shared + tested in the bus package); bad entries are rejected in
// isolation (one bad/null entry never blocks the good ones — P2-5/R3).
function loadWaitSeed(stateRef: { s: LogState }): void {
  if (!WAIT_SEED_FILE) return;
  let entries: unknown;
  try { entries = JSON.parse(readFileSync(WAIT_SEED_FILE, "utf8")); }
  catch (e) { log(`wait seed ${WAIT_SEED_FILE}: unreadable/invalid JSON — ignored: ${e instanceof Error ? e.message : e}`); return; }
  if (!Array.isArray(entries)) { log(`wait seed ${WAIT_SEED_FILE}: not a JSON array — ignored`); return; }
  for (const raw of entries as unknown[]) {
    const v = validSeedWait(raw);
    if (typeof v === "string") { log(`wait seed: REJECTED entry (${v}) — not committed`); continue; } // bad entry isolated
    if (stateRef.s.revisions[`wait:${v.waitId}`] !== undefined) continue; // already in the log
    const r = commitTask(stateRef.s, [{ put: "wait", wait: v }]);
    if (!r.result.ok) { log(`wait seed ${v.waitId}: commit rejected (${r.result.reason}) — not loaded`); continue; } // P1-1: only log loaded on success
    stateRef.s = r.state;
    log(`wait seed: loaded ${v.waitId} (owner ${v.owner})`);
  }
}

function buildSweepOps(stateRef: { s: LogState }): SweepOps {
  // Owner liveness via the bus-identity whois + three-state liveness kernel (batch B). v1 has no birth collection ⇒
  // birthOk undefined ⇒ liveness returns "suspected" for every owner (never alive/dead) — the sweep rules handle that
  // (expired fires for not-dead; reassign only on a trustworthy dead, which v1 never produces + picker is null).
  const kill0 = (pid: number): ProbeResultKind => { try { process.kill(pid, 0); return "present"; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" ? "eperm" : "absent"; } };
  return {
    nowSec,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { const r = commitTask(state, bodies); stateRef.s = r.state; return r; },
    // Two-evidence file liveness (task-liveness; bus-identity replaces the impl). An unresolvable owner ⇒ dead.
    isAlive: (owner) => {
      // ponytail: read + project the (small) identity log per call; a per-tick cache is a later optimization if it matters.
      const log = readIdentityLog(HOME);
      const r = whois(buildProjection(log.events, log.corruption), owner);
      if (r.kind !== "entity") return "suspected"; // not-seen / candidates (ambiguous, F16) / pid-only (unverified) ⇒ don't convict
      const t = probeTargets(r.entity);
      const now = Date.now();
      const facts: ProbeFact[] = [];
      if (t.scope === "relay") facts.push({ target: "remote", result: "stale", at: now }); // remote: reported freshness only (v1 stale) ⇒ never alive/dead
      else {
        if (t.hostPid) facts.push({ target: "hostPid", result: kill0(t.hostPid), at: now, pid: t.hostPid }); // birthOk undefined (v1) ⇒ never alive/dead
        if (t.busPid) facts.push({ target: "busPid", result: kill0(t.busPid), at: now, pid: t.busPid });
      }
      return busLiveness(facts, "unknown").state; // output "unknown" (no confirmed-no-output signal) ⇒ never promoted to dead
    },
    // v1: no idle-same-role picker yet (that is the R8 overload rule, next) ⇒ a dead owner is left for escalation.
    pickReassignee: () => null,
    // v1: no validator-roster picker yet (needs bus-identity) ⇒ a stuck/dead RPV validator is left for escalation.
    pickValidator: () => null,
    // Safe single-segment ids (no "/") so the projection's waits/<waitId>.json never drops a legit reassigned/moved wait
    // (review P2b) — a "/" would be rejected by the path-safety whitelist. Dash separators keep them flat + collision-free.
    newWaitId: (base) => `${base}-r-${randomBytes(3).toString("hex")}`,
    newValidationRunId: (base) => `${base}-g-${randomBytes(3).toString("hex")}`,
    newActionId: () => `swp-${randomBytes(4).toString("hex")}`,
    freshDeadlineSec: () => nowSec() + 1800,
    // R5 channel: deliver the ping/escalation/reassign-notice to the owner's durable inbox (filesystem — part of bus
    // delivery; the owner's bus node claims it). Thin v1; bus-identity formalizes handle→delivery.
    // Bound a single action's IO per tick (P1-3): a slower delivery is left action_pending + re-fired next tick.
    actionTimeoutMs: Number(process.env.SWARM_ACTION_TIMEOUT_MS || "5000"),
    doAction: async (w, action) => {
      // Route to the DESTINATION: reassign / move-validator notify the NEW owner / validator seat (action.target carries
      // it, so routing is reconstructable from the durable intent); bypass / escalation ping the current owner.
      const recipient = action.actionKind === "reassign" || action.actionKind === "move-validator" ? action.target : w.owner;
      // P2-3: never route to an AMBIGUOUS identity via the legacy presence scanner — whois candidates means two sessions
      // share the handle and we cannot tell which is the real owner. Withhold delivery (the wait stays supervised + re-fired)
      // rather than ping the wrong one; routing resumes once the identity disambiguates. A single whois entity / not-seen
      // falls through to the existing presence-based inbox resolution.
      const idlog = readIdentityLog(HOME);
      if (whois(buildProjection(idlog.events, idlog.corruption), recipient).kind === "candidates") { log(`sweep doAction ${w.waitId}: recipient ${recipient} ambiguous (whois candidates) — withholding delivery`); return false; }
      const sid = resolveSession(recipient, listSessions(HOME));
      if (!sid) { log(`sweep doAction ${w.waitId}: recipient ${recipient} unresolved — not delivered`); return false; }
      const text = action.actionKind === "bypass" ? `[sweep] progress on ${w.waitId}? (subject ${JSON.stringify(w.subject)}) — past deadline`
        : action.actionKind === "escalation" ? `[sweep] ESCALATION: ${w.waitId} past deadline, needs a decision`
        : action.actionKind === "reassign" ? `[sweep] REASSIGN: ${w.waitId} (subject ${JSON.stringify(w.subject)}) — you are the new owner`
        : action.actionKind === "move-validator" ? `[sweep] VALIDATE: ${w.waitId} (run ${w.subject.validationRunId ?? "?"}) — you are the new validator seat`
        : `[sweep] ${w.waitId}: ${action.actionKind}`;
      // R6: at-least-once delivery — carry actionId so a re-fired duplicate is self-evident to the receiver (no transport dedup).
      try { writeInbox(HOME, sid, { from: SELF, fromLabel: "swarm-sweep", text: `${text} [actionId:${action.actionId}]`, via: "local", ts: Date.now(), actionId: action.actionId }); return true; }
      catch (e) { log(`sweep doAction ${w.waitId}: inbox write failed: ${e instanceof Error ? e.message : e}`); return false; }
    },
    log,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--observe-once") { await observeOnce(argv.slice(1)); return; }
  // --sweep-once: seed waits, run ONE sweep pass, print the resulting live waits, exit (deterministic validation — the
  // "first real wait handled" milestone without the infinite loop; mirrors --observe-once).
  if (argv[0] === "--sweep-once") {
    mkdirSync(path.dirname(DISPATCHER_LOCK), { recursive: true });
    const release = acquireSingleFlight(DISPATCHER_LOCK); // P2-1: never overlap a live dispatcher's sweep
    if (!release) { log("--sweep-once: a dispatcher holds the single-flight lock — skipping (no concurrent sweep)"); return; }
    try {
      const ref = { s: loadControlLog(CONTROL_LOG_DIR) };
      loadWaitSeed(ref);
      await sweepPass(buildSweepOps(ref));
      const live = Object.values(liveEntities(ref.s)).filter((b) => b.put === "wait").map((b) => (b as { wait: WaitRecord }).wait);
      console.log(JSON.stringify({ seq: ref.s.seq, liveWaits: live.map((w) => ({ waitId: w.waitId, state: w.state, owner: w.owner, resolution: w.resolution })) }, null, 2));
    } finally { release(); }
    return;
  }

  // Single-active-dispatcher guard (P2-1): refuse to start a second concurrent dispatcher (double delivery + same-seq
  // overwrite). The lock is held for the whole process and released on exit/signal.
  mkdirSync(path.dirname(DISPATCHER_LOCK), { recursive: true });
  const releaseLock = acquireSingleFlight(DISPATCHER_LOCK);
  if (!releaseLock) { log("dispatcher: another active dispatcher holds the single-flight lock — refusing to start a second"); return; }
  process.on("exit", () => releaseLock());
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { releaseLock(); process.exit(0); });

  const plan = loadPlanFile();
  const taskOn = plan !== null && TASK_EXEC;
  log(`single-active dispatcher up (cap=${CAP}, budget=${BUDGET_SEC}s, workRepo=${WORK_REPO || "<unset>"}, exec=${EXEC_ENABLED}, task=${taskOn ? `on:${plan!.jobId}` : "off"})`);
  const records = loadMirror();
  const ops = buildOps();
  const taskStateRef = { s: loadControlLog(CONTROL_LOG_DIR) };
  const taskOps = plan ? buildTaskOps(taskStateRef, jobStartSec(plan.jobId)) : null;
  loadWaitSeed(taskStateRef); // seed the migrated coordinator waits (first sweep input), if any
  // The sweep runs on its OWN loop with its OWN state ref (reloaded each tick) so a slow lifecycle/task pass never starves
  // it (R1 bounded scheduling). Single-writer safety across the two in-process loops = control-store disk-CAS (never
  // overwrite a committed seq) + the actionId-matched confirm; a stale commit is rejected + retried next tick.
  const sweepStateRef = { s: loadControlLog(CONTROL_LOG_DIR) };
  const sweepOps = buildSweepOps(sweepStateRef);
  // Write the projection once at startup so a consumer sees current state before this run's first commit (fail-soft).
  try { writeProjection(PROJECTION_DIR, taskStateRef.s, { nowSec: nowSec(), jobStartSec }); } catch (e) { log(`projection initial write failed: ${e instanceof Error ? e.message : e}`); }
  if (SWEEP_ENABLED) log(`liveness sweep ON${WAIT_SEED_FILE ? ` (seed=${WAIT_SEED_FILE})` : ""}`);

  // Rewrite the projection (now-dependent wall-clock judgments) + recompute the INV-1 livenessVerdict (L1b) from the CURRENT
  // control slice + heartbeat. The plan is resolved FROM the loaded state by buildControlCut (review P1-2: never the stale
  // startup SWARM_PLAN) — a job with no authoritative PlanPut yields UNVERIFIABLE, not a judgment off a stale plan. The verdict
  // is published with its evidence window (review P2-1). Fail-soft: a heartbeat gap omits the verdict this tick (filled next).
  const modesNow = () => ({ sweepOn: SWEEP_ENABLED, taskExecOn: taskOn, passInstance: SELF, sweepInstance: SELF });

  // L1-tail STALL disposition: fold the verdict into the durable incident registry + open/resolve its repair-wait. Fail-soft
  // (never throws): a commit/write error logs + leaves the verdict as-is, retried next tick. Returns the verdict to publish —
  // on a freshly-opened episode it re-asserts with the new episode so the published verdict carries the stable incidentId (C3).
  const findWaitIn = (st: LogState, id: string): WaitRecord | undefined => {
    const b = Object.values(liveEntities(st)).find((x) => x.put === "wait" && (x as Extract<ChangeBody, { put: "wait" }>).wait.waitId === id);
    return b === undefined ? undefined : (b as Extract<ChangeBody, { put: "wait" }>).wait;
  };
  const applyIncidentReconcile = (reg: IncidentRegistry, verdict: LivenessVerdict, cut: ControlCut, obs: ObservationFact[], openEp: number | undefined, jobId: string, controlEpisodeFloor: number): LivenessVerdict => {
    try {
      const owner = REPAIR_OWNER_ROUTABLE ? REPAIR_OWNER : SELF; // P2-2: a routable repair owner when configured, else labeled best-effort
      const rec = reconcileIncident(reg, verdict, nowSec(), { repairWindowSec: REPAIR_WAIT_SEC, owner, jobId, controlEpisodeFloor });
      if (rec.openRepairWait === undefined && rec.resolveRepairWait === undefined) {
        if (JSON.stringify(rec.registry) !== JSON.stringify(reg)) writeIncidents(INCIDENTS_FILE, rec.registry); // dedup lastObservedSeq bump
        return verdict;
      }
      // Apply the control-log action FIRST; persist the registry only if it committed, so the registry never leads CONTROL.
      const fresh = loadControlLog(CONTROL_LOG_DIR);
      let committed = false;
      if (rec.openRepairWait) {
        const spec = rec.openRepairWait;
        const existing = findWaitIn(fresh, spec.waitId);
        if (existing !== undefined && existing.state !== "resolved") {
          // ADOPT (review P1-3): the repair-wait is ALREADY live in CONTROL — a prior tick committed it but the registry write
          // didn't land, or the sweep advanced it to action_pending. Re-putting would clobber its phase/deadline/pendingAction.
          committed = true;
          log(`repair-wait ${spec.waitId} already live in CONTROL (state=${existing.state}) — adopting, not re-opening (P1-3)`);
        } else if (existing !== undefined) {
          // existing is RESOLVED: re-putting would RESURRECT it + erase its resolution (review 19152aa-P1-3 A). The episode floor
          // should have bumped past it — defer this tick; next tick reconcileRegistryWithControl's floor yields a fresh id.
          log(`repair-wait ${spec.waitId} exists RESOLVED in CONTROL — NOT resurrecting; deferring (floor bumps next tick)`);
          return verdict;
        } else {
          const w: WaitRecord = { waitId: spec.waitId, kind: "wait", subject: { jobId: spec.jobId }, state: "open", deadlineSec: spec.deadlineSec, owner: spec.owner, timeoutPolicy: "escalate" };
          committed = commitTask(fresh, [{ put: "wait", wait: w }]).result.ok;
          if (committed) log(`liveness STALL ${spec.incidentId} — opened repair-wait ${w.waitId} (owner=${spec.owner}${REPAIR_OWNER_ROUTABLE ? "" : "; NON-ROUTABLE default — set SWARM_REPAIR_OWNER for escalation delivery (recorded + supervised, delivery best-effort)"}, deadline +${REPAIR_WAIT_SEC}s)`);
        }
      } else if (rec.resolveRepairWait) {
        const spec = rec.resolveRepairWait;
        const w = findWaitIn(fresh, spec.waitId);
        if (w === undefined || w.state === "resolved") committed = true; // already gone/resolved (idempotent)
        else {
          const adv = advanceWait(w, { type: "close", resolution: { outcome: "recovered", reason: spec.reason, sourceOperationId: `liveness-recover-${SELF}` } });
          if (adv.ok) { committed = commitTask(fresh, [{ put: "wait", wait: adv.wait }]).result.ok; if (committed) log(`liveness recovered — resolved repair-wait ${spec.waitId}`); }
        }
      }
      if (!committed) { log(`repair-wait action deferred (seq conflict/failed) — retry next tick`); return verdict; }
      writeIncidents(INCIDENTS_FILE, rec.registry);
      // first-stall tick: the episode was just assigned (openEp was undefined) — re-assert so the published verdict carries it.
      if (rec.openRepairWait && openEp === undefined) {
        const ep = rec.registry.episodes[`${jobId}:no-live-holder`]?.episode;
        if (ep !== undefined) return assertLiveness({ controlCut: { ...cut, openIncidentEpisode: ep }, observations: obs, modes: modesNow() }, nowSec());
      }
      return verdict;
    } catch (e) { log(`incident reconcile failed: ${e instanceof Error ? e.message : e}`); return verdict; }
  };

  const refreshProjectionAndVerdict = (): void => {
    try {
      const st = loadControlLog(CONTROL_LOG_DIR);
      let livenessVerdict: unknown;
      let livenessSampledAtSec: number | undefined;
      let livenessValidUntilSec: number | undefined;
      if (plan) {
        // L1-tail: feed the OPEN incident episode (if any) into the cut so a persisting STALL carries its stable incidentId (C3).
        // A read FAILURE (non-ENOENT) leaves reg = null ⇒ we SKIP the incident reconcile this tick rather than run it on a
        // false-empty registry that would reset episode history (review P1-2); ENOENT returns an empty registry (legit first run).
        let reg: IncidentRegistry | null = null;
        try { reg = readIncidents(INCIDENTS_FILE); } catch (e) { log(`incidents read failed — SKIPPING incident reconcile this tick (no reset): ${e instanceof Error ? e.message : e}`); }
        // Reconcile the registry against CONTROL (the durable backstop) BEFORE deciding: adopt a live committed repair-wait the
        // registry lost, close an episode whose repair-wait already recovered in CONTROL, and get the episode floor so a new one
        // never resurrects/collides with a committed id (review 19152aa-P1-3). Persist the correction (fail-soft).
        let controlEpisodeFloor = 0;
        if (reg !== null) {
          const jobRepairWaits = Object.values(liveEntities(st))
            .filter((b) => b.put === "wait" && isRepairWaitId((b as Extract<ChangeBody, { put: "wait" }>).wait.waitId) && (b as Extract<ChangeBody, { put: "wait" }>).wait.subject.jobId === plan.jobId)
            .map((b) => { const w = (b as Extract<ChangeBody, { put: "wait" }>).wait; return { waitId: w.waitId, state: w.state }; });
          const sync = reconcileRegistryWithControl(reg, plan.jobId, jobRepairWaits, nowSec());
          controlEpisodeFloor = sync.controlEpisodeFloor;
          if (sync.registry !== reg) { try { writeIncidents(INCIDENTS_FILE, sync.registry); } catch (e) { log(`incidents sync write failed: ${e instanceof Error ? e.message : e}`); } reg = sync.registry; }
        }
        const ep = reg?.episodes[`${plan.jobId}:no-live-holder`];
        const openEp = ep?.open ? ep.episode : undefined;
        const cut = buildControlCut(plan.jobId, st, nowSec(), { jobStartSec: jobStartSec(plan.jobId), openIncidentEpisode: openEp });
        if (cut === null) {
          livenessVerdict = { verdict: "UNVERIFIABLE", missing: ["current-plan"] }; // no PlanPut in CONTROL ⇒ don't guess (P1-2)
          livenessSampledAtSec = nowSec();
          livenessValidUntilSec = nowSec(); // no evidence ⇒ immediately re-check (not valid into the future)
        } else {
          try {
            const hb = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8"));
            const obs = heartbeatObservations(hb, LIVENESS_WINDOW_SEC);
            let verdict = assertLiveness({ controlCut: cut, observations: obs, modes: modesNow() }, nowSec());
            if (reg !== null) verdict = applyIncidentReconcile(reg, verdict, cut, obs, openEp, plan.jobId, controlEpisodeFloor); // STALL⇒episode+repair-wait; OK⇒close (skipped if registry unknown)
            livenessVerdict = verdict;
            // Evidence-bounded freshness (review 59e7328-P2): the verdict is valid only until its EARLIEST-expiring observation,
            // NOT publish-time + window — otherwise a reused heartbeat's OK outlives the heartbeat it relied on. No obs ⇒ now.
            livenessSampledAtSec = obs.length > 0 ? Math.max(...obs.map((o) => o.sampledAtSec)) : nowSec();
            livenessValidUntilSec = obs.length > 0 ? Math.min(...obs.map((o) => o.validUntilSec)) : nowSec();
          } catch { /* no heartbeat yet / parse error ⇒ omit the verdict this tick (viz shows unknown), filled next tick */ }
        }
      }
      // Publish over the CURRENT state: applyIncidentReconcile may have committed a repair-wait (advancing CONTROL), so reload —
      // writing the pre-commit `st` would regress meta + PRUNE the just-committed repair-wait's projection file (review P2-1).
      // But the verdict was EVALUATED over `st` (seq before that commit), so stamp livenessCutSeq = st.seq — the verdict binds to
      // its own cut, not the advanced water level (review 19152aa-P2-1). meta.lastAppliedSeq still reflects the reloaded state.
      writeProjection(PROJECTION_DIR, loadControlLog(CONTROL_LOG_DIR), { nowSec: nowSec(), jobStartSec, livenessVerdict, livenessSampledAtSec, livenessValidUntilSec, livenessCutSeq: st.seq });
    } catch (e) { log(`projection refresh failed: ${e instanceof Error ? e.message : e}`); }
  };

  // v1 lightweight completion-record reader (§2c; real version-resolution/integrity is a later acceptance): the artifact at the
  // locator is a JSON completion record {requestId, payloadDigest, subject}; observedDigest = an INDEPENDENT sha256 of the file
  // bytes (never an author self-report). Missing / non-JSON / incomplete ⇒ null (not a candidate).
  const readArtifact: ReadArtifact = (locator) => {
    const abs = path.isAbsolute(locator) ? locator : path.join(WORK_REPO || HOME, locator);
    let raw: string;
    try { raw = readFileSync(abs, "utf8"); } catch { return null; }
    let rec: unknown;
    try { rec = JSON.parse(raw); } catch { return null; }
    const r = rec as { requestId?: unknown; payloadDigest?: unknown; subject?: { jobId?: unknown; revision?: unknown } };
    if (typeof r.requestId !== "string" || typeof r.payloadDigest !== "string" || typeof r.subject?.jobId !== "string") return null;
    return { observedDigest: createHash("sha256").update(raw).digest("hex"), record: { requestId: r.requestId, payloadDigest: r.payloadDigest, subject: { jobId: r.subject.jobId, ...(typeof r.subject.revision === "number" ? { revision: r.subject.revision } : {}) } } };
  };
  const snapshotBoardProgress = (): WatchSnapshot => {
    let boardFiles: string[] = [];
    try { boardFiles = readdirSync(BOARD_DIR).filter((f) => f.endsWith(".json")).sort(); } catch { /* no board dir yet */ }
    let progressMtimeMs = 0;
    try { progressMtimeMs = statSync(PROGRESS_FILE).mtimeMs; } catch { /* no PROGRESS yet */ }
    return { boardFiles, progressMtimeMs };
  };
  const notifyCoordinator = (text: string): void => {
    if (COORDINATOR !== "") {
      const sid = resolveSession(COORDINATOR, listSessions(HOME));
      if (sid) { try { writeInbox(HOME, sid, { from: SELF, fromLabel: "swarm-observer", text, via: "local", ts: Date.now() }); return; } catch (e) { log(`observer notify write failed: ${e instanceof Error ? e.message : e}`); } }
    }
    log(`[observer→coordinator] ${text}${COORDINATOR === "" ? " (SWARM_COORDINATOR unset — logged, not delivered)" : " (coordinator unresolved — logged)"}`);
  };

  // The durable-state observer (L2-struct 2/n, §2b-c/§2c + F25): discover completion-slot artifacts → verify → close production +
  // open consumption (so an artifact is found + the consumption obligation armed even if the producer never messaged); + watch
  // the board/PROGRESS surfaces → push each durable change to the coordinator. Fail-soft throughout; runs on the sweep loop.
  const runObserver = (): void => {
    try {
      let dreg: DelegationRegistry | null = null;
      try { dreg = readDelegations(DELEGATIONS_FILE); } catch (e) { log(`delegations read failed — skip completion-slot scan: ${e instanceof Error ? e.message : e}`); }
      if (dreg !== null) {
        for (const cand of scanCompletionSlots(dreg, readArtifact)) {
          const v = observeCandidate(dreg, cand, nowSec() + CONSUMPTION_WINDOW_SEC, nowSec());
          if (!v.verified) { log(`observer: candidate for ${cand.record.requestId} rejected: ${v.reason}`); continue; }
          const fresh = loadControlLog(CONTROL_LOG_DIR);
          const changes: ChangeBody[] = [];
          const prod = findWaitIn(fresh, v.closeProductionWait.waitId);
          if (prod !== undefined && prod.state !== "resolved") { const adv = advanceWait(prod, { type: "close", resolution: v.closeProductionWait.resolution }); if (adv.ok) changes.push({ put: "wait", wait: adv.wait }); }
          if (findWaitIn(fresh, v.openConsumptionWait.waitId) === undefined) changes.push({ put: "wait", wait: { waitId: v.openConsumptionWait.waitId, kind: "wait", subject: { jobId: v.openConsumptionWait.jobId }, state: "open", deadlineSec: v.openConsumptionWait.deadlineSec, owner: v.openConsumptionWait.owner, timeoutPolicy: "escalate" } });
          if (changes.length === 0 || commitTask(fresh, changes).result.ok) { writeDelegations(DELEGATIONS_FILE, v.registry); dreg = v.registry; log(`observer: ${cand.record.requestId} produced→consumption (artifact ${cand.observedLocator})`); }
          else log(`observer: ${cand.record.requestId} transition deferred (seq conflict) — retry next tick`);
        }
      }
      let snap: WatchSnapshot | null = null;
      try { snap = readWatchSnapshot(OBSERVER_SNAPSHOT_FILE); } catch (e) { log(`watch snapshot read failed — skip watch: ${e instanceof Error ? e.message : e}`); }
      if (snap !== null) {
        const curr = snapshotBoardProgress();
        for (const ev of detectWatchEvents(snap, curr)) {
          notifyCoordinator(ev.kind === "board" ? `board: ${ev.item} → ${ev.state}${ev.who ? ` by ${ev.who}` : ""} (durable change — reconcile)` : `PROGRESS.md changed (mtime ${ev.mtimeMs})`);
        }
        // advance the snapshot regardless (events were surfaced to inbox or log) so a persistently-unroutable coordinator does
        // not re-fire every board file each tick; a transient write error just re-surfaces next tick (bounded).
        try { writeWatchSnapshot(OBSERVER_SNAPSHOT_FILE, curr); } catch (e) { log(`watch snapshot write failed: ${e instanceof Error ? e.message : e}`); }
      }
    } catch (e) { log(`observer failed: ${e instanceof Error ? e.message : e}`); }
  };

  await runDispatchLoops({
    // Lifecycle handoff pass, then the business-task pass (§4.5: handoff advances lifecycle, then task observes/accepts/
    // dispatches). T1.5 RED LINE (fe0376cd): --task dispatch stays off (SWARM_TASK_EXEC) until the resume adapter +
    // lifecycle→commitControl migration land — a handoff's resume half is not yet wired to continue the business task.
    passTick: async () => {
      await pass(records, ops);
      if (plan && taskOn && taskOps) { taskStateRef.s = loadControlLog(CONTROL_LOG_DIR); await taskPass(plan, taskOps); }
      // NOTE: the projection + verdict refresh is NOT here — it lives on the sweep loop (below), so a wedged pass/taskPass
      // cannot freeze the on-disk verdict into a stale OK (review P2-1). Per-commit projection writes still happen via the
      // commitTask apply hook; this loop only drives the business passes.
    },
    // The liveness sweep (§0b R2) — scan durable waits + member liveness, auto-handle expired waits (ping/escalate/re-arm)
    // + dead owners (reassign) + stuck validators (move). The coordinator-replacement step; gated on SWARM_SWEEP.
    sweepTick: async () => {
      sweepStateRef.s = loadControlLog(CONTROL_LOG_DIR);
      if (SWEEP_ENABLED) await sweepPass(sweepOps);
      // Now-dependent projection + INV-1 verdict refresh on the INDEPENDENT sweep loop + its own ref (review P2-1): when the
      // pass loop wedges, this keeps re-sampling observations and a stale pass heartbeat flips the verdict to UNVERIFIABLE.
      // Runs even with sweep rules off — it is observability, not a sweep action; bounded, fail-soft inside the helper.
      refreshProjectionAndVerdict();
      // L2-struct observer (F22/F25): discover completion-slot artifacts + push board/PROGRESS durable changes to the coordinator.
      runObserver();
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    passIntervalMs: 5000,
    sweepIntervalMs: 5000,
    shouldStop: () => false,
    onError: (where, e) => log(`${where} error: ${e instanceof Error ? e.message : e}`),
    // Per-loop heartbeat (L1 subset): each loop records its own tick; a wedged loop stays in-flight while the other
    // advances. Fail-soft — observability, never a barrier.
    onTick: (loop, phase) => {
      try {
        const meta = { instance: SELF, pid: process.pid };
        const mode = loop === "pass" ? (taskOn ? "task" : "lifecycle") : SWEEP_ENABLED ? "sweep" : "off";
        if (phase === "start") beatStart(HEARTBEAT_FILE, meta, loop, loop === "pass" ? "pass+taskPass" : "sweep", nowSec(), mode);
        else beatEnd(HEARTBEAT_FILE, meta, loop, nowSec(), mode);
      } catch (e) { log(`heartbeat ${loop} ${phase} failed: ${e instanceof Error ? e.message : e}`); }
    },
  });
}

// Run the loop only when executed directly (not when imported, e.g. by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
