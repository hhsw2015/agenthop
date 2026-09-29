import { afterEach, beforeEach, expect, test } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { startBridge, type Bridge } from "../src/bridge.js";
import { startBusCore, type BusCore, type BusMessage } from "../src/core.js";
import { deriveTeam } from "../src/team.js";
import type { SelfInfo } from "../src/label.js";

const TEAM_SECRET = "bridge-secret-7";
const TEAM_ID = deriveTeam(TEAM_SECRET).nsId;

/**
 * The cross-machine gateway, end to end over a real (local) stock relay. An OpenCode session cannot
 * carry the relay, so it talks to the bridge over a socket; the bridge runs the relay for that
 * session's identity. Here a self-joining core (node A, as if another machine) and a MOCK plugin
 * client behind the bridge (session B) must discover each other through the relay and exchange DMs
 * both ways — proving the bridge stands in for B exactly as a self-joining session would.
 */

let relay: RunningRelay;
let bridge: Bridge | undefined;
const homes: string[] = [];

beforeEach(async () => {
  relay = await startRelay();
  process.env.AGENTHOP_TEAM = TEAM_SECRET;
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET; // node A's inbound must land in its recv queue
  process.env.AGENTHOP_NO_CODEX = "1";
});

afterEach(async () => {
  delete process.env.AGENTHOP_TEAM;
  delete process.env.AGENTHOP_NO_CODEX;
  delete process.env.AGENTHOP_BRIDGE_SOCK;
  await bridge?.close();
  bridge = undefined;
  await relay.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "bus-bridge-"));
  homes.push(home);
  return home;
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/** A stand-in for the OpenCode plugin's bridge client: one connection, one session identity. */
type RemoteRow = { id: string; pub?: string; title: string; via: string };
function mockPlugin(sock: string, self: SelfInfo, teamId: string = TEAM_ID) {
  const socket = net.connect(sock);
  let roster: RemoteRow[] = [];
  let rejected = false;
  const inbound: Array<{ from: string; text: string }> = [];
  const sent = new Map<number, (ok: boolean) => void>();
  let rid = 0;
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(`${JSON.stringify({ t: "hello", self, team: teamId })}\n`));
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.t === "roster") roster = msg.peers;
      else if (msg.t === "inbound") inbound.push({ from: msg.from, text: msg.text });
      else if (msg.t === "sent") sent.get(msg.rid)?.(msg.ok);
      else if (msg.t === "rejected") rejected = true;
    }
  });
  return {
    roster: () => roster,
    inbound: () => inbound,
    rejected: () => rejected,
    send: (pub: string, text: string) =>
      new Promise<boolean>((resolve) => {
        const id = ++rid;
        sent.set(id, resolve);
        socket.write(`${JSON.stringify({ t: "send", rid: id, pub, text })}\n`);
      }),
    close: () => socket.destroy(),
  };
}

test("an OpenCode session reaches another machine through the gateway, both ways", async () => {
  const homeA = freshHome();
  const homeB = freshHome();
  const bridgeSock = path.join(homeB, "bridge.sock");
  process.env.AGENTHOP_BRIDGE_SOCK = bridgeSock;

  const a: BusCore = startBusCore({ home: homeA, relay: relay.url });
  bridge = await startBridge({ home: homeB, relay: relay.url });
  expect(bridge).toBeDefined();

  const selfB: SelfInfo = {
    id: "run-b-1",
    stableId: "opencode-session-b",
    tool: "opencode",
    cwd: "/tmp/projB",
    pid: process.pid,
    title: "opencode:projB-opencode",
    startedAt: Date.now(),
  };
  const plugin = mockPlugin(bridgeSock, selfB);

  try {
    // Discovery both ways through the relay directory.
    const bSeesA = await until(() => plugin.roster().some((p) => p.id === a.self.id && !!p.pub), 20000);
    const aSeesB = await until(() => a.peers().some((p) => p.id === selfB.id && p.via === "relay"), 20000);
    expect(bSeesA).toBe(true);
    expect(aSeesB).toBe(true);

    // B -> A: the plugin sends to A's relay pub via the gateway; A gets it in its recv queue.
    const aPub = plugin.roster().find((p) => p.id === a.self.id)!.pub!;
    expect(await plugin.send(aPub, "hi A from B")).toBe(true);
    const gotA: BusMessage[] = [];
    const deadlineA = Date.now() + 15000;
    while (gotA.length === 0 && Date.now() < deadlineA) gotA.push(...(await a.recv(1000)));
    expect(gotA.map((m) => m.text)).toContain("hi A from B");
    expect(gotA[0]!.via).toBe("relay");

    // A -> B: A sends to B by id; the gateway hosts B's mailbox and forwards it to the plugin.
    const sent = await a.send(selfB.id, "hi B from A");
    expect(sent.ok).toBe(true);
    const bGot = await until(() => plugin.inbound().some((m) => m.text === "hi B from A"), 15000);
    expect(bGot).toBe(true);
  } finally {
    plugin.close();
    await a.close();
  }
}, 60000);

test("the gateway refuses a session whose team namespace differs", async () => {
  const homeB = freshHome();
  const bridgeSock = path.join(homeB, "bridge.sock");
  process.env.AGENTHOP_BRIDGE_SOCK = bridgeSock;
  bridge = await startBridge({ home: homeB, relay: relay.url });
  expect(bridge).toBeDefined();

  const selfC: SelfInfo = {
    id: "run-c-1",
    stableId: "opencode-session-c",
    tool: "opencode",
    cwd: "/tmp/projC",
    pid: process.pid,
    title: "opencode:projC-opencode",
    startedAt: Date.now(),
  };
  // A different team's nsId: the gateway serves TEAM_SECRET, so this must be rejected, not relayed.
  const plugin = mockPlugin(bridgeSock, selfC, deriveTeam("some-other-team").nsId);
  try {
    const wasRejected = await until(() => plugin.rejected(), 5000);
    expect(wasRejected).toBe(true);
    expect(plugin.roster()).toEqual([]);
  } finally {
    plugin.close();
  }
}, 30000);
