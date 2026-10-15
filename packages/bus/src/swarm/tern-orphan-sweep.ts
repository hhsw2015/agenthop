/**
 * Orphan sweep (#1033 r3; user rule "no leaks", coordinator ruling: RECORD-DRIVEN). Runs every ORPHAN_EVERY_MS from the tern-bridge
 * sweep step. Three classes:
 *   ① a herdr session REGISTERED in a seat-shell record (workers[].herdr_session) whose worker is state "stopped" (or "orphan")
 *      but the herdr session still exists ⇒ `herdr session stop <name>` then `herdr session delete <name>`.
 *   ② a seat-shell worker in state "live"/"stopping" whose Tern block (workers[].pane) is gone from `tern ls --json` ⇒ mark the
 *      record "orphan" (+stopped_at), then ① applies to its herdr session on the following confirmations.
 *   ③ control-plane files: the bridge's gc.sh (results/requests/tmp/quarantine TTLs; r12 line adds requests_held = could not
 *      quarantine, left in place, retried next run — any nonzero field is audited) + mirror-phase.json / diag.json older than 1h.
 * Never touched: the herdr session "default", and ANY herdr session that no seat-shell record ever registered (a name shaped like
 * `<role>-<task>` is only a second check, never a reason). Seat-shell schema (coordinator, pinned 2026-10-15):
 *   ~/.agenthop/swarm/seat-shell/<sid>.json  { …, workers: [{ name, herdr_session, pane, kind:"tui", started_at, stopped_at, state }] }
 *   pane = Tern block id as a NUMBER; started_at / stopped_at = epoch ms numbers (stopped_at null while live). Strict: a pane of any
 *   other type is a schema violation (logged) and the worker is never judged orphan.
 * Debounce: an orphan is acted on only when the SAME candidate was seen on two consecutive rounds. FC-2: if herdr or tern cannot be
 * read this round ⇒ UNKNOWN ⇒ zero actions (and the two-round memory is cleared, so an unknown round can never count as a "yes").
 * Each action writes one line to the reload audit (same log as the bridge sweep). Pure core + injected IO.
 */
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ORPHAN_EVERY_MS = 60_000;
export const TMP_TTL_MS = 3_600_000;
const NAME_SHAPE = /^[a-z0-9]+-[a-z0-9][a-z0-9-]*$/i; // `<role>-<task>`: a second check only

export type Worker = { name?: unknown; herdr_session?: unknown; pane?: unknown; kind?: unknown; started_at?: unknown; stopped_at?: unknown; state?: unknown };
export type SeatRecord = { sid: string; workers: Worker[] };

export type OrphanIO = {
  seatRecords: () => SeatRecord[] | null;              // null = seat-shell dir unreadable (UNKNOWN); [] = none
  herdrSessions: () => string[] | null;                // null = herdr unreachable (UNKNOWN)
  ternBlocks: () => Set<number> | null;                // live block ids from tern ls --json; null = UNKNOWN
  herdrStop: (name: string) => boolean;
  herdrDelete: (name: string) => boolean;
  markWorker: (sid: string, herdrSession: string, state: "orphan", stoppedAt: number) => boolean;
  gc: () => { code: number; line: string };            // bridge gc.sh: exit 1 = control dir unreadable = UNKNOWN
  tmpFiles: () => Array<{ name: string; ageMs: number }>; // mirror-phase.json / diag.json with age
  removeTmp: (name: string) => boolean;
  nowMs: () => number;
  log: (l: string) => void;
  audit: (l: string) => void;
};

export type OrphanState = { lastRunMs: number; seen: Set<string> };
export function initialOrphanState(): OrphanState { return { lastRunMs: -Infinity, seen: new Set() }; }

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** Tern block id from a worker record. Schema (coordinator, 2026-10-15): pane is a NUMBER. Strict on purpose: accepting a numeric
 *  string too would let a wrongly-typed writer go unnoticed forever. Anything else ⇒ null ⇒ cannot prove the block is gone ⇒ the
 *  worker is never marked orphan, and the caller logs a schema-violation line so the bad record is visible. */
