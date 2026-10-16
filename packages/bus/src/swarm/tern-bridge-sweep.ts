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
import { spawnSync } from "node:child_process";
import { cleanTernEnv, realTernSpawn, TERN_SPAWN_TIMEOUT_MS, type TernSpawn } from "./tern-env.js";

export const ACTION = "plugin.agenthop-agents-bridge";
export const MIRROR_EVERY_MS = 5_000;
export const TICK_STALL_MS = 5_000;
export const REQ_STUCK_MS = 2_000;
export const RELOAD_MIN_MS = 60_000;
export const READY_WAIT_MS = 4_000;
/** [liveness] the ready wait is ALSO bounded by poll count (immune to a clock that stalls or goes back) and by a monotonic
 *  deadline: ≤ READY_POLLS mirror probes, ≤ READY_WAIT_MS + one TERN_TIMEOUT_MS + one READY_POLL_MS of real time. */
export const READY_POLL_MS = 250;
export const READY_POLLS = Math.ceil(READY_WAIT_MS / READY_POLL_MS) + 1;
export const TERN_TIMEOUT_MS = TERN_SPAWN_TIMEOUT_MS; // 1.5s (L3; was 3s)
export const ARM_CANCEL_MAX = 64; // bound on arm-cancel iterations (a sentinel that never reaches 0 must not loop forever)
/** L5: after this many consecutive UNKNOWN ticks (tern not answering) the sweep probes only once per UNKNOWN_BACKOFF_MS. */
export const UNKNOWN_BACKOFF_AFTER = 3;
export const UNKNOWN_BACKOFF_MS = 60_000;
/** L5: an owed "ready" (the reload did not take: vm and tick unchanged) for this many rounds, with the debounce passed ⇒ reload again. */
export const OWED_READY_ROUNDS = 3;

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
/** The bridge helper scripts (arm-schedule.sh, gc.sh) call `tern` themselves, so they get the same cleaned env as every other tern
 *  call (L3) plus the bridge's pane dir. */
