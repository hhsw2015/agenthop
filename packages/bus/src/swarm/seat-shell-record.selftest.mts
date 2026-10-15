/**
 * seat-shell-record selftest (coordinator ruling: one locked write path for seat-shell/<sid>.json). The bug it pins: a writer that
 * reads, lets another writer publish, then renames its OLD snapshot over the new record. Here many PROCESSES each add their own key
 * through updateSeatShell at once; every key must survive and rev must equal the number of writes.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/seat-shell-record.selftest.mts
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSeatRecord, seatShellPath, updateSeatShell } from "./seat-shell-record.js";

const SID = "11111111-2222-4333-8444-555555555555";
const self = fileURLToPath(import.meta.url);

if (process.env.SSR_CHILD) { // child: add one key, then exit with the result state
  let st = "ok";
  for (let j = 0; j < 3; j++) { // 3 writes each: more interleavings per run
    const r = updateSeatShell(process.env.SSR_HOME!, SID, (rec) => ({ ...rec, [`k${process.env.SSR_CHILD}_${j}`]: true }), { waitMs: 30000 });
    if (r.state !== "ok") st = r.state;
  }
  process.stdout.write(st);
  process.exit(st === "ok" ? 0 : 1);
}

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const home = mkdtempSync(path.join(os.tmpdir(), "ssr-"));

// ---- single-writer basics ----
const r1 = updateSeatShell(home, SID, (rec) => ({ ...rec, shell: "tern" }));
t("absent ⇒ created at rev 1", r1.state === "ok" && r1.rev === 1 && (r1.record as any).shell === "tern")
const r2 = updateSeatShell(home, SID, (rec) => ({ ...rec, workers: [] }));
t("second write keeps the other key, rev 2", r2.state === "ok" && r2.rev === 2 && (r2.record as any).shell === "tern")
const r3 = updateSeatShell(home, SID, () => null);
t("fn returns null ⇒ nothing written, rev unchanged", r3.state === "ok" && r3.rev === 2 && readSeatRecord(home, SID).kind === "ok" && (readSeatRecord(home, SID) as any).rev === 2)
const r4 = updateSeatShell(home, SID, () => { throw new Error("nope"); });
t("fn throws ⇒ refused, nothing written", r4.state === "refused" && (readSeatRecord(home, SID) as any).rev === 2)
t("an invalid sid is refused before any path", updateSeatShell(home, "../x", (r) => r).state === "refused")
t("no lock dir or temp left behind", readdirSync(path.dirname(seatShellPath(home, SID))).every((n) => !n.includes(".lockd") && !n.includes(".tmp-")))

// ---- FC-2: an unreadable / malformed record is never overwritten ----
{
  const h = mkdtempSync(path.join(os.tmpdir(), "ssr2-"));
  mkdirSync(path.dirname(seatShellPath(h, SID)), { recursive: true });
  writeFileSync(seatShellPath(h, SID), "{torn");
  t("torn JSON ⇒ unreadable, file untouched", updateSeatShell(h, SID, (r) => ({ ...r, x: 1 })).state === "unreadable" && readFileSync(seatShellPath(h, SID), "utf8") === "{torn")
  writeFileSync(seatShellPath(h, SID), JSON.stringify({ rev: "7" }));
  t("non-integer rev ⇒ unreadable", updateSeatShell(h, SID, (r) => r).state === "unreadable")
  writeFileSync(seatShellPath(h, SID), JSON.stringify({ shell: "tern" }));
  const legacy = updateSeatShell(h, SID, (r) => ({ ...r, y: 1 }));
  t("a pre-rev file counts as rev 0 ⇒ becomes rev 1, keys kept", legacy.state === "ok" && legacy.rev === 1 && (legacy.record as any).shell === "tern")
  chmodSync(seatShellPath(h, SID), 0o000);
  t("EACCES ⇒ unreadable (not 'absent')", updateSeatShell(h, SID, (r) => r).state === "unreadable")
  chmodSync(seatShellPath(h, SID), 0o600);
}

// ---- the reported race: concurrent writers in SEPARATE processes, each adding its own key ----
{
  const h = mkdtempSync(path.join(os.tmpdir(), "ssr3-"));
  const N = 16; const W = N * 3;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => new Promise<string>((res) => {
    const c = spawn(process.execPath, [...process.execArgv, self], { env: { ...process.env, SSR_CHILD: String(i), SSR_HOME: h }, stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.on("close", () => res(out));
  })));
  const rec = readSeatRecord(h, SID);
  const keys = rec.kind === "ok" ? Object.keys(rec.record).filter((k) => /^k\d+_\d+$/.test(k)).length : -1;
  t(`${N} concurrent processes all ok`, results.every((x) => x === "ok"))
  t(`no lost update: all ${W} keys present`, keys === W)
  t(`rev == ${W} (one increment per write, no write applied twice or dropped)`, rec.kind === "ok" && rec.rev === W)
}

// ---- defensive conflict: a writer that BYPASSES the lock (writes the file directly) while fn runs ⇒ conflict, nothing renamed ----
{
  const h = mkdtempSync(path.join(os.tmpdir(), "ssr4-"));
  updateSeatShell(h, SID, (r) => ({ ...r, a: 1 }));
  const r = updateSeatShell(h, SID, (rec) => { writeFileSync(seatShellPath(h, SID), JSON.stringify({ rogue: true, rev: 9 })); return { ...rec, b: 1 }; });
  t("a lock-bypassing write during fn ⇒ conflict, the rogue file is NOT overwritten", r.state === "conflict" && JSON.parse(readFileSync(seatShellPath(h, SID), "utf8")).rogue === true)
  t("conflict leaves no temp behind", readdirSync(path.dirname(seatShellPath(h, SID))).every((n) => !n.includes(".tmp-")))
}

console.log("all seat-shell-record selftests passed");
