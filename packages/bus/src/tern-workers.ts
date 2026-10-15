import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { acquireHolderLock, releaseHolderLock, type LockSite } from "./swarm/holder-lock.js";
import { homedir } from "node:os";
import path from "node:path";
import { isValidSessionId } from "./send-fallback.js";
import { realRun, ternBin, unreachable, type Run } from "./tern-bridge.js";
import { scrubbedEnv } from "./spawn.js";
import { updateSeatShell } from "./swarm/seat-shell-record.js";

/**
 * kind="tui" WORKERS (#1034 r2): a short-lived TUI agent that lives in its OWN herdr session, shown as a Tern split block beside the
 * caller's seat. herdr gives the TUI a real agent state (agent_status working/idle) that a bare Tern block cannot; Tern gives it the
 * visible place. Honest boundary: such a block is invisible to cx.agents — no ask / wait / approve through the bridge; its subagents
 * are visual only; the worker reports back through the durable inbox.
 *
 * Lifecycle (all argv fixed, no shell; every step's outcome recorded):
 *   start  cap + memory gates → `herdr --session N server` (detached) → wait for the socket → `workspace create --cwd` → root pane →
 *          `agent start N --kind claude --pane <root> -- --permission-mode bypassPermissions <prompt>` → `tern split <near> right --json
 *          -- herdr --session N` → record {state:"live"}. A step that fails after the server started is UNDONE in reverse (server stop
 *          + session delete) and reported; nothing is left running unrecorded.
 *   stop   state "stopping" written FIRST → `herdr --session N server stop` → wait for the socket to disappear → `tern close <pane>` →
 *          `herdr session delete N`. A failed step is recorded and the rest STILL run; the end state is "stopped" (all ok) or
 *          "stopped" with partial:[…] — never left "live".
 *   status per worker `herdr --session N agent list` agent_status; orphans both ways (a recorded live worker whose herdr session or
 *          Tern block is gone; a herdr session named like ours that no seat records). Orphans are REPORTED, never deleted.
 *
 * Registry: ~/.agenthop/swarm/seat-shell/<sid>.json gains `workers` (schema pinned by the coordinator, shared with #1033):
 *   workers: [{ name, herdr_session (= name), pane: number (Tern block id), kind: "tui", started_at: number (epoch ms),
 *               stopped_at: number | null, state: "live" | "stopping" | "stopped" | "orphan" }]
 * Written O_EXCL temp + rename; every other key in the seat file is preserved. The seat-shell writer (scripts/seat-shell.ts,
 * feat/inbox-wake-tern) owns `shell`/`pid`; this module owns only `workers`.
 */

export type WorkerState = "starting" | "live" | "stopping" | "stopped" | "orphan";
export type Worker = { name: string; herdr_session: string; pane: number; kind: "tui"; started_at: number; stopped_at: number | null; state: WorkerState; server_pid?: number };

export const WORKER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const STATES: readonly string[] = ["starting", "live", "stopping", "stopped", "orphan"];

/** Schema check for one record (the pinned shape). Pure. */
export function isWorker(v: unknown): v is Worker {
  const w = v as Record<string, unknown> | null;
  return !!w && typeof w === "object"
    && typeof w.name === "string" && WORKER_NAME.test(w.name) && w.herdr_session === w.name
    // pane is the Tern block id; 0 = no block was ever placed (a placeholder, or a start that failed before the split) — never "live"
    && Number.isSafeInteger(w.pane) && ((w.pane as number) > 0 || (w.pane === 0 && w.state !== "live")) && w.kind === "tui"
    && Number.isSafeInteger(w.started_at) && (w.stopped_at === null || Number.isSafeInteger(w.stopped_at))
    && typeof w.state === "string" && STATES.includes(w.state)
    && (w.server_pid === undefined || (Number.isSafeInteger(w.server_pid) && (w.server_pid as number) > 0)); // additive, optional
}

/** `<role short>-<task short>`: lower-case, [a-z0-9-], ≤40 chars. null when nothing usable is left. Pure. */
export function workerName(role: string, task: string): string | null {
  const slug = (x: string, n: number) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "");
  const name = [slug(role, 16), slug(task, 22)].filter(Boolean).join("-");
  return WORKER_NAME.test(name) ? name : null;
}

// ---- registry --------------------------------------------------------------------------------------------------------------------

