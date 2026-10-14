/**
 * carly-sweep selftest (tsx-run). Covers the M2-a sweep wiring:
 *  - flag SWARM_CARLY_PROJECTION DEFAULT OFF ⇒ noop (no files written).
 *  - projection writes to the WORKSPACE dir (CARLY_WORKSPACE_DIR) AND the ~/.agenthop/carly audit copy; idempotent; her
 *    out-of-region bytes preserved (reuses the reviewed writeManagedFile).
 *  - outbox drain: a resolvable role ⇒ delivered to its inbox + file removed; unresolvable ⇒ left (retry); corrupt ⇒ left.
 *  - coordinator.beat written as bare epoch seconds; beat contract round-trips cross-program (date +%s ⇄ TS ⇄ lua).
 *
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/carly-sweep.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  carlyProjectionEnabled,
  carlyWorkspaceDir,
  carlyAuditDir,
  outboxDir,
  runCarlySweep,
  drainOutbox,
  writeBeat,
  readBeatSec,
  beatStale,
  coordinatorBeatPath,
} from "./carly-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "carlysweep-"));
const read = (f: string) => readFileSync(f, "utf8");
let LUA = true; try { execSync("lua -v 2>/dev/null || lua5.4 -v 2>/dev/null"); } catch { LUA = false; }
const luaBin = (() => { try { execSync("lua -v 2>/dev/null"); return "lua"; } catch { return "lua5.4"; } })();

// ---- flag default OFF ----
{
  t("flag: SWARM_CARLY_PROJECTION unset ⇒ disabled", carlyProjectionEnabled({} as any) === false);
  t("flag: =1 ⇒ enabled", carlyProjectionEnabled({ SWARM_CARLY_PROJECTION: "1" } as any) === true);
  const home = tmp();
  const r = runCarlySweep(home, { AH_HOME: home } as any); // flag off
  t("flag off ⇒ runCarlySweep noop (ran=false)", r.ran === false && r.reason === "disabled");
  t("flag off ⇒ no beat written", !existsSync(coordinatorBeatPath(home)));
}

// ---- projection to workspace + audit, idempotent, out-of-region preserved ----
{
  const home = tmp();
  const ws = path.join(tmp(), "Tern", "carly"); // stand-in workspace dir
  const env = { AH_HOME: home, SWARM_CARLY_PROJECTION: "1", CARLY_WORKSPACE_DIR: ws } as unknown as NodeJS.ProcessEnv;
  // pre-seed HER content in the workspace HEARTBEAT.md (outside any managed block)
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "HEARTBEAT.md"), "# Carly's own header\n\nkeep me\n");
  const r1 = runCarlySweep(home, env, 1791990000);
  t("sweep ran (flag on)", r1.ran === true && r1.wroteProjection === true && r1.beat === true);
  const wsHb = read(path.join(ws, "HEARTBEAT.md"));
  t("workspace HEARTBEAT.md written (her bytes preserved + managed block added)", wsHb.startsWith("# Carly's own header") && wsHb.includes("<!-- swarm begin -->"));
  t("workspace MEMORY.md written", existsSync(path.join(ws, "MEMORY.md")) && read(path.join(ws, "MEMORY.md")).includes("<!-- swarm begin -->"));
  t("audit copy written under ~/.agenthop/carly", existsSync(path.join(carlyAuditDir(home), "HEARTBEAT.md")));
  t("coordinator.beat written as bare epoch", read(coordinatorBeatPath(home)).trim() === "1791990000");
  // idempotent: rerun with same (empty) status ⇒ workspace files byte-identical
  const before = read(path.join(ws, "HEARTBEAT.md"));
  runCarlySweep(home, env, 1791990005);
  t("projection idempotent (workspace HEARTBEAT byte-identical on rerun)", read(path.join(ws, "HEARTBEAT.md")) === before);
}

// ---- outbox drain ----
{
  const home = tmp();
  const coordSid = "coord-sweep-1";
  mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "presence", `${coordSid}.pid`), String(process.pid));
  mkdirSync(outboxDir(home), { recursive: true });
  const msg = { from: "carly", fromLabel: "carly", text: "queued earlier", via: "carly", ts: Date.now(), intent: "report" };
  writeFileSync(path.join(outboxDir(home), "0001-aaaa.json"), JSON.stringify({ to: "coordinator", msg }));
  writeFileSync(path.join(outboxDir(home), "0002-bbbb.json"), JSON.stringify({ to: "coordinator", msg: { ...msg, text: "second" } }));
  // unresolvable (no SWARM_COORDINATOR) ⇒ both left
  t("drain: unresolvable role ⇒ files left (retry)", drainOutbox(home, { AH_HOME: home } as any) === 0 && readdirSync(outboxDir(home)).filter((f) => f.endsWith(".json")).length === 2);
  // resolvable ⇒ delivered + removed
  const n = drainOutbox(home, { AH_HOME: home, SWARM_COORDINATOR: coordSid } as any);
  const box = path.join(home, ".agenthop", "inbox", coordSid);
  t("drain: resolvable ⇒ 2 delivered, outbox emptied", n === 2 && readdirSync(outboxDir(home)).filter((f) => f.endsWith(".json")).length === 0);
  t("drain: messages landed in the coordinator box with the carly envelope", readdirSync(box).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(read(path.join(box, f))).from).every((x) => x === "carly"));
  // corrupt ⇒ left
  writeFileSync(path.join(outboxDir(home), "0003-cccc.json"), "{ not json");
  t("drain: corrupt file left for inspection", drainOutbox(home, { AH_HOME: home, SWARM_COORDINATOR: coordSid } as any) === 0 && existsSync(path.join(outboxDir(home), "0003-cccc.json")));
}

// ---- beat contract ----
{
  const home = tmp();
  writeBeat(coordinatorBeatPath(home), 1791990000);
  t("beat: TS write → TS read round-trips", readBeatSec(coordinatorBeatPath(home)) === 1791990000);
  t("beat: absent ⇒ null ⇒ stale", readBeatSec(path.join(home, "nope.beat")) === null && beatStale(null, 1791990000) === true);
  t("beat: fresh ⇒ not stale; >20min ⇒ stale", beatStale(1791990000, 1791990100) === false && beatStale(1791990000, 1791990000 + 1201) === true);
  // cross-program: shell `date +%s` sample read by TS AND lua (same file)
  const bf = path.join(home, "shell.beat");
  execSync(`date +%s > ${JSON.stringify(bf)}`);
  const tsRead = readBeatSec(bf);
  t("beat cross-program: TS reads a `date +%s` beat", typeof tsRead === "number" && tsRead! > 1700000000);
  if (LUA) {
    const luaRead = Number(execSync(`${luaBin} -e 'local f=io.open([[${bf}]]);io.write(tostring(tonumber(f:read("l"))));f:close()'`).toString().trim());
    t("beat cross-program: lua reads the SAME int the shell wrote", luaRead === tsRead);
    // TS writeBeat → lua reads it
    const bf2 = path.join(home, "ts.beat"); writeBeat(bf2, 1791991234);
    const luaRead2 = Number(execSync(`${luaBin} -e 'local f=io.open([[${bf2}]]);io.write(tostring(tonumber(f:read("l"))));f:close()'`).toString().trim());
    t("beat cross-program: lua reads a TS writeBeat int", luaRead2 === 1791991234);
  } else {
    console.log("skip - beat cross-program lua (no lua binary)");
  }
}

console.log("all carly-sweep selftests passed");
