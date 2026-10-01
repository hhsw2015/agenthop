import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startAgenthop } from "../src/agenthop.js";

beforeAll(() => {
  process.env.AGENTHOP_NO_CODEX = "1";
});
afterAll(() => {
  delete process.env.AGENTHOP_NO_CODEX;
});

test("enhanced entry starts and carries classic + bus tools with no name collision", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-enh-"));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  // startAgenthop registers the classic tools then the bus tools on ONE server. A duplicate tool name
  // (the bug: bus reusing classic's agenthop_status / agenthop_wait) throws HERE, before connect.
  const server = await startAgenthop({ home }, serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    // Classic conversation tools and the new bus work-status tools must coexist under distinct names.
    for (const n of ["agenthop_status", "agenthop_wait", "agenthop_report_status", "agenthop_wait_peer", "agenthop_peers", "agenthop_spawn"]) {
      expect(names).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length); // no duplicates
  } finally {
    await client.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("every bus tool declares all four hints, and the safety-critical ones are correct", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-enh-"));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = await startAgenthop({ home }, serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  try {
    const tools = (await client.listTools()).tools;
    const BUS_TOOLS = [
      "agenthop_peers", "agenthop_send", "agenthop_handoff", "agenthop_recv", "agenthop_report_status",
      "agenthop_wait_peer", "agenthop_spawn", "agenthop_wm", "agenthop_spawned", "agenthop_despawn",
    ];
    const bus = tools.filter((t) => BUS_TOOLS.includes(t.name));
    expect(bus.length, "all bus tools present").toBe(BUS_TOOLS.length);
    // Directory rule (why upstream added hints): EVERY bus tool declares all four as booleans, none missing, so
    // a directory that rejects a tool with any hint absent accepts our bus surface too. (The classic tools'
    // hints are @agenthop/cli's own concern, covered by its mcp.test.ts — not re-asserted across the package.)
    for (const tool of bus) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe("boolean");
      }
    }
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    // Safety-critical: a client that asks before acting must see the window/process closers as destructive.
    expect(hints("agenthop_despawn")?.destructiveHint).toBe(true);
    expect(hints("agenthop_wm")?.destructiveHint).toBe(true);
    // Read-only observers must not look like mutations.
    expect(hints("agenthop_peers")?.readOnlyHint).toBe(true);
    expect(hints("agenthop_recv")?.readOnlyHint).toBe(true);
    expect(hints("agenthop_wait_peer")?.readOnlyHint).toBe(true);
    // Outward actions are not read-only; and only a local-registry read is closed-world.
    expect(hints("agenthop_send")?.readOnlyHint).toBe(false);
    expect(hints("agenthop_spawn")?.readOnlyHint).toBe(false);
    expect(hints("agenthop_spawned")?.openWorldHint).toBe(false);
    expect(hints("agenthop_peers")?.openWorldHint).toBe(true);
  } finally {
    await client.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
