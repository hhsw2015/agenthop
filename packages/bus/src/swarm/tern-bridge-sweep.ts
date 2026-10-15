/**
 * Tern bridge sweep (#1033) — the swarm-side duties of agenthop-agents-bridge r7 (PROTOCOL.md §1/§4, README), automated in the
 * dispatcher sweep tail instead of by hand. Flag SWARM_TERN_BRIDGE, DEFAULT OFF. Reads the bridge's files; never edits the bridge.
 *
 * Per sweep tick (the sweep loop already runs every ~5s):
 *   ① drive: `tern ctl plugins run plugin.agenthop-agents-bridge.mirror` (the PRIMARY mirror driver; the bridge's timer chain is
 *      only a helper). Throttled to MIRROR_EVERY_MS.
 *   ② re-arm on reload: agents.json `vm` is a per-load random id. A vm we have not armed yet ⇒ one `…arm`.
 *   ③ health: tick not advancing for > TICK_STALL_MS, or a request in requests/ older than REQ_STUCK_MS ⇒ recovery chain
 *      `tern plugin reload` → wait ready (agents.json tick/vm moves after a mirror) → `…arm` → `…drain` (+ `…drain-start` when the
 *      stuck request is a start). Debounced: at most one reload per RELOAD_MIN_MS. Every reload writes one control-log line.
 *   ④ every tern call has a timeout and uses TERN_BIN.
 *   ⑤ FC-2 three-state: if tern is unavailable (spawn error, timeout, non-zero exit, socket refused) the tick is UNKNOWN: it logs one
 *      line and does NOTHING else. UNKNOWN is never read as "bridge dead" — reload is only ever triggered by a POSITIVE stall signal
 *      read from the bridge's own files while tern itself answered.
 * Pure core + injected IO (tern runner, file reads, clock, log), so the whole call sequence is offline-testable.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** SWARM_TERN_BRIDGE — DEFAULT OFF (opt-in). */
export function ternBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.SWARM_TERN_BRIDGE ?? "");
}

export function bridgeDir(home: string): string { return path.join(home, ".agenthop", "tern-panes"); }

/** One tern call's outcome. ok=false ⇒ tern itself did not answer (UNKNOWN), not a bridge verdict. */
export type TernResult = { ok: boolean; detail: string };
export type TernRun = (args: string[]) => TernResult;

export type Mirror = { tick: number; vm: string } | null;
export type PendingReq = { name: string; ageMs: number };

export type BridgeIO = {
  tern: TernRun;
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
};
export function initialBridgeState(): BridgeState {
  return { lastMirrorMs: -Infinity, armedVm: null, lastTick: null, lastTickChangeMs: -Infinity, lastReloadMs: -Infinity };
}

export type TickOutcome = "disabled" | "throttled" | "unknown" | "ok" | "rearmed" | "reloaded" | "reload-debounced" | "reload-failed";

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
    const a = run(io, "arm");
    if (!a.ok) { io.log(`tern-bridge: UNKNOWN on arm (${a.detail}) — will retry`); return "unknown"; }
    st.armedVm = mirror.vm;
    io.log(`tern-bridge: armed sentinel for vm ${mirror.vm}`);
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
  if (!ready) {
    io.controlLog(`tern-bridge reload (${why}): reloaded but not ready within ${READY_WAIT_MS}ms`);
    return "reload-failed";
  }
  const vm = io.readMirror()?.vm ?? null;
  const armed = run(io, "arm").ok;
  if (armed) st.armedVm = vm;
  const drained = run(io, "drain").ok;
  const startStuck = stuck.some((q) => /start/i.test(q.name));
  if (startStuck) run(io, "drain-start");
  io.controlLog(`tern-bridge reload (${why}): ready vm=${vm} arm=${armed} drain=${drained}${startStuck ? " drain-start=sent" : ""}`);
  return "reloaded";
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

export function realPendingRequests(home: string, nowMs: () => number): () => PendingReq[] {
  return () => {
    const dir = path.join(bridgeDir(home), "requests");
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
    const out: PendingReq[] = [];
    for (const n of names) {
      try {
        const raw = readFileSync(path.join(dir, n), "utf8");
        const isStart = /"op"\s*:\s*"start"/.test(raw);
        out.push({ name: isStart ? `${n}#start` : n, ageMs: nowMs() - statSync(path.join(dir, n)).mtimeMs });
      } catch { /* claimed meanwhile: not pending */ }
    }
    return out;
  };
}

export function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
