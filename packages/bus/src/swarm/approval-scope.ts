/**
 * approval-scope — the IO resolver that turns a member's command + cwd into the verified `ApprovalScope` facts the pure
 * classifier consumes (approval-delegation.ts). This is the dormant IO seam's filesystem half: it runs in the MEMBER's
 * environment (the sync permission-gate hook), realpaths every path operand following symlinks to the end, tests containment
 * in realpath(cwd), and credential-classifies the resolved target. The coordinator then trusts these facts (it has no access
 * to the member's filesystem) and runs classifyApproval — the trust boundary is deliberate: delegation only auto-ALLOWS what
 * the member could already do after one user click, so the hook (our own code, same trust domain as the member) is the only
 * place that CAN resolve scope, and a forged fact buys nothing a user click would not have granted.
 *
 * Mirrors the review harness's `scopeFor` exactly (the canonical resolution the adversarial suite pinned). Fail-soft per path:
 * an unresolvable operand (missing file, broken symlink, EACCES) ⇒ resolvedWithinCwd:false ⇒ the classifier escalates it.
 */
import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { planDelegation, isSensitivePath, isGitEnvClean, type ApprovalScope } from "./approval-delegation.js";

/** git-recall: is `anchor` (a realpath'd dir) the git repo ROOT? `git rev-parse --show-toplevel` realpath-compared to anchor.
 *  Called ONLY after gitEnvClean is confirmed (a dirty env — e.g. GIT_DIR — could otherwise mislead rev-parse). Fail-soft. */
function gitRootIsCwd(anchor: string): boolean {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: anchor, encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || typeof r.stdout !== "string" || !r.stdout.trim()) return false;
    return realpathSync(r.stdout.trim()) === anchor;
  } catch { return false; }
}

/**
 * Resolve IO-verified scope facts for `command` in `cwd`. Returns null when cwd is not a trustworthy absolute, existing
 * directory (⇒ the caller escalates — no anchor to contain against). Only a `scope-paths` plan resolves operands; a scope-free
 * or escalate plan yields `{ cwdVerified, resolvedPaths: [] }` (the classifier decides from the plan alone). Pure except for
 * the realpath/stat reads it is defined to perform.
 */
export function resolveApprovalScope(command: string, cwd: string): ApprovalScope | null {
  if (!cwd || !cwd.startsWith("/")) return null;          // an absolute cwd is the containment anchor (AD-P1-3)
  let anchor: string;
  try {
    anchor = realpathSync(cwd);
    if (!statSync(anchor).isDirectory()) return null;
  } catch {
    return null;                                           // cwd does not resolve to a real directory ⇒ no anchor ⇒ escalate
  }
  const scope: ApprovalScope = { cwdVerified: true, resolvedPaths: [] };
  const plan = planDelegation(command);
  if (plan.gate === "scope-paths") {
    for (const raw of plan.pathArgs) {
      let resolved: string | null = null;
      try { resolved = realpathSync(path.resolve(anchor, raw)); } catch { resolved = null; }
      const resolvedWithinCwd = resolved !== null && (resolved === anchor || resolved.startsWith(anchor + path.sep));
      const resolvedSensitive = resolved !== null && isSensitivePath(resolved);
      scope.resolvedPaths.push({ raw, resolvedWithinCwd, resolvedSensitive });
    }
  } else if (plan.gate === "scope-git") {
    // git-recall (Hole 2 then scope): verify the member env is clean FIRST; only probe the repo root with a clean env.
    scope.gitEnvClean = isGitEnvClean(process.env);
    scope.cwdIsGitRoot = scope.gitEnvClean ? gitRootIsCwd(anchor) : false;
  }
  return scope;
}
