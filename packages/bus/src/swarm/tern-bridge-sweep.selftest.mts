/**
 * tern-bridge-sweep selftest (#1033). A fake tern records the call sequence; fake files drive tick/vm/requests.
 * Covers: flag default OFF; a mirror every ~5s (throttle); vm change ⇒ one arm; tick stall ⇒ reload→mirror(ready)→arm→drain;
 * stuck request ⇒ same chain (+drain-start for a start); 60s debounce; tern UNKNOWN (no answer) ⇒ zero actions; agents.json unreadable ⇒
 * UNKNOWN zero actions; one control-log line per reload; real tern runner classifies exit/timeout/{"ok":false} as UNKNOWN.
 * Mutant gate (verified by editing PRODUCTION code, not a test wrapper): removing the 60s debounce guard turns "debounce: no second
 * reload within 60s" RED; removing the UNKNOWN early-return turns "unknown: only the mirror probe was attempted" RED.
 *
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/tern-bridge-sweep.selftest.mts  (from repo root)
 */
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ternBridgeEnabled, runTernBridgeTick, initialBridgeState, realTern, ACTION, RELOAD_MIN_MS,
  type BridgeIO, type Mirror, type PendingReq, type TernResult,
} from "./tern-bridge-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

type World = {
  clock: number; mirror: Mirror; reqs: PendingReq[]; ternUp: boolean;
  calls: string[]; logs: string[]; control: string[];
  onReload?: () => void; mirrorAdvances: boolean;
};
function world(): World {
  return { clock: 0, mirror: { tick: 1, vm: "vmA" }, reqs: [], ternUp: true, calls: [], logs: [], control: [], mirrorAdvances: true };
}
function io(w: World): BridgeIO {
  return {
    tern: (args): TernResult => {
      w.calls.push(args.join(" "));
      if (!w.ternUp) return { ok: false, detail: "socket refused" };
      const a = args.join(" ");
      if (a === "plugin reload") { w.onReload?.(); return { ok: true, detail: "" }; }
      if (a === `ctl plugins run ${ACTION}.mirror` && w.mirrorAdvances && w.mirror) w.mirror = { ...w.mirror, tick: w.mirror.tick + 1 };
      return { ok: true, detail: "" };
    },
    readMirror: () => w.mirror,
    pendingRequests: () => w.reqs,
    nowMs: () => w.clock,
    sleep: (ms) => { w.clock += ms; },
    log: (l) => w.logs.push(l),
    controlLog: (l) => w.control.push(l),
  };
}
const mirrorCalls = (w: World) => w.calls.filter((c) => c.endsWith(".mirror")).length;
const has = (w: World, s: string) => w.calls.some((c) => c.includes(s));
const reloads = (w: World) => w.calls.filter((c) => c === "plugin reload").length;

const tick = (st: ReturnType<typeof initialBridgeState>, b: BridgeIO) => runTernBridgeTick(st, b, true);

// --- flag ---
t("flag: default OFF", ternBridgeEnabled({}) === false);
t("flag: on with 1", ternBridgeEnabled({ SWARM_TERN_BRIDGE: "1" }) === true);
{ const w = world(); t("flag off ⇒ zero calls", runTernBridgeTick(initialBridgeState(), io(w), false) === "disabled" && w.calls.length === 0); }

// --- normal: one mirror per ~5s, first vm armed once ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  t("first tick arms vm", tick(st, b) === "rearmed" && has(w, ".arm"));
  w.clock += 1000; t("1s later throttled", tick(st, b) === "throttled");
  for (let i = 0; i < 6; i++) { w.clock += 5000; tick(st, b); }
  t("normal: 7 mirrors over ~31s", mirrorCalls(w) === 7);
  t("normal: armed exactly once", w.calls.filter((c) => c.endsWith(".arm")).length === 1);
  t("normal: no reload", reloads(w) === 0);
}

// --- vm change (reload happened elsewhere) ⇒ one arm ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); w.calls = [];
  w.mirror = { tick: 50, vm: "vmB" }; w.clock += 5000;
  t("vm change ⇒ rearmed", tick(st, b) === "rearmed" && w.calls.filter((c) => c.endsWith(".arm")).length === 1);
  w.clock += 5000; t("same vm ⇒ no second arm", tick(st, b) === "ok" && w.calls.filter((c) => c.endsWith(".arm")).length === 1);
}

