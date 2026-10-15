// Child process for the unique-claimant fixture: starts a REAL bus core (same sid via CLAUDE_CODE_SESSION_ID) in the shell its env
// attests (TERN_PANE ⇒ tern, HERDR_ENV+HERDR_PANE_ID ⇒ herdr), drains its durable inbox once via recv, prints what it claimed as
// one JSON line, and exits. Run by tern-claim-gate.test.ts — never by hand.
import { startBusCore } from "../../src/core.js";

const home = process.env.CLAIM_GATE_HOME!;
const core = startBusCore({ home });
const got = await core.recv(300);
process.stdout.write(`${JSON.stringify({ shell: process.env.TERN_PANE ? "tern" : "herdr", claimed: got.map((m) => m.text) })}\n`);
process.exit(0);
