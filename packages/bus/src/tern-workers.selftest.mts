/**
 * tern-workers selftest (tsx-run). Fake herdr / tern / vm_stat through an injected `run` that records argv; a fake seat-shell dir in
 * tmp. Gates (#1034 r2, one tooth each): cap refused / memory refused / stop order + partial / orphans both ways / schema refuses a
 * non-number pane.  Run: node_modules/.bin/tsx packages/bus/src/tern-workers.selftest.mts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { capGate, claudePermissionArgs, freeBytes, herdrSessions, ternBlockIds, readSeat, setWorkerState, startWorker, stopWorker, stopWorkerAfterRead, workerName, workersStatus, writeWorkers, type Worker, type WorkerDeps } from "./tern-workers.js";
import type { Run } from "./tern-bridge.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const SEAT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const VM = (freePages: number) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      ${freePages}.\nPages active:    1.\nPages inactive:  0.\nPages speculative:  0.\n`;
const GiB = 1024 ** 3;

type Fake = { owners: Map<string, number>; nextPid: number; spawnEnv: Array<Record<string, string>>; signals: number[]; foreignFirst: Set<string>; argv: string[][]; sockets: Set<string>; fail: Set<string>; herdrSessions: Array<{ name: string; running: boolean }>; blocks: number[]; freePages: number; agentStatus: string };
function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "tw-"));
  const f: Fake = { owners: new Map(), nextPid: 50000, spawnEnv: [], signals: [], foreignFirst: new Set(), argv: [], sockets: new Set(), fail: new Set(), herdrSessions: [], blocks: [500], freePages: Math.ceil((4 * GiB) / 16384), agentStatus: "working" };
  const ok = (stdout = ""): Run => ({ code: 0, stdout, stderr: "", timedOut: false });
  const bad = (): Run => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
  const run = async (bin: string, args: string[]): Promise<Run> => {
    f.argv.push([bin, ...args]);
    const key = [bin, ...args].join(" ");
    for (const pat of f.fail) if (key.includes(pat)) return bad();
    if (bin === "vm_stat") return ok(VM(f.freePages));
    if (bin === "herdr") {
      if (args[0] === "session" && args[1] === "list") return ok(JSON.stringify({ sessions: [{ name: "default", running: true }, ...f.herdrSessions] }));
      if (args[0] === "session" && args[1] === "delete") { f.herdrSessions = f.herdrSessions.filter((s) => s.name !== args[2]); return ok(); }
      const name = args[1]!;
      if (args[2] === "server" && args[3] === "stop") { f.sockets.delete(name); f.owners.delete(name); const s = f.herdrSessions.find((x) => x.name === name); if (s) s.running = false; return ok(); }
      if (args[2] === "workspace") return ok(JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" } } }));
      if (args[2] === "agent" && args[3] === "start") return ok("{}");
      if (args[2] === "agent" && args[3] === "list") return ok(JSON.stringify({ result: { agents: [{ agent_status: f.agentStatus }] } }));
    }
    if (bin === "tern") {
      if (args[0] === "split") { const b = 700 + f.blocks.length; f.blocks.push(b); return ok(JSON.stringify({ session: 4, tab: 1, block: b })); }
      if (args[0] === "close") { f.blocks = f.blocks.filter((b) => String(b) !== args[1]); return ok(); }
      if (args[0] === "ls") return ok(JSON.stringify({ sessions: [{ tabs: [{ blocks: f.blocks.map((id) => ({ id })) }] }] }));
    }
    return ok();
  };
  const d: WorkerDeps = {
    home, tern: "tern", herdr: "herdr", run,
    spawnDetached: (_b, args, extraEnv) => {
      f.argv.push(["spawn", ...args]); f.spawnEnv.push(extraEnv);
      if (f.fail.has("spawn")) return { ok: false, error: "ENOENT" };
      const pid = ++f.nextPid; const name = args[1]!;
      if (f.foreignFirst.has(name)) { // a FOREIGN server created the same session after our list: ours exits "already running"
        f.sockets.add(name); f.owners.set(name, 99999); f.herdrSessions.push({ name, running: true }); return { ok: true, pid };
      }
      f.sockets.add(name); f.owners.set(name, pid); f.herdrSessions.push({ name, running: true }); return { ok: true, pid };
    },
    socketExists: (n) => f.sockets.has(n),
    socketOwners: (n) => (f.owners.has(n) ? [f.owners.get(n)!] : []),
    signal: (pid) => {
      f.signals.push(pid);
      for (const [n, p] of f.owners) if (p === pid) { f.owners.delete(n); f.sockets.delete(n); const s = f.herdrSessions.find((x) => x.name === n); if (s) s.running = false; return true; }
      return false;
    },
    listDir: (dir) => readdirSync(dir),
    now: () => Date.now(),
    sleep: async () => { /* instant */ },
    env: { TERN_PANE: "500" },
  };
  return { home, f, d };
}
const start = (d: WorkerDeps, task: string, sid = SEAT) => startWorker({ role: "Platform Dev", task, prompt: "do it", cwd: "/tmp", parentSid: sid }, d);

