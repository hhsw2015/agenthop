// Dispatcher-side auto-replier (她) for the agent-to-agent communication proof: join the scoped team's bus,
// and for every message received, reply to its sender. Proves two-way agent messaging with the box (他).
//   AGENTHOP_TEAM=<secret> AGENTHOP_NO_CODEX=1 AH_HOME=/tmp/ah-she npx tsx scripts/swarm-echo.ts 120
import { startBusCore } from "../packages/bus/src/core.js";

const secs = Number(process.argv[2] ?? 120);
const core = startBusCore({ home: process.env.AH_HOME });
console.log(`SHE up as ${core.self.title} (${core.self.id.slice(0, 8)}) for ${secs}s`);

const deadline = Date.now() + secs * 1000;
(async () => {
  while (Date.now() < deadline) {
    for (const m of await core.recv(2000)) {
      console.log(`SHE GOT from ${m.fromLabel} (${m.via}): ${m.text}`);
      const r = await core.send(m.from, `ack from 她 (${core.self.title}): I received "${m.text}"`);
      console.log(`SHE replied to ${m.fromLabel}: ok=${r.ok}${r.error ? " err=" + r.error : ""}`);
    }
  }
  await core.close();
  process.exit(0);
})();
