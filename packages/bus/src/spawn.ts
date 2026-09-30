import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { omniwmctlBin, omniwmReady, runOmniwmctl } from "./wm.js";

/**
 * Launch a chosen agent CLI in a VISIBLE Ghostty window and (best effort) arrange it via OmniWM, so a
 * bus session can dispatch sub-agents the user can watch. macOS + Ghostty.
 *
 * Backend: Ghostty's AppleScript scripting (`new window with configuration`). It makes exactly ONE
 * window in the running instance, applies a command + working directory + injected env, and returns the
 * new window's id AND its terminal's surface UUID in the same script.
 *
 * Sub-agents launch in NO-CONFIRMATION mode at the user's explicit request so they run unattended
 * (claude --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-sandbox,
 * opencode --auto). Override the flags per tool with AGENTHOP_SPAWN_ARGS_<TOOL>.
 *
 * SAFETY — despawn closes ONLY the terminal SURFACE agenthop spawned, addressed by its Ghostty surface
 * UUID. This is what makes "never close a window you opened" actually hold:
 *   - A window id is an ObjectIdentifier (object address) Ghostty REUSES after a window closes, so it
 *     cannot identify our window later. A surface UUID is random, unique, and never reused — a user
 *     window that reused our window id has a different surface UUID, so it is never matched.
 *   - The UUID is captured in the SAME AppleScript that creates the window (no separate query), so there
 *     is no create→capture gap in which a reused id could bind the wrong surface.
 *   - despawn issues Ghostty's `close <terminal whose id is UUID>`, which closes just that surface — a
 *     split or tab the user later added to our window is NOT taken down with it. If the surface is gone,
 *     nothing is closed. No window-id, tty, or liveness guess is involved.
 * A unique AGENTHOP_LAUNCH_ID is still injected (a Phase-2 claim/ready seed) and recorded so
 * agenthop_spawned can tell concurrent same-dir launches apart.
 */

export const AGENTS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  opencode: ["--auto"],
};

/**
 * Session-identity / tool-marker env vars stripped from the child (via `env -u`) so a spawned agent can
 * never inherit the DISPATCHER's identity from the running Ghostty app environment and mis-join the bus
 * as its parent, or be mis-detected as the parent's tool. Auth/config vars (CODEX_HOME, AGENTHOP_TEAM,
 * ...) are deliberately NOT stripped.
 */
export const SCRUB_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "AGENTHOP_TITLE",
  "AGENTHOP_TOOL",
];

export type SpawnInput = { tool: string; cwd?: string; workspace?: string };
export type SpawnResult = { ok: boolean; windowId?: string; surfaceId?: string; omniwmId?: string; arranged: boolean; workspace?: string; launchId?: string; note: string };

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

/** A unique per-launch id, injected as AGENTHOP_LAUNCH_ID (a Phase-2 claim/ready seed) and recorded so
 *  agenthop_spawned can distinguish concurrent same-dir launches. Pure. */
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

/** Build the osascript that opens one Ghostty window and returns "<windowId>\t<surfaceUUID>". Pure. */
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
    "  return (id of w) & tab & (id of (first terminal of w))",
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
 * config-injection surface. Callers pass a realpath'd cwd (codex keys trust on the physical path). Pure.
 */
export function codexTrustArgs(cwd: string): string[] {
  return ["-c", `projects={"${tomlBasicString(cwd)}"={trust_level="trusted"}}`];
}

function ghosttyPresent(): boolean {
  return existsSync("/Applications/Ghostty.app") || existsSync(path.join(homedir(), "Applications", "Ghostty.app"));
}

// --- Spawn registry: the ONLY surfaces despawn may close ------------------------------------------
// One file per launch under ~/.agenthop/spawned/<launchId>.json, so concurrent spawns from different
// bus sessions never lose each other's records to a shared read-modify-write. A record is written with
// windowId=null BEFORE the window is opened (so a lost/timed-out launch is still discoverable) and
// updated with the window id + surface UUID on success. despawn closes by the surface UUID.
export type SpawnRecord = { windowId: string | null; surfaceId: string | null; launchId: string; tool: string; cwd: string; ts: number };

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
  const p = recordFile(home, rec.launchId);
  const tmp = `${p}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmp, p); // atomic replace — a failed/partial write never truncates the existing record
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // leftover temp is harmless (readRegistry only reads *.json)
    }
    return false;
  }
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

/** Close exactly the surface with this Ghostty surface UUID (not the whole window). A UUID is unique
 *  and never reused, so this can only ever hit the surface agenthop spawned. */
async function closeSurface(surfaceId: string): Promise<"closed" | "absent" | "unknown"> {
  const r = await runOsascript(`tell application "Ghostty"
  set matches to (terminals whose id is "${asEsc(surfaceId)}")
  if matches is {} then return "absent"
  close (item 1 of matches)
  return "closed"