// ---- pure ----
t("workerName: <role short>-<task short>, lower-case [a-z0-9-]", workerName("Platform Dev", "bridge r8 smoke") === "platform-dev-bridge-r8-smoke")
t("workerName: nothing usable ⇒ null", workerName("审查", "!!") === null)
t("freeBytes: free+inactive+speculative pages × page size", freeBytes(VM(100)) === 100 * 16384 && freeBytes("garbage") === null)

// ---- happy start: the herdr session, the split, the record ----
{
  const { home, f, d } = setup();
  const r = await start(d, "smoke");
  t("start tui: ok with {pane, herdr_session}", r.state === "ok" && (r as any).herdr_session === "platform-dev-smoke" && Number.isSafeInteger((r as any).pane))
  const order = f.argv.map((a) => a.join(" "));
  t("start tui: server spawned, workspace, agent start (claude, highest permission by default), split beside TERN_PANE running herdr --session",
    order.some((x) => x === "spawn --session platform-dev-smoke server")
    && order.some((x) => x.startsWith("herdr --session platform-dev-smoke agent start platform-dev-smoke --kind claude --pane w1:p1 -- --dangerously-skip-permissions"))
    && order.some((x) => x === "tern split 500 right --json -- herdr --session platform-dev-smoke"))
  const agentArgs = f.argv.find((a) => a[3] === "agent" && a[4] === "start")!;
t("start tui: the prompt tail names the parent sid's durable inbox and a subagent bound", agentArgs[agentArgs.length - 1]!.includes(SEAT) && /durable inbox/.test(agentArgs[agentArgs.length - 1]!) && /subagents/.test(agentArgs[agentArgs.length - 1]!))
  const seat = readSeat(home, SEAT);
  const w = seat.kind === "ok" ? seat.workers[0] : undefined;
  t("record: pinned schema (pane number, herdr_session=name, kind tui, epoch-ms started_at, stopped_at null, live)",
    !!w && typeof w.pane === "number" && w.herdr_session === w.name && w.kind === "tui" && w.started_at > 1e12 && w.stopped_at === null && w.state === "live")
}

{
  const { f, d } = setup();
  await startWorker({ role: "Platform Dev", task: "multi", prompt: "line one\nline two\r\nthree", cwd: "/tmp", parentSid: SEAT }, d);
  const ag = f.argv.find((a) => a[3] === "agent" && a[4] === "start")!;
  t("start tui: the prompt reaches herdr as ONE line (herdr refuses newline arguments)", !/[\r\n]/.test(ag[ag.length - 1]!) && ag[ag.length - 1]!.startsWith("line one line two three"))
}

