import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { scrubbedEnv } from "./spawn.js";
import { parsePs, pidAlive, resolveAgentPid, writePresence, type PresenceResult } from "./swarm/seat-presence.js";

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
 * PLACEMENT MODEL (user Q&A via coordinator, #1034 r2): Tern session = cluster/project; tab = a long-lived SEAT (English role name);
 * block = a short-lived WORKER. `start` is the front door for visible work (#1035: Tern only shows top-level blocks):
 *   - default how="split": the worker opens BESIDE the caller's own seat pane (args.near, else TERN_PANE) — `cx.agents:start` only
 *     places relative to focus, so we start it, then `tern move <new> right-of <near>`;
 *   - how="tab": a new tab in the SAME session (fan-out of more than ~4 workers) — `tern move <new> new-tab`;
 *   - args.session: NOT supported yet (the CLI has no move-to-session) ⇒ rejected with a reason, never a silently-new session.
 * Worker title = "<role> · <task>" (rename via `tern rename <pane> <title>`); no session ids in titles (user rule). The tab keeps its
 * seat name when the worker block closes. Returns null when the title is acceptable, else the reason. Pure.
 */
const SID_LIKE = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|\b[0-9a-f]{8}\b/i;
export function checkRoleTitle(title: unknown): string | null {
  if (title === undefined) return null;
  if (typeof title !== "string" || title.trim() === "") return "title must be a non-empty string";
  if (title.length > 60) return "title too long (max 60)";
  if (!/^[A-Za-z][A-Za-z0-9 ._·:-]*$/.test(title)) return "title must be English: \"<role> · <task>\" (letters, digits, space . _ - · :)";
  if (SID_LIKE.test(title)) return "title must not contain a session id (use a fixed role name)";
  return null;
}

export type Run = { code: number; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };

export type TernDeps = {
  bin: string | undefined;
  ctlDir: string;
  bridgeDir: string; // the installed plugin dir (arm-schedule.sh lives there)
  presenceHome: string; // where presence/<sid>.pid is written (the OS home, like the bus)
  alive: (pid: number) => boolean;
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
  // The bridge (window.luau) ALWAYS writes $HOME/.agenthop/tern-panes via tern.getenv("HOME") — it never sees AH_HOME. So the control
  // dir defaults to the OS home, NOT AH_HOME: a caller with AH_HOME pointing elsewhere would otherwise read an empty dir, judge the
  // live bridge stale and reload SOMEONE ELSE's production bridge (live incident, coordinator #1034 trial). AGENTHOP_TERN_PANES still
  // overrides explicitly (tests, alternate installs).
  const socket = env.TERN_PANE_SOCKET ?? path.join(homedir(), "Library", "Application Support", "Tern", "daemon.sock");
  return {
    bin: ternBin(env),
    ctlDir: env.AGENTHOP_TERN_PANES ?? path.join(homedir(), ".agenthop", "tern-panes"),
    bridgeDir: env.AGENTHOP_BRIDGE_DIR ?? path.join(homedir(), "Library", "Application Support", "Tern", "plugins", PLUGIN_ID),
    presenceHome: env.AH_HOME || homedir(),
    alive: pidAlive,
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
  | { state: "ok"; id: string; ms: number; result: unknown; recovered?: boolean; republished?: boolean; presence?: PresenceResult | { state: "pending"; reason: string }; pane?: number; placed?: string; placeError?: string; renamed?: string; renameError?: string }
  | { state: "UNKNOWN"; hold: true; id: string; ms: number; reason: string }
  | { state: "timeout"; id: string; ms: number; recovered: boolean; reason: string }
  | { state: "unknown"; id?: string; ms: number; reason: string };

const CTL_TIMEOUT_MS = 5000;
const STALE_MS = 5000; // PROTOCOL.md §4: tick stalled >5s ⇒ recover

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

export type Mirror = { tick: number; vm: string; agents: unknown[]; tick_ms?: number; tick_ms_max?: number };
/** A LEGAL mirror (MTB-SOURCE-SHAPE): decodable JSON is not enough — tick:number, vm:string, agents:array. Anything else = null. Pure. */
export function asMirror(v: unknown): Mirror | null {
  const j = v as Record<string, unknown> | null;
  if (!j || typeof j !== "object" || !Number.isFinite(j.tick) || typeof j.vm !== "string" || !Array.isArray(j.agents)) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return { tick: j.tick as number, vm: j.vm, agents: j.agents, tick_ms: num(j.tick_ms), tick_ms_max: num(j.tick_ms_max) };
}
/** Total block count from `tern ls --json`, or null when the inventory is not the expected shape (sessions[].tabs[].blocks[]). Pure. */
export function blockCount(v: unknown): number | null {
  const sessions = (v as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return null;
  let n = 0;
  for (const s of sessions) {
    const tabs = (s as { tabs?: unknown } | null)?.tabs;
    if (!Array.isArray(tabs)) return null;
    for (const t of tabs) {
      const blocks = (t as { blocks?: unknown } | null)?.blocks;
      if (!Array.isArray(blocks)) return null;
      n += blocks.length;
    }
  }
  return n;
}

/** agents.json as a legal mirror, or null when absent/torn/unparseable/malformed. */
export function readMirror(ctlDir: string): Mirror | null {
  try { return asMirror(JSON.parse(readFileSync(path.join(ctlDir, "agents.json"), "utf8"))); } catch { return null; }
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
  const arm = await armSequence(d);
  return arm.ok ? undefined : `arm failed: ${arm.detail}`;
}

const ARM_CANCEL_MAX = 64;
type ArmStatus = { step: string | null; count: number | null; id: number | null; error: string | null } | null;
function readSentinel(ctlDir: string): ArmStatus {
  try {
    const v = JSON.parse(readFileSync(path.join(ctlDir, "sentinel.json"), "utf8")) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const int = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);
    return { step: typeof v.step === "string" ? v.step : null, count: int(v.count), id: int(v.id), error: typeof v.error === "string" ? v.error : null };
  } catch { return null; }
}
/** Wait (bounded) for sentinel.json to say one of `steps`; null = no such answer in time. */
async function awaitSentinel(d: TernDeps, steps: string[]): Promise<ArmStatus> {
  const deadline = d.now() + 2000;
  for (;;) {
    const s = readSentinel(d.ctlDir);
    if (s !== null && s.step !== null && steps.includes(s.step)) return s;
    if (d.now() >= deadline) return s;
    await d.sleep(100);
  }
}

/**
 * MTB-ARM-CONTRACT: the bridge r12 arming protocol — the SAME sequence #1033's sweep runs (armSequence there). Zero kv, zero args.
 *   arm-scan (sentinel.json cleared first, so only a fresh write answers; integer count required — ctl ok proves nothing)
 *   count>1 ⇒ loop arm-cancel-next: require step "cancelled-one" with count strictly lower; cancel-failed / anything else ⇒ stop
 *            then a fresh arm-scan must say count==1
 *   count==0 ⇒ arm-schedule.sh (exit 0 = scheduled + verified by its own re-scan) ⇒ our own fresh arm-scan must say count==1
 *   count==1 ⇒ armed
 * Any stop ⇒ ok:false naming the step; nothing after it runs (the caller then does NOT drain).
 */
export async function armSequence(d: TernDeps): Promise<{ ok: boolean; detail: string }> {
  const stop = (where: string, why: string) => ({ ok: false, detail: `${where}: ${why}` });
  const action = async (a: string) => unreachable(await d.run(d.bin!, ["ctl", "plugins", "run", `plugin.${PLUGIN_ID}.${a}`], CTL_TIMEOUT_MS));
  const scan = async (): Promise<number | string> => {
    try { unlinkSync(path.join(d.ctlDir, "sentinel.json")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return `cannot clear the previous sentinel.json (${(e as Error).message})`; }
    const bad = await action("arm-scan");
    if (bad) return bad;
    const s = await awaitSentinel(d, ["scanned", "scan-failed"]);
    if (s === null || s.step !== "scanned" || s.count === null) return `no fresh scan (step=${s?.step ?? "none"}${s?.error ? ` error=${s.error}` : ""})`;
    return s.count;
  };
  let count = await scan();
  if (typeof count === "string") return stop("arm-scan", count);
  let cancels = 0;
  while (count > 1) {
    if (cancels >= ARM_CANCEL_MAX) return stop("arm-cancel-next", `still ${count} patrols after ${cancels} cancels`);
    const bad = await action("arm-cancel-next");
    if (bad) return stop("arm-cancel-next", bad);
    const s = await awaitSentinel(d, ["cancelled-one", "cancel-failed", "cancel-unknown", "cancel-idle"]);
    if (s === null) return stop("arm-cancel-next", "UNKNOWN: sentinel.json unreadable");
    if (s.step === "cancel-failed") return stop("arm-cancel-next", `cancel-failed id ${s.id} (obligation kept)`);
    if (s.step !== "cancelled-one") return stop("arm-cancel-next", `UNKNOWN: step=${s.step}${s.error ? ` error=${s.error}` : ""}`);
    if (s.count === null || s.count >= count) return stop("arm-cancel-next", `no progress (count ${count} -> ${s.count})`);
    count = s.count;
    cancels += 1;
  }
  if (count === 0) {
    const r = await d.run("bash", [path.join(d.bridgeDir, "arm-schedule.sh")], 15000);
    if (r.code !== 0 || r.timedOut || r.spawnError) return stop("arm-schedule.sh", `exit ${r.code}${r.timedOut ? " (timed out)" : ""}: ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
  } else if (cancels === 0) return { ok: true, detail: "already 1 patrol" };
  const v = await scan();
  if (typeof v === "string") return stop("arm-scan(verify)", v);
  if (v !== 1) return stop("arm-scan(verify)", `count ${v} (want 1)`);
  return { ok: true, detail: cancels > 0 ? `cancelled ${cancels} extra, 1 patrol` : "scheduled, verified 1 patrol" };
}


export type Placement = { how: "split" | "tab"; near?: string };

/** Resolve where a started worker goes (placement model above). Pure. */
export function placementFor(args: Record<string, unknown>, ternPane: string | undefined): Placement | { error: string } {
  if (args.session !== undefined) return { error: "args.session is not supported yet (no move-to-session in the Tern CLI); start in this session" };
  const how = args.how === undefined ? "split" : args.how;
  if (how !== "split" && how !== "tab") return { error: `how must be "split" (default, beside your seat) or "tab" (new tab, same session)` };
  if (how === "tab") return { how };
  const near = args.near !== undefined ? String(args.near) : ternPane;
  return near ? { how, near } : { how }; // no caller pane known ⇒ leave it where start put it (beside focus)
}

/** After a successful start: place the worker (move beside the caller's seat, or into a new tab), then name it. Best-effort — the start
 *  already happened, so a move/rename failure is REPORTED alongside the ok result, never turned into an error or a retry of the start. */
async function nameStarted(d: TernDeps, op: string, result: unknown, title: string | undefined, place: Placement | undefined):
  Promise<{ pane?: number; placed?: string; placeError?: string; renamed?: string; renameError?: string }> {
  if (op !== "start") return {};
  const pane = (result as { pane?: unknown } | null)?.pane;
  if (typeof pane !== "number") return {};
  const out: { pane: number; placed?: string; placeError?: string; renamed?: string; renameError?: string } = { pane };
  if (place) {
    const argv = place.how === "tab" ? ["move", String(pane), "new-tab"] : place.near && place.near !== String(pane) ? ["move", String(pane), "right-of", place.near] : null;
    if (argv) {
      const bad = unreachable(await d.run(d.bin!, argv, CTL_TIMEOUT_MS));
      if (bad) out.placeError = bad; else out.placed = argv.slice(2).join(" ");
    }
  }
  if (title) {
    const bad = unreachable(await d.run(d.bin!, ["rename", String(pane), title], CTL_TIMEOUT_MS));
    if (bad) out.renameError = bad; else out.renamed = title;
  }
  return out;
}

/** The sid a started ACP block resumes, read from its own `command` (`tern acp <claude|codex> --resume <sid> …`). `tern acp` has no
 *  --session-id, and a fresh `tern acp claude` carries no sid at all, so a start without --resume has no sid to write. Pure. */
export function resumedSeat(command: unknown): { sid: string; tool: "claude" | "codex" } | null {
  if (typeof command !== "string") return null;
  const m = /(?:^|\s)(?:\S*\/)?tern\s+acp\s+(claude|codex)\b.*?\s--resume(?:=|\s+)([0-9A-Za-z-]{8,128})(?:\s|$)/.exec(command);
  return m ? { tool: m[1] as "claude" | "codex", sid: m[2]! } : null;
}

/** #1053: after an ACP `start`, write presence/<sid>.pid for the new seat (the SessionStart hook never fires under ACP). Best-effort
 *  and REPORTED: the start already happened, so a presence failure never becomes an error or a retry. The agent process appears a
 *  little after the block, so the resolve is retried for a few seconds. */
async function startedPresence(d: TernDeps, pane: number, args: Record<string, unknown>): Promise<PresenceResult | { state: "pending"; reason: string }> {
  const seat = resumedSeat(args.command);
  if (!seat) return { state: "pending", reason: "no sid known at start (tern acp has no --session-id; pass command \"tern acp <tool> --resume <sid>\" to bind presence now)" };
  const deadline = d.now() + 8000;
  for (;;) {
    const pr = await d.run(d.bin!, ["process", String(pane), "--json"], CTL_TIMEOUT_MS);
    let root: unknown;
    try { root = (JSON.parse(pr.stdout) as { child?: { pid?: unknown } }).child?.pid; } catch { /* retry */ }
    if (Number.isSafeInteger(root)) {
      const ps = await d.run("ps", ["axo", "pid=,ppid=,command="], CTL_TIMEOUT_MS);
      const pid = ps.code === 0 ? resolveAgentPid(root as number, seat.sid, seat.tool, parsePs(ps.stdout)) : null;
      if (pid !== null) return writePresence(d.presenceHome, seat.sid, pid, d.alive);
    }
    if (d.now() >= deadline) return { state: "pending", reason: `no unique ${seat.tool} agent for ${seat.sid} under block ${pane} yet` };
    await d.sleep(500);
  }
}

/** "stale" iff agents.json is readable and older than STALE_MS; "fresh" if readable and newer; "unknown" if unreadable. Pure-ish. */
export function staleness(d: TernDeps): "stale" | "fresh" | "unknown" {
  try {
    const f = path.join(d.ctlDir, "agents.json");
    if (readMirror(d.ctlDir) === null) return "unknown"; // a malformed mirror is no evidence of anything
    return d.now() - statSync(f).mtimeMs > STALE_MS ? "stale" : "fresh";
  } catch { return "unknown"; }
}

/** One bridge call: publish → trigger → poll, with PROTOCOL §3.3 timeout semantics. Never throws. */
export async function ternCall(op: string, args: Record<string, unknown> = {}, timeoutMs = 2000, d: TernDeps = defaultDeps()): Promise<CallResult> {
  const t0 = d.now();
  const ms = () => d.now() - t0;
  if (!(TERN_OPS as readonly string[]).includes(op)) return { state: "unknown", ms: ms(), reason: `unsupported op "${op}" (allowed: ${TERN_OPS.join(", ")})` };
  if (!d.bin) return { state: "unknown", ms: ms(), reason: "tern binary not found (set TERN_BIN)" }; // zero actions taken
  // MTB-OP-AUTHORITY: the top-level op is the ONLY op. An args.op would be spread into the wire body after validation and
  // classification, so a "list" could publish a "stop" while being recovered as read-only — rejected before any action.
  if (Object.prototype.hasOwnProperty.call(args, "op")) return { state: "unknown", ms: ms(), reason: "args.op is reserved: pass the op only as the top-level op" };
  let title: string | undefined;
  let place: Placement | undefined;
  if (op === "start") {
    const bad = checkRoleTitle(args.title);
    if (bad) return { state: "unknown", ms: ms(), reason: `start: ${bad}` }; // rejected before any publish: zero actions
    title = args.title as string | undefined;
    const p = placementFor(args, process.env.TERN_PANE);
    if ("error" in p) return { state: "unknown", ms: ms(), reason: `start: ${p.error}` };
    place = p;
  }
  const id = d.newId();
  // `readonly`/`title`/`near`/`session` are caller-side; the bridge never sees them. The bridge always gets how="split" (start beside
  // focus); the final placement is done with `tern move` once the pane is known (placementFor / nameStarted).
  const { readonly: _ro, title: _t, near: _n, session: _s, how: _h, ...rest } = args;
  const wire = op === "start" ? { ...rest, how: "split" } : rest;
  const body = { ...wire, op }; // op last: nothing in args can replace it
  try { publishRequest(d.ctlDir, id, body); }
  catch (e) { return { state: "unknown", id, ms: ms(), reason: `publish failed: ${(e as Error).message}` }; }

  const bad = await trigger(d, op);
  if (bad) {
    // We could not reach Tern. The request sits published; for a non-idempotent op that is still an UNKNOWN obligation.
    return opClass(op, args) === "non-idempotent"
      ? { state: "UNKNOWN", hold: true, id, ms: ms(), reason: `trigger did not reach the bridge: ${bad}` }
      : { state: "unknown", id, ms: ms(), reason: bad };
  }
  const first = await poll(d, id, timeoutMs);
  if (first !== undefined) {
    const named = await nameStarted(d, op, first, title, place);
    return { state: "ok", id, ms: ms(), result: first, ...named, ...(op === "start" && named.pane !== undefined ? { presence: await startedPresence(d, named.pane, args) } : {}) };
  }

  if (opClass(op, args) === "non-idempotent") {
    return { state: "UNKNOWN", hold: true, id, ms: ms(), reason: "no result in time; the op may have run — HOLD, do not re-send (PROTOCOL.md §3.3)" };
  }
  // FC-2 GATE before any reload: only a mirror we can READ and that is STALE (>5s) proves the bridge is stuck. An unreadable / absent
  // agents.json is UNKNOWN — maybe a wrong control dir, maybe a fresh install — never grounds to reload a live bridge.
  const gate = staleness(d);
  if (gate !== "stale") {
    return { state: "unknown", id, ms: ms(), reason: gate === "unknown"
      ? "timed out; agents.json unreadable here (wrong control dir?) — UNKNOWN, NOT reloading"
      : "timed out but the mirror is fresh — drain may be disabled; not reloading on this evidence (check agenthop_tern_status)" };
  }
  // Read-only + proven stale: ONE recovery, then re-trigger the SAME published request and wait again (still unconsumed ⇒ no duplicate).
  const rec = await recover(d);
  if (rec) return { state: "unknown", id, ms: ms(), reason: `timed out; recovery failed: ${rec}` };
  // MTB-READONLY-REPLAY: the bridge claims by REMOVING the request before running it, so a read-only request that was claimed and
  // then lost its answer (hook killed mid-op, result write failed) is gone from requests/. Read-only ⇒ safe to publish it again
  // under the SAME id; a still-unclaimed one is just re-triggered.
  let republished = false;
  if (!existsSync(path.join(d.ctlDir, "requests", `${id}.json`)) && !existsSync(path.join(d.ctlDir, "results", `${id}.json`))) {
    try { publishRequest(d.ctlDir, id, body); republished = true; }
    catch (e) { return { state: "unknown", id, ms: ms(), reason: `timed out; re-publish after recovery failed: ${(e as Error).message}` }; }
  }
  const bad2 = await trigger(d, op);
  if (bad2) return { state: "unknown", id, ms: ms(), reason: `timed out; re-trigger after reload failed: ${bad2}` };
  const second = await poll(d, id, timeoutMs);
  if (second !== undefined) return { state: "ok", id, ms: ms(), result: second, recovered: true, ...(republished ? { republished } : {}) };
  return { state: "timeout", id, ms: ms(), recovered: true, reason: `no result even after one reload/arm recovery${republished ? " (the claimed request was re-published)" : ""}` };
}

export type BridgeStatus = {
  state: "healthy" | "degraded" | "unknown";
  reasons: string[];
  mirror?: { tick?: number; vm?: string; tick_ms?: number; tick_ms_max?: number; age_ms?: number; agents?: number };
  blocks?: number;
  backlog?: number;
  recentKills?: string[];
};


/** Bridge health snapshot. Three-state: unknown when we cannot observe; degraded when observed but unhealthy. Never throws. */
export async function ternStatus(d: TernDeps = defaultDeps(), logPath: string | undefined = defaultLogPath()): Promise<BridgeStatus> {
  const reasons: string[] = [];
  const out: BridgeStatus = { state: "healthy", reasons };
  // mirror (agents.json)
  const af = path.join(d.ctlDir, "agents.json");
  try {
    const j = asMirror(JSON.parse(readFileSync(af, "utf8")));
    if (j === null) throw new Error("not a legal mirror (want tick:number, vm:string, agents:array)");
    const age = d.now() - statSync(af).mtimeMs;
    out.mirror = { tick: j.tick, vm: j.vm, tick_ms: j.tick_ms, tick_ms_max: j.tick_ms_max, age_ms: Math.round(age), agents: j.agents.length };
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
      let n: number | null = null;
      try { n = blockCount(JSON.parse(r.stdout)); } catch { /* unparseable ⇒ null */ }
      if (n === null) { reasons.push("tern ls --json is not a sessions[].tabs[].blocks[] inventory"); out.state = "unknown"; }
      else out.blocks = n;
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
