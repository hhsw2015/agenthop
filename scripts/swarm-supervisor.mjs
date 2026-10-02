#!/usr/bin/env node
// Box-side swarm supervisor. Runs on a Railway box as a SEPARATE, long-lived process (launched via setsid in its
// OWN session, NOT inside the worker's tmux) so it survives + can scrub the worker's session without killing
// itself. It owns the deadline and the checkpoint/push/receipt pipeline; the worker (Claude TUI) only REQUESTS a
// milestone and supplies a semantic manifest. Self-contained: Node stdlib only (the box has node, nothing else is
// guaranteed). See docs/swarm/phase2-design-review*.md + plan v3 for why each piece exists.
//
// Config (all via env, injected by swarm-launch.sh):
//   SWARM_LAUNCH_ID, SWARM_GENERATION, SWARM_BUDGET_SEC (remaining at injection), SWARM_DEADLINE_WALL (abs epoch s,
//   this incarnation), SWARM_WORK_DIR (git clone), SWARM_BRANCH, SWARM_TMUX_SESSION (worker session, default
//   "swarm"), SWARM_RUNTIME_DIR (private 0700 dir for req/ack + askpass; MUST be outside SWARM_WORK_DIR),
//   SWARM_ALLOWLIST (newline/comma list of paths to stage; default "."), SWARM_SCRUB (path to swarm-scrub.sh),
//   GIT_ASKPASS (already exported for git auth; token never on argv).
//
// Timing: conservative min of a MONOTONIC source (process.hrtime, immune to wall steps; stalls on suspend) and the
// WALL deadline (advances across suspend). Whichever says less time remains wins. Mirrors + is unit-tested by
// packages/bus/src/swarm/supervisor-logic.ts (conservativeRemainingSec). UNDER-counting here loses the box, so we
// bias early.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

const env = process.env;
const LID = must("SWARM_LAUNCH_ID");
const GEN = Number(must("SWARM_GENERATION"));
const BUDGET_SEC = Number(must("SWARM_BUDGET_SEC"));
const DEADLINE_WALL = Number(must("SWARM_DEADLINE_WALL"));
const WORK_DIR = must("SWARM_WORK_DIR");
const BRANCH = must("SWARM_BRANCH");
const TMUX_SESSION = env.SWARM_TMUX_SESSION || "swarm";
const RUNTIME_DIR = must("SWARM_RUNTIME_DIR");
const SCRUB = env.SWARM_SCRUB || "";
const ALLOWLIST = (env.SWARM_ALLOWLIST || ".").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const THRESHOLDS = [300, 120]; // T-5, T-2 (seconds before deadline) — matches control.ts CHECKPOINT_THRESHOLDS_SEC
const POLL_MS = 5000;

const REQ_FILE = path.join(RUNTIME_DIR, "milestone.req"); // worker writes {requestId, manifest}
const ACK_FILE = path.join(RUNTIME_DIR, "milestone.ack"); // supervisor writes {requestId, status, sha, error}
const SEQ_FILE = path.join(RUNTIME_DIR, "seq"); // persisted monotonic checkpoint counter (survives a supervisor restart)
const RECEIPT_DIR_REL = ".swarm/receipts"; // inside the work repo, pushed with the checkpoint

/** Monotonic, restart-safe checkpoint sequence. Persisted so a restarted supervisor never reuses/rewrites a seq —
 *  CONTROL only advances on seq > lastSeq, so a replayed receipt can't roll a confirmed sha back. */
function nextSeq() {
  let cur = 0;
  try {
    cur = parseInt(readFileSync(SEQ_FILE, "utf8").trim(), 10) || 0;
  } catch {
    cur = 0;
  }
  const next = cur + 1;
  atomicWrite(SEQ_FILE, String(next));
  return next;
}

function must(k) {
  const v = env[k];
  if (!v) {
    console.error(`swarm-supervisor: missing required env ${k}`);
    process.exit(2);
  }
  return v;
}
function log(msg) {
  console.error(`[sup ${LID} gen${GEN}] ${msg}`);
}
function git(args, opts = {}) {
  return spawnSync("git", args, { cwd: WORK_DIR, encoding: "utf8", ...opts });
}
function nowWallSec() {
  return Math.floor(Date.now() / 1000);
}

// --- conservative deadline (see supervisor-logic.ts / its test) ---
const monoStart = process.hrtime.bigint();
function monotonicElapsedSec() {
  return Number(process.hrtime.bigint() - monoStart) / 1e9;
}
function remainingSec() {
  const byMonotonic = BUDGET_SEC - monotonicElapsedSec();
  const byWall = DEADLINE_WALL - nowWallSec();
  return Math.min(byMonotonic, byWall);
}

