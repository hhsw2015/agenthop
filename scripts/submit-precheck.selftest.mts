// CLI integration selftest for submit-precheck (SP-1): against REAL isolated Git repos, the CLI must losslessly handle C-quoted /
// literal-Unicode / spaced / leading-space paths, enumerate from the repo root (not the caller's cwd), and read the right files.
//   npx tsx scripts/submit-precheck.selftest.mts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

let pass = 0;
const t = (n: string, c: boolean): void => { if (!c) { console.error(`FAIL ${n}`); process.exit(1); } pass++; console.log(`ok  ${n}`); };

const here = path.dirname(fileURLToPath(import.meta.url));
const repoScriptsRoot = path.resolve(here, "..");
const cli = path.join(here, "submit-precheck.ts");
const tsx = path.join(repoScriptsRoot, "node_modules/.bin/tsx");
const BARE = `import { writeFileSync } from "node:fs";\nwriteFileSync(target, data);\n`;

const repos: string[] = [];
function mkRepo(quotePath: boolean): { dir: string; base: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "sp-cli-"));
  repos.push(dir);
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]); git(["config", "user.name", "t"]);
  git(["config", "core.quotePath", quotePath ? "true" : "false"]);
  writeFileSync(path.join(dir, "README"), "base\n");
  git(["add", "README"]); git(["commit", "-q", "-m", "base"]);
  return { dir, base: git(["rev-parse", "HEAD"]).trim() };
}
const run = (cwd: string, base: string) => spawnSync(tsx, [cli, base], { cwd, encoding: "utf8" });

try {
  // ── Scenario 1 (quotePath=true): a C-quoted unicode tracked file, a leading-space UNTRACKED file, a tracked subdir file ──
  {
    const { dir, base } = mkRepo(true);
    const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    writeFileSync(path.join(dir, "中文.ts"), BARE);
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "item.ts"), BARE);
    git(["add", "中文.ts", "src/item.ts"]);
    writeFileSync(path.join(dir, " leading.ts"), BARE); // untracked, leading space
    const root = run(dir, base);
    t("S1: runs clean from repo root (exit 0)", root.status === 0);
    t("S1 SP-1: a C-quoted unicode tracked file is scanned", /中文\.ts/.test(root.stdout) && /MISS/.test(root.stdout));
    t("S1 SP-1: a leading-space UNTRACKED file is scanned (NUL-split, not trimmed)", /leading\.ts/.test(root.stdout));
  }

  // ── Scenario 2 (SP-1 subdir coordinate): UNTRACKED files in root AND in a subdir; run FROM the subdir ⇒ both must be found ──
  {
    const { dir, base } = mkRepo(true);
    writeFileSync(path.join(dir, "root-new.ts"), BARE);       // untracked, repo root
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "sub-new.ts"), BARE); // untracked, subdir
    const sub = run(path.join(dir, "src"), base);
    t("S2 SP-1: from a subdirectory, the ROOT untracked file is still enumerated (ls-files from repo root)", sub.status === 0 && /root-new\.ts/.test(sub.stdout));
    t("S2 SP-1: from a subdirectory, the subdir untracked file is found at its repo-root path", /src\/sub-new\.ts/.test(sub.stdout));
  }

  // ── Scenario 3 (SP-1 quotePath=false mixed literal-Unicode + C-escape): literal UTF-8 must survive (no low-byte truncation) ──
  {
    const { dir, base } = mkRepo(false);
    const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const mixed = '中文"q.ts'; // literal Unicode + a double-quote ⇒ Git still C-quotes it, but keeps the Unicode literal
    writeFileSync(path.join(dir, mixed), BARE);
    git(["add", mixed]);
    const root = run(dir, base);
    t("S3 SP-1: a quotePath=false mixed literal-Unicode+quote tracked file is scanned (no charCode&0xff truncation)", root.status === 0 && /中文"q\.ts/.test(root.stdout) && /MISS/.test(root.stdout));
  }

  // ── Scenario 4 (SP-1 header TAB): a tracked name WITH A SPACE gets a trailing TAB in the Git +++ header; must not corrupt it ──
  {
    const { dir, base } = mkRepo(true);
    const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    writeFileSync(path.join(dir, "with space.ts"), BARE);
    git(["add", "with space.ts"]);
    const root = run(dir, base);
    t("S4 SP-1: a tracked spaced name (header TAB) is scanned, space preserved", root.status === 0 && /with space\.ts/.test(root.stdout) && /MISS/.test(root.stdout));
  }
} finally {
  for (const d of repos) rmSync(d, { recursive: true, force: true });
}
console.log(`\nall submit-precheck CLI selftests passed (${pass})`);
