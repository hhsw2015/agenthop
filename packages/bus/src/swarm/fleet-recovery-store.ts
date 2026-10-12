/**
 * fleet-recovery — IO layer (full-fleet-recovery piece ①/②, brief §5). Captures the live dispatcher's launch recipe (command + cwd +
 * the allowlisted, secret-stripped env subset) to `~/.agenthop/swarm/fleet-snapshot.json`, reads it back for recover, and supplies the
 * durable facts the orchestrator verifies against (dispatcher pid-liveness, heartbeat freshness, board file names). Mirrors
 * model-catalog-store.ts's discipline: atomic temp+rename writes (0o700/0o600), a CP-3 lstat (no-follow) boundary guard, FC-2
 * error handling (ENOENT ⇒ null, corrupt ⇒ null via the pure parser, any OTHER read fault PROPAGATES). The pure shape/policy
 * (schema, env allowlist, verdicts, breakpoint) lives in fleet-recovery.ts.
 *
 * Secret discipline (Q1): the env subset is filtered by the pure filterCaptureEnv (credentials never captured); at RELAUNCH the shell
 * merges this OVER its own live env, so profile secrets (ANTHROPIC_API_KEY / CPA_API_KEY) come from the canonical live shell and the
 * captured non-secret identity/flag/herdr vars take precedence. A leaked snapshot can never leak a key.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, lstatSync, existsSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  FLEET_SNAPSHOT_SCHEMA,
  parseFleetSnapshot,
  filterCaptureEnv,
  type FleetSnapshot,
  type DispatcherRecipe,
} from "./fleet-recovery.js";

// --- paths -----------------------------------------------------------------------------------------------------------
function swarmDir(home: string): string { return path.join(home, ".agenthop", "swarm"); }
function consoleDir(home: string): string { return path.join(swarmDir(home), "console"); }
function snapshotPath(home: string): string { return path.join(swarmDir(home), "fleet-snapshot.json"); }
function dispatcherLockPath(home: string): string { return path.join(swarmDir(home), "dispatcher.lock"); }
function heartbeatPath(home: string): string { return path.join(swarmDir(home), "heartbeat.json"); }
function boardDir(home: string): string { return path.join(swarmDir(home), "board"); }
export const ROSTER_SNAPSHOT_FILE = "roster-snapshot.json";
function receiptPath(home: string): string { return path.join(consoleDir(home), "fleet-recovery.json"); }

/** CP-3 — a target dir must be a REAL owned directory, never redirected by a pre-existing symlink (which would land the write outside
 *  the boundary). lstat (NO-follow): symlink / non-directory ⇒ REFUSE; ENOENT ⇒ safe (our mkdir makes a real dir); any other stat
 *  fault ⇒ refuse. */
function boundaryOk(dir: string): boolean {
  let st;
  try { st = lstatSync(dir); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
  return st.isDirectory();
}

/** Atomic JSON write (temp + rename) so a reader never sees a half-written file (and concurrent writers both land COMPLETE files;
 *  last rename wins). 0o700 dir / 0o600 file. */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

// --- dispatcher pid / liveness --------------------------------------------------------------------------------------

/** The pid recorded in dispatcher.lock, or null (absent / unreadable / not a number). Fail-soft. */
export function dispatcherPid(home: string): number | null {
  let raw: string;
  try { raw = readFileSync(dispatcherLockPath(home), "utf8"); }
  catch { return null; }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Is the recorded dispatcher pid a live process? false when no pid or the process is gone. Uses signal 0 (existence check). */
export function dispatcherLive(home: string): boolean {
  const pid = dispatcherPid(home);
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // EPERM = alive but not ours (shouldn't happen, same user); ESRCH = gone
}

/** Age (seconds) of heartbeat.json's most recent tick (max of pass/sweep lastTickSec), or null (absent / unreadable / no tick).
 *  Never negative. FC: a corrupt heartbeat ⇒ null (not proven ticking), never a fabricated freshness. */
export function heartbeatFreshSec(home: string, nowSec: number): number | null {
  let raw: string;
  try { raw = readFileSync(heartbeatPath(home), "utf8"); }
  catch { return null; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const tick = (sec: unknown): number | null => {
    if (!sec || typeof sec !== "object") return null;
    const t = (sec as { lastTickSec?: unknown }).lastTickSec;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  };
  const ticks = [tick(r.pass), tick(r.sweep)].filter((t): t is number => t !== null);
  if (ticks.length === 0) return null;
  const last = Math.max(...ticks);
  if (!Number.isFinite(nowSec)) return null;
  return Math.max(0, Math.floor(nowSec - last));
}

// --- env + command + cwd capture (platform-aware) -------------------------------------------------------------------

/** Capture the live environ of a pid into the allowlisted subset. Linux: /proc/<pid>/environ (NUL-separated, exact). macOS/others:
 *  `ps eww -o command=` (command + env appended, space-separated) — tokenized on whitespace, each `KEY=VALUE` token kept iff KEY
 *  passes the pure allowlist (command args never start with SWARM_/HERDR_/the named vars, so they are not mistaken for env). A value
 *  containing spaces is truncated by the ps path (the allowlisted families — ids / paths-without-spaces / flags — do not); documented
 *  lossy edge. Returns {} + a false flag when nothing could be read (⇒ envSource "unavailable"; NEVER fabricate). Never throws. */
export function captureEnvForPid(pid: number): { env: Record<string, string>; ok: boolean } {
  // Linux fast path: exact NUL-separated environ.
  const procEnviron = `/proc/${pid}/environ`;
  if (existsSync(procEnviron)) {
    try {
      const raw = readFileSync(procEnviron, "utf8");
      const out: Record<string, string> = {};
      for (const kv of raw.split("\0")) {
        const eq = kv.indexOf("=");
        if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      const filtered = filterCaptureEnv(out);
      return { env: filtered, ok: Object.keys(out).length > 0 };
    } catch { /* fall through to ps */ }
  }
  // macOS / portable path: ps eww.
  try {
    const stdout = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 8000, maxBuffer: 1 << 22 });
    const out: Record<string, string> = {};
    for (const tok of stdout.trim().split(/\s+/)) {
      const eq = tok.indexOf("=");
      if (eq > 0) { const k = tok.slice(0, eq); if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = tok.slice(eq + 1); }
    }
    const filtered = filterCaptureEnv(out);
    // ok iff we actually saw at least one allowlisted var — an empty filtered set from a real read still means "we could read but it
    // had nothing we keep"; treat truly-empty raw (parse found no KEY=VAL at all) as unavailable.
    return { env: filtered, ok: Object.keys(out).length > 0 };
  } catch {
    return { env: {}, ok: false };
  }
}

/** The dispatcher's command line (ps -o args=), split tokens joined back — args only, NO env. null when the pid is gone/unreadable. */
function commandForPid(pid: number): string | null {
  try {
    const stdout = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 8000 });
    const line = stdout.trim();
    return line.length > 0 ? line : null;
  } catch { return null; }
}