// ---- GATE: cap ----
{
  const { f, d } = setup();
  await start(d, "one"); await start(d, "two");
  const before = f.argv.length;
  const r = await start(d, "three");
  const after = f.argv.slice(before).map((x) => x.join(" "));
  t("GATE cap: 3rd worker on a seat (default cap 2) ⇒ refused reason cap, only read-only probes (vm_stat, session list), no spawn",
    r.state === "refused" && (r as any).reason === "cap" && after.every((x) => x === "vm_stat" || x === "herdr session list --json"))
  d.env = { ...d.env, SWARM_WORKER_CAP: "5", SWARM_WORKER_CAP_GLOBAL: "3" };
  await start(d, "four", OTHER);
  const r2 = await start(d, "five", OTHER);
  t("GATE cap: the GLOBAL cap counts every seat (3 live machine-wide) ⇒ refused", r2.state === "refused" && (r2 as any).reason === "cap" && /machine/.test((r2 as any).detail))
}
{
  const { home, d } = setup();
  mkdirSync(path.join(home, ".agenthop", "swarm", "seat-shell"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "swarm", "seat-shell", `${OTHER}.json`), "{torn");
  const r = await start(d, "x");
  t("GATE cap: an unreadable seat file makes the count UNKNOWN ⇒ refused (never assumed under the cap)", r.state === "refused" && (r as any).reason === "cap")
}
t("capGate pure: stopped workers do not count", capGate(SEAT, { workers: [{ name: "a-b", herdr_session: "a-b", pane: 1, kind: "tui", started_at: 1, stopped_at: 2, state: "stopped", seat: SEAT }], unreadable: [] }, {}).ok)

// ---- GATE: memory ----
{
  const { f, d } = setup();
  f.freePages = Math.floor((1.4 * GiB) / 16384);
  const r = await start(d, "mem");
  t("GATE memory: 1.4 GiB free ⇒ refused reason memory, no herdr server started", r.state === "refused" && (r as any).reason === "memory" && !f.argv.some((a) => a[0] === "spawn"))
  f.fail.add("vm_stat");
  const r2 = await start(d, "mem2");
  t("GATE memory: vm_stat unreadable ⇒ refused (unknown is not 'enough')", r2.state === "refused" && (r2 as any).reason === "memory")
}

// ---- a failed start step is undone: nothing left running unrecorded ----
{
  const { home, f, d } = setup();
  f.fail.add("tern split");
  const r = await start(d, "undo");
  const ws = (readSeat(home, SEAT) as any).workers as Worker[];
  t("start: split fails, undo PROVEN ⇒ herdr session gone and the placeholder recorded as stopped (never 'absent')",
    r.state === "failed" && (r as any).step === "tern split" && !f.sockets.has("platform-dev-undo") && !f.herdrSessions.some((s) => s.name === "platform-dev-undo")
    && ws.length === 1 && ws[0]!.state === "stopped" && typeof ws[0]!.stopped_at === "number")
}
// ---- CLEANUP (Chief Review): the placeholder exists BEFORE any resource; an unproven cleanup keeps "stopping" and its capacity ----
{
  const { home, f, d } = setup();
  let seenPlaceholder = false;
  const spawn0 = d.spawnDetached;
  d.spawnDetached = (b, args, env) => { const w = ((readSeat(home, SEAT) as any).workers ?? []) as Worker[]; seenPlaceholder = w.some((x) => x.state === "starting" && x.pane === 0); return spawn0(b, args, env); };
  f.fail.add("tern split"); f.fail.add("session delete");
  const r = await start(d, "leak");
  const ws = (readSeat(home, SEAT) as any).workers as Worker[];
  t("CLEANUP: the 'starting' placeholder is already recorded when the herdr server is spawned", seenPlaceholder)
  t("CLEANUP: split fails AND session delete fails ⇒ entry stays 'stopping' (not stopped, not absent)", r.state === "failed" && ws.length === 1 && ws[0]!.state === "stopping" && ws[0]!.stopped_at === null)
  t("CLEANUP: the report says the cleanup was not proven", /NOT proven/.test(((r as any).undone as string[]).join(" ")))
  f.fail.clear();
  const r2 = await start(d, "next");
  const r3 = await start(d, "third");
  t("CLEANUP: the unproven 'stopping' entry still takes capacity (cap 2: one more ok, then refused)", r2.state === "ok" && r3.state === "refused" && (r3 as any).reason === "cap")
}
{
  const { home, f, d } = setup();
  await start(d, "stopfail");
  f.fail.add("session delete");
  const r = await stopWorker(SEAT, "platform-dev-stopfail", d);
  const w = ((readSeat(home, SEAT) as any).workers as Worker[])[0]!;
  t("CLEANUP stop: a failed delete ⇒ partial and the record stays 'stopping' (never 'stopped')", r.state === "partial" && w.state === "stopping" && w.stopped_at === null)
}

