import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    hint: (bin) => `claude mcp add --scope user ${SERVER} -- ${quote(bin)} mcp`,
    register: (bin) => run("claude", ["mcp", "add", "--scope", "user", SERVER, "--", bin, "mcp"], "Claude Code"),
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
    hint: (bin, home) => t(`Add to ${join(home, ".codex", "config.toml")}:\n${codexBlock(bin)}`, `在 ${join(home, ".codex", "config.toml")} 里加上：\n${codexBlock(bin)}`),
    register: (bin, home) => {
      const file = join(home, ".codex", "config.toml");
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (/^\[mcp_servers\.agenthop\]/m.test(existing)) return t(`${file} already has agenthop; nothing changed`, `${file} 里已经有 agenthop 了，没有改动`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${codexBlock(bin)}\n`);
      return t(`written to ${file}`, `已写入 ${file}`);
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

function codexBlock(bin: string): string {
  // env_vars forwards AGENTHOP_LAUNCH_ID from Codex's own environment into the MCP subprocess (Codex
  // otherwise clears it). That is how a spawned Codex session learns its launch id and can self-register
  // its window for agenthop_despawn. Harmless when the var is unset (normal, non-spawned sessions).
  return `[mcp_servers.agenthop]\ncommand = ${JSON.stringify(bin)}\nargs = ["mcp"]\nenv_vars = ["AGENTHOP_LAUNCH_ID"]`;
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
