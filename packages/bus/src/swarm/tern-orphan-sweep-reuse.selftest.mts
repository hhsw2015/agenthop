/**
 * tern-orphan-sweep name-reuse selftest (#1033 r11, TBS-SV-NAME-REUSE). A real #1034 lifecycle (startWorker / stopWorker on private
 * seat-shell files, fake herdr/tern IO in the shape of tern-workers.selftest.mts) followed by real sweep rounds: an old stopped record
 * of a reused name must never stop or delete the server a newer start owns. Controls: a stopped record whose own server still holds
 * the socket IS cleaned; unobservable socket owner / unproven record / no server_pid => no action.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/tern-orphan-sweep-reuse.selftest.mts  (from repo root)
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { capGate, claudePermissionArgs, freeBytes, herdrSessions, ternBlockIds, readSeat, setWorkerState, startWorker, stopWorker, stopWorkerAfterRead, workerName, workersStatus, writeWorkers, type Worker, type WorkerDeps } from "../tern-workers.js";
import type { Run } from "../tern-bridge.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const SEAT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const VM = (freePages: number) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      ${freePages}.\nPages active:    1.\nPages inactive:  0.\nPages speculative:  0.\n`;
const GiB = 1024 ** 3;

type Fake = { owners: Map<string, number>; nextPid: number; spawnEnv: Array<Record<string, string>>; signals: number[]; foreignFirst: Set<string>; argv: string[][]; sockets: Set<string>; fail: Set<string>; herdrSessions: Array<{ name: string; running: boolean }>; blocks: number[]; freePages: number; agentStatus: string };
function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "orphan-reuse-"));
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
import { runOrphanSweep, initialOrphanState, realSeatRecords, realMarkWorker, realWhileInstance, ORPHAN_EVERY_MS, type OrphanIO } from "./tern-orphan-sweep.js";

const NAME = "platform-dev-reused-name";
type Ev = { actions: Array<{ op: string; name: string; pid?: number }>; logs: string[]; audit: string[] };
const ev0 = (): Ev => ({ actions: [], logs: [], audit: [] });
function sweepIO(home: string, f: Fake, ev: Ev, clock: { t: number }, owners?: (n: string) => number[] | null): OrphanIO {
  return {
    seatRecords: realSeatRecords(home), herdrSessions: () => ["default", ...f.herdrSessions.map((x) => x.name)], ternBlocks: () => new Set(f.blocks),
    socketOwners: owners ?? ((n) => (f.owners.has(n) ? [f.owners.get(n)!] : [])),
    // the fake kernel: SIGTERM ends exactly that pid; it releases the socket only if it was the one holding it
    signalPid: (pid) => {
      ev.actions.push({ op: "signal", name: [...f.owners].find(([, p]) => p === pid)?.[0] ?? "", pid });
      for (const [n, p] of f.owners) if (p === pid) { f.owners.delete(n); f.sockets.delete(n); }
      (f as Fake & { gone?: Set<number> }).gone = new Set([...((f as Fake & { gone?: Set<number> }).gone ?? []), pid]);
      return true;
    },
    waitPidGone: (pid) => (f as Fake & { gone?: Set<number> }).gone?.has(pid) === true,
    herdrDelete: (n) => { ev.actions.push({ op: "delete", name: n }); f.herdrSessions = f.herdrSessions.filter((x) => x.name !== n); return true; },
    markWorker: realMarkWorker(home), whileInstance: realWhileInstance(home),
    gc: () => ({ code: 0, line: "gc: results=0 tmp=0" }), tmpFiles: () => [], removeTmp: () => false,
    nowMs: () => clock.t, log: (l) => ev.logs.push(l), audit: (l) => ev.audit.push(l),
  };
}
const rounds = (io: OrphanIO, clock: { t: number }, n: number) => { const st = initialOrphanState(); for (let i = 0; i < n; i++) { runOrphanSweep(st, io); clock.t += ORPHAN_EVERY_MS; } };

// --- the reviewer's lifecycle: A starts + stops, B starts the same name; A's stopped record must not touch B's server ---
{
  const { home, f, d } = setup();
  t("reuse setup: A starts", (await start(d, "reused-name", SEAT)).state === "ok");
  t("reuse setup: A stops", (await stopWorker(SEAT, NAME, d)).state === "stopped");
  t("reuse setup: B starts the same name", (await start(d, "reused-name", OTHER)).state === "ok");
  const a = readSeat(home, SEAT), b = readSeat(home, OTHER);
  const bPid = b.kind === "ok" ? b.workers[0]!.server_pid : undefined;
  t("reuse setup: A stopped, B live, B's server holds the socket", a.kind === "ok" && a.workers[0]!.state === "stopped" && b.kind === "ok"
    && b.workers[0]!.state === "live" && typeof bPid === "number" && f.owners.get(NAME) === bPid);
  const ev = ev0(), clock = { t: 0 };
  rounds(sweepIO(home, f, ev, clock), clock, 4);
  t("reuse: zero stop/delete across 4 rounds", ev.actions.length === 0);
  t("reuse: B's server still holds the socket", f.owners.get(NAME) === bPid);
  t("reuse: B's record unchanged", JSON.stringify(readSeat(home, OTHER)) === JSON.stringify(b));
  t("reuse: A's record kept", JSON.stringify(readSeat(home, SEAT)) === JSON.stringify(a));
  t("reuse: the skip is logged", ev.logs.some((l) => /newer active record holds the name/.test(l)));
}
// --- same, but B's record is gone: the socket-owner check alone still protects B's server ---
{
  const { home, f, d } = setup();
  await start(d, "reused-name", SEAT); await stopWorker(SEAT, NAME, d); await start(d, "reused-name", OTHER);
  const bPid = f.owners.get(NAME);
  writeWorkers(home, OTHER, []);
  const ev = ev0(), clock = { t: 0 };
  rounds(sweepIO(home, f, ev, clock), clock, 4);
  t("reuse, no B record: zero stop/delete (socket held by another pid)", ev.actions.length === 0 && f.owners.get(NAME) === bPid);
  t("reuse, no B record: skip names the socket holder", ev.logs.some((l) => l.includes(`socket held by ${bPid}`)));
}
// --- positive control: a stopped record whose OWN server still holds the socket (stop was partial) IS cleaned ---
{
  const { home, f, d } = setup();
  await start(d, "reused-name", SEAT);
  const r = readSeat(home, SEAT); const w = r.kind === "ok" ? r.workers[0]! : null;
  setWorkerState(home, SEAT, w!, "stopped", 5);
  const ev = ev0(), clock = { t: 0 };
  rounds(sweepIO(home, f, ev, clock), clock, 2);
  t("own server: signal its pid then delete on round 2", ev.actions.map((x) => x.op).join() === "signal,delete" && ev.actions[0]!.pid === w!.server_pid);
  t("own server: audit names the server pid", ev.audit.some((l) => l.includes(`server ${w!.server_pid}`)));
}
// --- FC-2 / ownership controls: unobservable owner, unproven record, no server_pid => no action ---
{
  const { home, f, d } = setup();
  await start(d, "reused-name", SEAT);
  const r = readSeat(home, SEAT); const w = r.kind === "ok" ? r.workers[0]! : null;
  setWorkerState(home, SEAT, w!, "stopped", 5);
  const ev = ev0(), clock = { t: 0 };
  rounds(sweepIO(home, f, ev, clock, () => null), clock, 3);
  t("unobservable socket owner: no action", ev.actions.length === 0 && ev.logs.some((l) => /socket owner unobservable/.test(l)));
  writeWorkers(home, SEAT, [{ ...w!, state: "stopped", stopped_at: 5, ownership: "unproven" }]);
  const ev2 = ev0();
  rounds(sweepIO(home, f, ev2, clock), clock, 3);
  t("ownership unproven: no action", ev2.actions.length === 0 && ev2.logs.some((l) => /ownership unproven/.test(l)));
  const { server_pid: _drop, ...legacy } = w!;
  writeWorkers(home, SEAT, [{ ...legacy, state: "stopped", stopped_at: 5 }]);
  const ev3 = ev0();
  rounds(sweepIO(home, f, ev3, clock), clock, 3);
  t("no server_pid (legacy record): no action", ev3.actions.length === 0 && ev3.logs.some((l) => /no server_pid/.test(l)));
}
// --- probe/action gap (r12): another server takes the name AFTER the socket probe saw ours ---
// our record's server = A (pid from the real start); the takeover server = 99999. Each window must leave 99999 running and its
// session undeleted; only A's pid is ever signalled.
for (const when of ["after-probe", "after-signal"] as const) {
  const { home, f, d } = setup();
  await start(d, "reused-name", SEAT);
  const r = readSeat(home, SEAT); const w = r.kind === "ok" ? r.workers[0]! : null;
  setWorkerState(home, SEAT, w!, "stopped", 5);
  const ev = ev0(), clock = { t: 0 };
  let probes = 0;
  const takeover = () => { for (const [n, p] of f.owners) if (p === w!.server_pid) f.owners.delete(n); f.owners.set(NAME, 99999); f.sockets.add(NAME); };
  const io = sweepIO(home, f, ev, clock, (n) => {
    const now = f.owners.has(n) ? [f.owners.get(n)!] : [];
    if (++probes === 1 && when === "after-probe") takeover(); // the commit-point probe (the first call, round 2) returns ours, then the name moves
    return now;
  });
  const sig = io.signalPid;
  io.signalPid = (pid) => { const ok = sig(pid); if (when === "after-signal") takeover(); return ok; };
  rounds(io, clock, 2);
  t(`takeover ${when}: only our recorded pid was signalled`, ev.actions.filter((x) => x.op === "signal").every((x) => x.pid === w!.server_pid)
    && ev.actions.some((x) => x.op === "signal"));
  t(`takeover ${when}: the new server 99999 still holds the socket`, f.owners.get(NAME) === 99999);
  t(`takeover ${when}: its session is NOT deleted`, !ev.actions.some((x) => x.op === "delete") && f.herdrSessions.some((x) => x.name === NAME));
  t(`takeover ${when}: audit says not deleted, socket held by 99999`, ev.audit.some((l) => /delete=false \(not deleted: socket held by 99999\)/.test(l)));
}
// --- our pid does not exit within the wait ⇒ no delete ---
{
  const { home, f, d } = setup();
  await start(d, "reused-name", SEAT);
  const r = readSeat(home, SEAT); const w = r.kind === "ok" ? r.workers[0]! : null;
  setWorkerState(home, SEAT, w!, "stopped", 5);
  const ev = ev0(), clock = { t: 0 };
  const io = sweepIO(home, f, ev, clock);
  io.signalPid = (pid) => { ev.actions.push({ op: "signal", name: NAME, pid }); return true; }; // ignores SIGTERM
  io.waitPidGone = () => false;
  rounds(io, clock, 2);
  t("pid ignores SIGTERM: no delete, audit says exited=false", !ev.actions.some((x) => x.op === "delete") && ev.audit.some((l) => /exited=false delete=false/.test(l)));
  t("pid ignores SIGTERM: session kept", f.herdrSessions.some((x) => x.name === NAME));
}
// --- signal refused (EPERM/ESRCH) ⇒ no wait, no delete ---
{
  const { home, f, d } = setup();
  await start(d, "reused-name", SEAT);
  const r = readSeat(home, SEAT); const w = r.kind === "ok" ? r.workers[0]! : null;
  setWorkerState(home, SEAT, w!, "stopped", 5);
  const ev = ev0(), clock = { t: 0 };
  const io = sweepIO(home, f, ev, clock);
  let waited = false;
  io.signalPid = () => false; io.waitPidGone = () => { waited = true; return true; };
  rounds(io, clock, 2);
  t("signal refused: no wait, no delete", !waited && !ev.actions.some((x) => x.op === "delete") && ev.audit.some((l) => /signal=false exited=false delete=false/.test(l)));
}
// --- the real pid helpers: a real child process is signalled and confirmed gone; a dead pid is "gone"; pid 1 is never signalled ---
{
  const { spawn } = await import("node:child_process");
  const { realSignalPid, realWaitPidGone } = await import("./tern-orphan-sweep.js");
  const c = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = c.pid!;
  const reaped = new Promise((res) => c.on("exit", res));
  t("real: SIGTERM to our child succeeds", realSignalPid(pid));
  await reaped; // our own child stays a zombie (still answers kill 0) until reaped; the detached herdr server is not our child
  t("real: child confirmed gone", realWaitPidGone(pid));
  t("real: a live pid is NOT reported gone (bounded wait)", (() => { const t0 = Date.now(); const r = realWaitPidGone(process.pid); return r === false && Date.now() - t0 >= 4000; })());
  t("real: pid 1 is never signalled", realSignalPid(1) === false);
}
console.log("PASS tern-orphan-sweep-reuse");
