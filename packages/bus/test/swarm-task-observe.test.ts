import { describe, expect, test, beforeEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { observeResultOnBranch, type GitRun } from "../src/swarm/task-observe.js";

/**
 * REAL-git coverage for O1 observation (the gap that let the --literal-pathspecs arg-position bug through: the pure unit
 * tests never ran git, so a command that git rejects looked fine). These drive observeResultOnBranch against a temp repo
 * with a real git runner, so arg placement + the ls-tree three-state + the first-parent scan are exercised for real.
 */

const gitRun: GitRun = async (args, cwd) => {
  const r = spawnSync("git", args, cwd ? { cwd, encoding: "utf8" } : { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const BRANCH = "swarm/rw-1-g0";
const RESULT_PATH = "out/results/job/build/a0/result.json";
const IDENT = { jobId: "job", nodeId: "build", attemptId: "job/build/a0", assignmentId: "as0" };

let repo: string, scratch: string;
const sh = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const commit = (msg: string): string => { sh("add", "-A"); sh("commit", "-q", "-m", msg); return sh("rev-parse", "HEAD").trim(); };
function writeValidResult(): void {
  mkdirSync(path.join(repo, "out/results/job/build/a0"), { recursive: true });
  writeFileSync(path.join(repo, RESULT_PATH), JSON.stringify({
    schemaVersion: 1, jobId: "job", planRevision: 1, nodeId: "build", attemptId: "job/build/a0", assignmentId: "as0",
    inputBindingDigest: "ibd", outcome: "success",
    outputs: [{ logicalName: "r", kind: "report", path: "out/report.md" }],
    validationEvidence: [{ check: "c", summaryPath: "out/evidence.txt" }],
  }));
  writeFileSync(path.join(repo, "out/report.md"), "report");
  writeFileSync(path.join(repo, "out/evidence.txt"), "evidence");
}
const observe = () => observeResultOnBranch({ git: gitRun, workRepo: repo, scratch, branch: BRANCH, resultPath: RESULT_PATH, identity: IDENT, acceptanceEmpty: true });

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "ah-obs-"));
  repo = path.join(base, "work"); scratch = path.join(base, "scratch");
  mkdirSync(repo, { recursive: true }); mkdirSync(scratch, { recursive: true });
  sh("init", "-q", "-b", BRANCH); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
});

describe("observeResultOnBranch (real git)", () => {
  test("happy path: valid result + declared files ⇒ full GitFacts (would be null under the ls-tree arg bug)", async () => {
    writeValidResult(); commit("r");
    const f = await observe();
    expect(f).not.toBeNull();
    expect(f!.contract.requiredOutputsPresent).toBe(true); // every declared file resolved — the arg bug made this false/null
    expect(f!.closureFiles.map((c) => c.path).sort()).toEqual(["out/evidence.txt", "out/report.md"]);
    expect(f!.resultBlobOid).toMatch(/^[0-9a-f]{40}$/);
    expect(f!.acceptancePassed).toBe(true);
  });

  test("result removed from the tip is found at its ancestor (F6 complete first-parent scan)", async () => {
    writeValidResult(); const withResult = commit("has-result");
    rmSync(path.join(repo, RESULT_PATH)); commit("remove-result");
    const f = await observe();
    expect(f!.observedWorkCommit).toBe(withResult);
  });

  test("a declared evidence file missing ⇒ requiredOutputsPresent false (P2-6, real absence)", async () => {
    writeValidResult(); rmSync(path.join(repo, "out/evidence.txt")); commit("no-evidence");
    const f = await observe();
    expect(f).not.toBeNull();
    expect(f!.contract.requiredOutputsPresent).toBe(false);
  });

  test("a foreign result (wrong assignmentId) at the tip is skipped; the valid ancestor is found (P1-3)", async () => {
    writeValidResult(); const valid = commit("valid");
    writeFileSync(path.join(repo, RESULT_PATH), JSON.stringify({ schemaVersion: 1, jobId: "job", planRevision: 1, nodeId: "build", attemptId: "job/build/a0", assignmentId: "OTHER", inputBindingDigest: "ibd", outcome: "success", outputs: [], validationEvidence: [] }));
    commit("foreign-tip");
    const f = await observe();
    expect(f!.observedWorkCommit).toBe(valid);
  });

  test("no result.json anywhere ⇒ null (no candidate yet)", async () => {
    writeFileSync(path.join(repo, "readme"), "x"); commit("empty");
    expect(await observe()).toBeNull();
  });

  // ---- coverage follow-up (reviewer): fold the passed probes into formal regression ----

  test("a result >200 commits deep is still found — guards against re-adding an -n depth cap", async () => {
    writeValidResult(); const deep = commit("deep-result");
    rmSync(path.join(repo, RESULT_PATH)); commit("remove");
    for (let i = 0; i < 205; i++) execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `e${i}`], { cwd: repo });
    const f = await observe();
    expect(f!.observedWorkCommit).toBe(deep); // walked past 206 commits to the ancestor (no cap)
  }, 30_000); // inherently ~400 git spawns (205 setup + full-history scan); generous timeout for the real-depth guard

  test("a declared path with pathspec magic is treated literally (guards the --literal-pathspecs fix)", async () => {
    // result declares an output whose literal name contains magic — it does NOT exist as a literal file, so it must read
    // as absent (not magic-match a different real file).
    mkdirSync(path.join(repo, "out/results/job/build/a0"), { recursive: true });
    writeFileSync(path.join(repo, RESULT_PATH), JSON.stringify({ schemaVersion: 1, jobId: "job", planRevision: 1, nodeId: "build", attemptId: "job/build/a0", assignmentId: "as0", inputBindingDigest: "ibd", outcome: "success", outputs: [{ logicalName: "r", kind: "report", path: ":(literal)out/report.md" }], validationEvidence: [] }));
    writeFileSync(path.join(repo, "out/report.md"), "report"); // the REAL file exists, but the declared literal name does not
    commit("magic-path");
    const f = await observe();
    expect(f).not.toBeNull();
    expect(f!.contract.requiredOutputsPresent).toBe(false); // literal declared path absent ⇒ not magic-matched to out/report.md
  });

  test("a git query error on a declared file ⇒ null (incomplete), never a business-fail (P2-3)", async () => {
    writeValidResult(); commit("r");
    // inject an ls-tree error for the evidence file only; everything else runs real git.
    const flaky: GitRun = async (args, cwd) => (args[0] === "--literal-pathspecs" && args.includes("out/evidence.txt")) ? { code: 128, stdout: "", stderr: "boom" } : gitRun(args, cwd);
    const f = await observeResultOnBranch({ git: flaky, workRepo: repo, scratch, branch: BRANCH, resultPath: RESULT_PATH, identity: IDENT, acceptanceEmpty: true });
    expect(f).toBeNull(); // incomplete observation ⇒ re-read next pass, not a fabricated reject
  });
});
