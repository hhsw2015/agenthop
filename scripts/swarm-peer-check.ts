// Dispatcher-side listener for the swarm-networking proof: join a (scoped) team's bus and report any peers
// discovered + messages received, for N seconds. Run with AGENTHOP_TEAM=<scoped> so it shares the box's bus.
//   AGENTHOP_TEAM=<secret> AGENTHOP_NO_CODEX=1 AH_HOME=/tmp/ah-disp npx tsx scripts/swarm-peer-check.ts 60
import { startBusCore } from "../packages/bus/src/core.js";

const secs = Number(process.argv[2] ?? 40);
const core = startBusCore({ home: process.env.AH_HOME });
const seen = new Set<string>();

(async () => {
  console.log(`listening as ${core.self.title} (${core.self.id.slice(0, 8)}) for ${secs}s...`);
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    for (const p of core.peers()) {
      if (p.id !== core.self.id && !seen.has(p.id)) {
        seen.add(p.id);
        console.log(`PEER: ${p.title} via=${p.via}${p.machine ? ` @${p.machine}` : ""} id=${p.id.slice(0, 8)}`);
      }
    }
    for (const m of await core.recv(2000)) console.log(`MSG from ${m.fromLabel} (${m.via}): ${m.text}`);
  }
  await core.close();
  console.log(`done. peers seen: ${seen.size}`);
  process.exit(0);
})();
