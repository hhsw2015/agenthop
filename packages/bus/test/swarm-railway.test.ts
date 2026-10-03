import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startRelay, type RunningRelay } from "@agenthop/relay-node";
import { reportResult } from "../src/swarm/room.js";
import {
  buildSshArgv,
  buildVmBootstrap,
  genKeyArgv,
  keyDir,
  runRailwayTask,
  scpArgv,
  type Run,
} from "../src/swarm/railway.js";

const TEST_SECRET = "test-eph-secret-not-the-real-one";

// --- pure builders (no ssh) ---

test("buildSshArgv uses the isolated throwaway key and never the user's agent/known_hosts", () => {
  const argv = buildSshArgv("/tmp/ah-rwkey-x/id", "/tmp/ah-rwkey-x/known_hosts", "echo hi");
  expect(argv).toEqual([
    "-i", "/tmp/ah-rwkey-x/id",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=/tmp/ah-rwkey-x/known_hosts",
    "railway.new", "echo hi",
  ]);
});

test("genKeyArgv makes a per-launch ed25519 key under the launch's own dir (distinct key per box)", () => {
  const a = genKeyArgv("rw-aaa");
  const b = genKeyArgv("rw-bbb");
  expect(a.argv).toEqual(["-t", "ed25519", "-f", path.join(keyDir("rw-aaa"), "id"), "-N", "", "-q"]);
  expect(a.keyPath).not.toBe(b.keyPath); // 1 box = 1 key
  expect(a.keyPath.startsWith(keyDir("rw-aaa"))).toBe(true);
});

test("scpArgv ships the bundle to the box over the isolated key", () => {
  const argv = scpArgv("/k/id", "/k/kh", "/local/ah-report.js", "/tmp/ah-report.js");
  expect(argv).toContain("/local/ah-report.js");
  expect(argv).toContain("railway.new:/tmp/ah-report.js");
  expect(argv).toContain("IdentitiesOnly=yes");
});

test("buildVmBootstrap strips telemetry, repoints the CLI at CPA, runs headless, and posts the sealed result", () => {
  const script = buildVmBootstrap({
    tool: "claude",
    task: "say hi; rm -rf nothing", // shell-metachar laden → must be quoted, not interpreted
    cpaBase: "https://cpa.example.com/", // trailing slash trimmed
    token: "eyJ.tok.en",
    roomCode: "1234-foo-bar-baz",
    keyHex: "ab".repeat(32),
    relay: "https://relay.example.com",
    reportPath: "/tmp/ah-report.js",
  });
  expect(script).toContain("express-agent"); // telemetry strip present
  expect(script).toContain("export ANTHROPIC_BASE_URL='https://cpa.example.com'");
  expect(script).toContain("export ANTHROPIC_AUTH_TOKEN='eyJ.tok.en'");
  expect(script).toContain("claude -p 'say hi; rm -rf nothing'"); // task shell-quoted, not expanded
  expect(script).toContain("node '/tmp/ah-report.js' --code '1234-foo-bar-baz' --key '" + "ab".repeat(32) + "' --relay 'https://relay.example.com'");
});

test("buildVmBootstrap uses the OpenAI wire protocol for codex", () => {
  const script = buildVmBootstrap({
    tool: "codex", task: "t", cpaBase: "https://cpa.example.com", token: "tok",
    roomCode: "c", keyHex: "cd".repeat(32), relay: "r", reportPath: "/p",
  });
  expect(script).toContain("export OPENAI_BASE_URL='https://cpa.example.com/v1'");
  expect(script).toContain("codex exec 't'");
});

// --- orchestration over a local relay, with ssh mocked (no real VM) ---

let relay: RunningRelay;
let home: string;
beforeEach(async () => {
  relay = await startRelay();
  home = mkdtempSync(path.join(tmpdir(), "ah-swarm-"));
});
afterEach(async () => {
  await relay.close();
  rmSync(home, { recursive: true, force: true });
});

test("runRailwayTask binds key+token+room to one launchId and collects the result the 'VM' posts (ssh mocked)", async () => {
  // Mock every child process: keygen/scp are no-ops; the ssh call parses the bootstrap and SIMULATES the box by
  // sealing+posting a result to the per-task room with the exact code/key/relay the runner injected.
  const run: Run = async (cmd, args) => {
    if (cmd === "ssh") {
      const script = args[args.length - 1]!;
      const code = /--code '([^']*)'/.exec(script)?.[1];
      const key = /--key '([^']*)'/.exec(script)?.[1];
      const r = /--relay '([^']*)'/.exec(script)?.[1];
      // Also prove the eph token + CPA repoint were injected.
      expect(script).toContain("ANTHROPIC_AUTH_TOKEN='");
      await reportResult({ code: code!, keyHex: key!, text: "SIMULATED: done", relay: r });
    }
    return { stdout: "", stderr: "" };
  };

  const out = await runRailwayTask({
    tool: "claude",
    task: "do the thing",
    relay: relay.url,
    cpaBase: "https://cpa.example.com",
    secret: TEST_SECRET, // never the real secret
    collectMs: 15_000,
    home,
    run,
  });

  expect(out.result).toBe("SIMULATED: done");
  expect(out.launchId.startsWith("rw-")).toBe(true);
  // 1:1:1 binding recorded: launchId ties the key + token sub + room together.
  const binding = JSON.parse(readFileSync(path.join(home, ".agenthop", "swarm", `${out.launchId}.json`), "utf8"));
  expect(binding.sub).toBe(out.launchId);
  expect(binding.roomCode).toBe(out.code);
  expect(binding.keyPath).toBe(path.join(keyDir(out.launchId), "id"));
}, 60000);
