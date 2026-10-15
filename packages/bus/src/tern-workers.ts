import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

export type WorkerState = "live" | "stopping" | "stopped" | "orphan";
export type Worker = { name: string; herdr_session: string; pane: number; kind: "tui"; started_at: number; stopped_at: number | null; state: WorkerState };

export const WORKER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const STATES: readonly string[] = ["live", "stopping", "stopped", "orphan"];

/** Schema check for one record (the pinned shape). Pure. */
export function isWorker(v: unknown): v is Worker {
  const w = v as Record<string, unknown> | null;
  return !!w && typeof w === "object"
    && typeof w.name === "string" && WORKER_NAME.test(w.name) && w.herdr_session === w.name
    && Number.isSafeInteger(w.pane) && (w.pane as number) > 0 && w.kind === "tui"
    && Number.isSafeInteger(w.started_at) && (w.stopped_at === null || Number.isSafeInteger(w.stopped_at))
    && typeof w.state === "string" && STATES.includes(w.state);
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

const active = (w: Worker) => w.state === "live" || w.state === "stopping";

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
  spawnDetached: (bin: string, args: string[]) => { ok: boolean; error?: string };
  socketExists: (session: string) => boolean;
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
    spawnDetached: (bin, args) => {
      try {
        const c = spawn(bin, args, { detached: true, stdio: "ignore", env: scrubbedEnv(env), cwd: homedir() });
        c.on("error", () => { /* reported through the socket wait */ });
        c.unref();
        return { ok: true };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    socketExists: (name) => existsSync(path.join(homedir(), ".config", "herdr", "sessions", name, "herdr.sock")),
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

export type StartArgs = { role: string; task: string; prompt: string; cwd: string; parentSid: string; near?: string };
export type StartResult =
  | { state: "ok"; pane: number; herdr_session: string }
  | { state: "refused"; reason: "cap" | "memory" | "invalid"; detail: string }
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
  if (!isValidSessionId(a.parentSid)) return { state: "refused", reason: "invalid", detail: "parentSid is not a session id" };
  if (typeof a.prompt !== "string" || a.prompt.trim() === "" || typeof a.cwd !== "string" || !path.isAbsolute(a.cwd)) {
    return { state: "refused", reason: "invalid", detail: "prompt (non-empty) and an absolute cwd are required" };
  }
  const all = allWorkers(d.home, d.listDir);
  if (all.workers.some((w) => w.name === name && active(w))) return { state: "refused", reason: "invalid", detail: `worker ${name} is already live` };
  const cap = capGate(a.parentSid, all, d.env);
  if (!cap.ok) return { state: "refused", reason: "cap", detail: cap.detail };
  const vm = await d.run("vm_stat", [], 5000);
  const free = vm.code === 0 ? freeBytes(vm.stdout) : null;
  if (free === null) return { state: "refused", reason: "memory", detail: "free memory unknown (vm_stat unreadable)" };
  if (free < MIN_FREE_BYTES) return { state: "refused", reason: "memory", detail: `${(free / 1024 ** 3).toFixed(2)} GiB free < 1.5 GiB` };

  const undone: string[] = [];
  const undo = async () => {
    const s = await d.run(d.herdr, ["--session", name, "server", "stop"], T);
    undone.push(`server stop: ${failed(s) ?? "ok"}`);
    await waitSocket(d, name, false, 3000);
    const del = await d.run(d.herdr, ["session", "delete", name], T);
    undone.push(`session delete: ${failed(del) ?? "ok"}`);
  };
  const fail = async (step: string, detail: string): Promise<StartResult> => { await undo(); return { state: "failed", step, detail, undone }; };

  const sp = d.spawnDetached(d.herdr, ["--session", name, "server"]);
  if (!sp.ok) return { state: "failed", step: "herdr server", detail: sp.error ?? "spawn failed", undone };
  if (!(await waitSocket(d, name, true, 5000))) return fail("herdr server", "socket did not appear in 5s");
  const ws = await d.run(d.herdr, ["--session", name, "workspace", "create", "--cwd", a.cwd], T);
  let root: string | undefined;
  try { root = (JSON.parse(ws.stdout) as { result?: { root_pane?: { pane_id?: unknown } } }).result?.root_pane?.pane_id as string | undefined; } catch { /* below */ }
  if (failed(ws) || typeof root !== "string") return fail("workspace create", failed(ws) ?? "no root_pane.pane_id in the reply");
  const ag = await d.run(d.herdr, ["--session", name, "agent", "start", name, "--kind", "claude", "--pane", root, "--",
    "--permission-mode", "bypassPermissions", workerPrompt(a.prompt, a.parentSid)], AGENT_START_MS);
  if (failed(ag)) return fail("agent start", failed(ag)!);
  const near = a.near ?? d.env.TERN_PANE;
  if (!near) return fail("tern split", "no caller pane (args.near or TERN_PANE) to place the block beside");
  const sb = await d.run(d.tern, ["split", near, "right", "--json", "--", d.herdr, "--session", name], T);
  let pane: unknown;
  try { pane = (JSON.parse(sb.stdout) as { block?: unknown }).block; } catch { /* below */ }
  if (failed(sb) || !Number.isSafeInteger(pane)) return fail("tern split", failed(sb) ?? "no numeric block id in the reply");
  const w: Worker = { name, herdr_session: name, pane: pane as number, kind: "tui", started_at: d.now(), stopped_at: null, state: "live" };
  try { upsert(d.home, a.parentSid, w); }
  catch (e) {
    // the worker runs but is unrecorded: undo the herdr side and close the block, so nothing lives outside the registry
    const c = await d.run(d.tern, ["close", String(pane)], T);
    undone.push(`tern close: ${failed(c) ?? "ok"}`);
    return fail("record", (e as Error).message);
  }
  return { state: "ok", pane: pane as number, herdr_session: name };
}

export type StopResult = { state: "stopped" | "partial" | "unknown"; name: string; steps: Array<{ step: string; ok: boolean; detail?: string }>; reason?: string };

export async function stopWorker(seatSid: string, name: string, d: WorkerDeps): Promise<StopResult> {
  const steps: StopResult["steps"] = [];
  let seat: SeatRead;
  try { seat = readSeat(d.home, seatSid); } catch (e) { return { state: "unknown", name, steps, reason: (e as Error).message }; }
  if (seat.kind !== "ok") return { state: "unknown", name, steps, reason: seat.kind === "absent" ? "seat has no record" : seat.reason };
  const w = seat.workers.find((x) => x.name === name);
  if (!w) return { state: "unknown", name, steps, reason: `no worker ${name} recorded on this seat` };
  // set state/stopped_at on THIS instance only, under the lock, keeping whatever else the entry carries now (never the snapshot
  // read above — another writer, e.g. the #1033 orphan sweep, may have touched it meanwhile)
  const record = (state: WorkerState, stopped_at: number | null) => {
    try { setWorkerState(d.home, seatSid, w, state, stopped_at); return true; }
    catch (e) { steps.push({ step: `record ${state}`, ok: false, detail: (e as Error).message }); return false; }
  };
  record("stopping", null); // FIRST: a crash mid-stop leaves "stopping", never "live"
  const step = async (label: string, bin: string, args: string[]) => {
    const r = await d.run(bin, args, T);
    const bad = failed(r);
    steps.push(bad ? { step: label, ok: false, detail: bad } : { step: label, ok: true });
  };
  await step("herdr server stop", d.herdr, ["--session", w.herdr_session, "server", "stop"]);
  const gone = await waitSocket(d, w.herdr_session, false, 5000);
  steps.push(gone ? { step: "socket gone", ok: true } : { step: "socket gone", ok: false, detail: "socket still present after 5s" });
  await step("tern close", d.tern, ["close", String(w.pane)]);
  await step("herdr session delete", d.herdr, ["session", "delete", w.herdr_session]);
  record("stopped", d.now());
  return { state: steps.every((s) => s.ok) ? "stopped" : "partial", name, steps };
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
  try {
    const j = JSON.parse(ls.stdout) as { sessions?: unknown };
    if (!failed(ls) && Array.isArray(j.sessions)) sessions = (j.sessions as Array<{ name?: unknown; running?: unknown }>).filter((s) => typeof s.name === "string").map((s) => ({ name: s.name as string, running: s.running === true }));
  } catch { /* below */ }
  if (sessions === null) out.unknown.push("herdr session list unreadable — orphan detection skipped");
  const tl = await d.run(d.tern, ["ls", "--json"], T);
  let blocks: Set<number> | null = null;
  try {
    const j = JSON.parse(tl.stdout) as { sessions?: Array<{ tabs?: Array<{ blocks?: Array<{ id?: unknown }> }> }> };
    if (!failed(tl) && Array.isArray(j.sessions)) blocks = new Set(j.sessions.flatMap((s) => (s.tabs ?? []).flatMap((t) => (t.blocks ?? []).map((b) => b.id as number))));
  } catch { /* below */ }
  if (blocks === null) out.unknown.push("tern ls --json unreadable — block check skipped");

  for (const w of all.workers.filter(active)) {
    const hs = sessions?.find((s) => s.name === w.herdr_session);
    if (sessions !== null && (!hs || !hs.running)) { out.orphan.push({ kind: "recorded-but-gone", seat: w.seat, name: w.name, detail: hs ? "herdr session stopped" : "herdr session missing" }); continue; }
    if (blocks !== null && !blocks.has(w.pane)) { out.orphan.push({ kind: "recorded-but-gone", seat: w.seat, name: w.name, detail: `Tern block ${w.pane} missing` }); continue; }
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
