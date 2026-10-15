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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ternBridgeEnabled, runTernBridgeTick, initialBridgeState, realTern, realSentinelReader, armSequence, ACTION, RELOAD_MIN_MS,
  type BridgeIO, type Mirror, type PendingReq, type TernResult, type ArmStatus,
} from "./tern-bridge-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

type World = {
  clock: number; mirror: Mirror; reqs: PendingReq[]; ternUp: boolean;
  calls: string[]; logs: string[]; control: string[];
  onReload?: () => void; mirrorAdvances: boolean;
  // fake r8 sentinel: kv list of prior patrol ids + the status file it writes
  priorPatrols: number; kv: number[]; sentinel: ArmStatus;
  failStep?: string;            // a tern ctl action that returns not-ok
  cancelStuck?: boolean;        // arm-cancel runs but makes no progress
  scheduleRefuse?: boolean;     // arm-schedule writes scheduled=false
};
function world(): World {
  return { clock: 0, mirror: { tick: 1, vm: "vmA" }, reqs: [], ternUp: true, calls: [], logs: [], control: [], mirrorAdvances: true,
    priorPatrols: 0, kv: [], sentinel: null };
}
function io(w: World): BridgeIO {
  return {
    tern: (args): TernResult => {
      w.calls.push(args.join(" "));
      if (!w.ternUp) return { ok: false, detail: "socket refused" };
      const a = args.join(" ");
      if (a === "plugin reload") { w.onReload?.(); return { ok: true, detail: "" }; }
      const act = a.startsWith(`ctl plugins run ${ACTION}.`) ? a.slice(`ctl plugins run ${ACTION}.`.length) : null;
      if (act !== null && act === w.failStep) return { ok: false, detail: "exit 1" };
      if (act === "mirror" && w.mirrorAdvances && w.mirror) w.mirror = { ...w.mirror, tick: w.mirror.tick + 1 };
      if (act === "arm") { w.kv = Array.from({ length: w.priorPatrols }, (_, i) => i + 1); w.sentinel = { step: "scanned", pendingCancel: w.kv.length, scheduled: false, error: null }; }
      if (act === "arm-cancel") { if (!w.cancelStuck) w.kv.shift(); w.sentinel = { step: "cancelling", pendingCancel: w.kv.length, scheduled: false, error: null }; }
      if (act === "arm-schedule") {
        if (w.kv.length > 0) w.sentinel = { step: "blocked", pendingCancel: w.kv.length, scheduled: false, error: "cancel prior patrols first" };
        else { w.sentinel = { step: "schedule", pendingCancel: null, scheduled: !w.scheduleRefuse, error: w.scheduleRefuse ? "x" : null }; if (!w.scheduleRefuse) w.priorPatrols = 1; }
      }
      return { ok: true, detail: "" };
    },
    readMirror: () => w.mirror,
    readSentinel: () => w.sentinel,
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
  t("first tick arms vm (full r8 sequence)", tick(st, b) === "rearmed" && has(w, ".arm-schedule"));
  w.clock += 1000; t("1s later throttled", tick(st, b) === "throttled");
  for (let i = 0; i < 6; i++) { w.clock += 5000; tick(st, b); }
  t("normal: 7 mirrors over ~31s", mirrorCalls(w) === 7);
  t("normal: armed exactly once", w.calls.filter((c) => c.endsWith(".arm-schedule")).length === 1);
  t("normal: no reload", reloads(w) === 0);
}

// --- vm change (reload happened elsewhere) ⇒ one arm ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); w.calls = [];
  w.mirror = { tick: 50, vm: "vmB" }; w.clock += 5000;
  t("vm change ⇒ rearmed", tick(st, b) === "rearmed" && w.calls.filter((c) => c.endsWith(".arm-schedule")).length === 1);
  t("vm change ⇒ cancels the prior patrol first", w.calls.filter((c) => c.endsWith(".arm-cancel")).length === 1);
  w.clock += 5000; t("same vm ⇒ no second arm", tick(st, b) === "ok" && w.calls.filter((c) => c.endsWith(".arm-schedule")).length === 1);
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
  const iReload = seq.indexOf("plugin reload"), iArm = seq.indexOf("arm"), iSch = seq.indexOf("arm-schedule"), iDrain = seq.indexOf("drain");
  t("stall: order reload → mirror(ready) → arm … arm-schedule → drain", iReload >= 0 && seq[iReload + 1] === "mirror" && iReload < iArm && iArm < iSch && iSch < iDrain);
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

// --- r8 arm sequence ---
const acts = (w: World) => w.calls.filter((c) => c.startsWith(`ctl plugins run ${ACTION}.arm`)).map((c) => c.slice(`ctl plugins run ${ACTION}.`.length));
{
  const w = world(); w.priorPatrols = 3; const r = armSequence(io(w));
  t("arm seq: 3 prior => arm, 3x arm-cancel, arm-schedule", r.ok && acts(w).join(",") === "arm,arm-cancel,arm-cancel,arm-cancel,arm-schedule");
  t("arm seq: scheduled asserted", w.sentinel?.scheduled === true);
}
{ const w = world(); const r = armSequence(io(w)); t("arm seq: 0 prior => no arm-cancel", r.ok && acts(w).join(",") === "arm,arm-schedule"); }
{ const w = world(); w.priorPatrols = 2; w.failStep = "arm-cancel"; const r = armSequence(io(w));
  t("arm seq: cancel fails => stop, no schedule", !r.ok && !acts(w).includes("arm-schedule") && /arm-cancel/.test(r.detail)); }
{ const w = world(); w.priorPatrols = 2; w.cancelStuck = true; const r = armSequence(io(w));
  t("arm seq: cancel no progress => stop after 1, no schedule", !r.ok && acts(w).filter((a) => a === "arm-cancel").length === 1 && !acts(w).includes("arm-schedule")); }
{ const w = world(); w.scheduleRefuse = true; const r = armSequence(io(w)); t("arm seq: schedule refused => not ok", !r.ok && /scheduled=false/.test(r.detail)); }
{ const w = world(); w.failStep = "arm"; const r = armSequence(io(w)); t("arm seq: scan fails => only arm attempted", !r.ok && acts(w).join(",") === "arm"); }
{ const w = world(); const b = io(w); b.readSentinel = () => null; const r = armSequence(b);
  t("arm seq: sentinel unreadable => stop before cancel/schedule", !r.ok && acts(w).join(",") === "arm"); }
{ // a failed arm in the reload chain: no drain, logged, retried next tick
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.mirrorAdvances = false; w.onReload = () => { w.mirror = { tick: 1, vm: "vmF" }; w.mirrorAdvances = true; };
  w.failStep = "arm-schedule"; w.clock += 11000; w.calls = []; w.control = [];
  t("reload chain: arm stop => reload-failed", tick(st, b) === "reload-failed");
  t("reload chain: arm stop => no drain", !has(w, ".drain"));
  t("reload chain: arm stop logged to audit", w.control.length === 1 && /arm STOPPED/.test(w.control[0]!));
  w.failStep = undefined; w.clock += 5000; w.calls = [];
  t("next tick retries the full arm sequence", tick(st, b) === "rearmed" && acts(w)[0] === "arm" && acts(w).includes("arm-schedule"));
}
{ // real sentinel reader
  const home = mkdtempSync(path.join(os.tmpdir(), "ternbridge-home-")); const d = path.join(home, ".agenthop", "tern-panes");
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "sentinel.json"), JSON.stringify({ step: "scanned", pending_cancel: 2, scheduled: false }));
  const r = realSentinelReader(home)(); t("sentinel reader: pending_cancel parsed", r?.pendingCancel === 2 && r.step === "scanned");
  writeFileSync(path.join(d, "sentinel.json"), JSON.stringify({ step: "scanned", pending_cancel: "2" }));
  t("sentinel reader: non-integer pending_cancel => null field", realSentinelReader(home)()?.pendingCancel === null);
  writeFileSync(path.join(d, "sentinel.json"), "{torn");
  t("sentinel reader: torn => null", realSentinelReader(home)() === null);
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
