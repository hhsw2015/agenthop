import { afterEach, beforeEach, afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { startBusCore } from "../src/core.js";
import { runPresence } from "../src/presence.js";
import { probeSessionAlive } from "../src/swarm/task-liveness.js";
import { resolveInboxTarget } from "../src/send-fallback.js";
import type { UnifiedPeer } from "../src/resolve.js";

// B7-1 (batch-7 arch review): a presence daemon that starts with NO pre-set SID and NO pid file listens on its per-session
// liveness socket under the per-RUN id. Codex then adopts its real thread id LATE (cwd-match). Pre-fix the listener stayed at
// hash(run-id), so a sender probing hash(stableId) found nothing, treated the session as cross-machine, and the same-machine
// durable guarantee to the stable id's inbox silently broke. The fix re-binds the socket to hash(stableId) on adoption.

// A Codex session with no env SID (stableId is adopted later) and no live host channel / real daemon.
let saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["AGENTHOP_TOOL", "AGENTHOP_NO_CODEX", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "AGENTHOP_PID_FILE", "AGENTHOP_HOST_PID"]) saved[k] = process.env[k];
  process.env.AGENTHOP_TOOL = "codex";
  process.env.AGENTHOP_NO_CODEX = "1"; // only noteThread drives adoption (no real codex daemon racing it)
  delete process.env.CLAUDE_CODE_SESSION_ID;      // ⇒ no stableId at startup (the B7-1 precondition)
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET; // ⇒ no cc-socks orphan guard
  delete process.env.AGENTHOP_PID_FILE;           // ⇒ sockSid is NOT fixed from a pid file (the B7-1 precondition)
  delete process.env.AGENTHOP_HOST_PID;           // ⇒ no host-pid orphan guard
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

// Short /tmp home: the liveness socket path (home + .agenthop/presence/<32hex>.<nonce>.sock) must fit sun_path (~103 bytes),
// and macOS tmpdir() (/var/folders/.../T/) is already too long on its own — the same bound openLivenessSocket enforces.
let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join("/tmp", "ahpr-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("core fires onIdentityChange when a stable id is adopted late (and not before)", async () => {
  const seen: Array<string | undefined> = [];
  const core = startBusCore({ home: HOME, onIdentityChange: (self) => seen.push(self.stableId) });
  try {
    expect(core.self.stableId).toBeUndefined(); // no env SID ⇒ no identity yet
    expect(seen).toEqual([]);                   // nothing fired at startup
    core.noteThread("thread-A");                // F47 adopts the thread id (authoritative)
    expect(core.self.stableId).toBe("thread-A");
    expect(seen).toEqual(["thread-A"]);         // fired exactly once, with the new id
    core.noteThread("thread-A");                // a repeat of the SAME id is not a new identity fact
    expect(seen).toEqual(["thread-A"]);         // not fired again
  } finally { await core.close(); }
});

test("B7-1: a late adoption RE-BINDS the liveness socket to the stable id (old run-id socket dies)", async () => {
  const { core, stop } = runPresence({ home: HOME });
  try {
    const runId = core.self.id;
    expect(core.self.stableId).toBeUndefined();
    await delay(80); // let the startup socket bind under the run id
    expect(await probeSessionAlive(HOME, runId)).toBe(true); // pre-adoption: alive under the per-run id

    core.noteThread("thread-A"); // late cwd-adoption learns the real thread id
    expect(core.self.stableId).toBe("thread-A");
    await delay(80); // let the synchronous re-bind's fresh async listen() land

    expect(await probeSessionAlive(HOME, "thread-A")).toBe(true); // THE FIX: the stable id now probes alive
    expect(await probeSessionAlive(HOME, runId)).toBe(false);     // the superseded run-id listener was closed (unlinked)
  } finally { await stop(); }
});

test("B7-1 (send contract): after the re-bind, a same-machine relay peer routes DURABLE to the stable id's inbox", async () => {
  const { core, stop } = runPresence({ home: HOME });
  try {
    core.noteThread("thread-A");
    await delay(80);
    const stableId = "thread-A";
    // A sender resolves this session cross-broker (via relay) and must decide same-machine vs cross-machine by the liveness probe
    // — exactly what core.send does before resolveInboxTarget. The probe now succeeds, so relayLocalSid = the stable id.
    const relayLocalSid = (await probeSessionAlive(HOME, stableId)) ? stableId : null;
    expect(relayLocalSid).toBe(stableId);
    const relayPeer: UnifiedPeer = { id: core.self.id, stableId, tool: "codex", cwd: "/w", title: "codex:Work-drift", via: "relay", pub: "pk" };
    const target = resolveInboxTarget("codex:Work-drift", relayPeer, null, relayLocalSid);
    expect(target).toMatchObject({ kind: "durable", sid: stableId }); // the send lands in the stable id's durable inbox (not relay-only)
  } finally { await stop(); }
});

test("positive case preserved: a pid-file presence (pre-set sid) binds + probes alive and does not drift", async () => {
  const sid = "fixed-sid-1";
  const pidFile = path.join(HOME, ".agenthop", "presence", `${sid}.pid`);
  process.env.AGENTHOP_PID_FILE = pidFile;
  try {
    const { core, stop } = runPresence({ home: HOME });
    try {
      await delay(80);
      expect(await probeSessionAlive(HOME, sid)).toBe(true); // bound under the fixed sid from byte one
      core.noteThread("thread-Z"); // even if an id is learned, the pid-file sid is fixed — the socket must NOT move off it
      await delay(80);
      expect(await probeSessionAlive(HOME, sid)).toBe(true);        // still at the fixed sid
      expect(await probeSessionAlive(HOME, "thread-Z")).toBe(false); // never re-bound away from the pid-file identity
    } finally { await stop(); }
  } finally { delete process.env.AGENTHOP_PID_FILE; }
});
