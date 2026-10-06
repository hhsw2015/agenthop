import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { omniwmctlBin, omniwmReady, runOmniwmctl } from "./wm.js";
import { herdrAgentName, herdrLaunch, herdrServerReachable, herdrSpawnable } from "./swarm/herdr.js";

/**
 * Launch a chosen agent CLI as a dispatched sub-agent, in one of two modes the CALLING AGENT chooses
 * per task:
 *   - VISIBLE (default): a Ghostty window the user can watch, best-effort arranged via OmniWM
 *     (macOS + Ghostty). The session joins the bus; give it work with agenthop_handoff.
 *   - HEADLESS (visible:false): no window — a DETACHED background run of the tool's native
 *     non-interactive mode (claude -p / codex exec / opencode run) with `task` as the prompt.
 *     Cross-platform (no Ghostty needed). stdout/stderr stream to a per-launch log file; if the
 *     tool's own config has the agenthop MCP registered it also joins the bus as a peer (best-effort,
 *     see spawnHeadlessAgent). Cleanup kills exactly the recorded pid (see despawnAgent).
 *
 * VISIBLE-mode backend notes:
 *
 * Backend: Ghostty's AppleScript scripting (`new window with configuration`). It makes exactly ONE
 * window in the running instance, applies a command + working directory + injected env, and returns the
 * new window's id AND its terminal's surface UUID in the same script.
 *
 * Sub-agents launch in NO-CONFIRMATION mode at the user's explicit request so they run unattended
 * (claude --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-sandbox,
 * opencode --auto). Override the flags per tool with AGENTHOP_SPAWN_ARGS_<TOOL>.
 *
 * SAFETY — despawn closes ONLY a surface the spawned agent CLAIMED as its own, so it can never close a
 * surface the dispatcher merely guessed at:
 *   - The dispatcher cannot prove which surface it created: `new window` returns a window, not a surface,
 *     and a terminal's env/command are not readable, so any read-back from the window's terminal set can
 *     be fooled by a concurrent change (that was the old capture residual).
 *   - So provenance comes from the CHILD, the authoritative owner of its own surface. On startup a
 *     spawned bus node (one carrying our injected AGENTHOP_LAUNCH_ID) finds its controlling tty (via ps,
 *     walking ppid across the MCP/pipe boundary), maps that tty to its Ghostty surface UUID
 *     (`terminal whose tty is …`, requiring a unique match), and records that UUID with claimed=true on
 *     its own launch record. This binds (this launch)→(the real surface it runs in) from the one process
 *     that cannot be wrong about it.
 *   - despawn closes `terminal whose id is <claimed UUID>` (a UUID is unique and never reused) and ONLY
 *     when claimed=true. An unclaimed record (agent not up yet, or killed before claiming) is refused,
 *     never closed by the reusable window id. If the surface is gone, nothing is closed.
 * Net: a surface an agenthop-spawned agent never claimed is never closed by despawn.
 */

// An agenthop-SPAWNED agent runs fully autonomous, so it also TRUSTS its own hooks: a dispatched Codex must run its
// agenthop presence/status hooks (and any just-(re)installed ones) immediately, not sit behind the per-hook trust
// prompt that a freshly written/edited hooks.json otherwise requires — hence --dangerously-bypass-hook-trust alongside
// --dangerously-bypass-approvals-and-sandbox. This applies ONLY to agents WE launch, never the user's own sessions.
export const AGENTS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"],
  opencode: ["--auto"],
};

/**
 * Native NON-INTERACTIVE ("headless") entry for each tool. claude takes its prompt as a positional after
 * the `-p` flag; codex and opencode use a subcommand. Verified against each installed binary's own
 * `--help`: `claude -p/--print` ("Print response and exit"), `codex exec` ("Run Codex non-interactively"),
 * `opencode run` ("run opencode with a message"). Override per tool with AGENTHOP_SPAWN_HEADLESS_<TOOL>
 * (space-separated); an empty override means "no mode tokens — prompt only" (e.g. a CLI that is already
 * non-interactive). The trailing prompt is always appended as the final argv element.
 */
