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
  ternBridgeEnabled, runTernBridgeTick, initialBridgeState, realTern, realSentinelReader, realClearSentinel, realPendingRequests, bridgeHome, bridgeScriptEnv, bridgeDir, movedSince,
  armSequence, ACTION, RELOAD_MIN_MS, TERN_TIMEOUT_MS,
  type BridgeIO, type Mirror, type PendingReq, type TernResult, type ArmStatus,
} from "./tern-bridge-sweep.js";
import { realTernSpawn } from "./tern-env.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

type World = {
  clock: number; mirror: Mirror; reqs: PendingReq[] | null; ternUp: boolean;
  calls: string[]; logs: string[]; control: string[];
  onReload?: () => void; mirrorAdvances: boolean;
  // fake r11 bridge: live patrol task ids + the status file (arm-cancel-next reads the ids the last scan recorded)
  patrols: number[]; nextId: number; sentinel: ArmStatus;
  failStep?: string;            // a tern ctl action that returns not-ok
  cancelFails?: boolean;        // arm-cancel-next writes cancel-failed (keeps the obligation)
  scheduleCode?: number;        // arm-schedule.sh exit code override
  scheduleNoop?: boolean;       // arm-schedule.sh says 0 but schedules nothing (verify must catch it)
  scheduleCalls: number; clearFails?: boolean;
};
function world(): World {
  return { clock: 0, mirror: { tick: 1, vm: "vmA" }, reqs: [], ternUp: true, calls: [], logs: [], control: [], mirrorAdvances: true,
    patrols: [], nextId: 100, sentinel: null, scheduleCalls: 0 };
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
      if (act === "arm-cancel-next") {
        const ids = w.sentinel?.ids ?? null;
        if (ids === null) w.sentinel = { step: "cancel-unknown", count: null, ids: null, id: null, error: "run arm-scan first" };
        else if (ids.length <= 1) w.sentinel = { step: "cancel-idle", count: ids.length, ids, id: null, error: null };
        else {
          const sorted = [...ids].sort((a, b) => a - b); const victim = sorted[0]!;
          if (w.cancelFails) w.sentinel = { step: "cancel-failed", count: ids.length, ids, id: victim, error: "x" };
          else { w.patrols = w.patrols.filter((x) => x !== victim); const rest = sorted.slice(1); w.sentinel = { step: "cancelled-one", count: rest.length, ids: rest, id: victim, error: null }; }
        }
      }
      return { ok: true, detail: "" };
    },
    readMirror: () => w.mirror,
    readSentinel: () => w.sentinel,
    clearSentinel: () => { if (w.clearFails) return false; w.sentinel = null; return true; },
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
  w.reqs = [{ name: "r1.json", ageMs: 2500, isStart: true }];
  w.clock += 5000; w.calls = [];
  t("stuck request ⇒ reloaded", tick(st, b) === "reloaded");
  t("stuck start ⇒ drain-start sent", has(w, ".drain-start"));
  w.reqs = [{ name: "r2.json", ageMs: 1500, isStart: false }];
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

