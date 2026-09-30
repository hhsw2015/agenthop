import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readStatusFile, writeStatusFile } from "../src/statusfile.js";
import { startBusCore } from "../src/core.js";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.sid = process.env.CLAUDE_CODE_SESSION_ID;
  saved.noc = process.env.AGENTHOP_NO_CODEX;
  saved.sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  process.env.AGENTHOP_NO_CODEX = "1";
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
});
afterEach(() => {
  for (const [k, v] of [["CLAUDE_CODE_SESSION_ID", saved.sid], ["AGENTHOP_NO_CODEX", saved.noc], ["CLAUDE_CODE_MESSAGING_SOCKET", saved.sock]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

test("status file: round-trip, strictly-advancing seq, invalid state rejected", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-sf-"));
  try {
    expect(writeStatusFile(home, "k", "working")).toBe(true);
    const first = readStatusFile(home, "k")!;
    expect(first.state).toBe("working");
    writeStatusFile(home, "k", "idle", { text: "done" });
    const second = readStatusFile(home, "k")!;
    expect(second.state).toBe("idle");
    expect(second.text).toBe("done");
    expect(second.seq).toBeGreaterThan(first.seq); // monotonic even within the same millisecond
    expect(writeStatusFile(home, "k", "bogus")).toBe(false); // not a known state
    expect(readStatusFile(home, "k")!.state).toBe("idle"); // unchanged by the rejected write
    expect(readStatusFile(home, "missing")).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a bus core applies a hook-written status file at startup and while running", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-sf-core-"));
  process.env.CLAUDE_CODE_SESSION_ID = "sess-1"; // the core's stableId = this key
  // A file that already exists when the core starts is applied immediately (startup read).
  writeStatusFile(home, "sess-1", "blocked", { text: "approve?" });
  const core = startBusCore({ home });
  try {
    expect(core.self.stableId).toBe("sess-1");
    expect(core.self.status).toBe("blocked");
    expect(core.self.statusText).toBe("approve?");
    // A file written WHILE running is picked up by the watcher.
    writeStatusFile(home, "sess-1", "idle");
    expect(await until(() => core.self.status === "idle")).toBe(true);
    // A stale seq is ignored by the core's monotonic guard.
    writeStatusFile(home, "sess-1", "working", { seq: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect(core.self.status).toBe("idle");
  } finally {
    await core.close();
    rmSync(home, { recursive: true, force: true });
  }
});
