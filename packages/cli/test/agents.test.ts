import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpHints, opencodeConfigDir, opencodePluginPath, registerMcp, writeOpencodePlugin } from "../src/agents.js";
import { parseArgs } from "../src/args.js";

const BIN = "/Users/someone/.local/bin/agenthop";

async function home() {
  return mkdtemp(path.join(tmpdir(), "agenthop-agents-"));
}

// One test sets XDG_CONFIG_HOME; restore it so it never leaks into the others.
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
});

describe("plugging into agents as an MCP server", () => {
  it("says how to register with the agents it finds, using the installed path", async () => {
    const dir = await home();
    await mkdir(path.join(dir, ".cursor"));
    const hints = mcpHints(BIN, dir).join("\n");
    expect(hints).toContain("Cursor");
    expect(hints).toContain(BIN);
    expect(hints).toContain('"args":["mcp"]');
  });

  it("adds itself to a JSON config and leaves the rest of it alone", async () => {
    const dir = await home();
    const file = path.join(dir, ".cursor", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    expect(registerMcp(["cursor"], BIN, dir)[0]).toContain("written to");
    const config = JSON.parse(await readFile(file, "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.agenthop).toEqual({ command: BIN, args: ["mcp"] });
  });

  it("creates the JSON config when there is none", async () => {
    const dir = await home();
    registerMcp(["gemini"], BIN, dir);
    const config = JSON.parse(await readFile(path.join(dir, ".gemini", "settings.json"), "utf8"));
    expect(config.mcpServers.agenthop.args).toEqual(["mcp"]);
  });

  it("will not rewrite a config it cannot read as plain JSON", async () => {
    const dir = await home();
    const file = path.join(dir, ".gemini", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    const original = '{ // a comment\n  "theme": "dark" }';
    await writeFile(file, original);
    const [result] = registerMcp(["gemini"], BIN, dir);
    expect(result).toContain("not written");
    expect(result).toContain("Do it by hand");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("adds a Codex block once, however many times it is asked", async () => {
    const dir = await home();
    const file = path.join(dir, ".codex", "config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'model = "o4"\n');
    registerMcp(["codex"], BIN, dir);
    expect(registerMcp(["codex"], BIN, dir)[0]).toContain("already has agenthop");
    const text = await readFile(file, "utf8");
    expect(text.startsWith('model = "o4"\n')).toBe(true);
    expect(text.match(/\[mcp_servers\.agenthop\]/g)).toHaveLength(1);
    expect(text).toContain(`command = "${BIN}"`);
  });

  it("leaves an existing agenthop block byte-for-byte alone (no fragile TOML rewriting)", async () => {
    const dir = await home();
    const file = path.join(dir, ".codex", "config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    // An old install without env_vars: we do NOT edit it (a spawned Codex gets forwarding via `codex -c`
    // at launch instead). Rewriting existing TOML risks corrupting it.
    const before = `[mcp_servers.agenthop]\ncommand = "/old/agenthop"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "x"\n`;
    await writeFile(file, before);
    expect(registerMcp(["codex"], BIN, dir)[0]).toContain("already has agenthop");
    expect(await readFile(file, "utf8")).toBe(before); // untouched
  });

  it("names an agent it does not know instead of guessing", async () => {
    const dir = await home();
    expect(registerMcp(["vscode"], BIN, dir)[0]).toContain("Unknown agent");
    expect(existsSync(path.join(dir, ".vscode"))).toBe(false);
  });

  it("registers OpenCode by writing the embedded bus plugin, not an mcpServers block", async () => {
    const dir = await home();
    await mkdir(opencodeConfigDir(dir), { recursive: true });
    const [result] = registerMcp(["opencode"], BIN, dir);
    expect(result).toContain("written to");
    const plugin = await readFile(opencodePluginPath(dir), "utf8");
    expect(plugin).toContain("AgenthopBusPlugin");
    expect(plugin).toContain("@opencode-ai/plugin");
    // A plugin, not an MCP entry: the agenthop binary path is never baked into it.
    expect(plugin).not.toContain(BIN);
  });

  it("offers to write the OpenCode plugin when OpenCode is present", async () => {
    const dir = await home();
    await mkdir(opencodeConfigDir(dir), { recursive: true });
    expect(mcpHints(BIN, dir).join("\n")).toContain("OpenCode");
  });

  it("honors XDG_CONFIG_HOME for the OpenCode plugin location", async () => {
    const dir = await home();
    const xdg = path.join(dir, "xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    expect(opencodePluginPath(dir)).toBe(path.join(xdg, "opencode", "plugin", "agenthop-bus.js"));
    await mkdir(opencodeConfigDir(dir), { recursive: true });
    registerMcp(["opencode"], BIN, dir);
    expect(existsSync(path.join(xdg, "opencode", "plugin", "agenthop-bus.js"))).toBe(true);
  });

  it("refreshes the plugin without following a symlink at its path", async () => {
    const dir = await home();
    const pluginPath = opencodePluginPath(dir);
    await mkdir(path.dirname(pluginPath), { recursive: true });
    const target = path.join(dir, "elsewhere.js");
    await writeFile(target, "PRECIOUS");
    await symlink(target, pluginPath);
    writeOpencodePlugin(dir);
    expect(await readFile(target, "utf8")).toBe("PRECIOUS"); // the link target is left intact
    expect(lstatSync(pluginPath).isSymbolicLink()).toBe(false); // the link was replaced by a real file
    expect(await readFile(pluginPath, "utf8")).toContain("AgenthopBusPlugin");
  });

  it("takes --mcp more than once", () => {
    expect(parseArgs(["install", "--mcp", "grok", "--mcp", "cursor"]).flags.mcpAgents).toEqual(["grok", "cursor"]);
    expect(() => parseArgs(["install", "--mcp"])).toThrow(/--mcp takes/);
  });
});
