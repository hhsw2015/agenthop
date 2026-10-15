/**
 * tern-orphan-sweep selftest (#1033 r3). Fake herdr/tern/seat-shell; the three orphan classes, the two-round debounce, UNKNOWN = zero
 * actions, and the hard "never touch" set (default, unregistered sessions). Mutants (applied to PRODUCTION code by the reviewer gate):
 * removing the two-round debounce, or treating an unreadable source as "no orphans", must turn this RED.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/tern-orphan-sweep.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { writeWorkers, setWorkerState, readSeat, type Worker as RW } from "../tern-workers.js";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runOrphanSweep, initialOrphanState, paneId, ORPHAN_EVERY_MS, TMP_TTL_MS, realSeatRecords, realMarkWorker, realWhileInstance, realTernBlocks, type OrphanIO, type SeatRecord } from "./tern-orphan-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

type W = {
  clock: number; recs: SeatRecord[] | null; sessions: string[] | null; blocks: Set<number> | null;
  stopped: string[]; deleted: string[]; marked: string[]; gcCode: number; gcLine: string;
  tmp: Array<{ name: string; ageMs: number }>; removed: string[]; logs: string[]; audit: string[];
  owners?: Record<string, number[] | null>;
  dead?: Array<{ name: string; pid: number }>;
};
const world = (): W => ({ clock: 0, recs: [], sessions: ["default"], blocks: new Set(), stopped: [], deleted: [], marked: [],
  gcCode: 0, gcLine: "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0", tmp: [], removed: [], logs: [], audit: [] });
const io = (w: W): OrphanIO => ({
  seatRecords: () => w.recs, herdrSessions: () => w.sessions, ternBlocks: () => w.blocks,
  socketOwners: (n) => {
    if (w.owners && n in w.owners) return w.owners[n]!;
    if (!(w.sessions ?? []).includes(n) || (w.dead ?? []).some((d) => d.name === n)) return [];
    const own = (w.recs ?? []).flatMap((r) => r.workers).filter((x) => x.herdr_session === n).map((x) => x.server_pid).filter((p): p is number => typeof p === "number");
    return own.length ? [own[own.length - 1]!] : [];
  },
  // a signalled server releases its session socket; w.stopped records the SESSION whose server got the signal
  signalPid: (pid) => {
    const r = (w.recs ?? []).flatMap((r) => r.workers).find((x) => x.server_pid === pid);
    const n = typeof r?.herdr_session === "string" ? r.herdr_session : `pid:${pid}`;
    w.stopped.push(n); (w.dead ??= []).push({ name: n, pid }); return true;
  },
  waitPidGone: (pid) => (w.dead ?? []).some((d) => d.pid === pid),
  herdrDelete: (n) => { w.deleted.push(n); w.sessions = (w.sessions ?? []).filter((x) => x !== n); return true; },
  whileInstance: (sid, hs, inst, states, act) => {
    const x = (w.recs ?? []).find((r) => r.sid === sid)?.workers.find((x) => x.herdr_session === hs && x.pane === inst.pane && x.started_at === inst.startedAt);
    if (!x || !states.includes(x.state as string)) return false;
    act(); return true;
  },
  markWorker: (sid, hs, inst, state) => { w.marked.push(hs); for (const r of w.recs ?? []) if (r.sid === sid) for (const x of r.workers) if (x.herdr_session === hs && x.pane === inst.pane && x.started_at === inst.startedAt) x.state = state; return true; },
  gc: () => ({ code: w.gcCode, line: w.gcLine }),
  tmpFiles: () => w.tmp, removeTmp: (n) => { w.removed.push(n); return true; },
  nowMs: () => w.clock, log: (l) => w.logs.push(l), audit: (l) => w.audit.push(l),
});
const round = (st: ReturnType<typeof initialOrphanState>, w: W) => { const r = runOrphanSweep(st, io(w)); w.clock += ORPHAN_EVERY_MS; return r; };
// server_pid = pane + 50000, and the fake socket owner of a live session is the pid of the (last) record naming it
const worker = (hs: string, state: string, pane: number) => ({ name: hs, herdr_session: hs, pane, kind: "tui", started_at: 1, stopped_at: null, state, server_pid: pane + 50000 });

// --- throttle ---
{ const w = world(); const st = initialOrphanState(); runOrphanSweep(st, io(w)); w.clock += 1000;
  t("throttle: second call within 60s does nothing", runOrphanSweep(st, io(w)).ran === false); }

// --- ① stopped record + live herdr session ⇒ stop+delete, only on the 2nd consecutive round ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatA-1111", workers: [worker("infra-build", "stopped", 501)] }];
  w.sessions = ["default", "infra-build"];
  round(st, w);
  t("①: first sighting does NOT clean", w.stopped.length === 0 && w.deleted.length === 0);
  round(st, w);
  t("①: second consecutive sighting stops then deletes", w.stopped.join() === "infra-build" && w.deleted.join() === "infra-build");
  t("①: one audit line", w.audit.filter((l) => /infra-build/.test(l)).length === 1);
  round(st, w);
  t("①: idempotent once gone", w.deleted.length === 1);
}
// --- debounce: an orphan that recovers between rounds is never touched ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatA-1111", workers: [worker("infra-build", "stopped", 501)] }]; w.sessions = ["default", "infra-build"];
  round(st, w);
  w.recs = [{ sid: "seatA-1111", workers: [worker("infra-build", "live", 501)] }]; w.blocks = new Set([501]);
  round(st, w);
  t("debounce: back to live on round 2 => nothing deleted", w.deleted.length === 0 && w.stopped.length === 0);
}
// --- ② live record whose Tern block vanished ⇒ marked orphan on round 2, then ① cleans it 2 rounds later ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatB-2222", workers: [worker("dev-tests", "live", 777)] }];
  w.sessions = ["default", "dev-tests"]; w.blocks = new Set([1, 2]);
  round(st, w); t("②: first sighting does not mark", w.marked.length === 0);
  round(st, w); t("②: second sighting marks the record orphan", w.marked.join() === "dev-tests");
  round(st, w); t("②→①: orphan session not deleted on its first ① sighting", w.deleted.length === 0);
  round(st, w); t("②→①: deleted on the next round", w.deleted.join() === "dev-tests");
}
// --- strict schema: a pane that is not a number is a visible schema violation and is never judged ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatS-5555", workers: [{ ...worker("dev-str", "live", 0), pane: "1056561954852" }] }];
  w.sessions = ["default", "dev-str"]; w.blocks = new Set([1]);
  round(st, w); round(st, w); round(st, w);
  t("string pane: never marked orphan", w.marked.length === 0 && w.deleted.length === 0);
  t("string pane: schema-violation logged", w.logs.some((l) => /schema-violation/.test(l) && /dev-str/.test(l)));
}
t("paneId: number", paneId(42) === 42);
t("paneId: numeric string rejected (strict)", paneId("1056561954852") === null);
t("paneId: non-integer / negative / null rejected", paneId(1.5) === null && paneId(-3) === null && paneId(null) === null);

// --- r6 TBS-ORPHAN-GENERATION: a new instance under the same name does not inherit the old instance's first sighting ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatG-7777", workers: [{ ...worker("dev-gen", "live", 600), started_at: 1000 }] }];
  w.sessions = ["default", "dev-gen"]; w.blocks = new Set([1]);
  round(st, w); // first sighting of instance A (pane 600, started 1000)
  w.recs = [{ sid: "seatG-7777", workers: [{ ...worker("dev-gen", "live", 601), started_at: 2000 }] }]; // restarted: B
  round(st, w);
  t("generation: restarted instance (new pane/started_at) is NOT marked on its first round", w.marked.length === 0);
  round(st, w);
  t("generation: B marked only after its own two rounds", w.marked.join() === "dev-gen");
}

// --- r6 TBS-ORPHAN-SHAPE end-to-end: a live worker + a malformed authoritative listing never reaches mark/stop/delete ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatH-8888", workers: [{ ...worker("dev-shape", "live", 777), started_at: 5 }] }];
  w.sessions = ["default", "dev-shape"];
  const bad = realTernBlocks(() => JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 777, live: "true" }] }] }] }));
  const b = io(w); b.ternBlocks = bad;
  for (let i = 0; i < 5; i++) { runOrphanSweep(st, b); w.clock += ORPHAN_EVERY_MS; }
  t("shape e2e: 5 rounds of a malformed listing => no mark, no stop, no delete", w.marked.length === 0 && w.stopped.length === 0 && w.deleted.length === 0);
}

// --- #1034 r3: "starting" is never judged; a persisting "stopping" is reported, never marked or deleted ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatP-9999", workers: [{ ...worker("dev-new", "starting", 0), started_at: 5 }] }];
  w.sessions = ["default", "dev-new"]; w.blocks = new Set([1]);
  for (let i = 0; i < 4; i++) round(st, w);
  t("starting (pane 0): never marked, never stopped/deleted", w.marked.length === 0 && w.stopped.length === 0 && w.deleted.length === 0);
  t("starting: not even a schema-violation line", !w.logs.some((l) => /schema-violation/.test(l)));
}
{ // a "starting" entry is skipped by its STATE, not by the pane-0 accident: even with a nonzero pane absent from Tern, nothing
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatP-9998", workers: [{ ...worker("dev-new2", "starting", 555), started_at: 7 }] }];
  w.sessions = ["default", "dev-new2"]; w.blocks = new Set([1]);
  for (let i = 0; i < 4; i++) round(st, w);
  t("starting (pane 555 not in Tern): never marked, never stopped/deleted", w.marked.length === 0 && w.stopped.length === 0 && w.deleted.length === 0);
}
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatS-8888", workers: [{ ...worker("dev-stuck", "stopping", 444), started_at: 6 }] }];
  w.sessions = ["default", "dev-stuck"]; w.blocks = new Set([1]); // its block is gone and its herdr session is still there
  for (let i = 0; i < 5; i++) round(st, w);
  t("stopping (block gone, session alive): never marked orphan", w.marked.length === 0);
  t("stopping: never stopped/deleted", w.stopped.length === 0 && w.deleted.length === 0);
  t("stopping: reported as a possible leak (after two rounds)", w.audit.some((l) => /still "stopping" — possible leak/.test(l)));
}

// --- never touched: default, unregistered sessions (even with role-task shape), records without herdr_session ---
{
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "seatC-3333", workers: [{ name: "x", pane: 9, state: "stopped" }] }]; // no herdr_session
  w.sessions = ["default", "worker-probe", "user-scratch", "infra-build"];
  for (let i = 0; i < 4; i++) round(st, w);
  t("never: unregistered role-task-shaped sessions untouched", w.stopped.length === 0 && w.deleted.length === 0);
  w.recs = [{ sid: "seatC-3333", workers: [worker("default", "stopped", 9)] }];
  for (let i = 0; i < 4; i++) round(st, w);
  t("never: 'default' even if a record names it", !w.deleted.includes("default") && !w.stopped.includes("default"));
}
// --- stopped record but herdr session already gone ⇒ nothing to do ---
{ const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "s", workers: [worker("ops-x", "stopped", 1)] }]; w.sessions = ["default"];
  round(st, w); round(st, w); t("①: stopped and session gone => no herdr call", w.stopped.length === 0); }

// --- FC-2 UNKNOWN: any source unreadable ⇒ zero herdr/mark actions, and the unknown round resets the debounce ---
for (const which of ["recs", "sessions", "blocks"] as const) {
  const w = world(); const st = initialOrphanState();
  w.recs = [{ sid: "s", workers: [worker("ops-x", "stopped", 1), worker("ops-y", "live", 99)] }]; w.sessions = ["default", "ops-x"];
  round(st, w); // first sighting
  const saved = { recs: w.recs, sessions: w.sessions, blocks: w.blocks };
  (w as Record<string, unknown>)[which] = null;
  const r = round(st, w);
  t(`unknown(${which}): zero actions`, r.unknown && w.stopped.length === 0 && w.marked.length === 0);
  Object.assign(w, saved);
  round(st, w);
  t(`unknown(${which}): debounce reset — next readable round is a FIRST sighting again`, w.stopped.length === 0);
}
// --- no registered workers ⇒ one log line, nothing else ---
{ const w = world(); const st = initialOrphanState(); w.sessions = ["default", "infra-build"]; round(st, w);
  t("no registered workers: logged, no action", w.logs.some((l) => /no registered herdr sessions/.test(l)) && w.stopped.length === 0); }

// --- ③ control plane: gc.sh exit 1 = UNKNOWN logged (not audited as success); gc work audited; stale tmp removed ---
{ const w = world(); const st = initialOrphanState(); w.gcCode = 1; w.gcLine = "gc: control dir unreadable"; round(st, w);
  t("③ gc exit 1 => logged UNKNOWN, no audit", w.logs.some((l) => /gc UNKNOWN/.test(l)) && w.audit.length === 0); }
{ const w = world(); const st = initialOrphanState(); w.gcLine = "gc: results=2 requests_quarantined=1 tmp=0 quarantine_expired=0"; round(st, w);
  t("③ gc removed something => one audit line", w.audit.length === 1 && /results=2/.test(w.audit[0]!)); }
{ const w = world(); const st = initialOrphanState(); round(st, w);
  t("③ gc nothing to do => no audit noise", w.audit.length === 0); }
{ const w = world(); const st = initialOrphanState(); w.gcLine = "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0 skipped=requests(symlink)"; round(st, w);
  t("③ gc r13 skipped=... => logged as an anomaly", w.logs.some((l) => /gc anomaly/.test(l) && /requests\(symlink\)/.test(l))); }
{ const w = world(); const st = initialOrphanState(); w.gcLine = "gc: results=0 requests_quarantined=0 requests_held=2 tmp=0 quarantine_expired=0"; round(st, w);
  t("③ gc r12 requests_held>0 => audited (could not quarantine, retried next run)", w.audit.length === 1 && /requests_held=2/.test(w.audit[0]!)); }
{ const w = world(); const st = initialOrphanState(); w.gcLine = "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0"; round(st, w);
  t("③ gc r12 all zero => no audit", w.audit.length === 0); }
{ const w = world(); const st = initialOrphanState(); w.gcLine = "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0 mode=0755"; round(st, w);
  t("③ gc r15 all-zero counts with mode=0755 => no audit (mode is not a count)", w.audit.length === 0); }
{ const w = world(); const st = initialOrphanState(); w.gcLine = "gc: results=0 requests_quarantined=0 requests_held=0 tmp=0 quarantine_expired=0 mode=755 skipped=requests(symlink)"; round(st, w);
  t("③ gc: a non-count field with a nonzero digit (mode=755) is not audited — counts are parsed by key", w.audit.length === 0); }
{ const w = world(); const st = initialOrphanState(); w.gcLine = "gc: results=0 requests_quarantined=0 requests_held=0 tmp=3 quarantine_expired=0 mode=0700"; round(st, w);
  t("③ gc r15 tmp=3 with mode => audited", w.audit.length === 1); }
{ const w = world(); const st = initialOrphanState(); w.gcCode = 1; w.gcLine = "gc: unsafe_mode mode=0777 (group/other-writable control dir: UNKNOWN, nothing done)"; round(st, w);
  t("③ gc r15 unsafe_mode => UNKNOWN anomaly logged, no audit", w.logs.some((l) => /gc UNKNOWN — anomaly: control dir is group\/other-writable/.test(l)) && w.audit.length === 0); }
{ const w = world(); const st = initialOrphanState();
  w.tmp = [{ name: "diag.json", ageMs: TMP_TTL_MS + 1 }, { name: "mirror-phase.json", ageMs: 1000 }]; round(st, w);
  t("③ tmp: only the >1h file removed", w.removed.join() === "diag.json"); }

// --- real IO: seat-shell reader + marker + tern ls parser ---
{
  const home = mkdtempSync(path.join(os.tmpdir(), "orphan-")); const d = path.join(home, ".agenthop", "swarm", "seat-shell");
  t("seat reader: missing dir => [] (nothing registered)", JSON.stringify(realSeatRecords(home)()) === "[]");
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "abc.json"), JSON.stringify({ sid: "abc", shell: "tern", workers: [worker("ops-x", "live", 5)] }));
  const recs = realSeatRecords(home)(); t("seat reader: workers read", recs?.[0]?.workers.length === 1);
  t("marker: a different instance (pane) is NOT written", realMarkWorker(home)("abc", "ops-x", { pane: 6, startedAt: 1 }, "orphan", 42) === false
    && JSON.parse(readFileSync(path.join(d, "abc.json"), "utf8")).workers[0].state === "live");
  t("marker: sets state+stopped_at, keeps other fields", realMarkWorker(home)("abc", "ops-x", { pane: 5, startedAt: 1 }, "orphan", 42)
    && (() => { const x = JSON.parse(readFileSync(path.join(d, "abc.json"), "utf8")); return x.shell === "tern" && x.workers[0].state === "orphan" && x.workers[0].stopped_at === 42; })());
  writeFileSync(path.join(d, "bad.json"), "{torn");
  t("seat reader: one unreadable record => UNKNOWN (null)", realSeatRecords(home)() === null);
  for (const [label, body] of [["workers not an array", { workers: { a: 1 } }], ["workers [null]", { workers: [null] }],
    ["workers [1]", { workers: [1] }], ["record is an array", [1, 2]]] as Array<[string, unknown]>) {
    writeFileSync(path.join(d, "bad.json"), JSON.stringify(body));
    t(`seat reader: ${label} => UNKNOWN (null), no throw`, realSeatRecords(home)() === null);
  }
  writeFileSync(path.join(d, "bad.json"), JSON.stringify({ sid: "x", shell: "tern" }));
  t("seat reader: no workers field => none registered (not UNKNOWN)", realSeatRecords(home)()?.length === 2);
  const blocks = realTernBlocks(() => JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 5, live: true }, { id: 6, live: false }] }] }] }))();
  t("tern ls parser: only live block ids", blocks?.has(5) === true && blocks.has(6) === false);
  t("tern ls parser: malformed => null", realTernBlocks(() => JSON.stringify({ sessions: [{}] }))() === null);
  const lsWith = (blk: unknown) => realTernBlocks(() => JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 5, live: true }, blk] }] }] }))();
  t("tern ls parser: live:\"true\" => UNKNOWN", lsWith({ id: 777, live: "true" }) === null);
  t("tern ls parser: id:\"777\" => UNKNOWN", lsWith({ id: "777", live: true }) === null);
  t("tern ls parser: missing live => UNKNOWN", lsWith({ id: 777 }) === null);
  t("tern ls parser: null block => UNKNOWN", lsWith(null) === null);
  t("tern ls parser: tern did not answer => null", realTernBlocks(() => null)() === null);
}

// --- TBS-STATE-COMMIT: the state an action needs is checked at the commit point (real seat-shell files + the shared locked writer) ---
{
  const home = mkdtempSync(path.join(os.tmpdir(), "orphan-commit-"));
  const sid = "00000000-0000-4000-8000-000000000091";
  const inst: RW = { name: "review-state", herdr_session: "review-state", pane: 555, kind: "tui", started_at: 1000, stopped_at: null, state: "live", server_pid: 50001 };
  const cur = () => { const r = readSeat(home, sid); return r.kind === "ok" ? r.workers[0]!.state : null; };
  const run = (start: RW, flipAt: number | null) => {
    writeWorkers(home, sid, [start]);
    let clock = 0, rnd = 0, sessions = ["default", inst.herdr_session], killed = false;
    const ev: string[] = [];
    const io: OrphanIO = {
      seatRecords: realSeatRecords(home), herdrSessions: () => sessions,
      // a legal locked writer (stopWorker) moves the instance to "stopping" AFTER this round's collection read
      ternBlocks: () => { if (rnd === flipAt) setWorkerState(home, sid, start, "stopping", null); return new Set([1]); },
      markWorker: realMarkWorker(home), whileInstance: realWhileInstance(home),
      socketOwners: (n) => (sessions.includes(n) && !killed ? [50001] : []),
      signalPid: (pid) => { ev.push(`stop ${pid === 50001 ? "review-state" : pid} @${cur()}`); killed = true; return true; },
      waitPidGone: () => killed,
      herdrDelete: (n) => { ev.push(`delete ${n} @${cur()}`); sessions = sessions.filter((x) => x !== n); return true; },
      gc: () => ({ code: 0, line: "gc: results=0 tmp=0" }), tmpFiles: () => [], removeTmp: () => false,
      nowMs: () => clock, log: (l) => ev.push(l), audit: (l) => ev.push(l),
    };
    const st = initialOrphanState();
    for (rnd = 0; rnd < 4; rnd++) { runOrphanSweep(st, io); clock += ORPHAN_EVERY_MS; }
    return ev;
  };
  // window 1: live seen twice, but turned "stopping" between round 2's read and its mark ⇒ never marked, never stopped/deleted
  let ev = run(inst, 1);
  t("state-commit: live→stopping before the mark ⇒ stays stopping (not overwritten orphan)", cur() === "stopping");
  t("state-commit: … and zero stop/delete", !ev.some((l) => /^(stop|delete) /.test(l)));
  t("state-commit: … the dropped mark is logged", ev.some((l) => /could not mark review-state orphan/.test(l)));
  // positive: stays live ⇒ marked on round 2, stop+delete on round 4 while the record is orphan
  ev = run(inst, null);
  t("state-commit positive: live kept ⇒ marked orphan, then stop+delete under orphan", cur() === "orphan"
    && ev.includes("stop review-state @orphan") && ev.includes("delete review-state @orphan"));
  // window 2: orphan seen twice, turned "stopping" between round 2's read and the stop/delete ⇒ zero stop/delete, record kept
  ev = run({ ...inst, state: "orphan", stopped_at: 5 }, 1);
  t("state-commit: orphan→stopping before stop/delete ⇒ zero stop/delete", !ev.some((l) => /^(stop|delete) /.test(l)));
  t("state-commit: … record kept as stopping, candidate dropped", cur() === "stopping" && ev.some((l) => /candidate dropped, record kept/.test(l)));
  // window 2 positive: stays stopped ⇒ stop+delete on round 2, state seen inside the action is still stopped
  ev = run({ ...inst, state: "stopped", stopped_at: 5 }, null);
  t("state-commit positive: stopped kept ⇒ stop+delete with the record still stopped", ev.includes("stop review-state @stopped") && ev.includes("delete review-state @stopped"));
  // the action holds the lock: a writer arriving during stop/delete cannot slip a state change in underneath it
  writeWorkers(home, sid, [{ ...inst, state: "stopped", stopped_at: 5 }]);
  // (another PROCESS: holder-lock reclaims tokens carrying its own pid, so an in-process writer is not a concurrent writer)
  const writer = path.join(home, "writer.mts");
  writeFileSync(writer, `import { setWorkerState } from ${JSON.stringify(path.resolve("packages/bus/src/tern-workers.ts"))};
try { setWorkerState(${JSON.stringify(home)}, ${JSON.stringify(sid)}, ${JSON.stringify({ ...inst, state: "stopped", stopped_at: 5 })}, "live", null); console.log("wrote"); }
catch { console.log("blocked"); }`);
  let inner = "";
  realWhileInstance(home)(sid, inst.herdr_session, { pane: 555, startedAt: 1000 }, ["stopped"], () => {
    inner = spawnSync(process.execPath, [...process.execArgv, writer], { encoding: "utf8", timeout: 20_000 }).stdout.trim();
  });
  t("state-commit: a concurrent writer (other process) is blocked while stop/delete runs", inner === "blocked" && cur() === "stopped");
  t("state-commit: … and writes once the action is done (lock released)", spawnSync(process.execPath, [...process.execArgv, writer], { encoding: "utf8" }).stdout.trim() === "wrote" && cur() === "live");
  t("state-commit: unreadable record ⇒ action not run", (() => { writeFileSync(path.join(home, ".agenthop", "swarm", "seat-shell", `${sid}.json`), "{torn"); let ran = false;
    const ok = realWhileInstance(home)(sid, inst.herdr_session, { pane: 555, startedAt: 1000 }, ["stopped"], () => { ran = true; }); return !ok && !ran; })());
}
console.log("PASS tern-orphan-sweep");
