// holder-lock CROSS-PROCESS concurrency regression gate (DO-R6-P2-1, the infra-law concurrency-race fixture class for the shared
// lock primitive). The terminal-state tests in holder-lock.test.ts cannot reach the window where the ② post-publish sole-ownership
// verify is the real safety — a single process cannot interleave INSIDE take(). So this gate drives REAL processes through the exact
// late-publish ABA / cleanup-fault interleavings (child monkey-patches fs to gate at mkdir/publish/read around the UNMODIFIED
// acquireHolderLock; this test sequences them via .go files). It asserts mutual exclusion + recovery, AND a NEGATIVE CONTROL runs the
// SAME ABA against a ②-stripped copy and proves a double-hold appears there — i.e. this gate FAILS if the ② verify is ever removed
// (exactly the gap happycapy's review found: deleting ② still passed the old terminal-state suite).
import { afterAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const PKG_ROOT = path.join(HERE, "..");
const CHILD = path.join(HERE, "fixtures", "holder-lock-race-child.mts");
const HOLDER_SRC = path.join(HERE, "..", "src", "swarm", "holder-lock.ts");

type Done = { pid?: number; code: number | null; signal: NodeJS.Signals | null; err: string };
type Kid = { p: ChildProcess; id: string; closed: boolean; done: Promise<Done> };
const kids: Kid[] = [];

function home(): string { const h = mkdtempSync(path.join(os.tmpdir(), "hl-race-")); mkdirSync(path.join(h, "intents"), { recursive: true }); return h; }
const lockDir = (h: string): string => path.join(h, "lock");

function child(mod: string, h: string, id: string, gates: string[] = [], action = "once"): Kid {
  const p = spawn(process.execPath, ["--import", "tsx", CHILD, mod, h, id, gates.join(","), action], { cwd: PKG_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let err = ""; p.stderr!.on("data", (b) => (err += String(b)));
  const k = { p, id, closed: false } as Kid;
  k.done = new Promise<Done>((resolve, reject) => { p.on("error", reject); p.on("close", (code, signal) => { k.closed = true; resolve({ pid: p.pid, code, signal, err }); }); });
  kids.push(k); return k;
}
async function stage(h: string, id: string, n: string): Promise<Record<string, unknown>> {
  const file = path.join(h, `${id}.${n}.json`), end = Date.now() + 40000; // generous under a saturated parallel pool; the normal path resolves in ms
  while (!existsSync(file)) { if (Date.now() > end) throw new Error(`stage timeout ${id}.${n}`); await new Promise((r) => setTimeout(r, 5)); }
  return JSON.parse(readFileSync(file, "utf8"));
}
const go = (h: string, id: string, n: string): void => writeFileSync(path.join(h, `${id}.${n}.go`), "");
async function killHard(k: Kid): Promise<void> {
  k.p.kill("SIGKILL"); const e = await k.done;
  expect(e.signal).toBe("SIGKILL");
  expect(() => process.kill(k.p.pid!, 0)).toThrow(); // ESRCH ⇒ definitely dead
}
/** Spawn a plain acquire+release child and assert whether it won the lock. */
async function acquireOnce(mod: string, h: string, id: string, wantToken: boolean): Promise<Record<string, unknown>> {
  child(mod, h, id); const r = await stage(h, id, "result"); const e = await kids[kids.length - 1]!.done;
  expect(e.code).toBe(0); expect(typeof r.token === "string").toBe(wantToken); return r;
}
/** A ②-stripped copy of holder-lock.ts: take()'s post-publish sole-ownership re-read is deleted. Used ONLY by the negative control. */
function makeMutant(): string {
  const src = readFileSync(HOLDER_SRC, "utf8");
  const verify = `    let after: string[];
    try { after = readdirSync(dir); } catch { try { rmSync(mine, { force: true }); } catch { /* residual ⇒ SUCC1-3 reclaims */ } return false; } // can't verify ⇒ back off
    if (after.length !== 1 || after[0] !== token) { try { rmSync(mine, { force: true }); } catch { /* ditto */ } return false; } // ② not sole owner ⇒ back off (no double-hold)
`;
  const mutant = src.replace(verify, "");
  expect(mutant).not.toBe(src); // the anchor MUST still match — a refactor that moves ② must update this gate, never silently disable it
  const p = path.join(mkdtempSync(path.join(os.tmpdir(), "hl-mutant-")), "holder-lock.ts");
  writeFileSync(p, mutant); return p;
}

afterAll(async () => { for (const k of kids) if (!k.closed) k.p.kill("SIGKILL"); await Promise.allSettled(kids.map((k) => k.done)); });

describe("holder-lock cross-process concurrency gate (DO-R6-P2-1)", () => {
  test("real SIGKILL after mkdir / after publish ⇒ never stolen while live, recovered by a new PID after death", async () => {
    for (const at of ["mkdir", "publish"] as const) {
      const h = home();
      const d = child(HOLDER_SRC, h, "D", [at], "hold");
      await stage(h, "D", at);                                  // D paused right after its mkdir (empty dir) / publish (its token)
      await acquireOnce(HOLDER_SRC, h, `probe-${at}`, false);   // while D is live mid-op ⇒ contend (never churn/steal)
      await killHard(d);                                        // D really dies at that exact point
      await acquireOnce(HOLDER_SRC, h, `repair-${at}`, true);   // a fresh PID recovers (empty ⇒ rmdir-if-empty; dead token ⇒ ESRCH reclaim)
      await acquireOnce(HOLDER_SRC, h, `restart-${at}`, true);  // lock reusable
    }
  }, 90000);

  test("late-publish ABA: a stale reclaim rmdir's a newer holder's fresh dir; ② makes the late publisher back off (exactly one holder)", async () => {
    const h = home();
    const d = child(HOLDER_SRC, h, "D", [], "hold"); expect((await stage(h, "D", "result")).token).toBeTruthy(); await killHard(d);
    const b = child(HOLDER_SRC, h, "B", ["read-1", "mkdir", "publish"], "hold"); await stage(h, "B", "read-1"); // B read [D-token] (dead), gated before reclaiming
    await acquireOnce(HOLDER_SRC, h, "A", true); expect(existsSync(lockDir(h))).toBe(false);                   // A fully reclaims D, takes, releases ⇒ lock gone
    const c = child(HOLDER_SRC, h, "C", ["mkdir", "publish"], "hold"); await stage(h, "C", "mkdir"); const cInode = statSync(lockDir(h)).ino; // C mkdir's a FRESH dir, gated mid-publish
    go(h, "B", "read-1"); await stage(h, "B", "mkdir"); const newInode = statSync(lockDir(h)).ino;            // B resumes on its stale read ⇒ rmdir's C's dir ⇒ mkdir's its OWN
    expect(cInode).not.toBe(newInode);                                                                        // THE ABA (B deleted + recreated the dir)
    go(h, "B", "mkdir"); await stage(h, "B", "publish"); go(h, "B", "publish"); const won = await stage(h, "B", "result"); expect(won.token).toBeTruthy(); // B verifies while sole ⇒ wins
    go(h, "C", "mkdir"); await stage(h, "C", "publish"); go(h, "C", "publish"); const lost = await stage(h, "C", "result"); expect(lost.token).toBeNull();  // C's late publish ⇒ ② ⇒ back off
    expect(readdirSync(lockDir(h))).toEqual([won.token]);                                                     // exactly ONE identity
    go(h, "B", "release"); expect((await b.done).code).toBe(0); expect((await c.done).code).toBe(0);
    await acquireOnce(HOLDER_SRC, h, "after", true);                                                          // lock reusable
  }, 90000);

  test("SUCC1-3 cleanup-fault: two ② back-offs hit real EACCES ⇒ a dead multi-token residual, protected while live, reclaimed after both die", async () => {
    const h = home();
    const d = child(HOLDER_SRC, h, "D", [], "hold"); expect((await stage(h, "D", "result")).token).toBeTruthy(); await killHard(d);
    const b = child(HOLDER_SRC, h, "B", ["read-1", "mkdir", "publish"], "linger"); await stage(h, "B", "read-1");
    await acquireOnce(HOLDER_SRC, h, "A", true); expect(existsSync(lockDir(h))).toBe(false);
    const c = child(HOLDER_SRC, h, "C", ["mkdir", "publish"], "linger"); await stage(h, "C", "mkdir"); const cInode = statSync(lockDir(h)).ino;
    go(h, "B", "read-1"); await stage(h, "B", "mkdir"); expect(statSync(lockDir(h)).ino).not.toBe(cInode);   // ABA again
    go(h, "C", "mkdir"); await stage(h, "C", "publish"); go(h, "B", "mkdir"); await stage(h, "B", "publish"); // BOTH write their token into the one dir
    const before = readdirSync(lockDir(h)).sort(); expect(before.length).toBe(2);
    chmodSync(lockDir(h), 0o500);                                                                              // dir read-only ⇒ each ② back-off rmSync(mine) EACCESes
    let br: Record<string, unknown>, cr: Record<string, unknown>;
    try {
      go(h, "C", "publish"); go(h, "B", "publish");
      br = await stage(h, "B", "result"); cr = await stage(h, "C", "result");
      expect(br.token).toBeNull(); expect(cr.token).toBeNull();                                               // neither holds (both ② saw two, both tried to back off)
      expect((br.errors as { code?: string }[]).some((e) => e.code === "EACCES")).toBe(true);
      expect((cr.errors as { code?: string }[]).some((e) => e.code === "EACCES")).toBe(true);
      await acquireOnce(HOLDER_SRC, h, "while-live", false);                                                  // residual tokens of LIVE owners ⇒ contend (never partial-delete)
      expect(readdirSync(lockDir(h)).sort()).toEqual(before);                                                 // both residual tokens intact
    } finally { chmodSync(lockDir(h), 0o700); }
    await acquireOnce(HOLDER_SRC, h, "readable-live", false);                                                 // still live ⇒ contend
    await Promise.all([killHard(b), killHard(c)]);                                                            // both die ⇒ both tokens now ESRCH
    await acquireOnce(HOLDER_SRC, h, "after-death", true);                                                    // SUCC1-3: all-dead ⇒ reclaim ALL ⇒ recover (not a permanent wedge)
    await acquireOnce(HOLDER_SRC, h, "replay", true);
  }, 90000);

  test("NEGATIVE CONTROL: with ② removed, the SAME ABA produces a DOUBLE-HOLD ⇒ this gate detects the safety being deleted", async () => {
    const MUT = makeMutant();
    const h = home();
    const d = child(MUT, h, "D", [], "hold"); expect((await stage(h, "D", "result")).token).toBeTruthy(); await killHard(d);
    const b = child(MUT, h, "B", ["read-1", "mkdir", "publish"], "hold"); await stage(h, "B", "read-1");
    await acquireOnce(MUT, h, "A", true); expect(existsSync(lockDir(h))).toBe(false);
    const c = child(MUT, h, "C", ["mkdir", "publish"], "hold"); await stage(h, "C", "mkdir");
    go(h, "B", "read-1"); await stage(h, "B", "mkdir");
    go(h, "B", "mkdir"); await stage(h, "B", "publish"); go(h, "B", "publish"); const won = await stage(h, "B", "result"); expect(won.token).toBeTruthy();
    go(h, "C", "mkdir"); await stage(h, "C", "publish"); go(h, "C", "publish"); const second = await stage(h, "C", "result");
    // WITHOUT ②: C does not re-read ⇒ it does NOT back off ⇒ a SECOND live holder. Production (with ②) makes second.token null; the
    // mutant exposes the broken mutual exclusion this gate exists to catch.
    expect(second.token).toBeTruthy();
    expect(readdirSync(lockDir(h)).length).toBe(2);              // two identities ⇒ double-hold (the regression)
    go(h, "B", "release"); go(h, "C", "release"); await Promise.allSettled([b.done, c.done]);
  }, 90000);
});
