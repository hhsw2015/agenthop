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

import { spawn, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { type ControlRecord, PROVIDER_LIFETIME_SEC } from "../packages/bus/src/swarm/control.js";
import { parseManifest } from "../packages/bus/src/swarm/manifest.js";
import { type ObservedTip, tipToEvent } from "../packages/bus/src/swarm/acceptance.js";
import { type HandoffOps, handoffStep } from "../packages/bus/src/swarm/dispatch-step.js";
import { loadControlLog, commitControl, readControlBatches } from "../packages/bus/src/swarm/control-store.js";
import { entityKeyOf, type Change, type ChangeBody, type CommitResult, type LogState } from "../packages/bus/src/swarm/control-log.js";
import { loadPlan, type TaskPlan, type TaskSpec } from "../packages/bus/src/swarm/task-plan.js";
import type { TaskAttempt, ExecutionBinding } from "../packages/bus/src/swarm/task-state.js";
import type { Assignment } from "../packages/bus/src/swarm/task-assignment.js";
import { taskPass, buildSched, physicalSlotsOccupied, type TaskOps, type GitFacts } from "../packages/bus/src/swarm/task-pass.js";
import { readyTasks } from "../packages/bus/src/swarm/task-ready.js";
import { boardAdmitEnabled, planBoardWrites, planBoardSupervision, parsePolicyNum, postedFileName, reclaimedFileName, planClaimAdmission, parseClaimApplication, grantWaitId, boardItemId, claimedFileName, grantedFileName, rejectedFileName, parseBoardItemName, repostTmpAction, suppressPendingReposts, boardFileIdentityVerified, type ClaimApplication, type ExistingBoardFile } from "../packages/bus/src/swarm/task-board.js";
import { observeResultOnBranch } from "../packages/bus/src/swarm/task-observe.js";
import { mintEphToken, readEphSecret } from "../packages/bus/src/swarm/mint.js";
import { sweepPass, type SweepOps } from "../packages/bus/src/swarm/task-sweep.js";
import { acquireSingleFlight } from "../packages/bus/src/swarm/single-flight.js";
import { validSeedWait } from "../packages/bus/src/swarm/wait-seed.js";
import { runDispatchLoops } from "../packages/bus/src/swarm/dispatch-loops.js";
import { writeProjection } from "../packages/bus/src/swarm/projection.js";
import { beatStart, beatEnd } from "../packages/bus/src/swarm/heartbeat.js";
import { buildControlCut, heartbeatObservations, currentPlan } from "../packages/bus/src/swarm/liveness-review.js";
import { assertLiveness, type LivenessVerdict, type ControlCut, type ObservationFact } from "../packages/bus/src/swarm/task-liveness-inv1.js";
import { reconcileIncident, reconcileIncidentCore, reconcileRegistryWithControl, readIncidents, writeIncidents, type IncidentRegistry } from "../packages/bus/src/swarm/incident-episode.js";
import { isRepairWaitId, repairEpisodeOf, repairGroupKeyOf } from "../packages/bus/src/swarm/repair-wait-id.js";
import { observeCandidate, openDelegation, readDelegations, writeDelegations, type DelegationRegistry } from "../packages/bus/src/swarm/delegation-envelope.js";
import { planGrantEnvelope } from "../packages/bus/src/swarm/board-envelope.js";
import { scanCompletionSlots, detectWatchEvents, parseCompletionArtifact, readWatchSnapshot, writeWatchSnapshot, ingestLedgerChunk, pruneDeadLetterWindow, consolidatePending, readDeadLetterWatch, writeDeadLetterWatch, routeKeyOf, routingGroupKey, routeKeyOfGroup, routingActiveSignal, type ReadArtifact, type WatchSnapshot, type DeadLetterWatch } from "../packages/bus/src/swarm/delegation-observer.js";
import { advanceWait, isRenewable } from "../packages/bus/src/swarm/task-wait.js";
import { subjectProgressSeq, hasFreshSubjectEvidence, renewOperationId, renewalCount } from "../packages/bus/src/swarm/evidence-renewal.js";
import { resolveSession, listSessions, makeFileLiveness } from "../packages/bus/src/swarm/task-liveness.js";
import { whois, buildProjection, readIdentityLog, probeTargets, legacyInboxKeys, liveness as busLiveness, type ProbeFact, type ProbeResultKind } from "../packages/bus/src/bus-identity.js";
import { liveEntities, type WaitRecord } from "../packages/bus/src/swarm/control-log.js";
import { writeInbox, inboxDirName } from "../packages/bus/src/inbox.js";
import { scanInboxes, detectStalledInboxes } from "../packages/bus/src/swarm/inbox-sentinel.js";
import { herdrServerReachable, herdrAgentStates, herdrReadClean, herdrReadContent, herdrAgentState, herdrAgentPaneId, herdrPaneIdForSession, herdrWait, herdrWaitOutput, herdrExplain, sentinelDecision, buildApprovalDoc, type AgentState } from "../packages/bus/src/swarm/herdr.js";
import { coordinatorReportPlan, coordEscalateEnabled, type ReportSeverity } from "../packages/bus/src/swarm/coordinator-report.js";
import { superviseMember, type WatchOps, type SentinelEvent } from "../packages/bus/src/swarm/live-sentinel.js";
import { AlertDedup, alertKey, classifyMemberHealth, isOnRoster, classifyBlockedEscalation, screenIndicatesContentFilter, contentFilterHintNote, classifyFailure, failureHintNote, resolveSnapshotMembers, parsePsOutput, isDispatcherAlreadyRunning, shouldEmitWatchNotice } from "../packages/bus/src/swarm/sentinel-denoise.js";
import { autoscaleEnabled, readReviewLedger, reviewQueueDir, filterLiveRecords, queueDepth, instantaneousWant, buildSeatStatesFromLedger, canonicalizeLiveRecords, planAutoscaleSuggestion, type ScaleConfig } from "../packages/bus/src/swarm/review-seat-autoscale.js";
import { gaugeSamplingEnabled, shouldSampleGauge, writeBandwidthProjection } from "../packages/bus/src/swarm/dual-bandwidth-store.js";
import { placementEnabled, readPlacementSpec, readLedgerMachines, planPlacementSuggest, shouldSuggestPlacement } from "../packages/bus/src/swarm/placement-engine.js";
import { digestEnabled, digestActions, digestTextFromProjection } from "../packages/bus/src/swarm/morning-digest.js";
import { inboxWakeEnabled, installInboxWake, backstopWake } from "../packages/bus/src/swarm/inbox-wake.js";
import { writeDigestProjection, writeDigestProjectionRaw, readDigestProjection, readNotifiedState, markNotified, gatherDigestSources, archiveLegacyMigration } from "../packages/bus/src/swarm/morning-digest-store.js";
import { successionEnabled } from "../packages/bus/src/swarm/shell-succession.js";
import { readStatusFile } from "../packages/bus/src/statusfile.js";

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
// F40 unclaimed-mail sentinel: a durable inbox with unread mail older than this AND no live session draining it ⇒ escalate to
// the coordinator (silent-stall detection). 10min default — long enough that an ordinary flush cadence never trips it.
const INBOX_STALL_SEC = Number(process.env.SWARM_INBOX_STALL_SEC || "600");

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
// Local artifact root for RELATIVE completion-slot locators (review f0a999f-P2-4): WORK_REPO is a Git remote id (may be an
// HTTPS URL) — NEVER a filesystem base. A relative locator with no ARTIFACT_ROOT is skipped (not joined under a URL).
const ARTIFACT_ROOT = process.env.SWARM_ARTIFACT_ROOT || "";
// Dead-letter watch (F26): N dead-letters to the same `to` within WINDOW ⇒ a routing incident. The ledger WRITE side is
// bus-identity v1.5's (dormant until it exists); this is the read side.
const DEAD_LETTERS_FILE = path.join(HOME, ".agenthop", "swarm", "dead-letters.jsonl");
const DEAD_LETTER_WATCH_FILE = path.join(HOME, ".agenthop", "swarm", "dead-letter-watch.json"); // durable cursor/window/pending/notify (R1-R5)
// Parse an env numeric budget/cap to a FINITE integer >= min, else the default. A bare Number() yields NaN on a bad value, and
// a NaN bound SILENTLY disables itself — e.g. `renewalCount >= NaN` is always false, so the free-renewal cap vanishes and a wait
// renews forever (review ab1bf81-E4). An invalid config must fall back to the safe default, never to "no bound".
const envInt = (raw: string | undefined, fallback: number, min = 1): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
};
const DEAD_LETTER_WINDOW_MS = envInt(process.env.SWARM_DEAD_LETTER_WINDOW_MS, 120000);
const DEAD_LETTER_THRESHOLD = envInt(process.env.SWARM_DEAD_LETTER_THRESHOLD, 3);
// Per-tick budgets so the dead-letter watch never occupies the supervision loop unbounded (review bb2a2cb-P2-3 / d1bcd94-R3):
// read at most N BYTES of the ledger per tick from a persistent byte cursor (NOT a full-file slurp — the IO/decode/split cost
// is what must be bounded, not just the JSON.parse count) + process at most M routing groups per tick (round-robin cursor).
const MAX_READ_BYTES = envInt(process.env.SWARM_DEAD_LETTER_MAX_BYTES, 256 * 1024);
const MAX_ROUTING_GROUPS_PER_TICK = envInt(process.env.SWARM_ROUTING_GROUPS_PER_TICK, 32);
// R3: an over-long ledger line (no newline) past this many bytes is pathological ⇒ skip it instead of growing carry each tick;
// and notify at most this many owed incidents per tick (round-robin) so a backlog can't become an unbounded notify storm.
const MAX_CARRY_BYTES = envInt(process.env.SWARM_DEAD_LETTER_MAX_CARRY_BYTES, 64 * 1024);
const MAX_NOTIFY_PER_TICK = envInt(process.env.SWARM_ROUTING_NOTIFY_PER_TICK, 32);
// S11/4-n: suppress an IDENTICAL coordinator notice (same taskRef+text) re-sent within this window, so a repeating observer
// event does not spam the coordinator inbox. A transient send FAILURE is never recorded, so a genuine retry is not suppressed.
const NOTIFY_DEDUP_MS = envInt(process.env.SWARM_NOTIFY_DEDUP_MS, 60000, 0);
// §2c-b evidence renewal: a renewed liveness wait's fresh probe window (a coarse magnitude, NOT an ETA — §2c), and the finite
// number of FREE renewals a non-A1-approved wait gets before the sweep escalates instead of renewing ("不许无限 re-arm", acc ③).
const RENEW_WINDOW_SEC = envInt(process.env.SWARM_RENEW_WINDOW_SEC, 1800);
const MAX_FREE_RENEWALS = envInt(process.env.SWARM_MAX_FREE_RENEWALS, 20, 0); // 0 = a valid strict "no free renewals" policy
const PLAN_FILE = process.env.SWARM_PLAN || "";
const TASK_EXEC = /^(1|true|yes|on)$/i.test(process.env.SWARM_TASK_EXEC ?? "");
const CPA_BASE_URL = process.env.SWARM_CPA_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
const CHECKPOINT_BUDGET_SEC = Number(process.env.SWARM_CHECKPOINT_BUDGET_SEC || "300");
const TOKEN_MARGIN_SEC = Number(process.env.SWARM_TOKEN_MARGIN_SEC || "300");
// liveness sweep (team-collab §0b R2) — the coordinator-replacement pass step. Gated on SWARM_SWEEP (it writes to peer
// inboxes). SWARM_WAIT_SEED = a JSON file of {put:"wait"} entries to seed the control-log (the migrated coordinator waits).
const SWEEP_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SWARM_SWEEP ?? "");
const WAIT_SEED_FILE = process.env.SWARM_WAIT_SEED || "";
// S14 live sentinel: watch herdr-identified members (plus bus-presence fallback) for blocked / idle-timeout / working-fake-death
// and escalate to the coordinator (blocked ⇒ S19 approval via sentinelDecision+buildApprovalDoc). Gated on SWARM_SENTINEL
// (default OFF, dormant-ahead-of-use) AND herdr being reachable (it reads terminal screens). FAKEDEATH = status working but zero
// new terminal output for this long; IDLE = idle with no check-in for this long.
const SENTINEL_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SWARM_SENTINEL ?? "");
const SENTINEL_FAKEDEATH_SEC = envInt(process.env.SWARM_SENTINEL_FAKEDEATH_SEC, 900);
const SENTINEL_IDLE_SEC = envInt(process.env.SWARM_SENTINEL_IDLE_SEC, 1800);
// Inter-sample block / backoff for a working member's fake-death content sampling (LS1/LS2): bounds the loop so a quirky
// wait-output can never tight-spin, and sets how often the pane content hash is re-sampled within the fake-death window.
const SENTINEL_SAMPLE_SEC = envInt(process.env.SWARM_SENTINEL_SAMPLE_SEC, 60);
const GAUGE_SAMPLE_SEC = envInt(process.env.SWARM_GAUGE_SAMPLE_SEC, 60); // T5-2 seam: gauge sampling interval (sweep ticks faster, every 5s)
const DIGEST_HOUR = Math.min(23, envInt(process.env.SWARM_DIGEST_HOUR, 7, 0)); // morning-digest local target hour (clamped 0..23)

