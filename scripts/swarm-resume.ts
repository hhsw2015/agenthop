#!/usr/bin/env tsx
/**
 * swarm-resume — one command to bring the swarm back after a reboot (board: swarm-resume, author 90b58f9c).
 *
 * The user's pain: after a restart the whole swarm is gone and every window gets re-opened by hand. This is
 * the thin IO shell over the pure core (packages/bus/src/swarm/resume.ts) and the existing Ghostty launcher
 * (packages/bus/src/spawn.ts) — it adds no launch logic of its own.
 *
 *   tsx scripts/swarm-resume.ts --snapshot      # capture the live roster -> roster-snapshot.json (on demand)
 *   tsx scripts/swarm-resume.ts --dry           # show what would relaunch, launch nothing
 *   tsx scripts/swarm-resume.ts                 # relaunch every captured window that is not already up
 *
 * Idempotent: a window already live (same tool+cwd) is skipped, so re-running only fills the gaps. Partial
 * failures are reported and do NOT stop the rest (spec item 3). Decoupled from closeout on purpose — the
 * snapshot is captured from the live bus roster, so resume works today; the at-closeout auto-capture is the
 * same writer hung at the closeout seam (diff handed to that owner, board dep L2-struct).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { startBusCore } from "../packages/bus/src/core.js";
import { spawnAgent } from "../packages/bus/src/spawn.js";
import { ROSTER_FILE, assembleRoster, parseSnapshot, planResume } from "../packages/bus/src/swarm/resume.js";

function rosterPath(): string {
  const home = process.env.AH_HOME ?? homedir();
  return path.join(home, ".agenthop", "swarm", ROSTER_FILE);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const out = opt("--out") ?? rosterPath();

  const core = startBusCore({ home: process.env.AH_HOME });
  try {
    await sleep(1500); // let the local broker + a relay announce before we read the roster

    if (flag("--snapshot")) {
      const snap = assembleRoster(core.peers(), Math.floor(Date.now() / 1000), { selfId: core.self.id });
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(snap, null, 2)}\n`);
      console.log(`captured ${snap.members.length} window(s) -> ${out}`);
      for (const m of snap.members) console.log(`  ${m.title ?? m.member}  ${m.tool}  ${m.cwd}`);
      return;
    }

    const file = out;
    if (!existsSync(file)) {
      console.error(`no roster snapshot at ${file}. Capture one first:  tsx scripts/swarm-resume.ts --snapshot`);
      console.error(`(the at-closeout auto-capture is pending the closeout hook — board dep L2-struct.)`);
      process.exit(1);
    }
    const snap = parseSnapshot(readFileSync(file, "utf8"));
    if (!snap) { console.error(`roster snapshot at ${file} is unreadable/corrupt.`); process.exit(1); }

    const plan = planResume(snap, core.peers());
    console.log(`roster: ${snap.members.length} window(s) · ${plan.skip.length} already live · ${plan.launch.length} to relaunch`);
    for (const m of plan.skip) console.log(`  skip (live)  ${m.title ?? m.member}  ${m.tool}  ${m.cwd}`);

    if (flag("--dry")) {
      for (const m of plan.launch) console.log(`  would launch  ${m.title ?? m.member}  ${m.tool}  ${m.cwd}`);
      return;
    }

    let ok = 0, fail = 0;
    for (const m of plan.launch) {
      try {
        const r = await spawnAgent({ tool: m.tool, cwd: m.cwd, visible: true });
        if (r.ok) { ok++; console.log(`  launched  ${m.title ?? m.member}  ${m.tool}  ${m.cwd}  (${r.note})`); }
        else { fail++; console.error(`  FAILED    ${m.title ?? m.member}  ${m.tool}  ${m.cwd}  (${r.note})`); }
      } catch (e) {
        fail++; // partial failure must not stop the rest (spec item 3)
        console.error(`  FAILED    ${m.title ?? m.member}  ${m.tool}  ${m.cwd}  (${(e as Error).message})`);
      }
    }
    console.log(`done: ${ok} launched, ${fail} failed, ${plan.skip.length} already live. Each session self-reports; the sweep takes over.`);
    if (fail) process.exitCode = 1;
  } finally {
    await core.close();
  }
}

// Guard so the module can be imported without running (msglog P1 lesson).
if (process.argv[1] && /(^|\/)swarm-resume\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
