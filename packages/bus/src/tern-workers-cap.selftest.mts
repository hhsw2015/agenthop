/**
 * MTB-SV-CAP, multi-PROCESS (the in-process async test cannot interleave the synchronous decide+record). Many processes each try
 * to take a worker slot at once through reserveSlot (the machine-wide locked transaction); at most the cap may succeed.
 * Run: node_modules/.bin/tsx packages/bus/src/tern-workers-cap.selftest.mts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSeat, reserveSlot, type Worker } from "./tern-workers.js";

const SEAT = "11111111-2222-4333-8444-555555555555";
if (process.env.CAP_CHILD) {
  const name = `p-w${process.env.CAP_CHILD}`;
  const ph: Worker = { name, herdr_session: name, pane: 0, kind: "tui", started_at: Date.now(), stopped_at: null, state: "starting" };
  const r = reserveSlot(process.env.CAP_HOME!, SEAT, ph, { listDir: (d) => readdirSync(d), env: { SWARM_WORKER_CAP: "3", SWARM_WORKER_CAP_GLOBAL: "6" } });
  process.stdout.write(r === null ? "ok" : r.reason);
  process.exit(0);
}
const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const self = fileURLToPath(import.meta.url);
for (let round = 0; round < 3; round++) {
  const home = mkdtempSync(path.join(os.tmpdir(), "twcap-"));
  const N = 12;
  const out = await Promise.all(Array.from({ length: N }, (_, i) => new Promise<string>((res) => {
    const c = spawn(process.execPath, [...process.execArgv, self], { env: { ...process.env, CAP_CHILD: String(i), CAP_HOME: home }, stdio: ["ignore", "pipe", "inherit"] });
    let s = ""; c.stdout.on("data", (d) => { s += d; }); c.on("close", () => res(s));
  })));
  const oks = out.filter((x) => x === "ok").length;
  const seat = readSeat(home, SEAT);
  const recorded = seat.kind === "ok" ? seat.workers.filter((w) => w.state === "starting").length : -1;
  t(`round ${round}: ${N} processes race for cap 3 ⇒ exactly 3 ok (got ${oks})`, oks === 3)
  t(`round ${round}: exactly 3 placeholders recorded (got ${recorded}); the rest refused cap`, recorded === 3 && out.filter((x) => x === "cap").length === N - 3)
}
console.log("all tern-workers-cap selftests passed");