// ---- GATE: stop order + partial ----
{
  const { home, f, d } = setup();
  const s = await start(d, "stopme");
  const pane = (s as any).pane as number;
  const serverPid = ((readSeat(home, SEAT) as any).workers[0] as Worker).server_pid!;
  f.argv.length = 0; f.signals.length = 0;
  const r = await stopWorker(SEAT, "platform-dev-stopme", d);
  const seq = f.argv.map((a) => a.join(" "));
  t("GATE stop order: OUR server pid signalled (not `server stop` by name) → socket gone → tern close <pane> → session delete", r.state === "stopped"
    && f.signals[0] === serverPid && !seq.some((x) => x.includes("server stop")) && seq.indexOf(`tern close ${pane}`) === 0 && seq.indexOf("herdr session delete platform-dev-stopme") === 1)
  const w = (readSeat(home, SEAT) as any).workers[0] as Worker;
  t("stop: record ends stopped with stopped_at", w.state === "stopped" && typeof w.stopped_at === "number")
}
{
  const { home, f, d } = setup();
  await start(d, "partial");
  const sig0 = d.signal;
  d.signal = () => false; // our server cannot be signalled (it keeps running)
  const r = await stopWorker(SEAT, "platform-dev-partial", d);
  d.signal = sig0;
  const seq = f.argv.map((a) => a.join(" "));
  t("GATE partial: stopping our server fails ⇒ the block close still runs, the session is NOT deleted (still running), state partial",
    r.state === "partial" && r.steps.find((x) => x.step === "stop own server")?.ok === false && seq.some((x) => x.startsWith("tern close")) && !seq.some((x) => x.startsWith("herdr session delete")))
  const w = (readSeat(home, SEAT) as any).workers[0] as Worker;
  t("GATE partial: the record is never left live — it stays 'stopping' until a cleanup is proven", w.state === "stopping")
}

// ---- GATE: orphans both ways, report only ----
{
  const { home, f, d } = setup();
  await start(d, "alive"); await start(d, "vanished");
  f.herdrSessions = f.herdrSessions.filter((s) => s.name !== "platform-dev-vanished"); // its herdr session disappeared
  f.herdrSessions.push({ name: "reviewer-stray", running: true });                    // a herdr session nobody records
  const before = f.argv.filter((a) => a.includes("delete") || a.includes("stop") || a[1] === "close").length;
  const st = await workersStatus(d);
  t("status: the live worker reports herdr agent_status", st.live.length === 1 && st.live[0]!.name === "platform-dev-alive" && st.live[0]!.agent_status === "working")
  t("GATE orphan (recorded but gone): a recorded live worker whose herdr session is missing", st.orphan.some((o) => o.kind === "recorded-but-gone" && o.name === "platform-dev-vanished"))
  t("GATE orphan (unrecorded): a herdr session no seat records", st.orphan.some((o) => o.kind === "unrecorded-herdr-session" && o.name === "reviewer-stray"))
  t("GATE orphan: REPORTED only — no stop/delete/close issued", f.argv.filter((a) => a.includes("delete") || a.includes("stop") || a[1] === "close").length === before)
  t("status: the default herdr session is never an orphan", !st.orphan.some((o) => o.name === "default"))
  f.blocks = f.blocks.filter((b) => b !== st.live[0]!.pane);
  const st2 = await workersStatus(d);
  t("GATE orphan: a recorded live worker whose Tern block is gone", st2.orphan.some((o) => o.name === "platform-dev-alive" && /block/.test(o.detail)))
  void home;
}

