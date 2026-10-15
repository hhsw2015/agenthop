/**
 * Tern bridge sweep (#1033) — the swarm-side duties of agenthop-agents-bridge r7 (PROTOCOL.md §1/§4, README), automated in the
 * dispatcher sweep tail instead of by hand. Flag SWARM_TERN_BRIDGE, DEFAULT OFF. Reads the bridge's files; never edits the bridge.
 *
 * Per sweep tick (the sweep loop already runs every ~5s):
 *   ① drive: `tern ctl plugins run plugin.agenthop-agents-bridge.mirror` every MIRROR_EVERY_MS. This is the ONLY live liveness
 *      guarantee: bridge r8 makes its timer chain stop itself when a callback is >400ms late (App Nap / background coalescing) and
 *      report agents.json `timer`="stopped-late"; the next `mirror` COMMAND restarts it. So if this sweep stops, the mirror stops.
 *   ② re-arm on reload: agents.json `vm` is a per-load random id. A vm we have not armed yet ⇒ the r8 arm SEQUENCE (below).
 *   ③ health: tick not advancing for > TICK_STALL_MS, or a request in requests/ older than REQ_STUCK_MS ⇒ recovery chain
 *      `tern plugin reload` → wait ready (agents.json tick/vm moves after a mirror) → arm sequence → `…drain` (+ `…drain-start` when the
 *      stuck request is a start). Debounced: at most one reload per RELOAD_MIN_MS. Every reload writes one control-log line.
 *   ④ every tern call has a timeout and uses TERN_BIN.
 *   ⑤ FC-2 three-state: if tern is unavailable (spawn error, timeout, non-zero exit, socket refused) the tick is UNKNOWN: it logs one
 *      line and does NOTHING else. UNKNOWN is never read as "bridge dead" — reload is only ever triggered by a POSITIVE stall signal
 *      read from the bridge's own files while tern itself answered.
 * Arm sequence = bridge r11 protocol (see armSequence): arm-scan (read-only, plugin) → arm-cancel-next per extra (plugin, zero
 *   parameters) → arm-schedule.sh (swarm CLI) → re-scan must say count==1. The sweep never writes the bridge's data dir. Any failed step STOPS there (no half
 *   sequence) and is written to the reload audit. Same definition as #1034 r2's recovery chain.
 * Orphans + control-plane GC: tern-orphan-sweep.ts, run from this step every 60s (record-driven; never touches unregistered sessions).
 * Pure core + injected IO (tern runner, file reads, clock, log), so the whole call sequence is offline-testable.
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export const ACTION = "plugin.agenthop-agents-bridge";
export const MIRROR_EVERY_MS = 5_000;
export const TICK_STALL_MS = 5_000;
export const REQ_STUCK_MS = 2_000;
export const RELOAD_MIN_MS = 60_000;
export const READY_WAIT_MS = 4_000;
export const TERN_TIMEOUT_MS = 3_000;
export const ARM_CANCEL_MAX = 64; // bound on arm-cancel iterations (a sentinel that never reaches 0 must not loop forever)

/** SWARM_TERN_BRIDGE — DEFAULT OFF (opt-in). */
export function ternBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_TERN_BRIDGE ?? "");
}

export function bridgeDir(home: string): string { return path.join(home, ".agenthop", "tern-panes"); }

/** TBS-CONTROL-ROOT: the home the BRIDGE writes under. window.luau always uses the OS home Tern runs in ($HOME/.agenthop/
 *  tern-panes) and never reads AH_HOME, so the dispatcher's AH_HOME (swarm state) must NOT be used for bridge files.
 *  AGENTHOP_BRIDGE_HOME is the one explicit override (tests / a non-default install). */
export function bridgeHome(env: NodeJS.ProcessEnv, osHome: string): string {
  return env.AGENTHOP_BRIDGE_HOME || osHome;
}

/** The env every bridge helper SCRIPT (arm-schedule.sh, gc.sh) must run with: the same resolved control dir the TS readers use,
 *  via AGENTHOP_TERN_PANES (both scripts read it, else fall back to OS home). One function so scan/read/schedule/gc cannot split. */
export function bridgeScriptEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return { ...env, AGENTHOP_TERN_PANES: bridgeDir(home) };
}