// --- r11 arm sequence ---
const steps = (w: World) => w.calls.map((c) => c.replace(`ctl plugins run ${ACTION}.`, "")).filter((c) => c.startsWith("arm"));
const onAct = (b: BridgeIO, act: string, f: () => void) => { const rr = b.tern; b.tern = (x) => { const r = rr(x); if (x.join(" ").endsWith("." + act)) f(); return r; }; };
{ const w = world(); const r = armSequence(io(w));
  t("arm: 0 patrols => scan, schedule.sh, verify scan", r.ok && steps(w).join(",") === "arm-scan,arm-schedule.sh,arm-scan" && w.patrols.length === 1); }
{ const w = world(); w.patrols = [7]; const r = armSequence(io(w));
  t("arm: 1 patrol => scan only (idempotent)", r.ok && steps(w).join(",") === "arm-scan" && w.scheduleCalls === 0); }
{ const w = world(); w.patrols = [7, 8, 9]; const r = armSequence(io(w));
  t("arm: 3 patrols => 2x arm-cancel-next, confirm scan, keeps newest, no schedule", r.ok && w.patrols.join() === "9" && w.scheduleCalls === 0
    && steps(w).join(",") === "arm-scan,arm-cancel-next,arm-cancel-next,arm-scan"); }
{ const w = world(); w.patrols = [7, 8]; w.cancelFails = true; const r = armSequence(io(w));
  t("arm: cancel-failed => stop (retry next round), no schedule", !r.ok && /cancel-failed/.test(r.detail) && w.scheduleCalls === 0 && w.patrols.length === 2); }
{ const w = world(); w.patrols = [7, 8]; const b = io(w);
  onAct(b, "arm-cancel-next", () => { w.sentinel = { step: "cancel-unknown", count: null, ids: null, id: null, error: "x" }; });
  const r = armSequence(b); t("arm: cancel-unknown => stop as UNKNOWN", !r.ok && /UNKNOWN/.test(r.detail) && w.scheduleCalls === 0); }
{ const w = world(); w.patrols = [7, 8]; const b = io(w);
  onAct(b, "arm-cancel-next", () => { w.sentinel = { step: "cancel-idle", count: 2, ids: [7, 8], id: null, error: null }; });
  const r = armSequence(b); t("arm: cancel-idle while count>1 => stop as UNKNOWN", !r.ok && /UNKNOWN/.test(r.detail)); }
{ const w = world(); w.patrols = [7, 8]; const b = io(w);
  onAct(b, "arm-cancel-next", () => { w.sentinel = { step: "cancelled-one", count: 2, ids: [7, 8], id: 7, error: null }; });
  const r = armSequence(b); t("arm: stale 'cancelled-one' without a count drop => stop, no progress", !r.ok && /no progress/.test(r.detail)); }
{ const w = world(); w.scheduleCode = 1; const r = armSequence(io(w));
  t("arm: schedule.sh exit 1 => stop", !r.ok && /arm-schedule.sh: exit 1/.test(r.detail)); }
{ const w = world(); w.scheduleNoop = true; const r = armSequence(io(w));
  t("arm: schedule.sh says 0 but nothing scheduled => our verify scan catches it", !r.ok && /verify/.test(r.detail)); }
{ const w = world(); w.failStep = "arm-scan"; const r = armSequence(io(w));
  t("arm: scan not answered => stop, nothing else", !r.ok && steps(w).join(",") === "arm-scan"); }
{ const w = world(); const b = io(w); onAct(b, "arm-scan", () => { w.sentinel = null; });
  t("arm: ctl ok but no fresh sentinel.json => stop (ctl ok is not proof)", !armSequence(b).ok); }
{ const w = world(); w.sentinel = { step: "scanned", count: 0, ids: [], id: null, error: null };
  const b = io(w); const realRun = b.tern; b.tern = (a) => (a.join(" ").endsWith(".arm-scan") ? { ok: true, detail: "" } : realRun(a));
  t("arm: a stale 'scanned' file is cleared first, never read as this scan", !armSequence(b).ok && w.scheduleCalls === 0); }
{ const w = world(); w.patrols = [7, 8]; const b = io(w); let n = 0;
  onAct(b, "arm-scan", () => { if (++n === 2) { w.patrols.push(50); w.sentinel = { step: "scanned", count: 2, ids: [8, 50], id: null, error: null }; } });
  const r = armSequence(b); t("arm: confirm scan after cancels sees count != 1 => stop", !r.ok && /after cancel/.test(r.detail)); }
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
  t("reload chain: arm stop logged to audit", w.control.length === 1 && /owed at arm — arm stopped/.test(w.control[0]!));
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
  writeFileSync(path.join(d, "sentinel.json"), "{torn");
  t("sentinel reader: torn => null", realSentinelReader(home)() === null);
}

// --- r5: TBS-ARM-RETRY — same stuck request, first arm fails after a good reload, next tick finishes WITHOUT another reload ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); // armed vmA
  w.onReload = () => { w.mirror = { tick: 1, vm: "vmR" }; };
  w.reqs = [{ name: "stuck.json", ageMs: 3000, isStart: false }];
  w.patrols = []; w.scheduleCode = 1; w.clock += 5000; w.calls = [];
  t("arm-retry: first tick reloads, arm stops, no drain", tick(st, b) === "reload-failed" && reloads(w) === 1 && !has(w, ".drain"));
  w.scheduleCode = undefined; w.clock += 5000; w.calls = [];
  const out = tick(st, b);
  t("arm-retry: next tick (request still there, inside 60s) finishes arm + drain", out === "rearmed" && has(w, ".drain") && w.patrols.length === 1);
  t("arm-retry: no second reload", reloads(w) === 0);
  w.reqs = []; w.clock += 5000; w.calls = [];
  t("arm-retry: obligation discharged afterwards", tick(st, b) === "ok" && !has(w, ".drain"));
}

