// Dispatcher-side: find a peer by title substring, send it a task over the bus, and print any replies. Used to
// drive the box's persistent Claude Code TUI as a swarm node. Run with CLAUDE_CODE_MESSAGING_SOCKET UNSET so the
// reply lands in this node's recv queue instead of auto-surfacing into the operator's own Claude session.
//   env -u CLAUDE_CODE_MESSAGING_SOCKET AGENTHOP_TEAM=<secret> AGENTHOP_NO_CODEX=1 AH_HOME=/tmp/ah-ask \
//     npx tsx scripts/swarm-ask.ts "railway:worker-he" "task text" 90
import { startBusCore } from "../packages/bus/src/core.js";

const targetSub = process.argv[2] ?? "railway:";
const task = process.argv[3] ?? "ping";
const secs = Number(process.argv[4] ?? 90);
const core = startBusCore({ home: process.env.AH_HOME });
console.log(`ASK up as ${core.self.title} (${core.self.id.slice(0, 8)}); seeking "${targetSub}" for ${secs}s`);

(async () => {
  const deadline = Date.now() + secs * 1000;
  let sent = false;
  while (Date.now() < deadline) {
    if (!sent) {
      const peer = core.peers().find((p) => p.id !== core.self.id && p.title.includes(targetSub));
      if (peer) {
        console.log(`found peer ${peer.title} (${peer.via}); sending task`);
        const r = await core.send(peer.id, task);
        console.log(`sent ok=${r.ok}${r.error ? " err=" + r.error : ""}`);
        sent = true;
      }
    }
    for (const m of await core.recv(2000)) console.log(`REPLY from ${m.fromLabel} (${m.via}): ${m.text}`);
  }
  await core.close();
  process.exit(0);
})();