export function paneId(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** One orphan round. Returns the candidate keys acted on (for tests). */
export function runOrphanSweep(st: OrphanState, io: OrphanIO): { ran: boolean; unknown: boolean; acted: string[] } {
  const now = io.nowMs();
  if (now - st.lastRunMs < ORPHAN_EVERY_MS) return { ran: false, unknown: false, acted: [] };
  st.lastRunMs = now;

  // ③ control-plane files first: independent of herdr/tern reachability.
  const g = io.gc();
  if (g.code !== 0) io.log(`orphan-sweep: gc UNKNOWN (${g.line})`);
  else if (/=[1-9]/.test(g.line)) io.audit(`orphan-sweep ${g.line}`); // audit only when gc actually removed/moved something
  // r13: `skipped=<dir>(why),...` = a managed subdir was a symlink / outside the control dir and was NOT cleaned — an anomaly
  const skipped = g.code === 0 ? /\bskipped=(\S+)/.exec(g.line) : null;
  if (skipped) io.log(`orphan-sweep: gc anomaly — not cleaned: ${skipped[1]}`);
  for (const f of io.tmpFiles()) {
    if (f.ageMs > TMP_TTL_MS && io.removeTmp(f.name)) io.audit(`orphan-sweep removed stale ${f.name} (${Math.round(f.ageMs / 60000)}min)`);
  }

  const recs = io.seatRecords();
  const sessions = io.herdrSessions();
  const blocks = io.ternBlocks();
  if (recs === null || sessions === null || blocks === null) {
    io.log(`orphan-sweep: UNKNOWN (${recs === null ? "seat-shell " : ""}${sessions === null ? "herdr " : ""}${blocks === null ? "tern" : ""}unreadable) — no action`);
    st.seen.clear();
    return { ran: true, unknown: true, acted: [] };
  }
  const workers = recs.flatMap((r) => r.workers.map((w) => ({ sid: r.sid, w })));
  if (workers.length === 0) {
    io.log("orphan-sweep: no registered herdr sessions");
    st.seen.clear();
    return { ran: true, unknown: false, acted: [] };
  }

  const live = new Set(sessions);
  const candidates: Array<{ key: string; act: () => void }> = [];
  for (const { sid, w } of workers) {
    const hs = str(w.herdr_session);
    const state = str(w.state);
    if (hs === null || hs === "default" || !NAME_SHAPE.test(hs)) continue; // second check only; never a reason to act
    // ② live record whose Tern block vanished ⇒ mark orphan (two rounds)
    const pane = paneId(w.pane);
    if ((state === "live" || state === "stopping") && pane === null)
      io.log(`orphan-sweep: schema-violation seat ${sid.slice(0, 8)} worker ${hs}: pane ${JSON.stringify(w.pane)} is not a number — not judged`);
    if ((state === "live" || state === "stopping") && pane !== null && !blocks.has(pane)) {
      candidates.push({ key: `mark:${sid}:${hs}`, act: () => {
        if (io.markWorker(sid, hs, "orphan", now)) io.audit(`orphan-sweep marked ${hs} orphan (seat ${sid.slice(0, 8)}, block ${pane} gone)`);
        else io.log(`orphan-sweep: could not mark ${hs} orphan`);
      } });
      continue;
    }
    // ① stopped/orphan record whose herdr session still exists ⇒ stop + delete (two rounds)
    if ((state === "stopped" || state === "orphan") && live.has(hs)) {
      candidates.push({ key: `kill:${sid}:${hs}`, act: () => {
        const stopped = io.herdrStop(hs);
        const deleted = stopped && io.herdrDelete(hs);
        io.audit(`orphan-sweep herdr session ${hs} (seat ${sid.slice(0, 8)}, record ${state}): stop=${stopped} delete=${deleted}`);
      } });
    }
  }
  const acted: string[] = [];
  const next = new Set<string>();
  for (const c of candidates) {
    if (st.seen.has(c.key)) { c.act(); acted.push(c.key); }
    else next.add(c.key); // first sighting: remember, act only if it is still an orphan next round
  }
  st.seen = next;
  return { ran: true, unknown: false, acted };
}

// ---------------- real IO ----------------
export function realSeatRecords(home: string): () => SeatRecord[] | null {
  const dir = path.join(home, ".agenthop", "swarm", "seat-shell");
  return () => {
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null; }
    const out: SeatRecord[] = [];
    for (const n of names) {
      try {
        const d = JSON.parse(readFileSync(path.join(dir, n), "utf8")) as { workers?: unknown };
        out.push({ sid: n.slice(0, -5), workers: Array.isArray(d.workers) ? (d.workers as Worker[]) : [] });
      } catch { return null; } // one unreadable record = we cannot prove which sessions are registered ⇒ UNKNOWN
    }
    return out;
  };
}

