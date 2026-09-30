import { startAgenthop } from "./agenthop.js";
import { startBridge } from "./bridge.js";
import { setTeam } from "./team.js";
import { statusHome, writeStatusFile } from "./statusfile.js";
import { version } from "./version.js";

/**
 * The enhanced agenthop entry. It IS agenthop: it adds the bus (mcp carries the bus tools, plus a
 * `team` command) and hands every classic command straight to the upstream CLI, so create / join /
 * install / update / relay / contacts behave exactly as before. In `mcp` mode nothing may touch
 * stdout — it is the protocol.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "team") {
    const secret = argv[1]?.trim();
    if (!secret) {
      console.error("Usage: agenthop team <secret>   (shared secret for cross-machine discovery)");
      process.exitCode = 1;
      return;
    }
    setTeam(secret);
    console.log("Team secret saved. Sessions that share it discover each other across machines.");
    return;
  }

  if (cmd === "report-status") {
    // Called by an agent's HOOKS (or by hand) to report this session's work state; the session's own
    // bus node watches ~/.agenthop/status/<key>.json and applies it. `key` = the session's native id,
    // known to the hook from its env (Claude Code: CLAUDE_CODE_SESSION_ID) — pass it with --session for
    // hosts whose hook env differs. Non-fatal: a hook must never break the agent, so it never throws.
    const state = argv[1]?.trim();
    const rest = argv.slice(2);
    const sessionArg = valueOf(rest, "--session");
    const note = valueOf(rest, "--note");
    const key = sessionArg || process.env.AGENTHOP_SESSION?.trim() || process.env.CLAUDE_CODE_SESSION_ID?.trim();
    if (!state || !["working", "idle", "blocked", "unknown"].includes(state)) {
      console.error("Usage: agenthop report-status <working|idle|blocked|unknown> [--session <id>] [--note <text>]");
      process.exitCode = 1;
      return;
    }
    if (!key) {
      console.error("report-status: no session key (set --session, AGENTHOP_SESSION, or run where CLAUDE_CODE_SESSION_ID is set).");
      process.exitCode = 1;
      return;
    }
    writeStatusFile(statusHome(), key, state, { text: note });
    return;
  }

  if (cmd === "bus-bridge") {
    // The per-machine cross-machine gateway for plugin-based tools (OpenCode). A plugin spawns this
    // when a team is set; it exits on its own once the last session has been gone for a grace period,
    // or immediately if there is no team or a live bridge already holds the socket.
    const bridge = await startBridge({ onIdle: () => process.exit(0) });
    if (!bridge) process.exit(0);
    return; // the socket server keeps the process alive until idle-exit
  }

  if (cmd === "mcp") {
    await startAgenthop({});
    // The harness closing our input is the end; a lingering server would keep the next one's inbox.
    process.stdin.once("end", () => process.exit(0));
    process.stdin.once("close", () => process.exit(0));
    return;
  }

  if (cmd === "--version" || cmd === "-v") {
    console.log(`agenthop v${version} (with session bus)`);
    return;
  }

  // Everything else is classic agenthop: create / join / install / update / relay / contacts / help.
  // The CLI reads process.argv itself and self-executes on import.
  await import("@agenthop/cli/bin");
}

/** Value after `--flag` in an argv slice, or undefined. */
function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

void main();
