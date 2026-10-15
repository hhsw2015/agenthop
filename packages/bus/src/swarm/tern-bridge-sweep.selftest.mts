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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ternBridgeEnabled, runTernBridgeTick, initialBridgeState, realTern, realSentinelReader, realClearSentinel, realCancelIdSetter,
  armSequence, ACTION, RELOAD_MIN_MS,
  type BridgeIO, type Mirror, type PendingReq, type TernResult, type ArmStatus,
} from "./tern-bridge-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

type World = {
  clock: number; mirror: Mirror; reqs: PendingReq[]; ternUp: boolean;
  calls: string[]; logs: string[]; control: string[];
  onReload?: () => void; mirrorAdvances: boolean;
  // fake r9 bridge: the live patrol task ids, kv bridge.arm_cancel_id, and the status file it writes
  patrols: number[]; nextId: number; kvCancel: number | null; sentinel: ArmStatus;
  failStep?: string;            // a tern ctl action that returns not-ok
  cancelFails?: boolean;        // arm-cancel writes cancel-failed (keeps the obligation)
  scheduleCode?: number;        // arm-schedule.sh exit code override
  scheduleNoop?: boolean;       // arm-schedule.sh says 0 but schedules nothing (verify must catch it)
  kvFail?: boolean; scheduleCalls: number;
};
function world(): World {
  return { clock: 0, mirror: { tick: 1, vm: "vmA" }, reqs: [], ternUp: true, calls: [], logs: [], control: [], mirrorAdvances: true,
    patrols: [], nextId: 100, kvCancel: null, sentinel: null, scheduleCalls: 0 };
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
      if (act === "arm-scan" || act === "arm") w.sentinel = { step: "scanned", count: w.patrols.length, ids: [...w.patrols], id: null, error: null };
      if (act === "arm-cancel") {
        const id = w.kvCancel;
        if (id === null) w.sentinel = { step: "cancel-idle", count: null, ids: null, id: null, error: null };
        else if (w.cancelFails) w.sentinel = { step: "cancel-failed", count: null, ids: null, id, error: "x" };
        else { w.patrols = w.patrols.filter((x) => x !== id); w.kvCancel = null; w.sentinel = { step: "cancelled", count: null, ids: null, id, error: null }; }
      }
      return { ok: true, detail: "" };
    },
    readMirror: () => w.mirror,
    readSentinel: () => w.sentinel,
    clearSentinel: () => { w.sentinel = null; },
    setCancelId: (id) => { if (w.kvFail) return false; w.kvCancel = id; return true; },
    schedule: () => {
      w.scheduleCalls++; w.calls.push("arm-schedule.sh");
      if (w.scheduleCode !== undefined) return { code: w.scheduleCode, detail: "fake" };
      if (w.patrols.length > 0) return { code: 2, detail: "refused" };
      if (!w.scheduleNoop) w.patrols.push(w.nextId++);
      return { code: 0, detail: "scheduled" };
    },
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
  t("first tick arms vm (r9: scan + schedule.sh + verify)", tick(st, b) === "rearmed" && w.calls.includes("arm-schedule.sh"));
  w.clock += 1000; t("1s later throttled", tick(st, b) === "throttled");
  for (let i = 0; i < 6; i++) { w.clock += 5000; tick(st, b); }
  t("normal: 7 mirrors over ~31s", mirrorCalls(w) === 7);
  t("normal: armed exactly once", w.scheduleCalls === 1);
  t("normal: no reload", reloads(w) === 0);
}

// --- vm change (reload happened elsewhere) ⇒ one arm ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); w.calls = [];
  w.mirror = { tick: 50, vm: "vmB" }; w.clock += 5000;
  t("vm change ⇒ rearmed (patrol already there: scan only)", tick(st, b) === "rearmed" && w.calls.some((c) => c.endsWith(".arm-scan")));
  t("vm change with 1 patrol ⇒ no second schedule", w.scheduleCalls === 1);
  w.clock += 5000; w.calls = []; t("same vm ⇒ no arm at all", tick(st, b) === "ok" && !w.calls.some((c) => c.includes(".arm")));
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
  const iReload = seq.indexOf("plugin reload"), iArm = seq.indexOf("arm-scan"), iDrain = seq.indexOf("drain");
  t("stall: order reload → mirror(ready) → arm-scan → drain", iReload >= 0 && seq[iReload + 1] === "mirror" && iReload < iArm && iArm < iDrain);
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

