// Crash/race fixture child for the TG bridge (TGP-7). It records a REAL decision to the durable ledger via the SAME store entry
// the bridge driver uses, then either HARD-CRASHES (SIGKILL self — exactly the on-disk state a killed bridge leaves: ledger written,
// offset never advanced, receipt never forwarded) or exits cleanly (to race two instances). The parent proves recovery / exactly-once.
// argv: <home> <batchId> <itemId> <verdict> <scope|-> <mode:crash|exit>
import { recordDecision } from "../../src/swarm/decision-batch-store.js";

const [home, batchId, itemId, verdict, scopeArg, mode] = process.argv.slice(2);
const scope = scopeArg && scopeArg !== "-" ? scopeArg : undefined;
const dec = { id: itemId!, verdict: verdict as "approve" | "reject" | "defer", ...(scope ? { scope: scope as "once" | "this-chat" | "always" } : {}) };
const outcome = recordDecision(home!, batchId!, dec, Math.floor(Date.now() / 1000));
process.stdout.write(outcome + "\n");
if (mode === "crash") {
  if (outcome !== "recorded") process.exit(3); // the crash scenario requires a real write first
  process.kill(process.pid, "SIGKILL"); // hard crash: no offset write, no forward, no graceful teardown
}
process.exit(outcome === "recorded" || outcome === "consumed" ? 0 : 4);
