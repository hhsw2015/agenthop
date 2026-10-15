/**
 * seat-record CAS selftest (#1033 r7, TBS-ORPHAN-GENERATION). Real files in a private home: versioned read-modify-write, a
 * concurrent publish between read and lock ⇒ conflict and the newer record survives, busy / dead lock, unknown carriers.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/seat-record.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { casSeatRecord, readSeatRecord, seatRecordFile, LOCK_STALE_MS } from "./seat-record.js";
import { realMarkWorker } from "./tern-orphan-sweep.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const home = () => { const h = mkdtempSync(path.join(os.tmpdir(), "seatrec-")); mkdirSync(path.join(h, ".agenthop", "swarm", "seat-shell"), { recursive: true }); return h; };
const put = (h: string, sid: string, rec: unknown) => writeFileSync(seatRecordFile(h, sid), JSON.stringify(rec));
const get = (h: string, sid: string) => JSON.parse(readFileSync(seatRecordFile(h, sid), "utf8"));
const w = (pane: number, started: number, state = "live") => ({ name: "dev-x", herdr_session: "dev-x", pane, kind: "tui", started_at: started, stopped_at: null, state });

// --- basic versioned write ---
{ const h = home(); put(h, "s1", { sid: "s1", shell: "tern" });
  t("cas: ok on a record without rev", casSeatRecord(h, "s1", (c) => ({ ...c!, note: 1 })) === "ok");
  t("cas: rev becomes 1", get(h, "s1").rev === 1 && get(h, "s1").note === 1 && get(h, "s1").shell === "tern");
  t("cas: second write rev 2", casSeatRecord(h, "s1", (c) => ({ ...c!, note: 2 })) === "ok" && get(h, "s1").rev === 2);
  t("cas: edit null => nochange, nothing written", casSeatRecord(h, "s1", () => null) === "nochange" && get(h, "s1").rev === 2);
  t("cas: lock released", !existsSync(seatRecordFile(h, "s1") + ".lock"));
  t("cas: no temp left", readdirSync(path.dirname(seatRecordFile(h, "s1"))).every((n) => !n.includes(".tmp-"))); }

// --- the reviewer's case: marker read pane 111, another writer publishes pane 222 before the marker commits ---
{ const h = home(); put(h, "s2", { sid: "s2", shell: "tern", rev: 4, workers: [w(111, 1)] });
  const r = casSeatRecord(h, "s2", (c) => ({ ...c!, workers: [{ ...w(111, 1), state: "orphan", stopped_at: 99 }] }), Date.now,
    () => put(h, "s2", { sid: "s2", shell: "tern", rev: 5, workers: [w(222, 2)] })); // concurrent atomic publish
  t("concurrent publish: CAS returns conflict", r === "conflict");
  const after = get(h, "s2");
  t("concurrent publish: the NEW live record survives (pane 222)", after.rev === 5 && after.workers.length === 1 && after.workers[0].pane === 222 && after.workers[0].state === "live");
  t("concurrent publish: old pane 111 did not reappear as orphan", !JSON.stringify(after).includes("111")); }

// --- the real marker goes through the CAS ---
{ const h = home(); put(h, "s3", { sid: "s3", shell: "tern", rev: 1, workers: [w(111, 1)] });
  t("marker: same instance marked orphan", realMarkWorker(h)("s3", "dev-x", { pane: 111, startedAt: 1 }, "orphan", 77) === true);
  const a = get(h, "s3");
  t("marker: state orphan, stopped_at epoch ms, rev bumped", a.workers[0].state === "orphan" && a.workers[0].stopped_at === 77 && a.rev === 2);
  put(h, "s3", { sid: "s3", shell: "tern", rev: 3, workers: [w(222, 2)] });
  t("marker: a newer instance is not touched (false, record unchanged)", realMarkWorker(h)("s3", "dev-x", { pane: 111, startedAt: 1 }, "orphan", 78) === false && get(h, "s3").workers[0].pane === 222 && get(h, "s3").rev === 3); }

// --- locks ---
{ const h = home(); put(h, "s4", { sid: "s4", rev: 1 });
  writeFileSync(seatRecordFile(h, "s4") + ".lock", `${process.pid} ${Date.now()}\n`);
  t("lock: held by a live writer => conflict, record untouched", casSeatRecord(h, "s4", (c) => ({ ...c!, x: 1 })) === "conflict" && get(h, "s4").x === undefined);
  const lf = seatRecordFile(h, "s4") + ".lock"; const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000; utimesSync(lf, old, old);
  t("lock: older than 10s is dead => taken over, write ok", casSeatRecord(h, "s4", (c) => ({ ...c!, x: 1 })) === "ok" && get(h, "s4").x === 1);
  t("lock: removed after the takeover write", !existsSync(lf)); }

// --- unknown carriers are never overwritten ---
{ const h = home(); writeFileSync(seatRecordFile(h, "s5"), "{torn");
  t("unknown: torn record => unknown, untouched", casSeatRecord(h, "s5", () => ({ a: 1 })) === "unknown" && readFileSync(seatRecordFile(h, "s5"), "utf8") === "{torn");
  put(h, "s6", [1, 2]); t("unknown: array record => unknown", casSeatRecord(h, "s6", () => ({ a: 1 })) === "unknown");
  put(h, "s7", { rev: "3" }); t("unknown: non-integer rev => unknown", readSeatRecord(seatRecordFile(h, "s7")) === "unknown");
  t("unknown: bad sid => unknown", casSeatRecord(h, "../x", () => ({ a: 1 })) === "unknown"); }

// --- absent record: create with rev 1 ---
{ const h = home(); t("absent: create => ok rev 1", casSeatRecord(h, "s8", (c) => (c === null ? { sid: "s8", shell: "tern" } : null)) === "ok" && get(h, "s8").rev === 1); }

console.log("PASS seat-record");
