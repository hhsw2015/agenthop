/**
 * sanitized-read-git — the COORDINATOR-side HARDENED git committed-history read (Phase 2: log/show/diff/branch, NON-content). The
 * coordinator runs git in a THROWAWAY `--mirror` clone of the member's repo, in a SCRUBBED env, and injects the captured output;
 * the member's rewrite (`builtin command /bin/cat <result>`) reads THAT — identical to every other sanitize form. It NEVER runs the
 * member's git command and never checks out a working tree. The ONLY git touches of the member's repo are three side-effect-free,
 * hardened probes to find the clone source + faithfully replicate HEAD: `rev-parse --absolute-git-dir` (the real git-dir, not the
 * `core.worktree`-redirectable toplevel), `symbolic-ref -q HEAD` (the full current-branch ref, or detached), and — only when
 * detached — `rev-parse --verify HEAD` (the sha). Everything else runs in the throwaway clone.
 *
 * Soundness (the git-recall threat list is the audit input; empirically verified against planted exec vectors):
 *   - ENV (git-recall Hole 2): the child env is MINIMAL — only PATH (the coordinator's own, trusted) + GIT_CONFIG_GLOBAL/SYSTEM
 *     =/dev/null + GIT_TERMINAL_PROMPT=0. The coordinator's process.env is NOT spread, so BASH_ENV / every GIT_* / PAGER / EDITOR /
 *     SSH_ASKPASS / XDG_CONFIG_HOME are all absent by construction (env -i), and ~/.gitconfig is bypassed (GIT_CONFIG_GLOBAL=/dev/null).
 *   - CONFIG exec (Hole 1): `--no-pager` + `-c diff.external=` + `-c core.fsmonitor=` + `--no-ext-diff` (diff/log/show). A `--mirror`
 *     clone does NO checkout and uses git's LOCAL transport (no upload-pack) ⇒ smudge/textconv filters, core.fsmonitor, and
 *     uploadpack.packObjectsHook NEVER fire (verified: four planted vectors did not execute during clone + read).
 *   - CONTENT leak (Hole 3): the closed non-content flag table (sanitized-read.ts) + the rev-operand check below ⇒ no file content.
 *   - rev-vs-pathspec: every operand is verified to resolve to a COMMIT in the clone (`rev-parse --verify <rev>^{commit}`); a
 *     pathspec / path / `rev:path` blob fails that peel ⇒ reject ⇒ escalate (never a silent pathspec/content read).
 * Residual (brief ⑤, documented, same class as git-recall's unmodelled-knob residual): a FUTURE git config knob that execs during a
 * bare local `--mirror` clone and is not in the `-c` set — a coordinator-side exec. Audited against the git-recall threat list.
 */
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { SanitizeSpec } from "./sanitized-read.js";
import { SANITIZED_READ_MAX_BYTES, SANITIZED_READ_DIRNAME } from "./sanitized-read.js";
import type { ReadResult } from "./sanitized-read-io.js";

/** env -i equivalent: ONLY the vars git needs, none of the coordinator's (no BASH_ENV, no GIT_ vars, no PAGER). PATH is the coordinator's
 *  own (trusted — not member-controlled). GIT_CONFIG_GLOBAL/SYSTEM=/dev/null bypass ~/.gitconfig + /etc/gitconfig. */
function minimalEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

type GitOut = { code: number; stdout: Buffer; truncated: boolean };
/** The git runner shape — injectable so tests can simulate probe/writeback FAILURES (exit codes) that real git won't easily produce. */
export type GitRunner = (args: string[], maxBytes: number) => Promise<GitOut>;

/** Run `git <args>` in the scrubbed env, capturing stdout up to `maxBytes` (then mark truncated + kill — bounded memory). stderr is
 *  drained + discarded (never injected). No shell (execFile-style arg vector) ⇒ no shell metachar interpretation. Never rejects. */
