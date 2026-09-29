import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpHints, opencodePluginPath, registerMcp, writeOpencodePlugin } from "./agents.js";
import { chosenLang, lang, setLang, t, type Lang } from "./lang.js";
import { skillMarkdown, skillMarkdownZh } from "./skill-text.js";

const windows = platform() === "win32";

export type InstallOptions = {
  /** Directories that should contain SKILL.md. The caller names its own skill folder. */
  skillDirs?: string[];
  /** Only rewrite SKILL.md. `update` uses this to refresh the skill with the new program. */
  skillOnly?: boolean;
  /** Agents to register agenthop with as an MCP server. Without this it only says how. */
  mcp?: string[];
  /** The language to speak from now on. Kept in install.json, and the skill is written in it. */
  lang?: Lang;
};

/** Copy this program onto PATH and write the skill. No repository and no package install. */
export function installAgenthop(options: InstallOptions = {}): void {
  if (options.lang) setLang(options.lang);
  const dirs = rememberSkillDirs(options.skillDirs ?? [], homedir(), options.lang);
  const command = options.skillOnly ? "" : installCommand();
  const skills = writeSkillFiles(dirs);
  if (command) console.log(command);
  for (const skill of skills) console.log(skill);
  console.log(languageNote());
  // Keep an already-installed OpenCode plugin current on every install/update (update runs
  // `install --skill-only`). First-time setup stays explicit via `install --mcp opencode`, so a
  // machine that never opted in is left untouched. Isolate any failure here: this optional refresh
  // must never abort the install or block the explicit --mcp registrations that follow.
  if (!options.mcp?.includes("opencode") && existsSync(opencodePluginPath())) {
    try {
      console.log(`OpenCode${t(": ", "：")}${writeOpencodePlugin()}`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.log(t(`OpenCode: could not refresh the bus plugin (${why})`, `OpenCode：刷新总线插件失败（${why}）`));
    }
  }
  if (!command) return;
  if (options.mcp?.length) {
    for (const line of registerMcp(options.mcp, command)) console.log(line);
    return;
  }
  console.log(t("\nAdd agenthop as an MCP server and the agent can use its tools directly, with nothing to write into a process's standard input:", "\n接入 MCP，agent 就能直接用 agenthop 的工具，不用往进程的标准输入里写字："));
  for (const line of mcpHints(command)) console.log(line);
  console.log(t("  Or have it written for you: agenthop install --mcp <claude|grok|codex|cursor|gemini|opencode>", "  或者让它替你写：agenthop install --mcp <claude|grok|codex|cursor|gemini|opencode>"));
}

/**
 * Which language this is, and how to change it. Until someone chooses, it is said in both:
 * everything before English spoke Chinese, and `update` — which runs `install --skill-only` and
 * prints what it says — is where someone used to that finds out.
 */
function languageNote(): string {
  if (chosenLang()) return t("Language: English (agenthop install --lang zh switches to Chinese)", "语言：中文（agenthop install --lang en 改回英文）");
  return "Language: English. 要用中文：agenthop install --lang zh";
}

/**
 * Where SKILL.md goes. Directories named on the command line are added to the ones a previous
 * install recorded, so `update` can refresh every copy without being told again. The language is
 * kept beside them, and so is anything else already in the file.
 */
export function rememberSkillDirs(named: string[], home = homedir(), chosen?: Lang): string[] {
  // A directory that is gone was removed on purpose. Refreshing the skill must not bring it back.
  const dirs = new Set(readSkillDirs(home).filter(isDirectory));
  for (const dir of named) {
    if (!dir.trim()) throw new Error("usage: agenthop install [--skill-dir DIR]");
    dirs.add(resolve(dir));
  }
  const kept = [...dirs];
  const file = join(home, ".agenthop", "install.json");
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify({ ...readInstall(home), skillDirs: kept, ...(chosen ? { lang: chosen } : {}) }, null, 2)}\n`);
  return kept;
}

function readInstall(home: string): Record<string, unknown> {
  try {
    const body = JSON.parse(readFileSync(join(home, ".agenthop", "install.json"), "utf8")) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readSkillDirs(home = homedir()): string[] {
  try {
    const body = JSON.parse(readFileSync(join(home, ".agenthop", "install.json"), "utf8")) as { skillDirs?: unknown };
    if (!Array.isArray(body.skillDirs)) return [];
    return body.skillDirs.filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0);
  } catch {
    return [];
  }
}

/** Write SKILL.md under the home directory and into each directory the caller provides. */
export function writeSkillFiles(skillDirs: string[], home = homedir()): string[] {
  const files = [join(home, ".agenthop", "SKILL.md")];
  for (const dir of skillDirs) {
    if (!dir.trim()) throw new Error("usage: agenthop install [--skill-dir DIR]");
    files.push(join(resolve(dir), "SKILL.md"));
  }
  for (const file of files) {
    ensureDir(dirname(file));
    writeFileSync(file, lang() === "zh" ? skillMarkdownZh : skillMarkdown);
  }
  return files;
}

export type CommandSource = { dev: boolean; source: string };

/**
 * The released program is a single executable and installs by copying itself. Run from a source
 * checkout the executable is Node itself, so what belongs on PATH is the launcher, never `node`.
 */
export function commandSource(execPath: string = process.execPath): CommandSource {
  if (!isNodeBinary(execPath)) return { dev: false, source: execPath };
  return { dev: true, source: fileURLToPath(new URL("../bin/agenthop.mjs", import.meta.url)) };
}

function installCommand(): string {
  const { dev, source } = commandSource();
  if (windows) {
    const destDir = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agenthop");
    ensureDir(destDir);
    const dest = join(destDir, "agenthop.exe");
    if (!dev) placeCommand(source, dest);
    else writeFileSync(join(destDir, "agenthop.cmd"), `@echo off\r\n"${process.execPath}" "${source}" %*\r\n`);
    ensureWindowsPath(destDir);
    return dev ? join(destDir, "agenthop.cmd") : dest;
  }
  const destDir = join(homedir(), ".local", "bin");
  ensureDir(destDir);
  const dest = join(destDir, "agenthop");
  if (dev) {
    chmodSync(source, 0o755);
    if (!sameFile(dest, source)) {
      rmSync(dest, { force: true });
      symlinkSync(source, dest);
    }
  } else {
    placeCommand(source, dest);
  }
  ensureUnixPath(destDir);
  return dest;
}

/**
 * Put the program at `dest`. Installing from the installed copy has nothing to copy: the two
 * paths can be spelled differently and still be one file, and copying a file onto itself
 * deletes it. Everything else is copied beside the target and renamed into place, so a copy
 * that fails cannot leave the machine without a program.
 */
export function placeCommand(source: string, dest: string): void {
  if (isSameFile(source, dest)) {
    try {
      chmodSync(dest, 0o755);
    } catch {
      // Windows may refuse the mode. The program is already in place either way.
    }
    return;
  }
  const staged = `${dest}.new`;
  rmSync(staged, { force: true });
  copyFileSync(source, staged);
  try {
    chmodSync(staged, 0o755);
  } catch {
    // Windows may refuse the mode. The file is still the program.
  }
  renameSync(staged, dest);
}

/** Two names for one file: a symlinked home, a hard link, or simply the same path. */
export function isSameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.ino === right.ino && left.dev === right.dev;
  } catch {
    return resolve(a) === resolve(b);
  }
}

export function ensureDir(dir: string): void {
  const absolute = resolve(dir);
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isNodeBinary(file: string): boolean {
  const name = file.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return name === "node" || name === "node.exe";
}

function sameFile(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === resolve(target);
  } catch {
    return false;
  }
}

function ensureUnixPath(dir: string): void {
  if (onPath(dir)) return;
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  const shell = process.env.SHELL ?? "";
  const files = [join(homedir(), ".profile"), join(homedir(), shell.includes("zsh") ? ".zshrc" : ".bashrc")];
  for (const file of files) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = "";
    }
    if (!current.includes(".local/bin")) writeFileSync(file, `${current.replace(/\s*$/, "")}\n${line}\n`);
  }
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

function ensureWindowsPath(dir: string): void {
  if (onPath(dir)) return;
  const command = `
    $dir = '${dir.replaceAll("'", "''")}'
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $user) { $user = '' }
    $parts = @($user -split ';' | Where-Object { $_ -ne '' })
    if ($parts -notcontains $dir) {
      $updated = $(if ($user) { "$user;$dir" } else { $dir })
      [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    }
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("could not update the user PATH");
  process.env.Path = `${dir}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
}

function onPath(dir: string): boolean {
  return (process.env.PATH ?? process.env.Path ?? "").split(delimiter).some((entry) => entry && resolve(entry) === resolve(dir));
}
