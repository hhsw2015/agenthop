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

// ---- CS-OUTBOX-ONCE: exactly-once to a BOUND target (incl. the role-switch face) ----
{
  const home = tmp();
  const coordSid = seedCoord(home); // "coord-sweep-1"
  const env = { AH_HOME: home, SWARM_COORDINATOR: coordSid } as unknown as NodeJS.ProcessEnv;
  const box = path.join(home, ".agenthop", "inbox", coordSid);
  putOutbox(home, "0001-aaaa.json", { to: "coordinator", msg: msg("once") });
  t("drain: first delivery (1) + source cleared", drainOutbox(home, env) === 1 && jsonCount(outboxDir(home)) === 0 && jsonCount(box) === 1);
  // same basename reappears (failed unlink) ⇒ re-drain re-binds same target ⇒ 'already' ⇒ no duplicate
  putOutbox(home, "0001-aaaa.json", { to: "coordinator", msg: msg("once") });
  drainOutbox(home, env);
  t("CS-OUTBOX-ONCE: re-drain ⇒ 'already' ⇒ no duplicate (box still 1)", jsonCount(box) === 1 && jsonCount(outboxDir(home)) === 0);
  // receiver TAKES the message, same file reappears ⇒ still no re-delivery (pubcred persists in the bound box)
  for (const f of readdirSync(box).filter((x) => x.endsWith(".json"))) rmSync(path.join(box, f)); // .pubcred stays
  putOutbox(home, "0001-aaaa.json", { to: "coordinator", msg: msg("once") });
  drainOutbox(home, env);
  t("CS-OUTBOX-ONCE: after receiver took it, no re-delivery (box 0) + source cleared", jsonCount(box) === 0 && jsonCount(outboxDir(home)) === 0);
}
// CS-OUTBOX-ONCE role-switch face: a BOUND target is honored even when the role now resolves to a DIFFERENT sid ⇒ no second copy.
{
  const home = tmp();
  const aSid = "coord-A", bSid = "coord-B";
  mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "presence", `${aSid}.pid`), String(process.pid));
  writeFileSync(path.join(home, ".agenthop", "presence", `${bSid}.pid`), String(process.pid));
  const boxA = path.join(home, ".agenthop", "inbox", aSid), boxB = path.join(home, ".agenthop", "inbox", bSid);
  // a record ALREADY BOUND to A, but the role now points to B
  putOutbox(home, "0009-switch.json", { to: "coordinator", msg: msg("bound"), target: aSid });
  const n = drainOutbox(home, { AH_HOME: home, SWARM_COORDINATOR: bSid } as unknown as NodeJS.ProcessEnv);
  t("CS-OUTBOX-ONCE role-switch: delivered to BOUND A, not the new role B", n === 1 && jsonCount(boxA) === 1 && jsonCount(boxB) === 0 && jsonCount(outboxDir(home)) === 0);
  // a bound record delivers even when the role is now UNRESOLVABLE (no SWARM_COORDINATOR) — binding, not live resolution
  putOutbox(home, "0010-bound.json", { to: "coordinator", msg: msg("bound2"), target: aSid });
  t("CS-OUTBOX-ONCE: bound target honored with no resolvable role", drainOutbox(home, { AH_HOME: home } as unknown as NodeJS.ProcessEnv) === 1 && jsonCount(boxA) === 2);
  // first-attempt binding is PERSISTED: an un-targeted file, drained once with the role resolvable, records target in the file if kept.
  // (Observed indirectly above: the role-switch file was pre-bound; here assert a fresh un-targeted file still delivers a FIRST time.)
  putOutbox(home, "0011-fresh.json", { to: "coordinator", msg: msg("fresh") });
  t("CS-OUTBOX-ONCE: never-attempted obligation still allows a first delivery", drainOutbox(home, { AH_HOME: home, SWARM_COORDINATOR: aSid } as unknown as NodeJS.ProcessEnv) === 1 && jsonCount(boxA) === 3);
}

