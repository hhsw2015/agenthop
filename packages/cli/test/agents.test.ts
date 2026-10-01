import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installClaudeStatusHooks, installCodexStatusHooks, mcpHints, opencodeConfigDir, opencodePluginPath, registerMcp, writeOpencodePlugin } from "../src/agents.js";
import { parseArgs } from "../src/args.js";

const BIN = "/Users/someone/.local/bin/agenthop";

async function home() {
  return mkdtemp(path.join(tmpdir(), "agenthop-agents-"));
}

// Restore env that individual tests set, and ISOLATE CODEX_HOME — this machine has a real one set, and
// codexHome() prefers it, so without clearing it the codex tests would write into the real Codex dir.
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
beforeEach(() => {
  delete process.env.CODEX_HOME; // tests target the passed-in temp home, not a machine-level CODEX_HOME
});
afterEach(() => {
  if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  if (ORIGINAL_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
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

  it("never rewrites an existing agenthop MCP block and never machine-edits config.toml (no fragile TOML rewriting)", async () => {
    const dir = await home();
    const file = path.join(dir, ".codex", "config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    // An old install with a different binary path: we do NOT rewrite that block (a spawned Codex gets
    // forwarding via `codex -c` at launch instead), and we never touch config.toml at all for the feature flag.
    const before = `[mcp_servers.agenthop]\ncommand = "/old/agenthop"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "x"\n`;
    await writeFile(file, before);
    expect(registerMcp(["codex"], BIN, dir)[0]).toContain("already has agenthop");
    expect(await readFile(file, "utf8")).toBe(before); // byte-for-byte untouched (no rewrite, no [features] append)
    // hooks.json was written alongside (the actual status hooks); that is JSON, safe to merge.
    const hooks = JSON.parse(await readFile(path.join(dir, ".codex", "hooks.json"), "utf8"));
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain("report-status idle");
  });

  it("installs Codex status hooks (hooks.json schema, async, stdin session id) and instructs manual activation", async () => {
    const dir = await home();
    const msg = installCodexStatusHooks(BIN, dir);
    const hooks = JSON.parse(await readFile(path.join(dir, ".codex", "hooks.json"), "utf8"));
    const group = (event: string) => hooks.hooks[event][0] as { matcher: string; hooks: { command: string; type: string; timeout: number; async?: boolean }[] };
    // Same Claude-Code hooks.json schema: matcher-group + timeout (seconds); async so a slow report-status
    // can't stall the approval UI.
    expect(group("PermissionRequest").matcher).toBe("");
    expect(group("PermissionRequest").hooks[0].timeout).toBe(10);
    expect(group("PermissionRequest").hooks[0].async).toBe(true);
    expect(group("PermissionRequest").hooks[0].command).toContain("report-status blocked");
    expect(group("Stop").hooks[0].command).toContain("report-status idle");
    expect(group("Interrupt").hooks[0].command).toContain("report-status idle"); // Codex-only event clears blocked
    expect(group("SessionStart").hooks[0].command).toContain("report-status idle"); // seed: no [unknown] at start
    expect(group("UserPromptSubmit").hooks[0].command).toContain("report-status working");
    // Shared command: event-time --seq + ours-sentinel; session id comes from stdin (no --session needed).
    expect(group("Stop").hooks[0].command.startsWith("_ahT=$(")).toBe(true);
    expect(group("Stop").hooks[0].command).toContain("--seq");
    expect(group("Stop").hooks[0].command.trimEnd().endsWith("# agenthop-status-hook:idle")).toBe(true);
    // Activation is MANUAL (feature flag + one-time hook trust): never machine-edit config.toml.
    expect(existsSync(path.join(dir, ".codex", "config.toml"))).toBe(false); // config.toml not created/edited
    expect(msg).toContain("[features]");
    expect(msg).toContain("hooks = true");
    expect(msg).toContain("--dangerously-bypass-hook-trust");
    // Idempotent: a second run changes nothing in hooks.json.
    const msg2 = installCodexStatusHooks(BIN, dir);
    expect(msg2).toContain("already has agenthop status hooks");
  });

  it("honors CODEX_HOME for the hooks.json location", async () => {
    const dir = await home();
    const ch = path.join(dir, "custom-codex");
    process.env.CODEX_HOME = ch;
    installCodexStatusHooks(BIN, dir);
    expect(existsSync(path.join(ch, "hooks.json"))).toBe(true); // written where Codex actually reads it
    expect(existsSync(path.join(dir, ".codex", "hooks.json"))).toBe(false); // NOT the default dir
  });

  it("merges Codex status hooks beside another consumer's hooks and won't touch non-JSON hooks.json", async () => {
    const dir = await home();
    const file = path.join(dir, ".codex", "hooks.json");
    await mkdir(path.dirname(file), { recursive: true });
    // Another tool already stacks a Stop hook (the real ~/.codex/hooks.json does this); we add beside it.
    await writeFile(file, JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "/other/logger", timeout: 5 }] }] } }));
    installCodexStatusHooks(BIN, dir);
    const stop = (JSON.parse(await readFile(file, "utf8")).hooks.Stop) as { hooks: { command: string }[] }[];
    expect(stop.length).toBe(2); // other logger + ours
    expect(stop.some((g) => g.hooks.some((h) => h.command === "/other/logger"))).toBe(true); // untouched
    expect(stop.some((g) => g.hooks.some((h) => h.command.includes("agenthop-status-hook:idle")))).toBe(true); // ours
    // A non-JSON hooks.json is refused (left byte-for-byte alone), surfaced via the register fallback.
    await writeFile(file, "not json {");
    expect(() => installCodexStatusHooks(BIN, dir)).toThrow();
    expect(await readFile(file, "utf8")).toBe("not json {");
  });

  it("never machine-edits config.toml for the feature, even a tricky existing [features] table", async () => {
    const dir = await home();
    const toml = path.join(dir, ".codex", "config.toml");
    await mkdir(path.dirname(toml), { recursive: true });
    // A [features] header with a trailing comment — the kind a naive append-if-no-[features] regex misreads
    // as "no table" and then corrupts with a duplicate [features]. We must leave it byte-for-byte.
    const before = "[features]  # my features\nweb_search = true\n";
    await writeFile(toml, before);
    const msg = installCodexStatusHooks(BIN, dir);
    expect(await readFile(toml, "utf8")).toBe(before); // TOML untouched (no corruption)
    expect(msg).toContain("hooks = true"); // just instructs
  });

  it("installs Claude status hooks (working/idle/blocked), idempotent, preserving other settings", async () => {
    const dir = await home();
    const file = path.join(dir, ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "my-logger" }] }] } }));

    expect(installClaudeStatusHooks(BIN, dir)).toContain("wrote");
    const cfg = JSON.parse(await readFile(file, "utf8"));
    expect(cfg.model).toBe("opus"); // unrelated key preserved
    const cmds = (event: string) => (cfg.hooks[event] as { hooks: { command: string }[] }[]).flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds("SessionStart").some((c) => c.includes("report-status idle"))).toBe(true); // seed: no [unknown] at start
    expect(cmds("UserPromptSubmit").some((c) => c.includes("report-status working"))).toBe(true);
    expect(cmds("PostToolUse").some((c) => c.includes("report-status working"))).toBe(true); // recovers from blocked
    expect(cmds("Stop").some((c) => c.includes("report-status idle"))).toBe(true);
    expect(cmds("Stop").some((c) => c.includes("my-logger"))).toBe(true); // user's own hook kept
    expect(cmds("PermissionRequest").some((c) => c.includes("report-status blocked"))).toBe(true);

    expect(installClaudeStatusHooks(BIN, dir)).toContain("already has agenthop status hooks"); // idempotent
    const cfg2 = JSON.parse(await readFile(file, "utf8"));
    expect((cfg2.hooks.Stop as unknown[]).length).toBe(2); // user's + ours, no duplicate
  });

  it("does not clobber a user hook that merely mentions report-status (ownership via sentinel)", async () => {
    const dir = await home();
    const file = path.join(dir, ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    // A user's own logger whose command contains the text "report-status idle" but not our sentinel.
    await writeFile(file, JSON.stringify({ hooks: { Stop: [{ matcher: "Bash", hooks: [{ type: "command", command: "/bin/echo report-status idle", async: false }] }] } }));
    installClaudeStatusHooks(BIN, dir);
    const stop = (JSON.parse(await readFile(file, "utf8")).hooks.Stop) as { matcher?: string; hooks: { command: string; async?: boolean }[] }[];
    expect(stop.length).toBe(2); // user's logger + ours, added not overwritten
    const userGroup = stop.find((g) => g.matcher === "Bash")!;
    expect(userGroup.hooks[0].command).toBe("/bin/echo report-status idle"); // untouched
    expect(userGroup.hooks[0].async).toBe(false); // its fields untouched
    expect(stop.some((g) => g.hooks.some((h) => h.command.includes("agenthop-status-hook:idle")))).toBe(true); // ours added
  });

  it("refreshes the agenthop hook command when the binary path changes, without duplicating", async () => {
    const dir = await home();
    installClaudeStatusHooks("/old/path/agenthop", dir);
    const msg = installClaudeStatusHooks("/new/path/agenthop", dir);
    expect(msg).toContain("wrote"); // refreshed, not "already has"
    const cfg = JSON.parse(await readFile(path.join(dir, ".claude", "settings.json"), "utf8"));
    const stop = cfg.hooks.Stop as { hooks: { command: string }[] }[];
    expect(stop.length).toBe(1); // refreshed in place, no duplicate group
    expect(stop[0].hooks[0].command).toContain("/new/path/agenthop");
    expect(stop[0].hooks[0].command).not.toContain("/old/path/agenthop");
  });

  it("shell-single-quotes the binary path so metacharacters can't be expanded", async () => {
    const dir = await home();
    installClaudeStatusHooks("/opt/a b/$(touch pwned)/agenthop", dir);
    const cfg = JSON.parse(await readFile(path.join(dir, ".claude", "settings.json"), "utf8"));
    const cmd = (cfg.hooks.Stop as { hooks: { command: string }[] }[])[0].hooks[0].command;
    expect(cmd.startsWith("_ahT=$(")).toBe(true); // event time captured in the hook shell, before report-status
    expect(cmd).toContain("'/opt/a b/$(touch pwned)/agenthop' report-status idle"); // single-quoted, inert
  });

  it("captures event time in the hook (--seq) and covers tool/turn failure events", async () => {
    const dir = await home();
    installClaudeStatusHooks(BIN, dir);
    const cfg = JSON.parse(await readFile(path.join(dir, ".claude", "settings.json"), "utf8"));
    const cmds = (event: string) => (cfg.hooks[event] as { hooks: { command: string }[] }[]).flatMap((g) => g.hooks.map((h) => h.command));
    // The ordering key is the event time captured in the shell, not this process's start time (node-startup jitter).
    for (const e of ["UserPromptSubmit", "PostToolUse", "Stop", "PermissionRequest"]) {
      expect(cmds(e).every((c) => c.startsWith("_ahT=$(") && c.includes("--seq"))).toBe(true);
    }
    expect(cmds("PostToolUseFailure").some((c) => c.includes("report-status working"))).toBe(true); // recover from blocked when the approved tool errors
    expect(cmds("StopFailure").some((c) => c.includes("report-status idle"))).toBe(true); // never stick at working if the turn dies on an API error
  });

  it("treats the sentinel as ownership only when it is the trailing comment (endsWith, not includes)", async () => {
    const dir = await home();
    const file = path.join(dir, ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    // The user's command CONTAINS our marker as quoted DATA (a trailing quote follows it), not as a trailing comment.
    const userCmd = "printf '%s\\n' '# agenthop-status-hook:idle'";
    await writeFile(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: userCmd, async: false }] }] } }));
    installClaudeStatusHooks(BIN, dir);
    const stop = (JSON.parse(await readFile(file, "utf8")).hooks.Stop) as { hooks: { command: string }[] }[];
    expect(stop.length).toBe(2); // user's printf not mistaken for ours — ours added alongside it
    expect(stop.some((g) => g.hooks.some((h) => h.command === userCmd))).toBe(true); // user's command byte-for-byte
    expect(stop.some((g) => g.hooks.some((h) => h.command.trimEnd().endsWith("# agenthop-status-hook:idle") && h.command.includes("report-status idle")))).toBe(true); // ours
  });

  it("refuses to touch a non-JSON settings.json", async () => {
    const dir = await home();
    const file = path.join(dir, ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json {");
    expect(() => installClaudeStatusHooks(BIN, dir)).toThrow();
    expect(await readFile(file, "utf8")).toBe("not json {"); // left untouched
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