// --- r7: TBS-ARM-RETRY — drain / drain-start not confirmed, or ready timing out, keep the obligation; next tick finishes w/o reload ---
for (const failing of ["drain", "drain-start"] as const) {
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.onReload = () => { w.mirror = { tick: 1, vm: "vmQ" }; };
  w.reqs = [{ name: "s.json", ageMs: 3000, isStart: true }];
  w.failStep = failing; w.clock += 5000; w.calls = [];
  t(`arm-retry r7: ${failing} ok=false => not 'reloaded', obligation kept`, tick(st, b) === "reload-failed" && st.owedAfterReload !== null);
  t(`arm-retry r7: ${failing} failure is in the audit, never 'sent'`, w.control.some((l) => /owed at drain/.test(l)) && !w.control.some((l) => /complete/.test(l)));
  w.failStep = undefined; w.clock += 5000; w.calls = [];
  const out = tick(st, b);
  t(`arm-retry r7: next tick (request still there) completes with NO reload`, out === "rearmed" && reloads(w) === 0 && has(w, `.${failing}`));
  t(`arm-retry r7: obligation cleared only after the chain`, st.owedAfterReload === null);
}
{ // ready window times out: obligation kept; next tick (bridge answers) finishes without reload
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.mirrorAdvances = false; w.onReload = () => { /* bridge does not come back within the ready window */ };
  w.clock += 6000; w.calls = [];
  t("arm-retry r7: ready timeout => owed, reload-failed", tick(st, b) === "reload-failed" && st.owedAfterReload?.stage === "ready");
  w.mirrorAdvances = true; w.mirror = { tick: 50, vm: "vmLate" }; w.clock += 5000; w.calls = [];
  const out = tick(st, b);
  t("arm-retry r7: next tick after ready timeout finishes arm+drain, no reload", out === "rearmed" && reloads(w) === 0 && has(w, ".drain") && st.armedVm === "vmLate");
}

// --- r8: TBS-READY-RETRY — the cross-tick ready stage uses the same rule as the in-reload wait (moved vs the pre-reload baseline) ---
{ // the reviewer's control: the mirror stays {vm:A, tick:0} — a later tick must NOT arm/drain/complete
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);                                   // armed vmA
  w.mirrorAdvances = false; w.onReload = () => { /* bridge never comes back: the mirror stays exactly as before the reload */ };
  w.clock += 5000; tick(st, b);                  // tick frozen: stall clock starts (lastTickChangeMs = this tick)
  w.clock += 5100; w.calls = [];                 // > 5s frozen and past the 5s mirror throttle => reload; ready never comes
  t("ready-retry: first wait times out => owed at ready", tick(st, b) === "reload-failed" && st.owedAfterReload?.stage === "ready");
  w.clock += 5000; w.calls = []; w.control = [];
  const out = tick(st, b);
  t("ready-retry: next tick, mirror unchanged => stays at ready", out === "reload-failed" && st.owedAfterReload?.stage === "ready");
  t("ready-retry: ... no arm-scan, no drain", !has(w, ".arm-scan") && !has(w, ".drain"));
  t("ready-retry: ... no 'complete' in the audit", !w.control.some((l) => /complete/.test(l)));
  t("ready-retry: ... and no new reload", reloads(w) === 0);
  w.mirror = { tick: 99, vm: "vmB" }; w.clock += 5000; w.calls = [];
  t("ready-retry: once the mirror really moves => arm + drain, rearmed", tick(st, b) === "rearmed" && has(w, ".drain") && st.armedVm === "vmB" && st.owedAfterReload === null);
}
{ // same vm, tick moved (bridge kept its vm id but ticks again) counts as ready
  t("movedSince: tick moved, same vm => ready", movedSince({ vm: "A", tick: 3 }, { vm: "A", tick: 4 }));
  t("movedSince: unchanged => not ready", !movedSince({ vm: "A", tick: 3 }, { vm: "A", tick: 3 }));
  t("movedSince: unreadable now => not ready", !movedSince({ vm: "A", tick: 3 }, null));
  t("movedSince (L5-SV-UNKNOWN-BASELINE): unreadable baseline => NOT ready, whatever is read now", !movedSince(null, { vm: "A", tick: 0 }));
}