// ---- schema: a non-number pane is refused at write time ----
{
  const { home } = setup();
  let threw = false;
  try { writeWorkers(home, SEAT, [{ name: "a-b", herdr_session: "a-b", pane: "123" as unknown as number, kind: "tui", started_at: 1, stopped_at: null, state: "live" }]); } catch { threw = true; }
  t("schema: pane as a STRING is refused (pinned: number)", threw && readSeat(home, SEAT).kind === "absent")
  mkdirSync(path.join(home, ".agenthop", "swarm", "seat-shell"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "swarm", "seat-shell", `${SEAT}.json`), JSON.stringify({ sid: SEAT, shell: "tern", pid: 42 }));
  writeWorkers(home, SEAT, [{ name: "a-b", herdr_session: "a-b", pane: 9, kind: "tui", started_at: 1, stopped_at: null, state: "live" }]);
  const raw = JSON.parse(readFileSync(path.join(home, ".agenthop", "swarm", "seat-shell", `${SEAT}.json`), "utf8"));
  t("schema: writing workers PRESERVES the seat's shell/pid keys", raw.shell === "tern" && raw.pid === 42 && raw.workers.length === 1)
  t("workers are written through updateSeatShell (the record carries rev)", raw.rev === 1)
  t("readSeat: a bad worker record makes the seat unreadable (never 'no workers')", (() => {
    writeFileSync(path.join(home, ".agenthop", "swarm", "seat-shell", `${SEAT}.json`), JSON.stringify({ workers: [{ name: "x" }] }));
    return readSeat(home, SEAT).kind === "unreadable";
  })())
}

// ---- shared ownership (#1033 option A): only the matching instance's state/stopped_at change, under the lock ----
{
  const { home } = setup();
  const a: Worker = { name: "p-a", herdr_session: "p-a", pane: 11, kind: "tui", started_at: 1000, stopped_at: null, state: "live" };
  const b: Worker = { name: "p-b", herdr_session: "p-b", pane: 12, kind: "tui", started_at: 2000, stopped_at: null, state: "live" };
  writeWorkers(home, SEAT, [a, b]);
  setWorkerState(home, SEAT, b, "orphan", 5000);
  const ws = (readSeat(home, SEAT) as any).workers as Worker[];
  t("setWorkerState: only the matching instance changes; order and the other entry untouched", ws.length === 2 && ws[0]!.state === "live" && ws[1]!.state === "orphan" && ws[1]!.stopped_at === 5000 && ws[0]!.name === "p-a")
  let threw = false;
  try { setWorkerState(home, SEAT, { ...a, started_at: 999 }, "orphan", 1); } catch { threw = true; }
  t("setWorkerState: a different instance (same name, other started_at) is not matched ⇒ throws, nothing written", threw && ((readSeat(home, SEAT) as any).workers as Worker[])[0]!.state === "live")
}
{
  // stop must not resurrect a field another writer set meanwhile: the orphan sweep marks the instance, THEN stop records stopped
  const { home, f, d } = setup();
  const s = await start(d, "race");
  const w0 = ((readSeat(home, SEAT) as any).workers as Worker[])[0]!;
  const run0 = d.run;
  let marked = false;
  d.run = async (bin, args, ms) => {
    if (!marked && bin === "tern" && args[0] === "close") {
      marked = true;
      // another writer adds a NEW worker entry while stop is in flight (a concurrent start on the same seat)
      const other: Worker = { name: "p-other", herdr_session: "p-other", pane: 99, kind: "tui", started_at: 7, stopped_at: null, state: "live" };
      writeWorkers(home, SEAT, [...((readSeat(home, SEAT) as any).workers as Worker[]), other]);
    }
    return run0(bin, args, ms);
  };
  await stopWorker(SEAT, "platform-dev-race", d);
  const ws = (readSeat(home, SEAT) as any).workers as Worker[];
  t("stop writes under the lock: our instance ends stopped AND the entry another writer added meanwhile survives", ws.length === 2 && ws.find((x) => x.name === "platform-dev-race")?.state === "stopped" && ws.some((x) => x.name === "p-other" && x.state === "live"))
  void s; void f;
}

