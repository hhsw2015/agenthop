import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge.js";

/**
 * The gateway's single-owner election and shutdown, with no relay/network: startBridge only touches the
 * relay once a session says hello, so binding, stale-socket recovery, and close are exercised offline.
 */

let home: string;
let sock: string;
const started: Bridge[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "bus-elect-"));
  sock = path.join(home, "bridge.sock");
  process.env.AGENTHOP_TEAM = "election-secret";
  process.env.AGENTHOP_BRIDGE_SOCK = sock;
});

afterEach(async () => {
  for (const b of started.splice(0)) await b.close();
  delete process.env.AGENTHOP_TEAM;
  delete process.env.AGENTHOP_BRIDGE_SOCK;
  rmSync(home, { recursive: true, force: true });
});

test("no team -> does not start", async () => {
  delete process.env.AGENTHOP_TEAM;
  expect(await startBridge({ home })).toBeUndefined();
});

test("exactly one of many concurrent launches wins the socket", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => startBridge({ home })));
  const live = results.filter((b): b is Bridge => b !== undefined);
  for (const b of live) started.push(b);
  expect(live.length).toBe(1);
  expect(statSync(sock).isSocket()).toBe(true);
});

test("a second launch while one is live is redundant (undefined)", async () => {
  const first = await startBridge({ home });
  expect(first).toBeDefined();
  started.push(first!);
  expect(await startBridge({ home })).toBeUndefined();
});

test("clears a stale leftover at the socket path and binds", async () => {
  writeFileSync(sock, "not a live socket"); // a leftover from a crashed bridge blocks bind until cleared
  const b = await startBridge({ home });
  expect(b).toBeDefined();
  started.push(b!);
  expect(statSync(sock).isSocket()).toBe(true);
});

test("close is idempotent, concurrent-safe, and hands the socket back cleanly", async () => {
  const b = await startBridge({ home });
  expect(b).toBeDefined();
  await Promise.all([b!.close(), b!.close()]); // shared promise: neither throws, both await one shutdown
  const again = await startBridge({ home }); // a fresh bridge can take the path after a clean close
  expect(again).toBeDefined();
  started.push(again!);
});
