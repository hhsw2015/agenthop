/**
 * tern-orphan-sweep selftest (#1033 r3). Fake herdr/tern/seat-shell; the three orphan classes, the two-round debounce, UNKNOWN = zero
 * actions, and the hard "never touch" set (default, unregistered sessions). Mutants (applied to PRODUCTION code by the reviewer gate):
 * removing the two-round debounce, or treating an unreadable source as "no orphans", must turn this RED.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/tern-orphan-sweep.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOrphanSweep, initialOrphanState, ORPHAN_EVERY_MS, TMP_TTL_MS, realSeatRecords, realMarkWorker, realTernBlocks, type OrphanIO, type SeatRecord } from "./tern-orphan-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

type W = {
  clock: number; recs: SeatRecord[] | null; sessions: string[] | null; blocks: Set<number> | null;
  stopped: string[]; deleted: string[]; marked: string[]; gcCode: number; gcLine: string;
  tmp: Array<{ name: string; ageMs: number }>; removed: string[]; logs: string[]; audit: string[];
};
const world = (): W => ({ clock: 0, recs: [], sessions: ["default"], blocks: new Set(), stopped: [], deleted: [], marked: [],
  gcCode: 0, gcLine: "gc: results=0 requests_quarantined=0 tmp=0 quarantine_expired=0", tmp: [], removed: [], logs: [], audit: [] });
const io = (w: W): OrphanIO => ({
  seatRecords: () => w.recs, herdrSessions: () => w.sessions, ternBlocks: () => w.blocks,
  herdrStop: (n) => { w.stopped.push(n); return true; },
  herdrDelete: (n) => { w.deleted.push(n); w.sessions = (w.sessions ?? []).filter((x) => x !== n); return true; },
  markWorker: (sid, hs, state) => { w.marked.push(hs); for (const r of w.recs ?? []) if (r.sid === sid) for (const x of r.workers) if (x.herdr_session === hs) x.state = state; return true; },
  gc: () => ({ code: w.gcCode, line: w.gcLine }),
  tmpFiles: () => w.tmp, removeTmp: (n) => { w.removed.push(n); return true; },
  nowMs: () => w.clock, log: (l) => w.logs.push(l), audit: (l) => w.audit.push(l),
});
const round = (st: ReturnType<typeof initialOrphanState>, w: W) => { const r = runOrphanSweep(st, io(w)); w.clock += ORPHAN_EVERY_MS; return r; };
const worker = (hs: string, state: string, pane: number) => ({ name: hs, herdr_session: hs, pane, kind: "tui", started_at: 1, stopped_at: null, state });

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
  t("marker: sets state+stopped_at, keeps other fields", realMarkWorker(home)("abc", "ops-x", "orphan", 42)
    && (() => { const x = JSON.parse(readFileSync(path.join(d, "abc.json"), "utf8")); return x.shell === "tern" && x.workers[0].state === "orphan" && x.workers[0].stopped_at === 42; })());
  writeFileSync(path.join(d, "bad.json"), "{torn");
  t("seat reader: one unreadable record => UNKNOWN (null)", realSeatRecords(home)() === null);
  const blocks = realTernBlocks(() => JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 5, live: true }, { id: 6, live: false }] }] }] }))();
  t("tern ls parser: only live block ids", blocks?.has(5) === true && blocks.has(6) === false);
  t("tern ls parser: malformed => null", realTernBlocks(() => JSON.stringify({ sessions: [{}] }))() === null);
  t("tern ls parser: tern did not answer => null", realTernBlocks(() => null)() === null);
}
console.log("PASS tern-orphan-sweep");