// --- r5: TBS-REQUEST-CLASS — start classification comes from the decoded top-level op ---
{
  const home = mkdtempSync(path.join(os.tmpdir(), "ternbridge-req-")); const rq = path.join(home, ".agenthop", "tern-panes", "requests");
  mkdirSync(rq, { recursive: true });
  const files: Record<string, string> = {
    "a.json": '{"op":"st\\u0061rt","prompt":"x"}',
    "b.json": '{"\\u006fp":"start"}',
    "c.json": '{"op":"list","meta":{"op":"start"}}',
    "d.json": '{"op":"list"}',
    "e.json": '{torn',
  };
  for (const [n, body] of Object.entries(files)) writeFileSync(path.join(rq, n), body);
  const got = Object.fromEntries((realPendingRequests(home, () => Date.now())() ?? []).map((r) => [r.name, r.isStart]));
  t("request class: escaped \\u0061 'start' is a start", got["a.json"] === true);
  t("request class: escaped key \\u006fp is a start", got["b.json"] === true);
  t("request class: nested op:start is NOT a start", got["c.json"] === false);
  t("request class: list is not a start", got["d.json"] === false);
  t("request class: undecodable is not a start", got["e.json"] === false);
  t("request class: file names unchanged (no #start suffix)", Object.keys(got).sort().join() === "a.json,b.json,c.json,d.json,e.json");
}

// --- r5: TBS-SCAN-FRESH — the previous status cannot be removed ⇒ a stale count=1 must not answer for this scan ---
{ const w = world(); w.patrols = [7]; w.sentinel = { step: "scanned", count: 1, ids: [7], id: null, error: null }; w.clearFails = true;
  const b = io(w); const rr = b.tern; b.tern = (x) => (x.join(" ").endsWith(".arm-scan") ? { ok: true, detail: "" } : rr(x)); // ack only
  const r = armSequence(b);
  t("scan-fresh: unremovable old sentinel => stop, not 'already'", !r.ok && /cannot prove a fresh scan/.test(r.detail)); }
{ const home = mkdtempSync(path.join(os.tmpdir(), "scanfresh-")); const d = path.join(home, ".agenthop", "tern-panes");
  mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, "sentinel.json"), "{}");
  chmodSync(d, 0o555); const ok = realClearSentinel(home)(); chmodSync(d, 0o755);
  t("scan-fresh: real clear in a 0555 dir => false (EACCES is not 'absent')", ok === false);
  t("scan-fresh: real clear when absent => true", realClearSentinel(mkdtempSync(path.join(os.tmpdir(), "abs-")))() === true); }

// --- r5: TBS-CONTROL-ROOT — AH_HOME (swarm state) never redirects the bridge's control files ---
t("control root: AH_HOME set, no override => OS home", bridgeHome({ AH_HOME: "/tmp/swarm-state" }, "/Users/u") === "/Users/u");
t("control root: explicit AGENTHOP_BRIDGE_HOME wins", bridgeHome({ AH_HOME: "/tmp/swarm-state", AGENTHOP_BRIDGE_HOME: "/tmp/b" }, "/Users/u") === "/tmp/b");
{ // and the readers actually observe the bridge root, not AH_HOME
  const osHome = mkdtempSync(path.join(os.tmpdir(), "osh-")); const ahHome = mkdtempSync(path.join(os.tmpdir(), "ah-"));
  mkdirSync(path.join(osHome, ".agenthop", "tern-panes"), { recursive: true });
  writeFileSync(path.join(osHome, ".agenthop", "tern-panes", "sentinel.json"), JSON.stringify({ step: "scanned", count: 1, ids: [3] }));
  const r = realSentinelReader(bridgeHome({ AH_HOME: ahHome }, osHome))();
  t("control root: sentinel read from the bridge root while AH_HOME differs", r?.count === 1);
}

// --- r7: TBS-SCHEDULER-ROOT — helper scripts get the same resolved control dir as the readers ---
{
  const h = bridgeHome({ AGENTHOP_BRIDGE_HOME: "/tmp/override-root" }, "/Users/u");
  const e = bridgeScriptEnv({ PATH: "/bin" }, h);
  t("scheduler root: explicit override reaches the helper env", e.AGENTHOP_TERN_PANES === bridgeDir("/tmp/override-root"));
  t("scheduler root: other env kept", e.PATH === "/bin");
  t("scheduler root: default = OS home control dir", bridgeScriptEnv({}, bridgeHome({ AH_HOME: "/tmp/ah" }, "/Users/u")).AGENTHOP_TERN_PANES === "/Users/u/.agenthop/tern-panes");
}