/** One tern call's outcome. ok=false ⇒ tern itself did not answer (UNKNOWN), not a bridge verdict. */
export type TernResult = { ok: boolean; detail: string };
export type TernRun = (args: string[]) => TernResult;

export type Mirror = { tick: number; vm: string } | null;
/** A request file waiting in requests/. `isStart` comes from the DECODED top-level `op` (same rule as the bridge's drain since r8),
 *  never from the file name or a text peek: `{"op":"st\u0061rt"}` is a start, `{"op":"list","meta":{"op":"start"}}` is not. An
 *  undecodable file is not a start (the fast drain owns and reports it). */
export type PendingReq = { name: string; ageMs: number; isStart: boolean };

/** sentinel.json as bridge r9 (@613e691) writes it. `count`/`ids` only on step "scanned"; null fields = absent/invalid. */
export type ArmStatus = { step: string | null; count: number | null; ids: number[] | null; id: number | null; error: string | null } | null;

export type BridgeIO = {
  tern: TernRun;
  readSentinel: () => ArmStatus;         // sentinel.json, or null (absent/torn/unparseable)
  clearSentinel: () => boolean;          // delete sentinel.json so only the NEXT write can answer; false = could not (not ENOENT)
  schedule: () => { code: number; detail: string }; // arm-schedule.sh: 0 scheduled+verified, 2 refused (count>0), else failed
  readMirror: () => Mirror;              // agents.json tick+vm, or null (absent/torn/unparseable)
  pendingRequests: () => PendingReq[];   // requests/*.json with their age
  nowMs: () => number;
  sleep: (ms: number) => void;           // synchronous wait (used only inside the bounded ready-wait)
  log: (line: string) => void;           // dispatcher log
  controlLog: (line: string) => void;    // one line per reload (audit)
};

/** State carried across ticks by the caller (one per dispatcher process). */
export type BridgeState = {
  lastMirrorMs: number;
  armedVm: string | null;
  lastTick: number | null;
  lastTickChangeMs: number;
  lastReloadMs: number;
  /** TBS-ARM-RETRY: a reload that succeeded but whose arm (and therefore drain) did not complete. The obligation is kept here and
   *  retried EVERY tick — independent of the 60s reload debounce, so finishing a reload never waits for (or causes) another one. */
  owedAfterReload: { vm: string | null; why: string; startStuck: boolean; stage: "ready" | "arm" | "drain"; reason: string } | null;
};
export function initialBridgeState(): BridgeState {
  return { lastMirrorMs: -Infinity, armedVm: null, lastTick: null, lastTickChangeMs: -Infinity, lastReloadMs: -Infinity, owedAfterReload: null };
}

export type TickOutcome = "disabled" | "throttled" | "unknown" | "ok" | "rearmed" | "arm-failed" | "reloaded" | "reload-debounced"
  | "reload-failed";

/** Bridge r11 arm protocol (@69821b6; coordinator #1033 r4). Zero kv, zero parameters. Listing + cancelling stay in the plugin
 *  (tern 0.8.3's `ctl carly task` has add but no list/cancel); scheduling is the swarm's arm-schedule.sh.
 *    arm-scan:        clear sentinel.json first → require a FRESH step "scanned" with integer count (ctl ok proves nothing)
 *    count>1 loop:    `arm-cancel-next` (the plugin cancels the smallest id from the last recorded ids, keeps the newest). NOT
 *                     cleared first: the plugin reads the ids from sentinel.json. Require step "cancelled-one" AND count strictly
 *                     below the previous count (a stale "cancelled-one" cannot satisfy that). cancel-failed ⇒ stop, the plugin
 *                     keeps the obligation, retried next round; cancel-unknown / cancel-idle / no answer ⇒ stop as UNKNOWN.
 *                     After the loop a fresh arm-scan must confirm count==1.
 *    count==0:        arm-schedule.sh (it re-scans itself and accepts only count==1) → our own fresh arm-scan must say count==1
 *    count==1:        already armed (idempotent)
 *  Any stop ⇒ ok=false with the step named; nothing after it runs. */
