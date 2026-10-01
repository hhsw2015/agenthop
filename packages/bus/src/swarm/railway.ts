import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mintEphToken, readEphSecret } from "./mint.js";
import { openTaskRoom } from "./room.js";
import { shquote } from "../spawn.js";

/**
 * The SSH-inject runner — the dispatcher half of swarm-on-Railway. Per task: a fresh launchId binds ONE
 * throwaway SSH key + ONE CPA eph-token + ONE per-task A2A room (the 1:1:1 the user required). The runner
 * allocates a Railway 60-min box, scp's the VM reporter bundle, and ssh-runs a bootstrap that strips the box's
 * telemetry hooks, repoints the pre-installed CLI at CPA with the eph token, runs the task headless, and posts
 * the sealed result to the per-task room — which the dispatcher collects asynchronously. No team key, no real
 * relay key, and no CPA_EPH_SECRET ever touches the box.
 *
 * Builders are pure (unit-tested); every child process goes through an injectable `run` so tests never ssh.
 * The actual `ssh railway.new` only happens via runRailwayTask with the default `run` — a GATED live step.
 */

export type RailwayTool = "claude" | "codex" | "opencode";
const TOOLS: readonly RailwayTool[] = ["claude", "codex", "opencode"];

export type Run = (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

const execFileP = promisify(execFile);
const defaultRun: Run = async (cmd, args, opts) => {
  const child = execFileP(cmd, args, { timeout: opts?.timeoutMs ?? 0, maxBuffer: 16 * 1024 * 1024 });
  if (opts?.input !== undefined) {
    child.child.stdin?.end(opts.input);
  }
  const { stdout, stderr } = await child;
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

export function newLaunchId(): string {
  return `rw-${randomUUID().slice(0, 8)}`;
}

/** Per-launch throwaway-key location. A DISTINCT key per box (Railway identity = key fingerprint); the key is the box handle while it lives. */
export function keyDir(launchId: string): string {
  return path.join("/tmp", `ah-rwkey-${launchId}`);
}

/** argv for `ssh-keygen` to make the throwaway ed25519 key (no passphrase). */
export function genKeyArgv(launchId: string): { argv: string[]; keyPath: string; knownHostsPath: string } {
  const dir = keyDir(launchId);
  const keyPath = path.join(dir, "id");
  return { argv: ["-t", "ed25519", "-f", keyPath, "-N", "", "-q"], keyPath, knownHostsPath: path.join(dir, "known_hosts") };
}

/** The isolated-key ssh options (per railway-ephemeral-vm.md) — never touch the user's agent/known_hosts. */
function isolatedKeyOpts(keyPath: string, knownHostsPath: string): string[] {
  return [
    "-i", keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHostsPath}`,
  ];
}

export function buildSshArgv(keyPath: string, knownHostsPath: string, remoteScript: string): string[] {
  return [...isolatedKeyOpts(keyPath, knownHostsPath), "railway.new", remoteScript];
}

export function scpArgv(keyPath: string, knownHostsPath: string, localPath: string, remotePath: string): string[] {
  return [...isolatedKeyOpts(keyPath, knownHostsPath), localPath, `railway.new:${remotePath}`];
}

/** Repoint the pre-installed CLI at CPA + its headless run command, per tool. Values are shell-quoted. */
function cliEnvAndRun(tool: RailwayTool, task: string, cpaBase: string, token: string): { env: string[]; runCmd: string } {
  const base = cpaBase.replace(/\/+$/, "");
  if (tool === "claude") {
    return {
      env: [`export ANTHROPIC_BASE_URL=${shquote(base)}`, `export ANTHROPIC_AUTH_TOKEN=${shquote(token)}`],
      runCmd: `claude -p ${shquote(task)}`,
    };
  }
  // codex / opencode speak the OpenAI wire protocol; CPA exposes it at /v1.
  const openai = [`export OPENAI_BASE_URL=${shquote(`${base}/v1`)}`, `export OPENAI_API_KEY=${shquote(token)}`];
  return { env: openai, runCmd: tool === "codex" ? `codex exec ${shquote(task)}` : `opencode run ${shquote(task)}` };
}

/**
 * Strip the box's bundled-agent telemetry: remove any hook group that mentions `express-agent` from
 * ~/.claude/settings.json and ~/.codex/hooks.json so the box doesn't phone home `latestPrompt`. Best-effort
 * (a box without the file is a no-op). Pure node — the box has node24.
 */
const TELEMETRY_STRIP = `node -e 'const fs=require("fs"),os=require("os"),p=require("path");for(const f of [p.join(os.homedir(),".claude","settings.json"),p.join(os.homedir(),".codex","hooks.json")]){try{const j=JSON.parse(fs.readFileSync(f,"utf8"));if(j&&j.hooks){for(const k of Object.keys(j.hooks)){j.hooks[k]=(j.hooks[k]||[]).filter(g=>!JSON.stringify(g).includes("express-agent"));if(!j.hooks[k].length)delete j.hooks[k];}fs.writeFileSync(f,JSON.stringify(j,null,2));}}catch{}}' 2>/dev/null || true`;

export type VmBootstrapInput = {
  tool: RailwayTool;
  task: string;
  cpaBase: string;
  token: string;
  roomCode: string;
  keyHex: string;
  relay: string;
  reportPath: string;
};

/** The remote shell script the box runs: strip telemetry → repoint the CLI at CPA → run the task headless → seal+post the result. */
export function buildVmBootstrap(o: VmBootstrapInput): string {
  const { env, runCmd } = cliEnvAndRun(o.tool, o.task, o.cpaBase, o.token);
  return [
    "set -u",
    TELEMETRY_STRIP,
    ...env,
    // Capture output (and errors) but never abort before reporting — the box must always post SOMETHING back.
    `_ahout=$(${runCmd} 2>&1 || true)`,
    `printf '%s' "$_ahout" | node ${shquote(o.reportPath)} --code ${shquote(o.roomCode)} --key ${shquote(o.keyHex)} --relay ${shquote(o.relay)}`,
  ].join("\n");
}

/** Where the bun-bundled VM reporter lives after `build:swarm-report`. */
export function defaultBundlePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "dist-swarm", "ah-report.mjs");
}

/** The 1:1:1 binding record, written for audit / collect / cleanup. */
export type SwarmBinding = { launchId: string; keyPath: string; sub: string; roomCode: string; relay: string; ts: number };

export function recordBinding(binding: SwarmBinding, home: string = homedir()): void {
  const dir = path.join(home, ".agenthop", "swarm");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${binding.launchId}.json`), `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // audit record is best-effort; the run still proceeds
  }
}

export type RunRailwayTaskInput = {
  tool: RailwayTool;
  task: string;
  ttlSec?: number;
  relay?: string;
  cpaBase?: string;
  bundlePath?: string;
  secret?: string; // test only; production reads CPA_EPH_SECRET
  collectMs?: number;
  remotePath?: string;
  run?: Run;
  home?: string;
};

export type RunRailwayTaskResult = { launchId: string; code: string; result?: string };

/**
 * Allocate a box, inject, run the task, and collect the sealed result over the per-task room. Child processes go
 * through `run` (default: real ssh/scp/ssh-keygen) — the GATED live step. Tests pass a `run` that never sshes.
 */
export async function runRailwayTask(input: RunRailwayTaskInput): Promise<RunRailwayTaskResult> {
  if (!TOOLS.includes(input.tool)) throw new Error(`runRailwayTask: unknown tool "${input.tool}"`);
  if (!input.task.trim()) throw new Error("runRailwayTask: task is required");
  const run = input.run ?? defaultRun;
  const cpaBase = input.cpaBase ?? process.env.AGENTHOP_CPA_BASE;
  if (!cpaBase) throw new Error("runRailwayTask: cpaBase required (option or AGENTHOP_CPA_BASE)");
  const launchId = newLaunchId();
  const token = mintEphToken({ sub: launchId, ttlSec: input.ttlSec, secret: input.secret ?? readEphSecret() });
  const { argv: keygenArgv, keyPath, knownHostsPath } = genKeyArgv(launchId);
  await run("ssh-keygen", keygenArgv);
  const room = await openTaskRoom({ relay: input.relay });
  try {
    const remotePath = input.remotePath ?? "/tmp/ah-report.mjs";
    await run("scp", scpArgv(keyPath, knownHostsPath, input.bundlePath ?? defaultBundlePath(), remotePath));
    const bootstrap = buildVmBootstrap({
      tool: input.tool,
      task: input.task,
      cpaBase,
      token,
      roomCode: room.code,
      keyHex: room.keyHex,
      relay: room.relay,
      reportPath: remotePath,
    });
    await run("ssh", buildSshArgv(keyPath, knownHostsPath, bootstrap));
    recordBinding({ launchId, keyPath, sub: launchId, roomCode: room.code, relay: room.relay, ts: Date.now() }, input.home);
    const results = await room.collect(input.collectMs ?? 90_000);
    return { launchId, code: room.code, result: results[0] };
  } finally {
    await room.close();
  }
}
