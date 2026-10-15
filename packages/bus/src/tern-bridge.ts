import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { scrubbedEnv } from "./spawn.js";

/**
 * Native caller for the Tern A1 agents-bridge (tern/agenthop-agents-bridge, PROTOCOL.md). One call = the three manual steps a
 * session used to type: atomically PUBLISH requests/<id>.json (temp + rename, the publish.sh contract) → TRIGGER the op-class drain
 * (`tern ctl plugins run plugin.agenthop-agents-bridge.drain|drain-start`) → POLL results/<id>.json, then consume it.
 *
 * Timeout semantics follow PROTOCOL.md §3.3. A READ-ONLY op (list / transcript / wait, or eval when the caller asserts
 * args.readonly=true) that times out gets ONE automatic recovery: `tern plugin reload` → wait for the plugin to report ready → run
 * `…arm` → re-trigger the drain → wait again. A NON-IDEMPOTENT op (ask / start / interrupt / stop / eval) that times out returns
 * {state:"UNKNOWN", hold:true, id} and is NEVER re-sent — it may have run, only the receipt is missing.
 *
 * FC-2: every failure to even reach the bridge (no tern binary, socket refused, plugin not loaded) is reported as state "unknown"
 * with a reason — never as "the bridge is dead". Every subprocess has a timeout and a scrubbed env; TERN_BIN overrides discovery.
 *
 * Two live facts (#1033, Infra Dev) shape the evidence rules here:
 *   - `tern ctl plugins run <action>` returns {"ok":true} rc 0 even for an action that does not exist, so a successful ctl call is
 *     NEVER proof the drain ran. Only results/<id>.json appearing counts as an answer.
 *   - `tern plugin list` falls back to reading the plugins directory when the daemon is unreachable and still reports "ready", so it
 *     is NOT a readiness probe. Ready after a reload = triggering the `mirror` command moves agents.json's vm or tick (the same
 *     criterion #1033's sweep uses — one recovery-chain definition, PROTOCOL.md §4).
 *
 * All IO is injected (TernDeps) so the whole flow is unit-tested against a fake tern and a fake control dir.
 */

export const PLUGIN_ID = "agenthop-agents-bridge";
export const TERN_OPS = ["list", "transcript", "wait", "ask", "start", "interrupt", "stop", "eval"] as const;
export type TernOp = (typeof TERN_OPS)[number];
const READ_ONLY: ReadonlySet<string> = new Set(["list", "transcript", "wait"]);

/** Op class for recovery purposes (PROTOCOL.md §3.3). eval is non-idempotent unless the caller asserts args.readonly=true. Pure. */
export function opClass(op: string, args: Record<string, unknown> = {}): "read-only" | "non-idempotent" {
  if (READ_ONLY.has(op)) return "read-only";
  if (op === "eval" && args.readonly === true) return "read-only";
  return "non-idempotent";
}

/** Which drain command serves an op: `start` has its own hook (it can exceed the 50ms budget); everything else is `drain`. Pure. */
export function drainActionFor(op: string): string {
  return `plugin.${PLUGIN_ID}.${op === "start" ? "drain-start" : "drain"}`;
}

/**
 * #1035: Tern ACP blocks only show top-level sessions, so `start` is the swarm's front door for VISIBLE work. Its block opens as a
 * sibling TAB by default, and an optional `title` (a fixed English role name, never a session id — user rule) is applied with
 * `tern rename <pane> <title>` once start reports the pane. Returns null when the title is acceptable, else the reason. Pure.
 */
const SID_LIKE = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|\b[0-9a-f]{8}\b/i;
export function checkRoleTitle(title: unknown): string | null {
  if (title === undefined) return null;
  if (typeof title !== "string" || title.trim() === "") return "title must be a non-empty string";
  if (title.length > 60) return "title too long (max 60)";
  if (!/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(title)) return "title must be an English role name (letters, digits, space . _ -)";
  if (SID_LIKE.test(title)) return "title must not contain a session id (use a fixed role name)";
  return null;
}

export type Run = { code: number; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };

export type TernDeps = {
  bin: string | undefined;
  ctlDir: string;
  socket: string;
  run: (bin: string, args: string[], timeoutMs: number) => Promise<Run>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
};