// ---- #1034 r3: highest permission by default, args.mode lowers it ----
t("permission: default = --dangerously-skip-permissions", JSON.stringify(claudePermissionArgs(undefined)) === JSON.stringify(["--dangerously-skip-permissions"]))
t("permission: mode plan ⇒ --permission-mode plan (explicit downgrade)", JSON.stringify(claudePermissionArgs("plan")) === JSON.stringify(["--permission-mode", "plan"]))
t("permission: an unknown mode is refused", !Array.isArray(claudePermissionArgs("root")))
{
  const { f, d } = setup();
  await startWorker({ role: "Platform Dev", task: "lowered", prompt: "p", cwd: "/tmp", parentSid: SEAT, mode: "acceptEdits" }, d);
  const ag = f.argv.find((a) => a[3] === "agent" && a[4] === "start")!;
  t("permission: args.mode reaches herdr, no skip flag", ag.includes("--permission-mode") && ag.includes("acceptEdits") && !ag.includes("--dangerously-skip-permissions"))
}

// ---- MTB-SV-CAP: concurrent starts never pass the cap (the slot is taken inside one locked transaction) ----
{
  const { home, f, d } = setup();
  const rs = await Promise.all([start(d, "c1"), start(d, "c2"), start(d, "c3"), start(d, "c4")]);
  const ok = rs.filter((r) => r.state === "ok").length;
  const ws = ((readSeat(home, SEAT) as any).workers as Worker[]).filter((w) => w.state === "live").length;
  t("CAP: 4 concurrent starts on one seat (cap 2) ⇒ exactly 2 ok, 2 refused cap", ok === 2 && rs.filter((r) => r.state === "refused" && (r as any).reason === "cap").length === 2)
  t("CAP: exactly 2 live workers recorded, no reservation left behind", ws === 2 && (() => { try { return readdirSync(path.join(home, ".agenthop", "swarm", "seat-shell", ".reservations")).length === 0; } catch { return true; } })())
  void f;
}

// ---- MTB-SV-START-OWN: an existing herdr session with our name is someone else's — refuse, never stop/delete it ----
{
  const { f, d } = setup();
  f.herdrSessions.push({ name: "platform-dev-taken", running: true });
  const r = await start(d, "taken");
  t("START-OWN: name exists ⇒ refused name-taken", r.state === "refused" && (r as any).reason === "name-taken")
  t("START-OWN: the existing session was never stopped or deleted", !f.argv.some((a) => a.join(" ").includes("platform-dev-taken") && (a.includes("stop") || a.includes("delete"))) && f.herdrSessions.some((s) => s.name === "platform-dev-taken"))
  f.herdrSessions.push({ name: "platform-dev-taken2", running: false });
  const r2 = await start(d, "taken2");
  t("START-OWN: a STOPPED session with our name is not ours either ⇒ refused", r2.state === "refused" && (r2 as any).reason === "name-taken")
}

// ---- MTB-SV-STOP-INSTANCE: the recorded instance changed ⇒ zero actions ----
{
  const { home, f, d } = setup();
  await start(d, "inst");
  const w0 = ((readSeat(home, SEAT) as any).workers as Worker[])[0]!;
  // a newer instance with the same name replaced the record between stop's read and its locked check
  const readSeat0 = readSeat;
  const newer: Worker = { ...w0, pane: w0.pane + 1, started_at: w0.started_at + 1 };
  const before = f.argv.length;
  const realRun = d.run;
  let swapped = false;
  const d2: WorkerDeps = { ...d, run: async (b, a2, ms) => realRun(b, a2, ms) };
  // swap right after stopWorker's unlocked read: patch via a getter on listDir is not available, so do it by writing first
  writeWorkers(home, SEAT, [newer]);
  swapped = true;
  const r = await stopWorker(SEAT, w0.name, { ...d2 });
  t("STOP-INSTANCE (record already replaced): stop acts on the CURRENT instance only", r.state === "stopped" && f.argv.slice(before).some((a) => a.join(" ") === `tern close ${newer.pane}`))
  void readSeat0; void swapped;
}
{
  const { home, f, d } = setup();
  await start(d, "inst2");
  const w0 = ((readSeat(home, SEAT) as any).workers as Worker[])[0]!;
  const newer: Worker = { ...w0, pane: w0.pane + 7, started_at: w0.started_at + 7 };
  const realReadDir = d.listDir;
  let first = true;
  // the swap happens INSIDE stop: between its unlocked read and the locked "stopping" record (hooked on the lock-taking listDir call)
  const wrap: WorkerDeps = { ...d, listDir: (dir) => realReadDir(dir) };
  const orig = (globalThis as any).__noop;
  void orig;
  const before = f.argv.length;
  const stopP = (async () => {
    const r0 = readSeat(home, SEAT); void r0;
    if (first) { first = false; writeWorkers(home, SEAT, [newer]); }
    return stopWorkerAfterRead(SEAT, w0, wrap);
  })();
  const r = await stopP;
  t("STOP-INSTANCE: instance changed under us ⇒ instance-mismatch, ZERO herdr/tern actions", r.state === "unknown" && /instance-mismatch/.test(r.reason ?? "") && f.argv.length === before)
  t("STOP-INSTANCE: the newer instance's record is untouched (still live)", ((readSeat(home, SEAT) as any).workers as Worker[])[0]!.state === "live")
}

