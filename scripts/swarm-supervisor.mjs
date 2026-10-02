#!/usr/bin/env node
// Box-side swarm supervisor (git-channel pivot). Runs on a Railway box as a SEPARATE, long-lived process (launched
// via setsid in its OWN session, NOT inside the worker's tmux) so it survives + can scrub the worker's session.
// It is the SINGLE PUBLISHER of the box's WORK branch: it stages an explicit artifact allowlist into a PRIVATE
// git index (never the worker's index/HEAD), commits via plumbing onto a fixed parent, and does a non-force push
// (so the remote only ever fast-forwards). The git branch IS the durable/ordered/idempotent channel — no receipts,
// no seq, no request journal. A small manifest.json committed WITH the artifacts carries the semantic summary.
// The DISPATCHER (trusted off-box clock) is the authority on the hard deadline; this box timer is best-effort.
// See docs/swarm/phase2-design-review*.md + plan v3.
//
// Config (env, injected by swarm-launch.sh):
//   SWARM_LAUNCH_ID, SWARM_GENERATION, SWARM_BUDGET_SEC (remaining at injection), SWARM_DEADLINE_WALL (abs epoch s,
//   this incarnation), SWARM_WORK_DIR (a clone of the WORK repo; remote=origin, branch=SWARM_BRANCH),
//   SWARM_BRANCH (e.g. swarm/<lid>-g<gen>), SWARM_ALLOWLIST (REQUIRED, newline/comma paths to publish — NOT "."),
//   SWARM_RUNTIME_DIR (private 0700 dir OUTSIDE the work tree: private index, req/ack, askpass),
//   SWARM_TMUX_SESSION (worker session, default "swarm"), SWARM_SCRUB (path to swarm-scrub.sh),
//   GIT_ASKPASS (already exported; token never on argv), SWARM_GOAL (optional task description for the manifest).

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

const env = process.env;
const LID = must("SWARM_LAUNCH_ID");
const GEN = Number(must("SWARM_GENERATION"));
const BUDGET_SEC = Number(must("SWARM_BUDGET_SEC"));
const DEADLINE_WALL = Number(must("SWARM_DEADLINE_WALL"));
const WORK_DIR = must("SWARM_WORK_DIR");
const BRANCH = must("SWARM_BRANCH");
const RUNTIME_DIR = must("SWARM_RUNTIME_DIR");
const TMUX_SESSION = env.SWARM_TMUX_SESSION || "swarm";
const SCRUB = env.SWARM_SCRUB || "";
const GOAL = env.SWARM_GOAL || "";
// Allowlist is REQUIRED and must not be "." (Codex P1-3: "." / a shared index publishes logs/creds). Each entry is
// a pathspec relative to the work tree; the private index means only these (plus the manifest) are ever committed.
const ALLOWLIST = (must("SWARM_ALLOWLIST")).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

const THRESHOLDS = [300, 120]; // T-5, T-2 (matches control.ts CHECKPOINT_THRESHOLDS_SEC)
const POLL_MS = 5000;
const GIT_TIMEOUT_MS = 25_000; // bound every git call so one hung push can't eat the lifetime (Codex P1-2)
const PRIVATE_INDEX = path.join(RUNTIME_DIR, "index"); // GIT_INDEX_FILE — isolates staging from the worker's index
const MANIFEST_REL = ".swarm/manifest.json"; // committed WITH the artifacts; read by the dispatcher from the pinned sha
const REQ_FILE = path.join(RUNTIME_DIR, "checkpoint.req"); // worker writes {requestId, kind:"milestone"|"final", goal?, next?}
const ACK_FILE = path.join(RUNTIME_DIR, "checkpoint.ack"); // supervisor writes {requestId, status, sha?, error?}

// manifest.ts schema mirror (box has no bus import). Keep in sync with packages/bus/src/swarm/manifest.ts.
const MAX_MANIFEST_BYTES = 16 * 1024;

function must(k) {
  const v = env[k];
  if (!v) { console.error(`swarm-supervisor: missing required env ${k}`); process.exit(2); }
  return v;
}
function log(m) { console.error(`[sup ${LID} g${GEN}] ${m}`); }
function nowWallSec() { return Math.floor(Date.now() / 1000); }
function atomicWrite(file, data, mode = 0o600) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
}

