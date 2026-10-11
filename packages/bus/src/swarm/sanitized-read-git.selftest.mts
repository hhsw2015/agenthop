// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/sanitized-read-git.selftest.mts
// Pins the COORDINATOR-side HARDENED git read against REAL git fixtures (the security IS the real --mirror-clone behavior):
// log/show/diff/branch produce committed-history output; the ADVERSARIAL planted-exec-vector test (coordinator pin: four exec
// vectors in the member's .git/config must fire ZERO times across probe+clone+read); non-content (--stat never leaks file content);
// operand rev-validation (a non-rev ⇒ bad-rev, never a pathspec/blob); not-a-git-repo; and scratch self-cleanup (pins ①②).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndReadGit } from "./sanitized-read-git.js";
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
