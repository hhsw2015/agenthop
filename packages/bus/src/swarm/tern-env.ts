/**
 * L3 (long-run-liveness, 2026-10-16): the env a NON-PANE long-running process (the dispatcher and its sweeps) hands to `tern` and
 * records for its own relaunch.
 *
 * Measured live: `tern ctl plugins run …` from outside a pane finds the daemon ONLY through TERN_PANE_SOCKET (without it: "/tmp/tern.sock:
 * No such file", rc=1; TERN_DAEMON_SOCKET is not read by ctl) — so it is KEPT, set explicitly. What is dropped is what describes the
 * pane the process was STARTED from, which a dispatcher outlives: TERN_PANE (a stale one names a dead block — 2026-10-16 it was the old
 * coordinator's 1056561954886), the TERN_WINDOW, TERN_PROMPT and other per-pane TERN_ variables, every CLAUDE_ variable, and the
 * HERDR_PANE / HERDR_TAB / HERDR_WORKSPACE / HERDR_STARTUP ones. Pure except realTernSpawn.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

/** Tern vars a non-pane process keeps: the binary and the daemon socket. Every other TERN_* is per-pane. */
export const TERN_KEEP: readonly string[] = ["TERN_BIN", "TERN_PANE_SOCKET"];
/** HERDR vars that describe the pane/tab/workspace the process started in (the binary and server socket stay). */
const HERDR_PANE_RE = /^HERDR_(PANE|TAB|WORKSPACE|STARTUP)_/;

export function defaultDaemonSocket(home: string = homedir()): string {
  return path.join(home, "Library", "Application Support", "Tern", "daemon.sock");
}

/** Drop per-pane / per-session identity from an inherited env. Returns a NEW object; TERN_PANE_SOCKET is always present (inherited
 *  value, else the default daemon socket). Pure. */
export function cleanTernEnv(env: Record<string, string | undefined>, home: string = homedir()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (k.startsWith("TERN_") && !TERN_KEEP.includes(k)) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) continue;
    if (HERDR_PANE_RE.test(k) || k === "HERDR_PANE_ID") continue;
    out[k] = v;
  }
  out.TERN_PANE_SOCKET = env.TERN_PANE_SOCKET || defaultDaemonSocket(home);
  return out;
}

export const TERN_SPAWN_TIMEOUT_MS = 1_500;
export type TernSpawn = (args: string[]) => { ok: boolean; status: number | null; stdout: string; stderr: string; error?: string };

/** The ONE way a non-pane process runs `tern`: the cleaned env, TERN_BIN, a 1.5s ceiling. */
export function realTernSpawn(env: NodeJS.ProcessEnv = process.env, timeoutMs = TERN_SPAWN_TIMEOUT_MS): TernSpawn {
  const clean = cleanTernEnv(env);
  const bin = clean.TERN_BIN || "tern";
  return (args) => {
    // SIGKILL: a short read-only ctl call has nothing to flush, and a child that ignores TERM would hold the sweep
    // past its budget
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", env: clean });
    if (r.error) return { ok: false, status: null, stdout: "", stderr: "", error: String((r.error as Error).message ?? r.error) };
    return { ok: r.status === 0, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  };
}
