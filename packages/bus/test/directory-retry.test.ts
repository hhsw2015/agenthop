// FH-RELAY-1 fixture: the directory's first announce can fail (room not ready ⇒ a real 404 — the diagnosed flake). Before the fix
// the next send was only the 60s heartbeat, so a competitor stayed undiscovered past the test's deadline. The fix retries the
// LATEST failed announce on the existing 5s poll (failedAnnounceRev), keeping normal announces concurrent (NOT a global serialize).
//
// Deterministic by construction (a flake fix must not add another flake): @agenthop/cli is mocked so sendMessage is a manual
// promise we resolve/reject, startHost throws room_taken (we are a plain member), readQueue is empty; fake timers drive the 5s poll
// and 60s beat. This reproduces the exact failed-announce condition with reliable teeth (test #1 is RED without failedAnnounceRev —
// the poll does not re-send), which is stronger than a real-relay 200ms-delay test for a flake fix. The three new-law fixture
// classes map on: crash-recovery = a failed send recovered by the poll retry (#1, #6); concurrency-race = a held send must not
// block a later update / an old or obsolete completion must not corrupt the retry obligation (#2, #3, #4); idempotency/robustness =
// a held retry is not duplicated by polls, and close suppresses it (#5, #7).
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as { text: string; resolve: (x: unknown) => void; reject: (e: Error) => void }[] }));
vi.mock("@agenthop/cli", () => ({
  DEFAULT_RELAY: "http://127.0.0.1:1",
  startHost: async () => { throw new Error("room_taken"); }, // lose the keeper election ⇒ we are a plain member (announce + read)
  readQueue: async () => ({ events: [], generation: "fixed" }),
  sendMessage: (o: { text: string }) => new Promise((resolve, reject) => state.calls.push({ text: o.text, resolve, reject })),
}));

import { startDirectory, type Directory, type RemotePeer } from "../src/directory.js";
import { deriveTeam, openEntry } from "../src/team.js";

const team = deriveTeam("private-relay-retry-control");
const self: RemotePeer = { id: "test-peer", tool: "test", cwd: "/private", title: "test", machine: "private", pub: "key", ts: 1 };
let dir: Directory;

async function settle(): Promise<void> { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function sent(i: number): RemotePeer { return JSON.parse(openEntry(team.nsKey, state.calls[i]!.text.slice("[[agenthop:bus-presence]] ".length))); }

beforeEach(async () => { vi.useFakeTimers(); state.calls.length = 0; dir = startDirectory({ team, self, relay: "http://127.0.0.1:1" }); await settle(); });
afterEach(async () => { await dir.close(); vi.useRealTimers(); });

test("FH-RELAY-1 (crash-recovery / TEETH): a failed latest announce is retried on the next poll; a healthy poll does not re-send", async () => {
  expect(state.calls).toHaveLength(1);
  state.calls[0]!.reject(new Error("404 not found")); await settle(); expect(state.calls).toHaveLength(1); // no instant resend
  await vi.advanceTimersByTimeAsync(5000); expect(state.calls).toHaveLength(2);                              // the 5s poll retries the failed announce
  state.calls[1]!.resolve({}); await settle(); await vi.advanceTimersByTimeAsync(15000); expect(state.calls).toHaveLength(2); // success ⇒ no further retries
});

test("FH-RELAY-1 (concurrency): a held original send does not block an ordinary update or the heartbeat", async () => {
  dir.updateSelf({ ...self, status: "working", statusSeq: 10 });
  expect(state.calls).toHaveLength(2); expect(sent(1)).toMatchObject({ status: "working", statusSeq: 10 });
  state.calls[1]!.resolve({}); await settle();
  await vi.advanceTimersByTimeAsync(60000); expect(state.calls).toHaveLength(3);
  expect(sent(2)).toMatchObject({ status: "working", statusSeq: 10 });
  state.calls[2]!.resolve({}); state.calls[0]!.resolve({}); await settle();
});

test("FH-RELAY-1 (concurrency): an old success cannot clear a newer failed announcement", async () => {
  dir.updateSelf({ ...self, status: "working", statusSeq: 10 }); expect(state.calls).toHaveLength(2);
  state.calls[1]!.reject(new Error("newer transient failure")); await settle();
  state.calls[0]!.resolve({}); await settle();
  await vi.advanceTimersByTimeAsync(5000); expect(state.calls).toHaveLength(3);
  expect(sent(2)).toMatchObject({ status: "working", statusSeq: 10 }); state.calls[2]!.resolve({}); await settle();
});

test("FH-RELAY-1 (concurrency): an obsolete failure after a newer success cannot create retry work", async () => {
  dir.updateSelf({ ...self, status: "idle", statusSeq: 20 }); expect(state.calls).toHaveLength(2);
  state.calls[1]!.resolve({}); await settle(); state.calls[0]!.reject(new Error("old transient failure")); await settle();
  await vi.advanceTimersByTimeAsync(15000); expect(state.calls).toHaveLength(2);
});

test("FH-RELAY-1 (idempotency): a held retry is not duplicated by polls and does not block an ordinary update", async () => {
  state.calls[0]!.reject(new Error("404 not found")); await settle();
  await vi.advanceTimersByTimeAsync(5000); expect(state.calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(15000); expect(state.calls).toHaveLength(2); // still in flight ⇒ no duplicate retry
  dir.updateSelf({ ...self, status: "idle", statusSeq: 20 }); expect(state.calls).toHaveLength(3);
  state.calls[2]!.resolve({}); await settle(); state.calls[1]!.reject(new Error("obsolete retry failed")); await settle();
  await vi.advanceTimersByTimeAsync(15000); expect(state.calls).toHaveLength(3);
});

test("FH-RELAY-1 (recovery): each relevant failed completion authorizes exactly one later retry", async () => {
  state.calls[0]!.reject(new Error("transient1")); await settle();
  await vi.advanceTimersByTimeAsync(5000); expect(state.calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(10000); expect(state.calls).toHaveLength(2);
  state.calls[1]!.reject(new Error("transient2")); await settle(); expect(state.calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(5000); expect(state.calls).toHaveLength(3);
  state.calls[2]!.resolve({}); await settle();
});

test("FH-RELAY-1 (close): close suppresses a pending retry and later ordinary updates", async () => {
  await dir.close(); state.calls[0]!.reject(new Error("404 not found")); await settle();
  dir.updateSelf({ ...self, status: "idle", statusSeq: 20 });
  await vi.advanceTimersByTimeAsync(120000); expect(state.calls).toHaveLength(1);
});
