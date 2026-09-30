import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { omniwmctlBin, omniwmReady, runOmniwmctl } from "./wm.js";

/**
 * Launch a chosen agent CLI in a VISIBLE Ghostty window and (best effort) arrange it via OmniWM, so a
 * bus session can dispatch sub-agents the user can watch. macOS + Ghostty.
 *
 * Backend: Ghostty's AppleScript scripting (`new window with configuration`). Unlike `open -na` it makes
 * exactly ONE window in the running instance, applies a command + working directory + injected env, and
 * returns a stable window id. The launched window is a normal Ghostty window OmniWM tiles; to move it to
 * a specific workspace we diff OmniWM's window list before/after (no fragile title/pid matching).
 *
 * Sub-agents launch in NO-CONFIRMATION mode at the user's explicit request so they run unattended
 * (claude --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-sandbox,
 * opencode --auto), and per-CLI first-run "trust this folder" gates are pre-cleared (codex: a
 * config.toml trust entry). Override the flags per tool with AGENTHOP_SPAWN_ARGS_<TOOL>.
 *
 * Phase 1: launch + arrange only. The spawned session joins the bus on its own; assign it work with
 * agenthop_handoff once it appears in agenthop_peers. (A launchId is injected as AGENTHOP_LAUNCH_ID for
 * a future claim/ready handshake, but is not yet used to auto-deliver a task.)
 */

export const AGENTS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  opencode: ["--auto"],
};

export type SpawnInput = { tool: string; cwd?: string; workspace?: string };
export type SpawnResult = { ok: boolean; windowId?: string; omniwmId?: string; arranged: boolean; workspace?: string; note: string };

function resolveBin(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const fixed = [path.join(homedir(), ".local", "bin", name), `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`];
  for (const c of fixed) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // keep looking
    }
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (existsSync(p)) return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The argv (absolute command + args) to run for a tool, or an error if not allowed. Pure. */
export function resolveCli(tool: string, env: NodeJS.ProcessEnv = process.env): { argv: string[] } | { error: string } {
  const known = tool in AGENTS;
  if (!known && env.AGENTHOP_SPAWN_ALLOW_CMD !== "1") {
    return { error: `Unknown tool "${tool}". Allowed: ${Object.keys(AGENTS).join(", ")} (or set AGENTHOP_SPAWN_ALLOW_CMD=1 for a raw command).` };
  }
  const key = tool.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const bin = env[`AGENTHOP_SPAWN_BIN_${key}`] || resolveBin(tool, env) || tool;
  const argsOverride = env[`AGENTHOP_SPAWN_ARGS_${key}`];
  const args = argsOverride !== undefined ? argsOverride.split(/\s+/).filter(Boolean) : (AGENTS[tool] ?? []);
  return { argv: [bin, ...args] };
}

/** A unique per-launch id, injected as AGENTHOP_LAUNCH_ID for a future claim/ready handshake. Pure. */
export function launchId(tool: string): string {
  return `agenthop-spawn:${tool}:${randomBytes(4).toString("hex")}`;
}

function asEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the osascript that opens one Ghostty window with a command, cwd, and env. Pure. */
export function buildAppleScript(cfg: { command: string; cwd: string; env: string[] }): string {
  const envList = cfg.env.map((e) => `"${asEsc(e)}"`).join(", ");
  return [
    'tell application "Ghostty"',
    "  set c to new surface configuration",
    `  set command of c to "${asEsc(cfg.command)}"`,
    `  set initial working directory of c to "${asEsc(cfg.cwd)}"`,
    `  set environment variables of c to {${envList}}`,
    "  set wait after command of c to true",
    "  set w to new window with configuration c",
    "  return id of w",
    "end tell",
  ].join("\n");
}

/** New OmniWM window ids present in `afterJson` but not in `before`. Pure. */
export function diffNewWindowIds(before: string[], afterJson: string): string[] {
  let windows: unknown;
  try {
    windows = (JSON.parse(afterJson) as { result?: { payload?: { windows?: unknown } } })?.result?.payload?.windows;
  } catch {
    return [];
  }
  if (!Array.isArray(windows)) return [];
  const seen = new Set(before);
  const out: string[] = [];
  for (const w of windows) {
    const id = (w as { id?: unknown })?.id;
    if (typeof id === "string" && !seen.has(id)) out.push(id);
  }
  return out;
}