// ---- MTB-SOURCE: a malformed source is UNKNOWN, never folded into stopped/missing (no new orphan) ----
t("herdrSessions: running must be a boolean; a {} entry or a missing list ⇒ null", herdrSessions({ sessions: [{ name: "a", running: "true" }] }) === null && herdrSessions({ sessions: [{}] }) === null && herdrSessions({}) === null && herdrSessions({ sessions: [{ name: "a", running: true }] })?.length === 1)
t("ternBlockIds: a non-number id or missing level ⇒ null", ternBlockIds({ sessions: [{ tabs: [{ blocks: [{ id: "1" }] }] }] }) === null && ternBlockIds({ sessions: [{}] }) === null && ternBlockIds({ sessions: [{ tabs: [{ blocks: [{ id: 3 }] }] }] })?.has(3) === true)
for (const bad of [`{"sessions":[{"name":"platform-dev-src","running":"true"}]}`, `{"sessions":[{}]}`, `{"sessions":{}}`]) {
  const { f, d } = setup();
  await start(d, "src");
  const run0 = d.run;
  d.run = async (bin, args, ms) => (bin === "herdr" && args[0] === "session" && args[1] === "list" ? { code: 0, stdout: bad, stderr: "", timedOut: false } : run0(bin, args, ms));
  const st = await workersStatus(d);
  t(`SOURCE: herdr list ${bad.slice(0, 40)}… ⇒ unknown reported, ZERO orphans`, st.orphan.length === 0 && st.unknown.some((u) => /herdr session list/.test(u)))
  void f;
}
{
  const { f, d } = setup();
  await start(d, "src2");
  const run0 = d.run;
  d.run = async (bin, args, ms) => (bin === "tern" && args[0] === "ls" ? { code: 0, stdout: `{"sessions":[{"tabs":[{"blocks":[{"id":"7"}]}]}]}`, stderr: "", timedOut: false } : run0(bin, args, ms));
  const st = await workersStatus(d);
  t("SOURCE: tern ls with a string block id ⇒ unknown, no 'block missing' orphan", !st.orphan.some((o) => /block/.test(o.detail)) && st.unknown.some((u) => /tern ls/.test(u)))
  void f;
}

