// seat-shell — register / read / clear which shell (tern | herdr) owns a swarm seat. inbox-wake routes the wake ping by it, and the
// bus core's unique-claimant gate refuses a claim from the OTHER shell's instance of the same sid (PROGRESS #1025, dual-shell race).
// One file per seat (~/.agenthop/swarm/seat-shell/<sid>.json, O_EXCL temp + atomic rename) — no shared read-modify-write.
//
//   node <tsx> scripts/seat-shell.ts set <sid> tern|herdr [pid] (tern-restore.sh calls this after a seat comes up in Tern; pid =
//                                                               the seat's `tern acp` child pid, reserved for presence)
//   node <tsx> scripts/seat-shell.ts get <sid>                (prints: tern | herdr | absent | unreadable)
//   node <tsx> scripts/seat-shell.ts clear <sid>              (back to unregistered: both shells probed, Tern first)
// AH_HOME overrides the home dir.
import { homedir } from "node:os";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { writeSeatShell, readSeatShell, seatShellDir, type Shell } from "../packages/bus/src/swarm/tern-wake.js";

const [mode, sid, shell, pidArg] = process.argv.slice(2);
const home = process.env.AH_HOME || homedir();
const fail = (m: string): never => { process.stderr.write(`seat-shell: ${m}\n`); process.exit(2); };

if (!sid) fail("usage: seat-shell <set|get|clear> <sid> [tern|herdr]");
if (mode === "set") {
  if (shell !== "tern" && shell !== "herdr") fail("set needs a shell: tern | herdr");
  const pid = pidArg === undefined ? undefined : Number(pidArg);
  try { writeSeatShell(home, sid!, shell as Shell, Date.now() / 1000, pid); } catch (e) { fail((e as Error).message); }
  process.stdout.write(`${sid} ${shell}${pid !== undefined ? ` pid=${pid}` : ""}\n`);
} else if (mode === "get") {
  const r = readSeatShell(home, sid!);
  process.stdout.write(`${r.kind === "registered" ? r.shell : r.kind}\n`);
} else if (mode === "clear") {
  try { unlinkSync(path.join(seatShellDir(home), `${sid}.json`)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") fail((e as Error).message); }
  process.stdout.write(`${sid} cleared\n`);
} else {
  fail("usage: seat-shell <set|get|clear> <sid> [tern|herdr]");
}