// --- UNKNOWN: tern does not answer ⇒ zero further actions, exactly one log line, never a reload ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.ternUp = false; w.mirrorAdvances = false; w.reqs = [{ name: "r.json", ageMs: 99_000, isStart: false }];
  w.calls = []; w.logs = [];
  for (let i = 0; i < 4; i++) { w.clock += 6000; tick(st, b); }
  t("unknown: only the mirror probe was attempted", w.calls.every((c) => c.endsWith(".mirror")));
  t("unknown: never reload", reloads(w) === 0);
  t("unknown: one line per probe; the 4th tick (6s later) is inside the backoff and probes nothing", w.logs.length === 3 && w.logs.every((l) => /UNKNOWN/.test(l)) && mirrorCalls(w) === 3);
}

// --- L5: UNKNOWN backoff — after 3 in a row, at most one probe (and one line) per 60s; recovery says so and returns to 5s ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.ternUp = false; w.calls = []; w.logs = [];
  for (let i = 0; i < 60; i++) { w.clock += 5000; tick(st, b); } // 5 minutes of 5s ticks with tern timing out
  const probes = mirrorCalls(w);
  t("L5 backoff: 5 min of tern timeouts ⇒ 3 fast probes + one per 60s (≤ 8 probes, not 60)", probes >= 6 && probes <= 8);
  t("L5 backoff: logs ≤ 1 line per minute after the first three", w.logs.length === probes && w.logs.length <= 8);
  t("L5 backoff: the 3rd line announces the backoff", /3 in a row, probing once per 60s/.test(w.logs[2] ?? ""));
  w.ternUp = true; w.calls = []; w.logs = [];
  w.clock += 60_000; tick(st, b);
  t("L5 backoff: first answer ends the backoff with one line", w.logs.some((l) => /answering again after \d+ UNKNOWN/.test(l)));
  w.calls = []; w.clock += 5000; tick(st, b);
  t("L5 backoff: back to the 5s cadence", mirrorCalls(w) === 1);
}

// --- L5: a reload that does not take (vm + tick frozen) ⇒ after 3 owed rounds and the 60s debounce, ONE more reload ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); // arms vmA
  w.mirrorAdvances = false; // the mirror command no longer moves the tick (hook disabled)
  let reloadTakes = false;
  w.onReload = () => { if (reloadTakes) { w.mirror = { tick: 1, vm: "vmB" }; w.mirrorAdvances = true; } };
  w.calls = []; w.control = [];
  w.clock += 6000; tick(st, b); // stall detected (>5s) ⇒ reload #1, which does NOT take
  t("L5 owed: stall ⇒ reload #1", reloads(w) === 1 && st.owedAfterReload?.stage === "ready");
  const ctl0 = w.control.length;
  for (let i = 0; i < 5; i++) { w.clock += 5000; tick(st, b); } // 25s: owed rounds, debounce not passed
  t("L5 owed: inside the 60s debounce, no second reload", reloads(w) === 1);
  t("L5 owed: the unchanged owed state is audited ONCE, not once per tick", w.control.length - ctl0 === 1);
  reloadTakes = true;
  for (let i = 0; i < 8; i++) { w.clock += 5000; tick(st, b); } // past 60s since reload #1
  t("L5 owed: after ≥3 owed rounds and the debounce ⇒ exactly one more reload", reloads(w) === 2);
  t("L5 owed: that reload took ⇒ obligation discharged, armed on the new vm", st.owedAfterReload === null && st.armedVm === "vmB");
  t("L5 owed: the extra reload is audited with its reason", w.control.some((l) => /did not take after \d+ rounds/.test(l)));
  w.calls = []; for (let i = 0; i < 4; i++) { w.clock += 5000; tick(st, b); }
  t("L5 owed: healthy afterwards — the tick advances and no further reload", reloads(w) === 0);
}

