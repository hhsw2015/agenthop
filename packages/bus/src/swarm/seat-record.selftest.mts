/**
 * Orphan marker over the shared seat-shell write path (#1033 r7b, TBS-ORPHAN-GENERATION). The marker writes ONLY through
 * setWorkerState (tern-workers.ts, which runs inside
 * updateSeatShell, seat-shell-record.ts — Platform Dev); this checks the marker side of the contract with real files:
 *  - same instance (herdr_session + pane + started_at) ⇒ only that entry's state/stopped_at change; rev bumps;
 *  - a re-published instance (the reviewer's case: read pane 111, another writer publishes pane 222) ⇒ nothing written;
 *  - ruling A field scope: every other field of the entry and every other entry of workers[] is byte-identical;
 *  - an unreadable record / missing workers ⇒ false, file untouched; a held lock ⇒ false (busy), file untouched.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/seat-record.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { realMarkWorker } from "./tern-orphan-sweep.js";
import { updateSeatShell, seatShellPath } from "./seat-shell-record.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const SID = "11111111-2222-4333-8444-555555555555";
const home = () => { const h = mkdtempSync(path.join(os.tmpdir(), "seatrec-")); mkdirSync(path.join(h, ".agenthop", "swarm", "seat-shell"), { recursive: true }); return h; };
const put = (h: string, rec: unknown) => writeFileSync(seatShellPath(h, SID), JSON.stringify(rec));
const get = (h: string) => JSON.parse(readFileSync(seatShellPath(h, SID), "utf8"));
const w = (name: string, pane: number, started: number, extra: Record<string, unknown> = {}) =>
  ({ name, herdr_session: name, pane, kind: "tui", started_at: started, stopped_at: null, state: "live", ...extra });

// same instance ⇒ only state/stopped_at of that one entry change
{ const h = home();
  put(h, { sid: SID, shell: "tern", pid: 42, rev: 3, workers: [w("dev-x", 111, 1, { cwd: "/w", note: "keep" }), w("dev-y", 333, 9)] });
  const before = get(h);
  t("marker: matching instance => true", realMarkWorker(h)(SID, "dev-x", { pane: 111, startedAt: 1 }, "orphan", 77) === true);
  const a = get(h);
  t("marker: that entry is orphan with stopped_at epoch ms", a.workers[0].state === "orphan" && a.workers[0].stopped_at === 77);
  t("marker: rev bumped by the shared writer", a.rev === 4);
  const { state: _s, stopped_at: _t, ...restA } = a.workers[0]; const { state: _s2, stopped_at: _t2, ...restB } = before.workers[0];
  t("ruling A: every other field of the entry unchanged", JSON.stringify(restA) === JSON.stringify(restB));
  t("ruling A: the other worker entry byte-identical", JSON.stringify(a.workers[1]) === JSON.stringify(before.workers[1]));
  t("ruling A: top-level shell/pid unchanged, no new keys", a.shell === "tern" && a.pid === 42 && Object.keys(a).sort().join() === Object.keys(before).sort().join()); }

// the reviewer's case: another writer re-publishes the worker (pane 222) after the sweep saw pane 111
{ const h = home();
  put(h, { sid: SID, shell: "tern", rev: 4, workers: [w("dev-x", 111, 1)] });
  // the other writer goes through the same locked path (as #1034 does)
  t("other writer: publish pane 222", updateSeatShell(h, SID, (rec) => ({ ...rec, workers: [w("dev-x", 222, 2)] })).state === "ok");
  const before = readFileSync(seatShellPath(h, SID), "utf8");
  t("marker: stale instance (pane 111) => false", realMarkWorker(h)(SID, "dev-x", { pane: 111, startedAt: 1 }, "orphan", 78) === false);
  t("marker: new live record survives byte-identical", readFileSync(seatShellPath(h, SID), "utf8") === before);
  t("marker: old pane 111 did not reappear", get(h).workers.every((x: { pane: number }) => x.pane !== 111)); }

// unreadable / missing workers / held lock ⇒ false, untouched
{ const h = home(); writeFileSync(seatShellPath(h, SID), "{torn");
  t("unreadable record => false, untouched", realMarkWorker(h)(SID, "dev-x", { pane: 1, startedAt: 1 }, "orphan", 1) === false && readFileSync(seatShellPath(h, SID), "utf8") === "{torn"); }
{ const h = home(); put(h, { sid: SID, shell: "tern", rev: 1 });
  t("no workers field => false, nothing written", realMarkWorker(h)(SID, "dev-x", { pane: 1, startedAt: 1 }, "orphan", 1) === false && get(h).rev === 1); }

console.log("PASS seat-record");
