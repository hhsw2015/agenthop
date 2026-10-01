// LIVE runner (GATED) — allocate a Railway 60-min box, run a task on its pre-installed CLI repointed at CPA with
// a fresh eph token, and collect the sealed result over the per-task A2A room. This does REAL `ssh railway.new`
// and spends CPA budget: only run it deliberately.
//
// Prereqs: `cd packages/bus && bun run build:swarm-report` (builds the VM reporter bundle); CPA_EPH_SECRET set
// (or ~/.cpa_eph_secret); AGENTHOP_CPA_BASE = the CPA endpoint (e.g. https://headroom.geeker.indevs.in).
//   AGENTHOP_CPA_BASE=https://headroom.geeker.indevs.in npx tsx scripts/railway-run.ts --tool claude --task "reply with today's date and which model you are"
import { runRailwayTask, type RailwayTool } from "../packages/bus/src/swarm/railway.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const tool = (flag("--tool") ?? "claude") as RailwayTool;
const task = flag("--task");
const ttl = flag("--ttl");
if (!task) {
  process.stderr.write('usage: --task "<text>" [--tool claude|codex|opencode] [--ttl <seconds>]\n');
  process.exit(1);
}

runRailwayTask({ tool, task, ttlSec: ttl ? Number(ttl) : undefined })
  .then((r) => {
    process.stdout.write(`launch ${r.launchId}  room ${r.code}\n--- result ---\n${r.result ?? "(no result collected before timeout)"}\n`);
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