// --- L5 (Second Voice f77230c): the retry reload FAILS ⇒ the original obligation (baseline + startStuck) survives; when the bridge
//     comes back on its own, the owed arm + drain + drain-start still run on that tick ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); // armed on vmA
  w.mirrorAdvances = false;
  w.reqs = [{ name: "s.json", ageMs: 99_000, isStart: true }]; // a stuck start ⇒ the owed chain must end with drain-start
  w.clock += 6000; tick(st, b); // reload #1 (does not take)
  t("L5 keep: setup — reload #1 owed at ready with startStuck", reloads(w) === 1 && st.owedAfterReload?.stage === "ready" && st.owedAfterReload.startStuck === true);
  const original = st.owedAfterReload;
  // the retry reload will fail: tern answers the mirror but `plugin reload` times out
  const realTern = b.tern;
  b.tern = (args) => (args.join(" ") === "plugin reload" ? (w.calls.push("plugin reload"), { ok: false, detail: "ETIMEDOUT" }) : realTern(args));
  for (let i = 0; i < 13; i++) { w.clock += 5000; tick(st, b); } // > 60s: the retry fires and fails
  t("L5 keep: the retry reload was attempted and failed", reloads(w) === 2);
  t("L5 keep: the ORIGINAL obligation survives the failed retry (same object, startStuck kept)", st.owedAfterReload === original && st.owedAfterReload?.startStuck === true);
  // the bridge recovers on its own (new vm), tern reload works again
  b.tern = realTern;
  w.mirror = { tick: 1, vm: "vmC" }; w.mirrorAdvances = true;
  w.calls = [];
  w.clock += 5000; tick(st, b);
  t("L5 keep: on the recovery tick the owed arm + drain + drain-start run (not 'reload-debounced')", has(w, ".drain-start") && has(w, ".drain") && st.owedAfterReload === null && st.armedVm === "vmC");
}

// --- L5 gate (coordinator): the timer chain dies AND the mirror command's hook is disabled ⇒ tick recovers within 2 sweep rounds
//     of the stall being detectable, through one reload (no prior reload, so the debounce does not apply) ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); // healthy, armed on vmA
  w.mirrorAdvances = false; // timer killed + mirror hook disabled: nothing moves the tick
  w.onReload = () => { w.mirror = { tick: 1, vm: "vmB" }; w.mirrorAdvances = true; };
  w.calls = [];
  let rounds = 0; let recovered = false;
  const startTick = w.mirror!.tick;
  for (let i = 0; i < 4 && !recovered; i++) {
    w.clock += 5000; tick(st, b); rounds++;
    recovered = w.mirror!.vm === "vmB" && w.mirror!.tick > 1;
  }
  t("L5 gate: killed timer ⇒ the tick is moving again within 2 rounds after the stall threshold", recovered && rounds <= 2 && startTick > 0);
  t("L5 gate: that took exactly one reload", reloads(w) === 1);
}

// --- [liveness] L5-SV-UNKNOWN-BASELINE (P1): the stall is observed on an unchanged mirror; the NEXT read in that tick fails
//     (old code took its baseline from exactly that read). After the reload the same unchanged mirror must NOT count as ready ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.mirrorAdvances = false;
  w.reqs = [{ name: "s.json", ageMs: 99_000, isStart: true }];
  w.clock += 6000;
  let readsThisTick = 0;
  const read0 = b.readMirror;
  b.readMirror = () => (++readsThisTick === 2 ? null : read0()); // the 1st read (stall decision) works, the 2nd fails
  const before = w.calls.length;
  tick(st, b);
  t("UNKNOWN-BASELINE: an unchanged mirror after the reload is NOT ready (obligation kept at ready)", st.owedAfterReload?.stage === "ready");
  t("UNKNOWN-BASELINE: no arm / drain / drain-start ran on an unproven reload", !w.calls.slice(before).some((c) => /\.(arm-scan|drain|drain-start)$/.test(c)));
}

// --- [liveness] L5-SV-READY-CLOCK: a clock that jumps back during the ready wait cannot stretch it; it ends by poll count ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.mirrorAdvances = false;
  w.clock += 6000;
  let slept = 0;
  b.sleep = (ms) => { slept++; w.clock -= 3_600_000; void ms; }; // every wait sets the clock back an hour
  const before = mirrorCalls(w);
  tick(st, b);
  const probes = mirrorCalls(w) - before;
  t("READY-CLOCK: clock rolled back an hour per wait ⇒ the ready wait still ends (≤ READY_POLLS probes, not thousands)", probes <= 18 && slept <= 17);
  t("READY-CLOCK: the unfinished recovery is kept as an obligation", st.owedAfterReload?.stage === "ready");
}

// --- [liveness] clock rollback between ticks: the sweep must not go quiet for the length of the jump ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.clock -= 3_600_000; // the wall clock jumps back one hour
  w.calls = [];
  tick(st, b);
  t("ROLLBACK: the next tick still drives the mirror (not 'throttled' for an hour)", mirrorCalls(w) === 1);
  w.mirrorAdvances = false;
  for (let i = 0; i < 3; i++) { w.clock += 5000; tick(st, b); }
  t("ROLLBACK: a stall after the jump is still detected and recovered within a few rounds (not an hour)", reloads(w) === 1);
}