/** Best-effort cwd of a pid. Linux: /proc/<pid>/cwd symlink. macOS: `lsof -a -d cwd -p <pid> -Fn` (the `n` line). null ⇒ caller uses
 *  its fallback (recover's own cwd, which is the repo). Never throws. */
function cwdForPid(pid: number): string | null {
  const procCwd = `/proc/${pid}/cwd`;
  try { if (existsSync(procCwd)) return readlinkSync(procCwd) || null; } catch { /* not linux / unreadable ⇒ lsof below */ }
  try {
    const stdout = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 8000 });
    for (const line of stdout.split("\n")) if (line.startsWith("n")) return line.slice(1).trim() || null;
  } catch { /* lsof unavailable */ }
  return null;
}

/**
 * Capture the live dispatcher's launch recipe, or null when no dispatcher is live. `fallbackCwd` (recover's own cwd = the repo) is used
 * when the real cwd can't be read. envSource is "unavailable" when the environ read failed ⇒ env {} and recover must warn + run with
 * the current shell env (honest-degrade, never fabricate flags). Never throws.
 */
export function captureDispatcherRecipe(home: string, fallbackCwd: string): DispatcherRecipe | null {
  const pid = dispatcherPid(home);
  if (pid === null || !dispatcherLive(home)) return null;
  const command = commandForPid(pid);
  if (command === null) return null; // process vanished between the lock read and the ps
  const { env, ok } = captureEnvForPid(pid);
  const cwd = cwdForPid(pid) ?? fallbackCwd;
  return { command, cwd, env, envSource: ok ? "captured" : "unavailable" };
}

// --- snapshot read / write -------------------------------------------------------------------------------------------

/**
 * Write the fleet snapshot (dispatcher recipe + roster-file pointer) atomically. CP-3: a redirected swarm dir ⇒ SKIP (return false).
 * `recipe` is null when no dispatcher was live (the snapshot still records the roster pointer). Returns whether it was written.
 */
export function writeFleetSnapshot(home: string, recipe: DispatcherRecipe | null, nowSec: number): boolean {
  if (!boundaryOk(swarmDir(home))) return false; // CP-3
  const snap: FleetSnapshot = {
    schema: FLEET_SNAPSHOT_SCHEMA,
    capturedAtSec: Number.isFinite(nowSec) ? Math.floor(nowSec) : 0,
    dispatcher: recipe,
    rosterFile: path.join(swarmDir(home), ROSTER_SNAPSHOT_FILE),
  };
  writeJsonAtomic(snapshotPath(home), snap);
  return true;
}

/** Read the fleet snapshot. ENOENT (no snapshot) ⇒ null; a corrupt / wrong-schema file ⇒ null (via the pure tolerant parser — a
 *  half-written file never masquerades as a snapshot); any OTHER read fault PROPAGATES (house style). */
export function readFleetSnapshot(home: string): FleetSnapshot | null {
  let raw: string;
  try { raw = readFileSync(snapshotPath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  return parseFleetSnapshot(raw);
}

// --- board file names (breakpoint fact source) ----------------------------------------------------------------------

/** The board dir's file names (for claimedItemsForMember). Fail-soft: a missing/unreadable dir ⇒ []. Never throws. */
export function readBoardFileNames(home: string): string[] {
  try { return readdirSync(boardDir(home)); }
  catch { return []; }
}

// --- recovery receipt projection ------------------------------------------------------------------------------------

export const FLEET_RECEIPT_SCHEMA = "console-fleet-recovery/v1" as const;

/**
 * Write the recovery receipt projection (what relaunched, each verdict) atomically to console/fleet-recovery.json. CP-3: a redirected
 * console dir ⇒ SKIP (return false). The caller assembles the receipt object; this only stamps the schema + writes it durably.
 */
export function writeRecoveryReceipt(home: string, receipt: Record<string, unknown>): boolean {
  if (!boundaryOk(consoleDir(home))) return false; // CP-3
  writeJsonAtomic(receiptPath(home), { schema: FLEET_RECEIPT_SCHEMA, ...receipt });
  return true;
}

/** Read the receipt back (console / tests). ENOENT ⇒ null; corrupt / wrong-schema ⇒ null; other read faults propagate. */
export function readRecoveryReceipt(home: string): Record<string, unknown> | null {
  let raw: string;
  try { raw = readFileSync(receiptPath(home), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || (o as { schema?: unknown }).schema !== FLEET_RECEIPT_SCHEMA) return null;
  return o as Record<string, unknown>;
}
