/**
 * tern-workers selftest (tsx-run). Fake herdr / tern / vm_stat through an injected `run` that records argv; a fake seat-shell dir in
 * tmp. Gates (#1034 r2, one tooth each): cap refused / memory refused / stop order + partial / orphans both ways / schema refuses a
 * non-number pane.  Run: node_modules/.bin/tsx packages/bus/src/tern-workers.selftest.mts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { capGate, freeBytes, readSeat, startWorker, stopWorker, workerName, workersStatus, writeWorkers, type Worker, type WorkerDeps } from "./tern-workers.js";
import type { Run } from "./tern-bridge.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const SEAT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const VM = (freePages: number) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      ${freePages}.\nPages active:    1.\nPages inactive:  0.\nPages speculative:  0.\n`;
const GiB = 1024 ** 3;

type Fake = { argv: string[][]; sockets: Set<string>; fail: Set<string>; herdrSessions: Array<{ name: string; running: boolean }>; blocks: number[]; freePages: number; agentStatus: string };
function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "tw-"));
  const f: Fake = { argv: [], sockets: new Set(), fail: new Set(), herdrSessions: [], blocks: [500], freePages: Math.ceil((4 * GiB) / 16384), agentStatus: "working" };
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
      if (args[2] === "server" && args[3] === "stop") { f.sockets.delete(name); const s = f.herdrSessions.find((x) => x.name === name); if (s) s.running = false; return ok(); }
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
    spawnDetached: (_b, args) => { f.argv.push(["spawn", ...args]); if (f.fail.has("spawn")) return { ok: false, error: "ENOENT" }; f.sockets.add(args[1]!); f.herdrSessions.push({ name: args[1]!, running: true }); return { ok: true }; },
    socketExists: (n) => f.sockets.has(n),
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
  t("start tui: server spawned, workspace, agent start (claude, bypassPermissions), split beside TERN_PANE running herdr --session",
    order.some((x) => x === "spawn --session platform-dev-smoke server")
    && order.some((x) => x.startsWith("herdr --session platform-dev-smoke agent start platform-dev-smoke --kind claude --pane w1:p1 -- --permission-mode bypassPermissions"))
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
  t("GATE cap: 3rd worker on a seat (default cap 2) ⇒ refused reason cap, ZERO actions", r.state === "refused" && (r as any).reason === "cap" && f.argv.length === before)
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
  t("start: split fails ⇒ failed at 'tern split', herdr server stopped + session deleted, nothing recorded",
    r.state === "failed" && (r as any).step === "tern split" && !f.sockets.has("platform-dev-undo") && !f.herdrSessions.some((s) => s.name === "platform-dev-undo") && readSeat(home, SEAT).kind === "absent")
}

// ---- GATE: stop order + partial ----
{
  const { home, f, d } = setup();
  const s = await start(d, "stopme");
  const pane = (s as any).pane as number;
  f.argv.length = 0;
  const r = await stopWorker(SEAT, "platform-dev-stopme", d);
  const seq = f.argv.map((a) => a.join(" "));
  t("GATE stop order: server stop → (socket gone) → tern close <pane> → session delete", r.state === "stopped"
    && seq.indexOf("herdr --session platform-dev-stopme server stop") === 0 && seq.indexOf(`tern close ${pane}`) === 1 && seq.indexOf("herdr session delete platform-dev-stopme") === 2)
  const w = (readSeat(home, SEAT) as any).workers[0] as Worker;
  t("stop: record ends stopped with stopped_at", w.state === "stopped" && typeof w.stopped_at === "number")
}
{
  const { home, f, d } = setup();
  await start(d, "partial");
  f.fail.add("server stop");
  const r = await stopWorker(SEAT, "platform-dev-partial", d);
  const seq = f.argv.map((a) => a.join(" "));
  t("GATE partial: server stop fails ⇒ the REST still run (close + delete), state partial, failed steps named",
    r.state === "partial" && r.steps.find((x) => x.step === "herdr server stop")?.ok === false && seq.some((x) => x.startsWith("tern close")) && seq.some((x) => x.startsWith("herdr session delete")))
  const w = (readSeat(home, SEAT) as any).workers[0] as Worker;
  t("GATE partial: even then the record is written stopped (never left live)", w.state === "stopped")
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

console.log("all tern-workers selftests passed");
