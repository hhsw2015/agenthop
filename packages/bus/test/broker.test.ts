import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startLocalBus, type Inbound, type LocalBus } from "../src/broker.js";
import type { SelfInfo } from "../src/label.js";

function mk(id: string): SelfInfo {
  return { id, tool: "test", cwd: "/x", pid: 1, title: id, startedAt: 0 };
}

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

/** Poll a bus's inbox until at least one message arrives (drain is destructive, so collect). */
async function recv(bus: LocalBus, ms = 3000): Promise<Inbound[]> {
  const got: Inbound[] = [];
  await until(() => {
    got.push(...bus.drain());
    return got.length > 0;
  }, ms);
  return got;
}

test("two sessions discover each other and exchange messages, both directions", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bus-"));
  const a = startLocalBus(mk("aaaaaaaa-1"), home);
  const b = startLocalBus(mk("bbbbbbbb-2"), home);
  try {
    expect(await until(() => a.peers().length === 2 && b.peers().length === 2)).toBe(true);

    expect(a.send("bbbbbbbb-2", "hi-b")).toBe(true);
    const atB = await recv(b);
    expect(atB.map((m) => m.payload)).toContain("hi-b");
    expect(atB[0]!.from).toBe("aaaaaaaa-1");

    expect(b.send("aaaaaaaa-1", "hi-a")).toBe(true);
    const atA = await recv(a);
    expect(atA.map((m) => m.payload)).toContain("hi-a");

    // Exactly one is the broker.
    expect([a.role(), b.role()].filter((r) => r === "broker").length).toBe(1);
    // Unknown target is reported, not silently dropped.
    expect(a.send("nope", "x")).toBe(false);
  } finally {
    await a.close();
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("updateSelf re-announces a session's learned stable handle to peers", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bus-"));
  const a = startLocalBus(mk("aaaaaaaa-1"), home);
  await until(() => a.role() === "broker");
  const b = startLocalBus(mk("bbbbbbbb-2"), home);
  try {
    expect(await until(() => a.peers().length === 2)).toBe(true);
    // b (a client) learns its native session id after connecting and refreshes its handle — exactly
    // what a Codex session does once it resolves its thread id.
    b.updateSelf({ ...mk("bbbbbbbb-2"), stableId: "01a0ead5-thread", title: "codex:Work-01a0ead5" });
    // A client updating itself must NOT drop the other peers from its own roster (the bug: it
    // collapsed to [self], so the very next send failed). b must still see and reach a immediately.
    expect(b.peers().some((p) => p.id === "aaaaaaaa-1")).toBe(true);
    expect(b.send("aaaaaaaa-1", "right-after-update")).toBe(true);
    const seen = await until(() =>
      a.peers().some((p) => p.id === "bbbbbbbb-2" && p.stableId === "01a0ead5-thread" && p.title === "codex:Work-01a0ead5"),
    );
    expect(seen).toBe(true);
  } finally {
    await a.close();
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("closing an already-closed broker does not unlink the successor's socket", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bus-"));
  const a = startLocalBus(mk("aaaaaaaa-1"), home);
  await until(() => a.role() === "broker");
  const b = startLocalBus(mk("bbbbbbbb-2"), home);
  try {
    expect(await until(() => b.role() === "client")).toBe(true);
    await a.close(); // A gone, B takes the socket
    expect(await until(() => b.role() === "broker", 4000)).toBe(true);

    await a.close(); // second close of A must be a no-op, not unlink B's live socket

    // B is still the one and only broker, and a fresh session reaches it (no split brain).
    const c = startLocalBus(mk("cccccccc-3"), home);
    try {
      expect(await until(() => c.role() === "client" && c.peers().length === 2)).toBe(true);
      expect(c.send("bbbbbbbb-2", "still-here")).toBe(true);
      const atB = await recv(b);
      expect(atB.map((m) => m.payload)).toContain("still-here");
      expect([b.role(), c.role()].filter((r) => r === "broker").length).toBe(1);
    } finally {
      await c.close();
    }
  } finally {
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("closing a session while it is still connecting leaves no ghost peer", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bus-"));
  const a = startLocalBus(mk("aaaaaaaa-1"), home);
  await until(() => a.role() === "broker");
  const b = startLocalBus(mk("bbbbbbbb-2"), home);
  await b.close(); // close immediately — the connect to the broker is still in flight
  try {
    // Give any in-flight connect a chance to (wrongly) register, then confirm it never did.
    await new Promise((r) => setTimeout(r, 300));
    expect(a.peers().some((p) => p.id === "bbbbbbbb-2")).toBe(false);
    expect(a.peers().length).toBe(1);
  } finally {
    await a.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a client takes over when the broker exits", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bus-"));
  const a = startLocalBus(mk("aaaaaaaa-1"), home);
  await until(() => a.role() === "broker");
  const b = startLocalBus(mk("bbbbbbbb-2"), home);
  try {
    expect(await until(() => b.role() === "client")).toBe(true);

    await a.close(); // broker gone
    expect(await until(() => b.role() === "broker", 4000)).toBe(true);

    // A new session finds the new broker and both can talk.
    const c = startLocalBus(mk("cccccccc-3"), home);
    try {
      expect(await until(() => b.peers().length === 2 && c.peers().length === 2)).toBe(true);
      expect(c.send("bbbbbbbb-2", "after-failover")).toBe(true);
      const atB = await recv(b);
      expect(atB.map((m) => m.payload)).toContain("after-failover");
    } finally {
      await c.close();
    }
  } finally {
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});