// --- #1115 T1: each sweep tick that reached the bridge triggers one `screen` round; a failing `screen` is not a stall signal ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  w.calls = [];
  for (let i = 0; i < 3; i++) { w.clock += 5000; tick(st, b); }
  t("T1: one screen run per healthy tick", w.calls.filter((c) => c.endsWith(".screen")).length === 3);
  w.failStep = "screen"; w.calls = [];
  for (let i = 0; i < 3; i++) { w.clock += 5000; tick(st, b); }
  t("T1: screen failing ⇒ no reload, the mirror keeps being driven", reloads(w) === 0 && mirrorCalls(w) === 3);
  w.failStep = undefined; w.ternUp = false; w.calls = [];
  w.clock += 5000; tick(st, b);
  t("T1: tern UNKNOWN ⇒ no screen run either (zero further actions)", !w.calls.some((c) => c.endsWith(".screen")));
}

// --- L5: the unhealthy-but-debounced line is rate-limited too ---
{
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  st.lastReloadMs = w.clock; // a reload just happened elsewhere
  w.mirrorAdvances = false; w.logs = [];
  for (let i = 0; i < 10; i++) { w.clock += 5000; tick(st, b); }
  t("L5: 'reload debounced' logged at most once per 60s window", w.logs.filter((l) => /reload debounced/.test(l)).length === 1);
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
  const t0 = Date.now(); const hung = realTern({ TERN_BIN: mk("d", "sleep 10") })(["x"]); const took = Date.now() - t0;
  t("runner: hang ⇒ timeout ⇒ UNKNOWN", hung.ok === false);
  t("runner: L3 the hang is cut at 1.5s (not 3s)", took >= 1400 && took < 2500);
  // L3 env: what the spawned tern actually receives (a fake tern that prints its own env)
  const envDump = mk("e", 'env | sort');
  const parent = { TERN_BIN: envDump, TERN_PANE: "1056561954886", TERN_PANE_SOCKET: "/s/daemon.sock", TERN_WINDOW_SOCKET: "/w",
    TERN_PROMPT_FILE: "/p", CLAUDE_CODE_SESSION_ID: "c", CLAUDECODE: "1", HERDR_PANE_ID: "h", HERDR_ENV: "1", HERDR_BIN_PATH: "/hb",
    PATH: process.env.PATH ?? "", HOME: "/home/u", SWARM_COORDINATOR: "x" };
  const seen = realTernSpawn(parent)(["x"]).stdout;
  const has = (k: string) => new RegExp(`^${k}=`, "m").test(seen);
  t("L3 env: TERN_PANE_SOCKET kept (tern ctl needs it to find the daemon)", /^TERN_PANE_SOCKET=\/s\/daemon\.sock$/m.test(seen));
  t("L3 env: TERN_PANE / TERN_WINDOW_* / TERN_PROMPT_* dropped", !has("TERN_PANE") && !has("TERN_WINDOW_SOCKET") && !has("TERN_PROMPT_FILE"));
  t("L3 env: CLAUDE_* and CLAUDECODE dropped", !has("CLAUDE_CODE_SESSION_ID") && !has("CLAUDECODE"));
  t("L3 env: HERDR_PANE_ID dropped, HERDR_ENV / HERDR_BIN_PATH kept", !has("HERDR_PANE_ID") && has("HERDR_ENV") && has("HERDR_BIN_PATH"));
  t("L3 env: HOME / PATH / SWARM_* kept", has("HOME") && has("PATH") && has("SWARM_COORDINATOR"));
  t("L3 env: no inherited socket ⇒ the default daemon socket is set", /^TERN_PANE_SOCKET=.*\/Library\/Application Support\/Tern\/daemon\.sock$/m.test(realTernSpawn({ TERN_BIN: envDump, PATH: process.env.PATH ?? "" })(["x"]).stdout));
  t("L3 env: bridge scripts get the same cleaned env", (() => { const e = bridgeScriptEnv(parent, "/home/u"); return e.TERN_PANE === undefined && e.TERN_PANE_SOCKET === "/s/daemon.sock" && e.CLAUDECODE === undefined && e.AGENTHOP_TERN_PANES === "/home/u/.agenthop/tern-panes"; })());
}

