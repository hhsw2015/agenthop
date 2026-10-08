import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AlertDedup, alertKey, isValidInboxKey, classifyMemberHealth,
  parsePsOutput, selfTree, isDispatcherLoopCommand, isDispatcherAlreadyRunning, shouldEmitWatchNotice,
  type ProcInfo,
} from "../src/swarm/sentinel-denoise.js";
import { scanInboxes } from "../src/swarm/inbox-sentinel.js";

const homes: string[] = [];
const mkHome = (): string => { const h = mkdtempSync(path.join(tmpdir(), "sdn-")); homes.push(h); return h; };
afterEach(() => { while (homes.length) { try { rmSync(homes.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } } });

const UUID = "01a0ff49-7a50-7393-9737-2402e68e4649";
const UUID2 = "041d50b8-7f3a-4ab3-9cea-4e62c99d902c";

describe("F44 sentinel-denoise — ① AlertDedup", () => {
  test("fires once, suppressed within cooldown, fires again after it; record starts the cooldown", () => {
    let now = 1_000_000;
    const d = new AlertDedup(60_000, () => now);
    const k = alertKey("box1", "inbox-stall");
    expect(d.shouldFire(k)).toBe(true); d.record(k);
    expect(d.shouldFire(k)).toBe(false);       // within cooldown
    now += 59_999; expect(d.shouldFire(k)).toBe(false);
    now += 1;      expect(d.shouldFire(k)).toBe(true);  // cooldown elapsed ⇒ reminder allowed
  });

  test("shouldFire WITHOUT record does not start the cooldown (failed-delivery retry safety / LS4)", () => {
    let now = 0;
    const d = new AlertDedup(1000, () => now);
    const k = alertKey("m", "idle-timeout");
    expect(d.shouldFire(k)).toBe(true);  // checked but NOT recorded (delivery failed)
    expect(d.shouldFire(k)).toBe(true);  // still allowed next tick — not suppressed by a failed send
  });

  test("distinct identities / kinds are independent keys", () => {
    const d = new AlertDedup(1000, () => 0);
    d.record(alertKey("a", "idle-timeout"));
    expect(d.shouldFire(alertKey("a", "idle-timeout"))).toBe(false);
    expect(d.shouldFire(alertKey("a", "ghost-daemon"))).toBe(true); // same member, different kind
    expect(d.shouldFire(alertKey("b", "idle-timeout"))).toBe(true); // different member
  });

  test("rejects an invalid cooldown loudly", () => {
    expect(() => new AlertDedup(-1)).toThrow(/cooldownMs/);
    expect(() => new AlertDedup(NaN)).toThrow(/cooldownMs/);
  });

  test("REPLAY multi-generation: same member across dispatcher generations does NOT double-alert within the window", () => {
    let now = 0;
    const d = new AlertDedup(100_000, () => now);
    const k = alertKey("coord", "idle-timeout");
    // generation 1 alerts
    expect(d.shouldFire(k)).toBe(true); d.record(k);
    // generation 2 (a restart) observing the SAME condition shortly after must NOT re-alert (shared durable window)
    now += 500; expect(d.shouldFire(k)).toBe(false);
    now += 5000; expect(d.shouldFire(k)).toBe(false);
  });
});

describe("F44 sentinel-denoise — ② isValidInboxKey + scanInboxes filter", () => {
  test("UUID stableId accepted; garbage / bookkeeping rejected", () => {
    expect(isValidInboxKey(UUID)).toBe(true);
    expect(isValidInboxKey(UUID2)).toBe(true);
    for (const bad of ["_archive", "quarantine", ".DS_Store", ".hidden", "unknown", "garbage", "main", "coord-box", "", "01a0ff49"]) {
      expect(isValidInboxKey(bad)).toBe(false);
    }
  });

  test("REPLAY garbage directory: scanInboxes skips non-UUID / _archive dirs, only legit boxes are scanned", () => {
    const h = mkHome();
    const root = path.join(h, ".agenthop", "inbox");
    for (const [dir, file] of [[UUID, `${"1".padStart(16, "0")}.json`], ["_archive", "old.json"], ["garbage", "x.json"], [".hidden", "y.json"]] as const) {
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, file), "{}");
    }
    const stats = scanInboxes(h, () => false);
    expect(stats.map((s) => s.key)).toEqual([UUID]); // ONLY the legit box; _archive/garbage/.hidden skipped (no false stall)
  });
});