/** The omniwmctl argv to move a specific window to a workspace. Pure. */
export function moveArgv(id: string, workspace: string): string[] {
  return ["window", "move-to-workspace", id, workspace];
}

/** Whether codex's config still lacks a trust entry for `cwd` (so it would prompt). Pure. */
export function codexTrustNeeded(configText: string, cwd: string): boolean {
  return !configText.includes(`[projects."${cwd}"]`);
}

/** Pre-trust `cwd` for codex so it does not show the first-run "Trust this folder?" prompt. */
export function ensureCodexTrust(cwd: string, home: string = homedir()): void {
  const p = path.join(home, ".codex", "config.toml");
  try {
    const s = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!codexTrustNeeded(s, cwd)) return;
    appendFileSync(p, `\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
  } catch {
    // best effort — if we cannot write, codex will just prompt once
  }
}

function ghosttyPresent(): boolean {
  return existsSync("/Applications/Ghostty.app") || existsSync(path.join(homedir(), "Applications", "Ghostty.app"));
}

// --- Spawn registry: the ONLY windows despawn may close -------------------------------------------
// Every window agenthop_spawn creates is recorded here; despawn refuses any id that is not in this
// list, so it can never close a session the user opened themselves.
export type SpawnRecord = { windowId: string; launchId: string; tool: string; cwd: string; ts: number };

function registryPath(home: string): string {
  return path.join(home, ".agenthop", "spawned.json");
}
export function readRegistry(home: string = homedir()): SpawnRecord[] {
  try {
    const data = JSON.parse(readFileSync(registryPath(home), "utf8"));
    return Array.isArray(data) ? (data as SpawnRecord[]) : [];
  } catch {
    return [];
  }
}
function writeRegistry(home: string, list: SpawnRecord[]): void {
  const p = registryPath(home);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(list, null, 2)}\n`);
}
export function recordSpawn(rec: SpawnRecord, home: string = homedir()): void {
  try {
    writeRegistry(home, [...readRegistry(home).filter((r) => r.windowId !== rec.windowId), rec]);
  } catch {
    // best effort; a lost record just means despawn won't manage that window
  }
}
export function isSpawnedWindow(windowId: string, home: string = homedir()): boolean {
  return readRegistry(home).some((r) => r.windowId === windowId);
}
export function forgetSpawn(windowId: string, home: string = homedir()): void {
  try {
    writeRegistry(home, readRegistry(home).filter((r) => r.windowId !== windowId));
  } catch {
    // best effort
  }
}

function runOsascript(script: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 15000, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout ?? "", err: (stderr ?? "").trim() || (err ? String(err) : "") });
    });
  });
}

