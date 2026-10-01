import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneStaleStatusFiles, readStatusFile, STATUS_FILE_TTL_MS, writeStatusFile } from "../src/statusfile.js";
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

test("status file: round-trip, event-seq wins, no regress, invalid state rejected", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-sf-"));
  try {
    expect(writeStatusFile(home, "k", "working", { seq: 100 })).toBe(true);
    expect(readStatusFile(home, "k")).toMatchObject({ state: "working", seq: 100 });
    // A NEWER event (higher seq) wins.
    writeStatusFile(home, "k", "idle", { seq: 200, text: "done" });
    expect(readStatusFile(home, "k")).toMatchObject({ state: "idle", seq: 200, text: "done" });
    // An OLDER event (lower seq — e.g. a delayed async write) must NOT regress the recorded state.
    expect(writeStatusFile(home, "k", "working", { seq: 150 })).toBe(true); // returns ok (nothing to do)
    expect(readStatusFile(home, "k")).toMatchObject({ state: "idle", seq: 200 }); // unchanged
    // Invalid state rejected, disk untouched.
    expect(writeStatusFile(home, "k", "bogus", { seq: 300 })).toBe(false);
    expect(readStatusFile(home, "k")!.state).toBe("idle");
    expect(readStatusFile(home, "missing")).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status file: a lower-seq version never shadows a newer one, even with both on disk (lock-free max register)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-sf-race-"));
  try {
    const dir = path.join(home, ".agenthop", "status");
    mkdirSync(dir, { recursive: true });
    // Two versions coexist on disk — exactly what a stale (lower-seq) writer renaming last could leave. The
    // single-file overwrite scheme lost this race; the reader must take the MAX seq so the stale one can't win.
    writeFileSync(path.join(dir, "k.json.100"), JSON.stringify({ state: "working", seq: 100 }));
    writeFileSync(path.join(dir, "k.json.200"), JSON.stringify({ state: "idle", seq: 200 }));
    expect(readStatusFile(home, "k")).toMatchObject({ state: "idle", seq: 200 });
    // A genuinely newer event wins and prunes every older version.
    expect(writeStatusFile(home, "k", "blocked", { seq: 300 })).toBe(true);
    expect(readStatusFile(home, "k")).toMatchObject({ state: "blocked", seq: 300 });
    expect(existsSync(path.join(dir, "k.json.100"))).toBe(false);
    expect(existsSync(path.join(dir, "k.json.200"))).toBe(false);
    // A truncated NEWEST version (a crashed writer's partial file) must not blank out status — fall through
    // to the next-newest valid version instead.
    writeFileSync(path.join(dir, "k.json.400"), "{ not json");
    expect(readStatusFile(home, "k")).toMatchObject({ state: "blocked", seq: 300 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GC: prunes a dead session's stale file by mtime TTL, keeps fresh ones, never the current max", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-sf-gc-"));
  try {
    const dir = path.join(home, ".agenthop", "status");
    // Two sessions: "dead" last wrote hours ago, "live" wrote just now.
    writeStatusFile(home, "dead", "idle", { seq: 100 });
    writeStatusFile(home, "live", "working", { seq: 200 });
    const old = new Date(Date.now() - STATUS_FILE_TTL_MS - 60_000);
    utimesSync(path.join(dir, "dead.json.100"), old, old);
    expect(pruneStaleStatusFiles(home)).toBe(1);
    expect(readStatusFile(home, "dead")).toBeUndefined(); // the dead session's leftover is gone
    expect(readStatusFile(home, "live")).toMatchObject({ state: "working", seq: 200 }); // fresh file kept
    // A key's CURRENT max is never removed while fresh — even when an older sibling version is stale.
    writeFileSync(path.join(dir, "live.json.150"), JSON.stringify({ state: "idle", seq: 150 }));
    utimesSync(path.join(dir, "live.json.150"), old, old);
    expect(pruneStaleStatusFiles(home)).toBe(1); // only the stale sibling
    expect(readStatusFile(home, "live")).toMatchObject({ state: "working", seq: 200 });
    // Leftover staging temps age out too; a missing dir is a clean no-op.
    writeFileSync(path.join(dir, "live.json.1.tmp.abcd1234"), "partial");
    utimesSync(path.join(dir, "live.json.1.tmp.abcd1234"), old, old);
    expect(pruneStaleStatusFiles(home)).toBe(1);
    expect(pruneStaleStatusFiles(path.join(home, "no-such-home"))).toBe(0); // missing dir = clean no-op
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GC: an explicit ttl/now makes it deterministic; nothing younger than the TTL is touched", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ah-sf-gc2-"));
  try {
    writeStatusFile(home, "k", "idle", { seq: 1 });
    // With `now` barely past the write, nothing is old enough.
    expect(pruneStaleStatusFiles(home, { ttlMs: 1000, now: Date.now() + 500 })).toBe(0);
    expect(readStatusFile(home, "k")).toMatchObject({ state: "idle", seq: 1 });
    // Push `now` beyond the ttl and the same file is pruned.
    expect(pruneStaleStatusFiles(home, { ttlMs: 1000, now: Date.now() + 5000 })).toBe(1);
    expect(readStatusFile(home, "k")).toBeUndefined();
    // A nonsensical ttl is refused rather than treated as "prune everything".
    writeStatusFile(home, "k", "idle", { seq: 2 });
    expect(pruneStaleStatusFiles(home, { ttlMs: 0 })).toBe(0);
    expect(pruneStaleStatusFiles(home, { ttlMs: Number.NaN })).toBe(0);
    expect(readStatusFile(home, "k")).toMatchObject({ seq: 2 });
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