describe("F44 sentinel-denoise — ③④ classifyMemberHealth", () => {
  const cfg = { idleTimeoutSec: 600 };
  test("not idle long enough ⇒ ok", () => {
    expect(classifyMemberHealth({ onRoster: true, hasInFlight: true, idleSec: 10, presenceSeen: true }, cfg)).toBe("ok");
  });
  test("REPLAY legit idle: roster member idle with NO in-flight task ⇒ ok (no alert)", () => {
    expect(classifyMemberHealth({ onRoster: true, hasInFlight: false, idleSec: 9999, presenceSeen: true }, cfg)).toBe("ok");
  });
  test("roster member idle WITH in-flight work past timeout ⇒ disconnect-candidate", () => {
    expect(classifyMemberHealth({ onRoster: true, hasInFlight: true, idleSec: 601, presenceSeen: true }, cfg)).toBe("disconnect-candidate");
  });
  test("REPLAY ghost daemon: non-roster presence idle past timeout ⇒ ghost-daemon", () => {
    expect(classifyMemberHealth({ onRoster: false, hasInFlight: false, idleSec: 601, presenceSeen: true }, cfg)).toBe("ghost-daemon");
  });
  test("no presence ⇒ ok; NaN idle ⇒ ok (never convicts on an undefined duration)", () => {
    expect(classifyMemberHealth({ onRoster: false, hasInFlight: false, idleSec: 9999, presenceSeen: false }, cfg)).toBe("ok");
    expect(classifyMemberHealth({ onRoster: false, hasInFlight: false, idleSec: NaN, presenceSeen: true }, cfg)).toBe("ok");
  });
});

describe("F44 sentinel-denoise — ⑤ single-instance process-tree check", () => {
  const ps = (lines: ProcInfo[]): ProcInfo[] => lines;
  test("parsePsOutput parses pid/ppid/command, skips malformed lines", () => {
    const raw = "  100   1 node /x/tsx scripts/swarm-dispatch.ts\n 200 100 child\n(garbage line)\n";
    expect(parsePsOutput(raw)).toEqual([
      { pid: 100, ppid: 1, command: "node /x/tsx scripts/swarm-dispatch.ts" },
      { pid: 200, ppid: 100, command: "child" },
    ]);
  });
  test("isDispatcherLoopCommand: the loop yes; one-shot invocations no; unrelated no", () => {
    expect(isDispatcherLoopCommand("node /x/tsx scripts/swarm-dispatch.ts")).toBe(true);
    expect(isDispatcherLoopCommand("npx tsx scripts/swarm-dispatch.ts")).toBe(true);
    expect(isDispatcherLoopCommand("node tsx scripts/swarm-dispatch.ts --sweep-once")).toBe(false);
    expect(isDispatcherLoopCommand("node tsx scripts/swarm-dispatch.ts --observe-once r b l g")).toBe(false);
    expect(isDispatcherLoopCommand("node scripts/other.ts")).toBe(false);
  });
  test("selfTree walks self + ancestors via ppid", () => {
    const procs = ps([{ pid: 500, ppid: 400, command: "node .../tsx swarm-dispatch.ts" }, { pid: 400, ppid: 300, command: "npx tsx scripts/swarm-dispatch.ts" }, { pid: 300, ppid: 1, command: "sh" }]);
    expect([...selfTree(procs, 500)].sort((a, b) => a - b)).toEqual([300, 400, 500]);
  });
  test("our OWN wrapper tree is NOT a second dispatcher (self + npx/tsx ancestors excluded)", () => {
    const procs = ps([
      { pid: 500, ppid: 400, command: "node .../tsx scripts/swarm-dispatch.ts" }, // self (loop)
      { pid: 400, ppid: 300, command: "npx tsx scripts/swarm-dispatch.ts" },       // our npx wrapper (same tree)
      { pid: 300, ppid: 1, command: "sh -c ..." },
    ]);
    expect(isDispatcherAlreadyRunning(procs, 500)).toBe(false);
  });
  test("REPLAY multi-generation: a SECOND dispatcher tree (not ours) IS detected — covers the npx wrapper past the lock", () => {
    const procs = ps([
      { pid: 500, ppid: 400, command: "node .../tsx scripts/swarm-dispatch.ts" }, // self
      { pid: 400, ppid: 1, command: "npx tsx scripts/swarm-dispatch.ts" },
      { pid: 900, ppid: 800, command: "node .../tsx scripts/swarm-dispatch.ts" }, // a DIFFERENT generation's loop
      { pid: 800, ppid: 1, command: "npx tsx scripts/swarm-dispatch.ts" },        // its wrapper
    ]);
    expect(isDispatcherAlreadyRunning(procs, 500)).toBe(true);
  });
  test("a lone one-shot --sweep-once elsewhere is NOT a running loop", () => {
    const procs = ps([
      { pid: 500, ppid: 1, command: "node .../tsx scripts/swarm-dispatch.ts" },        // self loop
      { pid: 900, ppid: 1, command: "node .../tsx scripts/swarm-dispatch.ts --sweep-once" },
    ]);
    expect(isDispatcherAlreadyRunning(procs, 500)).toBe(false);
  });
});

describe("F44 sentinel-denoise — ⑥ shouldEmitWatchNotice", () => {
  test("board always notifies; PROGRESS off by default, opt-in via env", () => {
    expect(shouldEmitWatchNotice("board", undefined)).toBe(true);
    expect(shouldEmitWatchNotice("board", "")).toBe(true);
    expect(shouldEmitWatchNotice("progress", undefined)).toBe(false);
    expect(shouldEmitWatchNotice("progress", "0")).toBe(false);
    expect(shouldEmitWatchNotice("progress", "no")).toBe(false);
    for (const on of ["1", "true", "yes", "on", "YES", "On"]) expect(shouldEmitWatchNotice("progress", on)).toBe(true);
  });
});
