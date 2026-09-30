import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { omniwmctlBin, omniwmReady, runOmniwmctl } from "./wm.js";

/**
 * Launch a chosen agent CLI in a VISIBLE Ghostty window and (best effort) arrange it via OmniWM, so a
 * bus session can dispatch sub-agents the user can watch. macOS + Ghostty.
 *
 * Backend: Ghostty's AppleScript scripting (`new window with configuration`). Unlike `open -na` it makes
 * exactly ONE window in the running instance, applies a command + working directory + injected env, and
 * returns a window id. The launched window is a normal Ghostty window OmniWM tiles.
 *
 * Sub-agents launch in NO-CONFIRMATION mode at the user's explicit request so they run unattended
 * (claude --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-sandbox,
 * opencode --auto). Override the flags per tool with AGENTHOP_SPAWN_ARGS_<TOOL>.
 *
 * SAFETY — despawn only ever closes a window agenthop spawned, never a session the user opened. That
 * guarantee cannot rest on the window id alone: a Ghostty window id is `ObjectIdentifier(window)` (an
 * object address) that is REUSED after the window closes, so a stale record could otherwise authorize
 * closing a later user window that reused the address. Instead every spawn injects a unique
 * AGENTHOP_LAUNCH_ID; the spawned session republishes it on the bus (SelfInfo.launchId), and despawn
 * closes the stored window id ONLY while a live peer still carries that launchId (alive ⇒ our window
 * never closed ⇒ the id is still valid and still ours). No live peer ⇒ never send a close.
 */

export const AGENTS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  opencode: ["--auto"],
};

/**
 * Session-identity / messaging env vars stripped from the child (via `env -u`) so a spawned agent can
 * never inherit the DISPATCHER's identity from the running Ghostty app environment and mis-join the bus
 * as its parent. Auth/config vars (CODEX_HOME, AGENTHOP_TEAM, ...) are deliberately NOT stripped.
 */
export const SCRUB_ENV = [
  // tool markers detectTool() keys on — a child that inherits a parent's marker would mis-identify as
  // that tool (e.g. codex spawned from a claude window would look like claude).
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "AGENTHOP_TITLE",
  "AGENTHOP_TOOL",
];

export type SpawnInput = { tool: string; cwd?: string; workspace?: string };
export type SpawnResult = { ok: boolean; windowId?: string; omniwmId?: string; arranged: boolean; workspace?: string; launchId?: string; note: string };

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
  const known = Object.hasOwn(AGENTS, tool); // own-key check: `"constructor" in AGENTS` is a false positive
  if (!known && env.AGENTHOP_SPAWN_ALLOW_CMD !== "1") {
    return { error: `Unknown tool "${tool}". Allowed: ${Object.keys(AGENTS).join(", ")} (or set AGENTHOP_SPAWN_ALLOW_CMD=1 for a raw command).` };
  }
  const key = tool.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const bin = env[`AGENTHOP_SPAWN_BIN_${key}`] || resolveBin(tool, env) || tool;
  const argsOverride = env[`AGENTHOP_SPAWN_ARGS_${key}`];
  const args = argsOverride !== undefined ? argsOverride.split(/\s+/).filter(Boolean) : known ? AGENTS[tool]! : [];
  return { argv: [bin, ...args] };
}

/** A unique per-launch id, injected as AGENTHOP_LAUNCH_ID; the spawned session republishes it on the
 *  bus so despawn can prove ownership before closing a (reusable) window id. Pure. */
export function launchId(tool: string): string {
  return `agenthop-spawn:${tool}:${randomBytes(4).toString("hex")}`;
}

function asEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** POSIX single-quote a shell word so metacharacters cannot be re-interpreted. Pure. */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The shell command line Ghostty runs. Ghostty sets a surface `command` as `.shell`, i.e. the string
 * is shell-interpreted — so a bare argv.join(" ") breaks on any space/metachar in a path or arg. We
 * quote every element, and prefix `env -u` to strip inherited identity before exec. Pure.
 */
export function buildCommand(argv: string[], scrub: string[] = SCRUB_ENV): string {
  return ["/usr/bin/env", ...scrub.map((v) => `-u ${v}`), ...argv.map(shquote)].join(" ");
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

/** Full TOML basic-string escaping (quotes, backslash, and every control char) for a path embedded in
 *  a codex `-c` inline-table override. Pure. */
export function tomlBasicString(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0").toUpperCase()}`;
    else out += ch;
  }
  return out;
}

