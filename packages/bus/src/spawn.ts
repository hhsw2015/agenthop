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

function ghosttyPresent(): boolean {
  return existsSync("/Applications/Ghostty.app") || existsSync(path.join(homedir(), "Applications", "Ghostty.app"));
}

// --- Spawn registry: the ONLY surfaces despawn may close ------------------------------------------
// One file per launch under ~/.agenthop/spawned/<launchId>.json, so concurrent spawns from different
// bus sessions never lose each other's records to a shared read-modify-write. A record is written with
// windowId=null BEFORE the window is opened (so a lost/timed-out launch is still discoverable) and
// updated with the window id + surface UUID on success. despawn closes by the surface UUID.
// claimed=true means the spawned agent itself confirmed this surfaceId (its own controlling tty →
// surface UUID). despawn only ever closes a claimed surface. surfaceId from the dispatcher is not used.
export type SpawnRecord = { windowId: string | null; surfaceId: string | null; launchId: string; tool: string; cwd: string; ts: number; claimed?: boolean };

// TWO writers, TWO files, never a shared read-modify-write: the DISPATCHER owns the main record
// (<launchId>.json — window id/tool/cwd), the spawned CHILD owns the claim (<launchId>.claim.json — its
// authoritative surface UUID). readRegistry merges them. Because neither writer touches the other's file,
// a concurrent dispatcher write and child claim can never clobber each other (an RMW on one shared file
// could, and temp+rename would not save it).
type MainRecord = { windowId: string | null; launchId: string; tool: string; cwd: string; ts: number };
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
  return typeof o.launchId === "string" && typeof o.tool === "string" && typeof o.cwd === "string" && windowOk;
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
      out.push({ windowId: m.windowId, launchId: m.launchId, tool: m.tool, cwd: m.cwd, ts: m.ts, surfaceId: claim?.surfaceId ?? null, claimed: claim?.claimed ?? false });
    } catch {
      // skip a malformed / partially-written record
    }
  }
  return out;
}

/** Dispatcher-owned main record (window id/tool/cwd/ts). Never writes the child's claim fields. */
export function recordSpawn(rec: SpawnRecord, home: string = homedir()): boolean {
  return atomicWriteJson(mainFile(home, rec.launchId), { windowId: rec.windowId, launchId: rec.launchId, tool: rec.tool, cwd: rec.cwd, ts: rec.ts } satisfies MainRecord);
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

function psEnv(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", ["eww", "-p", String(pid)], { timeout: 3000, maxBuffer: 4 << 20, encoding: "utf8" }, (err, stdout) => resolve(err ? "" : (stdout ?? "")));
  });
}

/**
 * The AGENTHOP_LAUNCH_ID for this session: our own env if present, else an ANCESTOR's env (read via
 * `ps eww`). Codex clears its MCP subprocess env (so our bus node's own env loses it), but the codex CLI
 * ancestor still carries the value we injected into the window — so an ancestor walk recovers it without
 * any per-tool config forwarding. Undefined when this is not a spawned session.
 */
async function discoverLaunchId(env: NodeJS.ProcessEnv, pid: number, maxHops = 6): Promise<string | undefined> {
  const own = env.AGENTHOP_LAUNCH_ID?.trim();
  if (own) return own;
  let cur = pid;
  for (let i = 0; i < maxHops && cur > 1; i++) {
    const out = await psEnv(cur);
    const m = out.match(/AGENTHOP_LAUNCH_ID=(agenthop-spawn:[^\s]+)/);
    if (m) return m[1];
    const { ppid } = await psTtyPpid(cur);
    if (!ppid) break;
    cur = ppid;
  }
  return undefined;
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
 * Claim on startup with bounded retry. First it resolves the launchId (own env, else an ancestor's env
 * via ps eww — so it works even when codex clears the MCP subprocess env); if this is not a spawned
 * session it does nothing. Then it claims, retrying with backoff if the surface/tty is not queryable yet
 * (Ghostty still settling, permissions warming up), stopping on the first success. Non-blocking; timers
 * unref so they never keep the process alive.
 */
export function startClaimRetry(opts: ClaimOptions = {}): void {
  const env = opts.env ?? process.env;
  void discoverLaunchId(env, process.pid).then((lid) => {
    if (!lid) return; // not a spawned session → nothing to claim, no retries
    let attempt = 0;
    const tryOnce = (): void => {
      void claimOwnSpawn({ ...opts, launchId: lid }).then((ok) => {
        if (ok || attempt >= 5) return; // claimed, or gave up after ~1 min of backoff
        const timer = setTimeout(tryOnce, 1000 * 2 ** attempt++);
        if (typeof timer.unref === "function") timer.unref();
      });
    };
    tryOnce();
  });
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
  const windowId = r.out.trim() || undefined;
  // Fill in the window id on the dispatcher's OWN main record. The child's claim lives in a separate
  // file, so this write can never clobber a claim that already arrived (no shared read-modify-write).
  let recordOk = true;
  if (windowId) {
    recordOk = recordSpawn({ windowId, surfaceId: null, launchId: lid, tool: input.tool, cwd, ts: Date.now() });
  }

  const workspace = (input.workspace && input.workspace.trim()) || env.AGENTHOP_SPAWN_WORKSPACE?.trim();
  const warn = !windowId
    ? ` (Ghostty returned no window id — launchId ${lid}.)`
    : !recordOk
      ? ` (warning: could not persist the window record, so agenthop_despawn may not find it — launchId ${lid}.)`
      : "";
  const tail = `It will appear in agenthop_peers shortly and self-confirm its window for despawn once it's up; use agenthop_handoff to give it a task.${warn}`;
  const base = { windowId, launchId: lid } as const;
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
 * Close a surface agenthop spawned — and ONLY that surface. `handle` is the launchId (unique) or the
 * window id agenthop_spawn returned; a window id shared by several records is reported as ambiguous
 * (pick a launchId) rather than silently resolved. Closes by the recorded Ghostty surface UUID (unique,
 * never reused, captured from a single-terminal snapshot at creation). A user window that reused the
 * window id has a different surface UUID and is never matched; a split/tab the user added to our window
 * survives. If the surface is gone, nothing is closed. Never closes by the reusable window id.
 */
export async function despawnAgent(handle: string, opts: DespawnOptions = {}): Promise<{ ok: boolean; note: string }> {
  const home = opts.home ?? homedir();
  const key = handle.trim();
  if (!key) return { ok: false, note: "No window id or launch id given." };
  if (platform() !== "darwin") return { ok: false, note: "agenthop_despawn currently supports macOS + Ghostty only." };
  const target = resolveDespawnTarget(key, home);
  if ("error" in target) return { ok: false, note: target.error };
  if ("ambiguous" in target) {
    const ids = target.ambiguous.map((r) => r.launchId).join(", ");
    return { ok: false, note: `Window id "${key}" matches ${target.ambiguous.length} spawned records (its id was reused across launches). Despawn one by its launch id instead: ${ids}. (See agenthop_spawned.)` };
  }
  const rec = target.rec;
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