export function realMarkWorker(home: string): OrphanIO["markWorker"] {
  return (sid, hs, state, stoppedAt) => {
    const file = path.join(home, ".agenthop", "swarm", "seat-shell", `${sid}.json`);
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as { workers?: Worker[] };
      if (!Array.isArray(d.workers)) return false;
      let hit = false;
      d.workers = d.workers.map((w) => (w.herdr_session === hs ? (hit = true, { ...w, state, stopped_at: stoppedAt }) : w)); // epoch ms
      if (!hit) return false;
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(d) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch { return false; }
  };
}

const HERDR_TIMEOUT_MS = 5_000;
export function realHerdr(env: NodeJS.ProcessEnv = process.env) {
  const bin = env.HERDR_BIN || "herdr";
  const run = (args: string[]) => spawnSync(bin, args, { encoding: "utf8", timeout: HERDR_TIMEOUT_MS, env });
  return {
    sessions: (): string[] | null => {
      const r = run(["session", "list", "--json"]);
      if (r.error || r.status !== 0) return null;
      try {
        const d = JSON.parse(r.stdout) as { sessions?: Array<{ name?: unknown }> };
        if (!Array.isArray(d.sessions)) return null;
        return d.sessions.map((s) => (typeof s.name === "string" ? s.name : "")).filter(Boolean);
      } catch { return null; }
    },
    stop: (name: string) => { const r = run(["session", "stop", name]); return !r.error && r.status === 0; },
    del: (name: string) => { const r = run(["session", "delete", name]); return !r.error && r.status === 0; },
  };
}

/** Live Tern block ids from `tern ls --json` output (ls returns null when tern did not answer). Any shape it cannot read ⇒ null. */
export function realTernBlocks(ls: () => string | null): () => Set<number> | null {
  return () => {
    const out = ls();
    if (out === null) return null;
    try {
      const d = JSON.parse(out) as { sessions?: unknown };
      if (!Array.isArray(d.sessions)) return null;
      const ids = new Set<number>();
      for (const s of d.sessions as Array<{ tabs?: unknown }>) {
        if (!Array.isArray(s.tabs)) return null;
        for (const t of s.tabs as Array<{ blocks?: unknown }>) {
          if (!Array.isArray(t.blocks)) return null;
          for (const b of t.blocks as Array<{ id?: unknown; live?: unknown }>) if (typeof b.id === "number" && b.live === true) ids.add(b.id);
        }
      }
      return ids;
    } catch { return null; }
  };
}

export function realTmpFiles(home: string, nowMs: () => number): Pick<OrphanIO, "tmpFiles" | "removeTmp"> {
  const dir = path.join(home, ".agenthop", "tern-panes");
  const NAMES = ["mirror-phase.json", "diag.json"];
  return {
    tmpFiles: () => NAMES.flatMap((n) => { try { return [{ name: n, ageMs: nowMs() - statSync(path.join(dir, n)).mtimeMs }]; } catch { return []; } }),
    removeTmp: (n) => { if (!NAMES.includes(n)) return false; try { unlinkSync(path.join(dir, n)); return true; } catch { return false; } },
  };
}

export function realGc(env: NodeJS.ProcessEnv, bridgeDir: string): OrphanIO["gc"] {
  return () => {
    const r = spawnSync("bash", [path.join(bridgeDir, "gc.sh")], { encoding: "utf8", timeout: 10_000, env });
    if (r.error) return { code: -1, line: String(r.error.message ?? r.error) };
    return { code: r.status ?? -1, line: (r.stdout || r.stderr || "").trim().split("\n").pop() ?? "" };
  };
}