// T5-5 review-seat autoscale — SUGGESTION MODE ONLY (user ruling 2026-10-08: the flag is half-flipped). When
// SWARM_REVIEW_AUTOSCALE is on, the sweep reads the durable review-queue ledger, runs the pure planner, and ADVISES the
// coordinator (a durable-inbox suggestion, taskRef=autoscale-suggest); it NEVER spawns/reclaims a seat. LIVE BY DEFAULT
// (opt-out, user ruling 2026-10-10; kill with SWARM_REVIEW_AUTOSCALE=0). The thresholds are TUNABLE (same discipline as the dual-bandwidth gauge):
// kUp>kDown gives hysteresis; sustainSec debounces a transient spike; minDwellSec throttles how often a suggestion re-fires.
const SCALE_CFG: ScaleConfig = {
  kUp: envInt(process.env.SWARM_REVIEW_KUP, 2),
  kDown: envInt(process.env.SWARM_REVIEW_KDOWN, 1),
  floor: envInt(process.env.SWARM_REVIEW_FLOOR, 2),
  sustainSec: envInt(process.env.SWARM_REVIEW_SUSTAIN_SEC, 60),
  minDwellSec: envInt(process.env.SWARM_REVIEW_MIN_DWELL_SEC, 300),
};

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
// Commit pre-built Changes (caller supplies operationId + expectedEntityRevision) + the projection apply hook. Used directly
// when the operationId must be a specific value (e.g. the §2c-b renew id for countability); commitTask wraps it for the common
// case where the id is the default `${key}#${rev+1}`.
function commitChanges(state: LogState, changes: Change[]): { state: LogState; result: CommitResult } {
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

function commitTask(state: LogState, bodies: ChangeBody[]): { state: LogState; result: CommitResult } {
  return commitChanges(state, bodies.map((b) => {
    const key = entityKeyOf(b);
    const rev = state.revisions[key] ?? 0;
    return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev };
  }));
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
  // Path-boundary safety (BA2a defense-in-depth): a jobId can arrive from an untrusted board-claim body. Never concatenate a
  // raw jobId containing a path separator into a filename — encode it to a single safe segment. Plain identifiers are left
  // as-is (backward-compatible with existing <jobId>.started files; board claims are already identifier-validated upstream).
  const safe = /[/\\]/.test(jobId) ? encodeURIComponent(jobId) : jobId;
  const file = path.join(dir, `${safe}.started`);
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
      // apply-default (query-wait deadline, ab1bf81-P1#2) has NO recipient to ping — the pre-stored default IS the answer; there
      // is nothing to deliver, so report "delivered" and let the confirm phase apply it (applyDefaultOnTimeout → close).
      if (action.actionKind === "apply-default") return true;
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
      try { writeInbox(HOME, sid, { from: SELF, fromLabel: "swarm-sweep", taskRef: w.waitId, title: `sweep:${action.actionKind}`, text: `${text} [actionId:${action.actionId}]`, via: "local", ts: Date.now(), actionId: action.actionId }); return true; }
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
  // F44-⑤: defense-in-depth OVER the single-flight lock — refuse to start if another dispatcher LOOP process tree is already
  // running (the lock can be free while a lingering `npx tsx scripts/swarm-dispatch.ts` wrapper still lives). Excludes our own
  // process tree. Fail-soft: if the process table can't be read, we rely on the lock alone (never block a legit start on a ps error).
  try {
    const procs = parsePsOutput(execSync("ps -axo pid=,ppid=,command=", { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    if (isDispatcherAlreadyRunning(procs, process.pid)) { log("dispatcher: another dispatcher process tree is already running (npx/tsx wrapper past the lock) — refusing to start a second"); releaseLock(); return; }
  } catch (e) { log(`dispatcher: process-tree self-check skipped (ps unavailable: ${e instanceof Error ? e.message : e}) — relying on the single-flight lock`); }
  process.on("exit", () => releaseLock());
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { releaseLock(); process.exit(0); });

  const plan = loadPlanFile();
  const taskOn = plan !== null && TASK_EXEC;
  log(`single-active dispatcher up (cap=${CAP}, budget=${BUDGET_SEC}s, workRepo=${WORK_REPO || "<unset>"}, exec=${EXEC_ENABLED}, task=${taskOn ? `on:${plan!.jobId}` : "off"})`);
  // Flag status at startup (ops visibility; user ruling 2026-10-10 — the swarm wiring flags are now LIVE BY DEFAULT / opt-out,
  // kill with SWARM_<X>=0). Calls the SAME readers the features use, so the line reflects the real decision. SWARM_TG_ENTRY is the
  // deliberate exception (opt-in — the bridge needs a user-seeded token), read with its own opt-in form.
  const onoff = (b: boolean): string => (b ? "on" : "off");
  log(`flags: BOARD_ADMIT=${onoff(boardAdmitEnabled())} REVIEW_AUTOSCALE=${onoff(autoscaleEnabled())} SUCCESSION=${onoff(successionEnabled())} COORD_ESCALATE=${onoff(coordEscalateEnabled())} GAUGE_SAMPLING=${onoff(gaugeSamplingEnabled())} DIGEST=${onoff(digestEnabled())} INBOX_WAKE=${onoff(inboxWakeEnabled())} TG_ENTRY=${onoff(/^(1|true|yes|on)$/i.test(process.env.SWARM_TG_ENTRY ?? ""))} (opt-out default-on; kill with SWARM_<X>=0; TG_ENTRY is opt-in)`);
  // SWARM_INBOX_WAKE: bake a real-time ping into the delivery primitive — writeInbox pings the target's herdr pane on every new
  // message (any caller, zero discipline). No-op + hook left unset when the flag is off (byte-for-byte v0 delivery).
  installInboxWake(log);
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
          const sync = reconcileRegistryWithControl(reg, `${plan.jobId}:no-live-holder`, "liveness", jobRepairWaits, nowSec());
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

  // v1 lightweight completion-record reader (§2c; independent version-resolution + content integrity are a later acceptance):
  // the artifact is a JSON completion record {requestId, payloadDigest, subject, workTarget}; observedDigest = the DECLARED
  // workTarget (same domain as slot.targetDigest — review P1-1). Relative locators resolve under ARTIFACT_ROOT, NEVER WORK_REPO
  // (a Git remote id — review P2-4); a relative locator with no root is skipped, not silently joined. Null-safe (never throws).
  const readArtifact: ReadArtifact = (locator) => {
    let abs: string;
    if (path.isAbsolute(locator)) abs = locator;
    else if (ARTIFACT_ROOT !== "") abs = path.join(ARTIFACT_ROOT, locator);
    else { log(`observer: relative locator "${locator}" but SWARM_ARTIFACT_ROOT unset — skipping (WORK_REPO is not a filesystem base)`); return null; }
    let raw: string;
    try { raw = readFileSync(abs, "utf8"); } catch { return null; }
    return parseCompletionArtifact(raw);
  };
  // Sample the watched surfaces. A real ENOENT is a legit empty (no board dir / no PROGRESS yet); ANY OTHER sampling error ⇒
  // null, so the caller HOLDS the last good snapshot instead of certifying a false empty that re-fires every file next tick
  // (review P2-3).
  const snapshotBoardProgress = (): WatchSnapshot | null => {
    let boardFiles: string[];
    try { boardFiles = readdirSync(BOARD_DIR).filter((f) => f.endsWith(".json")).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") boardFiles = []; else { log(`observer: board readdir failed (${e instanceof Error ? e.message : e}) — holding snapshot`); return null; } }
    let progressMtimeMs: number;
    try { progressMtimeMs = statSync(PROGRESS_FILE).mtimeMs; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") progressMtimeMs = 0; else { log(`observer: PROGRESS stat failed (${e instanceof Error ? e.message : e}) — holding snapshot`); return null; } }
    return { boardFiles, progressMtimeMs };
  };
  // "delivered" = written to the coordinator inbox; "logged" = unroutable (unset/unresolved) best-effort to the log (NOT a
  // defect — a declared log-only mode); "failed" = routable but the inbox write errored (transient ⇒ the caller holds the
  // snapshot + retries so the event is not lost — review P2-2).
  const notifySent = new Map<string, number>(); // dedup: (taskRef\0text) -> last-sent ms; suppress an identical re-send within NOTIFY_DEDUP_MS
  const isStableSid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); // CE2: a verified stable SID, not a routable display handle
  const notifyCoordinator = (text: string, opts: { taskRef?: string; title?: string; severity?: ReportSeverity } = {}): "delivered" | "logged" | "failed" | "deduped" => {
    const now = Date.now();
    for (const [k, t] of notifySent) if (now - t >= NOTIFY_DEDUP_MS) notifySent.delete(k); // prune expired (bounds the map)
    const key = `${opts.taskRef ?? ""}\u0000${text}`;
    if ((notifySent.get(key) ?? -Infinity) > now - NOTIFY_DEDUP_MS) return "deduped"; // identical notice just DELIVERED — skip (CE4: sync delivery records dedup, so a later tick is suppressed)
    const s11 = { ...(opts.taskRef ? { taskRef: opts.taskRef } : {}), ...(opts.title ? { title: opts.title } : {}) }; // S11 structured header
    // RESOLVED coordinator ⇒ the durable inbox (the normal path).
    if (COORDINATOR !== "") {
      const sid = resolveSession(COORDINATOR, listSessions(HOME));
      if (sid) {
        try { writeInbox(HOME, sid, { from: SELF, fromLabel: "swarm-observer", ...s11, text, via: "local", ts: now }); notifySent.set(key, now); return "delivered"; }
        catch (e) { log(`observer notify write failed (transient) — will retry: ${e instanceof Error ? e.message : e}`); return "failed"; } // not recorded ⇒ retry not suppressed
      }
    }
    // UNRESOLVED + escalate flag OFF ⇒ the historical log-only mode (a declared best-effort; callers move on; no dedup so recovery re-delivers).
    if (!coordEscalateEnabled()) {
      log(`[observer→coordinator] ${text}${COORDINATOR === "" ? " (SWARM_COORDINATOR unset — logged)" : " (coordinator unresolved — logged)"}`);
      return "logged";
    }
    // F45 ② (SWARM_COORD_ESCALATE): escalate to a REAL surface, SYNCHRONOUSLY, so the return reflects the actual IO (CE1): a
    // successful durable S19 write discharges the obligation (dedup recorded); a write FAILURE returns "failed" (caller retries,
    // obligation retained); a notice with no verified surface returns "logged" (honest UNHEARD). CE2: the S19 inbox KEY must be a
    // VERIFIED STABLE SID (UUID) — never a routable display handle, which no identity drains. CE3: S19 is the preferred durable
    // route and is written directly (no herdr-pane query). The pane rung of coordinatorReportPlan is intentionally NOT exercised
    // here — it is async, the historical source of the early-discharge / duplicate-tick defects, and the coordinator is a stable
    // SID in practice so S19 always covers it; herdrPaneAvailable is passed false.
    const s19Sid = isStableSid(COORDINATOR) ? COORDINATOR : null;
    const plan = coordinatorReportPlan({ coordinatorResolved: false, s19Available: s19Sid !== null, herdrPaneAvailable: false, severity: opts.severity ?? "stall" });
    if (plan.surface === "s19" && s19Sid) {
      try { writeInbox(HOME, s19Sid, { from: SELF, fromLabel: "swarm-observer", ...s11, text: `[S19 incident] ${text}`, via: "local", ts: now }); notifySent.set(key, now); log(`[observer→coordinator] escalated to S19 durable incident (coordinator unresolved): ${text}`); return "delivered"; }
      catch (e) { log(`[observer→coordinator] S19 escalation write FAILED — retry: ${e instanceof Error ? e.message : e}`); return "failed"; } // CE1: failure keeps the obligation
    }
    log(`[observer→coordinator] UNHEARD/logged (coordinator unresolved${s19Sid ? "" : ", no verified stable SID"}): ${text}`); // plan=log (info severity, or no verified SID) — isReport=false
    return "logged";
  };

  // §2d-a board producer (board admission 5/n, the PULL path): post the current READY nodes as claimable board items so an
  // idle member can apply, and reap stale UNCLAIMED posts whose node is no longer ready. DORMANT-AHEAD-OF-USE: runs ONLY when
  // SWARM_BOARD_ADMIT is on (coordinator boundary #1/#2 — gate off ⇒ fully dry, writes nothing). Board files are the
  // application-queue projection, NEVER a second ledger — no CONTROL commit here (the admission commit is the consumer's).
  // The pure decision (which to post/reap) is planBoardWrites; this shell only does the atomic write + unlink. Fail-soft.
  const runBoardProducer = (): void => {
    if (!plan || !boardAdmitEnabled()) return;
    try {
      const state = loadControlLog(CONTROL_LOG_DIR);
      // BA1: post from the job's AUTHORITATIVE plan in the current CONTROL (fall back to the startup copy only before the
      // PlanPut lands). BA3: isolate the ready computation to THIS job's attempts/accepted.
      const cur = currentPlan(state, plan.jobId) ?? plan;
      const all = buildSched(cur, state);
      const attempts = all.attempts.filter((a) => a.jobId === cur.jobId);
      const acceptedResults = all.acceptedResults.filter((r) => r.jobId === cur.jobId);
      const usage = { totalAttempts: attempts.length, wallClockSec: Math.max(0, nowSec() - jobStartSec(cur.jobId)) };
      const ready = readyTasks({ plan: cur, attempts, acceptedResults, now: nowSec(), jobUsage: usage });
      mkdirSync(BOARD_DIR, { recursive: true });
      // BP3: adopt an orphaned `.repost.<pid>.tmp` left when a crash hit BETWEEN the repost's rename-acquire
      // (posted -> tmp) and its rewrite/restore, so the item's escalation progress (repostCount + deadline) survives a
      // restart. Restore ONLY a genuinely-missing item: if ANY live state exists for its itemId (posted already back, or
      // claimed/granted/terminal) the item MOVED ON -> the tmp is stale, drop it (never revive a claimed/moved item ->
      // claimed+posted coexisting). A restore that itself FAILS keeps the itemId a PENDING obligation (below), so a fresh
      // first post is suppressed (never reset the count by re-creating the item). Only touch a tmp whose writer is gone.
      const boardFiles = readdirSync(BOARD_DIR);
      // BP3 counterexample A: liveItemIds counts ONLY body-VERIFIED states — a forged/mismatched file (filename itemId ≠
      // body identity) must NOT evict a legit tmp (the consumer rejects it on BA2b, so trusting its filename would drop a
      // real obligation and re-post a fresh count-less item). Verify each candidate state's body against its filename.
      const liveItemIds = new Set<string>();
      for (const bf of boardFiles) {
        const p = parseBoardItemName(bf);
        if (!p) continue;
        let body: unknown = null;
        try { body = JSON.parse(readFileSync(path.join(BOARD_DIR, bf), "utf8")); } catch { /* unreadable ⇒ unverified */ }
        if (boardFileIdentityVerified(p.itemId, body)) liveItemIds.add(p.itemId);
      }
      const pendingTmpItemIds = new Set<string>();
      for (const f of boardFiles) {
        const m = /^(.+)\.json\.repost\.(\d+)\.tmp$/.exec(f);
        if (!m) continue;
        const itemId = m[1]!;
        const writerPid = Number(m[2]);
        let writerAlive = false; try { process.kill(writerPid, 0); writerAlive = true; } catch { /* dead */ }
        // BP3 counterexample B: an UNRESTORED legit tmp ALWAYS suppresses a fresh first post — a live/recycled/ambiguous
        // writer pid is NO exception; its escalation obligation still lives in the tmp. Leave the tmp (don't steal a
        // possibly-live producer's in-flight work), but retain the obligation so planBoardWrites can't re-post it fresh.
        if (writerAlive && writerPid !== process.pid) { pendingTmpItemIds.add(itemId); continue; }
        const tmp = path.join(BOARD_DIR, f);
        if (repostTmpAction(itemId, liveItemIds) === "drop") { try { unlinkSync(tmp); } catch { /* fine */ } continue; } // body-verified moved-on -> stale
        try { renameSync(tmp, path.join(BOARD_DIR, postedFileName(itemId))); liveItemIds.add(itemId); } // recovered -> now live
        catch { pendingTmpItemIds.add(itemId); } // restore FAILED -> obligation still pending; suppress a fresh first post
      }
      // Read each existing board file's body so the producer can refresh a stale-revision post (BA8b) and tell its own job's
      // entries from another job's (BA4). Unreadable ⇒ body null.
      const existing: ExistingBoardFile[] = readdirSync(BOARD_DIR).map((f) => {
        let body: ExistingBoardFile["body"] = null;
        try { body = JSON.parse(readFileSync(path.join(BOARD_DIR, f), "utf8")); } catch { /* unreadable ⇒ null */ }
        return { file: f, body };
      });
      const { post, reap } = planBoardWrites(ready, cur, existing, { postedBy: SELF, nowSec: nowSec() });
      // Reap BEFORE post (BA8a): a stale-revision refresh overwrites the posted file in place via atomicWrite, so post must run
      // AFTER any unlink — never write the fresh item and then delete it. (planBoardWrites keeps the two sets path-disjoint,
      // but ordering reap-first is the robust guarantee.)
      // BP3: suppress a fresh first post for any node whose itemId still has an UNRESTORED repost tmp — its escalation
      // obligation lives in that tmp; re-posting fresh would reset repostCount + deadline and bypass the cap.
      const toPost = suppressPendingReposts(post, pendingTmpItemIds);
      for (const f of reap) { try { unlinkSync(path.join(BOARD_DIR, f)); } catch { /* raced away — fine */ } }
      for (const item of toPost) atomicWrite(path.join(BOARD_DIR, postedFileName(item.itemId)), JSON.stringify(item));
      if (toPost.length || reap.length) log(`board producer: posted ${toPost.length}, reaped ${reap.length} stale`);

      // BA9: supervise STILL-READY posted-but-unclaimed items past their claim deadline — REPOST (bounded) ->
      // REPORT (S19-form incident, deduped by a `.report.json` marker) -> RECLAIM (rename to the terminal
      // `reclaimed` dead-letter, which planBoardWrites then never auto-re-posts). Still inside the board gate.
      const supPolicy = {
        claimTtlSec: parsePolicyNum(process.env.SWARM_BOARD_CLAIM_TTL_SEC, 300),
        maxReposts: parsePolicyNum(process.env.SWARM_BOARD_MAX_REPOSTS, 2, { integer: true }), // BP6: finite non-neg int, preserve 0
        reportGraceSec: parsePolicyNum(process.env.SWARM_BOARD_REPORT_GRACE_SEC, 300),
      };
      const readyItemIds = new Set(ready.map((r) => boardItemId(cur.jobId, r.nodeId)));
      // BP2: supervise a FRESH snapshot taken AFTER the post/reap writes — never the pre-write `existing`.
      const fresh: ExistingBoardFile[] = readdirSync(BOARD_DIR).map((f) => {
        let body: ExistingBoardFile["body"] = null;
        try { body = JSON.parse(readFileSync(path.join(BOARD_DIR, f), "utf8")); } catch { /* unreadable ⇒ null */ }
        return { file: f, body };
      });
      const sup = planBoardSupervision(fresh, readyItemIds, nowSec(), supPolicy);
      // BP3: repost/report migrate the SAME posted file atomically — acquire it by rename (skip if a member
      // claimed it first), rewrite, release. Losing the source never publishes a new state.
      const atomicRepost = (itemId: string, body: unknown): boolean => {
        const posted = path.join(BOARD_DIR, postedFileName(itemId));
        const tmp = `${posted}.repost.${process.pid}.tmp`;
        try { renameSync(posted, tmp); } catch { return false; } // gone/claimed ⇒ never revive
        try {
          atomicWrite(posted, JSON.stringify(body));
        } catch {
          // BP3: the rewrite failed — RESTORE the acquired original (with its repostCount/postedAtSec) so the
          // item's escalation progress is never lost. A failure that leaves only the tmp would make the next
          // planBoardWrites re-post a fresh first item (count/deadline reset, cap bypassed). If restore also fails,
          // the tmp survives for the next tick's adoption sweep to recover.
          try { renameSync(tmp, posted); } catch { /* adoption sweep will recover the tmp */ }
          return false;
        }
        try { unlinkSync(tmp); } catch { /* fine */ }
        return true;
      };
      for (const it of sup.reposts) atomicRepost(it.itemId, it);
      for (const it of sup.reports) {
        // BP1: the reportedAtSec stamp is what starts the reclaim grace, so it must mean "a report was durably
        // saved". Write the S19 incident FIRST; ONLY a confirmed save then stamps the posted file. A failed save
        // leaves reportedAtSec unset, so the next tick re-emits the report (the obligation is retained) — never
        // stamp-then-grace-then-reclaim with no report file. The incident content is fixed per item, so a re-write
        // before the stamp lands is idempotent.
        const doc = buildApprovalDoc({
          from: SELF, fromLabel: "swarm-board", nowSec: nowSec(), member: it.itemId,
          screenSummary: `board item ${it.itemId} unclaimed after ${supPolicy.maxReposts} reposts — no capable member claimed it`,
          options: [{ label: "reassign / raise capacity", consequence: "a capable member claims the item" }, { label: "let it reclaim", consequence: "the node returns to the dead-letter lane after the grace" }],
        });
        let saved = false;
        try { atomicWrite(path.join(BOARD_DIR, `${it.itemId}.report.json`), JSON.stringify(doc.body)); saved = true; } catch { /* not durable — retry next tick, do NOT stamp */ }
        if (!saved) continue;
        atomicRepost(it.itemId, it); // persist reportedAtSec on the still-unclaimed file (grace starts here); claimed/gone ⇒ harmless skip
      }
      for (const rc of sup.reclaims) {
        const from = path.join(BOARD_DIR, rc.file);
        const to = path.join(BOARD_DIR, reclaimedFileName(rc.itemId, SELF));
        let body: unknown = { itemId: rc.itemId };
        try { body = JSON.parse(readFileSync(from, "utf8")); } catch { /* minimal */ }
        try { renameSync(from, to); } catch { continue; } // BP3: ATOMIC state migration; skip if claimed/gone (never posted+reclaimed, never half-done)
        atomicWrite(to, JSON.stringify({ ...(body as object), reclaimedBy: SELF, reclaimedAtSec: nowSec(), deadLetter: true, note: "unclaimed past the repost cap + grace; dead-lettered (coordinator must re-enqueue)" }));
      }
      if (sup.reposts.length || sup.reports.length || sup.reclaims.length) log(`board supervision: reposted ${sup.reposts.length}, reported ${sup.reports.length}, reclaimed ${sup.reclaims.length}`);
    } catch (e) { log(`board producer failed (isolated): ${e instanceof Error ? e.message : e}`); }
  };

  // §2d-b admission REJECT: mark a claim rejected (reason into the board file) + tell the applicant. Best-effort.
  const rejectClaim = (claim: { itemId: string; who: string }, reason: string): void => {
    const from = path.join(BOARD_DIR, claimedFileName(claim.itemId, claim.who));
    const to = path.join(BOARD_DIR, rejectedFileName(claim.itemId, claim.who));
    try { const item = JSON.parse(readFileSync(from, "utf8")); atomicWrite(to, JSON.stringify({ ...item, rejectedReason: reason, rejectedAtSec: nowSec() })); unlinkSync(from); }
    catch { try { renameSync(from, to); } catch { /* raced away */ } }
    try { writeInbox(HOME, claim.who, { from: SELF, fromLabel: "swarm-admission", text: `[admission] rejected ${claim.itemId}: ${reason}`, via: "local", ts: Date.now() }); } catch { /* best-effort */ }
    log(`board admission: rejected ${claim.itemId} (${claim.who}): ${reason}`);
  };

  // §2d-b GRANT delivery (BA5 — receipt-first, at-least-once): the CONTROL grant is already durable. Deliver the receipt to
  // the applicant, and mark the board item `granted` ONLY once the receipt is written. If the receipt write fails, LEAVE the
  // claim as claimed — next tick's reconcile re-enters here and retries, so the receipt obligation is never silently dropped.
  // A benign duplicate receipt is acceptable; a lost one is not. NO execution side-effect (boundary #3 — A2 wires startTask).
  // §2b OPEN result: "none" = no envelope needed (node has no required output) ⇒ mark granted normally; "deferred" = OPEN
  // could not complete ⇒ EO1 the caller keeps the claim (retry next reconcile), NEVER mark granted; "opened" = registered +
  // wait committed, carries the frozen identity the receipt needs (EO3).
  type EnvelopeOpen = { status: "none" } | { status: "deferred" } | { status: "settled" } | { status: "opened"; requestId: string; payloadDigest: string; revision?: number };
  const deliverGrantAndMark = (claim: { itemId: string; who: string }, grant: { attemptId: string; waitId: string; bindingId?: string; envelope?: EnvelopeOpen }): void => {
    const claimFile = path.join(BOARD_DIR, claimedFileName(claim.itemId, claim.who));
    const grantedFile = path.join(BOARD_DIR, grantedFileName(claim.itemId, claim.who));
    const bindingNote = grant.bindingId ? ` (binding ${grant.bindingId})` : "";
    // EO3: the receipt carries the envelope's requestId + payloadDigest + subject revision + a RESOLVABLE payload source
    // (the delegations registry, keyed by requestId, holds the inline frozen payload) — enough to locate the frozen payload
    // and run receiptMatches. No execution asked (A2).
    const e = grant.envelope?.status === "opened" ? grant.envelope : undefined;
    const envelopeNote = e ? `; delegation envelope OPEN — requestId ${e.requestId}, payloadDigest ${e.payloadDigest}, subject revision ${e.revision ?? "?"}, payload source: delegations registry [${e.requestId}] @ ${DELEGATIONS_FILE}` : "";
    try { writeInbox(HOME, claim.who, { from: SELF, fromLabel: "swarm-admission", text: `[admission] granted ${claim.itemId} → attempt ${grant.attemptId}${bindingNote}; supervision wait ${grant.waitId} open${envelopeNote}. DO NOT begin execution — A2 (real dispatch/V8) is not wired yet.`, via: "local", ts: Date.now() }); }
    catch (e) { log(`board admission ${claim.itemId}: receipt write failed (grant committed) — claim kept, retry next tick: ${e instanceof Error ? e.message : e}`); return; } // BA5: do NOT mark granted until the receipt is delivered
    try { renameSync(claimFile, grantedFile); } catch (e) { log(`board admission ${claim.itemId}: granted-rename failed (receipt delivered; reconciled next tick): ${e instanceof Error ? e.message : e}`); }
    log(`board admission: granted ${claim.itemId} to ${claim.who} (attempt ${grant.attemptId})`);
  };

  // §2b OPEN side (R14 pre-flight, dual to BA9's post-side): open a PRODUCTION delegation envelope for the granted work, so a
  // granted-but-unproduced unit is supervised through openDelegation's production-wait (the sweep already escalates it). PURE
  // mapping (planGrantEnvelope) → openDelegation; the wait is committed FIRST, THEN the registry persisted (so the sweep never
  // sees a persisted envelope with no wait). Idempotent on the attemptId (= requestId): a re-grant/reconcile replay re-opens
  // nothing (no new wait). Best-effort + isolated: a skip/defer just means the next reconcile retries (receipt still delivered;
  // START stays A2 — this opens + supervises, never executes). Returns whether the envelope is active (for the receipt note).
  const openGrantEnvelope = (st: LogState, app: ClaimApplication, attemptId: string): EnvelopeOpen => {
    try {
      const p = currentPlan(st, app.jobId);
      if (p === undefined) return { status: "deferred" }; // no authoritative plan now ⇒ retry next reconcile
      const spec = planGrantEnvelope({ jobId: app.jobId, nodeId: app.nodeId, attemptId, specDigest: app.specDigest, inputBindingDigest: app.inputBindingDigest }, p, nowSec(), app.who, SELF);
      if (spec === null) return { status: "none" }; // node has no required output ⇒ nothing to observe ⇒ no envelope (mark granted normally)
      let reg: DelegationRegistry;
      try { reg = readDelegations(DELEGATIONS_FILE); } catch (e) { log(`board envelope ${app.jobId}/${app.nodeId}: delegations unreadable — retry next reconcile: ${e instanceof Error ? e.message : e}`); return { status: "deferred" }; } // corrupt ⇒ never overwrite
      const open = openDelegation(reg, spec, nowSec());
      if (!open.ok) { log(`board envelope ${app.jobId}/${app.nodeId}: open rejected (${open.reason}) — retry next reconcile`); return { status: "deferred" }; }
      // EO2: recover the envelope by the production wait's ACTUAL lifecycle in CONTROL (its id comes from the registered
      // envelope, not a re-derived formula). Never re-declare an active OPEN over a wait that is no longer live, nor persist a
      // production-phase envelope that contradicts CONTROL.
      const waitId = open.envelope.productionWaitId;
      // A FREEZE (op-conflict) lives in LogState.frozen, NOT wait.state — a frozen wait can still read state "open". A frozen
      // production is BLOCKED, not concluded: retain the recovery obligation (keep the claim, no OPEN receipt, nothing
      // persisted over the conflict) and re-evaluate once the freeze is lifted ⇒ deferred, not settled.
      if (st.frozen.includes(`wait:${waitId}`)) { log(`board envelope ${app.jobId}/${app.nodeId}: production wait ${waitId} is frozen (op-conflict) — retaining the claim, not declaring OPEN`); return { status: "deferred" }; }
      const existingWait = findWaitIn(st, waitId);
      const waitLive = existingWait !== undefined && (existingWait.state === "open" || existingWait.state === "action_pending");
      // A RESOLVED/concluded production (produced / cancelled / revoked) is terminal — the grant stands, no OPEN receipt, nothing persisted over it.
      if (existingWait !== undefined && !waitLive) { log(`board envelope ${app.jobId}/${app.nodeId}: production wait ${waitId} is ${existingWait.state} — not re-declaring OPEN`); return { status: "settled" }; }
      // Commit the production-wait ONLY when it is ABSENT (the registry may have been lost after a prior wait-commit); a LIVE
      // existing wait is adopted as-is — never re-committed (which would reset its deadline).
      if (existingWait === undefined && open.openProductionWait !== undefined) {
        const w = open.openProductionWait;
        const committed = commitTask(st, [{ put: "wait", wait: { waitId: w.waitId, kind: "wait", subject: { jobId: w.jobId }, state: "open", deadlineSec: w.deadlineSec, owner: w.owner, timeoutPolicy: "escalate" } }]).result.ok;
        if (!committed) { log(`board envelope ${app.jobId}/${app.nodeId}: production-wait commit deferred — retry next reconcile`); return { status: "deferred" }; } // never persist the registry without its wait
      }
      writeDelegations(DELEGATIONS_FILE, open.registry);
      // EO3: the receipt binds to the REGISTERED envelope openDelegation returned (its original requestId/payloadDigest/
      // revision), NOT the current candidate spec — a plan-revision bump between a lost first receipt and the retry must not
      // ship a receipt whose revision diverges from the persisted identity (receiptMatches would then fail).
      return { status: "opened", requestId: open.envelope.requestId, payloadDigest: open.envelope.payloadDigest, ...(open.envelope.subject.revision !== undefined ? { revision: open.envelope.subject.revision } : {}) };
    } catch (e) { log(`board envelope open failed (isolated) — retry next reconcile: ${e instanceof Error ? e.message : e}`); return { status: "deferred" }; }
  };

  // §2d-b admission CONSUMER (board admission 5/n, v2 — codex 3fda743 review): a claim (`<item>.claimed.<who>.json`) is a
  // RESERVATION APPLICATION, not authority. Each tick, re-run admission on the CURRENT CONTROL: resolve the job's authoritative
  // plan (BA1), validate the untrusted claim BODY against it (BA2), isolate the scheduler input to the claim's job (BA3), gate
  // on free capacity (BA6) → GRANT (commit intent+attempt(+retired)+supervision wait, receipt-first then mark granted) /
  // REJECT (terminal, mark + reason) / RECONCILE (already granted to this member — re-deliver receipt + fix board) / DEFER
  // (transient: no plan yet / capacity full — leave the claim). Gated by SWARM_BOARD_ADMIT (live by default; kill with =0; boundary #1/#2). NO startTask
  // (boundary #3). The board is an app-queue + projection, never a 2nd ledger: a grant whose commit fails leaves the claim for
  // re-review. Fail-soft, per-claim isolated.
  const runBoardConsumer = (): void => {
    if (!plan || !boardAdmitEnabled()) return;
    let files: string[];
    try { files = readdirSync(BOARD_DIR); } catch { return; } // no board dir yet ⇒ nothing to admit
    const claims = files.map((f) => parseBoardItemName(f)).filter((p): p is { itemId: string; state: "claimed"; who: string } => p !== null && p.state === "claimed");
    for (const claim of claims) {
      const claimFile = path.join(BOARD_DIR, claimedFileName(claim.itemId, claim.who));
      try {
        const state = loadControlLog(CONTROL_LOG_DIR);
        // BA2: the claim FILE BODY is untrusted (any member can write into the shared board dir). Validate it before admitting.
        let app: ClaimApplication | null = null;
        try { app = parseClaimApplication(JSON.parse(readFileSync(claimFile, "utf8")), claim.who); } catch { app = null; }
        if (app === null) { rejectClaim(claim, "unreadable or malformed claim body"); continue; }
        // BA2b: bind the file NAME to the body identity — a claim whose filename says one (job,node) but whose body is another's
        // valid entry must not be admitted under the filename's key. (Also keeps the granted/receipt rename on the right item.)
        if (claim.itemId !== boardItemId(app.jobId, app.nodeId)) { rejectClaim(claim, `claim filename does not match body identity (${claim.itemId} vs ${boardItemId(app.jobId, app.nodeId)})`); continue; }
        // BA6: free GLOBAL physical capacity, recomputed from the just-loaded state (a same-tick prior grant is already durable).
        const freeSlots = Math.max(0, CAP - physicalSlotsOccupied(state, nowSec()));
        const verdict = planClaimAdmission(state, app, {
          nowSec: nowSec(), jobStartSec: jobStartSec(app.jobId), launchId: `rw-${randomBytes(4).toString("hex")}`, freeSlots,
          remainingLifeSec: VM_LIFETIME_SEC, checkpointBudgetSec: CHECKPOINT_BUDGET_SEC, handoffMarginSec: HANDOFF_LEAD_SEC, tokenMarginSec: TOKEN_MARGIN_SEC, budgetSec: BUDGET_SEC,
        });
        if (verdict.verdict === "defer") { log(`board admission: ${claim.itemId} deferred — ${verdict.reason}`); continue; } // transient ⇒ leave claim, re-review next tick
        if (verdict.verdict === "reject") { rejectClaim(claim, verdict.reason); continue; }
        if (verdict.verdict === "reconcile") {
          const env = openGrantEnvelope(state, app, verdict.attemptId); // retry the envelope open (idempotent) on reconcile
          if (env.status === "deferred") { log(`board admission ${claim.itemId}: envelope OPEN still deferred — claim kept for retry`); continue; } // EO1: never mark granted without the envelope
          deliverGrantAndMark(claim, { attemptId: verdict.attemptId, waitId: grantWaitId(verdict.attemptId), envelope: env }); continue; // BA5: re-deliver receipt then mark
        }
        // GRANT: commit intent+attempt(+retired)+supervision wait (NO startTask). A failed commit leaves the claim for re-review.
        const r = commitTask(state, verdict.bodies);
        if (!r.result.ok) { log(`board admission ${claim.itemId}: grant commit rejected (${r.result.reason}) — claim left for re-review next tick`); continue; }
        const env = openGrantEnvelope(r.state, app, verdict.attemptId); // §2b OPEN the production envelope on the post-grant state
        // EO1: a DEFERRED open must NOT mark granted — keep the claim so the next tick's reconcile retries OPEN (the grant
        // attempt is already durable; the receipt + granted-rename wait until the envelope is open). Never granted-without-envelope.
        if (env.status === "deferred") { log(`board admission ${claim.itemId}: envelope OPEN deferred — claim kept for retry (grant committed, receipt pending)`); continue; }
        deliverGrantAndMark(claim, { attemptId: verdict.attemptId, waitId: verdict.waitId, bindingId: verdict.bindingId, envelope: env });
      } catch (e) { log(`board claim ${claim.itemId} failed (isolated): ${e instanceof Error ? e.message : e}`); }
    }
  };

  // The durable-state observer (L2-struct 2/n, §2b-c/§2c + F25). Two INDEPENDENT fail-soft halves (a failure in one must not
  // block the other — review P2-1): completion-slot discovery + the board/PROGRESS watch. Runs on the sweep loop.
  const runObserver = (): void => {
    try { // --- completion-slot scan: discover → verify → close production + open consumption ---
      let dreg: DelegationRegistry | null = null;
      try { dreg = readDelegations(DELEGATIONS_FILE); } catch (e) { log(`delegations read failed — skip completion-slot scan: ${e instanceof Error ? e.message : e}`); }
      if (dreg !== null) {
        for (const cand of scanCompletionSlots(dreg, readArtifact)) {
          try { // per-slot isolation: one bad candidate can't abort the scan (review P2-1)
            const v = observeCandidate(dreg, cand, nowSec() + CONSUMPTION_WINDOW_SEC, nowSec());
            if (!v.verified) { log(`observer: candidate ${cand.record.requestId} rejected: ${v.reason}`); continue; }
            const fresh = loadControlLog(CONTROL_LOG_DIR);
            const prod = findWaitIn(fresh, v.closeProductionWait.waitId);
            // P1-2: only a CURRENTLY-VALID production receipt advances to consumption.
            if (prod === undefined) { log(`observer: ${cand.record.requestId} production wait missing — not creating consumption`); continue; }
            if (prod.state === "resolved") {
              // already-produced replay (its consumption wait exists) ⇒ catch the registry up; cancelled/revoked/other ⇒ do NOT advance.
              if (prod.resolution?.outcome === "produced" && findWaitIn(fresh, v.openConsumptionWait.waitId) !== undefined) { writeDelegations(DELEGATIONS_FILE, v.registry); dreg = v.registry; }
              else log(`observer: ${cand.record.requestId} production wait resolved (${prod.resolution?.outcome ?? "?"}) without a consumption wait — not re-advancing (cancelled/revoked)`);
              continue;
            }
            // open / action_pending (reminder in flight is still valid) ⇒ close production + open consumption.
            const changes: ChangeBody[] = [];
            const adv = advanceWait(prod, { type: "close", resolution: v.closeProductionWait.resolution });
            if (adv.ok) changes.push({ put: "wait", wait: adv.wait });
            if (findWaitIn(fresh, v.openConsumptionWait.waitId) === undefined) changes.push({ put: "wait", wait: { waitId: v.openConsumptionWait.waitId, kind: "wait", subject: { jobId: v.openConsumptionWait.jobId }, state: "open", deadlineSec: v.openConsumptionWait.deadlineSec, owner: v.openConsumptionWait.owner, timeoutPolicy: "escalate" } });
            if (changes.length === 0 || commitTask(fresh, changes).result.ok) { writeDelegations(DELEGATIONS_FILE, v.registry); dreg = v.registry; log(`observer: ${cand.record.requestId} produced→consumption (artifact ${cand.observedLocator})`); }
            else log(`observer: ${cand.record.requestId} transition deferred (seq conflict) — retry next tick`);
          } catch (e) { log(`observer: slot ${cand.record.requestId} failed (isolated): ${e instanceof Error ? e.message : e}`); }
        }
      }
    } catch (e) { log(`observer completion-slot scan failed: ${e instanceof Error ? e.message : e}`); }

    try { // --- board/PROGRESS watch (independent half) ---
      let snap: WatchSnapshot | null = null;
      try { snap = readWatchSnapshot(OBSERVER_SNAPSHOT_FILE); } catch (e) { log(`watch snapshot read failed — skip watch: ${e instanceof Error ? e.message : e}`); }
      if (snap !== null) {
        const curr = snapshotBoardProgress();
        if (curr === null) return; // a transient sampling error ⇒ hold the last snapshot, retry next tick (P2-3)
        let anyFailed = false;
        for (const ev of detectWatchEvents(snap, curr)) {
          // F44-⑥: board changes always notify; the PROGRESS-mtime ping is self-noise (the coordinator is now PROGRESS's main
          // writer, so its own edits echo back) — OFF by default, opt-in via SWARM_WATCH_PROGRESS. A skipped event still lets the
          // snapshot advance (it is intentionally consumed, not a delivery failure).
          if (!shouldEmitWatchNotice(ev.kind, process.env.SWARM_WATCH_PROGRESS)) continue;
          const res = notifyCoordinator(
            ev.kind === "board" ? `board: ${ev.item} → ${ev.state}${ev.who ? ` by ${ev.who}` : ""} (durable change — reconcile)` : `PROGRESS.md changed (mtime ${ev.mtimeMs})`,
            ev.kind === "board" ? { taskRef: ev.item, title: "board change" } : { taskRef: "PROGRESS", title: "progress change" },
          );
          if (res === "failed") anyFailed = true;
        }
        // advance only if no event failed to deliver (unroutable log-only is fine); a transient delivery failure holds the
        // snapshot so the event re-fires next tick instead of being lost (review P2-2).
        if (anyFailed) { log("observer: a watch event failed delivery — snapshot held, retry next tick"); return; }
        try { writeWatchSnapshot(OBSERVER_SNAPSHOT_FILE, curr); } catch (e) { log(`watch snapshot write failed: ${e instanceof Error ? e.message : e}`); }
      }
    } catch (e) { log(`observer board watch failed: ${e instanceof Error ? e.message : e}`); }
  };

  // Dead-letter watch (L2-struct 3b / F26): N dead-letters on the same ROUTE PAIR within a window ⇒ a ROUTING incident (via the
  // generic incident core, category="routing"). Recovery is NOT window-clear (review P1-1: absence of failures is "untested",
  // not recovered) — a routing incident recovers only when its repair-wait is RESOLVED (by a delivery-success signal, deferred),
  // synced closed by reconcileRegistryWithControl. The ledger is dormant until bus-identity v1.5 writes it. Fail-soft; per-group
  // isolated. Bounded per tick (review P2-3). Repair-wait commit is inline (mirrors the liveness applier; sealed path untouched).
  let deadLetterCursor = 0; // in-memory round-robin over the sorted group union
  let deadLetterNotifyCursor = 0; // in-memory round-robin over owed notifications (R3 per-tick notify budget)
  const isEmptyWatch = (w: DeadLetterWatch): boolean =>
    w.offset === 0 && w.sig === "" && w.carry === "" && !w.truncating && w.window.length === 0
    && Object.keys(w.handled).length === 0 && Object.keys(w.recovered).length === 0 && Object.keys(w.pending).length === 0
    && Object.keys(w.owed).length === 0;
  const runDeadLetterWatch = (): void => {
    // Load the durable watch + registry FIRST — both independent of the ledger (R2: the backstop over already-known CONTROL/
    // registry obligations must run even when the ledger is missing/unreadable). Corrupt ⇒ skip, never reset durable state (R1).
    let watch: DeadLetterWatch;
    try { watch = readDeadLetterWatch(DEAD_LETTER_WATCH_FILE); }
    catch (e) { log(`dead-letter watch read failed — skip: ${e instanceof Error ? e.message : e}`); return; }
    let reg: IncidentRegistry;
    try { reg = readIncidents(INCIDENTS_FILE); } catch (e) { log(`incidents read failed — skip dead-letter watch: ${e instanceof Error ? e.message : e}`); return; }
    const wasEmpty = isEmptyWatch(watch);
    const nowMs = Date.now();
    const windowStartMs = nowMs - DEAD_LETTER_WINDOW_MS;

    // R3/R1 INCREMENTAL, BOUNDED ingest from a persistent BYTE cursor (not a full-file slurp): read at most MAX_READ_BYTES this
    // tick; rotation/truncation by file identity (inode shrink/change) resets the cursor. ENOENT or any read error does NOT
    // return — the R2 backstop below still runs for already-known obligations.
    try {
      const fd = openSync(DEAD_LETTERS_FILE, "r");
      try {
        const stt = fstatSync(fd);
        const sig = String(stt.ino);
        if ((watch.sig !== "" && watch.sig !== sig) || stt.size < watch.offset) { watch.offset = 0; watch.carry = ""; watch.truncating = false; } // rotated/truncated — a new input stream, so drop the prior stream's skip-state too, else the new file's first record is eaten as an old over-long line's tail (R3-a)
        watch.sig = sig;
        const toRead = Math.min(MAX_READ_BYTES, Math.max(0, stt.size - watch.offset));
        if (toRead > 0) {
          const b = Buffer.alloc(toRead);
          const n = readSync(fd, b, 0, toRead, watch.offset);
          watch.offset += n;
          const ing = ingestLedgerChunk(watch.carry, b.subarray(0, n), MAX_CARRY_BYTES, watch.truncating);
          watch.carry = ing.carry;
          watch.truncating = ing.truncating;
          for (const dl of ing.events) {
            // R1: one malformed record must NEVER skip the healthy records after it. routeKeyOf is already null-safe; this
            // per-record guard also contains any future per-record throw, so the rest of this batch (already past the cursor)
            // is never lost to a single bad line.
            try { const rk = routeKeyOf(dl); if (rk !== null && dl.ts >= windowStartMs) watch.window.push({ ts: dl.ts, route: rk }); }
            catch (e) { log(`dead-letter record skipped (isolated): ${e instanceof Error ? e.message : e}`); }
          }
        }
      } finally { closeSync(fd); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`dead-letters read failed: ${e instanceof Error ? e.message : e}`);
    }

    // Prune the detection window, then CONSOLIDATE at INGESTION — for EVERY route, not just those without pending, and not
    // deferred to the budget-limited group loop (review 2548808-D1). When a route's FRESH (post-handled/recovery) in-window
    // failures reach threshold, record them as the durable pending candidate, REPLACING with the current window SNAPSHOT (never
    // accumulating) ⇒ a route already pending gets its NEW burst folded in here, and the same failure is never double-counted.
    // A threshold-reaching set is a discovered obligation: it is STICKY — when the window later ages below threshold before the
    // group loop reaches the route, population does NOT shrink or drop it (review 7e9a08b-R5-C survival); only the group loop
    // removes it (on commit, or when the recovery boundary leaves it sub-threshold). So a new burst becomes aging-exempt the
    // moment it is observed, independent of when its group's turn comes under MAX_ROUTING_GROUPS_PER_TICK.
    watch.window = pruneDeadLetterWindow(watch.window, windowStartMs);
    watch.pending = consolidatePending(watch.pending, watch.window, windowStartMs, watch.handled, watch.recovered, DEAD_LETTER_THRESHOLD);

    // UNION of KNOWN obligations (registry routing episodes + CONTROL routing repair-waits — ledger-independent, R2) + the
    // durable pending candidates: a committed-but-registry-lost incident still reconciles even with the ledger window gone.
    const st0 = loadControlLog(CONTROL_LOG_DIR);
    const groups = new Set<string>();
    for (const ep of Object.values(reg.episodes)) if (ep.category === "routing") groups.add(ep.groupKey);
    for (const b of Object.values(liveEntities(st0))) if (b.put === "wait") { const gk = repairGroupKeyOf((b as Extract<ChangeBody, { put: "wait" }>).wait.waitId); if (gk !== null && gk.startsWith("routing:")) groups.add(gk); }
    for (const route of Object.keys(watch.pending)) groups.add(routingGroupKey(route));
    const all = [...groups].sort();

    if (all.length > 0) {
      // Bounded round-robin slice; a group not reached this tick keeps its registry/CONTROL/pending state and returns next tick.
      const batchCount = Math.min(MAX_ROUTING_GROUPS_PER_TICK, all.length);
      deadLetterCursor %= all.length;
      for (let i = 0; i < batchCount; i++) {
        const groupKey = all[(deadLetterCursor + i) % all.length]!;
        try {
          const fresh = loadControlLog(CONTROL_LOG_DIR);
          const groupWaits = Object.values(liveEntities(fresh))
            .filter((b) => b.put === "wait" && repairEpisodeOf((b as Extract<ChangeBody, { put: "wait" }>).wait.waitId, groupKey) !== null)
            .map((b) => (b as Extract<ChangeBody, { put: "wait" }>).wait);
          const groupCtlWaits = groupWaits.map((w) => ({ waitId: w.waitId, state: w.state }));
          // recovery closed loop: adopt a committed wait the registry lost / sync-close one whose repair-wait resolved.
          const sync = reconcileRegistryWithControl(reg, groupKey, "routing", groupCtlWaits, nowSec());
          if (sync.registry !== reg) { writeIncidents(INCIDENTS_FILE, sync.registry); reg = sync.registry; }
          const route = routeKeyOfGroup(groupKey);
          // R5-D (review 7e9a08b): derive the recovery boundary from CONTROL's DURABLE occurredAtSec on the group's RESOLVED
          // repair-wait(s), EVERY tick — not only when THIS tick witnessed open->closed. A watch write-loss + restart leaves the
          // episode already closed, but the occurrence remains a committed CONTROL fact that must still bound late pre-recovery
          // failures. The boundary is the TRUE occurrence (f32a0507's 459af09), *1000 to the window's ms unit, mirroring
          // task-wait.failureReopensIncident. A bare/legacy close with no finite occurredAtSec sets NO boundary ⇒ post-recovery
          // failures reopen (fail-toward-noticing; a missing/NaN occurrence never swallows a real failure).
          if (route !== null) {
            let occMs = 0;
            for (const w of groupWaits) { const o = w.state === "resolved" ? w.resolution?.occurredAtSec : undefined; if (o !== undefined && Number.isFinite(o)) occMs = Math.max(occMs, o * 1000); }
            if (occMs > 0) watch.recovered[route] = Math.max(watch.recovered[route] ?? 0, occMs);
          }
          if (route !== null && watch.pending[route] !== undefined) { // a DURABLE candidate awaiting commit
            // R5-A/R5-C (review 7e9a08b): filter the candidate by the RECOVERY BOUNDARY only — never by window aging. Pre-recovery
            // timestamps (<= the boundary just rebuilt above) drop; if the remaining post-recovery failures fall below threshold the
            // burst was pre-recovery ⇒ discharge, no reopen. Absent a recovery boundary the full candidate stands: a discovered
            // obligation does not age out just because its samples left the sliding window (the R5-C regression this replaces).
            const boundary = watch.recovered[route];
            const live = boundary === undefined ? watch.pending[route] : watch.pending[route].filter((ts) => ts > boundary);
            if (live.length < DEAD_LETTER_THRESHOLD) { delete watch.pending[route]; continue; } // pre-recovery/handled ⇒ discharge; population re-consolidates any fresh post-recovery burst from the window
            watch.pending[route] = live;
            const rec = reconcileIncidentCore(reg, routingActiveSignal(route, live.length, fresh.seq), nowSec(), { repairWindowSec: REPAIR_WAIT_SEC, owner: REPAIR_OWNER_ROUTABLE ? REPAIR_OWNER : SELF, controlEpisodeFloor: sync.controlEpisodeFloor });
            let settled = false;
            if (rec.openRepairWait !== undefined) { // NEW episode ⇒ commit/adopt the repair-wait (the notify obligation is derived below from the committed episode — R4)
              const spec = rec.openRepairWait;
              const existing = findWaitIn(fresh, spec.waitId);
              if (existing !== undefined && existing.state !== "resolved") settled = true;               // adopt a live committed wait (P1-3)
              else if (existing !== undefined) { log(`routing repair-wait ${spec.waitId} exists RESOLVED — not resurrecting; defer`); continue; }
              else settled = commitTask(fresh, [{ put: "wait", wait: { waitId: spec.waitId, kind: "wait", subject: { jobId: spec.jobId }, state: "open", deadlineSec: spec.deadlineSec, owner: spec.owner, timeoutPolicy: "escalate" } }]).result.ok;
              if (!settled) { log(`routing repair-wait ${spec.waitId} deferred (seq conflict) — retry next tick`); continue; } // keep the pending candidate
              writeIncidents(INCIDENTS_FILE, rec.registry); reg = rec.registry;
            } else { if (JSON.stringify(rec.registry) !== JSON.stringify(reg)) { writeIncidents(INCIDENTS_FILE, rec.registry); reg = rec.registry; } settled = true; } // already open ⇒ dedup bump
            if (settled) {
              watch.handled[route] = Math.max(watch.handled[route] ?? 0, ...live); // R5 watermark: cover the committed candidate's own failures so they can't reopen
              delete watch.pending[route]; // durable candidate discharged (re-recorded next tick only if a FRESH burst recurs)
            }
          }
        } catch (e) { log(`routing group ${groupKey} failed (isolated): ${e instanceof Error ? e.message : e}`); }
      }
      deadLetterCursor = (deadLetterCursor + batchCount) % all.length;
    }

    // R4 (review 7e9a08b): reconstruct the owed set from the GENERATION-PRESERVING authoritative store — CONTROL repair-waits —
    // not the latest-generation registry. reg.episodes keeps only ONE generation per groupKey, so a watch write-loss followed by a
    // recurrence (which overwrites the old episode) would lose the prior generation's unfulfilled notice. Every routing repair-wait
    // in CONTROL maps to an incidentId and owes a notice UNLESS watch.owed records it DELIVERED (notifiedAtSec); the registry
    // supplies why/open for whichever generation is current, else it is reconstructed from the wait. A lost watch then only
    // re-notifies (at-least-once) — no generation's obligation is ever lost, because CONTROL retains them all. Reload AFTER the
    // group loop so a just-opened repair-wait is included. ponytail: watch.owed keeps one tiny delivered-marker per lifetime
    // routing episode (rare); TTL-tombstone them only if that set ever grows enough to matter.
    for (const b of Object.values(liveEntities(loadControlLog(CONTROL_LOG_DIR)))) {
      if (b.put !== "wait") continue;
      const w = (b as Extract<ChangeBody, { put: "wait" }>).wait;
      const gk = repairGroupKeyOf(w.waitId);
      if (gk === null || !gk.startsWith("routing:")) continue;
      const epNum = repairEpisodeOf(w.waitId, gk);
      if (epNum === null) continue;
      const incidentId = `${gk}:episode-${epNum}`;
      const cur = watch.owed[incidentId];
      if (cur?.notifiedAtSec !== undefined) continue; // already delivered — never re-mirror or re-send
      const regEp = reg.episodes[gk];
      const current = regEp?.incidentId === incidentId;
      watch.owed[incidentId] = { why: current ? regEp!.why : (cur?.why ?? `routing incident ${incidentId}`), open: current ? regEp!.open : (w.state !== "resolved"), repairWaitId: w.waitId };
    }
    const owed = Object.entries(watch.owed).filter(([, n]) => n.notifiedAtSec === undefined);
    if (owed.length > 0) {
      const notifyCount = Math.min(MAX_NOTIFY_PER_TICK, owed.length);
      deadLetterNotifyCursor %= owed.length;
      for (let i = 0; i < notifyCount; i++) {
        const [incidentId, n] = owed[(deadLetterNotifyCursor + i) % owed.length]!;
        const text = `routing incident ${incidentId}: ${n.why}${n.open ? "" : " (recovered)"}`;
        if (notifyCoordinator(text, { taskRef: n.repairWaitId || incidentId, title: "routing incident" }) !== "failed")
          watch.owed[incidentId] = { ...n, notifiedAtSec: nowSec() }; // durable delivered marker (persisted with the watch below)
        else log(`routing notify for ${incidentId} failed (transient) — retry next tick`);
      }
      deadLetterNotifyCursor = (deadLetterNotifyCursor + notifyCount) % owed.length;
    }
    // (No prune: a DELIVERED marker must persist as long as its repair-wait exists in CONTROL, else the R4 reconstruct above would
    //  re-derive that generation as owed and re-notify it. Growth is one small marker per lifetime routing episode — see ceiling note.)

    // Persist the watch LAST (after commits + notifies): a crash before this re-reads the same cursor/window/pending next run,
    // never skipping durable work (R1). Stay fully dormant (write no file) only when there is genuinely nothing to track (R2).
    if (!(wasEmpty && isEmptyWatch(watch))) { try { writeDeadLetterWatch(DEAD_LETTER_WATCH_FILE, watch); } catch (e) { log(`dead-letter watch write failed: ${e instanceof Error ? e.message : e}`); } }
  };

  // §2c-b evidence renewal (two-clocks). BEFORE the sweep escalates an EXPIRED liveness wait, renew it IF the subject made
  // progress since it was armed — the owner is alive, so push the PROBE deadline out instead of convicting. Only renewable
  // (liveness/reminder) waits qualify (isRenewable — f32a0507's single predicate; also guarded inside advanceWait so a
  // misclassification here can't illegally renew a semantic-deadline wait). Evidence is derived LIVE from the control-log (no
  // cached counter to drift — F13). Finite FREE renewals (MAX_FREE_RENEWALS) so a forever-progressing job can't re-arm without
  // bound (§2c-b acceptance ③: "不许无限 re-arm"); past the cap, or with no fresh evidence, the wait stays expired and the
  // sweep escalates it as before. Fail-soft + per-wait isolated. Runs just before sweepPass so a renewed wait is no longer
  // expired by the time the sweep evaluates it.
  const renewLivenessWaits = (): void => {
    const now = nowSec();
    let st = loadControlLog(CONTROL_LOG_DIR);
    const batches = readControlBatches(CONTROL_LOG_DIR);
    for (const b of Object.values(liveEntities(st))) {
      if (b.put !== "wait") continue;
      const w = (b as Extract<ChangeBody, { put: "wait" }>).wait;
      if (w.state !== "open" || !isRenewable(w) || w.deadlineSec > now) continue;    // only an EXPIRED open renewable wait (the probe moment)
      if (renewalCount(batches, w.waitId) >= MAX_FREE_RENEWALS) continue;            // §2c-b ③: finite free renewals ⇒ let the sweep escalate
      // §2c-b evidence is anchored to the wait's FULL subject, most-specific field first: a binding-anchored wait renews only
      // on THAT binding's progress (a sibling binding of the same attempt must not, and a bindingId-only subject must not
      // degrade to job scope — review 4c617fa-E1); an attempt-anchored one only on that attempt's (review ab1bf81-P1#1).
      const progressSubject = { jobId: w.subject.jobId, attemptId: w.subject.attemptId, bindingId: w.subject.bindingId };
      if (!hasFreshSubjectEvidence(batches, progressSubject, w.waitId)) continue;    // no subject progress since the arm ⇒ let the sweep escalate
      const adv = advanceWait(w, { type: "renew", newDeadlineSec: now + RENEW_WINDOW_SEC, nowSec: now });
      if (!adv.ok) { log(`renew ${w.waitId} rejected by reducer: ${adv.error}`); continue; } // the reducer guard is the authority
      const progressSeq = subjectProgressSeq(batches, progressSubject);             // idempotent id by the triggering progress (countable, §2c-b ③)
      const rev = st.revisions[`wait:${w.waitId}`] ?? 0;
      try {
        const res = commitChanges(st, [{ put: "wait", wait: adv.wait, operationId: renewOperationId(w.waitId, progressSeq), expectedEntityRevision: rev }]);
        if (res.result.ok) { st = res.state; log(`renewed liveness wait ${w.waitId} (subject ${w.subject.jobId} progressed @${progressSeq}) +${RENEW_WINDOW_SEC}s`); }
        else log(`renew ${w.waitId} deferred (${JSON.stringify(res.result)}) — retry next tick`);
      } catch (e) { log(`renew ${w.waitId} failed (isolated): ${e instanceof Error ? e.message : e}`); }
    }
  };

  // F40 unclaimed-mail sentinel (silent-stall detection). Scan durable inbox dirs (incl. dead-pid orphan claims, F40-3); a box
  // with stranded mail past INBOX_STALL_SEC AND no live session draining it is escalated to the coordinator. The ownership set
  // MIRRORS core's inboxKeys(): each live presence session's own key + its legacy prior-run keys. Fail-soft + isolated.
  // Per-box dedup (inboxStallAlertedAt) keyed by the STABLE box id — NOT the message text — so a self-induced backlog count
  // does NOT bypass dedup (F40-5): at most one alert per box per SWARM_NOTIFY_DEDUP_MS, then a bounded reminder. The coordinator
  // box is NOT excluded (that would hide real business mail stranded in it); it just gets the same bounded treatment.
  const inboxDedup = new AlertDedup(NOTIFY_DEDUP_MS); // F44-①: per-box event-identity dedup + cooldown (stable box id, NOT message text)
  const runInboxSentinel = (): void => {
    try {
      const stats = scanInboxes(HOME);
      if (stats.length === 0) return;
      const idlog = readIdentityLog(HOME);
      const proj = buildProjection(idlog.events, idlog.corruption);
      const io = makeFileLiveness(HOME);
      const owned = new Set<string>();
      for (const sid of listSessions(HOME)) {
        const pid = io.readPid(sid);
        if (pid === null || io.procAlive(pid) !== "alive") continue; // only a LIVE presence session owns (drains) a box
        owned.add(inboxDirName(sid));
        // Mirror core's inboxKeys() legacy set, using the session's REAL tool/cwd. F40-4: only a whois SINGLE entity gives a
        // trustworthy tool/cwd; for candidates/pid/not-seen we must NOT fall back to empty (wildcard) metadata — that would
        // over-credit ownership and SUPPRESS a real stall core would actually refuse to drain. When unprovable, credit ONLY
        // the direct sid (under-credit ⇒ a safe false alert the coordinator checks, never a silently-suppressed stall).
        const w = whois(proj, sid);
        if (w.kind !== "entity") continue; // ambiguous/unknown identity ⇒ no legacy expansion (direct sid already credited)
        for (const k of legacyInboxKeys(proj, { id: sid, stableId: sid, title: "", tool: w.entity.tool ?? "", cwd: w.entity.cwd ?? "", pid: 0 })) owned.add(inboxDirName(k));
      }
      const thMin = Math.floor(INBOX_STALL_SEC / 60);
      for (const a of detectStalledInboxes(stats, (key) => owned.has(key), INBOX_STALL_SEC, nowSec())) {
        const dk = alertKey(a.key, "inbox-stall");
        if (!inboxDedup.shouldFire(dk)) continue; // already alerted this box this window
        // F44-P2-1: notify FIRST, consume the cooldown slot ONLY on a non-failed delivery (mirror live-sentinel's
        // record-on-success). A FAILED write must NOT start the cooldown, else an undelivered stall is silenced until it lapses.
        const res = notifyCoordinator(
          `[inbox-sentinel] STALL: inbox ${a.key} has ${a.unclaimedCount} unclaimed message(s) older than ${thMin}min and NO live session is draining it`,
          { taskRef: `inbox-stall:${a.key}`, title: "inbox stall" },
        );
        if (res !== "failed") inboxDedup.record(dk);
      }
    } catch (e) { log(`inbox sentinel failed (isolated): ${e instanceof Error ? e.message : e}`); }
  };

  // S14 live sentinel (v2 — herdr-primitive-driven, user "用到极致"): per herdr-IDENTIFIED member run an event-driven watcher
  // (superviseMember) on herdr's BLOCKING primitives — `agent wait --until` (①), `pane wait-output` (②), `agent explain` (④)
  // — INSTEAD of tick-polling. A bus-presence-only member (herdr can't wait on it) falls back to a per-tick self-reported-
  // status check (blocked / idle), no screen ("识别到才监控,未识别回落总线 presence"). Decisions trust only the VERIFIED
  // agent-list state / status file, never an unparsed herdr wait receipt. Gated on SWARM_SENTINEL + herdr reachability.
  // Escalation: blocked ⇒ S19 approval (buildApprovalDoc with explain + screen); fake-death / idle-timeout ⇒ a coordinator
  // notice. Per member+kind dedup (NOTIFY_DEDUP_MS). Fail-soft. NOTE: the herdr-name↔bus-sid mapping is the still-open
  // "identification" work (1/7 lit) — until it lands, a member that is BOTH herdr-identified AND self-reports idle could
  // double-notify (benign: one notice per id, no wrong action); blocked does not double (a stuck member cannot self-report).
  const REAL_AGENT_STATES: AgentState[] = ["idle", "working", "blocked", "done"]; // waitable states (no "unknown")
  const sentinelWatchers = new Map<string, AbortController>(); // herdr member -> its running watcher's abort handle
  const sentinelDedup = new AlertDedup(NOTIFY_DEDUP_MS); // F44-①: per member+kind event-identity dedup + cooldown (fake-death / idle-timeout / blocked)
  // F44-P2-3: ghost-daemon is ONE-TIME per episode, NOT a cooldown re-fire. ghostFired holds members already alerted; it is
  // reconciled each tick against the current ghost set (a member no longer a ghost is forgotten, so a later re-ghost re-fires).
  // This is the inline mirror of the pure `GhostOnce` helper in sentinel-denoise.ts (the live-sentinel test harness injects a
  // FIXED dep set with no GhostOnce, so the dispatcher cannot import it — the helper is unit-tested there, the logic lives here).
  const ghostFired = new Set<string>();
  const blockedOnceFired = new Set<string>(); // F44-⑧: non-roster blocked → at-most-once per episode (same reconcile as ghostFired)
  const escalationsInFlight = new Set<string>(); // F44-8A: member+kind claimed BEFORE the first await, so concurrent ticks form ONE delivery obligation
  const sentinelPending = new Map<string, { text: string; taskRef: string; title: string }>(); // LS4: failed deliveries ⇒ retried each tick
  const sentinelCfg = { fakeDeathSec: SENTINEL_FAKEDEATH_SEC, idleTimeoutSec: SENTINEL_IDLE_SEC, reArmSec: SENTINEL_IDLE_SEC, doneWakeSec: SENTINEL_IDLE_SEC, sampleSec: SENTINEL_SAMPLE_SEC, backoffSec: SENTINEL_SAMPLE_SEC };
  // LS4: deliver with a durable pending-retry. A FAILED notifyCoordinator does NOT consume the dedup slot AND the rendered
  // message is parked in sentinelPending, which runLiveSentinel drains every tick — so recovery is automatic and does NOT
  // depend on the watcher re-emitting (it is inside an 1800s state-wait). Success records dedup + clears pending.
  const sentinelDeliver = (dk: string, msg: { text: string; taskRef: string; title: string }): void => {
    const result = notifyCoordinator(msg.text, { taskRef: msg.taskRef, title: msg.title });
    if (result === "failed") { sentinelPending.set(dk, msg); return; } // keep the obligation for the next tick
    sentinelDedup.record(dk);
    sentinelPending.delete(dk);
  };
  const sentinelRetryPending = (): void => { for (const [dk, msg] of sentinelPending) sentinelDeliver(dk, msg); }; // LS4: auto-retry each tick
  const sentinelEscalate = async (ev: SentinelEvent): Promise<void> => {
    const dk = alertKey(ev.member, ev.kind);
    if (!sentinelDedup.shouldFire(dk)) return; // already surfaced this member+kind this window (F44-①)
    if (sentinelPending.has(dk)) return; // already queued for retry (LS4) — don't rebuild/double-send
    // F44-8A: claim the member+kind BEFORE the first await (the async screen read below). Without this, N concurrent ticks
    // for the same persistent block all pass the dedup/pending checks (neither is set until DELIVERY) and each writes a
    // message — text dedup can't stop it. The in-flight claim collapses them to ONE obligation; on release the next call is
    // gated by the cooldown (success) or sentinelPending (failure), so a failed delivery still retries.
    if (escalationsInFlight.has(dk)) return;
    escalationsInFlight.add(dk);
    try {
      let msg: { text: string; taskRef: string; title: string };
      if (ev.kind === "blocked") {
        // F44-⑦: a nameless / presence-only member (every claude agent is nameless in `agent list`) can't be read by
        // sid-as-herdr-name (agent_not_found). Map the sid → its pane via `agent list` and read by pane_id (herdr accepts a
        // pane_id as the agent target, verified: `agent explain w1:p1`); fall back to the member handle for a named agent.
        const paneId = await herdrPaneIdForSession(ev.member).catch(() => null);
        const screen = await herdrReadClean(paneId ?? ev.member).catch(() => "");
        if (sentinelDecision(screen).action !== "escalate") return;     // R12: always escalate; a future auto-clear would branch here
        // F44-⑩ (P1-1 fix): a content-filter anchor on screen is only a HINT — a whole-screen text match can be scrollback, a
        // quote, or displayed code, and a genuine approval may be live alongside it. It NEVER cancels the S19 approval; it only
        // ANNOTATES it (neutral note, N1). Always build the approval doc; append the hint note when detected.
        const cfHint = screenIndicatesContentFilter(screen) ? contentFilterHintNote() : "";
        // D-multica ①: bucket the screen+explain into a failure class and ANNOTATE the alert text only — disposition is unchanged
        // (the S19 approval below is always built the same way). "unknown" ⇒ "" (no note), the safe direction.
        const failHint = failureHintNote(classifyFailure(`${ev.explain ?? ""}\n${screen}`));
        const summary = [ev.explain ? `定性:${ev.explain}` : "", cfHint, failHint, screen ? `读屏:\n${screen}` : ""].filter(Boolean).join("\n\n") || "(screen/explain unavailable)";
        const doc = buildApprovalDoc({
          from: SELF, fromLabel: "swarm-sentinel", nowSec: nowSec(), member: ev.member, screenSummary: summary,
          options: [{ label: "读屏后裁决", consequence: "批准/拒绝由授权方按实际界面回注(blocked 态不可用 prompt,须按 UI 选择 send-keys 等);或中止/另派" }], // N1: prompt is rejected for a blocked agent
        });
        msg = { text: doc.body.text, taskRef: `approval:${ev.member}`, title: doc.body.title };
      } else {
        // F44-P2-3: ghost-daemon is NOT routed here — it has a one-time gate (ghostFired), not this cooldown dedup. This branch is
        // fake-death / idle-timeout only (both carry idleSec/silentSec); the type still admits ghost-daemon but it is never emitted.
        const detail = ev.kind === "fake-death" ? `status working but no terminal output for >= ${ev.silentSec}s` : `idle with no check-in for >= ${ev.idleSec}s`;
        msg = { text: `[live-sentinel] ${ev.kind}: 成员 ${ev.member} — ${detail}`, taskRef: `sentinel:${ev.kind}:${ev.member}`, title: `member ${ev.kind}` };
      }
      sentinelDeliver(dk, msg);
    } finally {
      escalationsInFlight.delete(dk); // release; cooldown (success) or sentinelPending (failure) now gates subsequent calls
    }
  };
  const startWatcher = (name: string): void => {
    const ac = new AbortController();
    sentinelWatchers.set(name, ac);
    const signal = ac.signal;
    const ops: WatchOps = {
      state: () => herdrAgentState(name, signal),
      paneId: () => herdrAgentPaneId(name, signal).catch(() => null),                       // fresh each cycle (LS2b)
      contentHash: async (_pane) => { const c = await herdrReadContent(name, 40, signal).catch(() => null); return c === null ? null : createHash("sha256").update(c).digest("hex"); }, // LS2: null on read failure (not evidence)
      waitOutput: (pane, timeoutSec) => herdrWaitOutput(pane, { regex: "[^\\s]", timeoutMs: timeoutSec * 1000 }, signal),  // bounded block (positional, LS1)
      waitLeave: (from, timeoutSec) => herdrWait(name, REAL_AGENT_STATES.filter((s) => s !== from), timeoutSec * 1000, signal), // LS3 outcome
      explain: () => herdrExplain(name, signal).catch(() => ""),
      emit: (ev) => { void sentinelEscalate(ev); },
      now: () => nowSec(),
      sleep: (sec) => new Promise((res) => setTimeout(res, sec * 1000)),
      stopped: () => signal.aborted || !SENTINEL_ENABLED,
    };
    void superviseMember(name, ops, sentinelCfg)
      .catch((e) => log(`live sentinel watcher ${name} ended: ${e instanceof Error ? e.message : e}`))
      .finally(() => { if (sentinelWatchers.get(name) === ac) sentinelWatchers.delete(name); });
  };
  const runLiveSentinel = async (): Promise<void> => {
    const abortAll = (): void => { for (const ac of sentinelWatchers.values()) ac.abort(); sentinelWatchers.clear(); };
    if (!SENTINEL_ENABLED) { abortAll(); sentinelPending.clear(); return; }
    try {
      sentinelRetryPending(); // LS4/R23-A: retry parked deliveries EVERY tick, BEFORE the herdr gate — recovery must not depend on observation-source reachability
      if (!(await herdrServerReachable())) { abortAll(); return; } // herdr workbench absent ⇒ stop watchers (avoid error-spin), restart on recovery
      const identified = new Set((await herdrAgentStates()).map((s) => s.name));
      for (const name of identified) if (!sentinelWatchers.has(name)) startWatcher(name);                 // new identified member ⇒ watch it
      for (const [name, ac] of sentinelWatchers) if (!identified.has(name)) { ac.abort(); sentinelWatchers.delete(name); } // gone ⇒ stop its watcher
      // Fallback: bus-presence-only members (not herdr-identified) ⇒ per-tick self-reported-status check (no screen).
      // F44-③④: roster + in-flight aware. A member is "on the roster" if the swarm resolves its identity OR it owns live work;
      // a stray presence that is neither, sitting idle, is a ghost daemon (③, one-time). A roster member idle with NO in-flight
      // work is HEALTHY (④, no alert); only an in-flight owner gone idle is a disconnect candidate. `blocked` is a real
      // self-report and still escalates regardless of roster.
      const now = nowSec();
      const sids = listSessions(HOME);
      const idlog2 = readIdentityLog(HOME);
      const proj2 = buildProjection(idlog2.events, idlog2.corruption);
      // F44-P2-2: in-flight = owns a NON-TERMINAL wait whose owner resolves to a UNIQUE session. (A) a "resolved" wait is done
      // (not in-flight; liveEntities already drops tombstones but keeps resolved waits). (B) the wait owner is a handle/short-id,
      // resolved to a canonical sid via resolveSession; an unassigned/ambiguous owner is credited to NO member (never guess, F16).
      const activeOwners = new Set<string>();
      for (const b of Object.values(liveEntities(loadControlLog(CONTROL_LOG_DIR)))) {
        if (b.put !== "wait") continue;
        const w = (b as Extract<ChangeBody, { put: "wait" }>).wait;
        if (w.state === "resolved") continue; // terminal WaitState ⇒ not in-flight
        const owner = resolveSession(w.owner ?? "", sids); // handle/short-id ⇒ unique sid, else null (unassigned/ambiguous)
        if (owner) activeOwners.add(owner);
      }
      // F44-⑨: the roster-snapshot (resume.ts ROSTER_FILE) is an authoritative member source too — include it so a captured
      // member (e.g. the swarm-viz front end 3e097dfe) with no in-flight wait and no identity-log entity is NOT mislabeled a
      // ghost. Fail-soft: no/garbled snapshot ⇒ no extra members.
      const snapshotMembers = new Set<string>();
      try {
        const snap = JSON.parse(readFileSync(path.join(HOME, ".agenthop", "swarm", "roster-snapshot.json"), "utf8"));
        // F44-9: a snapshot member may be a full sid OR a short handle (assembleRoster emits e.g. "Work-3e097dfe" when the
        // stableId is absent). Resolve each to its current full presence sid (unique-identity rule) — a raw handle never
        // matches a presence sid, which is exactly what mislabeled 3e097dfe a ghost. Ambiguous/unknown ⇒ dropped (no guess).
        for (const s of resolveSnapshotMembers(snap?.members ?? [], (h) => resolveSession(h, sids))) snapshotMembers.add(s);
      } catch { /* no snapshot ⇒ no extra members */ }
      const currentGhosts: { sid: string; idleSec: number }[] = [];
      const sawNonBlocked = new Set<string>(); // F44-8B: sids OBSERVED this tick in a readable NON-blocked state (confirmed left blocked)
      for (const sid of sids) {
        if (identified.has(sid)) continue; // best-effort exclusion (exact name match) — see the herdr-name↔sid mapping note above
        const st = readStatusFile(HOME, sid);
        if (!st) continue;
        const onRoster = isOnRoster(sid, { activeOwners, identityEntity: whois(proj2, sid).kind === "entity", snapshotMembers }); // F44-⑨
        if (st.state === "blocked") {
          // F44-⑧: a ROSTER member's block is swarm work ⇒ escalate (windowed). A NON-roster presence (e.g. the user's private
          // session) is not ⇒ escalate at most ONCE per episode (it might be a member whose identity has not resolved yet).
          if (classifyBlockedEscalation(onRoster) === "escalate") void sentinelEscalate({ kind: "blocked", member: sid, explain: "(presence-only roster member; no herdr screen/explain)" });
          else if (!blockedOnceFired.has(sid)) { blockedOnceFired.add(sid); void sentinelEscalate({ kind: "blocked", member: sid, explain: "(non-roster presence; surfaced once)" }); }
          continue;
        }
        if (st.state === "working" || st.state === "idle") sawNonBlocked.add(sid); // F44-8B: ONLY a DEFINITE working/idle proves left blocked; "unknown" (= not reported) / missing / unreadable keep the once-mark
        if (st.state !== "idle" || !Number.isFinite(st.seq)) continue;
        const idleSec = Math.max(0, now - Math.floor(st.seq / 1000));
        const health = classifyMemberHealth({ onRoster, hasInFlight: activeOwners.has(sid), idleSec, presenceSeen: true }, { idleTimeoutSec: SENTINEL_IDLE_SEC });
        if (health === "disconnect-candidate") void sentinelEscalate({ kind: "idle-timeout", member: sid, idleSec });
        else if (health === "ghost-daemon") currentGhosts.push({ sid, idleSec });
      }
      // F44-⑧/8B reconcile: forget a one-time non-roster blocked alert ONLY on a CONFIRMED non-blocked observation (sawNonBlocked)
      // — NOT on a missing/unreadable sample (which does not prove the block ended; clearing on absence let the same block re-escalate
      // after the status file blipped away and returned). A later genuine recovery → re-block then re-fires.
      for (const m of [...blockedOnceFired]) if (sawNonBlocked.has(m)) blockedOnceFired.delete(m);
      // F44-P2-3: fire each ghost ONCE per episode. Reconcile first — forget any member no longer observed as a ghost — so a
      // member that recovers and later re-ghosts fires again. The slot is taken only on a non-failed delivery, so an undelivered
      // ghost alert retries next tick (the member is still a ghost). This bypasses sentinelDedup (which would re-remind on cooldown).
      const ghostSet = new Set(currentGhosts.map((g) => g.sid));
      for (const m of [...ghostFired]) if (!ghostSet.has(m)) ghostFired.delete(m);
      for (const g of currentGhosts) {
        if (ghostFired.has(g.sid)) continue; // already alerted this episode
        const res = notifyCoordinator(
          `[live-sentinel] ghost-daemon: 游离 presence ${g.sid} idle >= ${g.idleSec}s 且不在册(非 roster 成员)— 疑似残留守护进程,一次性告警`,
          { taskRef: `sentinel:ghost-daemon:${g.sid}`, title: "ghost daemon" },
        );
        if (res !== "failed") ghostFired.add(g.sid);
      }
    } catch (e) { log(`live sentinel failed (isolated): ${e instanceof Error ? e.message : e}`); }
  };

  // T5-5 review-seat autoscale — SUGGESTION MODE ONLY (user ruling: half-flip). Each sweep, if SWARM_REVIEW_AUTOSCALE is on,
  // read the durable review-queue ledger, filter phantom depth against presence, run the pure planner, and ADVISE the
  // coordinator (a durable-inbox suggestion); it NEVER spawns/reclaims a seat (that is the coordinator's call, R16 money gate).
  // Cross-tick state tracks how long the current want has held (sustain) + when a suggestion last fired (min-dwell throttle).
  // Fail-soft: the ledger scan + inbox write are isolated and never break the sweep.
  let autoscaleWant: "up" | "down" | "none" = "none";
  let autoscaleWantSinceSec = nowSec();
  let lastAutoscaleSuggestSec = 0;
  let autoscaleReadInFlight = false;
  const runReviewAutoscaleSuggest = (): void => {
    if (!autoscaleEnabled()) return; // SWARM_REVIEW_AUTOSCALE live by default (opt-out; kill with =0)
    if (autoscaleReadInFlight) return; // single-flight (AS-P2-4): never overlap reads, so a slow older read cannot resolve late and clobber a newer snapshot
    autoscaleReadInFlight = true;
    void (async () => {
      try {
        const records = await readReviewLedger(reviewQueueDir(HOME));
        if (records.length === 0) { autoscaleWant = "none"; autoscaleWantSinceSec = nowSec(); return; } // empty ledger ⇒ nothing to advise
        // Phantom-depth guard (AS-P2-1): resolve each author/seat to its canonical native sid AND confirm the process is
        // actually ALIVE (a pid file alone is not life — kill(0): ESRCH ⇒ dead). Aliases of one seat collapse to the one
        // canonical id (AS-P2-2), so capacity is never inflated by an alias; all ticket work is kept.
        const sessions = listSessions(HOME);
        const io = makeFileLiveness(HOME);
        const resolveLive = (id: string): string | null => {
          const sid = resolveSession(id, sessions);
          if (sid === null) return null;
          const pid = io.readPid(sid);
          return pid !== null && io.procAlive(pid) === "alive" ? sid : null;
        };
        const canon = canonicalizeLiveRecords(records, resolveLive);
        const seats = buildSeatStatesFromLedger(canon.records, canon.liveSeats, SCALE_CFG, nowSec());
        // Track the raw want's continuity across ticks (reset on flip), feeding the planner's sustain gate.
        const want = instantaneousWant(queueDepth(filterLiveRecords(canon.records, canon.liveAuthors, canon.liveSeats)), seats, SCALE_CFG);
        if (want !== autoscaleWant) { autoscaleWant = want; autoscaleWantSinceSec = nowSec(); }
        const sustainedSec = nowSec() - autoscaleWantSinceSec;
        const sinceLastActionSec = nowSec() - lastAutoscaleSuggestSec; // no seats move; min-dwell just throttles re-suggesting
        const sug = planAutoscaleSuggestion({ records: canon.records, liveAuthors: canon.liveAuthors, liveSeats: canon.liveSeats, seats, cfg: SCALE_CFG, sinceLastActionSec, sustainedSec });
        // Only a REAL delivery consumes the cooldown slot (AS-P2-3): a logged (coordinator unresolved) or deduped result is
        // NOT a successful report, so lastAutoscaleSuggestSec does not advance and the still-standing advice re-delivers once
        // the coordinator becomes reachable.
        if (sug && notifyCoordinator(sug.text, { taskRef: "autoscale-suggest", title: "autoscale" }) === "delivered") lastAutoscaleSuggestSec = nowSec();
      } finally {
        autoscaleReadInFlight = false;
      }
    })().catch((e) => log(`review-autoscale suggest failed (isolated): ${e instanceof Error ? e.message : e}`));
  };

  // T5-2 DEFERRED seam: gauge timed sampling. The dual-bandwidth pure core + store shipped (batch-4) but had NO trigger, so
  // gauge.json only refreshed on a manual run and the (installed) console gauge read a stale projection. Each sweep, if
  // SWARM_GAUGE_SAMPLING is on and the sample interval has elapsed (sweep ticks every 5s, far faster than the 60s default),
  // re-derive + atomically write the projection. The interval advances whether or not the write succeeds, so a persistent
  // write fault logs once per interval, not every tick. Fully fail-soft: a sampling failure NEVER breaks the sweep.
  let lastGaugeSampleSec = 0;
  const runGaugeSampling = (): void => {
    if (!gaugeSamplingEnabled()) return; // SWARM_GAUGE_SAMPLING live by default (opt-out; kill with =0)
    const now = nowSec();
    if (!shouldSampleGauge(now, lastGaugeSampleSec, GAUGE_SAMPLE_SEC)) return; // throttle to the sample interval
    lastGaugeSampleSec = now; // advance BEFORE the write ⇒ one attempt per interval even if it throws (no tight retry loop)
    try { writeBandwidthProjection(HOME, now); }
    catch (e) { log(`gauge sampling failed (isolated): ${e instanceof Error ? e.message : e}`); }
  };

  // placement wiring — SUGGESTION MODE ONLY (coordinator ruling, same discipline as review-seat autoscale). Each sweep, if
  // SWARM_PLACEMENT is on, read the declarative spec, run the pure chain (reconcile → selectBackends on the shortfall), and
  // ADVISE the coordinator (a durable S19 suggestion, taskRef=placement-suggest) — it NEVER spawns/reclaims and never spends
  // (real VM ops + budget are the user money gate, R16). Default OFF. Only a REAL delivery consumes the min-dwell slot (so a
  // logged/deduped/failed advisory re-delivers once the coordinator is reachable). Fully fail-soft: never breaks the sweep.
  let lastPlacementSuggestSec = 0;
  let placementReadInFlight = false;
  const runPlacementSuggest = (): void => {
    if (!placementEnabled()) return; // SWARM_PLACEMENT default OFF (dormant-ahead-of-use, like SWARM_VM_CTL)
    if (placementReadInFlight) return; // single-flight: never overlap reads
    placementReadInFlight = true;
    void (async () => {
      try {
        const spec = readPlacementSpec(HOME);
        if (!spec) return; // no declarative desired-state ⇒ nothing to advise
        const now = nowSec();
        // PW-1: the NOTICE dwell is the wiring's OWN throttle (separate from reconcile's action dwell). The plan below is always
        // the FULL desired plan; this gate just paces how often we tell the coordinator. Only a real "delivered" advances the
        // window, so a failed/unreported advisory retries next tick.
        if (!shouldSuggestPlacement(now, lastPlacementSuggestSec, spec.cfg.minDwellSec)) return;
        // ACTUAL state = the vm-ctl backend account (`vm-ssh ls --json`), read ASYNChronously so the exec never blocks the
        // dispatcher's main loop (PL-3); the await stays inside this single-flight detached worker. Three-state: unknown (read
        // unconfirmed) ⇒ advise NOTHING this tick and do NOT advance the window — never fabricate an empty fleet / live capacity.
        const fleet = await readLedgerMachines(HOME);
        if (fleet.status === "unknown") return;
        const machines = fleet.status === "ok" ? fleet.machines : []; // empty ⇒ genuinely no machines ⇒ advise the full demand
        const sug = planPlacementSuggest(spec, machines);
        if (sug.hasContent && notifyCoordinator(sug.text, { taskRef: "placement-suggest", title: "placement" }) === "delivered") lastPlacementSuggestSec = now;
      } finally { placementReadInFlight = false; }
    })().catch((e) => log(`placement suggest failed (isolated): ${e instanceof Error ? e.message : e}`));
  };

  // Morning digest (TG v1 CORE composeDigest had no trigger ⇒ never produced). At/after the local target hour, once per calendar
  // date, run TWO INDEPENDENT obligations (MD-P2-1): (1) write the morning-digest/v1 projection (console + TG read it — one
  // generation, multi-end delivery, the generator touches no entry); (2) push the same brief to the coordinator durable box (S11,
  // fyi). Each is tracked by its OWN durable date-marker (the projection file / notified.json), so a write/deliver failure retains
  // the obligation, a restart recovers it, and a CONFIRMED delivery is never repeated. Backoff so a persistent failure does not
  // retry every tick. Live by default (SWARM_DIGEST, opt-out); fully fail-soft — never breaks the sweep.
  let lastDigestAttemptSec = 0;
  const DIGEST_RETRY_SEC = 300; // on a failed obligation, retry at most every 5 min (not every 5s sweep tick)
  const runDigest = (): void => {
    if (!digestEnabled()) return; // SWARM_DIGEST live by default (opt-out; kill with =0)
    try {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // local date
      let proj = readDigestProjection(HOME);
      const notified = readNotifiedState(HOME);
      const act0 = digestActions(today, d.getHours(), DIGEST_HOUR, proj, notified);
      if (!act0.writeProjection && !act0.notify) return; // both already delivered today (or before the hour)
      if (nowSec() - lastDigestAttemptSec < DIGEST_RETRY_SEC) return; // backoff: never a tight per-tick retry on a persistent fault
      lastDigestAttemptSec = nowSec();
      // MD-R2-P2-1: today's frozen body (carried in the notify marker) is the ONE TRUTH. When the carrier is CORRUPT or MISSING but
      // that body is recoverable, RESTORE the SAME body — never re-gather a different one (the body was already published). A restore
      // that FAILS keeps the SAME recovery obligation: return + retry, never fall through to a fresh gather (which would publish a
      // second, different body). An UNKNOWN (unreadable) carrier is left untouched (it may still be the valid body — do not overwrite).
      const frozenToday = (notified.kind === "pending" || notified.kind === "sent") && notified.date === today && notified.body ? notified.body : null;
      if ((proj.kind === "corrupt" || proj.kind === "absent") && frozenToday) {
        if (!writeDigestProjectionRaw(HOME, frozenToday)) return; // restore failed ⇒ retain the obligation, retry; never re-gather a new body
        proj = readDigestProjection(HOME);
      }
      const act = digestActions(today, d.getHours(), DIGEST_HOUR, proj, notified);
      // (1) Projection obligation: reached ONLY when there is NO recoverable frozen body (a genuinely never-generated event) ⇒ gather
      //     the night's sources ONCE and write the FROZEN body for today (a later retry/restore never re-gathers a different body).
      if (act.writeProjection) {
        const sources = gatherDigestSources(HOME);
        if (sources === null) return; // MD-P2-2: sources unreadable (unknown) ⇒ cannot assert content ⇒ retry later (no false quiet night)
        writeDigestProjection(HOME, sources, today, nowSec()); // atomic; writes absent / repairs corrupt-without-a-recoverable-body
      }
      // (2) Notify obligation: deliver the SAME frozen body the projection carries — render the on-disk projection, NEVER a
      //     re-gather, under a per-date idempotency key whose durable PUBLISHED marker (writeInbox) dedups the delivery across the
      //     coordinator's claim/ack/restart — so a crash-after-land or a failed "sent" flip re-sends without ever duplicating.
      if (act.notify) {
        // FC-7 unknown-in-migration: a LEGACY date-only notify marker (pending WITHOUT a frozen body) predates the durable
        // credential — a pre-key publication that was consumed leaves NO trace, so we cannot prove it was never delivered. Retain +
        // surface it rather than resend a possibly-already-delivered brief — but ONLY for ITS OWN date (MD-R7-P2-2): a stale marker
        // from an earlier day must NOT block a NEW day's brief (the new date is a distinct event with its own credential).
        if (notified.kind === "pending" && !notified.body && notified.date === today) { log(`morning digest: legacy date-only notify marker (${notified.date}) — retained for migration, not auto-resent`); return; }
        const p = readDigestProjection(HOME);
        if (p.kind !== "valid" || p.date !== today) return; // the frozen body is not on disk yet (projection write failed) ⇒ retry
        // MD-R7-P2-2: a LEGACY date-only marker from an EARLIER day is the only record of that day's un-migrated obligation. EVERY
        // branch below overwrites notified.json via markNotified (the no-target branch too), so durably ARCHIVE it FIRST (per-date,
        // append-only). If the archive can't persist, do NOT overwrite — keep the old marker recoverable and retry next tick.
        if (notified.kind === "pending" && !notified.body && notified.date !== today && !archiveLegacyMigration(HOME, notified.date)) return;
        const coord = process.env.SWARM_COORDINATOR;
        if (!coord || !coord.trim()) { markNotified(HOME, today, "sent", p.projection); return; } // no coordinator ⇒ no target; the projection is the artifact
        const coordSid = resolveSession(coord, listSessions(HOME));
        if (!coordSid) return; // coordinator not resolvable on this machine yet ⇒ retry (leave none/pending)
        if (!markNotified(HOME, today, "pending", p.projection)) return; // MD-P2-1: claim + freeze the body BEFORE sending; if it can't persist, do NOT send (retry)
        try {
          // MD-P2-1: the durable-first credential makes writeInbox exactly-once across the coordinator's claim/ack/restart. Confirm
          // "sent" ONLY when the publish is actually confirmed ("published" now, or "already" delivered) — a "deferred" (a concurrent
          // winner), "pending" (an unconfirmable prior attempt) or "unknown" (unreadable credential) must leave the marker "pending"
          // so the obligation stays VISIBLE and retries; a loser must never settle the winner's work as done.
          const res = writeInbox(HOME, coordSid, { from: SELF, fromLabel: "swarm-digest", text: digestTextFromProjection(p.projection), via: "local", ts: Date.now(), taskRef: "morning-digest", title: "morning brief", intent: "fyi" }, `morning-digest-${today}`);
          if (res === "published" || res === "already") markNotified(HOME, today, "sent", p.projection); // confirmed delivery ⇒ never re-send
        } catch (e) { log(`morning digest notify failed (isolated): ${e instanceof Error ? e.message : e}`); } // leave "pending" ⇒ retry (credential ⇒ no dup)
      }
    } catch (e) { log(`morning digest failed (isolated): ${e instanceof Error ? e.message : e}`); }
  };

  await runDispatchLoops({
    // Lifecycle handoff pass, then the business-task pass (§4.5: handoff advances lifecycle, then task observes/accepts/
    // dispatches). T1.5 RED LINE (fe0376cd): --task dispatch stays off (SWARM_TASK_EXEC) until the resume adapter +
    // lifecycle→commitControl migration land — a handoff's resume half is not yet wired to continue the business task.
    passTick: async () => {
      await pass(records, ops);
      if (plan && taskOn && taskOps) { taskStateRef.s = loadControlLog(CONTROL_LOG_DIR); await taskPass(plan, taskOps); }
      // §2d board admission (PULL path) — both self-gated on SWARM_BOARD_ADMIT (live by default; =0 ⇒ no-op), independent of
      // SWARM_TASK_EXEC push. Producer posts ready nodes as claimable items; consumer admits claims (prepareDispatch on current
      // CONTROL → grant intent+binding+supervision wait+receipt / reject), NO execution (A2). Dormant-ahead-of-use.
      runBoardProducer();
      runBoardConsumer();
      // NOTE: the projection + verdict refresh is NOT here — it lives on the sweep loop (below), so a wedged pass/taskPass
      // cannot freeze the on-disk verdict into a stale OK (review P2-1). Per-commit projection writes still happen via the
      // commitTask apply hook; this loop only drives the business passes.
    },
    // The liveness sweep (§0b R2) — scan durable waits + member liveness, auto-handle expired waits (ping/escalate/re-arm)
    // + dead owners (reassign) + stuck validators (move). The coordinator-replacement step; gated on SWARM_SWEEP.
    sweepTick: async () => {
      sweepStateRef.s = loadControlLog(CONTROL_LOG_DIR);
      if (SWEEP_ENABLED) {
        // §2c-b: renew eligible EXPIRED liveness waits (subject progressed since the arm) BEFORE escalating, then reload so
        // sweepPass sees the fresh deadlines and does not escalate a just-renewed wait.
        renewLivenessWaits();
        sweepStateRef.s = loadControlLog(CONTROL_LOG_DIR);
        await sweepPass(sweepOps);
      }
      // Now-dependent projection + INV-1 verdict refresh on the INDEPENDENT sweep loop + its own ref (review P2-1): when the
      // pass loop wedges, this keeps re-sampling observations and a stale pass heartbeat flips the verdict to UNVERIFIABLE.
      // Runs even with sweep rules off — it is observability, not a sweep action; bounded, fail-soft inside the helper.
      refreshProjectionAndVerdict();
      // L2-struct observer (F22/F25): discover completion-slot artifacts + push board/PROGRESS durable changes to the coordinator.
      runObserver();
      // L2-struct 3b (F26): dead-letter bursts ⇒ routing incidents. Dormant until the ledger exists.
      runDeadLetterWatch();
      // F40: unclaimed-mail sentinel — a box with stale unread mail and no live drainer ⇒ escalate (silent-stall backstop).
      runInboxSentinel();
      // S14: live member sentinel — herdr-identified blocked/fake-death/idle-timeout ⇒ escalate (blocked ⇒ S19 approval). Gated
      // on SWARM_SENTINEL + herdr reachability; dormant otherwise.
      await runLiveSentinel();
      // T5-5: review-seat autoscale SUGGESTION (never acts) — read the review-queue ledger, advise the coordinator on seat
      // scaling. Gated on SWARM_REVIEW_AUTOSCALE (live by default; kill with =0); fully fail-soft.
      runReviewAutoscaleSuggest();
      // placement suggestion (reconcile → selectBackends → coordinator advisory). Gated on SWARM_PLACEMENT (default OFF); never
      // spawns/spends (R16); fully fail-soft.
      runPlacementSuggest();
      // T5-2: gauge timed sampling — refresh gauge.json so the console gauge is not stale. Gated on SWARM_GAUGE_SAMPLING
      // (live by default; kill with =0), throttled to SWARM_GAUGE_SAMPLE_SEC; fully fail-soft (never breaks the sweep).
      runGaugeSampling();
      // Morning digest — generate the daily brief projection + coordinator fyi once per day at/after SWARM_DIGEST_HOUR. Gated on
      // SWARM_DIGEST (live by default; kill with =0); fully fail-soft.
      runDigest();
      // SWARM_INBOX_WAKE backstop: the write-side hook pings on every new message; this only re-pings the COORDINATOR's box if an
      // item has lain unclaimed past the window (a write-side wake that was missed because herdr was briefly down). Shares the hook's
      // filesystem claim, so it never double-fires a just-pinged box. IW-P2-2: resolve the coordinator through the SAME identity
      // resolver the normal notify path uses (resolveSession) — a configured handle resolves to its stable SID; no-resolution or a
      // non-stable result is skipped (never use a display handle as the box key). Fully fail-soft.
      const wakeCoordSid = resolveSession(COORDINATOR, listSessions(HOME));
      if (wakeCoordSid && isStableSid(wakeCoordSid)) await backstopWake(HOME, wakeCoordSid, log);
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
