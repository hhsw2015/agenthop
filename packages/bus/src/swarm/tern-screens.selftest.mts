/**
 * tern-screens selftest (#1115 T1, [liveness]): merging the per-VM screens/<vm>.json files. UNKNOWN for every unreadable,
 * malformed, missing, stale or future-dated observation; never idle by default; the newer of two VMs wins.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/tern-screens.selftest.mts
 */
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, symlinkSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mergeScreens, mergeScreensResult, readScreens, readScreensResult, realReadFs, screenOf, MAX_FILES, MAX_FILE_BYTES, MAX_DIR_ENTRIES, MAX_TOTAL_BYTES } from "./tern-screens.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const P = "12382390714370";
const file = (vm: string, screens: Record<string, unknown>) => JSON.stringify({ vm, screens });
const NOW = 1_000_000;

{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { state: "working", rule: "r", agent: "claude", observed_at: NOW - 3, try: "ok" } }) }], NOW, 60);
  const e = screenOf(m, Number(P));
  t("fresh observation ⇒ its state (working), with agent and rule", e.state === "working" && e.agent === "claude" && e.rule === "r" && e.vm === "A");
  t("a pane no VM reports ⇒ unknown (never idle)", screenOf(m, 42).state === "unknown");
}
{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { state: "idle", observed_at: NOW - 61 } }) }], NOW, 60);
  t("observation older than maxAge ⇒ unknown (stale), observedAt kept for diagnostics", screenOf(m, P).state === "unknown" && screenOf(m, P).observedAt === NOW - 61);
}
{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { state: "idle", observed_at: NOW + 3600 } }) }], NOW, 60);
  t("observation an hour in the future (clock stepped back) ⇒ unknown", screenOf(m, P).state === "unknown" && /future/.test(screenOf(m, P).why ?? ""));
}
{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { try: "unreadable", tried_at: NOW } }) }], NOW, 60);
  t("an entry with only a failed attempt (no observation) ⇒ unknown", screenOf(m, P).state === "unknown");
}
{
  for (const bad of [{ state: "sleeping", observed_at: NOW }, { state: 3, observed_at: NOW }, { state: "idle", observed_at: "x" }, null]) {
    const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: bad }) }], NOW, 60);
    t(`malformed entry ${JSON.stringify(bad)} ⇒ unknown`, screenOf(m, P).state === "unknown");
  }
  for (const body of [null, "{not json", "[]", "null", "7", "\"s\"", JSON.stringify({ vm: "A", screens: [] }), JSON.stringify({ vm: "A" }), JSON.stringify({ vm: 3, screens: {} }), JSON.stringify({ vm: "A", screens: null })]) {
    const m = mergeScreens([{ name: "a.json", body }], NOW, 60);
    t(`unreadable / malformed file ${JSON.stringify(body)?.slice(0, 30)} ⇒ its panes unknown (no throw)`, screenOf(m, P).state === "unknown");
    const ok = file("B", { [P]: { state: "idle", observed_at: NOW } });
    const r = mergeScreensResult([{ name: "b.json", body: ok }, { name: "a.json", body }], NOW, 60);
    t(`… and beside a good idle file it makes the WHOLE read unknown with a fault (it may hold this pane)`, screenOf(r.screens, P).state === "unknown" && typeof r.fault === "string");
  }
}
{
  const m = mergeScreens([
    { name: "a.json", body: file("A", { [P]: { state: "idle", observed_at: NOW - 20 } }) },
    { name: "b.json", body: file("B", { [P]: { state: "blocked", observed_at: NOW - 2 } }) },
  ], NOW, 60);
  t("two VMs report one pane ⇒ the newer observation wins", screenOf(m, P).state === "blocked" && screenOf(m, P).vm === "B");
}
{
  const A = (st: unknown, at: number) => ({ name: "a.json", body: file("A", { [P]: { state: st, observed_at: at } }) });
  const B = (st: unknown, at: number) => ({ name: "b.json", body: file("B", { [P]: { state: st, observed_at: at } }) });
  for (const [x, y, want] of [["idle", "blocked", "blocked"], ["idle", "unknown", "unknown"], ["idle", "working", "working"], ["working", "blocked", "blocked"]] as const) {
    const s1 = screenOf(mergeScreens([A(x, NOW), B(y, NOW)], NOW, 60), P).state;
    const s2 = screenOf(mergeScreens([B(y, NOW), A(x, NOW)], NOW, 60), P).state;
    t(`same-second ${x}/${y} ⇒ ${want} whatever the file order`, s1 === want && s2 === want);
  }
  t("within 1s (idle@NOW, blocked@NOW-1) ⇒ blocked (1s precision)", screenOf(mergeScreens([A("idle", NOW), B("blocked", NOW - 1)], NOW, 60), P).state === "blocked");
  t("clearly newer idle (idle@NOW, blocked@NOW-5) ⇒ idle", screenOf(mergeScreens([A("idle", NOW), B("blocked", NOW - 5)], NOW, 60), P).state === "idle");
  t("agreeing same-second idle/idle ⇒ idle", screenOf(mergeScreens([A("idle", NOW), B("idle", NOW)], NOW, 60), P).state === "idle");
  for (const bad of ["not-a-state", 7, null]) {
    const m = mergeScreens([A("idle", NOW - 10), B(bad, NOW - 1)], NOW, 60);
    t(`older idle + NEWER bad state ${JSON.stringify(bad)} ⇒ unknown (no fallback to the old idle)`, screenOf(m, P).state === "unknown");
  }
  const nt = mergeScreens([A("idle", NOW - 10), { name: "b.json", body: file("B", { [P]: { state: "working" } }) }], NOW, 60);
  t("older idle + a bad entry with NO time ⇒ unknown (an untimed observation may be the newest)", screenOf(nt, P).state === "unknown");
  t("newer good + older bad ⇒ the newer good stands", screenOf(mergeScreens([A("working", NOW), B("junk", NOW - 10)], NOW, 60), P).state === "working");
}
{
  const d = mkdtempSync(path.join(os.tmpdir(), "screens-")); mkdirSync(path.join(d, "screens"));
  t("no screens dir ⇒ every pane unknown", screenOf(readScreens(path.join(d, "nope"), NOW, 60), P).state === "unknown");
  writeFileSync(path.join(d, "screens", "A.json"), file("A", { [P]: { state: "idle", observed_at: NOW - 1 } }));
  t("real file read ⇒ idle", screenOf(readScreens(d, NOW, 60), P).state === "idle");
  chmodSync(path.join(d, "screens", "A.json"), 0o000);
  t("unreadable file (chmod 000) ⇒ unknown", screenOf(readScreens(d, NOW, 60), P).state === "unknown");
  chmodSync(path.join(d, "screens", "A.json"), 0o600);
}
{
  const d = mkdtempSync("/tmp/screens-b-"); const sd = path.join(d, "screens"); mkdirSync(sd);
  writeFileSync(path.join(sd, "A.json"), file("A", { [P]: { state: "idle", observed_at: NOW } }));
  const nowSec = Date.now() / 1000; // mtime-based freshness uses the real clock for these files
  const good = file("A", { [P]: { state: "idle", observed_at: Math.floor(nowSec) } });
  writeFileSync(path.join(sd, "A.json"), good);
  t("bounded reader: one regular file ⇒ idle", screenOf(readScreens(d, nowSec, 60), P).state === "idle");
  execFileSync("mkfifo", [path.join(sd, "F.json")]);
  const t0 = Date.now(); const r = readScreensResult(d, nowSec, 60); const ms = Date.now() - t0;
  t(`FIFO with no writer ⇒ returns at once (${ms}ms) with a fault, whole read unknown`, ms < 1000 && typeof r.fault === "string" && screenOf(r.screens, P).state === "unknown");
  // the open itself (second layer): a FIFO reached through readRegular must not block either (lstat raced into a regular file)
  const fifo = path.join(sd, "F.json");
  const t1 = Date.now(); let threw = false;
  try { realReadFs.readRegular(fifo, 0, MAX_FILE_BYTES); } catch { threw = true; }
  t(`readRegular on a FIFO (no writer) throws at once (${Date.now() - t1}ms), never blocks`, threw && Date.now() - t1 < 1000);
  execFileSync("rm", [fifo]);
  const link = path.join(sd, "L2.json"); symlinkSync(path.join(sd, "A.json"), link);
  const targetIno = (await import("node:fs")).statSync(link).ino; // the TARGET's inode: only O_NOFOLLOW can stop this open
  let lthrew = false; try { realReadFs.readRegular(link, targetIno, MAX_FILE_BYTES); } catch { lthrew = true; }
  t("readRegular on a symlink throws (O_NOFOLLOW)", lthrew);
  execFileSync("rm", [link]);
  const grow = path.join(sd, "G.json"); writeFileSync(grow, "x".repeat(MAX_FILE_BYTES + 5));
  let gthrew = false; try { realReadFs.readRegular(grow, (await import("node:fs")).lstatSync(grow).ino, MAX_FILE_BYTES); } catch { gthrew = true; }
  t("readRegular past its byte bound throws (file grew after lstat)", gthrew);
  const reg = path.join(sd, "R.json"); writeFileSync(reg, "{}");
  let ithrew = false; try { realReadFs.readRegular(reg, (await import("node:fs")).lstatSync(reg).ino + 1, MAX_FILE_BYTES); } catch { ithrew = true; }
  t("readRegular: a different inode than lstat saw (swapped file) throws", ithrew);
  execFileSync("rm", [grow, reg]);
  symlinkSync(path.join(d, "elsewhere.json"), path.join(sd, "L.json"));
  writeFileSync(path.join(d, "elsewhere.json"), file("X", { [P]: { state: "idle", observed_at: Math.floor(nowSec) } }));
  t("symlink ⇒ not followed, fault", typeof readScreensResult(d, nowSec, 60).fault === "string");
  execFileSync("rm", [path.join(sd, "L.json")]);
  writeFileSync(path.join(sd, "Big.json"), "x".repeat(MAX_FILE_BYTES + 1));
  t("file over MAX_FILE_BYTES ⇒ fault, unread", /bytes/.test(readScreensResult(d, nowSec, 60).fault ?? ""));
  const old = nowSec - 3600; utimesSync(path.join(sd, "Big.json"), old, old);
  t("… the same file aged out by mtime is skipped unread (old VM leftovers do not wedge the read)", readScreensResult(d, nowSec, 60).fault === undefined && screenOf(readScreens(d, nowSec, 60), P).state === "idle");
  for (let i = 0; i < MAX_FILES; i++) writeFileSync(path.join(sd, `v${i}.json`), file(`v${i}`, {}));
  t(`more than MAX_FILES (${MAX_FILES}) fresh files ⇒ fault`, /fresh screens files/.test(readScreensResult(d, nowSec, 60).fault ?? ""));
  for (let i = 0; i < MAX_FILES; i++) utimesSync(path.join(sd, `v${i}.json`), old, old);
  t("… aged out ⇒ fine again", readScreensResult(d, nowSec, 60).fault === undefined);
}
{
  // scale + total bytes through an injected fs: no real files needed
  const names = Array.from({ length: MAX_DIR_ENTRIES + 1 }, (_, i) => `v${i}.json`);
  let reads = 0;
  const fs = { readdir: () => names, lstat: () => ({ isFile: true, size: 10, mtimeSec: NOW, ino: 1 }), readRegular: () => { reads++; return file("v", {}); } };
  const r = readScreensResult("/x", NOW, 60, fs);
  t(`more than MAX_DIR_ENTRIES names ⇒ fault before any read`, typeof r.fault === "string" && reads === 0);
  const n = Math.floor(MAX_TOTAL_BYTES / MAX_FILE_BYTES) + 1; // each file within its own bound, together over the total
  if (n > MAX_FILES) throw new Error("fixture: total bound unreachable under MAX_FILES");
  const big = { readdir: () => Array.from({ length: n }, (_, i) => `b${i}.json`), lstat: () => ({ isFile: true, size: MAX_FILE_BYTES, mtimeSec: NOW, ino: 1 }), readRegular: () => "x".repeat(MAX_FILE_BYTES) };
  t(`total bytes over MAX_TOTAL_BYTES (${n} × ${MAX_FILE_BYTES}) ⇒ fault`, /in all/.test(readScreensResult("/x", NOW, 60, big).fault ?? ""));
  // T1B-READ-TOTAL-GROWTH: lstat says 1 byte, each file actually holds 62000 ⇒ 17 files = 1,054,000 > 1 MiB.
  const pad = (n: number) => { const body = file("g", {}); return body + " ".repeat(n - body.length); };
  const names17 = () => Array.from({ length: 17 }, (_, i) => `g${String(i).padStart(2, "0")}.json`);
  const bounds: number[] = [];
  // (a) a reader that honours its bound like realReadFs (more than `max` bytes ⇒ throws)
  const honest = { readdir: names17, lstat: () => ({ isFile: true, size: 1, mtimeSec: NOW, ino: 1 }),
    readRegular: (_p: string, _i: number, max: number) => { bounds.push(max); if (62000 > max) throw new Error(`more than ${max} bytes`); return pad(62000); } };
  const gr = readScreensResult("/x", NOW, 60, honest);
  t("growth after lstat: the read that would pass the total is refused ⇒ whole read fault", typeof gr.fault === "string" && gr.screens.size === 0);
  t("growth after lstat: each read is bounded by what is LEFT of the total", bounds.every((m, i) => m === Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - i * 62000)));
  // (b) a reader that returns more than it was allowed: the post-read recount still catches it
  const liar = { ...honest, readRegular: () => pad(62000) };
  t("growth after lstat: real bytes recounted after each read ⇒ fault even if a read overshoots", /in all/.test(readScreensResult("/x", NOW, 60, liar).fault ?? ""));
  let opened = 0;
  const lie = (isFile: boolean, size: number) => ({ readdir: () => ["a.json"], lstat: () => ({ isFile, size, mtimeSec: NOW, ino: 1 }), readRegular: () => { opened++; return file("A", {}); } });
  t("lstat says not a regular file ⇒ fault, never opened", /not a regular file/.test(readScreensResult("/x", NOW, 60, lie(false, 10)).fault ?? "") && opened === 0);
  t("lstat size over MAX_FILE_BYTES ⇒ fault, never opened", /bytes/.test(readScreensResult("/x", NOW, 60, lie(true, MAX_FILE_BYTES + 1)).fault ?? "") && opened === 0);
  const swap = { readdir: () => ["a.json"], lstat: () => ({ isFile: true, size: 10, mtimeSec: NOW, ino: 1 }), readRegular: () => { throw new Error("replaced between lstat and open"); } };
  t("swapped between lstat and open ⇒ fault", /replaced/.test(readScreensResult("/x", NOW, 60, swap).fault ?? ""));
}
console.log("all tern-screens selftests passed");
