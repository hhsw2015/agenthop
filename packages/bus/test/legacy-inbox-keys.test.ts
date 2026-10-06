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

describe("F40 legacyInboxKeys — drain a prior identity's inbox after a restart / thread drift", () => {
  test("incident replay: routing-name box + old run-id box are drained by the new term (same conversation, new run)", () => {
    // RUN 1: a Codex session boots as conv-1, then its active thread DRIFTS conv-1 → thread-A (the a058b168 case).
    const run1 = self({ id: "run-1", stableId: "conv-1", pid: 100 });
    recordSelfObserve(HOME, run1, true);
    recordLearn(HOME, "run-1", "conv-1", "thread-A", "thread-switch", true);

    // Mail arrives addressed three ways while run 1 is up: to the stable conv id, to the OLD per-run id, and to the DRIFTED
    // thread id (what a stale routing name "codex:w-thread-A" resolved to). All three land in durable boxes.
    writeInbox(HOME, "conv-1", msg("to-stable", 1000));
    writeInbox(HOME, "run-1", msg("to-old-run", 1100));
    writeInbox(HOME, "thread-A", msg("to-drifted-thread", 1200));

    // RUN 2: the conversation RESTARTS — SAME stableId conv-1, a NEW per-run id run-2.
    const run2 = self({ id: "run-2", stableId: "conv-1", pid: 200 });
    recordSelfObserve(HOME, run2, true);

    // The new term discovers its prior-identity boxes from the alias-log: the old run id AND the drifted thread.
    const legacy = legacyInboxKeys(proj(), run2);
    expect(new Set(legacy)).toEqual(new Set(["run-1", "thread-A"]));
    expect(legacy).not.toContain("conv-1"); // current identity — already in inboxKeys()
    expect(legacy).not.toContain("run-2");

    // End-to-end: inboxKeys() = [stableId, runId, ...legacy] drains EVERY box — nothing stranded.
    const keys = ["conv-1", "run-2", ...legacy];
    const drained = claimInbox(HOME, keys, "p").map((c) => c.msg.text).sort();
    expect(drained).toEqual(["to-drifted-thread", "to-old-run", "to-stable"]);
  });

  test("a DIFFERENT session's box is never adopted (no shared key ⇒ not my lineage)", () => {
    recordSelfObserve(HOME, self({ id: "run-1", stableId: "conv-1", pid: 100 }), true);
    recordSelfObserve(HOME, self({ id: "other-run", stableId: "other-conv", cwd: "/elsewhere", pid: 300 }), true);
    const legacy = legacyInboxKeys(proj(), self({ id: "run-1", stableId: "conv-1", pid: 100 }));
    expect(legacy).not.toContain("other-conv");
    expect(legacy).not.toContain("other-run");
  });

  test("a COLLISION native (two concurrent, different-cwd sessions share it) is NOT crossed — never steal mail", () => {
    // Two live sessions claim the SAME native "shared" from different cwds + pids, overlapping in time ⇒ projection flags a
    // collision. Draining across it could steal the other session's mail, so legacyInboxKeys must refuse to adopt it.
    recordSelfObserve(HOME, self({ id: "run-a", stableId: "shared", cwd: "/a", pid: 100 }), true);
    recordSelfObserve(HOME, self({ id: "run-b", stableId: "shared", cwd: "/b", pid: 200 }), true);
    const p = proj();
    expect(p.collisions.has("shared")).toBe(true); // precondition: it IS flagged ambiguous
    // From run-a's view, "shared" is its own stableId (anchor) but the OTHER session's run-b must not be pulled in through it.
    const legacy = legacyInboxKeys(p, self({ id: "run-a", stableId: "shared", cwd: "/a", pid: 100 }));
    expect(legacy).not.toContain("run-b");
  });

  test("no prior identities ⇒ no legacy keys (a fresh session)", () => {
    const only = self({ id: "run-1", stableId: "conv-1", pid: 100 });
    recordSelfObserve(HOME, only, true);
    expect(legacyInboxKeys(proj(), only)).toEqual([]);
  });
});
