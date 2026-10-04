import { describe, expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  scanCompletionSlots, parseCompletionArtifact, parseBoardFile, detectWatchEvents,
  readWatchSnapshot, writeWatchSnapshot, emptyWatchSnapshot,
  parseDeadLetters, countDeadLettersByRoute, routeKeyOf, routingGroupKey, routeKeyOfGroup, routingActiveSignal,
  type ReadArtifact, type WatchSnapshot,
} from "../src/swarm/delegation-observer.js";
import { openDelegation, observeCandidate, emptyDelegationRegistry, type OpenSpec, type CompletionSlot, type DelegationRegistry } from "../src/swarm/delegation-envelope.js";

/** L2-struct sub-increment 2/n (cluster-liveness §2b-c/§2c + coordinator watch-list): the durable-state observer — scan
 *  completion-slot locators into Candidates; diff the board/PROGRESS surfaces into pushable events. */

const slot = (over: Partial<CompletionSlot> = {}): CompletionSlot => ({ locator: "out/r/job-x/build/result.json", targetDigest: "sha-abc", resultFormat: "report", acceptor: "codex:verifier", ...over });
const spec = (over: Partial<OpenSpec> = {}): OpenSpec => ({ requestId: "job-x/build/r1", payloadDigest: "pd-1", payload: "do it", subject: { jobId: "job-x", revision: 1 }, completionSlot: slot(), owner: "rw-1", productionDeadlineSec: 5000, ...over });
const opened = (): DelegationRegistry => { const r = openDelegation(emptyDelegationRegistry(), spec(), 1000); if (!r.ok) throw new Error(r.reason); return r.registry; };

describe("scanCompletionSlots", () => {
  test("a production-phase slot with an artifact ⇒ a Candidate carrying the artifact's digest + record; absent ⇒ none", () => {
    const present: ReadArtifact = (loc) => loc === "out/r/job-x/build/result.json" ? { observedDigest: "sha-abc", record: { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } } } : null;
    const cands = scanCompletionSlots(opened(), present);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ observedLocator: "out/r/job-x/build/result.json", observedDigest: "sha-abc", record: { requestId: "job-x/build/r1" } });
    expect(scanCompletionSlots(opened(), () => null)).toEqual([]); // nothing on disk yet
  });

  test("a scanned candidate feeds observeCandidate end-to-end (discovery → verified transition)", () => {
    const read: ReadArtifact = () => ({ observedDigest: "sha-abc", record: { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } } });
    const cand = scanCompletionSlots(opened(), read)[0]!;
    const v = observeCandidate(opened(), cand, 1200, 1100);
    expect(v.verified).toBe(true);
  });

  test("a NON-production (already consumption) delegation is not re-scanned", () => {
    const read: ReadArtifact = () => ({ observedDigest: "sha-abc", record: { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 1 } } });
    const prod = observeCandidate(opened(), scanCompletionSlots(opened(), read)[0]!, 1200, 1100);
    if (!prod.verified) throw new Error("verify");
    expect(scanCompletionSlots(prod.registry, read)).toEqual([]); // consumption phase ⇒ not a production scan target
  });
});

describe("parseCompletionArtifact", () => {
  test("P1-1: observedDigest = the DECLARED workTarget (commit/spec domain), NOT a content hash", () => {
    const raw = JSON.stringify({ requestId: "job-x/build/r1", payloadDigest: "pd-1", workTarget: "f0a999f0000000000000000000000000000000ab", subject: { jobId: "job-x", revision: 8 } });
    expect(parseCompletionArtifact(raw)).toEqual({ observedDigest: "f0a999f0000000000000000000000000000000ab", record: { requestId: "job-x/build/r1", payloadDigest: "pd-1", subject: { jobId: "job-x", revision: 8 } } });
  });

  test("P2-1: null-safe — JSON null / non-object / invalid JSON / missing fields ⇒ null, never a throw", () => {
    expect(parseCompletionArtifact("null")).toBeNull();            // JSON null (the crash the reviewer hit)
    expect(parseCompletionArtifact("42")).toBeNull();              // non-object
    expect(parseCompletionArtifact('"a string"')).toBeNull();
    expect(parseCompletionArtifact("{ not json")).toBeNull();      // invalid JSON
    expect(parseCompletionArtifact(JSON.stringify({ requestId: "r", payloadDigest: "p", subject: { jobId: "j" } }))).toBeNull(); // no workTarget
    expect(parseCompletionArtifact(JSON.stringify({ requestId: "r", payloadDigest: "p", workTarget: "t" }))).toBeNull();          // no subject
    expect(parseCompletionArtifact(JSON.stringify({ requestId: "r", payloadDigest: "p", workTarget: "t", subject: null }))).toBeNull();
    expect(parseCompletionArtifact(JSON.stringify({ requestId: "r", payloadDigest: "p", workTarget: "t", subject: { revision: 1 } }))).toBeNull(); // no jobId
  });

  test("subject revision is optional (jobId-only subject is valid)", () => {
    const raw = JSON.stringify({ requestId: "r", payloadDigest: "p", workTarget: "t", subject: { jobId: "j" } });
    expect(parseCompletionArtifact(raw)).toEqual({ observedDigest: "t", record: { requestId: "r", payloadDigest: "p", subject: { jobId: "j" } } });
  });
});

describe("parseBoardFile", () => {
  test("claimed/done ⇒ {item,state,who}; posted ⇒ unclaimed; kebab items with dashes survive", () => {
    expect(parseBoardFile("liveness-impl-L2.claimed.20cab0a5.json")).toEqual({ item: "liveness-impl-L2", state: "claimed", who: "20cab0a5" });
    expect(parseBoardFile("pure-layer-f-coverage.done.f32a0507.json")).toEqual({ item: "pure-layer-f-coverage", state: "done", who: "f32a0507" });
    expect(parseBoardFile("selftest-backport.json")).toEqual({ item: "selftest-backport", state: "posted", who: "" });
    expect(parseBoardFile("not-json.txt")).toBeNull();
  });
});

