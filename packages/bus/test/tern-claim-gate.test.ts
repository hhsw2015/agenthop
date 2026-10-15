import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeInbox } from "../src/inbox.js";
import { writeSeatShell } from "../src/swarm/tern-wake.js";

// Unique-claimant gate, REAL processes (PROGRESS #1025). Two bus cores share ONE sid — one attests herdr, one attests Tern — exactly
// the dual-shell state after a migration. With the seat registered to Tern: the herdr twin must refuse the claim and leave the mail
// in place; the Tern instance must then claim it. Each child is awaited and killed on every path (no leaked subprocess).

const SID = "claim-gate-sid-0001";
const CHILD = path.join(__dirname, "fixtures", "claim-gate-child.mts");
const TSX = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(tmpdir(), "ah-claim-gate-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

function runChild(shellEnv: Record<string, string>): Promise<{ shell: string; claimed: string[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: SID, CLAIM_GATE_HOME: HOME, AGENTHOP_NO_CODEX: "1", AGENTHOP_TOOL: "claude", SWARM_INBOX_WAKE: "0", ...shellEnv };
    delete env.TERN_PANE; delete env.HERDR_ENV; delete env.HERDR_PANE_ID; delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    Object.assign(env, shellEnv);
    const child = spawn(TSX, [CHILD], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { err += b; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timed out; stderr=${err}`)); }, 20_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop();
      try { resolve({ ...JSON.parse(line ?? "{}"), stderr: err }); } catch (e) { reject(new Error(`bad child output: ${out} / ${err}`)); }
    });
  });
}

const msg = (text: string) => ({ from: "coord", fromLabel: "coord", text, via: "local" as const, ts: 1000 });
const pending = () => readdirSync(path.join(HOME, ".agenthop", "inbox", SID)).filter((n) => n.endsWith(".json"));

test("registered tern: the herdr twin refuses + leaves the file; the Tern instance claims it", async () => {
  writeSeatShell(HOME, SID, "tern", 1000);
  writeInbox(HOME, SID, msg("dispatch-1"));

  const herdr = await runChild({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p4" });
  expect(herdr.claimed).toEqual([]);
  expect(herdr.stderr).toMatch(/stale-shell claim refused/);
  expect(pending().length).toBe(1); // left in place: not renamed, not deleted, not quarantined

  const tern = await runChild({ TERN_PANE: "1056561954854" });
  expect(tern.claimed).toEqual(["dispatch-1"]);
  expect(pending().length).toBe(0);
}, 60_000);

test("registered herdr mirrors it: the Tern twin refuses, herdr claims", async () => {
  writeSeatShell(HOME, SID, "herdr", 1000);
  writeInbox(HOME, SID, msg("dispatch-2"));
  expect((await runChild({ TERN_PANE: "1056561954854" })).claimed).toEqual([]);
  expect(pending().length).toBe(1);
  expect((await runChild({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p4" })).claimed).toEqual(["dispatch-2"]);
}, 60_000);

test("unregistered seat: v0 behavior, any instance may claim", async () => {
  writeInbox(HOME, SID, msg("dispatch-3"));
  expect((await runChild({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p4" })).claimed).toEqual(["dispatch-3"]);
}, 60_000);

test("registered tern but the claimer cannot attest a shell (codex-seat MCP): allowed, never stranded", async () => {
  writeSeatShell(HOME, SID, "tern", 1000);
  writeInbox(HOME, SID, msg("dispatch-4"));
  expect((await runChild({})).claimed).toEqual(["dispatch-4"]);
}, 60_000);

// IWT-SV-P2-4: the AUTO-FLUSH path. A child with a WORKING host channel (private socket) and NO recv call — delivery can only come
// from the core's own flush. The stale-shell instance must push ZERO frames and leave the mail pending; the owning shell must push
// it. This test fails if only the flush gate is removed (the recv-only tests above would not notice).
function runFlushChild(shellEnv: Record<string, string>): Promise<{ frames: number }> {
  return new Promise((resolve, reject) => {
    const sock = path.join(HOME, `host-${Math.random().toString(16).slice(2, 8)}.sock`);
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: SID, CLAIM_GATE_HOME: HOME, AGENTHOP_NO_CODEX: "1", AGENTHOP_TOOL: "claude", SWARM_INBOX_WAKE: "0", CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: "t" };
    delete env.TERN_PANE; delete env.HERDR_ENV; delete env.HERDR_PANE_ID;
    Object.assign(env, shellEnv);
    const child = spawn(TSX, [path.join(__dirname, "fixtures", "claim-gate-flush-child.mts")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { err += b; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`flush child timed out; stderr=${err}`)); }, 30_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop();
      try { resolve(JSON.parse(line ?? "{}")); } catch { reject(new Error(`bad flush child output: ${out} / ${err}`)); }
    });
  });
}

test("auto-flush: registered tern ⇒ herdr twin pushes ZERO frames and the mail stays pending; Tern instance delivers it", async () => {
  writeSeatShell(HOME, SID, "tern", 1000);
  writeInbox(HOME, SID, msg("flush-dispatch"));

  const herdr = await runFlushChild({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p4" });
  expect(herdr.frames).toBe(0);
  expect(pending().length).toBe(1);

  const tern = await runFlushChild({ TERN_PANE: "1056561954854" });
  expect(tern.frames).toBe(1);
  expect(pending().length).toBe(0);
}, 90_000);
