#!/usr/bin/env tsx
/**
 * swarm-resume — one command to bring the swarm back after a reboot (board: swarm-resume, author 90b58f9c).
 *
 * The user's pain: after a restart the whole swarm is gone and every window gets re-opened by hand. This is
 * the thin IO shell over the pure core (packages/bus/src/swarm/resume.ts) and the existing Ghostty launcher
 * (packages/bus/src/spawn.ts) — it adds no launch logic of its own.
 *
 *   tsx scripts/swarm-resume.ts --snapshot      # capture the live roster -> roster-snapshot.json (on demand)
 *   tsx scripts/swarm-resume.ts --dry           # show what would relaunch (and the exact resume command)
 *   tsx scripts/swarm-resume.ts                 # relaunch every captured window that is not already up
 *
 * F36: each window relaunches with its FULL resume command (captured from the live process args, else the user's
 * canon) — never a bare `claude --resume`, which loses permission mode / model / effort. The launch runs that
 * command verbatim in a new Ghostty window via spawn.ts's exported buildAppleScript (spawn body unchanged).
 *
 * Idempotent: a window already live (same tool+cwd) is skipped, so re-running only fills the gaps. Partial
 * failures are reported and do NOT stop the rest.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startBusCore } from "../packages/bus/src/core.js";
import { buildAppleScript } from "../packages/bus/src/spawn.js";
import { herdrAgentName, herdrAgentStates, herdrLaunch, herdrServerReachable, herdrSpawnable, splitCommand } from "../packages/bus/src/swarm/herdr.js";
import { ROSTER_FILE, assembleRoster, parseSnapshot, planResume, resumeCommandForMember, type PeerLike } from "../packages/bus/src/swarm/resume.js";

const pexec = promisify(execFile);

function rosterPath(): string {
  const home = process.env.AH_HOME ?? homedir();
  return path.join(home, ".agenthop", "swarm", ROSTER_FILE);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a live process's full argv (ps -o args=), split into tokens. undefined when the pid is gone/unreadable. */
async function psArgs(pid: number): Promise<string[] | undefined> {
  try {
    const { stdout } = await pexec("ps", ["-o", "args=", "-p", String(pid)]);
    const line = stdout.trim();
    return line ? line.split(/\s+/) : undefined;
  } catch {
    return undefined; // process gone or ps unavailable -> fall back to the canon template
  }
}

/** Launch one resume command in a fresh Ghostty window (reuses spawn.ts's buildAppleScript; runs cmd verbatim). */
async function launchWindow(command: string, cwd: string): Promise<void> {
  const script = buildAppleScript({ command, cwd, env: [] });
  await pexec("osascript", ["-e", script], { timeout: 15000 });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const out = opt("--out") ?? rosterPath();

  const core = startBusCore({ home: process.env.AH_HOME });
  try {
    await sleep(1500); // let the local broker + a relay announce before we read the roster

    if (flag("--snapshot")) {
      // Enrich each peer with its live argv (ps pid->args) so the full resume command is captured.
      const peers: PeerLike[] = await Promise.all(
        core.peers().map(async (p) => ({ ...p, argv: typeof p.pid === "number" ? await psArgs(p.pid) : undefined })),
      );
      const snap = assembleRoster(peers, Math.floor(Date.now() / 1000), { selfId: core.self.id });
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(snap, null, 2)}\n`);
      console.log(`captured ${snap.members.length} window(s) (schema v${snap.version}) -> ${out}`);
      for (const m of snap.members) console.log(`  ${m.title ?? m.member}  [${m.resumeCmdSource}]  ${m.resumeCmd}`);
      return;
    }

    const file = out;
    if (!existsSync(file)) {
      console.error(`no roster snapshot at ${file}. Capture one first:  tsx scripts/swarm-resume.ts --snapshot`);
      process.exit(1);
    }
    const snap = parseSnapshot(readFileSync(file, "utf8"));
    if (!snap) { console.error(`roster snapshot at ${file} is unreadable/corrupt.`); process.exit(1); }

    const plan = planResume(snap, core.peers());
    console.log(`roster: ${snap.members.length} window(s) (schema v${snap.version}) · ${plan.skip.length} already live · ${plan.launch.length} to relaunch`);
    for (const m of plan.skip) console.log(`  skip (live)  ${m.title ?? m.member}  ${m.tool}  ${m.cwd}`);

    if (flag("--dry")) {
      for (const m of plan.launch) console.log(`  would launch  ${m.title ?? m.member}  ->  ${resumeCommandForMember(m)}`);
      return;
    }

    // herdr backend (S14): inside a herdr pane + server reachable -> relaunch as herdr panes; else Ghostty.
    const useHerdr = herdrSpawnable(process.env) && (await herdrServerReachable());
    console.log(`backend: ${useHerdr ? "herdr" : "Ghostty (osascript)"}`);
    const taken = useHerdr ? new Set((await herdrAgentStates()).map((a) => a.name)) : new Set<string>();
    let ok = 0, fail = 0, unconfirmed = 0;
    for (const m of plan.launch) {
      const cmd = resumeCommandForMember(m); // F36: full resume command, never a bare relaunch
      try {
        const sc = splitCommand(cmd);
        // herdr only when it's on AND the command tokenizes cleanly (H-P2-4: unbalanced quotes -> Ghostty keeps
        // arg boundaries); a hard not-started also falls back; an unconfirmed launch is kept, never re-launched.
        if (useHerdr && sc.balanced) {
          const name = herdrAgentName(m.title ?? m.member, taken); taken.add(name);
          const r = await herdrLaunch({ name, kind: sc.kind, cwd: m.cwd, args: sc.args });
          if (r.state === "started") { ok++; console.log(`  launched[herdr]  ${m.title ?? m.member}  pane ${r.paneId}  (${cmd})`); continue; }
          if (r.state === "unconfirmed") { unconfirmed++; console.log(`  unconfirmed[herdr]  ${m.title ?? m.member}  ${r.note} — kept, NOT re-launched`); continue; }
          console.error(`  herdr not-started (${r.note}); falling back to Ghostty for ${m.title ?? m.member}`);
        }
        await launchWindow(cmd, m.cwd);
        ok++;
        console.log(`  launched  ${m.title ?? m.member}  ${m.cwd}  (${cmd})`);
      } catch (e) {
        fail++; // partial failure must not stop the rest
        console.error(`  FAILED    ${m.title ?? m.member}  ${m.cwd}  (${(e as Error).message})`);
      }
    }
    console.log(`done: ${ok} launched, ${unconfirmed} unconfirmed(kept), ${fail} failed, ${plan.skip.length} already live. Each session self-reports; the sweep takes over.`);
    if (fail) process.exitCode = 1;
  } finally {
    await core.close();
  }
}

// Guard so the module can be imported without running (msglog P1 lesson).
if (process.argv[1] && /(^|\/)swarm-resume\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
