// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/sanitized-read-git.selftest.mts
// Pins the COORDINATOR-side HARDENED git read against REAL git fixtures (the security IS the real --mirror-clone behavior):
// log/show/diff/branch produce committed-history output; the ADVERSARIAL planted-exec-vector test (coordinator pin: four exec
// vectors in the member's .git/config must fire ZERO times across probe+clone+read); non-content (--stat never leaks file content);
// operand rev-validation (a non-rev ⇒ bad-rev, never a pathspec/blob); not-a-git-repo; and scratch self-cleanup (pins ①②).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndReadGit, type GitRunner } from "./sanitized-read-git.js";
import { planSanitize, SANITIZED_READ_MAX_BYTES, type SanitizeSpec } from "./sanitized-read.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const spec = (cmd: string): SanitizeSpec => { const s = planSanitize(cmd); if (!s) throw new Error("planSanitize returned null: " + cmd); return s; };

const root = mkdtempSync(join(tmpdir(), "sr-git-"));
const HOME = join(root, "home");          // the coordinator-owned scratch lives under HOME/.agenthop/swarm/...
const repo = join(root, "member");        // the member's repo
const scratchRoot = join(HOME, ".agenthop", "swarm", "sanitized-read", "git-scratch");

try {
  // ── fixture: a member repo with 2 commits, a feature branch, a committed .env secret, and FOUR planted exec vectors ──────────
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t"); git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "first\n"); git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "c1 first commit");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, ".env"), "TOKEN=SUPERSECRETVALUE\n"); git(repo, "add", ".env"); git(repo, "commit", "-qm", "c2 add env");
  git(repo, "checkout", "-q", "-"); // back to the first branch (main/master)
  const MARK = join(root, "EVIL");
  git(repo, "config", "core.fsmonitor", `touch ${MARK}.fsmonitor; echo`);
  git(repo, "config", "uploadpack.packObjectsHook", `touch ${MARK}.uphook #`);
  git(repo, "config", "diff.external", `touch ${MARK}.diffext; echo`);
  git(repo, "config", "core.pager", `touch ${MARK}.pager; cat`);

  // 1. git log --oneline ⇒ ok + contains a commit subject
  {
    const r = await resolveAndReadGit(spec("git log --oneline"), repo, HOME);
    t("git log --oneline ⇒ ok + has a commit", r.ok === true && /c1 first commit/.test(r.bytes.toString()));
  }
  // 2. git show --stat <feature> ⇒ ok + shows the .env FILENAME but NOT its CONTENT (non-content proof)
  {
    const r = await resolveAndReadGit(spec("git show --stat feature"), repo, HOME);
    const out = r.ok ? r.bytes.toString() : "";
    t("git show --stat ⇒ filename shown, content NOT leaked", r.ok === true && out.includes(".env") && !out.includes("SUPERSECRETVALUE"));
  }
  // 3. git diff --stat HEAD..feature ⇒ ok (committed-to-committed range) + .env in the stat, no content
  {
    const r = await resolveAndReadGit(spec("git diff --stat HEAD..feature"), repo, HOME);
    t("git diff --stat <range> ⇒ ok + no content", r.ok === true && r.bytes.toString().includes(".env") && !r.bytes.toString().includes("SUPERSECRETVALUE"));
  }
  // 4. git branch -a ⇒ ok + lists feature (faithful via --mirror)
  {
    const r = await resolveAndReadGit(spec("git branch -a"), repo, HOME);
    t("git branch -a ⇒ ok + lists feature", r.ok === true && /feature/.test(r.bytes.toString()));
  }

  // 5. ADVERSARIAL (coordinator pin): the four planted exec vectors must have fired ZERO times across probe+clone+read.
  {
    const fired = ["fsmonitor", "uphook", "diffext", "pager"].filter((v) => existsSync(`${MARK}.${v}`));
    t("planted exec vectors fire ZERO times (fsmonitor/uphook/diffext/pager)", fired.length === 0);
  }

  // 6. operand rev-validation: a non-existent ref passes the pure pre-filter but must fail the clone-side ^{commit} peel ⇒ bad-rev
  {
    const r = await resolveAndReadGit(spec("git log nonexistentref"), repo, HOME);
    t("git log <non-existent rev> ⇒ bad-rev (never a pathspec/blob read)", r.ok === false && r.reason === "bad-rev");
  }
  // 6b. an operand that is a real committed FILE name (a.txt) is NOT a commit ⇒ bad-rev (no pathspec interpretation)
  {
    const r = await resolveAndReadGit(spec("git log a.txt"), repo, HOME);
    t("git log <a committed filename> ⇒ bad-rev (no pathspec read)", r.ok === false && r.reason === "bad-rev");
  }

  // 7. not-a-git-repo ⇒ reject (cwd outside any repo)
  {
    const nonrepo = join(root, "notrepo"); mkdirSync(nonrepo, { recursive: true });
    const r = await resolveAndReadGit(spec("git log --oneline"), nonrepo, HOME);
    t("cwd not a git repo ⇒ reject not-a-git-repo", r.ok === false && r.reason === "not-a-git-repo");
  }

  // 9. SR2-P2-1: core.worktree can redirect the WORKTREE to a different repo — the clone must bind to the real GIT-DIR, not that.
  {
    const A = join(root, "wtA"), B = join(root, "wtB-decoy");
    mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true });
    git(A, "init", "-q"); git(A, "config", "user.email", "t@t"); git(A, "config", "user.name", "t");
    writeFileSync(join(A, "fa"), "REAL_A\n"); git(A, "add", "fa"); git(A, "commit", "-qm", "A-real-history");
    git(B, "init", "-q"); git(B, "config", "user.email", "t@t"); git(B, "config", "user.name", "t");
    writeFileSync(join(B, "fb"), "DECOY_B\n"); git(B, "add", "fb"); git(B, "commit", "-qm", "B-decoy-history");
    git(A, "config", "core.worktree", B); // redirect A's worktree at the decoy B
    const r = await resolveAndReadGit(spec("git log --oneline"), A, HOME);
    const out = r.ok ? r.bytes.toString() : "";
    t("core.worktree redirect ⇒ clone binds the REAL git-dir (A, not decoy B)", r.ok === true && out.includes("A-real-history") && !out.includes("B-decoy-history"));
  }
  // 10. SR2-P2-2: a DETACHED-HEAD source ⇒ sanitized `git branch` must show detached, NOT falsely mark a branch current
  {
    const D = join(root, "detached"); mkdirSync(D, { recursive: true });
    git(D, "init", "-q"); git(D, "config", "user.email", "t@t"); git(D, "config", "user.name", "t");
    writeFileSync(join(D, "f1"), "1\n"); git(D, "add", "f1"); git(D, "commit", "-qm", "d1");
    writeFileSync(join(D, "f2"), "2\n"); git(D, "add", "f2"); git(D, "commit", "-qm", "d2");
    git(D, "checkout", "-q", "--detach", "HEAD");
    const r = await resolveAndReadGit(spec("git branch"), D, HOME);
    const out = r.ok ? r.bytes.toString() : "";
    t("detached-HEAD source ⇒ branch shows detached (no false '* <branch>')", r.ok === true && /\*\s+\(/.test(out));
  }
  // 11. SR2-P2-3: git output LARGER than the cap ⇒ truncated=true (was silently false). A >1 MiB commit message overflows `git log`.
  {
    const Big = join(root, "bigmsg"); mkdirSync(Big, { recursive: true });
    git(Big, "init", "-q"); git(Big, "config", "user.email", "t@t"); git(Big, "config", "user.name", "t");
    writeFileSync(join(Big, "f"), "x\n"); git(Big, "add", "f");
    const msgFile = join(root, "bigmsg.txt"); writeFileSync(msgFile, "L".repeat(1_600_000)); // > 1 MiB cap (via -F to dodge ARG_MAX)
    git(Big, "commit", "-qF", msgFile);
    const r = await resolveAndReadGit(spec("git log"), Big, HOME);
    t("git output > cap ⇒ truncated=true (not silently false)", r.ok === true && r.truncated === true && r.bytes.length === SANITIZED_READ_MAX_BYTES);
  }

  // 12. SR2-R2-P2-1: a branch and a TAG with the same name ⇒ HEAD must bind via the FULL ref (not the ambiguous `--short` "heads/main")
  {
    const C = join(root, "collide"); mkdirSync(C, { recursive: true });
    git(C, "init", "-q"); git(C, "config", "user.email", "t@t"); git(C, "config", "user.name", "t");
    writeFileSync(join(C, "f"), "1\n"); git(C, "add", "f"); git(C, "commit", "-qm", "c1-collide");
    try { git(C, "branch", "-M", "main"); } catch { /* already main */ }
    git(C, "tag", "main"); // branch main + tag main now collide
    const rb = await resolveAndReadGit(spec("git branch"), C, HOME);
    t("branch+tag same name ⇒ current '* main' preserved (full ref, not heads/main)", rb.ok === true && /\*\s+main\b/.test(rb.bytes.toString()));
    const rl = await resolveAndReadGit(spec("git log --oneline"), C, HOME);
    t("branch+tag same name ⇒ log works (HEAD not broken)", rl.ok === true && /c1-collide/.test(rl.bytes.toString()));
  }
  // 13. SR2-R2-P2-1: a HEAD probe exit code that is NEITHER 0 nor 1 (a real error, e.g. 128) ⇒ escalate, NOT a guessed detached
  {
    const faultProbe: GitRunner = async (args) => {
      if (args.includes("--absolute-git-dir")) return { code: 0, stdout: Buffer.from("/tmp/ignored\n"), truncated: false };
      if (args.includes("symbolic-ref")) return { code: 2, stdout: Buffer.alloc(0), truncated: false }; // probe ERROR (not detached)
      return { code: 0, stdout: Buffer.alloc(0), truncated: false };
    };
    const r = await resolveAndReadGit(spec("git log --oneline"), repo, HOME, faultProbe);
    t("HEAD probe exit!=0/!=1 ⇒ escalate head-probe-failed", r.ok === false && r.reason === "head-probe-failed");
  }
  // 14. SR2-R2-P2-1: a HEAD WRITEBACK failure ⇒ escalate (the clone HEAD would be wrong), never a silent wrong marker
  {
    const faultWriteback: GitRunner = async (args) => {
      if (args.includes("--absolute-git-dir")) return { code: 0, stdout: Buffer.from("/tmp/ignored\n"), truncated: false };
      if (args.includes("symbolic-ref") && args.includes("-q")) return { code: 0, stdout: Buffer.from("refs/heads/main\n"), truncated: false }; // probe: on a branch
      if (args[0] === "clone") return { code: 0, stdout: Buffer.alloc(0), truncated: false }; // fake clone ok
      if (args.includes("symbolic-ref")) return { code: 2, stdout: Buffer.alloc(0), truncated: false }; // writeback FAILS
      return { code: 0, stdout: Buffer.alloc(0), truncated: false };
    };
    const r = await resolveAndReadGit(spec("git log --oneline"), repo, HOME, faultWriteback);
    t("HEAD writeback failure ⇒ escalate head-writeback-failed", r.ok === false && r.reason === "head-writeback-failed");
  }

  // 15. SR2-R3-P2-1(b): `branch -r` must PRESERVE the `origin/HEAD -> origin/main` arrow (the mirror drops the symref ⇒ replicate it)
  {
    const Up = join(root, "up2"); mkdirSync(Up, { recursive: true });
    git(Up, "init", "-q"); git(Up, "config", "user.email", "t@t"); git(Up, "config", "user.name", "t");
    writeFileSync(join(Up, "f"), "1\n"); git(Up, "add", "f"); git(Up, "commit", "-qm", "u1"); git(Up, "branch", "-M", "main");
    const Clone = join(root, "clone2");
    execFileSync("git", ["clone", "-q", Up, Clone], { stdio: ["ignore", "pipe", "pipe"] }); // a real clone ⇒ origin/HEAD symref present
    git(Clone, "config", "user.email", "t@t"); git(Clone, "config", "user.name", "t");
    const r = await resolveAndReadGit(spec("git branch -r"), Clone, HOME);
    t("branch -r preserves origin/HEAD -> origin/main arrow", r.ok === true && /origin\/HEAD -> origin\/main/.test(r.bytes.toString()));
  }
  // 16. SR2-R3-P2-1(a): a source with a LINKED worktree ⇒ `git branch` escalates (the `+ <branch>` occupancy marker is Phase-3 state)
  {
    const W = join(root, "wtmain"); mkdirSync(W, { recursive: true });
    git(W, "init", "-q"); git(W, "config", "user.email", "t@t"); git(W, "config", "user.name", "t");
    writeFileSync(join(W, "f"), "1\n"); git(W, "add", "f"); git(W, "commit", "-qm", "w1");
    git(W, "worktree", "add", "-q", join(root, "wt-linked"), "-b", "sidebr");
    const r = await resolveAndReadGit(spec("git branch"), W, HOME);
    t("linked worktree ⇒ branch escalates (worktree-occupancy)", r.ok === false && r.reason === "worktree-occupancy");
  }

  // 8. scratch self-cleanup (pins ①②): after all of the above, NO throwaway clone dir is left behind
  {
    let leftover: string[] = [];
    try { leftover = readdirSync(scratchRoot); } catch { leftover = []; } // root may not exist ⇒ nothing leaked
    t("throwaway git scratch dirs are all cleaned up", leftover.length === 0);
  }

  console.log("all sanitized-read-git selftests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
