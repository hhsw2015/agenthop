// holder-lock — the ONE shared identity-in-filename directory lock (decision-batch / shared-budget / shell-succession / tg-queue
// drain). This suite is the re-review surface for the TGP-11 / SUCC-1 / FR6 reclaim convergence (coordinator-finalized 2026-10-12):
//   - rmdir-if-empty + fresh mkdir reclaim of an EMPTY dir (a holder SIGKILLed between mkdir and identity-publish), folding the
//     former caller-side out-of-band reaper (tg-queue recoverDeadDrainLock) INTO the primitive;
//   - ② sole-ownership verify inside take() (a fresh mkdir is NOT proof of exclusivity) — exercised under true concurrency by the
//     tg-queue drain-lock FIFO test and the reviewers' multi-process harness; the deterministic single-process cases are below;
//   - SUCC1-3 entries>=1 reclaim classification (all own-or-ESRCH-dead ⇒ reclaim ALL by exact name; any live/unknown ⇒ contend),
//     which makes a DEAD MULTI-token residual inheritable instead of permanently wedged;
//   - DB-R7 / DB-R7 B occupancy protection (never steal a live published holder; never churn a live mid-publish empty dir);
//   - ESRCH-only probes (EPERM / unknown ⇒ contend, never steal).
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireHolderLock, releaseHolderLock } from "../src/swarm/holder-lock.js";

let BASE: string;
const site = () => ({ lockDir: path.join(BASE, "x.lockd"), intentDir: BASE, intentPrefix: "x.hold." });
const lockTokens = (): string[] => { try { return readdirSync(path.join(BASE, "x.lockd")); } catch { return []; } };
/** A pid that process.kill(pid,0) reports ESRCH (definitely dead). High int32 pids are unused; matches the decision-batch test. */
function aDeadPid(): number {
  for (let p = 2147480000; p < 2147483000; p++) { try { process.kill(p, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return p; } }
  throw new Error("no dead pid found");
}

beforeEach(() => { BASE = mkdtempSync(path.join(os.tmpdir(), "holder-lock-")); });
afterEach(() => { try { rmSync(BASE, { recursive: true, force: true }); } catch { /* */ } });

describe("holder-lock reclaim surface (TGP-11 / SUCC-1 / FR6 convergence)", () => {
  test("lifecycle: acquire publishes exactly our token (② sole owner); release drops the dir; re-acquire wins", () => {
    const t1 = acquireHolderLock(site());
    expect(typeof t1).toBe("string");
    expect(lockTokens()).toEqual([t1]);                         // ② — exactly our token, sole owner
    releaseHolderLock(site(), t1!);
    expect(existsSync(path.join(BASE, "x.lockd"))).toBe(false); // dir dropped on release
    expect(typeof acquireHolderLock(site())).toBe("string");    // free ⇒ re-acquire wins
  });

  test("DB-R7: a LIVE FOREIGN published holder is never stolen (contend) and its credential is left intact", () => {
    mkdirSync(path.join(BASE, "x.lockd"));
    writeFileSync(path.join(BASE, "x.lockd", "1.deadbeef"), ""); // pid 1 (init): always live + foreign ⇒ EPERM, not ESRCH ⇒ not reclaimable
    expect(acquireHolderLock(site())).toBeNull();
    expect(lockTokens()).toEqual(["1.deadbeef"]);               // untouched
  });

  test("a single DEAD holder (ESRCH) is reclaimed by exact name, then we take fresh", () => {
    const dead = aDeadPid();
    mkdirSync(path.join(BASE, "x.lockd"));
    writeFileSync(path.join(BASE, "x.lockd", `${dead}.old`), "");
    const t = acquireHolderLock(site());
    expect(typeof t).toBe("string");
    expect(lockTokens()).toEqual([t]);                          // dead token gone, ours in place
  });

  test("SUCC1-3: a DEAD MULTI-token residual is INHERITABLE — all-dead ⇒ reclaim every token then take (not a permanent wedge)", () => {
    const dead = aDeadPid();
    mkdirSync(path.join(BASE, "x.lockd"));
    writeFileSync(path.join(BASE, "x.lockd", `${dead}.a`), "");  // two dead tokens: two reclaimers whose ② back-off cleanup both faulted
    writeFileSync(path.join(BASE, "x.lockd", `${dead}.b`), "");
    const t = acquireHolderLock(site());
    expect(typeof t).toBe("string");                            // the OLD entries>1 ⇒ unconditional-contend would have WEDGED here forever
    expect(lockTokens()).toEqual([t]);                          // both dead tokens cleared, ours sole
  });

  test("SUCC1-3 safety: a mix of DEAD + LIVE tokens ⇒ contend, NEVER a partial delete (no stolen live holder, no reopened double-hold)", () => {
    const dead = aDeadPid();
    mkdirSync(path.join(BASE, "x.lockd"));
    writeFileSync(path.join(BASE, "x.lockd", `${dead}.a`), "");
    writeFileSync(path.join(BASE, "x.lockd", "1.live"), "");     // pid 1 alive
    expect(acquireHolderLock(site())).toBeNull();               // any live/unknown token ⇒ contend
    expect(lockTokens().sort()).toEqual([`${dead}.a`, "1.live"].sort()); // BOTH intact — no partial delete
  });

  test("TGP-11 crash recovery: an EMPTY lock dir (a holder SIGKILLed between mkdir and publish) + a DEAD intent is reclaimed in-primitive (rmdir-if-empty + fresh take)", () => {
    const dead = aDeadPid();
    mkdirSync(path.join(BASE, "x.lockd"));                       // empty lockdir: crashed holder, no identity published
    writeFileSync(path.join(BASE, `x.hold.${dead}.z`), "");      // its dead hold-intent
    const t = acquireHolderLock(site());
    expect(typeof t).toBe("string");                            // recovered IN the primitive (no caller-side reaper)
    expect(lockTokens()).toEqual([t]);
    expect(existsSync(path.join(BASE, `x.hold.${dead}.z`))).toBe(false); // dead intent cleaned (no intent-dir leak)
  });

  test("DB-R7 B: an EMPTY lock dir + a LIVE FOREIGN hold-intent ⇒ contend (a holder is mid-publish — never churn/rmdir it)", () => {
    mkdirSync(path.join(BASE, "x.lockd"));                       // empty — could be a live holder between its mkdir and publish
    writeFileSync(path.join(BASE, "x.hold.1.z"), "");           // pid 1 (live, foreign) intent ⇒ mid-publish ⇒ contend
    expect(acquireHolderLock(site())).toBeNull();
    expect(existsSync(path.join(BASE, "x.lockd"))).toBe(true);  // empty dir left intact (NOT rmdir'd out from under the live holder)
    expect(existsSync(path.join(BASE, "x.hold.1.z"))).toBe(true);
  });
});