export function armSequence(io: BridgeIO): { ok: boolean; detail: string } {
  const stop = (where: string, why: string) => ({ ok: false, detail: `${where}: ${why}` });
  const scan = (): number | string => {
    // TBS-SCAN-FRESH: if the previous status cannot be removed (EACCES/EPERM/…), a stale "scanned" could answer for this scan
    // (ctl's ack is not proof the command ran) ⇒ stop. Only "removed" or "was absent" (ENOENT) lets the scan proceed.
    if (!io.clearSentinel()) return "could not remove the previous sentinel.json (cannot prove a fresh scan)";
    const r = run(io, "arm-scan");
    if (!r.ok) return `tern ${r.detail}`;
    const s = io.readSentinel();
    if (s === null || s.step !== "scanned" || s.count === null) return `no fresh scan (step=${s?.step ?? "none"}${s?.error ? ` error=${s.error}` : ""})`;
    return s.count;
  };
  let count = scan();
  if (typeof count === "string") return stop("arm-scan", count);
  let cancels = 0;
  while (count > 1) {
    if (cancels >= ARM_CANCEL_MAX) return stop("arm-cancel-next", `still ${count} patrols after ${cancels} cancels`);
    const c = run(io, "arm-cancel-next");
    if (!c.ok) return stop("arm-cancel-next", `tern ${c.detail}`);
    const s = io.readSentinel();
    if (s === null) return stop("arm-cancel-next", "UNKNOWN: sentinel.json unreadable");
    if (s.step === "cancel-failed") return stop("arm-cancel-next", `cancel-failed id ${s.id} (obligation kept, retry next round)`);
    if (s.step !== "cancelled-one") return stop("arm-cancel-next", `UNKNOWN: step=${s.step}${s.error ? ` error=${s.error}` : ""}`);
    if (s.count === null || s.count >= count) return stop("arm-cancel-next", `no progress (count ${count} -> ${s.count})`);
    count = s.count;
    cancels++;
  }
  if (cancels > 0) {
    const v = scan();
    if (typeof v === "string") return stop("arm-scan(after cancel)", v);
    if (v !== 1) return stop("arm-scan(after cancel)", `count ${v} (want 1)`);
    return { ok: true, detail: `cancelled ${cancels} extra, 1 patrol` };
  }
  if (count === 1) return { ok: true, detail: "already 1 patrol" };
  const sch = io.schedule();
  if (sch.code !== 0) return stop("arm-schedule.sh", `exit ${sch.code}: ${sch.detail}`);
  const v = scan();
  if (typeof v === "string") return stop("arm-scan(verify)", v);
  if (v !== 1) return stop("arm-scan(verify)", `count ${v} after schedule (want 1)`);
  return { ok: true, detail: "scheduled, verified 1 patrol" };
}

const run = (io: BridgeIO, action: string): TernResult => io.tern(["ctl", "plugins", "run", `${ACTION}.${action}`]);

/** One sweep-tail step. Mutates `st` (caller-owned). Returns what it did (for logs + tests). */
export function runTernBridgeTick(st: BridgeState, io: BridgeIO, enabled: boolean): TickOutcome {
  if (!enabled) return "disabled";
  const now = io.nowMs();
  if (now - st.lastMirrorMs < MIRROR_EVERY_MS) return "throttled";
  st.lastMirrorMs = now;

  // ① drive the mirror. tern not answering ⇒ UNKNOWN: one line, zero further action (⑤).
  const m = run(io, "mirror");
  if (!m.ok) { io.log(`tern-bridge: UNKNOWN (tern did not answer: ${m.detail}) — no action`); return "unknown"; }

  const mirror = io.readMirror();
  // agents.json absent / torn / without tick+vm ⇒ UNKNOWN too (FC-2): an unreadable file is not proof the bridge is stuck.
  if (mirror === null) { io.log("tern-bridge: UNKNOWN (agents.json unreadable or without tick/vm) — no action"); return "unknown"; }
  if (mirror.tick !== st.lastTick) { st.lastTick = mirror.tick; st.lastTickChangeMs = now; }
  if (st.lastTickChangeMs === -Infinity) st.lastTickChangeMs = now; // first observation starts the stall clock

  // owed work from an earlier successful reload (arm → drain) comes first, before any new reload decision
  if (st.owedAfterReload !== null) return finishAfterReload(st, io, mirror.vm);

  // ③ health first: a positive stall signal from the bridge's own files (tern answered, so this is not UNKNOWN).
  const stuck = io.pendingRequests().filter((r) => r.ageMs > REQ_STUCK_MS);
  const tickStalled = now - st.lastTickChangeMs > TICK_STALL_MS;
  if (tickStalled || stuck.length > 0) {
    const why = tickStalled ? `tick ${st.lastTick} not advancing ${now - st.lastTickChangeMs}ms` : `request stuck: ${stuck[0]!.name}`;
    if (now - st.lastReloadMs < RELOAD_MIN_MS) {
      io.log(`tern-bridge: unhealthy (${why}) — reload debounced (${now - st.lastReloadMs}ms since last)`);
      return "reload-debounced";
    }
    st.lastReloadMs = now;
    return recover(st, io, why, stuck);
  }

  // ② re-arm after a reload (new vm id) — once per vm.
  if (mirror.vm !== st.armedVm) {
    const a = armSequence(io);
    if (!a.ok) {
      io.controlLog(`tern-bridge arm (vm ${mirror.vm}) stopped: ${a.detail}`);
      io.log(`tern-bridge: arm stopped (${a.detail}) — will retry next tick`);
      return "arm-failed";
    }
    st.armedVm = mirror.vm;
    io.log(`tern-bridge: armed sentinel for vm ${mirror.vm} (${a.detail})`);
    return "rearmed";
  }
  return "ok";
}