function runGit(args: string[], maxBytes: number): Promise<GitOut> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn("git", args, { env: minimalEnv(), stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve({ code: -1, stdout: Buffer.alloc(0), truncated: false }); return; }
    const chunks: Buffer[] = [];
    let total = 0, truncated = false, done = false;
    const finish = (code: number) => { if (done) return; done = true; resolve({ code, stdout: Buffer.concat(chunks).subarray(0, maxBytes), truncated }); };
    child.stdout?.on("data", (d: Buffer) => {
      // SR2-P2-3: ANY byte beyond the cap ⇒ truncated. A chunk that lands EXACTLY on the cap is NOT yet truncated (it may be the
      // final chunk — a complete output that fills the cap stays unmarked); a SUBSEQUENT chunk is what proves there was more.
      if (total >= maxBytes) { truncated = true; try { child.kill("SIGKILL"); } catch { /* best-effort */ } return; }
      const room = maxBytes - total;
      if (d.length > room) { chunks.push(d.subarray(0, room)); total = maxBytes; truncated = true; try { child.kill("SIGKILL"); } catch { /* best-effort */ } }
      else { chunks.push(d); total += d.length; } // may reach EXACTLY the cap; left unmarked unless a later chunk arrives
    });
    child.stderr?.on("data", () => { /* drain; stderr is never injected */ });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** The coordinator-owned 0700 scratch root for throwaway git clones (pin ②). */
function gitScratchRoot(home: string): string {
  return join(home, ".agenthop", "swarm", SANITIZED_READ_DIRNAME, "git-scratch");
}

/** Pin ②: a scratch-cleanup FAILURE is NEVER silent — append an alert line to a ledger the coordinator can see. ASYNC (SR2-P2-5:
 *  a sync append would block the sweep); the GC never deletes this ledger (SR2-P2-4: it cleans only result files). Best-effort. */
async function ledgerScratchError(home: string, scratch: string, err: unknown): Promise<void> {
  try {
    const line = JSON.stringify({ ts: Date.now(), scratch, error: `sanitized-read git scratch cleanup failed: ${err instanceof Error ? err.message : String(err)}` });
    const ledger = join(home, ".agenthop", "swarm", SANITIZED_READ_DIRNAME, "scratch-cleanup-errors.jsonl");
    await fsp.appendFile(ledger, `${line}\n`, { mode: 0o600 });
  } catch { /* the ledger itself is best-effort; a leftover scratch dir is the residual, surfaced via the leftover dir itself */ }
}

/**
 * HARDENED git committed-history read (Phase 2). Resolves the real git-dir (SR2-P2-1: not the `core.worktree`-redirectable
 * toplevel) + the source HEAD state, clones `--mirror` into a 0700 scratch, replicates HEAD (SR2-P2-2), VALIDATES each operand
 * resolves to a commit in the clone, runs the hardened non-content read, returns the captured bytes (capped, SR2-P2-3). The scratch
 * is ALWAYS removed in a finally (pin ①: even on a dispatcher budget-timeout the op settles here + cleans up; a cleanup failure ⇒
 * ledger alert, pin ②). `cwd` is the member's verified absolute cwd (S11). ALL FS async (SR2-P2-5: never blocks the sweep).
 */
export async function resolveAndReadGit(spec: SanitizeSpec, cwd: string, home: string, run: GitRunner = runGit): Promise<ReadResult> {
  if (spec.readKind !== "git") return { ok: false, reason: `not-a-git-spec:${spec.readKind}` };
  // SR2-P2-1: bind the clone source to the real GIT METADATA DIR, not the worktree toplevel. `core.worktree` can point the
  // worktree (`--show-toplevel`) at a DIFFERENT repo, but committed history lives in the git-dir, which `core.worktree` cannot
  // redirect. Strip only the trailing NEWLINE (NOT `.trim()`), so a path with a legitimate trailing space is preserved. Hardened.
  const gd = await run(["-C", cwd, "--no-pager", "-c", "core.fsmonitor=", "-c", "diff.external=", "rev-parse", "--absolute-git-dir"], 4096);
  if (gd.code !== 0) return { ok: false, reason: "not-a-git-repo" };
  const gitdir = stripTrailingNewline(gd.stdout.toString("utf8"));
  if (!gitdir) return { ok: false, reason: "no-git-dir" };
  // SR2-R2-P2-1: read the SOURCE HEAD state so the clone's current-branch marker is faithful (a `--mirror` clone does NOT preserve a
  // detached HEAD). Use the FULL symbolic ref (NOT `--short`, which returns an ambiguous `heads/<x>` when a tag shares the name), and
  // distinguish by EXIT CODE: 0 = on a branch (full ref in stdout), 1 = normal detached, anything else = a probe ERROR ⇒ escalate
  // (never guess detached from an error). Each probe/writeback code is checked; "can't confirm" ⇒ fail-to-user.
  const symref = await run(["-C", cwd, "--no-pager", "symbolic-ref", "-q", "HEAD"], 4096);
  let headFullRef = "";  // the full refs/heads/<branch> when on a branch
  let headSha = "";      // the sha when detached
  if (symref.code === 0) {
    headFullRef = stripTrailingNewline(symref.stdout.toString("utf8"));
    if (!headFullRef) return { ok: false, reason: "head-probe-empty" };          // code 0 but no ref ⇒ can't confirm
  } else if (symref.code === 1) {
    const rp = await run(["-C", cwd, "--no-pager", "rev-parse", "--verify", "--quiet", "HEAD"], 256); // normal detached ⇒ the sha
    if (rp.code !== 0) return { ok: false, reason: "head-sha-probe-failed" };
    headSha = stripTrailingNewline(rp.stdout.toString("utf8"));
    if (!headSha) return { ok: false, reason: "head-sha-empty" };
  } else {
    return { ok: false, reason: "head-probe-failed" };                           // code >= 2 (e.g. 128 not-a-repo) ⇒ escalate, NOT detached
  }

  // SR2-R3-P2-1 (a): `git branch` prints a `+ <branch>` marker for a branch checked out in a LINKED worktree — working-tree
  // occupancy a bare clone can't reproduce (Phase-3 territory). If the source has >1 worktree, escalate the branch read.
  if (spec.subcmd === "branch") {
    const wl = await run(["-C", cwd, "--no-pager", "worktree", "list", "--porcelain"], 1_000_000);
    if (wl.code !== 0) return { ok: false, reason: "worktree-probe-failed" };
    if (wl.stdout.toString("utf8").split("\n").filter((l) => l.startsWith("worktree ")).length > 1) return { ok: false, reason: "worktree-occupancy" };
  }

  const root = gitScratchRoot(home);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });            // SR2-P2-5: async so a slow FS never blocks the sweep
  const scratch = await fsp.mkdtemp(join(root, "r-"));
  try {
    // `--mirror` (bare, no checkout, no upload-pack for a local source) ⇒ no exec vector; copies ALL refs so `branch -a/-r` is faithful.
    const cl = await run(["clone", "--mirror", "--quiet", gitdir, scratch], 4096);
    if (cl.code !== 0) return { ok: false, reason: "clone-failed" };

    // SR2-R2-P2-1: replicate the source HEAD into the clone using the FULL ref (branch ⇒ symbolic-ref, detached ⇒ detach at the sha),
    // and CHECK the writeback exit code — a failed writeback leaves the clone HEAD wrong, so escalate rather than return a wrong marker.
    const wb = headFullRef
      ? await run(["-C", scratch, "symbolic-ref", "HEAD", headFullRef], 256)     // headFullRef = "refs/heads/..." ⇒ not a flag
      : await run(["-C", scratch, "update-ref", "--no-deref", "HEAD", headSha], 256);
    if (wb.code !== 0) return { ok: false, reason: "head-writeback-failed" };

    // SR2-R3-P2-1 (b): a `--mirror` clone copies refs/remotes/*/HEAD as a PLAIN ref, losing the `origin/HEAD -> origin/main` arrow
    // that `branch -r`/`-a` prints. For those forms, replicate the source's remote-HEAD SYMBOLIC refs into the clone (re-pointing a
    // ref, NOT copying config). A probe or replication failure ⇒ escalate (can't faithfully return the symref relationship).
    if (spec.flags.some((f) => f === "-a" || f === "--all" || f === "-r")) {
      const fer = await run(["-C", cwd, "--no-pager", "for-each-ref", "--format=%(refname) %(symref)", "refs/remotes/"], 1_000_000);
      if (fer.code !== 0) return { ok: false, reason: "symref-probe-failed" };
      for (const line of fer.stdout.toString("utf8").split("\n")) {
        const sp = line.indexOf(" ");
        if (sp < 0) continue;
        const refname = line.slice(0, sp), target = line.slice(sp + 1).trim();
        if (!target || !refname.endsWith("/HEAD")) continue;        // only the remote-HEAD symbolic refs carry the arrow
        const w = await run(["-C", scratch, "symbolic-ref", refname, target], 256);
        if (w.code !== 0) return { ok: false, reason: "symref-replication-failed" };
      }
    }

    // Operand soundness: each must peel to a COMMIT in the clone (a rev, not a pathspec/path/`rev:path` blob). A range endpoint too.
    for (const operand of spec.operands) {
      for (const rev of operand.split(/\.\.\.?/).filter((r) => r.length > 0)) {
        const v = await run(["-C", scratch, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], 256);
        if (v.code !== 0) return { ok: false, reason: "bad-rev" };   // not a committed rev ⇒ escalate (never a pathspec/content read)
      }
    }

    // The hardened non-content read. Global opts BEFORE the subcommand; `--no-ext-diff` (diff-family) AFTER it for diff/log/show.
    const noExtDiff = spec.subcmd === "diff" || spec.subcmd === "log" || spec.subcmd === "show" ? ["--no-ext-diff"] : [];
    const args = ["-C", scratch, "--no-pager", "-c", "diff.external=", "-c", "core.fsmonitor=", spec.subcmd, ...noExtDiff, ...spec.flags, ...spec.operands];
    const rr = await run(args, SANITIZED_READ_MAX_BYTES);
    // A non-zero exit is a FAILURE only when NOT truncated: hitting the cap SIGKILLs git (close code != 0 by design), which must
    // still return the capped output + truncated=true (SR2-P2-3 — the marker is applied downstream), not be misread as an error.
    if (!rr.truncated && rr.code !== 0) return { ok: false, reason: `git-${spec.subcmd}-failed` };
    return { ok: true, bytes: rr.stdout, truncated: rr.truncated };
  } finally {
    // pin ①: always clean up, even post-timeout. SR2-P2-5: async rm so a slow/large delete never blocks the dispatcher sweep.
    try { await fsp.rm(scratch, { recursive: true, force: true }); }
    catch (e) { await ledgerScratchError(home, scratch, e); }         // pin ②: a delete failure is NEVER silent (async ledger)
  }
}

/** Strip ONLY a trailing newline (and an optional CR) from git output — NOT `.trim()`, which would corrupt a path ending in a space. */
function stripTrailingNewline(s: string): string { return s.replace(/\r?\n$/, ""); }