export const HEADLESS: Record<string, string[]> = {
  claude: ["-p"],
  codex: ["exec"],
  opencode: ["run"],
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

/**
 * Headless children additionally scrub AGENTHOP_LAUNCH_ID and NEVER get one injected. A headless child
 * is detached (setsid ⇒ no controlling tty), so claimOwnSpawn's ppid walk from inside it would cross
 * into the DISPATCHER's own terminal and claim the dispatcher's surface — despawn could then close the
 * user's window. With no launch id in the child, startClaimRetry is a guaranteed no-op; headless
 * cleanup is by recorded pid instead (see despawnAgent).
 */
export const HEADLESS_SCRUB_ENV = [...SCRUB_ENV, "AGENTHOP_LAUNCH_ID"];

/** A copy of `env` without the scrubbed identity keys. Never mutates the input. Pure. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env, scrub: readonly string[] = HEADLESS_SCRUB_ENV): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!scrub.includes(k)) out[k] = v;
  }
  return out;
}

export type SpawnMode = "visible" | "headless";
export type SpawnInput = { tool: string; cwd?: string; workspace?: string; visible?: boolean; task?: string };
export type SpawnResult = {
  ok: boolean;
  mode?: SpawnMode;
  windowId?: string;
  surfaceId?: string;
  omniwmId?: string;
  arranged: boolean;
  workspace?: string;
  launchId?: string;
  pid?: number;
  outputFile?: string;
  note: string;
};

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

/**
 * Build the osascript that opens one Ghostty window and returns its window id. The surface identity is
 * NOT read back here (a dispatcher read-back cannot prove provenance) — the spawned agent claims its own
 * surface UUID later via claimOwnSpawn. Pure.
 */
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
 * config-injection surface. Callers pass a realpath'd cwd (codex keys trust on the physical path). Pure.
 */
export function codexTrustArgs(cwd: string): string[] {
  return ["-c", `projects={"${tomlBasicString(cwd)}"={trust_level="trusted"}}`];
}

/**
 * codex CLI args that set AGENTHOP_LAUNCH_ID in the agenthop MCP subprocess's environment (which codex
 * otherwise clears), so the spawned session can self-register its window for despawn. Done per-invocation
 * via `-c` on the `env` TABLE LEAF (not the `env_vars` passthrough array): this MERGES — it preserves the
 * user's env_vars (e.g. an AGENTHOP_TEAM forward for cross-machine) and any other env keys, and needs no
 * config-file edit/migration (verified against codex 0.159.2). We inject the actual launch id value
 * (known at spawn time), so it does not depend on codex's own environment carrying it. Pure.
 */
export function codexEnvForwardArgs(lid: string): string[] {
  return ["-c", `mcp_servers.agenthop.env.AGENTHOP_LAUNCH_ID="${lid}"`];
}

function ghosttyPresent(): boolean {
  return existsSync("/Applications/Ghostty.app") || existsSync(path.join(homedir(), "Applications", "Ghostty.app"));
}

/**
 * The full argv for a HEADLESS run: binary + the tool's non-interactive mode tokens + its usual
 * autonomous flags + the task as the final positional prompt. Mode tokens come from
 * AGENTHOP_SPAWN_HEADLESS_<TOOL> when set (an empty override means "prompt only"), else the verified
 * HEADLESS table; a tool in neither is refused rather than guessing a flag. Pure.
 */
export function headlessArgv(tool: string, cliArgv: string[], task: string, env: NodeJS.ProcessEnv = process.env): { argv: string[] } | { error: string } {
  const key = tool.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const override = env[`AGENTHOP_SPAWN_HEADLESS_${key}`];
  const known = Object.hasOwn(HEADLESS, tool);
  if (override === undefined && !known) {
    return { error: `No headless (non-interactive) mode known for "${tool}". Set AGENTHOP_SPAWN_HEADLESS_${key} to its non-interactive flags (empty = pass the task as the only argument), or spawn it visible.` };
  }
  const mode = override !== undefined ? override.split(/\s+/).filter(Boolean) : HEADLESS[tool]!;
  return { argv: [cliArgv[0]!, ...mode, ...cliArgv.slice(1), task] };
}

// --- Spawn registry: the ONLY surfaces/processes despawn may close --------------------------------
// One file per launch under ~/.agenthop/spawned/<launchId>.json, so concurrent spawns from different
// bus sessions never lose each other's records to a shared read-modify-write. A record is written with
// windowId=null BEFORE the window is opened (so a lost/timed-out launch is still discoverable) and
// updated with the window id + surface UUID on success. despawn closes by the surface UUID.
// claimed=true means the spawned agent itself confirmed this surfaceId (its own controlling tty →
// surface UUID). despawn only ever closes a claimed surface. surfaceId from the dispatcher is not used.
// HEADLESS launches (mode:"headless") have no window/surface: the record instead carries the exact pid
// the dispatcher spawned (plus the binary it launched + log file), and despawn terminates THAT pid only
// after verifying the live process still matches the recorded binary (see despawnAgent).
export type SpawnRecord = {
  windowId: string | null;
  surfaceId: string | null;
  launchId: string;
  tool: string;
  cwd: string;
  ts: number;
  claimed?: boolean;
  mode?: SpawnMode;
  pid?: number;
  /** The pid of the bus node that spawned this headless child — only that live process is its parent, so
   *  only it can prove ownership at despawn (see despawnHeadless). */
  spawnerPid?: number;
  bin?: string;
  outputFile?: string;
  exitCode?: number | null;
  exitedAt?: number;
};

// TWO writers, TWO files, never a shared read-modify-write: the DISPATCHER owns the main record
// (<launchId>.json — window id/tool/cwd), the spawned CHILD owns the claim (<launchId>.claim.json — its
// authoritative surface UUID). readRegistry merges them. Because neither writer touches the other's file,
// a concurrent dispatcher write and child claim can never clobber each other (an RMW on one shared file
// could, and temp+rename would not save it). A headless launch never writes a claim (its child has no
// surface, and gets no AGENTHOP_LAUNCH_ID — see HEADLESS_SCRUB_ENV).
type MainRecord = {
  windowId: string | null;
  launchId: string;
  tool: string;
  cwd: string;
  ts: number;
  mode?: SpawnMode;
  pid?: number;
  spawnerPid?: number;
  bin?: string;
  outputFile?: string;
  exitCode?: number | null;
  exitedAt?: number;
};
type ClaimRecord = { launchId: string; surfaceId: string; claimed: true };

function registryDir(home: string): string {
  return path.join(home, ".agenthop", "spawned");
}
function safeName(lid: string): string {
  return lid.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function mainFile(home: string, lid: string): string {
  return path.join(registryDir(home), `${safeName(lid)}.json`);
}
function claimFile(home: string, lid: string): string {
  return path.join(registryDir(home), `${safeName(lid)}.claim.json`);
}
function isMain(r: unknown): r is MainRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  const windowOk = o.windowId === null || typeof o.windowId === "string";
  const modeOk = o.mode === undefined || o.mode === "visible" || o.mode === "headless";
  const pidOk = o.pid === undefined || (typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0);
  const spawnerPidOk = o.spawnerPid === undefined || (typeof o.spawnerPid === "number" && Number.isInteger(o.spawnerPid) && o.spawnerPid > 0);
  if (!spawnerPidOk) return false;
  return typeof o.launchId === "string" && typeof o.tool === "string" && typeof o.cwd === "string" && windowOk && modeOk && pidOk;
}
function readClaim(home: string, lid: string): ClaimRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(claimFile(home, lid), "utf8")) as Record<string, unknown>;
    // A non-string surfaceId is a corrupt claim — ignore it rather than let despawn asEsc(<non-string>).
    if (r && typeof r === "object" && typeof r.surfaceId === "string" && r.claimed === true) return { launchId: lid, surfaceId: r.surfaceId, claimed: true };
  } catch {
    // no claim yet / malformed
  }
  return undefined;
}
function atomicWriteJson(p: string, data: unknown): boolean {
  const tmp = `${p}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, p); // atomic replace — a failed/partial write never truncates the existing file
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // leftover temp is harmless (readRegistry ignores *.tmp.*)
    }
    return false;
  }
}

export function readRegistry(home: string = homedir()): SpawnRecord[] {
  let files: string[];
  try {
    files = readdirSync(registryDir(home)).filter((f) => f.endsWith(".json") && !f.endsWith(".claim.json"));
  } catch {
    return []; // no dir yet
  }
  const out: SpawnRecord[] = [];
  for (const f of files) {
    try {
      const m = JSON.parse(readFileSync(path.join(registryDir(home), f), "utf8"));
      if (!isMain(m)) continue;
      const claim = readClaim(home, m.launchId); // merge the child's claim, if any
      out.push({
        windowId: m.windowId,
        launchId: m.launchId,
        tool: m.tool,
        cwd: m.cwd,
        ts: m.ts,
        surfaceId: claim?.surfaceId ?? null,
        claimed: claim?.claimed ?? false,
        mode: m.mode ?? "visible", // records from before headless existed are all visible launches
        pid: m.pid,
        spawnerPid: m.spawnerPid,
        bin: m.bin,
        outputFile: m.outputFile,
        exitCode: m.exitCode,
        exitedAt: m.exitedAt,
      });
    } catch {
      // skip a malformed / partially-written record
    }
  }
  return out;
}

/** Dispatcher-owned main record (window id/tool/cwd/ts + headless pid/bin/log). Never writes the
 *  child's claim fields. */
export function recordSpawn(rec: SpawnRecord, home: string = homedir()): boolean {
  return atomicWriteJson(mainFile(home, rec.launchId), {
    windowId: rec.windowId,
    launchId: rec.launchId,
    tool: rec.tool,
    cwd: rec.cwd,
    ts: rec.ts,
    ...(rec.mode !== undefined ? { mode: rec.mode } : {}),
    ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
    ...(rec.spawnerPid !== undefined ? { spawnerPid: rec.spawnerPid } : {}),
    ...(rec.bin !== undefined ? { bin: rec.bin } : {}),
    ...(rec.outputFile !== undefined ? { outputFile: rec.outputFile } : {}),
    ...(rec.exitCode !== undefined ? { exitCode: rec.exitCode } : {}),
    ...(rec.exitedAt !== undefined ? { exitedAt: rec.exitedAt } : {}),
  } satisfies MainRecord);
}

/** Child-owned claim: the authoritative surface UUID for this launch, in its OWN file (no RMW race). */
export function writeClaim(launchId: string, surfaceId: string, home: string = homedir()): boolean {
  return atomicWriteJson(claimFile(home, launchId), { launchId, surfaceId, claimed: true } satisfies ClaimRecord);
}

export function isSpawnedWindow(windowId: string, home: string = homedir()): boolean {
  return readRegistry(home).some((r) => r.windowId === windowId);
}
export function recordForWindow(windowId: string, home: string = homedir()): SpawnRecord | undefined {
  return readRegistry(home).find((r) => r.windowId === windowId);
}

/**
 * Resolve a despawn target from a caller-supplied handle, preferring the UNIQUE launchId (one file per
 * launch) so a reused window id can never pick the wrong record. Falls back to windowId, but a window id
 * shared by several records (the OS reused it across two of our launches) is reported as ambiguous
 * rather than silently resolved to the first.
 */
export function resolveDespawnTarget(handle: string, home: string = homedir()): { rec: SpawnRecord } | { error: string } | { ambiguous: SpawnRecord[] } {
  const all = readRegistry(home);
  const byLaunch = all.find((r) => r.launchId === handle); // launchId is the file key ⇒ at most one
  if (byLaunch) return { rec: byLaunch };
  const byWindow = all.filter((r) => r.windowId === handle);
  if (byWindow.length === 1) return { rec: byWindow[0]! };
  if (byWindow.length > 1) return { ambiguous: byWindow };
  return { error: `"${handle}" is not a window agenthop dispatched. agenthop only ever closes agents it spawned, never sessions you opened. (See agenthop_spawned for ids I can close.)` };
}
export function forgetSpawn(launchId: string, home: string = homedir()): void {
  for (const p of [mainFile(home, launchId), claimFile(home, launchId)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best effort
    }
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

function psTtyPpid(pid: number): Promise<{ tty?: string; ppid?: number }> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "tty=,ppid=", "-p", String(pid)], { timeout: 3000, encoding: "utf8" }, (err, stdout) => {
      if (err) return resolve({});
      const m = (stdout ?? "").trim().match(/^(\S+)\s+(\d+)$/);
      resolve(m ? { tty: m[1], ppid: Number(m[2]) } : {});
    });
  });
}

/** This process's controlling tty (e.g. "ttys008"), walking up ppid across the MCP/pipe boundary since
 *  a bus node's own stdio are pipes but it inherits the surface's controlling terminal. Undefined if none. */
async function controllingTty(pid: number, maxHops = 6): Promise<string | undefined> {
  let cur = pid;
  for (let i = 0; i < maxHops && cur > 1; i++) {
    const { tty, ppid } = await psTtyPpid(cur);
    if (tty && tty !== "??" && tty !== "?") return tty.trim();
    if (!ppid) break;
    cur = ppid;
  }
  return undefined;
}

/** Discover the Ghostty surface UUID this process runs in: controlling tty → the surface with that tty
 *  (requiring a UNIQUE match). This is authoritative — the process genuinely runs on that tty. */
async function discoverOwnSurfaceId(pid: number = process.pid): Promise<string | undefined> {
  const tty = await controllingTty(pid);
  if (!tty) return undefined;
  const dev = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  const r = await runOsascript(`tell application "Ghostty"
  set m to (terminals whose tty is "${asEsc(dev)}")
  if (count of m) is 1 then
    return id of (item 1 of m)
  else
    return ""
  end if
end tell`);
  const id = r.out.trim();
  return r.ok && id ? id : undefined;
}

export type ClaimOptions = { home?: string; env?: NodeJS.ProcessEnv; discover?: () => Promise<string | undefined>; launchId?: string };

/**
 * If this process was launched by agenthop_spawn, self-register (claimed=true) the Ghostty surface UUID
 * it actually runs in, on its own launch's claim file — the authoritative binding despawn requires. The
 * launchId is taken from opts.launchId, else this process's own AGENTHOP_LAUNCH_ID env (ancestor lookup
 * is done by startClaimRetry). Idempotent, best-effort. Returns whether a claim was written. `discover`
 * is injectable for tests.
 */
export async function claimOwnSpawn(opts: ClaimOptions = {}): Promise<boolean> {
  const lid = opts.launchId?.trim() || (opts.env ?? process.env).AGENTHOP_LAUNCH_ID?.trim();
  if (!lid) return false; // not a spawned session
  // The default discovery is macOS-only (osascript); off-macOS it returns undefined and we no-op.
  const surfaceId = await (opts.discover ?? discoverOwnSurfaceId)();
  if (!surfaceId) return false;
  // Write ONLY the claim file — never the dispatcher's main record — so the two writers never race.
  return writeClaim(lid, surfaceId, opts.home ?? homedir());
}

/**
 * Claim on startup with bounded retry. The launchId comes from this process's OWN env — each host
 * delivers it through a structured channel (Claude Code inherits the env into the MCP subprocess; Codex
 * needs `env_vars = ["AGENTHOP_LAUNCH_ID"]` in its mcp_servers config; the OpenCode plugin runs in the
 * server process, which inherits it). We deliberately do NOT scrape an ancestor's env: macOS `ps eww`
 * concatenates argv and env without clean delimiters, so a stale/unrelated occurrence could bind the
 * wrong launch. If this is not a spawned session it does nothing; otherwise it claims, retrying with
 * backoff while the surface/tty is not queryable yet (Ghostty settling / permissions), stopping on the
 * first success. Non-blocking; timers unref so they never keep the process alive.
 */
export function startClaimRetry(opts: ClaimOptions = {}): void {
  const lid = (opts.env ?? process.env).AGENTHOP_LAUNCH_ID?.trim();
  if (!lid) return; // not a spawned session (or the host did not deliver the id) → nothing to claim
  let attempt = 0;
  const tryOnce = (): void => {
    void claimOwnSpawn({ ...opts, launchId: lid }).then((ok) => {
      if (ok || attempt >= 5) return; // claimed, or gave up after ~1 min of backoff
      const timer = setTimeout(tryOnce, 1000 * 2 ** attempt++);
      if (typeof timer.unref === "function") timer.unref();
    });
  };
  tryOnce();
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

/** Validate + canonicalize a working directory. The PHYSICAL path matters: codex keys folder-trust on
 *  the realpath, so a /tmp alias or symlinked cwd would otherwise escape the trust entry. */
function validateCwd(raw: string | undefined): { cwd: string } | { error: string } {
  const cwd = raw && raw.trim() ? path.resolve(raw) : process.cwd();
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(cwd);
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }
  if (!st.isDirectory()) return { error: `cwd is not a directory: ${cwd}` };
  try {
    return { cwd: realpathSync(cwd) };
  } catch {
    return { cwd }; // keep the resolved path if realpath fails (e.g. permissions) — trust may not match, but safe
  }
}

/** Launch a visible sub-agent window and best-effort move it to a workspace. */
export async function spawnAgent(input: SpawnInput, env: NodeJS.ProcessEnv = process.env): Promise<SpawnResult> {
  if (input.visible === false) return spawnHeadlessAgent(input, env);
  const cli = resolveCli(input.tool, env);
  if ("error" in cli) return { ok: false, arranged: false, note: cli.error };
  // herdr backend (S14): when the dispatcher runs INSIDE a herdr pane and the server is reachable, launch the
  // agent as a herdr pane (JSON receipt + lifecycle states) instead of blind-typing Ghostty. Any miss falls
  // through to the Ghostty path below — the two backends coexist, Ghostty is not removed.
  if (herdrSpawnable(env) && (await herdrServerReachable())) {
    const name = herdrAgentName(input.workspace ?? input.tool);
    const r = await herdrLaunch({ name, kind: input.tool, cwd: input.cwd ?? homedir(), args: cli.argv.slice(1) });
    if (r.ok) return { ok: true, mode: "visible", arranged: false, launchId: r.name, note: `herdr: ${r.note} (pane ${r.paneId}, agent ${r.name})` };
    console.error(`[spawn] herdr backend miss (${r.note}); falling back to Ghostty.`);
  }
  if (platform() !== "darwin") return { ok: false, arranged: false, note: "agenthop_spawn (visible) currently supports macOS + Ghostty only. Try visible:false for a headless background run." };
  if (!ghosttyPresent()) return { ok: false, arranged: false, note: "Ghostty.app not found; a visible agenthop_spawn needs Ghostty. Try visible:false for a headless background run." };
  const dir = validateCwd(input.cwd);
  if ("error" in dir) return { ok: false, arranged: false, note: dir.error };
  const cwd = dir.cwd;

  const lid = launchId(input.tool);
  // codex: per-invocation `-c` overrides — pre-trust this folder (no global config write) AND set
  // AGENTHOP_LAUNCH_ID in the agenthop MCP subprocess's env so this session can self-register its window.
  const argv = input.tool === "codex" ? [cli.argv[0]!, ...codexTrustArgs(cwd), ...codexEnvForwardArgs(lid), ...cli.argv.slice(1)] : cli.argv;
  const command = buildCommand(argv);
  // Inject PATH/HOME (so the CLI finds node etc. under the GUI launch env) + the launch id. Inherited
  // identity is stripped by `env -u` in the command (see buildCommand / SCRUB_ENV).
  const injectEnv = [`PATH=${env.PATH ?? ""}`, `HOME=${env.HOME ?? homedir()}`, `AGENTHOP_LAUNCH_ID=${lid}`];

  // Record the launch REQUEST before any side effect, so a window opened but not confirmed (lost or
  // timed-out AppleScript reply) is still discoverable in agenthop_spawned rather than a silent orphan.
  // If we cannot even record it, do NOT open a window — an untracked window despawn could never close.
  if (!recordSpawn({ windowId: null, surfaceId: null, launchId: lid, tool: input.tool, cwd, ts: Date.now(), mode: "visible" })) {
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
  // Fill in the window id on the dispatcher's OWN main record — but only if the pending record still
  // exists. If a despawn already tore this launch down (main+claim removed) while the create ACK was in
  // flight, do NOT resurrect an unclaimed ghost record that could never be cleared. The child's claim is
  // a separate file, so this write can never clobber a claim (no shared read-modify-write).
  let recordOk = true;
  if (windowId && readRegistry().some((rec) => rec.launchId === lid)) {
    recordOk = recordSpawn({ windowId, surfaceId: null, launchId: lid, tool: input.tool, cwd, ts: Date.now(), mode: "visible" });
  }

  const workspace = (input.workspace && input.workspace.trim()) || env.AGENTHOP_SPAWN_WORKSPACE?.trim();
  const warn = !windowId
    ? ` (Ghostty returned no window id — launchId ${lid}.)`
    : !recordOk
      ? ` (warning: could not persist the window record, so agenthop_despawn may not find it — launchId ${lid}.)`
      : "";
  // A visible session is interactive: a `task` is NOT auto-typed into it — deliver it over the bus with
  // agenthop_handoff once the session appears in agenthop_peers (deliberate: handoff is the one richer,
  // auditable channel; auto-typing into a visible TUI would be a second, flakier one).
  const taskNote = input.task?.trim() ? ` You passed a task: a visible session does not auto-receive it — send it with agenthop_handoff when the session shows up in agenthop_peers.` : "";
  const tail = `It will appear in agenthop_peers shortly and self-confirm its window for despawn once it's up; use agenthop_handoff to give it a task.${taskNote}${warn}`;
  const base = { mode: "visible" as const, windowId, launchId: lid };
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

// --- Headless spawn -------------------------------------------------------------------------------
// visible:false — no window: a DETACHED run of the tool's native non-interactive mode with `task` as
// the prompt. RESULT CHANNEL (decided): the parent captures stdout/stderr into a per-launch log file
// (<registry>/<launchId>.out.log) as the GUARANTEED channel — it needs zero cooperation from the child.
// Joining the bus is a best-effort BONUS, not the result channel: when the tool's own config registers
// the agenthop MCP, the headless run loads it like any session and appears in agenthop_peers (and the
// task can ask it to agenthop_send its result back) — but that depends on per-machine config and on the
// model complying, so it is ASSUMED/UNVERIFIED and never relied on. The child's env is scrubbed with
// HEADLESS_SCRUB_ENV: identity vars so it never mis-joins as the dispatcher, and AGENTHOP_LAUNCH_ID so
// a detached child can never tty-walk into claiming the DISPATCHER's surface (see HEADLESS_SCRUB_ENV).

function headlessOutputFile(home: string, lid: string): string {
  return path.join(registryDir(home), `${safeName(lid)}.out.log`);
}

type Launched = { pid: number; child: ReturnType<typeof spawn> };

/** Start a detached child with stdout+stderr appended to `outFile`. Resolves once the OS accepted or
 *  rejected the spawn (the 'spawn'/'error' event), so a bad binary is a clean error, not a crash. */
function launchDetached(argv: string[], cwd: string, outFile: string, env: NodeJS.ProcessEnv): Promise<Launched | { error: string }> {
  let fd: number;
  try {
    mkdirSync(path.dirname(outFile), { recursive: true });
    fd = openSync(outFile, "a");
  } catch (e) {
    return Promise.resolve({ error: `cannot open the output log ${outFile}: ${String(e)}` });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Launched | { error: string }): void => {
      if (settled) return;
      settled = true;
      try {
        closeSync(fd); // the child holds its own dup of the fd
      } catch {
        // already closed
      }
      resolve(r);
    };
    try {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
      child.once("error", (e) => finish({ error: String(e) }));
      child.once("spawn", () => (child.pid ? finish({ pid: child.pid, child }) : finish({ error: "spawned but no pid reported" })));
    } catch (e) {
      finish({ error: String(e) });
    }
  });
}

