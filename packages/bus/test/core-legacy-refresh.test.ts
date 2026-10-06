import { afterEach, beforeEach, afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBusCore } from "../src/core.js";
import { recordSelfObserve, recordLearn } from "../src/bus-identity.js";
import { writeInbox, claimInbox } from "../src/inbox.js";

// Give this in-process core a known, stable native (conv-1) and no live host channel, so a background flush can only
// claim+release (never ack) — the durable copy always survives for the assertions. Clear inherited native/socket env.
let savedSid: string | undefined;
let savedSock: string | undefined;
let savedTool: string | undefined;
const TOOL = "unknown"; // force a deterministic tool so the recorded prior-run entities match the core's own identity
beforeAll(() => {
  process.env.AGENTHOP_NO_CODEX = "1";
  savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  savedSock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  savedTool = process.env.AGENTHOP_TOOL;
  process.env.AGENTHOP_TOOL = TOOL;
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
});
afterAll(() => {
  delete process.env.AGENTHOP_NO_CODEX;
  if (savedSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSid; else delete process.env.CLAUDE_CODE_SESSION_ID;
  if (savedSock !== undefined) process.env.CLAUDE_CODE_MESSAGING_SOCKET = savedSock;
  if (savedTool !== undefined) process.env.AGENTHOP_TOOL = savedTool; else delete process.env.AGENTHOP_TOOL;
});

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(tmpdir(), "ah-core-legacy-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const m = (text: string, ts: number) => ({ from: "x", fromLabel: "p", text, via: "local" as const, ts });

// F40-2: the legacy-key set must follow the alias-log at CLAIM time — a correction that revokes a link must stop the old box
// being claimed, and a newly-added same-native link must start being drained, WITHOUT the session restarting.
test("F40-2: a revoked legacy link stops being claimed; a late same-native link is drained (no restart)", async () => {
  process.env.CLAUDE_CODE_SESSION_ID = "conv-1"; // ⇒ this core's stableId = conv-1
  const cwd = process.cwd();
  // A prior run shared conv-1, so at startup the core caches old-run as a legacy key.
  recordSelfObserve(HOME, { id: "old-run", stableId: "conv-1", title: "t", tool: TOOL, cwd, pid: 100 }, true);
  const core = startBusCore({ home: HOME });
  try {
    writeInbox(HOME, "old-run", m("from-old-run", 1000));
    // REVOKE: an authoritative correction re-attributes old-run's conv-1 to another conversation.
    recordLearn(HOME, "old-run", "conv-1", "other-conv", "correction", true);
    await delay(250); // let any watch-triggered flush run (it recomputes legacy ⇒ post-correction it won't touch old-run)

    const got1 = await core.recv(0);
    expect(got1.map((x) => x.text)).not.toContain("from-old-run"); // the revoked box is NOT drained anymore
    // and it was never consumed — the message is still waiting in its box.
    expect(claimInbox(HOME, ["old-run"], "probe").map((c) => c.msg.text)).toEqual(["from-old-run"]);

    // LATE LINK: a new incarnation sharing conv-1 appears; its box (unwatched at startup) must now be drained on recv.
    recordSelfObserve(HOME, { id: "late-run", stableId: "conv-1", title: "t", tool: TOOL, cwd, pid: 300 }, true);
    writeInbox(HOME, "late-run", m("from-late-run", 2000));
    await delay(50);
    const got2 = await core.recv(100);
    expect(got2.map((x) => x.text)).toContain("from-late-run"); // the newly-linked box is auto-recovered
  } finally {
    await core.close();
  }
});

// F40-2-A: the refresh must run before EVERY drain in a pending recv's poll loop — not only at recv entry — so an identity-log
// change DURING the wait is honored on the next poll (prior versions only refreshed at entry).
test("F40-2-A: a correction/late-link DURING a pending recv is honored on the next poll", async () => {
  process.env.CLAUDE_CODE_SESSION_ID = "sid-a";
  const cwd = process.cwd();
  const core = startBusCore({ home: HOME });
  try {
    // old-run shares sid-a; appended AFTER start ⇒ its box is NOT fs-watched, so only the recv poll drives this claim path.
    recordSelfObserve(HOME, { id: "old-run", stableId: "sid-a", title: "t", tool: TOOL, cwd, pid: 100 }, true);
    // REVOKE during the wait: start a pending recv (boxes empty ⇒ it polls), then mid-wait revoke old-run + write to its box.
    const recvP = core.recv(400);
    await delay(40);
    recordLearn(HOME, "old-run", "sid-a", "other-conv", "correction", true);
    writeInbox(HOME, "old-run", m("private-after-revoke", 1000));
    expect((await recvP).map((x) => x.text)).not.toContain("private-after-revoke"); // next poll refreshed ⇒ revoked box NOT claimed
    expect(claimInbox(HOME, ["old-run"], "probe").map((c) => c.msg.text)).toEqual(["private-after-revoke"]); // still waiting

    // ADD during the wait: a late same-native link appearing mid-wait IS drained on the next poll.
    const recvP2 = core.recv(400);
    await delay(40);
    recordSelfObserve(HOME, { id: "late-run", stableId: "sid-a", title: "t", tool: TOOL, cwd, pid: 300 }, true);
    writeInbox(HOME, "late-run", m("from-late", 2000));
    expect((await recvP2).map((x) => x.text)).toContain("from-late");
  } finally {
    await core.close();
  }
});

// F40-2-B: a transient read failure (EACCES) must not strand mail. While blind, grant NO legacy claim (the log may already
// carry a revoke); after perms restore — with the file's bytes/mtime/size UNCHANGED — the next recv/flush must re-read and
// recover the legit box. A real chmod/EACCES, restored in finally; needs a non-root user (root ignores chmod 0).
test("F40-2-B: a read EACCES grants no legacy claim; recovery re-reads after restore (unchanged log)", async () => {
  process.env.CLAUDE_CODE_SESSION_ID = "sid-b";
  const cwd = process.cwd();
  const core = startBusCore({ home: HOME });
  const logFile = path.join(HOME, ".agenthop", "bus-identity", "alias-log.jsonl");
  let mode = 0o600;
  try {
    recordSelfObserve(HOME, { id: "old-run", stableId: "sid-b", title: "t", tool: TOOL, cwd, pid: 100 }, true);
    await core.recv(0); // fold once so old-run is cached as a legacy key
    recordLearn(HOME, "old-run", "sid-b", "other-conv", "correction", true);                                 // REVOKE old-run
    recordSelfObserve(HOME, { id: "late-run", stableId: "sid-b", title: "t", tool: TOOL, cwd, pid: 300 }, true); // legit late link
    writeInbox(HOME, "old-run", m("revoked-box", 1000));
    writeInbox(HOME, "late-run", m("legit-late", 2000));

    mode = statSync(logFile).mode & 0o777;
    chmodSync(logFile, 0o000);
    let reallyBlind = false;
    try { readFileSync(logFile); } catch { reallyBlind = true; }
    if (!reallyBlind) { chmodSync(logFile, mode); return; } // this user can still read (root-ish) ⇒ cannot exercise EACCES

    const blind = await core.recv(0);
    expect(blind.map((x) => x.text)).not.toContain("revoked-box"); // conservative: no legacy claim while blind
    expect(blind.map((x) => x.text)).not.toContain("legit-late");

    chmodSync(logFile, mode); // restore; bytes/mtime/size unchanged across the outage
    const recovered = await core.recv(200);
    expect(recovered.map((x) => x.text)).toContain("legit-late");  // RETRY sentinel forced a re-read despite the unchanged stamp
    expect(claimInbox(HOME, ["old-run"], "probe").map((c) => c.msg.text)).toEqual(["revoked-box"]); // revoked box never claimed
  } finally {
    try { chmodSync(logFile, mode); } catch { /* best effort */ }
    await core.close();
  }
});
