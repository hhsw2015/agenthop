import { afterEach, beforeEach, expect, test } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { openTaskRoom, pullMessages, reportResult, SWARM_CMD_PREFIX } from "../src/swarm/room.js";

/**
 * The networked swarm return, proven over a real (local) stock relay: the dispatcher opens a per-task room,
 * a stand-in "VM" seals a result under the per-launch key and posts it, and the dispatcher collects + decrypts
 * it. A result sealed with a different key is skipped (confidentiality — only the dispatcher's key opens it).
 */

let relay: RunningRelay;
beforeEach(async () => {
  relay = await startRelay();
});
afterEach(async () => {
  await relay.close();
});

test("a VM posts a sealed result and the dispatcher collects + decrypts it", async () => {
  const room = await openTaskRoom({ relay: relay.url });
  try {
    // The "VM" side: seal under the per-launch key injected to it, post to the room address.
    await reportResult({ code: room.code, keyHex: room.keyHex, text: "task done: the answer is 42", relay: relay.url });
    const results = await room.collect(15000);
    expect(results).toContain("task done: the answer is 42");
  } finally {
    await room.close();
  }
}, 60000);

test("two-way: a dispatcher command is pulled by the VM and the VM's reply is collected", async () => {
  const room = await openTaskRoom({ relay: relay.url });
  try {
    // dispatcher -> VM
    await room.send("reply with your hostname");
    const { messages } = await pullMessages({ code: room.code, keyHex: room.keyHex, relay: relay.url, prefix: SWARM_CMD_PREFIX });
    expect(messages).toContain("reply with your hostname");
    // VM -> dispatcher
    await reportResult({ code: room.code, keyHex: room.keyHex, text: "host-abc", relay: relay.url });
    expect(await room.collect(15000)).toContain("host-abc");
  } finally {
    await room.close();
  }
}, 60000);

test("a result sealed with the wrong key lands but is skipped, not surfaced", async () => {
  const room = await openTaskRoom({ relay: relay.url });
  try {
    const wrongKey = Buffer.alloc(32, 7).toString("hex"); // not the room's key
    await reportResult({ code: room.code, keyHex: wrongKey, text: "forged", relay: relay.url });
    const results = await room.collect(4000); // nothing openable with our key → [] at timeout
    expect(results).toEqual([]);
  } finally {
    await room.close();
  }
}, 60000);
