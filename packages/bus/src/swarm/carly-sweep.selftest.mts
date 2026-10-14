/**
 * carly-sweep selftest (tsx-run). Covers the M2-a sweep wiring (r2):
 *  - flag SWARM_CARLY_PROJECTION DEFAULT OFF ⇒ noop.
 *  - projection writes to the WORKSPACE dir (CARLY_WORKSPACE_DIR) AND the ~/.agenthop/carly audit copy; idempotent; her
 *    out-of-region bytes preserved (reuses the reviewed writeManagedFile).
 *  - outbox drain EXACTLY ONCE (CS-OUTBOX-ONCE): a re-drain of the same-named file returns "already" ⇒ no duplicate, even after the
 *    receiver took the message; unresolvable ⇒ left (retry).
 *  - outbox SHAPE isolation (CS-OUTBOX-SHAPE): a null/array/scalar JSON file does NOT throw the loop — it is left, later valid files
 *    still deliver once.
 *  - beat READ contract: readBeatSec / beatStale; cross-program (shell `date +%s` ⇄ TS readBeatSec ⇄ lua tonumber). The sweep does
 *    NOT write coordinator.beat (CS-BEAT-SOURCE).
 *
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/carly-sweep.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  carlyProjectionEnabled,
  carlyAuditDir,
  outboxDir,
  runCarlySweep,
  drainOutbox,
  readBeatSec,
  beatStale,
  coordinatorBeatPath,
} from "./carly-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "carlysweep-"));
const read = (f: string) => readFileSync(f, "utf8");
const jsonCount = (dir: string) => { try { return readdirSync(dir).filter((f) => f.endsWith(".json")).length; } catch { return 0; } };
let LUA = true; try { execSync("lua -v 2>/dev/null"); } catch { LUA = false; }

const msg = (text: string) => ({ from: "carly", fromLabel: "carly", text, via: "carly", ts: Date.now(), intent: "report" });
function seedCoord(home: string): string {
  const coordSid = "coord-sweep-1";
  mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "presence", `${coordSid}.pid`), String(process.pid));
  return coordSid;
}
function putOutbox(home: string, name: string, body: unknown): void {
  mkdirSync(outboxDir(home), { recursive: true });
  writeFileSync(path.join(outboxDir(home), name), typeof body === "string" ? body : JSON.stringify(body));
}

// ---- flag default OFF ----
{
  t("flag: unset ⇒ disabled", carlyProjectionEnabled({} as any) === false);
  t("flag: =1 ⇒ enabled", carlyProjectionEnabled({ SWARM_CARLY_PROJECTION: "1" } as any) === true);
  const home = tmp();
  const r = runCarlySweep(home, { AH_HOME: home } as any);
  t("flag off ⇒ runCarlySweep noop (ran=false)", r.ran === false && r.reason === "disabled");
}

// ---- projection to workspace + audit, idempotent, out-of-region preserved; sweep does NOT write coordinator.beat ----
{
  const home = tmp();
  const ws = path.join(tmp(), "Tern", "carly");
  const env = { AH_HOME: home, SWARM_CARLY_PROJECTION: "1", CARLY_WORKSPACE_DIR: ws } as unknown as NodeJS.ProcessEnv;
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "HEARTBEAT.md"), "# Carly's own header\n\nkeep me\n");
  const r1 = runCarlySweep(home, env);
  t("sweep ran (flag on), projection written", r1.ran === true && r1.wroteProjection === true);
  const wsHb = read(path.join(ws, "HEARTBEAT.md"));
  t("workspace HEARTBEAT.md: her bytes preserved + managed block added", wsHb.startsWith("# Carly's own header") && wsHb.includes("<!-- swarm begin -->"));
  t("workspace MEMORY.md written", existsSync(path.join(ws, "MEMORY.md")));
  t("audit copy under ~/.agenthop/carly", existsSync(path.join(carlyAuditDir(home), "HEARTBEAT.md")));
  t("CS-BEAT-SOURCE: sweep does NOT write coordinator.beat", !existsSync(coordinatorBeatPath(home)));
  const before = read(path.join(ws, "HEARTBEAT.md"));
  runCarlySweep(home, env);
  t("projection idempotent (workspace HEARTBEAT byte-identical on rerun)", read(path.join(ws, "HEARTBEAT.md")) === before);
}

// ---- CS-OUTBOX-ONCE: exactly-once even on re-drain / after the receiver took it ----
{
  const home = tmp();
  const coordSid = seedCoord(home);
  const env = { AH_HOME: home, SWARM_COORDINATOR: coordSid } as unknown as NodeJS.ProcessEnv;
  const box = path.join(home, ".agenthop", "inbox", coordSid);
  putOutbox(home, "0001-aaaa.json", { to: "coordinator", msg: msg("once") });
  t("drain: first delivery (1) + source cleared", drainOutbox(home, env) === 1 && jsonCount(outboxDir(home)) === 0 && jsonCount(box) === 1);
  // simulate an unlink that FAILED: the same-named file reappears (or was never cleared) ⇒ re-drain must NOT duplicate
  putOutbox(home, "0001-aaaa.json", { to: "coordinator", msg: msg("once") });
  drainOutbox(home, env);
  t("CS-OUTBOX-ONCE: re-drain of same file ⇒ 'already' ⇒ no duplicate (box still 1) + source cleared", jsonCount(box) === 1 && jsonCount(outboxDir(home)) === 0);
  // receiver TAKES the message, then the same file reappears ⇒ still no re-delivery (pubcred persists)
  for (const f of readdirSync(box).filter((x) => x.endsWith(".json"))) rmSync(path.join(box, f)); // receiver takes the MESSAGE; .pubcred stays
  putOutbox(home, "0001-aaaa.json", { to: "coordinator", msg: msg("once") });
  drainOutbox(home, env);
  t("CS-OUTBOX-ONCE: after receiver took it, re-drain does NOT re-deliver (box 0) + source cleared", jsonCount(box) === 0 && jsonCount(outboxDir(home)) === 0);
}

// ---- CS-OUTBOX-SHAPE: null-first does not break the loop; later valid file still delivers once ----
{
  const home = tmp();
  const coordSid = seedCoord(home);
  const env = { AH_HOME: home, SWARM_COORDINATOR: coordSid } as unknown as NodeJS.ProcessEnv;
  const box = path.join(home, ".agenthop", "inbox", coordSid);
  putOutbox(home, "0001-null.json", "null");          // JSON null — decodes but has no fields
  putOutbox(home, "0002-arr.json", "[1,2,3]");        // array root
  putOutbox(home, "0003-ok.json", { to: "coordinator", msg: msg("valid") }); // valid, AFTER the bad ones
  const n = drainOutbox(home, env);
  t("CS-OUTBOX-SHAPE: no whole-loop throw; valid delivered once", n === 1 && jsonCount(box) === 1);
  t("CS-OUTBOX-SHAPE: bad-shape files LEFT, valid file cleared", existsSync(path.join(outboxDir(home), "0001-null.json")) && existsSync(path.join(outboxDir(home), "0002-arr.json")) && !existsSync(path.join(outboxDir(home), "0003-ok.json")));
}

// ---- beat READ contract + cross-program ----
{
  const home = tmp();
  const bf = coordinatorBeatPath(home);
  mkdirSync(path.dirname(bf), { recursive: true });
  t("beat: absent ⇒ null ⇒ stale", readBeatSec(bf) === null && beatStale(null, 1791990000) === true);
  t("beat: fresh ⇒ not stale; >20min ⇒ stale", beatStale(1791990000, 1791990100) === false && beatStale(1791990000, 1791990000 + 1201) === true);
  // the coordinator writes the beat (shell `date +%s`); TS + lua read the SAME bare-epoch int
  execSync(`date +%s > ${JSON.stringify(bf)}`);
  const tsRead = readBeatSec(bf);
  t("beat cross-program: TS reads a `date +%s` beat", typeof tsRead === "number" && tsRead! > 1700000000);
  if (LUA) {
    const luaRead = Number(execSync(`lua -e 'local f=io.open([[${bf}]]);io.write(tostring(tonumber(f:read("l"))));f:close()'`).toString().trim());
    t("beat cross-program: lua reads the SAME int", luaRead === tsRead);
  } else {
    console.log("skip - beat cross-program lua (no lua binary)");
  }
}

console.log("all carly-sweep selftests passed");