async function omniwmWindowIds(bin: string): Promise<string[]> {
  const r = await runOmniwmctl(bin, ["query", "windows", "--app", "Ghostty", "--fields", "id", "--format", "json"], 3000);
  if (r.code !== 0) return [];
  try {
    const ws = (JSON.parse(r.stdout) as { result?: { payload?: { windows?: Array<{ id?: string }> } } })?.result?.payload?.windows ?? [];
    return ws.map((w) => w.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

async function pollNewWindowId(bin: string, before: string[], ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await runOmniwmctl(bin, ["query", "windows", "--app", "Ghostty", "--fields", "id", "--format", "json"], 3000);
    if (r.code === 0) {
      const fresh = diffNewWindowIds(before, r.stdout);
      if (fresh.length > 0) return fresh[0];
    }
    await new Promise((s) => setTimeout(s, 200));
  }
  return undefined;
}

/** Launch a visible sub-agent window and best-effort move it to a workspace. */
export async function spawnAgent(input: SpawnInput, env: NodeJS.ProcessEnv = process.env): Promise<SpawnResult> {
  const cli = resolveCli(input.tool, env);
  if ("error" in cli) return { ok: false, arranged: false, note: cli.error };
  if (platform() !== "darwin") return { ok: false, arranged: false, note: "agenthop_spawn currently supports macOS + Ghostty only." };
  if (!ghosttyPresent()) return { ok: false, arranged: false, note: "Ghostty.app not found; agenthop_spawn needs Ghostty." };
  const cwd = input.cwd && input.cwd.trim() ? path.resolve(input.cwd) : process.cwd();
  if (!existsSync(cwd)) return { ok: false, arranged: false, note: `cwd does not exist: ${cwd}` };

  // Per-CLI unattended setup: clear codex's first-run folder-trust gate for this cwd.
  if (input.tool === "codex") ensureCodexTrust(cwd);

  const lid = launchId(input.tool);
  const command = cli.argv.join(" "); // absolute bin + flags (our values contain no spaces)
  // Inject only PATH/HOME (so the CLI finds node etc. under the GUI launch env) + the launch id. The
  // child does NOT inherit this process's identity env, so it never mis-identifies as the parent.
  const injectEnv = [`PATH=${env.PATH ?? ""}`, `HOME=${env.HOME ?? homedir()}`, `AGENTHOP_LAUNCH_ID=${lid}`];

  const bin = omniwmctlBin(env);
  const canArrange = bin ? await omniwmReady(bin) : false;
  const before = bin && canArrange ? await omniwmWindowIds(bin) : [];

  const r = await runOsascript(buildAppleScript({ command, cwd, env: injectEnv }));
  if (!r.ok) return { ok: false, arranged: false, note: `Failed to open a Ghostty window via AppleScript: ${r.err || "unknown error"}` };
  const windowId = r.out.trim() || undefined;
  // Register this window as agenthop-spawned so despawn may (only) close it later.
  if (windowId) recordSpawn({ windowId, launchId: lid, tool: input.tool, cwd, ts: Date.now() });

  const workspace = (input.workspace && input.workspace.trim()) || env.AGENTHOP_SPAWN_WORKSPACE?.trim();
  const tail = "It will appear in agenthop_peers shortly; use agenthop_handoff to give it a task.";
  if (!workspace) {
    return { ok: true, arranged: false, windowId, note: `Launched ${input.tool} in a visible Ghostty window on the current workspace. ${tail}` };
  }
  if (!bin || !canArrange) {
    return { ok: true, arranged: false, windowId, workspace, note: `Launched ${input.tool}; OmniWM not reachable, so it stays on the current workspace (wanted ${workspace}). ${tail}` };
  }
  const omniwmId = await pollNewWindowId(bin, before, 4000);
  if (!omniwmId) return { ok: true, arranged: false, windowId, workspace, note: `Launched ${input.tool}; could not locate its window within 4s to move it to ${workspace} (it stays on the current workspace). ${tail}` };
  const mv = await runOmniwmctl(bin, moveArgv(omniwmId, workspace));
  if (mv.code !== 0) {
    return { ok: true, arranged: false, windowId, omniwmId, workspace, note: `Launched ${input.tool}; move to ${workspace} failed (${(mv.stderr || mv.stdout).trim()}). ${tail}` };
  }
  return { ok: true, arranged: true, windowId, omniwmId, workspace, note: `Launched ${input.tool} and moved it to workspace ${workspace}. ${tail}` };
}

/** Close a window agenthop spawned — and ONLY such a window. Refuses any id not in the registry, so it
 *  can never close a session the user opened. Focus-independent (targets the exact window id). */
export async function despawnAgent(windowId: string, home: string = homedir()): Promise<{ ok: boolean; note: string }> {
  const id = windowId.trim();
  if (!id) return { ok: false, note: "No window id given." };
  if (platform() !== "darwin") return { ok: false, note: "agenthop_despawn currently supports macOS + Ghostty only." };
  if (!isSpawnedWindow(id, home)) {
    return { ok: false, note: `Refusing to close "${id}": it is not a window agenthop dispatched. agenthop only ever closes agents it spawned, never sessions you opened. (See agenthop_spawned for ids I can close.)` };
  }
  const r = await runOsascript(`tell application "Ghostty" to close window (first window whose id is "${asEsc(id)}")`);
  forgetSpawn(id, home);
  return r.ok
    ? { ok: true, note: `Closed spawned window ${id}.` }
    : { ok: true, note: `Removed ${id} from the registry (it may already be closed): ${r.err || "no live window"}.` };
}
