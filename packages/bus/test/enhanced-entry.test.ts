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
