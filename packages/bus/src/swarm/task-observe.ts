/**
 * task-observe — the O1 WORK-branch observation logic (brain §4.2), extracted from scripts/swarm-dispatch.ts so it can
 * be exercised against REAL git in tests. All git IO goes through an injected GitRun, so a temp-repo integration test
 * catches arg-position / three-state bugs that the pure-layer unit tests can't (the --literal-pathspecs placement bug
 * that broke every validation slipped exactly because this ran only under the live dispatcher). The dispatcher binds
 * GitRun to its bounded `git()` + scratch dir; the logic here is identical.
 */

import { isForeignResult, requiredFilesPresent, type GitFacts, type ResultIdentity } from "./task-pass.js";

/** A bounded git runner: args + optional cwd ⇒ {code, stdout, stderr}. cwd omitted ⇒ runs against the remote (ls-remote). */
export type GitRun = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export type ObserveInput = {
  git: GitRun;
  /** The WORK repo (git URL / path) for ls-remote + fetch. */
  workRepo: string;
  /** An EXISTING scratch dir the caller created (a bare repo is init'd into it, idempotent). */
  scratch: string;
  branch: string;
  /** out/results/<attemptId>/result.json — the per-attempt path. */
  resultPath: string;
  /** This binding's expected identity (all four fields) for the foreign-result filter. */
  identity: ResultIdentity;
  /** T1: an empty acceptance list passes; a non-empty one is refused at dispatch (so this is true for dispatched nodes). */
  acceptanceEmpty: boolean;
};

export async function observeResultOnBranch(i: ObserveInput): Promise<GitFacts | null> {
  const { git, workRepo, scratch, branch, resultPath } = i;
  const ls = await git(["ls-remote", workRepo, `refs/heads/${branch}`]);
  if (ls.code !== 0) return null;
  const tip = ls.stdout.split(/\s+/)[0]?.trim();
  if (!tip) return null;
  await git(["init", "-q", "--bare"], scratch); // idempotent on an existing bare repo
  let fetched = await git(["fetch", "-q", workRepo, tip], scratch);
  if (fetched.code !== 0) fetched = await git(["fetch", "-q", workRepo, `refs/heads/${branch}:refs/heads/${branch}`], scratch);
  if (fetched.code !== 0) return null;

  // Complete first-parent scan of the fixed tip (no depth cap — only the persistent cursor is T2). Take the newest commit
  // carrying a result for THIS binding; skip confirmed-foreign candidates; surface an unparseable one to V1.
  const rl = await git(["rev-list", "--first-parent", tip], scratch);
  if (rl.code !== 0) return null;
  let sha = "", resultText = "", resultBlobOid = "";
  for (const c of rl.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const show = await git(["show", `${c}:${resultPath}`], scratch);
    if (show.code !== 0) continue;
    if (isForeignResult(show.stdout, i.identity)) continue;
    const rev = await git(["rev-parse", `${c}:${resultPath}`], scratch);
    sha = c; resultText = show.stdout; resultBlobOid = rev.code === 0 ? rev.stdout.trim() : "";
    break;
  }
  if (!sha) return null;

  let outputs: Array<{ path?: unknown }> = [];
  let evidence: Array<{ summaryPath?: unknown }> = [];
  try {
    const r = JSON.parse(resultText) as { outputs?: unknown; validationEvidence?: unknown };
    if (Array.isArray(r.outputs)) outputs = r.outputs as Array<{ path?: unknown }>;
    if (Array.isArray(r.validationEvidence)) evidence = r.validationEvidence as Array<{ summaryPath?: unknown }>;
  } catch { /* V1 rejects the unparseable result */ }

  const closureFiles: Array<{ path: string; blobOid: string }> = [];
  let incomplete = false;
  const resolveFile = async (p: string): Promise<void> => {
    const t = await git(["--literal-pathspecs", "ls-tree", sha, "--", p], scratch); // global opt BEFORE the subcommand
    if (t.code !== 0) { incomplete = true; return; }        // query error ⇒ unknown
    const lines = t.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;                         // cleanly absent ⇒ missing
    const m = /^\d+\s+blob\s+(\S+)\t(.+)$/.exec(lines[0]!);
    if (lines.length === 1 && m && m[2] === p) { closureFiles.push({ path: p, blobOid: m[1]! }); return; } // exact file
    const rp = await git(["rev-parse", `${sha}:${p}`], scratch); // directory ⇒ its content-addressed tree oid
    if (rp.code !== 0) { incomplete = true; return; }
    closureFiles.push({ path: p, blobOid: rp.stdout.trim() });
  };
  for (const o of outputs) if (o && typeof o.path === "string") await resolveFile(o.path);
  for (const e of evidence) if (e && typeof e.summaryPath === "string") await resolveFile(e.summaryPath);
  if (incomplete) return null; // a declared-file query errored ⇒ unknown, re-read next pass (not a business fail)

  const dt = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], scratch);
  const cumulativeChangedPaths = dt.code === 0 ? dt.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  return {
    observedWorkCommit: sha, resultText, resultBlobOid, closureFiles, cumulativeChangedPaths,
    contract: { requiredOutputsPresent: requiredFilesPresent(outputs, evidence, closureFiles), patchAppliesClean: true },
    acceptancePassed: i.acceptanceEmpty,
    withinCutoffAncestry: true,
  };
}