// ---- CS-OUTBOX-ONCE bad-binding carrier: a PRESENT-but-invalid target is preserved + skipped, NOT re-resolved ----
{
  const home = tmp();
  const aSid = seedCoord(home);
  const env = { AH_HOME: home, SWARM_COORDINATOR: aSid } as unknown as NodeJS.ProcessEnv;
  const box = path.join(home, ".agenthop", "inbox", aSid);
  const bads: Array<[string, unknown]> = [["b0", null], ["b1", 5], ["b2", {}], ["b3", []], ["b4", ""], ["b5", "../evil"]];
  for (const [n, target] of bads) putOutbox(home, `bad-${n}.json`, { to: "coordinator", msg: msg("bad"), target });
  const bytesBefore = bads.map(([n]) => read(path.join(outboxDir(home), `bad-${n}.json`)));
  const nBad = drainOutbox(home, env);
  t("bad-carrier: NO new publish for any invalid target field", nBad === 0 && jsonCount(box) === 0);
  t("bad-carrier: all 6 source files preserved BYTE-UNCHANGED (never re-resolved / rewritten / deleted)",
    bads.every(([n], i) => existsSync(path.join(outboxDir(home), `bad-${n}.json`)) && read(path.join(outboxDir(home), `bad-${n}.json`)) === bytesBefore[i]));
  // positive controls preserved: a truly-ABSENT target first-delivers; a VALID bound target delivers even with no resolvable role
  putOutbox(home, "absent.json", { to: "coordinator", msg: msg("absent") });
  putOutbox(home, "valid.json", { to: "coordinator", msg: msg("valid"), target: aSid });
  t("bad-carrier positive controls: absent ⇒ first delivery; valid bound ⇒ delivered", drainOutbox(home, { AH_HOME: home } as any) >= 0 && drainOutbox(home, env) >= 0 && jsonCount(box) === 2);
}
// ---- CS-OUTBOX-ONCE-GATE: the COMPLETE chain exercises the real first-time atomicReplace bind (a no-op variant must go RED) ----
{
  const NOTROOT = (process.getuid?.() ?? 1) !== 0;
  if (NOTROOT) {
    const home = tmp();
    const aSid = "coord-chainA", bSid = "coord-chainB";
    mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
    writeFileSync(path.join(home, ".agenthop", "presence", `${aSid}.pid`), String(process.pid));
    writeFileSync(path.join(home, ".agenthop", "presence", `${bSid}.pid`), String(process.pid));
    const boxA = path.join(home, ".agenthop", "inbox", aSid), boxB = path.join(home, ".agenthop", "inbox", bSid);
    // make A's box UNWRITABLE so the first publish FAILS after the bind (the outbox dir stays writable ⇒ atomicReplace succeeds)
    mkdirSync(boxA, { recursive: true }); execSync(`chmod 000 ${JSON.stringify(boxA)}`);
    putOutbox(home, "chain.json", { to: "coordinator", msg: msg("chain") }); // NO target
    const n1 = drainOutbox(home, { AH_HOME: home, SWARM_COORDINATOR: aSid } as any);
    execSync(`chmod 755 ${JSON.stringify(boxA)}`); // restore
    const chainFile = path.join(outboxDir(home), "chain.json");
    const rec = (() => { try { return JSON.parse(read(chainFile)); } catch { return {}; } })();
    t("CS-ONCE-GATE: first-bind PERSISTED target to disk before a failed publish (no-op variant RED)", n1 === 0 && existsSync(chainFile) && rec.target === aSid);
    // role switches to B ⇒ the persisted, A-bound file must deliver to A, never B
    const n2 = drainOutbox(home, { AH_HOME: home, SWARM_COORDINATOR: bSid } as any);
    t("CS-ONCE-GATE: after role switch, re-drain delivers to BOUND A (not B) + source cleared", n2 === 1 && jsonCount(boxA) === 1 && jsonCount(boxB) === 0 && jsonCount(outboxDir(home)) === 0);
    // adjacent control: first-bind WRITE failure (outbox dir read-only) ⇒ no publish, file preserved UNBOUND
    const home2 = tmp(); const a2 = seedCoord(home2); const box2 = path.join(home2, ".agenthop", "inbox", a2);
    putOutbox(home2, "wf.json", { to: "coordinator", msg: msg("wf") });
    execSync(`chmod 500 ${JSON.stringify(outboxDir(home2))}`);
    const nwf = drainOutbox(home2, { AH_HOME: home2, SWARM_COORDINATOR: a2 } as any);
    execSync(`chmod 755 ${JSON.stringify(outboxDir(home2))}`);
    const wfRec = JSON.parse(read(path.join(outboxDir(home2), "wf.json")));
    t("CS-ONCE-GATE: first-bind write-fail ⇒ no publish + file preserved unbound", nwf === 0 && jsonCount(box2) === 0 && wfRec.target === undefined);
  } else {
    console.log("skip - CS-ONCE-GATE complete chain (root)");
  }
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