// --- conservative deadline: min(monotonic-remaining, wall-remaining). Mirrors supervisor-logic.ts (unit-tested).
// Best-effort only: the dispatcher's trusted clock is the hard authority. monoStart resets on a supervisor restart,
// but DEADLINE_WALL is incarnation-bound and persisted by the launcher, so it still caps a restart. The combined
// suspend+wall-rollback case is covered by the dispatcher, not here (documented limit).
const monoStart = process.hrtime.bigint();
function remainingSec() {
  const byMono = BUDGET_SEC - Number(process.hrtime.bigint() - monoStart) / 1e9;
  const byWall = DEADLINE_WALL - nowWallSec();
  return Math.min(byMono, byWall);
}

// --- async, bounded git (so the setInterval deadline tick keeps firing during IO) ---
function git(args, { timeoutMs = GIT_TIMEOUT_MS, indexFile } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: WORK_DIR,
      env: indexFile ? { ...env, GIT_INDEX_FILE: indexFile } : env,
    });
    let stdout = "", stderr = "", done = false;
    const finish = (code) => { if (!done) { done = true; resolve({ code, stdout, stderr }); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", () => finish(-1));
    child.on("close", (code) => { clearTimeout(timer); finish(code ?? -1); });
  });
}

// --- the publish pipeline: stage allowlist+manifest into the PRIVATE index -> write-tree -> (skip if unchanged) ->
// commit-tree onto the current branch tip -> update local ref -> non-force push. Returns { ok, sha }.
function buildManifest(kind, goal, next) {
  // NO createdAt: a changing timestamp each publish would defeat the "skip if unchanged" idempotency (Codex).
  const m = { schemaVersion: 1, launchId: LID, generation: GEN, kind, ...(goal ? { goal } : {}), ...(next ? { next } : {}) };
  const s = JSON.stringify(m);
  if (s.length > MAX_MANIFEST_BYTES) {
    // Producer enforces the SAME bound the dispatcher's parseManifest uses (Codex #13) — drop next/goal to fit.
    return JSON.stringify({ schemaVersion: 1, launchId: LID, generation: GEN, kind });
  }
  return s;
}

