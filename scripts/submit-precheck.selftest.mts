// CLI integration selftest for submit-precheck (SP-1): against a REAL isolated Git repo, the CLI must losslessly handle a
// C-quoted non-ASCII tracked path, a leading-space UNTRACKED path, and running from a SUBDIRECTORY — none silently missed.
//   npx tsx scripts/submit-precheck.selftest.mts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

let pass = 0;
const t = (n: string, c: boolean): void => { if (!c) { console.error(`FAIL ${n}`); process.exit(1); } pass++; console.log(`ok  ${n}`); };

const here = path.dirname(fileURLToPath(import.meta.url));        // .../scripts
const repoRoot = path.resolve(here, "..");                       // the agenthop worktree root
const cli = path.join(here, "submit-precheck.ts");
const tsx = path.join(repoRoot, "node_modules/.bin/tsx");

const g = mkdtempSync(path.join(tmpdir(), "sp-cli-"));
const git = (args: string[], cwd = g): string => execFileSync("git", args, { cwd, encoding: "utf8" });
try {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]); git(["config", "user.name", "t"]);
  git(["config", "core.quotePath", "true"]); // the default — be explicit that non-ASCII names are C-quoted in diff output
  writeFileSync(path.join(g, "README"), "base\n");
  git(["add", "README"]); git(["commit", "-q", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();

  // changes on top of base: a tracked unicode file + a tracked subdir file (each ONE bare in-place write), + an untracked
  // leading-space file (also a bare write). All three MUST be scanned.
  const BARE = `import { writeFileSync } from "node:fs";\nwriteFileSync(target, data);\n`;
  writeFileSync(path.join(g, "中文.ts"), BARE);
  mkdirSync(path.join(g, "src"));
  writeFileSync(path.join(g, "src", "item.ts"), BARE);
  git(["add", "中文.ts", "src/item.ts"]);
  writeFileSync(path.join(g, " leading.ts"), BARE); // untracked, LEADING SPACE in the name

  const run = (cwd: string) => spawnSync(tsx, [cli, base], { cwd, encoding: "utf8" });

  const root = run(g);
  t("CLI: runs clean from repo root (exit 0)", root.status === 0);
  t("CLI SP-1: a C-quoted unicode TRACKED file is scanned (not silently missed)", /中文\.ts/.test(root.stdout) && /MISS/.test(root.stdout));
  t("CLI SP-1: a leading-space UNTRACKED file is scanned (NUL-split, not trimmed away)", /leading\.ts/.test(root.stdout));
  t("CLI: the tracked subdir file is found from root", /src\/item\.ts/.test(root.stdout));

  const sub = run(path.join(g, "src"));
  t("CLI SP-1: running from a SUBDIRECTORY still scans repo-root files (not a silent zero diff-set)", sub.status === 0 && /src\/item\.ts/.test(sub.stdout) && /中文\.ts/.test(sub.stdout));
} finally {
  rmSync(g, { recursive: true, force: true });
}
console.log(`\nall submit-precheck CLI selftests passed (${pass})`);
