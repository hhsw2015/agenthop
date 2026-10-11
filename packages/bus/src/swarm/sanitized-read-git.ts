/**
 * sanitized-read-git — the COORDINATOR-side HARDENED git committed-history read (Phase 2: log/show/diff/branch, NON-content). The
 * coordinator runs git in a THROWAWAY `--mirror` clone of the member's repo, in a SCRUBBED env, and injects the captured output;
 * the member's rewrite (`builtin command /bin/cat <result>`) reads THAT — identical to every other sanitize form. It NEVER runs the
 * member's git command, never runs git in the member's repo (except one side-effect-free `rev-parse --show-toplevel` to find the
 * clone source), and never checks out a working tree.
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
export async function resolveAndReadGit(spec: SanitizeSpec, cwd: string, home: string): Promise<ReadResult> {
  if (spec.readKind !== "git") return { ok: false, reason: `not-a-git-spec:${spec.readKind}` };
  // SR2-P2-1: bind the clone source to the real GIT METADATA DIR, not the worktree toplevel. `core.worktree` can point the
  // worktree (`--show-toplevel`) at a DIFFERENT repo, but committed history lives in the git-dir, which `core.worktree` cannot
  // redirect. Strip only the trailing NEWLINE (NOT `.trim()`), so a path with a legitimate trailing space is preserved. Hardened.
  const gd = await runGit(["-C", cwd, "--no-pager", "-c", "core.fsmonitor=", "-c", "diff.external=", "rev-parse", "--absolute-git-dir"], 4096);
  if (gd.code !== 0) return { ok: false, reason: "not-a-git-repo" };
  const gitdir = stripTrailingNewline(gd.stdout.toString("utf8"));
  if (!gitdir) return { ok: false, reason: "no-git-dir" };
  // SR2-P2-2: read the SOURCE HEAD state (a branch, or detached) so the clone's current-branch marker is faithful — a `--mirror`
  // clone does NOT preserve a detached HEAD (it points HEAD at a branch). Side-effect-free, hardened, in the member's cwd.
  const symref = await runGit(["-C", cwd, "--no-pager", "symbolic-ref", "-q", "--short", "HEAD"], 4096);
  const headBranch = symref.code === 0 ? stripTrailingNewline(symref.stdout.toString("utf8")) : "";  // "" ⇒ detached
  const headSha = headBranch ? "" : stripTrailingNewline((await runGit(["-C", cwd, "--no-pager", "rev-parse", "HEAD"], 256)).stdout.toString("utf8"));

  const root = gitScratchRoot(home);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });            // SR2-P2-5: async so a slow FS never blocks the sweep
  const scratch = await fsp.mkdtemp(join(root, "r-"));
  try {
    // `--mirror` (bare, no checkout, no upload-pack for a local source) ⇒ no exec vector; copies ALL refs so `branch -a/-r` is faithful.
    const cl = await runGit(["clone", "--mirror", "--quiet", gitdir, scratch], 4096);
    if (cl.code !== 0) return { ok: false, reason: "clone-failed" };

    // SR2-P2-2: replicate the source HEAD into the clone (branch ⇒ symbolic-ref; detached ⇒ detach HEAD at the sha). Both args are
    // git-validated refs/shas passed via the arg vector (no shell), and the branch value is prefixed `refs/heads/` so it can't be a flag.
    if (headBranch) await runGit(["-C", scratch, "symbolic-ref", "HEAD", `refs/heads/${headBranch}`], 256);
    else if (headSha) await runGit(["-C", scratch, "update-ref", "--no-deref", "HEAD", headSha], 256);

    // Operand soundness: each must peel to a COMMIT in the clone (a rev, not a pathspec/path/`rev:path` blob). A range endpoint too.
    for (const operand of spec.operands) {
      for (const rev of operand.split(/\.\.\.?/).filter((r) => r.length > 0)) {
        const v = await runGit(["-C", scratch, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], 256);
        if (v.code !== 0) return { ok: false, reason: "bad-rev" };   // not a committed rev ⇒ escalate (never a pathspec/content read)
      }
    }

    // The hardened non-content read. Global opts BEFORE the subcommand; `--no-ext-diff` (diff-family) AFTER it for diff/log/show.
    const noExtDiff = spec.subcmd === "diff" || spec.subcmd === "log" || spec.subcmd === "show" ? ["--no-ext-diff"] : [];
    const args = ["-C", scratch, "--no-pager", "-c", "diff.external=", "-c", "core.fsmonitor=", spec.subcmd, ...noExtDiff, ...spec.flags, ...spec.operands];
    const rr = await runGit(args, SANITIZED_READ_MAX_BYTES);
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
