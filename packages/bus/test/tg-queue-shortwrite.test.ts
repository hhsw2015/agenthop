// tg-queue RECORD-WRITE COMPLETENESS gate (DO-R8-P1-1, infra-law concurrency/IO class). The r13 O_EXCL fix wrote the record temp with
// a single raw writeSync(fd, body) that IGNORED the returned byte count — a legal SHORT write (both reviewers reproduced it: codex via
// a real kernel RLIMIT_FSIZE, happycapy via its harness) published a TRUNCATED record while returning "enqueued". This gate drives a
// real process whose RECORD-temp writeSync is capped / made to throw mid-write, and proves: (1) a short write loops to completion (the
// published record is byte-complete, incl. multi-byte UTF-8 — a single-writeSync revert truncates and fails this); (2) a mid-write
// failure publishes NO record, leaves no torn temp, keeps the cred, and a same-payload retry recovers + delivers.
import { afterAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueQueue, drainQueue } from "../src/swarm/tg-queue.js";

const HERE = import.meta.dirname;
const PKG_ROOT = path.join(HERE, "..");
const CHILD = path.join(HERE, "fixtures", "tg-queue-shortwrite-child.mts");
const TG_QUEUE = path.join(HERE, "..", "src", "swarm", "tg-queue.ts");

const procs: ChildProcess[] = [];
function runChild(root: string, mode: "cap" | "throw", cap: number): Promise<{ result: string; payload: unknown }> {
  const p = spawn(process.execPath, ["--import", "tsx", CHILD, TG_QUEUE, root, mode, String(cap)], { cwd: PKG_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p); let err = ""; p.stderr!.on("data", (b) => (err += String(b)));
  return new Promise((resolve, reject) => {
    p.on("error", reject);
    p.on("close", (code) => { if (code !== 0) return reject(new Error(`child exit ${code}: ${err}`)); try { resolve(JSON.parse(readFileSync(path.join(root, "result.json"), "utf8"))); } catch (e) { reject(e); } });
  });
}
afterAll(() => { for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL"); });

describe("tg-queue record-write completeness gate (DO-R8-P1-1)", () => {
  test("a SHORT write never publishes a truncated record — the writer loops until all bytes land (multi-byte UTF-8, byte offsets)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sw-cap-")); mkdirSync(path.join(root, "q"), { recursive: true });
    const { result, payload } = await runChild(root, "cap", 4); // 4 bytes/write ⇒ many iterations, splitting multi-byte chars across writes
    expect(result).toBe("enqueued");
    const dir = path.join(root, "q");
    const rec = readdirSync(dir).find((n) => /^\d{20}\.json$/.test(n));
    expect(rec).toBeDefined();
    expect(JSON.parse(readFileSync(path.join(dir, rec!), "utf8"))).toEqual(payload); // COMPLETE + byte-correct UTF-8 (a single-writeSync revert truncates ⇒ this fails)
    rmSync(root, { recursive: true, force: true });
  }, 30000);

  test("a MID-WRITE failure publishes NO record, cleans only our own temp, keeps the cred ⇒ a same-payload retry recovers + delivers", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sw-throw-")); mkdirSync(path.join(root, "q"), { recursive: true });
    const dir = path.join(root, "q");
    const { result, payload } = await runChild(root, "throw", 4); // first chunk writes, then the record write throws mid-stream
    expect(result).toBe("failed");
    expect(readdirSync(dir).some((n) => /^\d{20}\.json$/.test(n))).toBe(false); // NO published record (never rename a partial)
    expect(readdirSync(dir).some((n) => /\.json\.tmp-/.test(n))).toBe(false);   // our temp cleaned ⇒ no torn residue
    expect(existsSync(path.join(dir, "cred", "00000000000000000001"))).toBe(true); // cred preserved ⇒ retry obligation intact
    expect(enqueueQueue(dir, payload, 1)).toBe("enqueued");                      // same-payload retry (unpatched writeSync completes): cred==h, record missing ⇒ rewrite
    const received: unknown[] = []; await drainQueue(dir, (r) => { received.push(r); return "sent"; });
    expect(received).toEqual([payload]);                                         // delivered exactly the complete payload, once
    rmSync(root, { recursive: true, force: true });
  }, 30000);
});
