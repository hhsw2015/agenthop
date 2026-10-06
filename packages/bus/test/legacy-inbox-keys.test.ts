import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordSelfObserve, recordLearn, readIdentityLog, buildProjection, legacyInboxKeys, type SelfLike } from "../src/bus-identity.js";
import { writeInbox, claimInbox } from "../src/inbox.js";

// Isolate the alias-log + inbox under a temp HOME (identityDir/inboxDir default to <home>/.agenthop/...).
let HOME: string;
beforeEach(() => { HOME = mkdtempSync(path.join(os.tmpdir(), "ah-legacy-")); });
afterEach(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const self = (p: Partial<SelfLike> & { id: string }): SelfLike => ({ stableId: undefined, title: "t", tool: "codex", cwd: "/w", pid: 1, ...p });
const proj = () => { const l = readIdentityLog(HOME); return buildProjection(l.events, l.corruption); };
const msg = (text: string, ts: number) => ({ from: "x", fromLabel: "peer", text, via: "local" as const, ts });

// F40 ruling R15/R15-b: ONLY a shared durable native (conversation id) proves "same session across runs"; a shared per-run id
// is NOT proof. legacyInboxKeys recovers only the PRIOR-RUN boxes of entities sharing self.stableId as a hard native.
describe("F40 legacyInboxKeys (R15-b) — restart drains prior-run boxes; thread-switch siblings do NOT cross", () => {
  test("restart (same stableId, new run) recovers the OLD per-run box — but NOT a drifted-thread sibling box", () => {
    // RUN 1 boots as conv-1, then its active thread drifts conv-1 → thread-A (two DISTINCT entities, both on run-1).
    recordSelfObserve(HOME, self({ id: "run-1", stableId: "conv-1", pid: 100 }), true);
    recordLearn(HOME, "run-1", "conv-1", "thread-A", "thread-switch", true);
    // RUN 2 restarts the SAME conversation (stableId conv-1, new per-run id run-2).
    recordSelfObserve(HOME, self({ id: "run-2", stableId: "conv-1", pid: 200 }), true);

    const legacy = legacyInboxKeys(proj(), self({ id: "run-2", stableId: "conv-1", pid: 200 }));
    expect(legacy).toEqual(["run-1"]);          // the prior run's box — recovered
    expect(legacy).not.toContain("thread-A");   // a drifted-thread SIBLING is a distinct entity → left to the sentinel (R15-b)
    expect(legacy).not.toContain("conv-1");     // current native — already in inboxKeys()
    expect(legacy).not.toContain("run-2");
  });

  test("F40-1 counterexample: a same-run thread-switch A→B does NOT let B drain A's private box", () => {
    recordSelfObserve(HOME, self({ id: "run-1", stableId: "thread-A", pid: 100 }), true);
    recordLearn(HOME, "run-1", "thread-A", "thread-B", "thread-switch", true); // same run, A → B (distinct entities)
    writeInbox(HOME, "thread-A", msg("A-only-private", 1000));

    const me = self({ id: "run-1", stableId: "thread-B", pid: 100 }); // now on thread-B
    expect(legacyInboxKeys(proj(), me)).not.toContain("thread-A");    // the deleted run-id bridge: B must not inherit A
    // End-to-end: B's inboxKeys drain NOTHING of A's; A's private mail stays put.
    const keys = ["thread-B", "run-1", ...legacyInboxKeys(proj(), me)];
    expect(claimInbox(HOME, keys, "p").map((c) => c.msg.text)).not.toContain("A-only-private");
    expect(claimInbox(HOME, ["thread-A"], "p2").map((c) => c.msg.text)).toEqual(["A-only-private"]); // still waiting for A
  });

  test("restart end-to-end: the old per-run box is drained, the drifted-thread box is NOT (sentinel territory)", () => {
    recordSelfObserve(HOME, self({ id: "run-1", stableId: "conv-1", pid: 100 }), true);
    recordLearn(HOME, "run-1", "conv-1", "thread-A", "thread-switch", true);
    writeInbox(HOME, "conv-1", msg("to-stable", 1000));
    writeInbox(HOME, "run-1", msg("to-old-run", 1100));
    writeInbox(HOME, "thread-A", msg("to-drifted-thread", 1200));
    recordSelfObserve(HOME, self({ id: "run-2", stableId: "conv-1", pid: 200 }), true);

    const me = self({ id: "run-2", stableId: "conv-1", pid: 200 });
    const keys = ["conv-1", "run-2", ...legacyInboxKeys(proj(), me)];
    expect(claimInbox(HOME, keys, "p").map((c) => c.msg.text).sort()).toEqual(["to-old-run", "to-stable"]);
    expect(claimInbox(HOME, ["thread-A"], "p2").map((c) => c.msg.text)).toEqual(["to-drifted-thread"]); // left for the sentinel
  });

  test("no stableId ⇒ no inheritance (a shared run id alone is NOT same-session proof, R15)", () => {
    recordSelfObserve(HOME, self({ id: "run-1", stableId: "conv-1", pid: 100 }), true);
    expect(legacyInboxKeys(proj(), self({ id: "run-1", stableId: undefined, pid: 100 }))).toEqual([]);
  });

  test("a COLLISION native (two concurrent, different-cwd sessions share it) ⇒ inherit nothing (never steal mail)", () => {
    recordSelfObserve(HOME, self({ id: "run-a", stableId: "shared", cwd: "/a", pid: 100 }), true);
    recordSelfObserve(HOME, self({ id: "run-b", stableId: "shared", cwd: "/b", pid: 200 }), true);
    const p = proj();
    expect(p.collisions.has("shared")).toBe(true); // precondition: flagged ambiguous
    expect(legacyInboxKeys(p, self({ id: "run-a", stableId: "shared", cwd: "/a", pid: 100 }))).toEqual([]);
  });

  test("a DIFFERENT session's box is never adopted (no shared native)", () => {
    recordSelfObserve(HOME, self({ id: "run-1", stableId: "conv-1", pid: 100 }), true);
    recordSelfObserve(HOME, self({ id: "other-run", stableId: "other-conv", cwd: "/elsewhere", pid: 300 }), true);
    const legacy = legacyInboxKeys(proj(), self({ id: "run-1", stableId: "conv-1", pid: 100 }));
    expect(legacy).toEqual([]);
  });

  test("no prior identities ⇒ no legacy keys", () => {
    const only = self({ id: "run-1", stableId: "conv-1", pid: 100 });
    recordSelfObserve(HOME, only, true);
    expect(legacyInboxKeys(proj(), only)).toEqual([]);
  });
});