/**
 * codex CLI args that pre-trust `cwd` via a per-invocation config override, so the spawned session
 * skips the first-run "Trust this folder?" prompt WITHOUT mutating the user's global ~/.codex/config.toml.
 * The value MUST be a full inline table: codex's `-c` key parser splits on `.` and does NOT honor quotes,
 * so `projects."<path>".trust_level=...` misparses and does NOT trust — the working form (verified on
 * 0.159.2 by isolating the effective feature list) sets the whole `projects` table as an inline-table
 * value, where the path is a quoted TOML key. Per-invocation ⇒ no file to corrupt, no write race, no
 * config-injection surface. Pure.
 */
export function codexTrustArgs(cwd: string): string[] {
  return ["-c", `projects={"${tomlBasicString(cwd)}"={trust_level="trusted"}}`];
}

function ghosttyPresent(): boolean {
  return existsSync("/Applications/Ghostty.app") || existsSync(path.join(homedir(), "Applications", "Ghostty.app"));
}

// --- Spawn registry: the ONLY windows despawn may close -------------------------------------------
// One file per launch under ~/.agenthop/spawned/<launchId>.json, so concurrent spawns from different
// bus sessions never lose each other's records to a shared read-modify-write (a single JSON array
// could). A record is written with windowId=null BEFORE the window is opened (so a lost/timed-out
// launch is still discoverable) and updated with the id on success.
export type SpawnRecord = { windowId: string | null; launchId: string; tool: string; cwd: string; ts: number };

