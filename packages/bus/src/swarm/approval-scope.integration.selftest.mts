// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/approval-scope.integration.selftest.mts
// Integration test (real filesystem, temp fixtures) for resolveApprovalScope — the IO half of approval-delegation: it realpaths
// each operand, tests cwd containment following symlinks, and credential-classifies the resolved target. Also exercises the
// end-to-end resolve→classify path so a symlink-escape / symlink-to-.env is proven to escalate, and a clean local read delegates.
import fs from "node:fs";
import path from "node:path";
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

  // git is out of v0: resolver returns a scope but classify escalates regardless
  { const f = fixture();
    t("git status -> escalate (e2e, git out of v0)", isEscalate(verdict("git status", f.cwd))); }

  console.log("all approval-scope integration selftests passed");
} finally {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
}