// --- tick stall ⇒ reload chain in order, one control-log line ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.mirrorAdvances = false; // bridge stops ticking
  w.onReload = () => { w.mirror = { tick: 1, vm: "vmC" }; w.mirrorAdvances = true; };
  w.clock += 5000; tick(st, b);           // stall clock still within 5s window
  w.calls = [];
  w.clock += 5000;
  const out = tick(st, b);
  t("stall ⇒ reloaded", out === "reloaded");
  const seq = w.calls.map((c) => c.replace(`ctl plugins run ${ACTION}.`, ""));
  const iReload = seq.indexOf("plugin reload"), iArm = seq.lastIndexOf("arm"), iDrain = seq.indexOf("drain");
  t("stall: order reload → mirror(ready) → arm → drain", iReload >= 0 && seq[iReload + 1] === "mirror" && iReload < iArm && iArm < iDrain);
  t("stall: one control-log line", w.control.length === 1 && /reload/.test(w.control[0]!));
  t("stall: armed the new vm", st.armedVm === "vmC");
}

// --- stuck request ⇒ reload chain; start request ⇒ drain-start too ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.onReload = () => { w.mirror = { tick: 1, vm: "vmD" }; };
  w.reqs = [{ name: "r1.json#start", ageMs: 2500 }];
  w.clock += 5000; w.calls = [];
  t("stuck request ⇒ reloaded", tick(st, b) === "reloaded");
  t("stuck start ⇒ drain-start sent", has(w, ".drain-start"));
  w.reqs = [{ name: "r2.json", ageMs: 1500 }];
  w.clock += RELOAD_MIN_MS + 1; w.calls = [];
  t("young request (<2s) ⇒ no reload", tick(st, b) !== "reloaded" && reloads(w) === 0);
}

// --- debounce: at most one reload per 60s ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.mirrorAdvances = false; w.onReload = () => { w.mirror = { tick: (w.mirror?.tick ?? 0) + 1, vm: "vmE" + w.clock }; };
  w.clock += 6000; tick(st, b);
  t("debounce: first stall reloads", reloads(w) === 1);
  for (let i = 0; i < 5; i++) { w.clock += 6000; tick(st, b); }
  t("debounce: no second reload within 60s", reloads(w) === 1);
  t("debounce: debounced ticks logged", w.logs.some((l) => /debounced/.test(l)));
  w.clock += 60_000; tick(st, b);
  t("debounce: reload allowed again after 60s", reloads(w) === 2);
}

// --- UNKNOWN: tern does not answer ⇒ zero further actions, exactly one log line, never a reload ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.ternUp = false; w.mirrorAdvances = false; w.reqs = [{ name: "r.json", ageMs: 99_000 }];
  w.calls = []; w.logs = [];
  for (let i = 0; i < 4; i++) { w.clock += 6000; tick(st, b); }
  t("unknown: only the mirror probe was attempted", w.calls.every((c) => c.endsWith(".mirror")));
  t("unknown: never reload", reloads(w) === 0);
  t("unknown: one line per tick", w.logs.length === 4 && w.logs.every((l) => /UNKNOWN/.test(l)));
}

// --- UNKNOWN: agents.json unreadable ⇒ no action ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); w.mirror = null; w.calls = [];
  for (let i = 0; i < 3; i++) { w.clock += 6000; tick(st, b); }
  t("unreadable mirror: no reload / no arm", reloads(w) === 0 && !has(w, ".arm"));
}

// --- real runner classification (fake binary) ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "ternbridge-"));
  const mk = (name: string, body: string) => { const f = path.join(dir, name); writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`); chmodSync(f, 0o755); return f; };
  t("runner: ok json ⇒ ok", realTern({ TERN_BIN: mk("a", 'echo \'{"ok":true}\'') })(["x"]).ok === true);
  t("runner: exit 1 ⇒ UNKNOWN", realTern({ TERN_BIN: mk("b", "echo nope >&2; exit 1") })(["x"]).ok === false);
  t("runner: {\"ok\":false} ⇒ UNKNOWN", realTern({ TERN_BIN: mk("c", 'echo \'{"ok":false,"error":"x"}\'') })(["x"]).ok === false);
  t("runner: missing binary ⇒ UNKNOWN", realTern({ TERN_BIN: path.join(dir, "nope") })(["x"]).ok === false);
  t("runner: hang ⇒ timeout ⇒ UNKNOWN", realTern({ TERN_BIN: mk("d", "sleep 10") })(["x"]).ok === false);
}

console.log("PASS tern-bridge-sweep");