/** Resolve the tern binary: TERN_BIN override, then ~/.local/bin, common prefixes, then PATH. Pure-ish (existsSync). */
export function ternBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.TERN_BIN) return existsSync(env.TERN_BIN) ? env.TERN_BIN : undefined;
  const fixed = [path.join(homedir(), ".local", "bin", "tern"), "/usr/local/bin/tern", "/opt/homebrew/bin/tern"];
  for (const c of fixed) if (safeExists(c)) return c;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir && safeExists(path.join(dir, "tern"))) return path.join(dir, "tern");
  }
  return undefined;
}
function safeExists(p: string): boolean { try { return existsSync(p); } catch { return false; } }

/** Real subprocess runner: fixed argv (no shell), timeout, scrubbed env + TERN_PANE_SOCKET so ctl works from outside a Tern pane. */
export function realRun(socket: string): TernDeps["run"] {
  return (bin, args, timeoutMs) =>
    new Promise((resolve) => {
      const env = { ...scrubbedEnv(process.env), TERN_PANE_SOCKET: socket };
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown }) | null;
        const timedOut = !!e && (e.killed === true || e.signal === "SIGTERM");
        const spawnError = e && typeof e.code === "string" ? e.code : undefined; // ENOENT/EACCES: the binary could not start
        const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut, spawnError });
      });
    });
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): TernDeps {
  const home = env.AH_HOME ?? homedir();
  const socket = env.TERN_PANE_SOCKET ?? path.join(homedir(), "Library", "Application Support", "Tern", "daemon.sock");
  return {
    bin: ternBin(env),
    ctlDir: env.AGENTHOP_TERN_PANES ?? path.join(home, ".agenthop", "tern-panes"),
    socket,
    run: realRun(socket),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newId: () => `mcp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
  };
}

/** Atomic publish (the publish.sh contract, PROTOCOL.md §2.0): exclusive temp in requests/, then rename into place. */
export function publishRequest(ctlDir: string, id: string, body: Record<string, unknown>): void {
  const dir = path.join(ctlDir, "requests");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${id}.tmp-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(body), { flag: "wx", mode: 0o600 });
  try { renameSync(tmp, path.join(dir, `${id}.json`)); }
  catch (e) { try { unlinkSync(tmp); } catch { /* own temp */ } throw e; }
}

/** Read + consume results/<id>.json. undefined = not there yet; a corrupt/partial file is "not yet" (retry). */
export function takeResult(ctlDir: string, id: string): unknown | undefined {
  const f = path.join(ctlDir, "results", `${id}.json`);
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  try { unlinkSync(f); } catch { /* best-effort consume */ }
  return parsed;
}

/** Classify a `tern` invocation that failed to reach the bridge (FC-2). undefined = it reached Tern. Pure. */
export function unreachable(r: Run): string | undefined {
  if (r.spawnError) return `tern could not start (${r.spawnError})`;
  if (r.timedOut) return "tern timed out (daemon not answering?)";
  const out = `${r.stdout}\n${r.stderr}`.toLowerCase();
  if (r.code !== 0 && /connection refused|no such file|socket|not running|cannot connect/.test(out)) return `tern socket unreachable: ${(r.stderr || r.stdout).trim().slice(0, 200)}`;
  if (r.code !== 0 && /unknown action|no such action|not found|unknown command/.test(out)) return `bridge plugin not loaded: ${(r.stderr || r.stdout).trim().slice(0, 200)}`;
  if (r.code !== 0) return `tern exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`;
  return undefined;
}

export type CallResult =
  | { state: "ok"; id: string; ms: number; result: unknown; recovered?: boolean; pane?: number; renamed?: string; renameError?: string }
  | { state: "UNKNOWN"; hold: true; id: string; ms: number; reason: string }
  | { state: "timeout"; id: string; ms: number; recovered: boolean; reason: string }
  | { state: "unknown"; id?: string; ms: number; reason: string };

const CTL_TIMEOUT_MS = 5000;

async function trigger(d: TernDeps, op: string): Promise<string | undefined> {
  const r = await d.run(d.bin!, ["ctl", "plugins", "run", drainActionFor(op)], CTL_TIMEOUT_MS);
  return unreachable(r);
}

async function poll(d: TernDeps, id: string, waitMs: number): Promise<unknown | undefined> {
  const deadline = d.now() + waitMs;
  for (;;) {
    const res = takeResult(d.ctlDir, id);
    if (res !== undefined) return res;
    if (d.now() >= deadline) return undefined;
    await d.sleep(100);
  }
}

/** agents.json tick + vm, or null when absent/torn/unparseable. */
export function readMirror(ctlDir: string): { tick: number; vm: string } | null {
  try {
    const j = JSON.parse(readFileSync(path.join(ctlDir, "agents.json"), "utf8")) as { tick?: unknown; vm?: unknown };
    return typeof j.tick === "number" && typeof j.vm === "string" ? { tick: j.tick, vm: j.vm } : null;
  } catch { return null; }
}

/**
 * The recovery chain (PROTOCOL.md §4, same definition as #1033's sweep): reload → wait READY → arm. READY = after triggering the
 * `mirror` command, agents.json's vm changed or its tick moved (`tern plugin list` is not a probe — it says "ready" without a daemon).
 * Returns a reason string on failure, undefined on success.
 */
export async function recover(d: TernDeps): Promise<string | undefined> {
  const before = readMirror(d.ctlDir);
  const r = await d.run(d.bin!, ["plugin", "reload"], 15000);
  const bad = unreachable(r);
  if (bad) return `reload failed: ${bad}`;
  const deadline = d.now() + 5000;
  for (;;) {
    await d.run(d.bin!, ["ctl", "plugins", "run", `plugin.${PLUGIN_ID}.mirror`], CTL_TIMEOUT_MS);
    const after = readMirror(d.ctlDir);
    if (after !== null && (before === null || after.vm !== before.vm || after.tick !== before.tick)) break;
    if (d.now() >= deadline) return "bridge not ready after reload (agents.json vm/tick did not move on a mirror trigger)";
    await d.sleep(200);
  }
  const a = await d.run(d.bin!, ["ctl", "plugins", "run", `plugin.${PLUGIN_ID}.arm`], CTL_TIMEOUT_MS);
  const armBad = unreachable(a);
  return armBad ? `arm failed: ${armBad}` : undefined;
}


/** After a successful start, apply the role title with `tern rename <pane> <title>`. Best-effort: the start already happened, so a
 *  rename failure is reported alongside the ok result, never turned into an error or a retry of the start. */
async function nameStarted(d: TernDeps, op: string, result: unknown, title: string | undefined): Promise<{ pane?: number; renamed?: string; renameError?: string }> {
  if (op !== "start") return {};
  const pane = (result as { pane?: unknown } | null)?.pane;
  if (typeof pane !== "number") return {};
  if (!title) return { pane };
  const r = await d.run(d.bin!, ["rename", String(pane), title], CTL_TIMEOUT_MS);
  const bad = unreachable(r);
  return bad ? { pane, renameError: bad } : { pane, renamed: title };
}

/** One bridge call: publish → trigger → poll, with PROTOCOL §3.3 timeout semantics. Never throws. */
export async function ternCall(op: string, args: Record<string, unknown> = {}, timeoutMs = 2000, d: TernDeps = defaultDeps()): Promise<CallResult> {
  const t0 = d.now();
  const ms = () => d.now() - t0;
  if (!(TERN_OPS as readonly string[]).includes(op)) return { state: "unknown", ms: ms(), reason: `unsupported op "${op}" (allowed: ${TERN_OPS.join(", ")})` };
  if (!d.bin) return { state: "unknown", ms: ms(), reason: "tern binary not found (set TERN_BIN)" }; // zero actions taken
  let title: string | undefined;
  if (op === "start") {
    const bad = checkRoleTitle(args.title);
    if (bad) return { state: "unknown", ms: ms(), reason: `start: ${bad}` }; // rejected before any publish: zero actions
    title = args.title as string | undefined;
  }
  const id = d.newId();
  const { readonly: _ro, title: _t, ...rest } = args; // `readonly`/`title` are caller-side; the bridge never sees them
  const wire = op === "start" && rest.how === undefined ? { ...rest, how: "tab" } : rest; // #1035: start opens a sibling tab by default
  try { publishRequest(d.ctlDir, id, { op, ...wire }); }
  catch (e) { return { state: "unknown", id, ms: ms(), reason: `publish failed: ${(e as Error).message}` }; }

  const bad = await trigger(d, op);
  if (bad) {
    // We could not reach Tern. The request sits published; for a non-idempotent op that is still an UNKNOWN obligation.
    return opClass(op, args) === "non-idempotent"
      ? { state: "UNKNOWN", hold: true, id, ms: ms(), reason: `trigger did not reach the bridge: ${bad}` }
      : { state: "unknown", id, ms: ms(), reason: bad };
  }
  const first = await poll(d, id, timeoutMs);
  if (first !== undefined) return { state: "ok", id, ms: ms(), result: first, ...(await nameStarted(d, op, first, title)) };

  if (opClass(op, args) === "non-idempotent") {
    return { state: "UNKNOWN", hold: true, id, ms: ms(), reason: "no result in time; the op may have run — HOLD, do not re-send (PROTOCOL.md §3.3)" };
  }
  // Read-only: ONE recovery, then re-trigger the SAME published request and wait again (still unconsumed ⇒ no duplicate).
  const rec = await recover(d);
  if (rec) return { state: "unknown", id, ms: ms(), reason: `timed out; recovery failed: ${rec}` };
  const bad2 = await trigger(d, op);
  if (bad2) return { state: "unknown", id, ms: ms(), reason: `timed out; re-trigger after reload failed: ${bad2}` };
  const second = await poll(d, id, timeoutMs);
  if (second !== undefined) return { state: "ok", id, ms: ms(), result: second, recovered: true };
  return { state: "timeout", id, ms: ms(), recovered: true, reason: "no result even after one reload/arm recovery" };
}

export type BridgeStatus = {
  state: "healthy" | "degraded" | "unknown";
  reasons: string[];
  mirror?: { tick?: number; vm?: string; tick_ms?: number; tick_ms_max?: number; age_ms?: number; agents?: number };
  blocks?: number;
  backlog?: number;
  recentKills?: string[];
};

const STALE_MS = 5000; // PROTOCOL.md §4: tick stalled >5s ⇒ recover

/** Bridge health snapshot. Three-state: unknown when we cannot observe; degraded when observed but unhealthy. Never throws. */
export async function ternStatus(d: TernDeps = defaultDeps(), logPath: string | undefined = defaultLogPath()): Promise<BridgeStatus> {
  const reasons: string[] = [];
  const out: BridgeStatus = { state: "healthy", reasons };
  // mirror (agents.json)
  const af = path.join(d.ctlDir, "agents.json");
  try {
    const j = JSON.parse(readFileSync(af, "utf8")) as { tick?: number; vm?: string; tick_ms?: number; tick_ms_max?: number; agents?: unknown[] };
    const age = d.now() - statSync(af).mtimeMs;
    out.mirror = { tick: j.tick, vm: j.vm, tick_ms: j.tick_ms, tick_ms_max: j.tick_ms_max, age_ms: Math.round(age), agents: Array.isArray(j.agents) ? j.agents.length : undefined };
    if (age > STALE_MS) reasons.push(`mirror stale: agents.json ${Math.round(age / 1000)}s old (>5s)`);
    if (typeof j.tick_ms_max === "number" && j.tick_ms_max > 50) reasons.push(`mirror tick_ms_max ${j.tick_ms_max}ms exceeded the 50ms budget`);
  } catch (e) {
    reasons.push(`agents.json unreadable: ${(e as Error).message}`);
    out.state = "unknown";
  }
  // backlog
  try { out.backlog = readdirSync(path.join(d.ctlDir, "requests")).filter((f) => f.endsWith(".json")).length; }
  catch { /* no requests dir yet = no backlog signal */ }
  if ((out.backlog ?? 0) > 0) reasons.push(`${out.backlog} request(s) waiting in requests/ (drain may be disabled)`);
  // authoritative block list
  if (!d.bin) { reasons.push("tern binary not found (set TERN_BIN)"); out.state = "unknown"; }
  else {
    const r = await d.run(d.bin, ["ls", "--json"], CTL_TIMEOUT_MS);
    const bad = unreachable(r);
    if (bad) { reasons.push(bad); out.state = "unknown"; }
    else {
      try {
        const j = JSON.parse(r.stdout) as { sessions?: Array<{ tabs?: Array<{ blocks?: unknown[] }> }> };
        out.blocks = (j.sessions ?? []).reduce((n, s) => n + (s.tabs ?? []).reduce((m, t) => m + (t.blocks?.length ?? 0), 0), 0);
      } catch { reasons.push("tern ls --json unparseable"); }
    }
  }
  // recent budget kills (optional)
  if (logPath) {
    try {
      const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes(`plugin="${PLUGIN_ID}"`) && l.includes("exceeded its budget"));
      out.recentKills = lines.slice(-3).map((l) => l.slice(0, 200));
    } catch { /* log optional */ }
  }
  if (out.state !== "unknown" && reasons.length > 0) out.state = "degraded";
  return out;
}

function defaultLogPath(): string | undefined {
  const p = path.join(homedir(), "Library", "Logs", "Tern", "tern.log");
  return safeExists(p) ? p : undefined;
}
