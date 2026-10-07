import { describe, expect, test } from "vitest";
import { superviseMember, decideLiveSentinel, type WatchOps, type WatchCfg, type WaitOutcome, type SentinelEvent, type MemberObs } from "../src/swarm/live-sentinel.js";
import type { AgentState } from "../src/swarm/herdr.js";

const cfg: WatchCfg = { fakeDeathSec: 900, idleTimeoutSec: 1800, reArmSec: 1800, doneWakeSec: 1800, sampleSec: 60, backoffSec: 60 };

// Scripted WatchOps. `states` is the terminator: when its queue is exhausted it throws, ending the loop so the test can
// assert the events emitted so far. Other queues return a benign default when exhausted. `now` follows nowSeq (clamped) or
// auto-increments. sleep resolves immediately.
const END = "script-end";
type Script = {
  states: AgentState[];
  paneId?: (string | null)[];
  contentHash?: string[];
  waitOutput?: Array<"output" | "timeout" | "error">;
  waitLeave?: WaitOutcome[];
  explain?: string;
  nowSeq?: number[];
};
function makeOps(s: Script): { ops: WatchOps; events: SentinelEvent[] } {
  const events: SentinelEvent[] = [];
  let si = 0, pi = 0, ci = 0, oi = 0, li = 0, ni = 0;
  const take = <T>(arr: T[] | undefined, i: number, dflt: T): T => (!arr || i >= arr.length ? dflt : arr[i]!);
  return {
    events,
    ops: {
      state: async () => { if (si >= s.states.length) throw new Error(END); return s.states[si++]!; },
      paneId: async () => take(s.paneId, pi++, "p"),
      contentHash: async () => take(s.contentHash, ci++, "h0"),
      waitOutput: async () => take(s.waitOutput, oi++, "timeout"),
      waitLeave: async () => take(s.waitLeave, li++, { state: "unknown", outcome: "timeout" }),
      explain: async () => s.explain ?? "",
      emit: (ev) => events.push(ev),
      now: () => (s.nowSeq ? s.nowSeq[Math.min(ni++, s.nowSeq.length - 1)]! : ni++),
      sleep: async () => { /* immediate */ },
      stopped: () => false,
    },
  };
}
const run = async (s: Script): Promise<SentinelEvent[]> => {
  const { ops, events } = makeOps(s);
  await superviseMember("m", ops, cfg).catch((e) => { if ((e as Error).message !== END) throw e; });
  return events;
};

describe("live-sentinel superviseMember v3 (herdr primitives; content-diff fake-death; wait-outcome idle)", () => {
  test("blocked ⇒ explain + emit blocked, then wait to leave blocked", async () => {
    expect(await run({ states: ["blocked"], explain: "safety stop", waitLeave: [{ state: "working", outcome: "reached" }] }))
      .toEqual([{ kind: "blocked", member: "m", explain: "safety stop" }]);
  });

  test("LS2: working with UNCHANGED content for >= fakeDeathSec ⇒ fake-death (content-diff, not a stale match)", async () => {
    const events = await run({ states: ["working", "working"], contentHash: ["h1", "h1"], waitOutput: ["output", "output"], nowSeq: [0, 0, 900] });
    expect(events).toEqual([{ kind: "fake-death", member: "m", silentSec: 900 }]);
  });

  test("LS2: working with CHANGED content ⇒ no fake-death (new output resets the clock)", async () => {
    const events = await run({ states: ["working", "working"], contentHash: ["h1", "h2"], waitOutput: ["output", "output"], nowSeq: [0, 0, 900] });
    expect(events).toEqual([]);
  });

  test("LS1: a wait-output error backs off and never emits fake-death on its own", async () => {
    // content unchanged but elapsed < fakeDeathSec ⇒ no emit even though wait-output errors.
    expect(await run({ states: ["working", "working"], contentHash: ["h1", "h1"], waitOutput: ["error", "error"], nowSeq: [0, 0, 10] })).toEqual([]);
  });

  test("idle that stays idle on a REAL timeout ⇒ idle-timeout", async () => {
    expect(await run({ states: ["idle"], waitLeave: [{ state: "idle", outcome: "timeout" }] }))
      .toEqual([{ kind: "idle-timeout", member: "m", idleSec: 1800 }]);
  });

  test("LS3: a wait ERROR (not a real timeout) with state still idle ⇒ NO idle-timeout", async () => {
    expect(await run({ states: ["idle"], waitLeave: [{ state: "idle", outcome: "error" }] })).toEqual([]);
  });

  test("idle that leaves idle ⇒ no alert", async () => {
    expect(await run({ states: ["idle"], waitLeave: [{ state: "working", outcome: "reached" }] })).toEqual([]);
  });

  test("done ⇒ wait for activity, no alert", async () => {
    expect(await run({ states: ["done"], waitLeave: [{ state: "working", outcome: "reached" }] })).toEqual([]);
  });
});

describe("live-sentinel decideLiveSentinel (presence-only fallback: no herdr screen)", () => {
  const cfgF = { idleTimeoutSec: 1800 };
  const d = (m: MemberObs[]) => decideLiveSentinel(m, cfgF);
  test("self-reported blocked ⇒ blocked", () => {
    expect(d([{ member: "a", reportedStatus: "blocked" }]).map((x) => [x.member, x.kind])).toEqual([["a", "blocked"]]);
  });
  test("self-reported idle past the threshold ⇒ idle-timeout; below ⇒ none; no age ⇒ none", () => {
    expect(d([{ member: "a", reportedStatus: "idle", idleSec: 1800 }]).map((x) => x.kind)).toEqual(["idle-timeout"]);
    expect(d([{ member: "a", reportedStatus: "idle", idleSec: 1799 }])).toEqual([]);
    expect(d([{ member: "a", reportedStatus: "idle" }])).toEqual([]);
  });
  test("working / absent self-report ⇒ nothing (no screen ⇒ no fake-death in the fallback)", () => {
    expect(d([{ member: "a", reportedStatus: "working", idleSec: 9999 }, { member: "b" }])).toEqual([]);
  });
});
