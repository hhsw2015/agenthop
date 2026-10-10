// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/approval-scope.integration.selftest.mts
// Integration test (real filesystem, temp fixtures) for resolveApprovalScope — the IO half of approval-delegation: it realpaths
// each operand, tests cwd containment following symlinks, and credential-classifies the resolved target. Also exercises the
// end-to-end resolve→classify path so a symlink-escape / symlink-to-.env is proven to escalate, and a clean local read delegates.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveApprovalScope } from "./approval-scope.js";
import { classifyApproval, type ApprovalRequest } from "./approval-delegation.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const roots: string[] = [];
function fixture() { const root = fs.mkdtempSync("/tmp/approval-scope-selftest-"); roots.push(root); const cwd = path.join(root, "work"); fs.mkdirSync(cwd); return { root, cwd }; }
const verdict = (command: string, cwd: string) => {
  const scope = resolveApprovalScope(command, cwd);
  const req: ApprovalRequest = { member: "m", tool: "Bash", command, cwd, promptId: "p", nowSec: 1, ...(scope ? { scope } : {}) };
  return classifyApproval(req);
};
const isDelegate = (v: ReturnType<typeof classifyApproval>) => v.kind === "delegate";
const isEscalate = (v: ReturnType<typeof classifyApproval>) => v.kind === "escalate";

try {
  // cwd anchor validation
  t("relative cwd -> null", resolveApprovalScope("cat x", "rel/dir") === null);
  t("nonexistent cwd -> null", resolveApprovalScope("cat x", "/no/such/dir/xyzzy") === null);

  // clean local read: realpath within cwd, not sensitive -> delegate
  { const f = fixture(); fs.writeFileSync(path.join(f.cwd, "note.txt"), "LOCAL\n");
    const s = resolveApprovalScope("cat note.txt", f.cwd)!;
    t("clean file resolvedWithinCwd", s.resolvedPaths.length === 1 && s.resolvedPaths[0].resolvedWithinCwd === true && s.resolvedPaths[0].resolvedSensitive === false);
    t("clean file -> delegate (e2e)", isDelegate(verdict("cat note.txt", f.cwd))); }

  // symlink escaping cwd -> resolvedWithinCwd false -> escalate
  { const f = fixture(); fs.writeFileSync(path.join(f.root, "outside.txt"), "OUT\n"); fs.symlinkSync("../outside.txt", path.join(f.cwd, "alias.txt"));
    const s = resolveApprovalScope("cat alias.txt", f.cwd)!;
    t("escaping symlink resolvedWithinCwd=false", s.resolvedPaths[0].resolvedWithinCwd === false);
    t("escaping symlink -> escalate (e2e)", isEscalate(verdict("cat alias.txt", f.cwd))); }

  // in-cwd symlink to a credential -> resolvedSensitive true -> escalate (within-cwd is NOT credential-safe)
  { const f = fixture(); fs.writeFileSync(path.join(f.cwd, ".env"), "SECRET\n"); fs.symlinkSync(".env", path.join(f.cwd, "alias.txt"));
    const s = resolveApprovalScope("cat alias.txt", f.cwd)!;
    t("alias->.env resolvedWithinCwd=true & resolvedSensitive=true", s.resolvedPaths[0].resolvedWithinCwd === true && s.resolvedPaths[0].resolvedSensitive === true);
    t("alias->.env -> escalate (e2e)", isEscalate(verdict("cat alias.txt", f.cwd))); }

  // missing operand file (realpath fails) -> resolvedWithinCwd false -> escalate
  { const f = fixture();
    const s = resolveApprovalScope("cat ghost.txt", f.cwd)!;
    t("missing file resolvedWithinCwd=false (resolve failed)", s.resolvedPaths[0].resolvedWithinCwd === false);
    t("missing file -> escalate (e2e)", isEscalate(verdict("cat ghost.txt", f.cwd))); }

  // scope-free form: no operands resolved, delegates with just cwdVerified
  { const f = fixture();
    const s = resolveApprovalScope("pwd", f.cwd)!;
    t("pwd scope-free: empty resolvedPaths, cwdVerified", s.cwdVerified === true && s.resolvedPaths.length === 0);
    t("pwd -> delegate (e2e)", isDelegate(verdict("pwd", f.cwd))); }

  // ls listing cwd (no operand) -> delegate
  { const f = fixture(); fs.writeFileSync(path.join(f.cwd, "a.txt"), "x\n");
    t("ls (no operand) -> delegate (e2e)", isDelegate(verdict("ls", f.cwd))); }

  // git-recall (real git fixtures). Control the env so gitEnvClean is deterministic: snapshot + clear every GIT_ var and the
  // explicit non-GIT_ vectors for the duration, then restore.
  {
    const snapshot: Record<string, string | undefined> = {};
    const toClear = [...Object.keys(process.env).filter((k) => k.startsWith("GIT_")), "PAGER", "EDITOR", "SSH_ASKPASS", "XDG_CONFIG_HOME"];
    for (const k of toClear) { snapshot[k] = process.env[k]; delete process.env[k]; }
    try {
      // a real git repo at cwd, clean env -> cwdIsGitRoot true, gitEnvClean true -> delegate a non-content form with a rewrite
      const f = fixture();
      const init = spawnSync("git", ["init", "-q"], { cwd: f.cwd, encoding: "utf8" });
      if (init.status === 0) {
        const s = resolveApprovalScope("git status -s", f.cwd)!;
        t("git repo root + clean env: cwdIsGitRoot=true, gitEnvClean=true", s.cwdIsGitRoot === true && s.gitEnvClean === true);
        const v = verdict("git status -s", f.cwd);
        t("git non-content form at root + clean env -> delegate", v.kind === "delegate");
        t("git delegate carries the config-immune rewrite", v.kind === "delegate" && typeof v.rewrite === "string" && v.rewrite.startsWith("git --no-pager -c diff.external="));
        // a subdirectory of the repo is NOT the repo root -> escalate
        const sub = path.join(f.cwd, "subdir"); fs.mkdirSync(sub);
        t("git in a repo SUBDIR (not root) -> escalate", isEscalate(verdict("git status -s", sub)));
        // bare content form even at root -> escalate (Hole 3)
        t("bare git diff (content) at root -> escalate", isEscalate(verdict("git diff", f.cwd)));
      } else {
        console.log("ok  (git not available — skipped real-repo git-recall cases)");
      }
      // not a git repo -> cwdIsGitRoot false -> escalate
      const f2 = fixture();
      t("git status in a non-repo dir -> escalate", isEscalate(verdict("git status -s", f2.cwd)));
      // a dirty env (GIT_DIR set) -> gitEnvClean false -> escalate even in a real repo
      const f3 = fixture();
      if (spawnSync("git", ["init", "-q"], { cwd: f3.cwd }).status === 0) {
        process.env.GIT_DIR = ".git";
        try {
          const s3 = resolveApprovalScope("git status -s", f3.cwd)!;
          t("dirty env (GIT_DIR): gitEnvClean=false, cwdIsGitRoot=false (not probed)", s3.gitEnvClean === false && s3.cwdIsGitRoot === false);
          t("git form with a dirty env -> escalate", isEscalate(verdict("git status -s", f3.cwd)));
        } finally { delete process.env.GIT_DIR; }
      }
    } finally {
      for (const k of toClear) { if (snapshot[k] === undefined) delete process.env[k]; else process.env[k] = snapshot[k]; }
    }
  }

  console.log("all approval-scope integration selftests passed");
} finally {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
}
