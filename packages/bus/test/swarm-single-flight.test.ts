import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireSingleFlight } from "../src/swarm/single-flight.js";

/** Single-flight lock (§0b R2, P2-1): one live writer at a time; a stale lock (dead holder) is reclaimed. */

const lockPath = () => path.join(mkdtempSync(path.join(tmpdir(), "sf-")), "dispatcher.lock");

describe("acquireSingleFlight", () => {
  test("acquires when free; writes our pid; release removes the file", () => {
    const p = lockPath();
    const release = acquireSingleFlight(p, { pidAlive: () => true });
    expect(release).not.toBeNull();
    expect(existsSync(p)).toBe(true);
    expect(Number(readFileSync(p, "utf8").trim())).toBe(process.pid);
    release!();
    expect(existsSync(p)).toBe(false);
  });

  test("a LIVE holder blocks a second acquire ⇒ null (no second writer)", () => {
    const p = lockPath();
    const first = acquireSingleFlight(p, { pidAlive: () => true });
    expect(first).not.toBeNull();
    const second = acquireSingleFlight(p, { pidAlive: () => true }); // holder considered alive
    expect(second).toBeNull();
    first!();
  });

  test("a STALE lock (holder pid dead) is reclaimed and acquired", () => {
    const p = lockPath();
    writeFileSync(p, "999999"); // a dead holder pid
    const release = acquireSingleFlight(p, { pidAlive: () => false }); // holder reported dead ⇒ reclaim
    expect(release).not.toBeNull();
    expect(Number(readFileSync(p, "utf8").trim())).toBe(process.pid); // now ours
    release!();
  });

  test("a READABLE garbage holder (not a pid) is reclaimable (NaN, not a live pid)", () => {
    const p = lockPath();
    writeFileSync(p, "not-a-pid"); // readable, just not a pid ⇒ NaN ⇒ reclaim (distinct from an UNREADABLE lock, below)
    const release = acquireSingleFlight(p, { pidAlive: () => true });
    expect(release).not.toBeNull();
    release!();
  });

  // DISP-3 three-state (lock-readability root fix): a lock we CANNOT READ is UNKNOWN, not reclaimable — HOLD, never steal a
  // live-but-unreadable holder's lock. Injected readLock throws so the path is deterministic (no flaky chmod).
  const throwing = (code: string) => () => { const e = new Error(code) as NodeJS.ErrnoException; e.code = code; throw e; };

  test("DISP-3: an UNREADABLE lock (EACCES) is HELD, not reclaimed (never steal a live-but-unreadable holder)", () => {
    const p = lockPath();
    writeFileSync(p, "999999"); // a holder on disk; even if readable+probed it would look dead — but we cannot read it
    const got = acquireSingleFlight(p, { pidAlive: () => false, readLock: throwing("EACCES") });
    expect(got).toBeNull();                                 // UNKNOWN holder ⇒ HOLD (old code folded unreadable⇒NaN⇒reclaim)
    expect(existsSync(p)).toBe(true);                       // untouched — not renamed-aside / reclaimed
    expect(readFileSync(p, "utf8").trim()).toBe("999999");
  });

  test("DISP-3: an EIO lock read is also HELD, not reclaimed (same family as fleet FR6's EIO-steals-live residual)", () => {
    const p = lockPath();
    writeFileSync(p, "999999");
    expect(acquireSingleFlight(p, { pidAlive: () => false, readLock: throwing("EIO") })).toBeNull();
    expect(readFileSync(p, "utf8").trim()).toBe("999999"); // untouched
  });

  test("DISP3-1: a moved-aside read error must NOT let the restore CLOBBER a racer that acquired in the gap", () => {
    const p = lockPath();
    writeFileSync(p, ""); // a readable EMPTY old lock (holder NaN ⇒ enters the stale-reclaim path)
    const io = {
      pidAlive: (pid: number) => pid === 88888, // the racer's pid is alive; the empty holder (NaN) is not
      readLock: (lp: string): string => {
        if (lp === p) return readFileSync(lp, "utf8"); // reading the live lock path ⇒ real
        // reading the moved-aside copy: simulate a transient EACCES AND a racer publishing its pid at lockPath in the gap
        writeFileSync(p, "88888"); // racer B acquires lockPath while we are mid-reclaim
        const e = new Error("EACCES") as NodeJS.ErrnoException; e.code = "EACCES"; throw e;
      },
    };
    const got = acquireSingleFlight(p, io);
    expect(got).toBeNull();                                 // we must NOT acquire — B holds; our restore must not clobber B
    expect(readFileSync(p, "utf8").trim()).toBe("88888");   // B's lock intact (not overwritten by our aside restore, not reclaimed)
  });

  test("DISP-3: ENOENT on the holder read ⇒ the lock vanished mid-check ⇒ retry, then acquire", () => {
    const p = lockPath();
    writeFileSync(p, "999999"); // present ⇒ first linkSync EEXISTs
    let reads = 0;
    const io = {
      pidAlive: () => true,
      readLock: (lp: string): string => {
        reads += 1;
        if (reads === 1) { unlinkSync(lp); const e = new Error("gone") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; } // vanished
        return readFileSync(lp, "utf8");
      },
    };
    const release = acquireSingleFlight(p, io);
    expect(release).not.toBeNull();                          // the retry links cleanly onto the now-absent path
    expect(Number(readFileSync(p, "utf8").trim())).toBe(process.pid);
    release!();
  });

  test("the lock is published already holding our pid — never observed empty (#2)", () => {
    const p = lockPath();
    const release = acquireSingleFlight(p, { pidAlive: () => true });
    expect(readFileSync(p, "utf8").trim()).toBe(String(process.pid)); // born with the pid, no empty window
    release!();
  });

  test("stale takeover (#1): a lock REFRESHED between our judge and our reclaim does NOT yield two owners", () => {
    const p = lockPath();
    writeFileSync(p, "77"); // a stale holder, 77
    let refreshed = false;
    const io = {
      pidAlive: (pid: number) => {
        if (pid === 77 && !refreshed) { refreshed = true; writeFileSync(p, "202"); return false; } // we judge 77 dead; meanwhile 202 takes over
        if (pid === 202) return true; // 202 is a live holder
        return false;
      },
    };
    const got = acquireSingleFlight(p, io);
    expect(got).toBeNull();                              // we must NOT acquire — 202's live lock has to survive
    expect(readFileSync(p, "utf8").trim()).toBe("202");  // 202's lock intact (restored, not clobbered/reclaimed)
  });

  test("release is ownership-checked + idempotent: a double release does NOT delete a successor's lock (#3)", () => {
    const p = lockPath();
    const release = acquireSingleFlight(p, { pidAlive: () => true });
    expect(release).not.toBeNull();
    release!();                                     // A releases — its lock removed
    writeFileSync(p, "999999");                     // a successor B now holds the lock (different pid)
    release!();                                     // A's STALE double-release must be a no-op for B
    expect(existsSync(p)).toBe(true);               // B's lock intact
    expect(readFileSync(p, "utf8").trim()).toBe("999999");
  });
});
