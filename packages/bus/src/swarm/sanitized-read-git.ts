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
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
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
      if (total >= maxBytes) return;                         // already capped — discard the rest
      const room = maxBytes - total;
      if (d.length > room) { chunks.push(d.subarray(0, room)); total = maxBytes; truncated = true; try { child.kill("SIGKILL"); } catch { /* best-effort */ } }
      else { chunks.push(d); total += d.length; }
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

/** Pin ②: a scratch-cleanup FAILURE is NEVER silent — append an alert line to a ledger the coordinator can see. Best-effort. */
function ledgerScratchError(home: string, scratch: string, err: unknown): void {
  try {
    const line = JSON.stringify({ ts: Date.now(), scratch, error: `sanitized-read git scratch cleanup failed: ${err instanceof Error ? err.message : String(err)}` });
    const ledger = join(home, ".agenthop", "swarm", SANITIZED_READ_DIRNAME, "scratch-cleanup-errors.jsonl");
    appendFileSync(ledger, `${line}\n`, { mode: 0o600 });
  } catch { /* the ledger itself is best-effort; the bytes-leak risk is just a leftover scratch dir, already surfaced via the throw path */ }
}

/**
 * HARDENED git committed-history read (Phase 2). Resolves the repo toplevel, clones it `--mirror` into a 0700 scratch, VALIDATES
 * each operand resolves to a commit in the clone, runs the hardened non-content read, and returns the captured bytes (capped). The
 * scratch is ALWAYS removed in a finally (pin ①: even on a dispatcher budget-timeout the op settles here + cleans up; a cleanup
 * failure ⇒ ledger alert, pin ②). `cwd` is the member's verified absolute cwd (S11). ASYNC throughout (never blocks the sweep).
 */
export async function resolveAndReadGit(spec: SanitizeSpec, cwd: string, home: string): Promise<ReadResult> {
  if (spec.readKind !== "git") return { ok: false, reason: `not-a-git-spec:${spec.readKind}` };
  // Find the clone source = the member's repo toplevel. `rev-parse --show-toplevel` is side-effect-free (no checkout/diff/filter);
  // run it hardened (scrubbed env + the `-c` family) — this is the ONLY git touch of the member's repo; all else runs in the clone.
  const top = await runGit(["-C", cwd, "--no-pager", "-c", "core.fsmonitor=", "-c", "diff.external=", "rev-parse", "--show-toplevel"], 4096);
  if (top.code !== 0) return { ok: false, reason: "not-a-git-repo" };
  const toplevel = top.stdout.toString("utf8").trim();
  if (!toplevel) return { ok: false, reason: "no-toplevel" };

  const root = gitScratchRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(root, "r-"));
  try {
    // `--mirror` (bare, no checkout, no upload-pack for a local source) ⇒ no exec vector; copies ALL refs so `branch -a/-r` is faithful.
    const cl = await runGit(["clone", "--mirror", "--quiet", toplevel, scratch], 4096);
    if (cl.code !== 0) return { ok: false, reason: "clone-failed" };

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
    if (rr.code !== 0) return { ok: false, reason: `git-${spec.subcmd}-failed` };
    return { ok: true, bytes: rr.stdout, truncated: rr.truncated };
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); }       // pin ①: always clean up, even post-timeout
    catch (e) { ledgerScratchError(home, scratch, e); }               // pin ②: a delete failure is NEVER silent
  }
}