// --- r9 arm sequence ---
const steps = (w: World) => w.calls.map((c) => c.replace(`ctl plugins run ${ACTION}.`, "")).filter((c) => c.startsWith("arm"));
{ const w = world(); const r = armSequence(io(w));
  t("arm: 0 patrols => scan, schedule.sh, verify scan", r.ok && steps(w).join(",") === "arm-scan,arm-schedule.sh,arm-scan" && w.patrols.length === 1); }
{ const w = world(); w.patrols = [7]; const r = armSequence(io(w));
  t("arm: 1 patrol => scan only (idempotent)", r.ok && steps(w).join(",") === "arm-scan" && w.scheduleCalls === 0); }
{ const w = world(); w.patrols = [7, 8, 9]; const r = armSequence(io(w));
  t("arm: 3 patrols => cancel 2 extras via kv, re-scan each, no schedule", r.ok && w.patrols.length === 1 && w.scheduleCalls === 0
    && steps(w).join(",") === "arm-scan,arm-cancel,arm-scan,arm-cancel,arm-scan"); }
{ const w = world(); w.patrols = [7, 8]; w.cancelFails = true; const r = armSequence(io(w));
  t("arm: cancel-failed => stop, obligation kept in kv, no schedule", !r.ok && w.kvCancel === 8 && w.scheduleCalls === 0 && /arm-cancel/.test(r.detail)); }
{ const w = world(); w.patrols = [7, 8]; w.kvFail = true; const r = armSequence(io(w));
  t("arm: kv write fails => stop before arm-cancel", !r.ok && !steps(w).includes("arm-cancel")); }
{ const w = world(); w.scheduleCode = 1; const r = armSequence(io(w));
  t("arm: schedule.sh exit 1 => stop", !r.ok && /arm-schedule.sh: exit 1/.test(r.detail)); }
{ const w = world(); w.scheduleNoop = true; const r = armSequence(io(w));
  t("arm: schedule.sh says 0 but nothing scheduled => our verify scan catches it", !r.ok && /verify/.test(r.detail)); }
{ const w = world(); w.failStep = "arm-scan"; const r = armSequence(io(w));
  t("arm: scan not answered => stop, nothing else", !r.ok && steps(w).join(",") === "arm-scan"); }
{ const w = world(); const b = io(w); const realRun = b.tern; b.tern = (a) => { const r = realRun(a); if (a.join(" ").endsWith(".arm-scan")) w.sentinel = null; return r; };
  t("arm: ctl ok but no fresh sentinel.json => stop (ctl ok is not proof)", !armSequence(b).ok); }
{ const w = world(); w.sentinel = { step: "scanned", count: 0, ids: [], id: null, error: null };
  const b = io(w); const realRun = b.tern; b.tern = (a) => (a.join(" ").endsWith(".arm-scan") ? { ok: true, detail: "" } : realRun(a));
  t("arm: a stale 'scanned' file is cleared first, never read as this scan", !armSequence(b).ok && w.scheduleCalls === 0); }
{ // arm-cancel answers "cancelled" for a DIFFERENT id (stale kv / race) => not confirmed => stop
  const w = world(); w.patrols = [7, 8]; const b = io(w); const realRun = b.tern;
  b.tern = (x) => { const r = realRun(x); if (x.join(" ").endsWith(".arm-cancel")) w.sentinel = { step: "cancelled", count: null, ids: null, id: 999, error: null }; return r; };
  const r = armSequence(b);
  t("arm: cancel confirmed for another id => stop, no schedule", !r.ok && /not confirmed/.test(r.detail) && w.scheduleCalls === 0);
}
{ // three reruns => exactly one patrol
  const w = world(); for (let k = 0; k < 3; k++) armSequence(io(w));
  t("arm: three reruns => one patrol, one schedule", w.patrols.length === 1 && w.scheduleCalls === 1); }
{ // a failed arm in the reload chain: no drain, logged, retried next tick
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.mirrorAdvances = false; w.onReload = () => { w.mirror = { tick: 1, vm: "vmF" }; w.mirrorAdvances = true; };
  w.patrols = []; w.scheduleCode = 1; w.clock += 11000; w.calls = []; w.control = [];
  t("reload chain: arm stop => reload-failed", tick(st, b) === "reload-failed");
  t("reload chain: arm stop => no drain", !has(w, ".drain"));
  t("reload chain: arm stop logged to audit", w.control.length === 1 && /arm STOPPED/.test(w.control[0]!));
  w.scheduleCode = undefined; w.clock += 5000; w.calls = [];
  t("next tick retries the full arm sequence", tick(st, b) === "rearmed" && w.patrols.length === 1);
}
{ // real sentinel reader
  const home = mkdtempSync(path.join(os.tmpdir(), "ternbridge-home-")); const d = path.join(home, ".agenthop", "tern-panes");
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "sentinel.json"), JSON.stringify({ step: "scanned", ids: [4, 5], count: 2, scheduled: false, ts: 1 }));
  const r = realSentinelReader(home)(); t("sentinel reader: r9 scanned fields", r?.count === 2 && r.ids?.join(",") === "4,5" && r.step === "scanned");
  writeFileSync(path.join(d, "sentinel.json"), JSON.stringify({ step: "scanned", count: "2" }));
  t("sentinel reader: non-integer count => null field", realSentinelReader(home)()?.count === null);
  realClearSentinel(home)(); t("clearSentinel removes the file", realSentinelReader(home)() === null);
  const kvf = path.join(home, "kv.json"); writeFileSync(kvf, JSON.stringify({ other: 1 }));
  t("kv setter: writes id, keeps other keys", realCancelIdSetter({ AGENTHOP_BRIDGE_KV: kvf })(9) && (() => { const k = JSON.parse(readFileSync(kvf, "utf8")); return k["bridge.arm_cancel_id"] === 9 && k.other === 1; })());
  writeFileSync(kvf, "{torn"); t("kv setter: refuses to overwrite an unparseable kv.json", realCancelIdSetter({ AGENTHOP_BRIDGE_KV: kvf })(9) === false && readFileSync(kvf, "utf8") === "{torn");
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
