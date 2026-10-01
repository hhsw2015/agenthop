import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { startBusCore, type BusCore, type BusMessage } from "../src/core.js";

/**
 * Cross-machine proof over a real (local) stock relay: two cores in separate homes — so separate
 * local brokers, as if on two machines — sharing a team secret must discover each other through the
 * relay directory and exchange a DM through the relay mailboxes. Exercises team.ts + dm.ts (Codex)
 * with directory.ts + mailbox.ts (integration) end to end.
 */

let relay: RunningRelay;
const homes: string[] = [];

beforeEach(async () => {
  relay = await startRelay();
  process.env.AGENTHOP_TEAM = "integration-secret-42";
  // Tests run inside a real Claude Code + Codex shell; without these, inbound messages would push
  // into the real TUIs (cc-socks / codex queue) instead of the recv queue this test asserts on.
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  process.env.AGENTHOP_NO_CODEX = "1"; // don't reach the real Codex daemon from tests
});

afterEach(async () => {
  delete process.env.AGENTHOP_TEAM;
  delete process.env.AGENTHOP_NO_CODEX;
  await relay.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function core(): BusCore {
  const home = mkdtempSync(path.join(tmpdir(), "bus-relay-"));
  homes.push(home);
  return startBusCore({ home, relay: relay.url });
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

test("two machines on a team discover and message each other over the relay", async () => {
  const a = core();
  const b = core();
  try {
    // Discovery via the relay directory (each is in the other's roster, marked relay).
    const seesB = await until(() => a.peers().some((p) => p.id === b.self.id && p.via === "relay"), 20000);
    const seesA = await until(() => b.peers().some((p) => p.id === a.self.id && p.via === "relay"), 20000);
    expect(seesB).toBe(true);
    expect(seesA).toBe(true);

    // Message A -> B, sealed to B's key, through B's mailbox.
    const sent = await a.send(b.self.id, "hello over the relay");
    expect(sent.ok).toBe(true);

    const got: BusMessage[] = [];
    const deadline = Date.now() + 15000;
    while (got.length === 0 && Date.now() < deadline) got.push(...(await b.recv(1000)));
    expect(got.map((m) => m.text)).toContain("hello over the relay");
    expect(got[0]!.via).toBe("relay");
  } finally {
    await a.close();
    await b.close();
  }
}, 60000);

test("work status propagates across machines through the relay directory", async () => {
  const a = core();
  const b = core();
  const aId = a.self.id;
  try {
    // Wait for discovery first; before any report the remote peer carries no status.
    expect(await until(() => b.peers().some((p) => p.id === aId && p.via === "relay"), 20000)).toBe(true);
    expect(b.peers().find((p) => p.id === aId)?.status).toBeUndefined();

    // a reports working; b (another machine: separate home, relay-only view of a) sees state, seq,
    // and text on its roster. updateSelf announces immediately, so this lands within a poll (~5s).
    expect(a.setStatus("working", { seq: 10, text: "crunching" }).ok).toBe(true);
    expect(await until(() => b.peers().find((p) => p.id === aId)?.status === "working", 20000)).toBe(true);
    const seen = b.peers().find((p) => p.id === aId)!;
    expect(seen.via).toBe("relay");
    expect(seen.statusSeq).toBe(10);
    expect(seen.statusText).toBe("crunching");
    expect(seen.statusAt).toBeTypeOf("number");

    // A later state change follows, and a cross-machine wait resolves on it.
    expect(a.setStatus("idle", { seq: 20 }).ok).toBe(true);
    expect(await b.waitForStatus(aId, ["idle"], 20000)).toMatchObject({ reached: true, status: "idle" });
    expect(b.peers().find((p) => p.id === aId)?.statusSeq).toBe(20);
  } finally {
    await a.close();
    await b.close();
  }
}, 90000);
