import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { registerAgenthopTools, type McpOptions } from "@agenthop/cli";
import { busInstructions, registerBusTools } from "./mcp.js";
import { version } from "./version.js";

/**
 * The enhanced agenthop: one MCP server carrying both the classic conversation/contact tools and
 * the auto bus. This is the whole point of the fork — a stronger agenthop that fully replaces the
 * plain one. The bus is the default way to reach other sessions; the pairing-code tools stay for
 * the cases the bus does not cover (a one-off link to someone not on your team).
 */

export function enhancedInstructions(): string {
  return `This is agenthop with the built-in session bus.

For reaching other agent sessions, PREFER the bus — it needs no pairing code and finds sessions automatically:
${busInstructions()}

The classic tools (agenthop_create / join / say / wait / invite / send_file / save_contact …) are the manual pairing-code flow. Use them only when the bus does not apply — e.g. a one-off link to someone who is not on your team and not on this machine.`;
}

export async function startAgenthop(options: McpOptions = {}, transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = new McpServer({ name: "agenthop", version }, { instructions: enhancedInstructions() });
  // Classic tools first — this sets server.server.onclose for its own cleanup, which we then chain.
  registerAgenthopTools(server, options);
  const closeBus = registerBusTools(server, { home: options.home, relay: options.relay, pass: options.pass });
  const closeClassic = server.server.onclose?.bind(server.server);
  server.server.onclose = () => {
    closeBus();
    closeClassic?.();
  };
  await server.connect(transport);
  return server;
}