export { seatShellPath as seatFile } from "./swarm/seat-shell-record.js";
import { seatShellPath as seatFile } from "./swarm/seat-shell-record.js";
export type SeatRead = { kind: "ok"; seat: Record<string, unknown>; workers: Worker[] } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/** Three-state read (FC-2): ENOENT ⇒ absent; unreadable / malformed / a bad worker record ⇒ unreadable (never "no workers"). */
export function readSeat(home: string, sid: string): SeatRead {
  let raw: string;
  try { raw = readFileSync(seatFile(home, sid), "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: (e as Error).message }; }
  let seat: unknown;
  try { seat = JSON.parse(raw); } catch { return { kind: "unreadable", reason: "seat file is not JSON" }; }
  if (!seat || typeof seat !== "object" || Array.isArray(seat)) return { kind: "unreadable", reason: "seat file is not an object" };
  const ws = (seat as { workers?: unknown }).workers;
  if (ws === undefined) return { kind: "ok", seat: seat as Record<string, unknown>, workers: [] };
  if (!Array.isArray(ws) || !ws.every(isWorker)) return { kind: "unreadable", reason: "workers[] does not match the pinned schema" };
  return { kind: "ok", seat: seat as Record<string, unknown>, workers: ws };
}

/** Replace the seat's workers[] (other keys preserved) through the shared locked write path (updateSeatShell: lock → re-read →
 *  rev+1 → O_EXCL temp + rename). Throws on a bad record (non-number pane etc.), an unreadable seat file, or a busy/conflicting
 *  lock — never overwrites what it could not read, never renames a stale snapshot over another writer's update. */
export function writeWorkers(home: string, sid: string, workers: Worker[]): void {
  for (const w of workers) if (!isWorker(w)) throw new Error(`refusing to write a worker that breaks the schema: ${JSON.stringify(w)}`);
  mutateWorkers(home, sid, () => workers);
}

/** Read-modify-write of workers[] UNDER the seat lock: `fn` sees the workers as they are under the lock (never a stale copy). */
function mutateWorkers(home: string, sid: string, fn: (cur: Worker[]) => Worker[]): void {
  const r = updateSeatShell(home, sid, (rec) => {
    const ws = rec.workers;
    if (ws !== undefined && (!Array.isArray(ws) || !ws.every(isWorker))) throw new Error("workers[] does not match the pinned schema");
    const next = fn((ws as Worker[] | undefined) ?? []);
    for (const w of next) if (!isWorker(w)) throw new Error(`refusing to write a worker that breaks the schema: ${JSON.stringify(w)}`);
    return { ...(Object.keys(rec).length === 0 ? { sid } : rec), workers: next };
  });
  if (r.state !== "ok") throw new Error(`seat-shell ${r.state}: ${r.reason}`);
}

/** One instance = (herdr_session, pane, started_at). Pure. */
export function sameInstance(a: Worker, b: Worker): boolean {
  return a.herdr_session === b.herdr_session && a.pane === b.pane && a.started_at === b.started_at;
}
/** Change state/stopped_at of exactly the matching instance, under the lock; every other field and entry untouched, no reorder.
 *  The same shape the #1033 orphan sweep uses to mark an instance "orphan". Throws when the instance is not recorded. */
export function setWorkerState(home: string, sid: string, inst: Worker, state: WorkerState, stopped_at: number | null): void {
  mutateWorkers(home, sid, (cur) => {
    if (!cur.some((x) => sameInstance(x, inst))) throw new Error(`instance ${inst.herdr_session}:${inst.pane}:${inst.started_at} not recorded`);
    return cur.map((x) => (sameInstance(x, inst) ? { ...x, state, stopped_at } : x));
  });
}

function upsert(home: string, sid: string, w: Worker): void {
  mutateWorkers(home, sid, (cur) => [...cur.filter((x) => x.name !== w.name), w]);
}

/** Every seat's workers, for the global cap and orphan detection. Unreadable seat files are listed by name, never skipped silently. */
export function allWorkers(home: string, listDir: (d: string) => string[]): { workers: Array<Worker & { seat: string }>; unreadable: string[] } {
  const dir = path.join(home, ".agenthop", "swarm", "seat-shell");
  let names: string[] = [];
  try { names = listDir(dir).filter((n) => n.endsWith(".json")); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { workers: [], unreadable: [dir] };
  }
  const out: Array<Worker & { seat: string }> = [];
  const unreadable: string[] = [];
  for (const n of names) {
    const sid = n.slice(0, -5);
    let r: SeatRead;
    try { r = readSeat(home, sid); } catch { unreadable.push(n); continue; }
    if (r.kind === "unreadable") unreadable.push(n);
    else if (r.kind === "ok") for (const w of r.workers) out.push({ ...w, seat: sid });
  }
  return { workers: out, unreadable };
}

// ---- gates -----------------------------------------------------------------------------------------------------------------------

export const DEFAULT_SEAT_CAP = 2;
export const DEFAULT_GLOBAL_CAP = 6;
export const MIN_FREE_BYTES = 1.5 * 1024 ** 3;

const active = (w: Worker) => w.state === "starting" || w.state === "live" || w.state === "stopping";

// MTB-SV-CAP + CLEANUP: the cap is checked and the slot TAKEN in one transaction, and the slot IS the registry entry. The global cap
// spans every seat file, so the decision runs under a machine-wide holder-lock (dead-pid reclaim only): count active workers
// (starting / live / stopping) across all seats → decide → write this start's placeholder {state:"starting", pane:0} into the
// caller's workers[] (updateSeatShell). The placeholder exists BEFORE any herdr / Tern resource can exist, so a crash or a failed
// cleanup can never leave a live resource that the registry does not know about; it keeps occupying capacity until a cleanup is
// PROVEN (then "stopped") — an unproven one stays "stopping".
const registrySite = (home: string): LockSite => {
  const dir = path.join(home, ".agenthop", "swarm", "seat-shell");
  return { lockDir: path.join(dir, ".workers.lockd"), intentDir: dir, intentPrefix: ".workers.lockd.hold." };
};
export function reserveSlot(home: string, seat: string, placeholder: Worker, d: { listDir: (d: string) => string[]; env: NodeJS.ProcessEnv }):
  { reason: "cap" | "invalid"; detail: string } | null {
  const site = registrySite(home);
  try { mkdirSync(site.intentDir, { recursive: true, mode: 0o700 }); } catch (e) { return { reason: "cap", detail: `cannot prepare the worker registry: ${(e as Error).message}` }; }
  const deadline = Date.now() + 5000;
  let token: string | null = null;
  while (!(token = acquireHolderLock(site))) {
    if (Date.now() >= deadline) return { reason: "cap", detail: "worker registry busy (another start holds the lock); retry" };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    const all = allWorkers(home, d.listDir);
    if (all.workers.some((w) => w.name === placeholder.name && active(w))) return { reason: "invalid", detail: `worker ${placeholder.name} is already starting/live` };
    const cap = capGate(seat, all, d.env);
    if (!cap.ok) return { reason: "cap", detail: cap.detail };
    upsert(home, seat, placeholder);
    return null;
  } catch (e) {
    return { reason: "cap", detail: `could not record the placeholder: ${(e as Error).message}` };
  } finally { releaseHolderLock(site, token); }
}

/** Cap gate. SWARM_WORKER_CAP = per seat (default 2), SWARM_WORKER_CAP_GLOBAL = whole machine (default 6). An unreadable seat file
 *  makes the global count UNKNOWN ⇒ refused (we cannot prove we are under the cap). Pure. */
export function capGate(seatSid: string, all: { workers: Array<Worker & { seat: string }>; unreadable: string[] }, env: NodeJS.ProcessEnv):
  { ok: true } | { ok: false; reason: "cap"; detail: string } {
  const num = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);
  const seatCap = num(env.SWARM_WORKER_CAP, DEFAULT_SEAT_CAP);
  const globalCap = num(env.SWARM_WORKER_CAP_GLOBAL, DEFAULT_GLOBAL_CAP);
  if (all.unreadable.length > 0) return { ok: false, reason: "cap", detail: `worker count unknown (unreadable: ${all.unreadable.join(", ")})` };
  const mine = all.workers.filter((w) => w.seat === seatSid && active(w)).length;
  const total = all.workers.filter(active).length;
  if (mine >= seatCap) return { ok: false, reason: "cap", detail: `seat has ${mine} live worker(s), cap ${seatCap} (SWARM_WORKER_CAP)` };
  if (total >= globalCap) return { ok: false, reason: "cap", detail: `machine has ${total} live worker(s), cap ${globalCap} (SWARM_WORKER_CAP_GLOBAL)` };
  return { ok: true };
}

/** Free memory from `vm_stat` (free + inactive + speculative pages — what macOS can hand out without swapping). null = unparseable. */
export function freeBytes(vmStat: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)\\.`).exec(vmStat)?.[1]);
  const n = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
  return Number.isFinite(page) && page > 0 && Number.isFinite(n) ? n * page : null;
}

// ---- herdr / tern IO ------------------------------------------------------------------------------------------------------------

export type WorkerDeps = {
  home: string;
  tern: string;
  herdr: string;
  run: (bin: string, args: string[], timeoutMs: number) => Promise<Run>;
  /** spawn a detached daemon with EXTRA env; returns its pid (the instance we created) */
  spawnDetached: (bin: string, args: string[], extraEnv: Record<string, string>) => { ok: boolean; pid?: number; error?: string };
  socketExists: (session: string) => boolean;
  /** pids that hold the session's herdr.sock open (lsof); null = could not observe */
  socketOwners: (session: string) => number[] | null;
  /** SIGTERM one pid (our own server instance) */
  signal: (pid: number) => boolean;
  listDir: (d: string) => string[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
};

/** Real IO. The herdr server is a long-lived daemon, so it is spawned detached (own process group, stdio ignored) — it must outlive
 *  this MCP call. herdr's per-session socket lives at ~/.config/herdr/sessions/<name>/herdr.sock (herdr 0.9.3, probed live). */
export function realWorkerDeps(env: NodeJS.ProcessEnv = process.env): WorkerDeps {
  const socket = env.TERN_PANE_SOCKET ?? path.join(homedir(), "Library", "Application Support", "Tern", "daemon.sock");
  return {
    home: homedir(),
    tern: ternBin(env) ?? "tern",
    herdr: env.HERDR_BIN ?? "herdr",
    run: realRun(socket),
    spawnDetached: (bin, args, extraEnv) => {
      try {
        const c = spawn(bin, args, { detached: true, stdio: "ignore", env: { ...scrubbedEnv(env), ...extraEnv }, cwd: homedir() });
        c.on("error", () => { /* reported through the ownership proof */ });
        c.unref();
        return typeof c.pid === "number" ? { ok: true, pid: c.pid } : { ok: false, error: "spawn returned no pid" };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    socketExists: (name) => existsSync(path.join(homedir(), ".config", "herdr", "sessions", name, "herdr.sock")),
    socketOwners: (name) => {
      const r = spawnSync("lsof", ["-t", path.join(homedir(), ".config", "herdr", "sessions", name, "herdr.sock")], { encoding: "utf8", timeout: 5000 });
      if (r.error) return null;
      if (r.status !== 0 && r.status !== 1) return null; // lsof: 1 = nothing open
      return r.stdout.split("\n").map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
    },
    signal: (pid) => { try { process.kill(pid, "SIGTERM"); return true; } catch { return false; } },
    listDir: (d) => readdirSync(d),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env,
  };
}

const T = 10_000;
const AGENT_START_MS = 30_000; // herdr waits for claude to come up: 7s measured live for a short prompt, >10s seen
const failed = (r: Run) => unreachable(r) ?? (r.code !== 0 ? `exit ${r.code}` : undefined);

async function waitSocket(d: WorkerDeps, name: string, present: boolean, ms: number): Promise<boolean> {
  const deadline = d.now() + ms;
  for (;;) {
    if (d.socketExists(name) === present) return true;
    if (d.now() >= deadline) return false;
    await d.sleep(100);
  }
}

export type StartArgs = { role: string; task: string; prompt: string; cwd: string; parentSid: string; near?: string; mode?: string };

/** #1034 r3: a TUI worker's claude runs at the highest permission by default (user order via coordinator); `mode` lowers it.
 *  The flag goes to the bare claude CLI that herdr starts. Pure. */
export function claudePermissionArgs(mode: string | undefined): string[] | { error: string } {
  if (mode === undefined || mode === "full") return ["--dangerously-skip-permissions"];
  const ok = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
  return ok.includes(mode) ? ["--permission-mode", mode] : { error: `mode must be full or one of ${ok.join("|")}` };
}
export type StartResult =
  | { state: "ok"; pane: number; herdr_session: string }
  | { state: "refused"; reason: "cap" | "memory" | "invalid" | "name-taken"; detail: string }
  | { state: "failed"; step: string; detail: string; undone: string[] };

/** The prompt tail every TUI worker gets: report through the durable inbox (it is invisible to cx.agents), and a subagent bound
 *  (claude has no env/flag for that — prompt text is the only lever). ONE line: herdr 0.9.3 refuses an agent argument containing a
 *  newline ("invalid_agent_argument: cannot be encoded safely for the target shell", probed live), so line breaks become spaces. */
export function workerPrompt(prompt: string, parentSid: string): string {
  const body = `${prompt} --- When you finish (or get blocked), report back to session ${parentSid} through its durable inbox ` +
    `(agenthop_send to that session id, or writeInbox); nothing else reads your screen. Do not start more than 2 subagents.`;
  return body.replace(/[\r\n\u2028\u2029]+/g, " ");
}

export async function startWorker(a: StartArgs, d: WorkerDeps): Promise<StartResult> {
  const name = workerName(a.role, a.task);
  if (!name) return { state: "refused", reason: "invalid", detail: "role/task leave no usable worker name ([a-z0-9-])" };
  const perm = claudePermissionArgs(a.mode);
  if (!Array.isArray(perm)) return { state: "refused", reason: "invalid", detail: perm.error };
  if (!isValidSessionId(a.parentSid)) return { state: "refused", reason: "invalid", detail: "parentSid is not a session id" };
  if (typeof a.prompt !== "string" || a.prompt.trim() === "" || typeof a.cwd !== "string" || !path.isAbsolute(a.cwd)) {
    return { state: "refused", reason: "invalid", detail: "prompt (non-empty) and an absolute cwd are required" };
  }
  const vm = await d.run("vm_stat", [], 5000);
  const free = vm.code === 0 ? freeBytes(vm.stdout) : null;
  if (free === null) return { state: "refused", reason: "memory", detail: "free memory unknown (vm_stat unreadable)" };
  if (free < MIN_FREE_BYTES) return { state: "refused", reason: "memory", detail: `${(free / 1024 ** 3).toFixed(2)} GiB free < 1.5 GiB` };
  // MTB-SV-START-OWN: the herdr session name must be FREE before we touch it — an existing session (running or stopped) is someone
  // else's; refuse and never stop/delete it. Unreadable list ⇒ cannot prove it is free ⇒ refuse.
  const ls = await d.run(d.herdr, ["session", "list", "--json"], T);
  let existing: string[] | null = null;
  try { const j = JSON.parse(ls.stdout) as { sessions?: Array<{ name?: unknown }> }; if (!failed(ls) && Array.isArray(j.sessions)) existing = j.sessions.map((x) => String(x.name)); } catch { /* below */ }
  if (existing === null) return { state: "refused", reason: "invalid", detail: "herdr session list unreadable: cannot prove the worker name is free" };
  if (existing.includes(name)) return { state: "refused", reason: "name-taken", detail: `a herdr session named ${name} already exists; it is not ours, left untouched` };
  const placeholder: Worker = { name, herdr_session: name, pane: 0, kind: "tui", started_at: d.now(), stopped_at: null, state: "starting" };
  const slot = reserveSlot(d.home, a.parentSid, placeholder, d);
  if (slot) return { state: "refused", reason: slot.reason, detail: slot.detail };
  return launch(a, d, placeholder, perm);
}

/** Replace the placeholder instance (herdr_session + started_at, pane 0) with its final pane/state, under the lock. */
function settle(home: string, sid: string, ph: Worker, next: Partial<Worker>): void {
  mutateWorkers(home, sid, (cur) => {
    if (!cur.some((x) => sameInstance(x, ph))) throw new Error(`placeholder ${ph.herdr_session}:${ph.started_at} not recorded`);
    return cur.map((x) => (sameInstance(x, ph) ? { ...x, ...next } : x));
  });
}

async function launch(a: StartArgs, d: WorkerDeps, ph: Worker, perm: string[]): Promise<StartResult> {
  const name = ph.name;
  const undone: string[] = [];
  let pane: number | undefined;
  // MTB-WORKER-OWN: "the name was free" is not ownership — someone may create the same session after our list. Ownership is
  // PROVEN only when the process holding the session's herdr.sock is the server pid WE spawned (a second `herdr --session N server`
  // exits "already running", so if a foreign one won the race, our pid is gone and the socket owner is theirs). Until proven,
  // nothing that touches the session by NAME may run. Cleanup is bound to that instance: SIGTERM our pid (not `server stop`, which
  // addresses whoever owns the name), and `session delete` only once our pid is gone and no one else holds the socket.
  let ownPid: number | undefined;
  let owned = false;
  const undo = async (): Promise<boolean> => {
    let ok = true;
    if (pane !== undefined) { const c = await d.run(d.tern, ["close", String(pane)], T); undone.push(`tern close: ${failed(c) ?? "ok"}`); ok = ok && !failed(c); }
    if (!owned) {
      // never ours (or unproven): zero stop/delete on the name. If our own server process exists, stop only it.
      if (ownPid !== undefined) { undone.push(`signal own pid ${ownPid}: ${d.signal(ownPid) ? "sent" : "not running"}`); }
      undone.push("session NOT owned by this start: left untouched (no server stop, no delete)");
      return false;
    }
    const sent = d.signal(ownPid!);
    undone.push(`stop own server pid ${ownPid}: ${sent ? "sent" : "already gone"}`);
    const gone = await waitSocket(d, name, false, 3000);
    undone.push(`socket gone: ${gone ? "ok" : "still present"}`);
    const owners = d.socketOwners(name);
    if (!gone || owners === null || owners.length > 0) { undone.push("session delete skipped: cannot prove no other instance holds it"); return false; }
    const del = await d.run(d.herdr, ["session", "delete", name], T);
    undone.push(`session delete: ${failed(del) ?? "ok"}`);
    return ok && !failed(del);
  };
  const fail = async (step: string, detail: string): Promise<StartResult> => {
    const proven = await undo();
    try { settle(d.home, a.parentSid, ph, proven ? { state: "stopped", stopped_at: d.now(), ...(pane !== undefined ? { pane } : {}) } : { state: "stopping", ...(pane !== undefined ? { pane } : {}) }); }
    catch (e) { undone.push(`record: ${(e as Error).message}`); }
    if (!proven) undone.push("cleanup NOT proven: the entry stays \"stopping\" and keeps its capacity");
    return { state: "failed", step, detail, undone };
  };

  // SH-PARENT-WIRING (#1057): the authoritative parent sid of THIS call goes into the server's environment, which herdr passes to
  // the panes it creates, so the worker's subagent hook (agenthop hook subagent) can post to the parent inbox (it reads only
  // SWARM_PARENT_SID; the prompt text is not a channel it can read).
  const sp = d.spawnDetached(d.herdr, ["--session", name, "server"], { SWARM_PARENT_SID: a.parentSid });
  if (!sp.ok || sp.pid === undefined) return fail("herdr server", sp.error ?? "spawn failed");
  ownPid = sp.pid;
  if (!(await waitSocket(d, name, true, 5000))) return fail("herdr server", "socket did not appear in 5s");
  const deadline = d.now() + 3000;
  for (;;) {
    const owners = d.socketOwners(name);
    if (owners !== null && owners.length === 1 && owners[0] === ownPid) { owned = true; break; }
    if (owners !== null && owners.length > 0 && !owners.includes(ownPid)) return fail("ownership", `herdr.sock is held by pid ${owners.join(",")}, not by our server ${ownPid}: a foreign instance owns ${name}`);
    if (d.now() >= deadline) return fail("ownership", owners === null ? "socket owner unobservable (lsof)" : `socket owners ${owners.join(",") || "none"}; cannot prove ${ownPid} owns ${name}`);
    await d.sleep(100);
  }
  const ws = await d.run(d.herdr, ["--session", name, "workspace", "create", "--cwd", a.cwd], T);
  let root: string | undefined;
  try { root = (JSON.parse(ws.stdout) as { result?: { root_pane?: { pane_id?: unknown } } }).result?.root_pane?.pane_id as string | undefined; } catch { /* below */ }
  if (failed(ws) || typeof root !== "string") return fail("workspace create", failed(ws) ?? "no root_pane.pane_id in the reply");
  const ag = await d.run(d.herdr, ["--session", name, "agent", "start", name, "--kind", "claude", "--pane", root, "--",
    ...perm, workerPrompt(a.prompt, a.parentSid)], AGENT_START_MS);
  if (failed(ag)) return fail("agent start", failed(ag)!);
  const near = a.near ?? d.env.TERN_PANE;
  if (!near) return fail("tern split", "no caller pane (args.near or TERN_PANE) to place the block beside");
  const sb = await d.run(d.tern, ["split", near, "right", "--json", "--", d.herdr, "--session", name], T);
  let block: unknown;
  try { block = (JSON.parse(sb.stdout) as { block?: unknown }).block; } catch { /* below */ }
  if (failed(sb) || !Number.isSafeInteger(block) || (block as number) <= 0) return fail("tern split", failed(sb) ?? "no numeric block id in the reply");
  pane = block as number;
  try { settle(d.home, a.parentSid, ph, { pane, state: "live", server_pid: ownPid }); }
  catch (e) { return fail("record", (e as Error).message); }
  return { state: "ok", pane, herdr_session: name };
}

export type StopResult = { state: "stopped" | "partial" | "unknown"; name: string; steps: Array<{ step: string; ok: boolean; detail?: string }>; reason?: string };

export async function stopWorker(seatSid: string, name: string, d: WorkerDeps): Promise<StopResult> {
  const steps: StopResult["steps"] = [];
  let seat: SeatRead;
  try { seat = readSeat(d.home, seatSid); } catch (e) { return { state: "unknown", name, steps, reason: (e as Error).message }; }
  if (seat.kind !== "ok") return { state: "unknown", name, steps, reason: seat.kind === "absent" ? "seat has no record" : seat.reason };
  const w = seat.workers.find((x) => x.name === name && active(x));
  if (!w) return { state: "unknown", name, steps, reason: `no live worker ${name} recorded on this seat` };
  return stopWorkerAfterRead(seatSid, w, d);
}

/** The stop proper, for the instance `w` the caller read. Exported so the instance-check gate can be tested deterministically. */
export async function stopWorkerAfterRead(seatSid: string, w: Worker, d: WorkerDeps): Promise<StopResult> {
  const steps: StopResult["steps"] = [];
  const name = w.name;
  // set state/stopped_at on THIS instance only, under the lock, keeping whatever else the entry carries now (never the snapshot
  // read above — another writer, e.g. the #1033 orphan sweep, may have touched it meanwhile)
  const record = (state: WorkerState, stopped_at: number | null) => {
    try { setWorkerState(d.home, seatSid, w, state, stopped_at); return true; }
    catch (e) { steps.push({ step: `record ${state}`, ok: false, detail: (e as Error).message }); return false; }
  };
  // FIRST, and it is also the INSTANCE CHECK (MTB-SV-STOP-INSTANCE): under the lock, the exact instance we read (herdr_session +
  // pane + started_at) must still be recorded. If a newer instance took the name meanwhile, ZERO actions — never stop or delete it.
  if (!record("stopping", null)) return { state: "unknown", name, steps, reason: `instance-mismatch: ${w.herdr_session}:${w.pane}:${w.started_at} is no longer the recorded instance (or the record could not be written); nothing stopped` };
  const step = async (label: string, bin: string, args: string[]) => {
    const r = await d.run(bin, args, T);
    const bad = failed(r);
    steps.push(bad ? { step: label, ok: false, detail: bad } : { step: label, ok: true });
  };
  // MTB-WORKER-OWN: bound to the instance. With a recorded server_pid, stop only THAT process, and only while it is the one holding
  // the session's socket; a different owner (the name was taken over) ⇒ that server is not ours: no signal, no delete.
  let ownerOk = true;
  if (w.server_pid !== undefined) {
    const owners = d.socketOwners(w.herdr_session);
    if (owners === null) { steps.push({ step: "ownership", ok: false, detail: "socket owner unobservable" }); ownerOk = false; }
    else if (owners.length > 0 && !(owners.length === 1 && owners[0] === w.server_pid)) { steps.push({ step: "ownership", ok: false, detail: `socket held by ${owners.join(",")}, not our server ${w.server_pid}` }); ownerOk = false; }
    else if (owners.length === 1) steps.push(d.signal(w.server_pid) ? { step: "stop own server", ok: true } : { step: "stop own server", ok: false, detail: "signal failed" });
  } else {
    await step("herdr server stop", d.herdr, ["--session", w.herdr_session, "server", "stop"]); // legacy record (no pid)
  }
  const gone = ownerOk && await waitSocket(d, w.herdr_session, false, 5000);
  if (ownerOk) steps.push(gone ? { step: "socket gone", ok: true } : { step: "socket gone", ok: false, detail: "socket still present after 5s" });
  if (w.pane > 0) await step("tern close", d.tern, ["close", String(w.pane)]); // pane 0 = no block was ever placed
  if (ownerOk && gone) await step("herdr session delete", d.herdr, ["session", "delete", w.herdr_session]);
  else steps.push({ step: "herdr session delete", ok: false, detail: "skipped: the session is not proven ours / still running" });
  // CLEANUP: "stopped" only when every step is proven; otherwise the entry stays "stopping" (keeps its capacity, re-stoppable)
  const proven = steps.every((s) => s.ok);
  if (proven) record("stopped", d.now());
  return { state: proven ? "stopped" : "partial", name, steps };
}

/** `herdr session list --json` as [{name, running}], or null when ANY part is not that shape. Pure. */
export function herdrSessions(v: unknown): Array<{ name: string; running: boolean }> | null {
  const ss = (v as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(ss)) return null;
  const out: Array<{ name: string; running: boolean }> = [];
  for (const x of ss) {
    const e = x as { name?: unknown; running?: unknown } | null;
    if (!e || typeof e.name !== "string" || typeof e.running !== "boolean") return null;
    out.push({ name: e.name, running: e.running });
  }
  return out;
}
/** Every block id in `tern ls --json`, or null when the inventory is not sessions[].tabs[].blocks[].id:number. Pure. */
export function ternBlockIds(v: unknown): Set<number> | null {
  const ss = (v as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(ss)) return null;
  const ids = new Set<number>();
  for (const s of ss) {
    const tabs = (s as { tabs?: unknown } | null)?.tabs;
    if (!Array.isArray(tabs)) return null;
    for (const t of tabs) {
      const bs = (t as { blocks?: unknown } | null)?.blocks;
      if (!Array.isArray(bs)) return null;
      for (const b of bs) { const id = (b as { id?: unknown } | null)?.id; if (!Number.isSafeInteger(id)) return null; ids.add(id as number); }
    }
  }
  return ids;
}

export type WorkersStatus = {
  live: Array<{ seat: string; name: string; pane: number; agent_status: string }>;
  orphan: Array<{ kind: "recorded-but-gone" | "unrecorded-herdr-session"; seat?: string; name: string; detail: string }>;
  unknown: string[];
};

/** Live TUI workers with their herdr agent_status, plus orphans both ways — REPORTED only, never deleted. */
export async function workersStatus(d: WorkerDeps): Promise<WorkersStatus> {
  const out: WorkersStatus = { live: [], orphan: [], unknown: [] };
  const all = allWorkers(d.home, d.listDir);
  out.unknown.push(...all.unreadable.map((n) => `seat file unreadable: ${n}`));
  const ls = await d.run(d.herdr, ["session", "list", "--json"], T);
  let sessions: Array<{ name: string; running: boolean }> | null = null;
  // MTB-SOURCE: a session list that is not EXACTLY {sessions:[{name:string, running:boolean}, …]} is UNKNOWN as a whole — a
  // `running:"true"` or a `{}` entry must never be folded into "stopped" / "missing" and so never produce an orphan.
  try { if (!failed(ls)) sessions = herdrSessions(JSON.parse(ls.stdout)); } catch { /* below */ }
  if (sessions === null) out.unknown.push("herdr session list unreadable — orphan detection skipped");
  const tl = await d.run(d.tern, ["ls", "--json"], T);
  let blocks: Set<number> | null = null;
  try { if (!failed(tl)) blocks = ternBlockIds(JSON.parse(tl.stdout)); } catch { /* below */ }
  if (blocks === null) out.unknown.push("tern ls --json unreadable — block check skipped");

  for (const w of all.workers.filter(active)) {
    if (w.state === "starting") { out.unknown.push(`${w.name}: starting (placeholder; no live state yet)`); continue; }
    const hs = sessions?.find((s) => s.name === w.herdr_session);
    if (sessions !== null && (!hs || !hs.running)) { out.orphan.push({ kind: "recorded-but-gone", seat: w.seat, name: w.name, detail: hs ? "herdr session stopped" : "herdr session missing" }); continue; }
    if (blocks !== null && w.pane > 0 && !blocks.has(w.pane)) { out.orphan.push({ kind: "recorded-but-gone", seat: w.seat, name: w.name, detail: `Tern block ${w.pane} missing` }); continue; }
    const al = await d.run(d.herdr, ["--session", w.herdr_session, "agent", "list"], T);
    let st = "unknown";
    try { st = String((JSON.parse(al.stdout) as { result?: { agents?: Array<{ agent_status?: unknown }> } }).result?.agents?.[0]?.agent_status ?? "unknown"); } catch { /* unknown */ }
    out.live.push({ seat: w.seat, name: w.name, pane: w.pane, agent_status: failed(al) ? "unknown" : st });
  }
  if (sessions !== null) {
    const recorded = new Set(all.workers.map((w) => w.herdr_session));
    for (const s of sessions) {
      if (s.name === "default" || recorded.has(s.name) || !WORKER_NAME.test(s.name) || !s.name.includes("-")) continue;
      out.orphan.push({ kind: "unrecorded-herdr-session", name: s.name, detail: s.running ? "running, no seat records it" : "stopped, no seat records it" });
    }
  }
  return out;
}
