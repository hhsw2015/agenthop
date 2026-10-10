import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AlertDedup, alertKey, isValidInboxKey, classifyMemberHealth, GhostOnce, isOnRoster, classifyBlockedEscalation, resolveSnapshotMembers,
  parsePsOutput, selfTree, isDispatcherLoopCommand, isDispatcherAlreadyRunning, shouldEmitWatchNotice,
  screenIndicatesContentFilter, contentFilterHintNote, CONTENT_FILTER_ANCHORS,
  classifyFailure, failureHintNote,
  type ProcInfo, type FailureClass,
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

  test("same-instance cooldown: an identical event within the window does NOT re-alert", () => {
    // Scope note (F44-N1): AlertDedup is in-memory, per dispatcher instance — this is a SAME-INSTANCE cooldown, NOT a
    // cross-restart durable claim. A dispatcher restart constructs a fresh AlertDedup (empty state); the ⑤ process-tree
    // check is what prevents a second concurrent dispatcher, not this map.
    let now = 0;
    const d = new AlertDedup(100_000, () => now);
    const k = alertKey("coord", "idle-timeout");
    expect(d.shouldFire(k)).toBe(true); d.record(k);
    now += 500; expect(d.shouldFire(k)).toBe(false);  // same instance, still inside the window
    now += 5000; expect(d.shouldFire(k)).toBe(false); // still inside 100s
    now += 100_000; expect(d.shouldFire(k)).toBe(true); // window elapsed ⇒ fireable again
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

describe("F44-⑨ isOnRoster — union of ALL roster sources (identity log + in-flight owners + roster-snapshot)", () => {
  const S = (...xs: string[]) => new Set(xs);
  test("in roster-snapshot only ⇒ on roster (the 3e097dfe incident: registered member, no in-flight, no identity entity)", () => {
    expect(isOnRoster("3e097dfe", { activeOwners: S(), identityEntity: false, snapshotMembers: S("3e097dfe") })).toBe(true);
  });
  test("an in-flight owner ⇒ on roster", () => {
    expect(isOnRoster("x", { activeOwners: S("x"), identityEntity: false, snapshotMembers: S() })).toBe(true);
  });
  test("an identity-log entity ⇒ on roster", () => {
    expect(isOnRoster("x", { activeOwners: S(), identityEntity: true, snapshotMembers: S() })).toBe(true);
  });
  test("in NO source ⇒ not on roster (a genuine stray ⇒ still a ghost)", () => {
    expect(isOnRoster("stray", { activeOwners: S("other"), identityEntity: false, snapshotMembers: S("member") })).toBe(false);
  });
});

describe("F44-⑧ classifyBlockedEscalation — roster-gate the blocked alert", () => {
  test("roster member blocked ⇒ escalate (swarm work)", () => {
    expect(classifyBlockedEscalation(true)).toBe("escalate");
  });
  test("non-roster (e.g. user's private session) blocked ⇒ escalate-once (not repeated coordinator noise)", () => {
    expect(classifyBlockedEscalation(false)).toBe("escalate-once");
  });
});

describe("F44-9 resolveSnapshotMembers — map snapshot handles to current SIDs (not raw member strings)", () => {
  // the 3e097dfe incident: assembleRoster emitted member="Work-3e097dfe"; presence has the full sid.
  const sids = ["3e097dfe-81b3-4cca-b678-80dd3480a203", "90b58f9c-5bac-4318-a996-2373c179d674"];
  const resolve = (h: string) => { // mirrors resolveSession(h, sids)
    if (sids.includes(h)) return h;
    const tail = h.slice(h.lastIndexOf("-") + 1);
    const hit = sids.filter((s) => s.startsWith(tail));
    return hit.length === 1 ? hit[0] : null;
  };
  test("a short handle resolves to its full SID (ghost false-positive fixed)", () => {
    const set = resolveSnapshotMembers([{ member: "Work-3e097dfe" }], resolve);
    expect(set.has("3e097dfe-81b3-4cca-b678-80dd3480a203")).toBe(true);
  });
  test("a full SID resolves to itself", () => {
    expect(resolveSnapshotMembers([{ member: "90b58f9c-5bac-4318-a996-2373c179d674" }], resolve).has("90b58f9c-5bac-4318-a996-2373c179d674")).toBe(true);
  });
  test("an ambiguous/unknown handle is dropped (never guessed)", () => {
    expect(resolveSnapshotMembers([{ member: "Work-nope" }], resolve).size).toBe(0);
  });
  test("non-array / malformed members ⇒ empty", () => {
    expect(resolveSnapshotMembers(null as any, resolve).size).toBe(0);
    expect(resolveSnapshotMembers([{ notmember: "x" }, 42], resolve).size).toBe(0);
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
    // F44-P1-1: a mere file reference is NOT a running loop — only a JS runtime actually executes it.
    expect(isDispatcherLoopCommand("nvim scripts/swarm-dispatch.ts")).toBe(false);
    expect(isDispatcherLoopCommand("git diff -- scripts/swarm-dispatch.ts")).toBe(false);
    expect(isDispatcherLoopCommand("rg swarm-dispatch.ts scripts")).toBe(false);
    expect(isDispatcherLoopCommand("cat scripts/swarm-dispatch.ts")).toBe(false);
    // F44-P1-1: eval-style — the path is DATA inside the eval string, not a script entry.
    expect(isDispatcherLoopCommand("node -e setInterval(()=>0,1) scripts/swarm-dispatch.ts")).toBe(false);
    expect(isDispatcherLoopCommand("node --eval require('./scripts/swarm-dispatch.ts')")).toBe(false);
    // F44-P1-1: the one-shot exclusion mirrors main()'s EXACT argv[0] parse — a NON-first --sweep-once still runs the loop.
    expect(isDispatcherLoopCommand("node /x/tsx scripts/swarm-dispatch.ts --unused --sweep-once")).toBe(true);
    expect(isDispatcherLoopCommand("node /x/tsx scripts/swarm-dispatch.ts --observe-once")).toBe(false);
    // F44-P1-1 (round-2): a JS TOOL whose OWN entry is another script, with swarm-dispatch.ts a mere business ARG ⇒ NOT the loop.
    expect(isDispatcherLoopCommand("node tools/analyze.mjs scripts/swarm-dispatch.ts")).toBe(false);
    expect(isDispatcherLoopCommand("node /x/node_modules/prettier/bin/prettier.cjs --check scripts/swarm-dispatch.ts")).toBe(false);
    expect(isDispatcherLoopCommand("npx prettier --check scripts/swarm-dispatch.ts")).toBe(false);
    expect(isDispatcherLoopCommand("pnpm exec prettier scripts/swarm-dispatch.ts")).toBe(false);
    // F44-P1-1 (round-2): the `--eval=` EQUALS form is eval-before-entry ⇒ NOT the loop.
    expect(isDispatcherLoopCommand("node --eval=process.stdout.write('x');setInterval(()=>0,1) scripts/swarm-dispatch.ts")).toBe(false);
    // F44-P1-1 (round-2): an -e/--eval/-p AFTER the entry is the dispatcher's own application arg ⇒ STILL the loop.
    expect(isDispatcherLoopCommand("node scripts/swarm-dispatch.ts -e")).toBe(true);
    expect(isDispatcherLoopCommand("node /x/tsx scripts/swarm-dispatch.ts --eval")).toBe(true);
    expect(isDispatcherLoopCommand("tsx scripts/swarm-dispatch.ts --unused -p")).toBe(true);
    // F44-P1-1 (round-2): real wrappers / nested tsx cli / value-taking node options remain DETECTED.
    expect(isDispatcherLoopCommand("node /x/node_modules/tsx/dist/cli.mjs scripts/swarm-dispatch.ts")).toBe(true);
    expect(isDispatcherLoopCommand("node --require /x/tsx/preflight.cjs --import file:///x/tsx/loader.mjs scripts/swarm-dispatch.ts")).toBe(true);
    expect(isDispatcherLoopCommand("pnpm exec tsx scripts/swarm-dispatch.ts")).toBe(true);
    // F44-P1-1 (round-3) — an UNKNOWN value-taking option must NOT let its value masquerade as the entry: the real entry is a
    // later tool, so do not refuse-to-start on it.
    expect(isDispatcherLoopCommand("node --redirect-warnings /x/scripts/swarm-dispatch.ts /x/warnings-tool.mjs")).toBe(false);
    expect(isDispatcherLoopCommand("node --diagnostic-dir /x/swarm-dispatch.ts /x/tool.mjs")).toBe(false);
    // F44-P1-1 (round-3) — a mere `tsx/` DIRECTORY member is an ordinary tool, not a runtime cli; swarm-dispatch.ts is its arg.
    expect(isDispatcherLoopCommand("node /x/node_modules/fixture-tsx/tsx/analyzer.mjs scripts/swarm-dispatch.ts")).toBe(false);
    // F44-P1-1 (round-3) — but a KNOWN loader value that itself LOOKS like a dispatch entry is still consumed by --import; the
    // REAL entry is the next positional ⇒ STILL the loop.
    expect(isDispatcherLoopCommand("node --import /tmp/swarm-dispatch.ts /real/scripts/swarm-dispatch.ts")).toBe(true);
    // F44-P1-1 (round-3) — an EXPLICIT ts-node cli entrypoint (dist/bin.js) resolves to its next positional ⇒ the loop.
    expect(isDispatcherLoopCommand("node /x/node_modules/ts-node/dist/bin.js scripts/swarm-dispatch.ts")).toBe(true);
    // F44-P1-1 (round-3) — npx `-y` plus `-p <pkg>` value flags are unwrapped before the tsx runtime ⇒ the loop.
    expect(isDispatcherLoopCommand("npx -y -p tsx tsx scripts/swarm-dispatch.ts")).toBe(true);
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

describe("F44 sentinel-denoise — P2-3 GhostOnce (one-time-per-episode gate)", () => {
  test("fires once while a member stays a ghost, even past a cooldown window", () => {
    const g = new GhostOnce();
    let fires = 0;
    for (let tick = 0; tick < 4; tick++) {
      g.reconcile(["m1"]);              // m1 still a ghost every tick
      if (g.shouldFire("m1")) { fires++; g.record("m1"); }
    }
    expect(fires).toBe(1);             // NOT re-reminded each tick (contrast AlertDedup cooldown)
  });

  test("re-fires after a member LEAVES the ghost state and returns", () => {
    const g = new GhostOnce();
    g.reconcile(["m1"]); expect(g.shouldFire("m1")).toBe(true); g.record("m1");
    g.reconcile(["m1"]); expect(g.shouldFire("m1")).toBe(false); // still a ghost ⇒ silent
    g.reconcile([]);                                              // m1 recovered (no longer a ghost) ⇒ forgotten
    g.reconcile(["m1"]); expect(g.shouldFire("m1")).toBe(true);  // re-ghost ⇒ fires again
  });

  test("tracks members independently; an undelivered ghost (not recorded) retries next tick", () => {
    const g = new GhostOnce();
    g.reconcile(["m1", "m2"]);
    expect(g.shouldFire("m1")).toBe(true); g.record("m1"); // m1 delivered
    expect(g.shouldFire("m2")).toBe(true);                 // m2 send failed ⇒ NOT recorded
    g.reconcile(["m1", "m2"]);
    expect(g.shouldFire("m1")).toBe(false);                // m1 already alerted
    expect(g.shouldFire("m2")).toBe(true);                 // m2 retries
  });
});

describe("sentinel-denoise — F44-⑩ content-filter HINT (annotates, never replaces an approval)", () => {
  const codex = "Working...\nThis content can't be shown\nDaybreak\n"; // observed codex platform block
  test("detects a known vendor string (exact, mixed case, typographic apostrophe, embedded)", () => {
    expect(screenIndicatesContentFilter(codex)).toBe(true);
    expect(screenIndicatesContentFilter("THIS CONTENT CAN'T BE SHOWN")).toBe(true);        // case-insensitive
    expect(screenIndicatesContentFilter("this content can’t be shown … Daybreak")).toBe(true); // ’ folded to '
    expect(screenIndicatesContentFilter("…noise… content can't be shown …more…")).toBe(true);  // substring anywhere
  });
  test("a normal/approval screen is not a hint; non-string/empty ⇒ false", () => {
    expect(screenIndicatesContentFilter("Allow command rm -rf? (y/n)")).toBe(false);
    expect(screenIndicatesContentFilter("Waiting for your approval to continue")).toBe(false);
    expect(screenIndicatesContentFilter("")).toBe(false);
    expect(screenIndicatesContentFilter(undefined as unknown as string)).toBe(false);
    expect(screenIndicatesContentFilter(42 as unknown as string)).toBe(false);
  });
  test("every anchor is pre-normalized (lowercase, ASCII apostrophe) so it matches a normalized screen", () => {
    for (const a of CONTENT_FILTER_ANCHORS) {
      expect(a).toBe(a.toLowerCase());
      expect(a).not.toMatch(/[‘’“”ʼ]/);                 // no typographic marks that a folded screen could never contain
      expect(screenIndicatesContentFilter(a)).toBe(true); // an anchor matches itself
    }
  });
  test("F44-10-N1: the hint note is NEUTRAL — a clue not a verdict, defers to platform guidance, no bypass license, S19 intact", () => {
    const note = contentFilterHintNote();
    expect(note).toMatch(/线索/);                 // framed as a clue, not proof of the current block
    expect(note).toMatch(/不证明当前阻塞/);        // explicitly not a verdict on the current block
    expect(note).toMatch(/平台说明/);              // defer to the platform's own guidance
    expect(note).toMatch(/合规范围内/);            // only an in-policy reword
    expect(note).toMatch(/不构成绕过限制的许可/);   // NOT a license to bypass the limit
    expect(note).toMatch(/S19/);                  // the approval boundary is unchanged
  });

  // D-multica ① — failure taxonomy
  test("classifyFailure buckets each class", () => {
    expect(classifyFailure("Error: 503 Service Unavailable")).toBe("retryable");
    expect(classifyFailure("ECONNRESET while connecting")).toBe("retryable");
    expect(classifyFailure("got 429, rate limit")).toBe("retryable");
    expect(classifyFailure("HTTP 401 Unauthorized")).toBe("non-retryable");
    expect(classifyFailure("402 Payment Required")).toBe("non-retryable");
    expect(classifyFailure("invalid api key")).toBe("non-retryable");
    expect(classifyFailure("maximum context length exceeded")).toBe("context-exhausted");
    expect(classifyFailure("Error: Cannot find module 'foo'")).toBe("environment");
    expect(classifyFailure("ENOENT: no such file or directory")).toBe("environment");
  });

  test("classifyFailure: number-boundary guard — 401 inside a larger number is NOT a status code", () => {
    expect(classifyFailure("processed 2401 rows in 5000 ms")).toBe("unknown"); // 2401 / 5000 are not 401 / 5xx
    expect(classifyFailure("line 50123 of 40199")).toBe("unknown");            // no standalone 5xx / 4xx code
    expect(classifyFailure("vite on port 5173")).toBe("unknown");             // 5173 is not a 3-digit 5xx
  });

  test("classifyFailure: non-retryable WINS over a co-present 5xx (the 401-never-retries rail)", () => {
    expect(classifyFailure("saw 500 earlier; now 401 Unauthorized")).toBe("non-retryable");
  });

  test("classifyFailure: unknown / empty / non-string ⇒ unknown (the safe direction)", () => {
    expect(classifyFailure("just some ordinary screen output")).toBe("unknown");
    expect(classifyFailure("")).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
    expect(classifyFailure(12345)).toBe("unknown");
  });

  test("failureHintNote: a HINT only — restates disposition stays with S19, unknown has no note", () => {
    expect(failureHintNote("unknown")).toBe("");                 // no annotation for an unknown class
    const classes: FailureClass[] = ["retryable", "non-retryable", "context-exhausted", "environment"];
    for (const c of classes) {
      const note = failureHintNote(c);
      expect(note).toMatch(/线索/);        // framed as a clue
      expect(note).toMatch(/S19|审批/);    // disposition stays with S19/approval
    }
    expect(failureHintNote("non-retryable")).toMatch(/不应自动重试/); // explicitly never auto-retry
  });
});
