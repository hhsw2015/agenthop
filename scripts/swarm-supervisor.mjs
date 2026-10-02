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
// Validate the allowlist is a real artifact set, not the whole tree (Codex #8/#9): reject "." "./" "*" absolute ".."
// AND git pathspec magic (a leading ":" like :(top)** escapes to the whole tree). A list that filtered down to
// EMPTY (e.g. SWARM_ALLOWLIST=",") is also rejected — must() only checks the raw string was non-empty.
if (ALLOWLIST.length === 0) { console.error("swarm-supervisor: SWARM_ALLOWLIST resolved to an empty set"); process.exit(2); }
for (const p of ALLOWLIST) {
  if (p === "." || p === "./" || p === "*" || p.startsWith("/") || p.startsWith(":") || p.includes(":") || p.split("/").includes("..")) {
    console.error(`swarm-supervisor: unsafe allowlist entry ${JSON.stringify(p)} (no '.' './' '*' absolute '..' or ':' pathspec magic)`);
    process.exit(2);
  }
}

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
// Each field capped so that even worst-case JSON escaping (~2x) of BOTH fields + overhead stays under the 16KB
// bound parseManifest enforces — no runtime size surprise (Codex #10).
const MANIFEST_FIELD_CAP = 3000;
function clampStr(s, max) { return s.length > max ? `${s.slice(0, max)}…[truncated]` : s; }
// Coerce goal/next to a STRING (the worker's req JSON could carry a non-string) so a non-string can never produce a
// manifest the dispatcher's parseManifest rejects (Codex #10).
function asStr(v) { return v === undefined || v === null ? undefined : typeof v === "string" ? v : JSON.stringify(v); }
function buildManifest(kind, goal, next) {
  // NO createdAt: a changing timestamp each publish would defeat the "skip if unchanged" idempotency (Codex).
  const g0 = asStr(goal);
  const n0 = asStr(next);
  const g = g0 ? clampStr(g0, MANIFEST_FIELD_CAP) : undefined;
  const n = n0 ? clampStr(n0, MANIFEST_FIELD_CAP) : undefined;
  const s = JSON.stringify({ schemaVersion: 1, launchId: LID, generation: GEN, kind, ...(g ? { goal: g } : {}), ...(n ? { next: n } : {}) });
  // Belt-and-suspenders: if still over (pathological), drop to the minimal valid manifest.
  return s.length > MAX_MANIFEST_BYTES ? JSON.stringify({ schemaVersion: 1, launchId: LID, generation: GEN, kind }) : s;
}