/** Record the exit on the launch record (exit code + time) so agenthop_spawned shows it as finished —
 *  unless a despawn already removed the record (never resurrect a forgotten launch). unref'd. */
function watchHeadlessExit(child: ReturnType<typeof spawn>, rec: SpawnRecord, home: string): void {
  child.once("exit", (code) => {
    headlessChildren.delete(rec.launchId); // the handle is dead — despawn now reports "already exited"
    if (!readRegistry(home).some((r) => r.launchId === rec.launchId)) return;
    recordSpawn({ ...rec, exitCode: code ?? null, exitedAt: Date.now() }, home);
  });
  child.unref();
}

/**
 * Launch a HEADLESS (no window) one-shot run of the tool's non-interactive mode, detached, with the
 * task as its prompt. Output goes to a per-launch log file; the record (pid, bin, log) goes to the same
 * split-file registry despawn trusts. `task` injection note: the task is a positional argv element
 * (never shell-interpreted), and the caller already controls tool/cwd/flags, so a task starting with
 * "-" can at most pass a flag to a CLI the caller fully controls anyway — not a privilege boundary.
 */
export async function spawnHeadlessAgent(input: SpawnInput, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<SpawnResult> {
  const task = input.task?.trim();
  if (!task) return { ok: false, arranged: false, mode: "headless", note: "A headless spawn needs a `task`: it is a one-shot non-interactive run and the task is its prompt. Pass task, or spawn visible and use agenthop_handoff." };
  const cli = resolveCli(input.tool, env);
  if ("error" in cli) return { ok: false, arranged: false, mode: "headless", note: cli.error };
  const dir = validateCwd(input.cwd);
  if ("error" in dir) return { ok: false, arranged: false, mode: "headless", note: dir.error };
  const cwd = dir.cwd;
  // codex: same per-invocation folder-trust as visible (no global config write). No launch-id env
  // forward — a headless child must never claim a surface (see HEADLESS_SCRUB_ENV).
  const withTrust = input.tool === "codex" ? [cli.argv[0]!, ...codexTrustArgs(cwd), ...cli.argv.slice(1)] : cli.argv;
  const h = headlessArgv(input.tool, withTrust, task, env);
  if ("error" in h) return { ok: false, arranged: false, mode: "headless", note: h.error };

  const lid = launchId(input.tool);
  const outputFile = headlessOutputFile(home, lid);
  const pending: SpawnRecord = { windowId: null, surfaceId: null, launchId: lid, tool: input.tool, cwd, ts: Date.now(), mode: "headless", spawnerPid: process.pid, bin: cli.argv[0]!, outputFile };
  // Record BEFORE launching: an untracked process could never be despawned, so if we cannot record,
  // we do not launch (mirrors the visible flow).
  if (!recordSpawn(pending, home)) {
    return { ok: false, arranged: false, mode: "headless", launchId: lid, note: `Could not write a launch record under ~/.agenthop/spawned; not launching (an untracked process could never be despawned). Check that ~/.agenthop is writable.` };
  }
  const launched = await launchDetached(h.argv, cwd, outputFile, scrubbedEnv(env));
  if ("error" in launched) {
    forgetSpawn(lid, home); // nothing is running — a dead pending record would only confuse despawn
    return { ok: false, arranged: false, mode: "headless", launchId: lid, note: `Could not launch ${input.tool} headless: ${launched.error}` };
  }
  const rec: SpawnRecord = { ...pending, pid: launched.pid };
  const recorded = recordSpawn(rec, home);
  headlessChildren.set(lid, launched.child); // the live handle is the ONLY thing despawn will kill through
  watchHeadlessExit(launched.child, rec, home);
  const warn = recorded ? "" : ` (warning: could not persist the pid on the record, so agenthop_despawn may refuse this launch — launchId ${lid}.)`;
  return {
    ok: true,
    arranged: false,
    mode: "headless",
    launchId: lid,
    pid: launched.pid,
    outputFile,
    note:
      `Launched ${input.tool} HEADLESS (no window, pid ${launched.pid}, launchId ${lid}) in its native non-interactive mode with your task as the prompt. ` +
      `Its full output streams to ${outputFile} — read that file for the result; agenthop_spawned shows when it exits, agenthop_despawn(launchId) stops it early. ` +
      `If this machine's ${input.tool} config registers the agenthop MCP, the run may also appear in agenthop_peers and can be asked (in the task) to report back via agenthop_send — best-effort only, the log file is the guaranteed channel.${warn}`,
  };
}

// --- Headless despawn ------------------------------------------------------------------------------

// Live ChildProcess handles for headless launches made by THIS bus node — the ONLY authority to kill one.
// Node binds a handle to the exact child it spawned: after that child exits, handle.kill() is a no-op and can
// NEVER signal a pid the OS has since reused. So we never kill by a bare recorded pid (a ps / kill(pid,0)
// snapshot is racy — the pid can be reused between the check and the signal). Keyed by launchId; set at launch,
// deleted on exit/despawn.
const headlessChildren = new Map<string, ReturnType<typeof spawn>>();

const childExited = (child: ReturnType<typeof spawn>): boolean => child.exitCode !== null || child.signalCode !== null;

/** Resolve once the child has exited (by its OWN handle state — never a reusable pid), or after `ms`. */
function waitChildExit(child: ReturnType<typeof spawn>, ms: number): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(childExited(child));
    }, ms);
    child.once("exit", onExit);
  });
}

