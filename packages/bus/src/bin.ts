import { startAgenthop } from "./agenthop.js";
import { setTeam } from "./team.js";
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

void main();