function registryDir(home: string): string {
  return path.join(home, ".agenthop", "spawned");
}
function recordFile(home: string, lid: string): string {
  const safe = lid.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(registryDir(home), `${safe}.json`);
}
function isRecord(r: unknown): r is SpawnRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return typeof o.launchId === "string" && typeof o.tool === "string" && typeof o.cwd === "string" && (o.windowId === null || typeof o.windowId === "string");
}
export function readRegistry(home: string = homedir()): SpawnRecord[] {
  let files: string[];
  try {
    files = readdirSync(registryDir(home)).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no dir yet
  }
  const out: SpawnRecord[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(path.join(registryDir(home), f), "utf8"));
      if (isRecord(r)) out.push(r);
    } catch {
      // skip a malformed / partially-written record
    }
  }
  return out;
}
export function recordSpawn(rec: SpawnRecord, home: string = homedir()): boolean {
  try {
    const p = recordFile(home, rec.launchId);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`); // one file per launch — no cross-process RMW
    return true;
  } catch {
    return false;
  }
}

type AliveProbe = (pid: number | undefined) => boolean;
function defaultPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours to signal ⇒ still alive
  }
}

/**
 * Whether a LOCAL peer still carries `launchId` AND its OS process is alive right now. The pid probe
 * bypasses the broker roster's drop lag — a dead session can linger in the roster for tens of ms, and a
 * bare "is it in the roster" check would then let despawn close a window whose process already exited.
 * Same-machine only (a relay peer is on a machine we cannot despawn). Pure given the probe (injectable).
 */
export function isLaunchAlive(peers: Array<{ via?: string; launchId?: string; pid?: number }>, launchId: string, pidAlive: AliveProbe = defaultPidAlive): boolean {
  return peers.some((p) => p.via === "local" && p.launchId === launchId && pidAlive(p.pid));
}
export function isSpawnedWindow(windowId: string, home: string = homedir()): boolean {
  return readRegistry(home).some((r) => r.windowId === windowId);
}
export function recordForWindow(windowId: string, home: string = homedir()): SpawnRecord | undefined {
  return readRegistry(home).find((r) => r.windowId === windowId);
}
export function forgetSpawn(launchId: string, home: string = homedir()): void {
  try {
    rmSync(recordFile(home, launchId), { force: true });
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

/** Tri-state existence check for a Ghostty window id (yes / no / unknown-when-unreachable). */
async function ghosttyWindowExists(id: string): Promise<"yes" | "no" | "unknown"> {
  const r = await runOsascript(`tell application "Ghostty" to return (exists (first window whose id is "${asEsc(id)}"))`);
  if (!r.ok) return "unknown";
  const v = r.out.trim();
  return v === "true" ? "yes" : v === "false" ? "no" : "unknown";
}

async function omniwmWindowIds(bin: string): Promise<string[] | undefined> {
  const r = await runOmniwmctl(bin, ["query", "windows", "--app", "Ghostty", "--fields", "id", "--format", "json"], 3000);
  if (r.code !== 0) return undefined; // a FAILED query is unknown, not "no windows" — never treat as []
  try {
    const ws = (JSON.parse(r.stdout) as { result?: { payload?: { windows?: unknown } } })?.result?.payload?.windows;
    if (!Array.isArray(ws)) return undefined; // exit 0 but no windows array = unknown snapshot, not "none"
    return ws.map((w) => (w as { id?: unknown })?.id).filter((id): id is string => typeof id === "string");
  } catch {
    return undefined;
  }
}

/** Poll until EXACTLY ONE new window appears (return its id) — 0 or >1 stays ambiguous (undefined), so
 *  a concurrent spawn or an unrelated new window is never grabbed and moved. */
async function pollSingleNewWindowId(bin: string, before: string[], ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await runOmniwmctl(bin, ["query", "windows", "--app", "Ghostty", "--fields", "id", "--format", "json"], 3000);
    if (r.code === 0) {
      const fresh = diffNewWindowIds(before, r.stdout);
      if (fresh.length === 1) return fresh[0];
      if (fresh.length > 1) return undefined; // ambiguous — refuse to guess
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
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(cwd);
  } catch {
    return { ok: false, arranged: false, note: `cwd does not exist: ${cwd}` };
  }
  if (!st.isDirectory()) return { ok: false, arranged: false, note: `cwd is not a directory: ${cwd}` };

  // codex: pre-trust this folder per-invocation via `-c` (no global config write).
  const argv = input.tool === "codex" ? [cli.argv[0]!, ...codexTrustArgs(cwd), ...cli.argv.slice(1)] : cli.argv;
  const lid = launchId(input.tool);
  const command = buildCommand(argv);
  // Inject PATH/HOME (so the CLI finds node etc. under the GUI launch env) + the launch id. Inherited
  // identity is stripped by `env -u` in the command (see buildCommand / SCRUB_ENV).
  const injectEnv = [`PATH=${env.PATH ?? ""}`, `HOME=${env.HOME ?? homedir()}`, `AGENTHOP_LAUNCH_ID=${lid}`];

  // Record the launch REQUEST before any side effect, so a window opened but not confirmed (lost or
  // timed-out AppleScript reply) is still discoverable in agenthop_spawned rather than a silent orphan.
  // If we cannot even record it, do NOT open a window — an untracked window despawn could never close.
  if (!recordSpawn({ windowId: null, launchId: lid, tool: input.tool, cwd, ts: Date.now() })) {
    return { ok: false, arranged: false, launchId: lid, note: `Could not write a launch record under ~/.agenthop/spawned; not opening a window (an untracked window could never be despawned). Check that ~/.agenthop is writable.` };
  }

  const bin = omniwmctlBin(env);
  const canArrange = bin ? await omniwmReady(bin) : false;
  const before = bin && canArrange ? await omniwmWindowIds(bin) : undefined; // undefined = snapshot unknown

  const r = await runOsascript(buildAppleScript({ command, cwd, env: injectEnv }));
  if (!r.ok) {
    // The Apple Event and its reply are separate; a killed/timed-out osascript does NOT prove the app
    // did nothing. Keep the pending record and tell the caller not to blindly retry.
    return {
      ok: false,
      arranged: false,
      launchId: lid,
      note: `Could not confirm a Ghostty window opened (${r.err || "unknown error"}). A window MAY have opened (launchId ${lid}) — check agenthop_peers / agenthop_spawned before retrying; do not blindly re-spawn.`,
    };
  }
  const windowId = r.out.trim() || undefined;
  if (windowId) recordSpawn({ windowId, launchId: lid, tool: input.tool, cwd, ts: Date.now() });

  const workspace = (input.workspace && input.workspace.trim()) || env.AGENTHOP_SPAWN_WORKSPACE?.trim();
  const tail = "It will appear in agenthop_peers shortly; use agenthop_handoff to give it a task.";
  const idNote = windowId ? `` : ` (Ghostty returned no window id, so it can't be despawned by id — launchId ${lid}.)`;
  if (!workspace) {
    return { ok: true, arranged: false, windowId, launchId: lid, note: `Launched ${input.tool} in a visible Ghostty window on the current workspace.${idNote} ${tail}` };
  }
  if (!bin || !canArrange) {
    return { ok: true, arranged: false, windowId, workspace, launchId: lid, note: `Launched ${input.tool}; OmniWM not reachable, so it stays on the current workspace (wanted ${workspace}). ${tail}` };
  }
  if (before === undefined) {
    return { ok: true, arranged: false, windowId, workspace, launchId: lid, note: `Launched ${input.tool}; could not snapshot windows before launch, so nothing is moved (moving a guessed window could move one of yours). It stays on the current workspace. ${tail}` };
  }
  const omniwmId = await pollSingleNewWindowId(bin, before, 4000);
  if (!omniwmId) {
    return { ok: true, arranged: false, windowId, workspace, launchId: lid, note: `Launched ${input.tool}; could not UNIQUELY identify its window within 4s (0 or several new windows appeared), so it stays put — moving a guessed window risks moving one of yours. ${tail}` };
  }
  const mv = await runOmniwmctl(bin, moveArgv(omniwmId, workspace));
  if (mv.code !== 0) {
    return { ok: true, arranged: false, windowId, omniwmId, workspace, launchId: lid, note: `Launched ${input.tool}; move to ${workspace} failed (${(mv.stderr || mv.stdout).trim()}). ${tail}` };
  }
  return { ok: true, arranged: true, windowId, omniwmId, workspace, launchId: lid, note: `Launched ${input.tool} and moved the newly-appeared window to workspace ${workspace} (best-effort: matched as the single new window, not a hard binding). ${tail}` };
}

export type DespawnOptions = { isAlive?: (launchId: string) => boolean; home?: string };

/**
 * Close a window agenthop spawned — and ONLY such a window. Refuses any id not in the registry, and,
 * critically, only sends a close while a live bus peer still carries the record's launchId: a live
 * peer proves OUR session is up, which proves its window never closed, which proves the stored id is
 * still valid and still ours (Ghostty reuses a closed window's id). With no live peer we NEVER close —
 * the id may now belong to a window the user opened.
 */
export async function despawnAgent(windowId: string, opts: DespawnOptions = {}): Promise<{ ok: boolean; note: string }> {
  const home = opts.home ?? homedir();
  const id = windowId.trim();
  if (!id) return { ok: false, note: "No window id given." };
  if (platform() !== "darwin") return { ok: false, note: "agenthop_despawn currently supports macOS + Ghostty only." };
  const rec = recordForWindow(id, home);
  if (!rec) {
    return { ok: false, note: `Refusing to close "${id}": it is not a window agenthop dispatched. agenthop only ever closes agents it spawned, never sessions you opened. (See agenthop_spawned for ids I can close.)` };
  }

  const alive = opts.isAlive?.(rec.launchId) ?? false;
  if (!alive) {
    // Cannot prove ownership from the id alone (it is reusable). Do NOT close. At most, forget a record
    // whose window is provably gone.
    const exists = await ghosttyWindowExists(id);
    if (exists === "no") {
      forgetSpawn(rec.launchId, home);
      return { ok: true, note: `Session ${rec.launchId} is gone and no window ${id} exists; removed its stale record. (Did not send a close — a closed window's id can be reused by a later window.)` };
    }
    if (exists === "unknown") {
      return { ok: false, note: `Could not verify window "${id}" (Ghostty not reachable / permission). Its session is not on the bus, so I will not close by id — the id may have been reused. Record kept; retry once Ghostty is reachable.` };
    }
    return { ok: false, note: `Not closing "${id}": its spawned session is not on the bus, so I cannot confirm this window is still the one agenthop opened (a window id can be reused after close). If it is a stuck spawn, close it manually. Record kept.` };
  }

  // Alive ⇒ our window is still open ⇒ id is valid and ours ⇒ safe to close by exact id.
  const r = await runOsascript(`tell application "Ghostty" to close window (first window whose id is "${asEsc(id)}")`);
  if (r.ok) {
    forgetSpawn(rec.launchId, home);
    return { ok: true, note: `Closed spawned window ${id}.` };
  }
  // A permission/TCC/script error is NOT proof it closed — keep the record so a retry is still possible.
  return { ok: false, note: `Failed to close ${id} (${r.err || "unknown error"}). Record kept — fix the error (e.g. grant Automation permission) and retry; not assuming it closed.` };
}