/**
 * Terminate a HEADLESS launch — and ONLY the exact child agenthop launched. The authority is the in-memory
 * ChildProcess HANDLE (headlessChildren), never the recorded pid: Node ties the handle to that specific
 * child, so a signal through it can never hit a pid the OS reused, and once the child exits handle.kill() is
 * inert. No handle ⇒ this node did not launch it (another session did, or this node restarted and the
 * detached child reparented away) ⇒ REFUSE rather than risk a bare-pid signal — a one-shot headless run
 * exits on its own. The detached child leads its own process GROUP; we also signal the group (-pid) but ONLY
 * while the leader's exitCode is still null, so even the group signal can never land on a reused pid. A
 * helper the CLI re-parented into a NEW group before our SIGKILL is the lone residual (same class as
 * visible-mode lifecycle edges) — reported honestly, not silently claimed killed.
 */
async function despawnHeadless(rec: SpawnRecord, home: string): Promise<{ ok: boolean; note: string }> {
  const out = rec.outputFile ? ` Its output log is kept at ${rec.outputFile}.` : "";
  const child = headlessChildren.get(rec.launchId);
  if (!child) {
    // No live handle in THIS node. Probe existence with signal 0 (harmless — it can never affect the target):
    // if the recorded pid is gone (ESRCH), the record is a dead orphan we can safely forget; if it is still
    // alive we must NOT signal it (we hold no handle ⇒ cannot prove it is ours and a bare pid may be reused).
    if (rec.pid) {
      try {
        process.kill(rec.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          forgetSpawn(rec.launchId, home);
          return { ok: true, note: `That headless ${rec.tool} run is already gone; removed its record, killed nothing.${out}` };
        }
        // EPERM etc: alive but unsignalable by us ⇒ definitely not our child ⇒ fall through to refuse.
      }
    }
    return { ok: false, note: `agenthop can stop a headless run only from the SAME bus node that launched it, and this node holds no live handle for ${rec.launchId} (another session launched it, or this node restarted). Signalling a bare recorded pid is unsafe — it may have been reused — so nothing was killed; the one-shot ${rec.tool} run exits on its own. Record kept.${out}` };
  }
  if (childExited(child)) {
    headlessChildren.delete(rec.launchId);
    forgetSpawn(rec.launchId, home);
    return { ok: true, note: `That headless ${rec.tool} run already exited (code ${child.exitCode ?? `signal ${child.signalCode}`}); removed its record, killed nothing.${out}` };
  }
  // Signal ONLY through the ChildProcess HANDLE — this is the airtight path: Node binds the handle to this
  // exact child, so a signal through it can NEVER reach a reused pid and is a no-op once the child has exited.
  // We deliberately do NOT send a process-GROUP signal (process.kill(-pid)): a bare -pid is not handle-bound,
  // and on some runtimes (e.g. Bun) the handle's exitCode can still read null at the instant of exit, so -pid
  // could momentarily land on a reused pid — a risk the #1 rule forbids. Managed-process cancel (airtight) is
  // kept SEPARATE from group cleanup (which we do not guarantee): a sub-process the CLI spawned that OUTLIVES
  // its parent — whether it ignored SIGTERM in the original group or re-parented to a new one — is NOT
  // force-killed (rare for a one-shot run, which exits with its children). Reported honestly, never claimed clean.
  child.kill("SIGTERM");
  let ended = await waitChildExit(child, 2000);
  if (!ended) {
    child.kill("SIGKILL");
    ended = await waitChildExit(child, 2000);
  }
  if (!ended) {
    return { ok: false, note: `Sent SIGTERM then SIGKILL to the ${rec.tool} run's process handle but pid ${child.pid} is still alive; agenthop could not terminate it. Record kept — stop it manually.${out}` };
  }
  headlessChildren.delete(rec.launchId);
  forgetSpawn(rec.launchId, home);
  return { ok: true, note: `Stopped the headless ${rec.tool} run's main process (launchId ${rec.launchId}, pid ${child.pid}). agenthop signals only the exact process it launched — a sub-process that CLI spawned and that outlives it is not force-killed.${out}` };
}

