import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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

  test("an unreadable/garbage holder is treated as reclaimable (dead)", () => {
    const p = lockPath();
    writeFileSync(p, "not-a-pid");
    const release = acquireSingleFlight(p, { pidAlive: () => true }); // holder NaN (not > 0) ⇒ reclaim
    expect(release).not.toBeNull();
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
