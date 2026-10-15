// seat-presence — write ~/.agenthop/presence/<sid>.pid for a Tern ACP seat (#1053). The ONE implementation tern-restore and
// agenthop_tern share (see packages/bus/src/swarm/seat-presence.ts for the rules).
//
//   tsx scripts/seat-presence.ts resolve <sid> <block-id> <claude|codex>   print the agent pid under that block (exit 1 = not exactly one)
//   tsx scripts/seat-presence.ts set <sid> <block-id> <claude|codex>       resolve, then write presence (exit 0 wrote|kept, 1 refused)
// No "set <sid> <pid>": the writer only ever takes a RESOLVED agent pid, never an arbitrary one. AH_HOME overrides the home dir;
// TERN_BIN the tern binary; SEAT_PRESENCE_PS a file with `ps axo pid=,ppid=,command=` output (tests).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parsePs, pidAlive, resolveAgentPid, writePresence, type SeatTool } from "../packages/bus/src/swarm/seat-presence.js";

const [mode, sid, block, tool] = process.argv.slice(2);
const fail = (m: string, code = 2): never => { process.stderr.write(`seat-presence: ${m}\n`); process.exit(code); };
if ((mode !== "resolve" && mode !== "set") || !sid || !block || (tool !== "claude" && tool !== "codex")) {
  fail("usage: seat-presence <resolve|set> <sid> <block-id> <claude|codex>");
}
let root: number;
try {
  const j = JSON.parse(execFileSync(process.env.TERN_BIN || "tern", ["process", block!, "--json"], { encoding: "utf8", timeout: 5000 })) as { child?: { pid?: unknown } };
  if (!Number.isSafeInteger(j.child?.pid)) throw new Error("no child.pid in `tern process --json`");
  root = j.child!.pid as number;
} catch (e) { fail(`tern process ${block}: ${(e as Error).message}`, 1); }
const ps = process.env.SEAT_PRESENCE_PS ? readFileSync(process.env.SEAT_PRESENCE_PS, "utf8") : execFileSync("ps", ["axo", "pid=,ppid=,command="], { encoding: "utf8" });
const pid = resolveAgentPid(root!, sid!, tool as SeatTool, parsePs(ps));
if (pid === null) fail(`no unique ${tool} agent for ${sid} under block ${block} (tern acp pid ${root!})`, 1);
if (mode === "resolve") { process.stdout.write(`${pid}\n`); process.exit(0); }
const alive = process.env.SEAT_PRESENCE_PS ? () => true : pidAlive;
const r = writePresence(process.env.AH_HOME || homedir(), sid!, pid!, alive);
process.stdout.write(`${JSON.stringify(r)}\n`);
process.exit(r.state === "refused" ? 1 : 0);