describe("detectWatchEvents", () => {
  test("a newly-seen board file ⇒ a board event; a changed PROGRESS mtime ⇒ a progress event", () => {
    const prev: WatchSnapshot = { boardFiles: ["a.posted.json", "liveness-impl-L2.json"], progressMtimeMs: 1000 };
    const curr: WatchSnapshot = { boardFiles: ["a.posted.json", "liveness-impl-L2.claimed.20cab0a5.json"], progressMtimeMs: 2000 };
    const events = detectWatchEvents(prev, curr);
    expect(events).toContainEqual({ kind: "board", file: "liveness-impl-L2.claimed.20cab0a5.json", item: "liveness-impl-L2", state: "claimed", who: "20cab0a5" });
    expect(events).toContainEqual({ kind: "progress", mtimeMs: 2000 });
    expect(events.filter((e) => e.kind === "board")).toHaveLength(1); // the unchanged a.posted.json is not re-fired
  });

  test("first run (prev progressMtime 0) does NOT fire a spurious progress event; unchanged ⇒ no events", () => {
    const curr: WatchSnapshot = { boardFiles: ["x.json"], progressMtimeMs: 500 };
    expect(detectWatchEvents(emptyWatchSnapshot(), curr).some((e) => e.kind === "progress")).toBe(false); // mtime from 0 is initial, not a change
    expect(detectWatchEvents(curr, curr)).toEqual([]); // steady state ⇒ silent
  });
});

describe("dead-letter watch (F26)", () => {
  test("parseDeadLetters: JSONL null-safe — blank/malformed/partial/null skipped; maxLines bounds to the most-recent N", () => {
    const jsonl = [
      JSON.stringify({ ts: 100, from: "claude:A", to: "codex:B", error: "unresolved", preview: "hi" }),
      "", "{ not json", "null",                            // blank / malformed / JSON null ⇒ skipped
      JSON.stringify({ ts: 200, to: "codex:B" }),          // from-less is kept here (routeKeyOf decides route identity)
      JSON.stringify({ to: "codex:B" }),                   // no ts ⇒ skipped
    ].join("\n");
    const out = parseDeadLetters(jsonl);
    expect(out).toEqual([{ ts: 100, from: "claude:A", to: "codex:B", error: "unresolved", preview: "hi" }, { ts: 200, to: "codex:B" }]);
    // maxLines keeps only the last N raw lines (a verifiable read budget, P2-3)
    const many = Array.from({ length: 10 }, (_, i) => JSON.stringify({ ts: i, from: "a", to: "b" })).join("\n");
    expect(parseDeadLetters(many, 3)).toHaveLength(3);
  });

  test("P2-1 route-pair identity: routeKeyOf = (from→to); from-less ⇒ null (diagnostic, not a route)", () => {
    expect(routeKeyOf({ ts: 1, from: "claude:A", to: "codex:X" })).toBe("claude%3AA->codex%3AX");
    expect(routeKeyOf({ ts: 1, to: "codex:X" })).toBeNull();                  // no from ⇒ no route-pair identity
    expect(routeKeyOfGroup(routingGroupKey("claude%3AA->codex%3AX"))).toBe("claude%3AA->codex%3AX"); // round-trips
    expect(routeKeyOfGroup("liveness:x")).toBeNull();
  });

  test("countDeadLettersByRoute: per ROUTE PAIR (A→X and B→X don't merge); sliding window; from-less excluded", () => {
    const entries = [
      { ts: 50, from: "A", to: "X" },   // aged out (window start 100)
      { ts: 150, from: "A", to: "X" }, { ts: 160, from: "A", to: "X" },
      { ts: 170, from: "B", to: "X" },  // SAME `to`, DIFFERENT route ⇒ separate count
      { ts: 180, to: "X" },             // from-less ⇒ excluded
    ];
    const counts = countDeadLettersByRoute(entries, 100);
    expect(counts.get(routeKeyOf({ ts: 0, from: "A", to: "X" })!)).toBe(2); // A→X: the ts=50 is aged out
    expect(counts.get(routeKeyOf({ ts: 0, from: "B", to: "X" })!)).toBe(1); // B→X: separate, not merged with A→X
    expect(counts.size).toBe(2);                                            // from-less did not create a phantom route
  });

  test("routingActiveSignal: builds an ACTIVE signal keyed by the route-pair groupKey (no recovered signal exists, P1-1)", () => {
    const route = routeKeyOf({ ts: 0, from: "A", to: "X" })!;
    expect(routingActiveSignal(route, 4, 42)).toEqual({ kind: "active", groupKey: routingGroupKey(route), category: "routing", why: `4 dead-letters on route ${route} within window`, lastObservedSeq: 42, subjectJobId: "swarm-routing" });
  });
});

describe("readWatchSnapshot / writeWatchSnapshot", () => {
  test("round-trips atomically; missing ⇒ empty; corrupt ⇒ throws (no silent reset that re-fires every file)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "watch-"));
    const file = path.join(dir, "watch-snapshot.json");
    expect(readWatchSnapshot(file)).toEqual({ boardFiles: [], progressMtimeMs: 0 });
    const snap: WatchSnapshot = { boardFiles: ["x.claimed.me.json"], progressMtimeMs: 1234 };
    writeWatchSnapshot(file, snap);
    expect(existsSync(file)).toBe(true);
    expect(readWatchSnapshot(file)).toEqual(snap);
    writeFileSync(file, "{ nope");
    expect(() => readWatchSnapshot(file)).toThrow();
  });
});