end tell`);
  if (!r.ok) return "unknown";
  const v = r.out.trim();
  return v === "closed" || v === "absent" ? v : "unknown";
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
  let cwd = input.cwd && input.cwd.trim() ? path.resolve(input.cwd) : process.cwd();
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(cwd);
  } catch {
    return { ok: false, arranged: false, note: `cwd does not exist: ${cwd}` };
  }
  if (!st.isDirectory()) return { ok: false, arranged: false, note: `cwd is not a directory: ${cwd}` };
  // Use the PHYSICAL path: codex keys folder-trust on the realpath, so a /tmp alias or a symlinked cwd
  // would otherwise be launched under a path the trust entry does not cover (codex would still prompt).
  try {
    cwd = realpathSync(cwd);
  } catch {
    // keep the resolved path if realpath fails (e.g. permissions) — trust may then not match, but safe
  }

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
  if (!recordSpawn({ windowId: null, surfaceId: null, launchId: lid, tool: input.tool, cwd, ts: Date.now() })) {
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
  // The script returns "<windowId>\t<surfaceUUID>", both read in the same execution as creation.
  const [windowId, surfaceId] = r.out.trim().split("\t");
  let recordOk = true;
  if (windowId) {
    recordOk = recordSpawn({ windowId, surfaceId: surfaceId ?? null, launchId: lid, tool: input.tool, cwd, ts: Date.now() });
  }

  const workspace = (input.workspace && input.workspace.trim()) || env.AGENTHOP_SPAWN_WORKSPACE?.trim();
  const warn = !windowId
    ? ` (Ghostty returned no window id — launchId ${lid}.)`
    : !surfaceId
      ? ` (warning: captured no surface id, so agenthop_despawn cannot close it safely — launchId ${lid}; close it manually if needed.)`
      : !recordOk
        ? ` (warning: could not persist the window record, so agenthop_despawn may not find it — launchId ${lid}.)`
        : "";
  const tail = `It will appear in agenthop_peers shortly; use agenthop_handoff to give it a task.${warn}`;
  const base = { windowId, surfaceId: surfaceId || undefined, launchId: lid } as const;
  if (!workspace) {
    return { ok: true, arranged: false, ...base, note: `Launched ${input.tool} in a visible Ghostty window on the current workspace. ${tail}` };
  }
  if (!bin || !canArrange) {
    return { ok: true, arranged: false, ...base, workspace, note: `Launched ${input.tool}; OmniWM not reachable, so it stays on the current workspace (wanted ${workspace}). ${tail}` };
  }
  if (before === undefined) {
    return { ok: true, arranged: false, ...base, workspace, note: `Launched ${input.tool}; could not snapshot windows before launch, so nothing is moved (moving a guessed window could move one of yours). It stays on the current workspace. ${tail}` };
  }
  const omniwmId = await pollSingleNewWindowId(bin, before, 4000);
  if (!omniwmId) {
    return { ok: true, arranged: false, ...base, workspace, note: `Launched ${input.tool}; could not UNIQUELY identify its window within 4s (0 or several new windows appeared), so it stays put — moving a guessed window risks moving one of yours. ${tail}` };
  }
  const mv = await runOmniwmctl(bin, moveArgv(omniwmId, workspace));
  if (mv.code !== 0) {
    return { ok: true, arranged: false, ...base, omniwmId, workspace, note: `Launched ${input.tool}; move to ${workspace} failed (${(mv.stderr || mv.stdout).trim()}). ${tail}` };
  }
  return { ok: true, arranged: true, ...base, omniwmId, workspace, note: `Launched ${input.tool} and moved the newly-appeared window to workspace ${workspace} (best-effort: matched as the single new window, not a hard binding). ${tail}` };
}

export type DespawnOptions = { home?: string };

/**
 * Close a surface agenthop spawned — and ONLY that surface. Looks up the record by the window id the
 * caller was given, then closes by the recorded Ghostty surface UUID (unique, never reused, captured
 * atomically at creation). A user window that reused the window id has a different surface UUID and is
 * never matched; a split/tab the user added to our window survives. If the surface is gone, nothing is
 * closed. Never closes by the reusable window id.
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
  if (!rec.surfaceId) {
    // No surface UUID captured — we will NOT fall back to closing by the reusable window id.
    return { ok: false, note: `Cannot safely close "${id}": no surface id was captured at spawn (launchId ${rec.launchId}). agenthop won't close by a reusable window id. Close it manually if needed; the record is kept.` };
  }
  const res = await closeSurface(rec.surfaceId);
  if (res === "closed") {
    forgetSpawn(rec.launchId, home);
    return { ok: true, note: `Closed the spawned terminal (window ${id}).` };
  }
  if (res === "absent") {
    forgetSpawn(rec.launchId, home);
    return { ok: true, note: `That spawned terminal is already gone; removed its record. (Closed nothing.)` };
  }
  return { ok: false, note: `Could not close the spawned terminal for ${id} (Ghostty unreachable or permission). Record kept; retry once reachable.` };
}
