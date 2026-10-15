// Child for the AUTO-FLUSH unique-claimant gate (IWT-SV-P2-4). Starts a REAL bus core with a WORKING host channel: a private Unix
// socket (CLAUDE_CODE_MESSAGING_SOCKET) that counts every message frame pushed to it. It never calls recv — delivery can only
// happen through the core's own automatic flush (startup + 5s timer). After the wait it reports how many frames reached the
// "host" and exits. Run by tern-claim-gate.test.ts — never by hand.
import net from "node:net";
import { startBusCore } from "../../src/core.js";

const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET!;
let frames = 0;
const server = net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { if ((JSON.parse(line) as { type?: string }).type === "user") frames++; } catch { /* auth/garbage */ }
    }
  });
});
await new Promise<void>((r) => server.listen(sock, () => r()));
startBusCore({ home: process.env.CLAIM_GATE_HOME! });
await new Promise((r) => setTimeout(r, Number(process.env.FLUSH_WAIT_MS ?? 7000))); // covers the startup flush AND one 5s timer tick
process.stdout.write(`${JSON.stringify({ frames })}\n`);
server.close();
process.exit(0);