// ---- MTB-WORKER-OWN (Chief Review 82be0ff): the list was empty, then a FOREIGN server took the name before ours came up ----
{
  const { home, f, d } = setup();
  f.foreignFirst.add("platform-dev-foreign");
  const r = await start(d, "foreign");
  const seq = f.argv.map((a) => a.join(" "));
  t("WORKER-OWN: a foreign instance won the name ⇒ start fails at 'ownership'", r.state === "failed" && (r as any).step === "ownership")
  t("WORKER-OWN: ZERO foreign stop/delete — no `server stop`, no `session delete`, no workspace/agent on it", !seq.some((x) => x.includes("platform-dev-foreign") && (x.includes("server stop") || x.includes("session delete") || x.includes("workspace") || x.includes("agent start"))))
  t("WORKER-OWN: the foreign server is still running and still owns its socket", f.owners.get("platform-dev-foreign") === 99999 && f.herdrSessions.find((x) => x.name === "platform-dev-foreign")?.running === true)
  const ws = (readSeat(home, SEAT) as any).workers as Worker[];
  t("WORKER-OWN: our placeholder is kept 'stopping' (unproven), never 'stopped'", ws.length === 1 && ws[0]!.state === "stopping")
}
{
  // stop of a recorded instance whose name was later taken by another server: not ours ⇒ no signal to it, no delete
  const { home, f, d } = setup();
  await start(d, "took");
  f.owners.set("platform-dev-took", 88888); // the session socket is now held by a different server
  f.signals.length = 0; f.argv.length = 0;
  const r = await stopWorker(SEAT, "platform-dev-took", d);
  t("WORKER-OWN stop: the socket is held by another pid ⇒ partial, no signal to anyone, no session delete", r.state === "partial" && f.signals.length === 0 && !f.argv.some((a) => a.join(" ").includes("session delete")))
  t("WORKER-OWN stop: the record stays 'stopping'", ((readSeat(home, SEAT) as any).workers as Worker[])[0]!.state === "stopping")
}
// ---- MTB-WORKER-OWN retry (Second Voice ea1e879): the unproven placeholder a failed start keeps must never authorize a by-name stop ----
{
  const { home, f, d } = setup();
  f.foreignFirst.add("platform-dev-retry");
  await start(d, "retry");
  const kept = ((readSeat(home, SEAT) as any).workers as Worker[])[0]!;
  t("OWN-RETRY: the kept placeholder carries ownership=unproven and no server_pid", kept.state === "stopping" && kept.ownership === "unproven" && kept.server_pid === undefined)
  f.signals.length = 0; f.argv.length = 0;
  const r = await stopWorker(SEAT, "platform-dev-retry", d);
  const seq = f.argv.map((a) => a.join(" "));
  t("OWN-RETRY: stop ⇒ unknown ownership-unproven, ZERO actions (no server stop, no delete, no signal)", r.state === "unknown" && /ownership-unproven/.test(r.reason ?? "") && f.signals.length === 0 && seq.length === 0)
  t("OWN-RETRY: the foreign server still runs; our entry stays 'stopping'", f.owners.get("platform-dev-retry") === 99999 && ((readSeat(home, SEAT) as any).workers as Worker[])[0]!.state === "stopping")
}
{
  // a proven live start drops the mark (so the server_pid path, not the unproven refusal, governs its stop)
  const { home, d } = setup();
  await start(d, "proven");
  const w = ((readSeat(home, SEAT) as any).workers as Worker[])[0]!;
  t("OWN-RETRY control: a proven live worker has server_pid and no ownership mark", w.state === "live" && w.server_pid !== undefined && w.ownership === undefined)
}
// ---- MTB-SV-STOP-COMMIT: resources cleaned, but the final 'stopped' write fails ⇒ partial, never 'stopped' ----
{
  const { home, d } = setup();
  await start(d, "commit");
  const run0 = d.run;
  d.run = async (bin, args, ms) => {
    const r = await run0(bin, args, ms);
    if (args[0] === "session" && args[1] === "delete") writeFileSync(path.join(home, ".agenthop", "swarm", "seat-shell", `${SEAT}.json`), `{"workers":"broken"}`);
    return r;
  };
  const r = await stopWorker(SEAT, "platform-dev-commit", d);
  t("STOP-COMMIT: final record write fails ⇒ partial with a failed 'record stopped' step", r.state === "partial" && r.steps.some((x) => x.step === "record stopped" && !x.ok))
}
{
  const { home, d } = setup();
  await start(d, "commitok");
  const r = await stopWorker(SEAT, "platform-dev-commitok", d);
  t("STOP-COMMIT control: normal owned stop ⇒ stopped and recorded", r.state === "stopped" && ((readSeat(home, SEAT) as any).workers as Worker[])[0]!.state === "stopped")
}
// ---- SH-PARENT-WIRING (#1057): the authoritative parent sid is in the spawned server's environment ----
{
  const { f, d } = setup();
  await start(d, "parent");
  t("PARENT-WIRING: the herdr server is spawned with SWARM_PARENT_SID = this call's parent sid", f.spawnEnv.length === 1 && f.spawnEnv[0]!.SWARM_PARENT_SID === SEAT)
}

console.log("all tern-workers selftests passed");
