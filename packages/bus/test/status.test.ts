import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBusCore, type BusCore } from "../src/core.js";

// Force codexDaemonPresent() false so a real Codex daemon on this machine isn't contacted, and clear
// the inherited native-session env so the two in-process cores get DISTINCT identities (in production two
// sessions never share a native session id; only the test runner's shared env would make them collide).
let savedSid: string | undefined;
let savedSock: string | undefined;
beforeAll(() => {
  process.env.AGENTHOP_NO_CODEX = "1";
  savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  savedSock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
});
afterAll(() => {
  delete process.env.AGENTHOP_NO_CODEX;
  if (savedSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSid;
  if (savedSock !== undefined) process.env.CLAUDE_CODE_MESSAGING_SOCKET = savedSock;
});

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

test("self-reported status rides the roster, monotonic seq drops stale, wait pins + reaches", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-status-"));
  const a = startBusCore({ home });
  const b = startBusCore({ home });
  const aId = a.self.id;
  try {
    expect(await until(() => a.peers().length === 2 && b.peers().length === 2)).toBe(true);

    // a reports blocked (with detail); b sees it on the shared roster.
    a.setStatus("blocked", { text: "needs approval" });
    expect(await until(() => b.peers().find((p) => p.id === aId)?.status === "blocked")).toBe(true);
    expect(b.peers().find((p) => p.id === aId)?.statusText).toBe("needs approval");

    // Monotonic seq: a newer seq applies; an older/equal one is ignored (never applied on top of newer).
    expect(a.setStatus("idle", { seq: 10 }).ok).toBe(true);
    expect(a.setStatus("working", { seq: 5 })).toMatchObject({ ok: false, ignored: true, seq: 10 });
    expect(a.self.status).toBe("idle"); // stale report did not take effect
    expect(a.setStatus("working", { seq: 11 }).ok).toBe(true);
    expect(a.self.status).toBe("working");

    // b waits for a to reach idle — resolves as soon as a reports it.
    a.setStatus("idle", { seq: 20 });
    const reached = await b.waitForStatus(aId, ["idle"], 3000);
    expect(reached).toMatchObject({ reached: true, status: "idle" });

    // wait times out when the wanted state never comes (a is idle, we ask for blocked).
    const timedOut = await b.waitForStatus(aId, ["blocked"], 400);
    expect(timedOut.reached).toBe(false);

    // an unknown target is an error, not a silent hang.
    expect((await b.waitForStatus("no-such-session", ["idle"], 400)).error).toBeTruthy();
  } finally {
    await a.close();
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});
