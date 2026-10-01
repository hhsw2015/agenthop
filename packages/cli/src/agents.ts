import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { t } from "./lang.js";
import { opencodePluginJs } from "./opencode-plugin-text.js";

/**
 * The agents agenthop knows how to plug into as an MCP server. `install` finds the ones on this
 * machine and prints how to register it with each — writing into another tool's configuration
 * is a lasting change, so it only does that when asked by name (`--mcp <agent>`).
 *
 * OpenCode is the exception: an MCP subprocess there gets no session id or server url, so it can't
 * auto-surface an inbound message. Its bus node is a server PLUGIN instead — the same one embedded
 * in this program (opencode-plugin-text.ts) — so "registering" OpenCode means writing that plugin
 * file, not editing an mcpServers block.
 */

export const AGENT_IDS = ["claude", "grok", "codex", "cursor", "gemini", "opencode"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

type Agent = {
  id: AgentId;
  name: string;
  present(home: string): boolean;
  /** What a person would run or paste to register agenthop. */
  hint(bin: string, home: string): string;
  /** Do it. Returns what changed, in words. */
  register(bin: string, home: string): string;
};

const SERVER = "agenthop";

const agents: Agent[] = [
  {
    id: "claude",
    name: "Claude Code",
    present: (home) => existsSync(join(home, ".claude")) || onPath("claude"),
    hint: (bin) => `claude mcp add --scope user ${SERVER} -- ${quote(bin)} mcp   (+ status hooks in ~/.claude/settings.json)`,
    register: (bin, home) => {
      const mcp = run("claude", ["mcp", "add", "--scope", "user", SERVER, "--", bin, "mcp"], "Claude Code");
      let hooks: string;
      try {
        hooks = installClaudeStatusHooks(bin, home);
      } catch (error) {
        hooks = t(`status hooks not installed (${error instanceof Error ? error.message : String(error)}); add them by hand`, `状态 hook 没装上（${error instanceof Error ? error.message : String(error)}），手动加`);
      }
      return `${mcp}; ${hooks}`;
    },
  },
  {
    id: "grok",
    name: "grok",
    present: (home) => existsSync(join(home, ".grok")) || onPath("grok"),
    hint: (bin) => `grok mcp add --scope user ${SERVER} ${quote(bin)} -- mcp`,
    register: (bin) => run("grok", ["mcp", "add", "--scope", "user", SERVER, bin, "--", "mcp"], "grok"),
  },
  {
    id: "codex",
    name: "Codex",
    present: (home) => existsSync(join(home, ".codex")) || onPath("codex"),
    hint: (bin, home) => t(`Add to ${join(home, ".codex", "config.toml")}:\n${codexBlock(bin)}\n(+ status hooks in ~/.codex/hooks.json, with [features] hooks = true)`, `在 ${join(home, ".codex", "config.toml")} 里加上：\n${codexBlock(bin)}\n（外加 ~/.codex/hooks.json 里的状态 hook，并 [features] hooks = true）`),
    register: (bin, home) => {
      const file = join(home, ".codex", "config.toml");
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      // The MCP block is only ever APPENDED (no fragile TOML rewriting of an existing one). A spawned Codex
      // still gets AGENTHOP_LAUNCH_ID forwarded per-launch via `codex -c mcp_servers.agenthop.env.…` (spawn.ts).
      let mcp: string;
      if (/^\[mcp_servers\.agenthop\]/m.test(existing)) {
        mcp = t(`${file} already has agenthop`, `${file} 里已有 agenthop`);
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${codexBlock(bin)}\n`);
        mcp = t(`written to ${file}`, `已写入 ${file}`);
      }
      let hooks: string;
      try {
        hooks = installCodexStatusHooks(bin, home);
      } catch (error) {
        hooks = t(`status hooks not installed (${error instanceof Error ? error.message : String(error)}); add them by hand`, `状态 hook 没装上（${error instanceof Error ? error.message : String(error)}），手动加`);
      }
      return `${mcp}; ${hooks}`;
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    present: (home) => existsSync(join(home, ".cursor")),
    hint: (bin, home) => t(`Add to mcpServers in ${join(home, ".cursor", "mcp.json")}: ${JSON.stringify(entry(bin))}`, `在 ${join(home, ".cursor", "mcp.json")} 的 mcpServers 里加上：${JSON.stringify(entry(bin))}`),
    register: (bin, home) => mergeJson(join(home, ".cursor", "mcp.json"), bin),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    present: (home) => existsSync(join(home, ".gemini")) || onPath("gemini"),
    hint: (bin, home) => t(`Add to mcpServers in ${join(home, ".gemini", "settings.json")}: ${JSON.stringify(entry(bin))}`, `在 ${join(home, ".gemini", "settings.json")} 的 mcpServers 里加上：${JSON.stringify(entry(bin))}`),
    register: (bin, home) => mergeJson(join(home, ".gemini", "settings.json"), bin),
  },
  {
    id: "opencode",
    name: "OpenCode",
    present: (home) => existsSync(opencodeConfigDir(home)),
    hint: (_bin, home) => t(`Write the bus plugin to ${opencodePluginPath(home)} (OpenCode auto-loads it)`, `把总线插件写到 ${opencodePluginPath(home)}（OpenCode 会自动加载）`),
    register: (_bin, home) => writeOpencodePlugin(home),
  },
];

/**
 * OpenCode's config directory. OpenCode resolves it through XDG (XDG_CONFIG_HOME, else ~/.config),
 * so we must too — otherwise, with XDG_CONFIG_HOME set, we would write the plugin where OpenCode
 * never looks and the refresh check would miss the real one.
 */
export function opencodeConfigDir(home = homedir()): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "opencode");
}

/** Where the OpenCode bus plugin lives. OpenCode auto-loads every *.js under this directory. */
export function opencodePluginPath(home = homedir()): string {
  return join(opencodeConfigDir(home), "plugin", "agenthop-bus.js");
}

/**
 * Write (or refresh) the embedded OpenCode bus plugin. Idempotent — it is our own file. Written to a
 * sibling temp then renamed into place, so a short or failed write never truncates a working plugin,
 * and a symlink at the destination is replaced rather than its target overwritten. Same idiom as
 * placeCommand()/setTeam().
 */
export function writeOpencodePlugin(home = homedir()): string {
  const file = opencodePluginPath(home);
  mkdirSync(dirname(file), { recursive: true });
  const staged = `${file}.new`;
  rmSync(staged, { force: true });
  writeFileSync(staged, opencodePluginJs);
  try {
    renameSync(staged, file);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  return t(`written to ${file}`, `已写入 ${file}`);
}

/** How to register agenthop with each agent found here, or with all of them if none is. */
export function mcpHints(bin: string, home = homedir()): string[] {
  const found = agents.filter((agent) => agent.present(home));
  return (found.length > 0 ? found : agents).map((agent) => `  ${agent.name}${t(": ", "：")}${agent.hint(bin, home).replace(/\n/g, "\n    ")}`);
}

export function registerMcp(ids: string[], bin: string, home = homedir()): string[] {
  return ids.map((id) => {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) return t(`Unknown agent: ${id}. It can be ${AGENT_IDS.join(", ")}.`, `不认识的 agent：${id}。可以是 ${AGENT_IDS.join("、")}。`);
    try {
      return `${agent.name}${t(": ", "：")}${agent.register(bin, home)}`;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return t(`${agent.name}: not written (${why}). Do it by hand: ${agent.hint(bin, home)}`, `${agent.name}：没有写成（${why}）。手动做：${agent.hint(bin, home)}`);
    }
  });
}

function entry(bin: string) {
  return { [SERVER]: { command: bin, args: ["mcp"] } };
}

/**
 * Install Claude Code hooks that auto-report this session's work state to the bus (Phase 3 slice B):
 * UserPromptSubmit→working, Stop→idle, PermissionRequest→blocked (the instant approval signal). All are
 * async fire-and-forget and side-effect-only (output suppressed, `|| true`), so they can never block a
 * turn, inject context, or fail. `agenthop report-status` reads CLAUDE_CODE_SESSION_ID from the hook env.
 * Idempotent: skips any event that already has an agenthop status hook; preserves the user's other hooks
 * and the rest of settings.json (parse → merge → atomic write). ~/.claude/settings.json is JSON, so this
 * is a safe structured edit (unlike codex's TOML). Returns what changed.
 *
 * Known limitations (inherent to the hook set, documented, not bugs):
 *  - There is no "unblocked"/"interrupted" hook event, so `blocked` clears at the NEXT turn boundary
 *    (Stop / UserPromptSubmit), not the instant approval is granted. Spawned sub-agents run unattended
 *    (no permission prompts) so they rarely enter `blocked` at all.
 *  - `/clear` changes a session's id but the already-running MCP bus node keeps its startup id, so
 *    status auto-updates stop until the session/MCP restarts — a pre-existing identity-model limit, not
 *    specific to hooks.
 */
export function installClaudeStatusHooks(bin: string, home = homedir()): string {
  const file = join(home, ".claude", "settings.json");
  const config = readJsonConfig(file); // throws (file left alone) if present but not plain JSON
  // working on prompt-submit and after each tool (the latter recovers from `blocked` once an approval's tool
  // runs — success or failure — there is no dedicated "unblocked" event); idle on stop, including a turn that
  // ended on an API error (StopFailure) so it never sticks at `working`; blocked the instant an approval is
  // requested. (All event names verified against the Claude Code hooks reference.)
  const events = [
    { event: "UserPromptSubmit", state: "working" },
    { event: "PostToolUse", state: "working" },
    { event: "PostToolUseFailure", state: "working" },
    { event: "Stop", state: "idle" },
    { event: "StopFailure", state: "idle" },
    { event: "PermissionRequest", state: "blocked" },
  ];
  const changed = mergeStatusHookEvents(config, events, bin, (command) => ({ hooks: [{ type: "command", command, async: true }] }));
  if (changed === 0) return t(`${file} already has agenthop status hooks; nothing changed`, `${file} 里已有 agenthop 状态 hook，没有改动`);
  placeJson(file, config);
  return t(`wrote ${changed} status hook change(s) to ${file}`, `已写 ${changed} 处状态 hook 改动到 ${file}`);
}

/**
 * Install Codex status hooks (Phase 3 slice B). Codex adopted Claude Code's hook system verbatim: a JSON
 * $CODEX_HOME/hooks.json with the SAME schema, but the payload arrives on STDIN (field session_id, which
 * equals the bus stableId — see docs/research/codex-opencode-hooks.md); report-status reads it from stdin.
 * The command is otherwise identical (shared builder). Codex has no StopFailure/PostToolUseFailure but DOES
 * have Interrupt, so Interrupt→idle clears a lingering `blocked`. Also enables `[features] hooks = true`.
 *
 * Two caveats surfaced in the returned message (never silent):
 *  - Codex TRUSTS each hook by a sha256 in config.toml; a freshly written hooks.json will not run until the
 *    user approves it once (interactive) or Codex is launched with --dangerously-bypass-hook-trust.
 *  - The feature is auto-enabled only when there is no existing [features] table (appending one is
 *    corruption-proof); if [features] exists we ask the user to add the one line, never rewriting their TOML.
 */
export function installCodexStatusHooks(bin: string, home = homedir()): string {
  const file = join(home, ".codex", "hooks.json");
  const config = readJsonConfig(file); // throws (file left alone) if present but not plain JSON
  const events = [
    { event: "UserPromptSubmit", state: "working" },
    { event: "PostToolUse", state: "working" },
    { event: "Stop", state: "idle" },
    { event: "Interrupt", state: "idle" },
    { event: "PermissionRequest", state: "blocked" },
  ];
  // async:true so a slow/hung report-status can never stall Codex's approval UI; timeout is in SECONDS.
  const changed = mergeStatusHookEvents(config, events, bin, (command) => ({ matcher: "", hooks: [{ type: "command", command, timeout: 10, async: true }] }));
  let wrote: string;
  if (changed === 0) {
    wrote = t(`${file} already has agenthop status hooks`, `${file} 里已有 agenthop 状态 hook`);
  } else {
    placeJson(file, config);
    wrote = t(`wrote ${changed} status hook change(s) to ${file}`, `已写 ${changed} 处状态 hook 改动到 ${file}`);
  }
  const feature = ensureCodexHooksFeature(home);
  const trust = t(
    "Codex won't run the hook until you approve it once (it will prompt) or launch with --dangerously-bypass-hook-trust",
    "需在 Codex 里批准一次该 hook 才会运行（它会提示），或用 --dangerously-bypass-hook-trust 启动",
  );
  return `${wrote}; ${feature}; ${trust}`;
}

/**
 * Ensure `[features] hooks = true` in Codex's config.toml. Corruption-proof: if there is no [features] table
 * we append a fresh one (TOML tables are order-independent); if [features] already exists we do NOT rewrite
 * it — editing inside an existing table without a real parser risks corrupting it — we just report the one
 * line to add. Idempotent once `hooks = true` is present.
 */
function ensureCodexHooksFeature(home: string): string {
  const file = join(home, ".codex", "config.toml");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^\s*hooks\s*=\s*true\s*(#.*)?$/m.test(existing)) return t("hooks feature already enabled", "hooks 特性已启用");
  if (/^\s*\[features\]\s*$/m.test(existing)) {
    return t(`add 'hooks = true' under [features] in ${file}`, `请在 ${file} 的 [features] 下手动加一行 'hooks = true'`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}[features]\nhooks = true\n`);
  return t(`enabled [features] hooks = true in ${file}`, `已在 ${file} 启用 [features] hooks = true`);
}

const HOOK_SENTINEL = "agenthop-status-hook";

/** The time-capture shell word for a status hook. Node startup varies by tens of ms and can reorder two
 *  near-simultaneous events (a turn's last PostToolUse vs its Stop), so the EVENT time is captured in the
 *  hook shell and passed to `report-status --seq`, not sampled at node start. macOS `date` has no sub-second
 *  `%N`, so use perl (always present); GNU `date` elsewhere. If the tool is missing the capture is empty,
 *  `--seq` is omitted, and report-status falls back to its own start time (manual/degraded paths never race). */
function statusHookTimeMs(): string {
  return process.platform === "darwin" ? `perl -MTime::HiRes=time -e 'printf "%.0f",time()*1000'` : "date +%s%3N";
}

/** Our per-event OWNERSHIP marker: a TRAILING shell comment (the shell ignores it). */
function sentinelFor(state: string): string {
  return `# ${HOOK_SENTINEL}:${state}`;
}

/** True only when `command` is OURS — matched with endsWith (the sentinel is a trailing comment), so a user
 *  command that merely CONTAINS the text as data (e.g. `printf '# ...:idle'`) is never mistaken for it. */
function ownedBy(command: unknown, mark: string): command is string {
  return typeof command === "string" && command.trimEnd().endsWith(mark);
}

/**
 * The status-hook command, shared by every host (the hooks.json schema is the same for Claude Code and
 * Codex). Side-effect-only (output suppressed, `|| true`) so it can never block a turn, inject context, or
 * fail. The session key is resolved INSIDE report-status: Claude Code reads CLAUDE_CODE_SESSION_ID from the
 * hook env; Codex delivers {session_id} as stdin JSON (the shell time-capture does not consume that stdin).
 */
function statusHookCommand(bin: string, state: string): string {
  const q = shQuote(bin); // POSIX single-quote so a path with $()/backtick/space can't be expanded by the shell
  return `_ahT=$(${statusHookTimeMs()} 2>/dev/null); ${q} report-status ${state} \${_ahT:+--seq "\$_ahT"} >/dev/null 2>&1 || true ${sentinelFor(state)}`;
}

/**
 * Merge our status hooks into an already-parsed hooks config — the shape Claude Code's settings.json and
 * Codex's hooks.json share: `hooks -> Event -> [{ ...group, hooks: [{type,command,...}] }]`. Adds our group
 * per event, or refreshes OUR command in place when it changed (e.g. the binary path), never duplicating and
 * never touching a user's own hooks. `makeGroup` supplies the host-specific group wrapper (Claude Code:
 * `{hooks:[…]}`; Codex: `{matcher:"",hooks:[…]}` with a timeout). Returns the number of changes made.
 */
function mergeStatusHookEvents(config: Record<string, unknown>, events: Array<{ event: string; state: string }>, bin: string, makeGroup: (command: string) => unknown): number {
  const hooks = (config.hooks ??= {}) as Record<string, unknown>;
  let changed = 0;
  for (const { event, state } of events) {
    const arr = (hooks[event] ??= []) as unknown[];
    if (!Array.isArray(arr)) continue; // unexpected shape for this event — leave it alone
    const mark = sentinelFor(state);
    const want = statusHookCommand(bin, state);
    const ours = arr.find((g) => Array.isArray((g as { hooks?: unknown[] })?.hooks) && (g as { hooks: unknown[] }).hooks.some((h) => ownedBy((h as { command?: unknown })?.command, mark)));
    if (ours) {
      // Refresh our command in place (e.g. the agenthop path changed) without adding a duplicate.
      for (const h of (ours as { hooks: Array<{ command?: string }> }).hooks) {
        if (ownedBy(h.command, mark) && h.command !== want) {
          h.command = want;
          changed++;
        }
      }
      continue;
    }
    arr.push(makeGroup(want));
    changed++;
  }
  return changed;
}

/** Read a JSON config file, or {} if absent; throws (file left untouched) if present but not plain JSON. */
function readJsonConfig(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(t(`${file} is not plain JSON; left it alone`, `${file} 不是纯 JSON，没有动它`));
  }
}

/** POSIX single-quote a shell word (used in a hook command string). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Write JSON via a sibling temp + rename (never truncate the original on a short/failed write). Preserves
 * the original file's permission mode (a rename would otherwise reset it to the umask default, widening a
 * 0600 config to 0644). Uses a random temp name so concurrent writers don't consume each other's staging.
 */
function placeJson(file: string, config: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  let mode: number | undefined;
  try {
    mode = statSync(file).mode & 0o777; // preserve the existing file's permissions
  } catch {
    // no existing file — the temp keeps its default (umask) mode
  }
  const staged = `${file}.new.${randomBytes(4).toString("hex")}`;
  // Create the temp at the target mode from the start (not 0644-then-chmod) so it is never briefly wider
  // than the original. writeFileSync's mode is applied at O_CREAT (masked by umask); chmod makes it exact.
  writeFileSync(staged, `${JSON.stringify(config, null, 2)}\n`, mode !== undefined ? { mode } : {});
  try {
    if (mode !== undefined) chmodSync(staged, mode);
    renameSync(staged, file);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

function codexBlock(bin: string): string {
  // Just the server registration. A spawned Codex session receives its AGENTHOP_LAUNCH_ID via a
  // per-launch `codex -c mcp_servers.agenthop.env.AGENTHOP_LAUNCH_ID=...` (see spawn.ts) — so no env
  // config is needed here, and existing installs need no migration.
  return `[mcp_servers.agenthop]\ncommand = ${JSON.stringify(bin)}\nargs = ["mcp"]`;
}

/**
 * Add agenthop to a JSON config and leave everything else in it alone. A file that is not plain
 * JSON is not rewritten: a guess at someone's configuration is worse than no change.
 */
function mergeJson(file: string, bin: string): string {
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(t(`${file} is not plain JSON; left it alone`, `${file} 不是纯 JSON，没有动它`));
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  config.mcpServers = { ...servers, ...entry(bin) };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return t(`written to ${file}`, `已写入 ${file}`);
}

function run(command: string, args: string[], name: string): string {
  if (!onPath(command)) throw new Error(t(`No ${command} command found`, `找不到 ${command} 命令`));
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || t(`${command} exited with ${result.status}`, `${command} 退出码 ${result.status}`)).trim());
  return t(`registered with ${name}`, `已注册到 ${name}`);
}

function onPath(command: string): boolean {
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && names.some((name) => existsSync(join(dir, name))));
}

function quote(text: string): string {
  return /[\s"'$`\\]/.test(text) ? JSON.stringify(text) : text;
}