// --- serial checkpoint writer (one in-flight at a time; milestone + thresholds share it) ---
let chain = Promise.resolve();
function runExclusive(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * The checkpoint pipeline: stage the allowlist, commit IF there is something to commit, push the branch (separately
 * from commit — a clean tree with an unpushed commit must still push), then publish a receipt commit that records
 * the confirmed work sha, and push that. Returns { ok, sha } where sha is the confirmed WORK commit.
 * NOTE: `git add -A` is deliberately avoided (Codex P2-4: it would ingest creds/logs) — stage only the allowlist.
 */
function doCheckpoint(kind, requestId, manifest) {
  // 1. stage only the allowlisted paths
  const add = git(["add", "--", ...ALLOWLIST]);
  if (add.status !== 0) return { ok: false, error: `git add: ${add.stderr?.trim()}` };

  // 2. commit only if staged changes exist (don't let an empty commit fail the pipeline)
  const staged = git(["diff", "--cached", "--quiet"]);
  if (staged.status === 1) {
    const c = git(["commit", "-q", "-m", `swarm: ${kind} ${requestId}`]);
    if (c.status !== 0) return { ok: false, error: `git commit: ${c.stderr?.trim()}` };
  } else if (staged.status !== 0) {
    return { ok: false, error: `git diff --cached: ${staged.stderr?.trim()}` };
  }

  // 3. push the branch regardless (covers clean-tree-but-unpushed-commit). Commit and push are judged separately.
  const push1 = git(["push", "origin", `HEAD:${BRANCH}`]);
  if (push1.status !== 0) return { ok: false, error: `git push work: ${push1.stderr?.trim()}` };

  // 4. confirmed work sha
  const rev = git(["rev-parse", "HEAD"]);
  if (rev.status !== 0) return { ok: false, error: `git rev-parse: ${rev.stderr?.trim()}` };
  const sha = rev.stdout.trim();

  // 5. publish an immutable receipt pointing at the confirmed sha, then push it. The dispatcher scans receipts and
  //    CAS-advances CONTROL — the box never holds a CONTROL-write token. Shape must match receipt.ts.
  const receipt = {
    launchId: LID,
    generation: GEN,
    requestId,
    seq: nextSeq(),
    kind,
    sha,
    ...(manifest ? { manifest } : {}),
    createdAt: nowWallSec(),
  };
  const relPath = path.join(RECEIPT_DIR_REL, `${GEN}-${requestId}.json`);
  const absPath = path.join(WORK_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  atomicWrite(absPath, JSON.stringify(receipt));
  const addR = git(["add", "--", relPath]);
  if (addR.status !== 0) return { ok: false, error: `git add receipt: ${addR.stderr?.trim()}` };
  const cR = git(["commit", "-q", "-m", `swarm: receipt ${GEN}-${requestId}`]);
  if (cR.status !== 0) return { ok: false, error: `git commit receipt: ${cR.stderr?.trim()}` };
  const push2 = git(["push", "origin", `HEAD:${BRANCH}`]);
  if (push2.status !== 0) return { ok: false, error: `git push receipt: ${push2.stderr?.trim()}` };

  return { ok: true, sha };
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function pokeWorker(minsLeft) {
  // Advisory only — tmux send-keys is NOT a reliable RPC (Codex P1-1). The supervisor's OWN safety checkpoint below
  // is what guarantees the save; this just gives the worker a chance to produce a semantic final summary.
  const line = `[[swarm:checkpoint]] ${minsLeft}min left — checkpoint now; reply NEED HANDOFF if not done`;
  spawnSync("tmux", ["send-keys", "-t", TMUX_SESSION, line, "Enter"], { encoding: "utf8" });
}

// --- worker-driven milestone requests (snapshot-freeze handshake via req/ack files) ---
let lastReq = "";
function checkMilestoneRequest() {
  if (!existsSync(REQ_FILE)) return;
  let req;
  try {
    req = JSON.parse(readFileSync(REQ_FILE, "utf8"));
  } catch {
    return; // partial write mid temp+rename; try next tick
  }
  if (!req || typeof req.requestId !== "string" || req.requestId === lastReq) return;
  lastReq = req.requestId;
  const requestId = req.requestId;
  const manifest = typeof req.manifest === "string" ? req.manifest : undefined;
  // The worker, before writing REQ_FILE, is expected to have quiesced its writes (snapshot-freeze). We ack
  // "capturing" immediately, run the checkpoint, then ack the confirmed sha so the worker may resume writing.
  writeAck({ requestId, status: "capturing" });
  runExclusive(() => {
    const r = doCheckpoint("milestone", requestId, manifest);
    writeAck(r.ok ? { requestId, status: "confirmed", sha: r.sha } : { requestId, status: "error", error: r.error });
    log(r.ok ? `milestone ${requestId} confirmed ${r.sha}` : `milestone ${requestId} FAILED: ${r.error}`);
  });
}
function writeAck(obj) {
  atomicWrite(ACK_FILE, JSON.stringify(obj));
}

// --- near-death safety checkpoints (worker-INDEPENDENT) + scrub ---
const fired = new Set();
let scrubbed = false;

function tick() {
  const rem = remainingSec();

  if (rem <= 0 && !scrubbed) {
    scrubbed = true;
    runExclusive(() => {
      // Last-chance independent save of whatever is on disk, then scrub (from outside the worker tmux).
      const r = doCheckpoint("final", `deadline-${Date.now()}`, "near-death safety push");
      log(r.ok ? `final safety checkpoint ${r.sha}` : `final safety checkpoint FAILED: ${r.error}`);
      if (SCRUB) {
        log("running scrub");
        spawnSync("bash", [SCRUB], { encoding: "utf8", env });
      }
      process.exit(0);
    });
    return;
  }

  for (const t of THRESHOLDS.filter((t) => rem <= t && !fired.has(t)).sort((a, b) => a - b)) {
    fired.add(t);
    const mins = Math.max(1, Math.round(t / 60));
    log(`threshold T-${mins}m crossed (rem=${Math.round(rem)}s): poke worker + independent safety checkpoint`);
    pokeWorker(mins);
    runExclusive(() => {
      const r = doCheckpoint("final", `safety-${t}`, `T-${mins}m safety push`);
      log(r.ok ? `safety checkpoint ${r.sha}` : `safety checkpoint FAILED: ${r.error}`);
    });
  }

  checkMilestoneRequest();
}

function main() {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  log(`up: budget=${BUDGET_SEC}s deadlineWall=${DEADLINE_WALL} branch=${BRANCH} work=${WORK_DIR}`);
  tick();
  // Do NOT unref: this interval is the only thing keeping the supervisor alive; unref'd, an idle start exits
  // immediately (Codex impl-review bug 1).
  setInterval(tick, POLL_MS);
}

main();
