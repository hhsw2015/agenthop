import { describe, expect, test } from "vitest";
import { superviseMember, decideLiveSentinel, type WatchOps, type WatchCfg, type SentinelEvent, type MemberObs } from "../src/swarm/live-sentinel.js";
import type { AgentState } from "../src/swarm/herdr.js";

const cfg: WatchCfg = { fakeDeathSec: 900, idleTimeoutSec: 1800, reArmSec: 1800, doneWakeSec: 1800 };

// Scripted WatchOps: each queue yields its next value; when exhausted it throws, which ends the watch loop so the test can
// assert the events emitted up to that point. stopped() stays false — termination is by script exhaustion.
const END = "script-end";
function makeOps(s: { states: AgentState[]; waitLeave?: AgentState[]; waitOutput?: Array<"output" | "timeout" | "error">; explain?: string }): { ops: WatchOps; events: SentinelEvent[] } {
  const events: SentinelEvent[] = [];
  let si = 0, li = 0, oi = 0;
  const next = <T>(arr: T[] | undefined, i: number): T => { if (!arr || i >= arr.length) throw new Error(END); return arr[i]!; };
  return {
    events,
    ops: {
      state: async () => next(s.states, si++),
      waitLeave: async () => next(s.waitLeave, li++),
      waitOutput: async () => next(s.waitOutput, oi++),
      explain: async () => s.explain ?? "",
      emit: (ev) => events.push(ev),
      stopped: () => false,
    },
  };
}
const run = async (s: Parameters<typeof makeOps>[0]): Promise<SentinelEvent[]> => {
  const { ops, events } = makeOps(s);
  await superviseMember("m", ops, cfg).catch(() => { /* script-end terminates the loop */ });
  return events;
};

describe("live-sentinel superviseMember (S14: herdr-primitive watcher state machine)", () => {
  test("blocked ⇒ explain + emit blocked, then wait to leave blocked", async () => {
    const events = await run({ states: ["blocked"], explain: "safety stop", waitLeave: [] /* throws after emit */ });
    expect(events).toEqual([{ kind: "blocked", member: "m", explain: "safety stop" }]);
  });

  test("working + output-timeout + STILL working ⇒ fake-death", async () => {
    const events = await run({ states: ["working", "working"], waitOutput: ["timeout"] });
    expect(events).toEqual([{ kind: "fake-death", member: "m", silentSec: 900 }]);
  });

  test("working + output ⇒ no alert (healthy)", async () => {
    expect(await run({ states: ["working"], waitOutput: ["output"] })).toEqual([]);
  });

  test("working + output-timeout but state CHANGED ⇒ no fake-death", async () => {
    expect(await run({ states: ["working", "idle"], waitOutput: ["timeout"] })).toEqual([]);
  });

  test("idle that stays idle past the wait ⇒ idle-timeout", async () => {
    const events = await run({ states: ["idle"], waitLeave: ["idle"] });
    expect(events).toEqual([{ kind: "idle-timeout", member: "m", idleSec: 1800 }]);
  });

  test("idle that leaves idle ⇒ no alert", async () => {
    expect(await run({ states: ["idle"], waitLeave: ["working"] })).toEqual([]);
  });

  test("done ⇒ wait for activity, no alert", async () => {
    expect(await run({ states: ["done"], waitLeave: ["working"] })).toEqual([]);
  });

  test("output 'error' (inconclusive) is NOT a fake-death", async () => {
    expect(await run({ states: ["working"], waitOutput: ["error"] })).toEqual([]);
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
    expect(d([{ member: "a", reportedStatus: "idle" }])).toEqual([]); // status age unknown ⇒ not convicted
  });
  test("working / absent self-report ⇒ nothing (no screen ⇒ no fake-death in the fallback)", () => {
    expect(d([{ member: "a", reportedStatus: "working", idleSec: 9999 }, { member: "b" }])).toEqual([]);
  });
});