/** reload → wait ready → arm → drain (+drain-start). One control-log line whatever happens. */
function recover(st: BridgeState, io: BridgeIO, why: string, stuck: PendingReq[]): TickOutcome {
  const before = io.readMirror();
  const r = io.tern(["plugin", "reload"]);
  if (!r.ok) {
    io.controlLog(`tern-bridge reload FAILED (${why}): ${r.detail}`);
    io.log(`tern-bridge: reload failed (${r.detail})`);
    return "reload-failed";
  }
  // ready = after a mirror run, the vm id changed or the tick moved. `tern plugin list` is NOT used: without a reachable daemon it
  // falls back to listing the plugins directory and still says "ready".
  const deadline = io.nowMs() + READY_WAIT_MS;
  let ready = false;
  while (!ready) {
    if (run(io, "mirror").ok) {
      const after = io.readMirror();
      ready = after !== null && (before === null || after.vm !== before.vm || after.tick !== before.tick);
      if (ready) { st.lastTick = after!.tick; st.lastTickChangeMs = io.nowMs(); }
    }
    if (ready || io.nowMs() >= deadline) break;
    io.sleep(250);
  }
  // From here a reload HAPPENED: whatever is left (ready, arm, drain) is an obligation kept across ticks until the WHOLE chain
  // succeeds, never re-entering the reload debounce (TBS-ARM-RETRY, coordinator ruling).
  st.owedAfterReload = { vm: null, why, startStuck: stuck.some((q) => q.isStart), stage: "ready", reason: "" };
  if (!ready) {
    st.owedAfterReload.reason = `not ready within ${READY_WAIT_MS}ms`;
    io.controlLog(`tern-bridge reload (${why}): reloaded but not ready within ${READY_WAIT_MS}ms — owed, retry next tick (no reload)`);
    return "reload-failed";
  }
  const out = finishAfterReload(st, io, io.readMirror()?.vm ?? null);
  return out === "rearmed" ? "reloaded" : out;
}

/** The post-reload obligation: arm sequence, then drain (+drain-start). A stopped arm keeps the obligation (no drain after a half
 *  arm) and is retried on the next tick WITHOUT another reload. Discharged only when arm completed and the drain trigger was sent. */
function finishAfterReload(st: BridgeState, io: BridgeIO, vm: string | null): TickOutcome {
  const owed = st.owedAfterReload!;
  const keep = (stage: "ready" | "arm" | "drain", reason: string): TickOutcome => {
    owed.stage = stage; owed.reason = reason; owed.vm = vm;
    io.controlLog(`tern-bridge reload (${owed.why}): owed at ${stage} — ${reason} (retry next tick, no reload)`);
    return "reload-failed";
  };
  if (owed.stage === "ready") {
    // a ready-wait that timed out last time: this tick's mirror already ran and moved (we are here), so the bridge answers now
    if (vm === null) return keep("ready", "mirror still unreadable");
    owed.stage = "arm";
  }
  if (owed.stage === "arm") {
    const armed = armSequence(io);
    if (!armed.ok) return keep("arm", `arm stopped: ${armed.detail} — drain not run`);
    st.armedVm = vm;
    owed.stage = "drain";
  }
  const drained = run(io, "drain");
  if (!drained.ok) return keep("drain", `drain not confirmed sent: ${drained.detail}`);
  if (owed.startStuck) {
    const ds = run(io, "drain-start");
    if (!ds.ok) return keep("drain", `drain-start not confirmed sent: ${ds.detail}`);
  }
  st.owedAfterReload = null; // ONLY here: ready + arm + every drain trigger confirmed
  io.controlLog(`tern-bridge reload (${owed.why}): complete vm=${vm} drain=sent${owed.startStuck ? " drain-start=sent" : ""}`);
  return "rearmed";
}