export function bridgeScriptEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return { ...cleanTernEnv(env), AGENTHOP_TERN_PANES: bridgeDir(home) };
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
  pendingRequests: () => PendingReq[] | null; // null = could not read (UNKNOWN), never "none pending"   // requests/*.json with their age
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
  owedAfterReload: {
    vm: string | null; why: string; startStuck: boolean; stage: "ready" | "arm" | "drain"; reason: string;
    /** TBS-READY-RETRY: the mirror as it was BEFORE the reload. "ready" (now or on a later tick) = vm or tick moved against
     *  THIS baseline — the same rule as the in-reload wait, never merely "the mirror is readable". */
    baseline: Mirror;
    /** L5: ticks this obligation has been retried without progress, and the last reason logged (logged again only on change). */
    rounds: number;
    lastLogged: string;
  } | null;
  /** L5: consecutive UNKNOWN ticks (reset on the first answer) and the last unhealthy-debounced log time. */
  unknownStreak: number;
  lastDebouncedLogMs: number;
};
export function initialBridgeState(): BridgeState {
  return { lastMirrorMs: -Infinity, armedVm: null, lastTick: null, lastTickChangeMs: -Infinity, lastReloadMs: -Infinity, owedAfterReload: null,
    unknownStreak: 0, lastDebouncedLogMs: -Infinity };
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
  // [liveness] the clock went BACK (wall-clock adjustment; production now uses a monotonic clock, this guards any io.nowMs):
  // rebase every stored instant to now, so no interval reads as negative ⇒ never "throttled / debounced / not stalled" for the
  // length of the jump. Effect is bounded: at most one interval of delay.
  if (st.lastMirrorMs > now) st.lastMirrorMs = -Infinity;
  if (st.lastTickChangeMs > now) st.lastTickChangeMs = now;
  if (st.lastReloadMs > now) st.lastReloadMs = now;
  if (st.lastDebouncedLogMs > now) st.lastDebouncedLogMs = -Infinity;
  // L5: once tern has not answered UNKNOWN_BACKOFF_AFTER ticks in a row, probe (and so log) at most once per UNKNOWN_BACKOFF_MS
  const every = st.unknownStreak >= UNKNOWN_BACKOFF_AFTER ? UNKNOWN_BACKOFF_MS : MIRROR_EVERY_MS;
  if (now - st.lastMirrorMs < every) return "throttled";
  st.lastMirrorMs = now;

  // ① drive the mirror. tern not answering ⇒ UNKNOWN: one line, zero further action (⑤).
  const m = run(io, "mirror");
  if (!m.ok) {
    st.unknownStreak++;
    const backoff = st.unknownStreak === UNKNOWN_BACKOFF_AFTER ? ` — ${st.unknownStreak} in a row, probing once per ${UNKNOWN_BACKOFF_MS / 1000}s` : "";
    io.log(`tern-bridge: UNKNOWN (tern did not answer: ${m.detail}) — no action${backoff}`);
    return "unknown";
  }
  if (st.unknownStreak > 0) {
    if (st.unknownStreak >= UNKNOWN_BACKOFF_AFTER) io.log(`tern-bridge: tern answering again after ${st.unknownStreak} UNKNOWN probes`);
    st.unknownStreak = 0;
  }

  const mirror = io.readMirror();
  // agents.json absent / torn / without tick+vm ⇒ UNKNOWN too (FC-2): an unreadable file is not proof the bridge is stuck.
  if (mirror === null) { io.log("tern-bridge: UNKNOWN (agents.json unreadable or without tick/vm) — no action"); return "unknown"; }
  // #1115 T1: one `screen` round (one pane read + classify, its own hook) per sweep tick that reached the bridge. Its outcome is
  // not a liveness signal: a failed or disabled `screen` just lets the screen state go stale, which readers report as UNKNOWN.
  run(io, "screen");
  if (mirror.tick !== st.lastTick) { st.lastTick = mirror.tick; st.lastTickChangeMs = now; }
  if (st.lastTickChangeMs === -Infinity) st.lastTickChangeMs = now; // first observation starts the stall clock

  // L5-LV-SOURCE-UNKNOWN: an unreadable requests dir / request is UNKNOWN, not "nothing stuck" — hold BEFORE anything else,
  // including owed ready/arm/drain work from an earlier reload: no arm, no drain, no reload; every obligation is kept.
  const pending = io.pendingRequests();
  if (pending === null) { io.log("tern-bridge: UNKNOWN (requests/ unreadable) — no action, obligations kept"); return "unknown"; }

  // owed work from an earlier successful reload (arm → drain) comes first, before any new reload decision
  if (st.owedAfterReload !== null) return finishAfterReload(st, io, mirror);

  // ③ health first: a positive stall signal from the bridge's own files (tern answered, so this is not UNKNOWN).
  const stuck = pending.filter((r) => r.ageMs > REQ_STUCK_MS);
  const tickStalled = now - st.lastTickChangeMs > TICK_STALL_MS;
  if (tickStalled || stuck.length > 0) {
    const why = tickStalled ? `tick ${st.lastTick} not advancing ${now - st.lastTickChangeMs}ms` : `request stuck: ${stuck[0]!.name}`;
    if (now - st.lastReloadMs < RELOAD_MIN_MS) {
      // one line per debounce window, not one per tick
      if (now - st.lastDebouncedLogMs >= RELOAD_MIN_MS) {
        st.lastDebouncedLogMs = now;
        io.log(`tern-bridge: unhealthy (${why}) — reload debounced (${now - st.lastReloadMs}ms since last)`);
      }
      return "reload-debounced";
    }
    st.lastReloadMs = now;
    return recover(st, io, why, stuck, mirror);
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
/** `before` = the mirror the stall was OBSERVED on (the caller just read it), not a fresh read: a fresh read that fails would leave
 *  no baseline, and an unknown baseline must never make an unchanged mirror look "moved" (L5-SV-UNKNOWN-BASELINE). */
function recover(st: BridgeState, io: BridgeIO, why: string, stuck: PendingReq[], before: Mirror): TickOutcome {
  const r = io.tern(["plugin", "reload"]);
  if (!r.ok) {
    io.controlLog(`tern-bridge reload FAILED (${why}): ${r.detail}`);
    io.log(`tern-bridge: reload failed (${r.detail})`);
    return "reload-failed";
  }
  // ready = after a mirror run, the vm id changed or the tick moved. `tern plugin list` is NOT used: without a reachable daemon it
  // falls back to listing the plugins directory and still says "ready".
  const t0 = performance.now(); // monotonic: a wall-clock jump cannot stretch this wait
  let ready = false;
  for (let poll = 0; poll < READY_POLLS && !ready; poll++) {
    if (run(io, "mirror").ok) {
      const after = io.readMirror();
      ready = movedSince(before, after);
      if (ready) { st.lastTick = after!.tick; st.lastTickChangeMs = io.nowMs(); }
    }
    if (ready || poll === READY_POLLS - 1 || performance.now() - t0 >= READY_WAIT_MS) break;
    io.sleep(READY_POLL_MS);
  }
  // From here a reload HAPPENED: whatever is left (ready, arm, drain) is an obligation kept across ticks until the WHOLE chain
  // succeeds, never re-entering the reload debounce (TBS-ARM-RETRY, coordinator ruling).
  st.owedAfterReload = { vm: null, why, startStuck: stuck.some((q) => q.isStart), stage: "ready", reason: "", baseline: before, rounds: 0, lastLogged: "" };
  if (!ready) {
    st.owedAfterReload.reason = `not ready within ${READY_WAIT_MS}ms`;
    io.controlLog(`tern-bridge reload (${why}): reloaded but not ready within ${READY_WAIT_MS}ms — owed, retry next tick (no reload)`);
    return "reload-failed";
  }
  const out = finishAfterReload(st, io, io.readMirror());
  return out === "rearmed" ? "reloaded" : out;
}

/** The post-reload obligation: arm sequence, then drain (+drain-start). A stopped arm keeps the obligation (no drain after a half
 *  arm) and is retried on the next tick WITHOUT another reload. Discharged only when arm completed and the drain trigger was sent. */
/** The one readiness rule: after a reload the bridge is ready iff the mirror is readable and its vm or tick differs from the
 *  pre-reload baseline. UNKNOWN baseline (null) ⇒ NOT ready: without a known "before", no change can be proven
 *  (L5-SV-UNKNOWN-BASELINE, P1). */
export function movedSince(baseline: Mirror, now: Mirror): boolean {
  return now !== null && baseline !== null && (now.vm !== baseline.vm || now.tick !== baseline.tick);
}

function finishAfterReload(st: BridgeState, io: BridgeIO, now: Mirror): TickOutcome {
  const vm = now?.vm ?? null;
  const owed = st.owedAfterReload!;
  const keep = (stage: "ready" | "arm" | "drain", reason: string): TickOutcome => {
    owed.stage = stage; owed.reason = reason; owed.vm = vm; owed.rounds++;
    const line = `owed at ${stage} — ${reason}`;
    if (line !== owed.lastLogged) { // one audit line per distinct state, not one per tick
      owed.lastLogged = line;
      io.controlLog(`tern-bridge reload (${owed.why}): ${line} (retry next tick, no reload)`);
    }
    return "reload-failed";
  };
  if (owed.stage === "ready") {
    // a ready-wait that timed out last time: same rule as the in-reload wait — moved against the pre-reload baseline
    const unmoved = now === null ? "mirror still unreadable" : !movedSince(owed.baseline, now) ? `mirror unchanged since the reload (vm ${now.vm}, tick ${now.tick})` : null;
    if (unmoved !== null) {
      // L5: the reload did not take (live 2026-10-16: vm and tick frozen for 6h while every tick said "owed, no reload"). After
      // OWED_READY_ROUNDS rounds without progress, and only once the reload debounce has passed, reload again.
      const t = io.nowMs();
      if (owed.rounds + 1 >= OWED_READY_ROUNDS && t - st.lastReloadMs >= RELOAD_MIN_MS) {
        io.controlLog(`tern-bridge reload (${owed.why}): previous reload did not take after ${owed.rounds + 1} rounds (${unmoved}) — reloading again`);
        st.lastReloadMs = t;
        // the existing obligation (baseline, startStuck) stays in place until recover() REPLACES it with a new one — which it
        // does only once a reload actually ran; a failed / unanswered reload leaves this one intact, retried after the debounce
        const out = recover(st, io, owed.why, owed.startStuck ? [{ name: "(owed drain-start)", ageMs: 0, isStart: true }] : [], owed.baseline);
        if (st.owedAfterReload === owed) owed.rounds = 0; // still the old one: the reload did not run; count again from here
        return out;
      }
      return keep("ready", unmoved);
    }
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
export function realTern(env: NodeJS.ProcessEnv = process.env, spawn: TernSpawn = realTernSpawn(env)): TernRun {
  return (args) => {
    const r = spawn(args);
    if (r.error) return { ok: false, detail: r.error };
    if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${r.stderr.trim().slice(0, 160)}` };
    if (/"ok"\s*:\s*false/.test(r.stdout)) return { ok: false, detail: r.stdout.trim().slice(0, 160) };
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
    const r = spawnSync("bash", [path.join(bridgeDir, "arm-schedule.sh")], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", env });
    if (r.error) return { code: -1, detail: String(r.error.message ?? r.error) };
    return { code: r.status ?? -1, detail: ((r.stdout || "") + (r.stderr || "")).trim().slice(0, 200) };
  };
}

/** requests/*.json with their age. Only ENOENT means "not there" (no dir = none pending; a request gone = claimed meanwhile);
 *  any other read error (EIO, EACCES, …) on the dir or a request ⇒ null = UNKNOWN (L5-LV-SOURCE-UNKNOWN). `fs` is a test seam. */
export function realPendingRequests(home: string, nowMs: () => number,
  fs: { readdir: (d: string) => string[]; read: (f: string) => string; mtimeMs: (f: string) => number } =
    { readdir: (d) => readdirSync(d), read: (f) => readFileSync(f, "utf8"), mtimeMs: (f) => statSync(f).mtimeMs }): () => PendingReq[] | null {
  const gone = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
  return () => {
    const dir = path.join(bridgeDir(home), "requests");
    let names: string[];
    try { names = fs.readdir(dir).filter((n) => n.endsWith(".json")); } catch (e) { return gone(e) ? [] : null; }
    const out: PendingReq[] = [];
    for (const n of names) {
      const f = path.join(dir, n);
      let raw: string; let mtime: number;
      try { raw = fs.read(f); mtime = fs.mtimeMs(f); } catch (e) { if (gone(e)) continue; return null; }
      let isStart = false;
      try {
        const d = JSON.parse(raw) as unknown;
        isStart = typeof d === "object" && d !== null && !Array.isArray(d) && (d as { op?: unknown }).op === "start";
      } catch { isStart = false; }
      out.push({ name: n, ageMs: nowMs() - mtime, isStart });
    }
    return out;
  };
}

export function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