async function publish(kind, { goal, next } = {}) {
  // 1. write the manifest into the work tree at a fixed, supervisor-owned path (NOT something the worker writes).
  const manifestAbs = path.join(WORK_DIR, MANIFEST_REL);
  mkdirSync(path.dirname(manifestAbs), { recursive: true });
  atomicWrite(manifestAbs, buildManifest(kind, goal || GOAL, next), 0o644);

  // 2. stage ONLY the allowlist + the manifest into the PRIVATE index (never the worker's index). Seed the private
  //    index from the branch tip so unlisted tracked files are preserved but worker-staged junk is not inherited.
  const parent = (await git(["rev-parse", "-q", "--verify", BRANCH])).stdout.trim();
  if (parent) await git(["read-tree", parent], { indexFile: PRIVATE_INDEX });
  const add = await git(["add", "--", MANIFEST_REL, ...ALLOWLIST], { indexFile: PRIVATE_INDEX });
  if (add.code !== 0) return { ok: false, error: `git add: ${add.stderr.trim()}` };

  // 3. write-tree; skip the commit entirely if the tree is unchanged (idempotent latest-snapshot, no churn).
  const wt = await git(["write-tree"], { indexFile: PRIVATE_INDEX });
  if (wt.code !== 0) return { ok: false, error: `write-tree: ${wt.stderr.trim()}` };
  const tree = wt.stdout.trim();
  if (parent) {
    const parentTree = (await git(["rev-parse", `${parent}^{tree}`])).stdout.trim();
    if (parentTree === tree) return { ok: true, sha: parent, unchanged: true };
  }

  // 4. commit-tree onto the fixed parent (no HEAD/worktree mutation), update the local branch ref, non-force push.
  const ct = await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `swarm ${kind} g${GEN}`]);
  if (ct.code !== 0) return { ok: false, error: `commit-tree: ${ct.stderr.trim()}` };
  const sha = ct.stdout.trim();
  const upd = await git(["update-ref", `refs/heads/${BRANCH}`, sha, ...(parent ? [parent] : [])]);
  if (upd.code !== 0) return { ok: false, error: `update-ref: ${upd.stderr.trim()}` };
  const push = await git(["push", "origin", `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]); // non-force: remote only fast-forwards
  if (push.code !== 0) {
    // Do NOT force/rebase. Leave the local ref; a later tick retries. On an ambiguous failure the dispatcher
    // reconciles from whatever the remote ref actually is (Codex: read the ref, don't assume not-pushed).
    return { ok: false, error: `push: ${push.stderr.trim()}`, sha };
  }
  return { ok: true, sha };
}

// --- serial checkpoint writer (one publish in flight; milestone/rescue/final never overlap) ---
let chain = Promise.resolve();
function runExclusive(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function pokeWorker(minsLeft) {
  // Advisory only (tmux send-keys is not a reliable RPC). The supervisor's own rescue publish below is the guarantee.
  spawn("tmux", ["send-keys", "-t", TMUX_SESSION,
    `[[swarm:checkpoint]] ${minsLeft}min left — drain+checkpoint now; reply NEED HANDOFF if not done`, "Enter"]);
}
function writeAck(obj) { atomicWrite(ACK_FILE, JSON.stringify(obj)); }

// --- worker-driven checkpoint requests (cooperative freeze: worker quiesces writes BEFORE writing REQ_FILE, resumes
// only after a terminal ack). kind "milestone" stays mid-task; kind "final" is the drained, frozen handoff point. ---
let lastReq = "";
function checkRequest() {
  if (!existsSync(REQ_FILE)) return;
  let req;
  try { req = JSON.parse(readFileSync(REQ_FILE, "utf8")); } catch { return; }
  if (!req || typeof req.requestId !== "string" || req.requestId === lastReq) return;
  const kind = req.kind === "final" ? "final" : "milestone";
  const requestId = req.requestId;
  writeAck({ requestId, status: "capturing" }); // "received", not "frozen-proven" — freeze is the worker's contract
  runExclusive(async () => {
    const r = await publish(kind, { goal: req.goal, next: req.next });
    if (r.ok) { lastReq = requestId; writeAck({ requestId, status: "confirmed", sha: r.sha }); log(`${kind} ${requestId} -> ${r.sha}${r.unchanged ? " (unchanged)" : ""}`); }
    else writeAck({ requestId, status: "error", error: r.error }); // leave lastReq unset so the worker may retry the same id
  });
}

// --- near-death safety (worker-INDEPENDENT) + scrub ---
const fired = new Set();
let ending = false;

function tick() {
  const rem = remainingSec();

  if (rem <= 0 && !ending) {
    ending = true;
    runExclusive(async () => {
      const r = await publish("rescue", { next: "deadline reached; box expiring" }); // best-effort, NOT a clean final
      log(r.ok ? `deadline rescue -> ${r.sha}` : `deadline rescue FAILED: ${r.error}`);
      if (SCRUB) { log("scrub"); spawn("bash", [SCRUB], { env, stdio: "ignore" }).unref?.(); }
      setTimeout(() => process.exit(0), 2000);
    });
    return;
  }

  for (const t of THRESHOLDS.filter((t) => rem <= t && !fired.has(t)).sort((a, b) => a - b)) {
    fired.add(t);
    const mins = Math.max(1, Math.round(t / 60));
    log(`T-${mins}m (rem=${Math.round(rem)}s): poke + rescue publish`);
    pokeWorker(mins);
    runExclusive(async () => {
      const r = await publish("rescue", { next: `T-${mins}m safety snapshot` });
      log(r.ok ? `rescue -> ${r.sha}` : `rescue FAILED: ${r.error}`);
    });
  }

  checkRequest();
}

function main() {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  log(`up: budget=${BUDGET_SEC}s deadlineWall=${DEADLINE_WALL} branch=${BRANCH} allowlist=[${ALLOWLIST.join(",")}]`);
  tick();
  // NOT unref'd: this interval keeps the supervisor alive (Codex P1-1). git is async so the tick still fires during IO.
  setInterval(tick, POLL_MS);
}

main();