// ---------------- real IO (dispatcher wiring) ----------------

/** tern runner with timeout + TERN_BIN. Any spawn error / timeout / non-zero exit ⇒ ok=false (UNKNOWN). */
export function realTern(env: NodeJS.ProcessEnv = process.env): TernRun {
  const bin = env.TERN_BIN || "tern";
  const sock = env.TERN_PANE_SOCKET || path.join(homedir(), "Library", "Application Support", "Tern", "daemon.sock");
  return (args) => {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: TERN_TIMEOUT_MS, env: { ...env, TERN_PANE_SOCKET: sock } });
    if (r.error) return { ok: false, detail: String(r.error.message ?? r.error) };
    if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${(r.stderr || "").trim().slice(0, 160)}` };
    if (/"ok"\s*:\s*false/.test(r.stdout || "")) return { ok: false, detail: (r.stdout || "").trim().slice(0, 160) };
    return { ok: true, detail: "" };
  };
}

export function realMirrorReader(home: string): () => Mirror {
  return () => {
    try {
      const d = JSON.parse(readFileSync(path.join(bridgeDir(home), "agents.json"), "utf8")) as { tick?: unknown; vm?: unknown };
      return typeof d.tick === "number" && typeof d.vm === "string" ? { tick: d.tick, vm: d.vm } : null;
    } catch { return null; }
  };
}

export function realSentinelReader(home: string): () => ArmStatus {
  return () => {
    try {
      const d = JSON.parse(readFileSync(path.join(bridgeDir(home), "sentinel.json"), "utf8")) as Record<string, unknown>;
      if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
      const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
      const ids = Array.isArray(d.ids) && d.ids.every((x) => typeof x === "number" && Number.isInteger(x)) ? (d.ids as number[]) : null;
      return { step: typeof d.step === "string" ? d.step : null, count: int(d.count), ids, id: int(d.id), error: typeof d.error === "string" ? d.error : null };
    } catch { return null; }
  };
}
export function realClearSentinel(home: string): () => boolean {
  return () => {
    try { unlinkSync(path.join(bridgeDir(home), "sentinel.json")); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; } // absent = fine; any other failure = cannot clear
  };
}
/** arm-schedule.sh runner. `bridgeDir` = the bridge checkout the dispatcher uses (AGENTHOP_BRIDGE_DIR, else repo tern/agenthop-agents-bridge). */
export function realScheduler(env: NodeJS.ProcessEnv, bridgeDir: string): () => { code: number; detail: string } {
  return () => {
    const r = spawnSync("bash", [path.join(bridgeDir, "arm-schedule.sh")], { encoding: "utf8", timeout: 15_000, env });
    if (r.error) return { code: -1, detail: String(r.error.message ?? r.error) };
    return { code: r.status ?? -1, detail: ((r.stdout || "") + (r.stderr || "")).trim().slice(0, 200) };
  };
}

export function realPendingRequests(home: string, nowMs: () => number): () => PendingReq[] {
  return () => {
    const dir = path.join(bridgeDir(home), "requests");
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
    const out: PendingReq[] = [];
    for (const n of names) {
      try {
        const raw = readFileSync(path.join(dir, n), "utf8");
        let isStart = false;
        try {
          const d = JSON.parse(raw) as unknown;
          isStart = typeof d === "object" && d !== null && !Array.isArray(d) && (d as { op?: unknown }).op === "start";
        } catch { isStart = false; }
        out.push({ name: n, ageMs: nowMs() - statSync(path.join(dir, n)).mtimeMs, isStart });
      } catch { /* claimed meanwhile: not pending */ }
    }
    return out;
  };
}

export function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