// --- L5-LV-SOURCE-UNKNOWN: requests/ unreadable ⇒ UNKNOWN hold, never "nothing stuck" ---
{
  const eio = () => { const e = new Error("EIO") as NodeJS.ErrnoException; e.code = "EIO"; throw e; };
  const enoent = () => { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; };
  const okFs = { readdir: () => ["r1.json"], read: () => '{"op":"list"}', mtimeMs: () => 0 };
  t("pending: dir EIO ⇒ null (unknown)", realPendingRequests("/h", () => 1, { ...okFs, readdir: eio })() === null);
  t("pending: request body EIO ⇒ null (unknown)", realPendingRequests("/h", () => 1, { ...okFs, read: eio })() === null);
  t("pending: stat EIO ⇒ null (unknown)", realPendingRequests("/h", () => 1, { ...okFs, mtimeMs: eio })() === null);
  t("pending: no dir (ENOENT) ⇒ [] (none)", JSON.stringify(realPendingRequests("/h", () => 1, { ...okFs, readdir: enoent })()) === "[]");
  t("pending: request gone (ENOENT, claimed meanwhile) ⇒ skipped", JSON.stringify(realPendingRequests("/h", () => 1, { ...okFs, read: enoent })()) === "[]");
  const r = realPendingRequests("/h", () => 1000, okFs)();
  t("pending: readable ⇒ the request with its age", r !== null && r.length === 1 && r[0]!.ageMs === 1000);

  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b); // armed
  w.reqs = [{ name: "old.json", ageMs: 10 * 60_000, isStart: false }];
  const real = w.reqs;
  w.reqs = null; w.clock += 5000; w.calls = [];
  t("tick: requests unreadable ⇒ 'unknown', zero reload / arm / drain", tick(st, b) === "unknown" && reloads(w) === 0 && !has(w, ".arm") && !has(w, ".drain"));
  w.clock += 5000; w.calls = [];
  t("tick: still unreadable ⇒ still unknown, still no action", tick(st, b) === "unknown" && reloads(w) === 0);
  w.reqs = real; w.clock += 5000; w.calls = [];
  const out = tick(st, b);
  t(`tick: readable again ⇒ the stuck request drives the full recovery chain (${out})`, reloads(w) === 1 && has(w, ".drain"));
}

// --- L5-LV-SOURCE-UNKNOWN × owed work: an unreadable requests/ holds owed ready / arm / drain too (no exception) ---
for (const stage of ["drain", "ready"] as const) {
  const w = world(); const st = initialBridgeState(); const b = io(w);
  tick(st, b);
  if (stage === "drain") { w.onReload = () => { w.mirror = { tick: 1, vm: "vmQ" }; }; w.reqs = [{ name: "s.json", ageMs: 3000, isStart: true }]; w.failStep = "drain"; }
  else { w.mirrorAdvances = false; w.onReload = () => { /* the bridge does not come back */ }; }
  w.clock += 6000; w.calls = [];
  tick(st, b);
  const owed = st.owedAfterReload;
  t(`owed ${stage}: set up (stage ${owed?.stage})`, owed !== null);
  w.failStep = undefined; const real = w.reqs; w.reqs = null;
  for (let k = 0; k < 2; k++) {
    w.clock += RELOAD_MIN_MS + 1000; w.calls = []; // past the debounce: a reload would be allowed
    const out = tick(st, b);
    t(`owed ${stage} + requests unreadable (${k + 1}) ⇒ unknown; zero reload / arm / drain; obligation kept as it was`,
      out === "unknown" && reloads(w) === 0 && !has(w, ".arm") && !has(w, ".drain") && st.owedAfterReload !== null && st.owedAfterReload?.stage === owed?.stage);
  }
  if (stage === "ready") { w.mirrorAdvances = true; w.mirror = { tick: 77, vm: "vmBack" }; }
  w.reqs = real; w.clock += 5000; w.calls = [];
  tick(st, b);
  t(`owed ${stage}: readable again ⇒ the owed chain finishes (drain ran, obligation cleared)`, has(w, ".drain") && st.owedAfterReload === null);
}

// --- STEP-BOUND (small half): a child that ignores SIGTERM cannot hold the runner past its timeout ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "tbs-kill-"));
  const bin = path.join(dir, "tern"); writeFileSync(bin, "#!/bin/sh\ntrap '' TERM\nsleep 5\n"); chmodSync(bin, 0o755);
  const t0 = Date.now(); const r = realTern({ TERN_BIN: bin })(["x"]); const ms = Date.now() - t0;
  t(`runner: TERM-ignoring child ⇒ UNKNOWN within budget + 0.2s (${ms}ms)`, r.ok === false && ms < TERN_TIMEOUT_MS + 200);
}

console.log("PASS tern-bridge-sweep");