export type DespawnOptions = { home?: string };

/**
 * Tear down something agenthop spawned — and ONLY that. `handle` is the launchId (unique) or the
 * window id agenthop_spawn returned; a window id shared by several records is reported as ambiguous
 * (pick a launchId) rather than silently resolved.
 *   - VISIBLE launch: closes by the recorded Ghostty surface UUID (unique, never reused, claimed by
 *     the child itself). A user window that reused the window id has a different surface UUID and is
 *     never matched; a split/tab the user added to our window survives. If the surface is gone,
 *     nothing is closed. Never closes by the reusable window id.
 *   - HEADLESS launch: terminates exactly the recorded pid, after verifying the live process still
 *     matches the recorded launch (see despawnHeadless). Never kills by name, never a reused pid.
 */
export async function despawnAgent(handle: string, opts: DespawnOptions = {}): Promise<{ ok: boolean; note: string }> {
  const home = opts.home ?? homedir();
  const key = handle.trim();
  if (!key) return { ok: false, note: "No window id or launch id given." };
  const target = resolveDespawnTarget(key, home);
  if ("error" in target) return { ok: false, note: target.error };
  if ("ambiguous" in target) {
    const ids = target.ambiguous.map((r) => r.launchId).join(", ");
    return { ok: false, note: `Window id "${key}" matches ${target.ambiguous.length} spawned records (its id was reused across launches). Despawn one by its launch id instead: ${ids}. (See agenthop_spawned.)` };
  }
  const rec = target.rec;
  if (rec.mode === "headless") return despawnHeadless(rec, home);
  if (platform() !== "darwin") return { ok: false, note: "agenthop_despawn of a visible window currently supports macOS + Ghostty only." };
  if (!rec.claimed || !rec.surfaceId) {
    // The agent has not self-confirmed which surface it runs in (still starting up, or killed before it
    // could). We will NOT fall back to closing by the reusable window id.
    return { ok: false, note: `Cannot close "${key}" yet: the spawned agent has not confirmed its own window (launchId ${rec.launchId}). agenthop only closes a surface the agent itself claimed — wait a moment for it to come up and retry, or close it manually. The record is kept.` };
  }
  const res = await closeSurface(rec.surfaceId);
  if (res === "closed") {
    forgetSpawn(rec.launchId, home);
    return { ok: true, note: `Closed the spawned terminal (launchId ${rec.launchId}).` };
  }
  if (res === "absent") {
    forgetSpawn(rec.launchId, home);
    return { ok: true, note: `That spawned terminal is already gone; removed its record. (Closed nothing.)` };
  }
  return { ok: false, note: `Could not close the spawned terminal (launchId ${rec.launchId}): Ghostty unreachable or permission denied. Record kept; retry once reachable.` };
}