async function publish(kind, { goal, next } = {}) {
  // 1. write the manifest into the work tree at a fixed, supervisor-owned path (NOT something the worker writes).
  const manifestAbs = path.join(WORK_DIR, MANIFEST_REL);
  mkdirSync(path.dirname(manifestAbs), { recursive: true });
  atomicWrite(manifestAbs, buildManifest(kind, goal || GOAL, next), 0o644);

  // 2. parent = the REMOTE publish-branch tip (NOT the worker's local branch). ls-remote first so a QUERY FAILURE
  //    (network) is NOT mistaken for "branch absent" (Codex): on failure we abort + retry next tick. Single-publisher
  //    guard: if the remote advanced to something WE did not push, refuse to blind-rebase onto a foreign commit.
  const ls = await git(["ls-remote", "origin", `refs/heads/${BRANCH}`]);
  if (ls.code !== 0) return { ok: false, error: `ls-remote: ${ls.stderr.trim()}` };
  const remoteTip = (ls.stdout.split(/\s+/)[0] || "").trim(); // empty => branch genuinely absent
  // Lost-ACK / unresolved-push reconciliation (Codex P1-B): a push whose ACK we lost (returned failure/timeout)
  // may still have LANDED, so the remote can sit at ANY sha we attempted since our last confirmed tip. Adopt it as
  // ours BEFORE the foreign guard. Tracking the whole SET (not a single pendingSha) fixes the self-lock: A ok, B
  // times out (unknown), next round still sees A and builds C overwriting B's pending; then B lands -> remote=B,
  // which with only pendingSha=C looked "foreign" forever. With the set, B is still recognized as ours.
  if (remoteTip && (remoteTip === lastPushedSha || attemptedShas.has(remoteTip))) lastPushedSha = remoteTip;
  if (remoteTip && lastPushedSha && remoteTip !== lastPushedSha)
    return { ok: false, error: `foreign tip ${remoteTip.slice(0, 8)} != ours ${lastPushedSha.slice(0, 8)}; refusing blind rebase (single-publisher violated)` };
  // #6 parent is the CHECKED remoteTip, never a post-fetch re-read of the branch (a foreign writer could advance it
  //    between our check and the fetch). Fetch that exact object; if fetch-by-sha is unsupported, fetch the ref but
  //    VERIFY it still equals remoteTip, else abort.
  let parent = "";
  if (remoteTip) {
    let f = await git(["fetch", "-q", "origin", remoteTip]);
    if (f.code !== 0) {
      f = await git(["fetch", "-q", "origin", `refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
      if (f.code !== 0) return { ok: false, error: `fetch: ${f.stderr.trim()}` };
      const after = (await git(["rev-parse", "-q", "--verify", `refs/remotes/origin/${BRANCH}`])).stdout.trim();
      if (after !== remoteTip) return { ok: false, error: `remote advanced during fetch (${after.slice(0, 8)} != ${remoteTip.slice(0, 8)}); retry` };
    }
    parent = remoteTip;
  }

  // 2b. recover the publish PHASE from the parent's fixed manifest on EVERY publish (Codex P1-A). Startup recovery
  //     can MISS a remote `final` (transient ls/fetch/show failure, or a final whose ACK was lost), leaving in-memory
  //     finalized=false; a rescue/milestone would then build PAST a confirmed final and move the frozen handoff tip.
  //     Reading the parent's kind here makes the freeze self-correcting. Unknown phase (manifest unreadable/unparsable)
  //     is treated as possibly-final: refuse rather than risk publishing past a final; a later tick retries.
  if (parent) {
    const pm = await git(["show", `${parent}:${MANIFEST_REL}`]);
    if (pm.code !== 0) return { ok: false, error: `parent ${parent.slice(0, 8)} manifest unreadable (phase unknown); refusing to publish past a possibly-final tip` };
    let parentKind;
    try { parentKind = JSON.parse(pm.stdout).kind; } catch { return { ok: false, error: `parent ${parent.slice(0, 8)} manifest parse failed (phase unknown); refusing` }; }
    if (parentKind === "final") {
      finalized = true;            // freeze: never build past a confirmed final, even if we forgot we finalized
      lastPushedSha = parent;
      attemptedShas.clear();
      return { ok: true, sha: parent, unchanged: true, hitFinal: true };
    }
  }

  // 3. build the tree from an EMPTY private index + ONLY the allowlist (+manifest). Starting empty means a
  //    worker-committed out-of-tree .env can NEVER be inherited (Codex #2); the publish branch is a curated
  //    artifact snapshot, not a mirror of the worker's checkout.
  const empty = await git(["read-tree", "--empty"], { indexFile: PRIVATE_INDEX });
  if (empty.code !== 0) return { ok: false, error: `read-tree --empty: ${empty.stderr.trim()}` };
  // Add each path individually, tolerating "pathspec did not match" (git add has no --ignore-unmatch). An allowlist
  // entry whose file was DELETED (or a now-empty dir) simply matches nothing; with the empty index that correctly
  // leaves it ABSENT from the published tree — a deletion, not an error (Codex #7). A real add error still fails.
  for (const p of [MANIFEST_REL, ...ALLOWLIST]) {
    const a = await git(["add", "--", p], { indexFile: PRIVATE_INDEX });
    if (a.code !== 0 && !/did not match/i.test(a.stderr)) return { ok: false, error: `git add ${p}: ${a.stderr.trim()}` };
  }
  const wt = await git(["write-tree"], { indexFile: PRIVATE_INDEX });
  if (wt.code !== 0) return { ok: false, error: `write-tree: ${wt.stderr.trim()}` };
  const tree = wt.stdout.trim();

  // 4. skip only if the REMOTE parent already carries this exact tree (then the remote truly has our snapshot).
  if (parent) {
    const parentTree = (await git(["rev-parse", `${parent}^{tree}`])).stdout.trim();
    if (parentTree === tree) { lastPushedSha = parent; attemptedShas.clear(); return { ok: true, sha: parent, unchanged: true }; } // remote already has this tree
  }

  // 5. commit-tree onto the remote parent, then push the COMMIT OBJECT directly (no update-ref -> the worker's
  //    HEAD/branch is never touched). Non-force so the remote only fast-forwards.
  const ct = await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `swarm ${kind} g${GEN}`]);
  if (ct.code !== 0) return { ok: false, error: `commit-tree: ${ct.stderr.trim()}` };
  const sha = ct.stdout.trim();
  attemptedShas.add(sha); // track BEFORE the push: if the ACK is lost but it landed, next round recognizes it as ours (P1-B)
  const push = await git(["push", "origin", `${sha}:refs/heads/${BRANCH}`]);
  if (push.code !== 0) {
    // Do NOT force/rebase. A later tick re-fetches the remote tip; if OUR push actually landed it is in attemptedShas
    // and we adopt it; otherwise we retry. Never masks a failure.
    return { ok: false, error: `push: ${push.stderr.trim()}`, sha };
  }
  lastPushedSha = sha;   // OUR confirmed tip (single-publisher guard spots a foreign writer next time)
  attemptedShas.clear(); // confirmed FF: every earlier attempt is now moot (remote can only fast-forward) (P1-B)
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
let lastPushedSha = "";          // OUR last CONFIRMED published tip (single-publisher guard in publish())
const attemptedShas = new Set(); // shas we've tried to push since the last CONFIRMED tip; a lost-ACK push still
                                 // landed, so the remote showing any of these is OURS, not foreign (Codex P1-B).
let lastReq = "";         // the last requestId we CONFIRMED (permanent skip)
let processingReq = "";   // the requestId currently in flight (coalesce: don't re-enqueue it every tick)
let finalized = false;    // a `final` has been confirmed -> freeze: publish nothing more until retire/scrub (Codex #6)
function checkRequest() {
  if (ending || finalized) return; // once dying or finalized, stop accepting new work (Codex #5/#6)
  if (!existsSync(REQ_FILE)) return;
  let req;
  try { req = JSON.parse(readFileSync(REQ_FILE, "utf8")); } catch { return; }
  if (!req || typeof req.requestId !== "string") return;
  const requestId = req.requestId;
  // Coalesce: skip if already confirmed OR already in flight. Without the in-flight guard, every 5s tick re-enqueued
  // the SAME request while the first was still publishing, and a queued duplicate would capture AFTER the worker's
  // terminal ACK ended its freeze (Codex #5).
  if (requestId === lastReq || requestId === processingReq) return;
  const kind = req.kind === "final" ? "final" : "milestone";
  processingReq = requestId;
  writeAck({ requestId, status: "capturing" }); // "received", not "frozen-proven" — freeze is the worker's contract
  runExclusive(async () => {
    try {
      if (finalized) { writeAck({ requestId, status: "error", error: "finalized" }); return; } // exec-time: a req queued before final (#3)
      const r = await publish(kind, { goal: req.goal, next: req.next });
      if (r.ok) {
        lastReq = requestId;
        if (kind === "final") finalized = true; // freeze the handoff point; no later rescue can move the tip past it
        writeAck({ requestId, status: "confirmed", sha: r.sha });
        log(`${kind} ${requestId} -> ${r.sha}${r.unchanged ? " (unchanged)" : ""}`);
      } else {
        writeAck({ requestId, status: "error", error: r.error }); // leave lastReq unset so the worker may retry the same id
      }
    } catch (err) {
      // publish THREW (e.g. a transient fs/IO error). Without this the request would be stuck "capturing" forever
      // and the same id skipped (processingReq never cleared) — Codex #8. Report an error so the worker can retry.
      writeAck({ requestId, status: "error", error: `exception: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      processingReq = ""; // ALWAYS clear in-flight (retryable on error; a confirmed id is already skipped via lastReq)
    }
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
      try {
        // If a clean final was already confirmed, do NOT publish a rescue past it (keep the frozen handoff tip).
        if (!finalized) {
          const r = await publish("rescue", { next: "deadline reached; box expiring" }); // best-effort, NOT a clean final
          log(r.ok ? `deadline rescue -> ${r.sha}` : `deadline rescue FAILED: ${r.error}`);
        } else log("deadline: finalized, keeping frozen final tip");
      } catch (err) {
        log(`deadline rescue threw: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        // Scrub + exit MUST happen even if the rescue publish threw (Codex #8) — the box is dying regardless.
        if (SCRUB) { log("scrub"); spawn("bash", [SCRUB], { env, stdio: "ignore" }).unref?.(); }
        setTimeout(() => process.exit(0), 2000);
      }
    });
    return;
  }

  for (const t of THRESHOLDS.filter((t) => rem <= t && !fired.has(t)).sort((a, b) => a - b)) {
    fired.add(t);
    const mins = Math.max(1, Math.round(t / 60));
    pokeWorker(mins); // advisory nudge regardless
    if (finalized) { log(`T-${mins}m: finalized, no rescue (frozen final tip)`); continue; }
    log(`T-${mins}m (rem=${Math.round(rem)}s): poke + rescue publish`);
    runExclusive(async () => {
      if (finalized) return; // exec-time re-check: a final confirmed while this was queued (#3) — don't publish past it
      try {
        const r = await publish("rescue", { next: `T-${mins}m safety snapshot` });
        log(r.ok ? `rescue -> ${r.sha}` : `rescue FAILED: ${r.error}`);
      } catch (err) {
        log(`rescue threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  checkRequest();
}

// Startup recovery (Codex #3): a restarted supervisor must learn, from the REMOTE, (a) our last published tip
// (so the first publish's single-publisher guard doesn't flag it as foreign) and (b) whether a `final` was already
// published — in which case freeze, so we never rescue over a remote final after a restart.
async function recoverFromRemote() {
  const ls = await git(["ls-remote", "origin", `refs/heads/${BRANCH}`]);
  if (ls.code !== 0) { log(`startup: ls-remote failed (${ls.stderr.trim()}); proceeding without recovery`); return; }
  const tip = (ls.stdout.split(/\s+/)[0] || "").trim();
  if (!tip) return; // branch absent: fresh
  lastPushedSha = tip; // single-publisher: the remote tip is ours
  let f = await git(["fetch", "-q", "origin", tip]);
  if (f.code !== 0) f = await git(["fetch", "-q", "origin", `refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
  if (f.code !== 0) { log("startup: could not fetch tip; skipping finalized check"); return; }
  const show = await git(["show", `${tip}:${MANIFEST_REL}`]);
  if (show.code === 0) {
    try { if (JSON.parse(show.stdout).kind === "final") { finalized = true; log("startup: recovered finalized=true from remote final tip"); } } catch {}
  }
}

async function main() {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  log(`up: budget=${BUDGET_SEC}s deadlineWall=${DEADLINE_WALL} branch=${BRANCH} allowlist=[${ALLOWLIST.join(",")}]`);
  await recoverFromRemote();
  tick();
  // NOT unref'd: this interval keeps the supervisor alive (Codex P1-1). git is async so the tick still fires during IO.
  setInterval(tick, POLL_MS);
}

void main();
