import { describe, expect, test } from "vitest";
import { commit, entityKeyOf, initialLogState, liveEntities, type ChangeBody, type LogState, type WaitRecord } from "../src/swarm/control-log.js";
import { openWait, isLive } from "../src/swarm/task-wait.js";
import { sweepPass, type SweepOps } from "../src/swarm/task-sweep.js";

/**
 * liveness sweep (§0b R2) acceptance — fe0376cd scenarios A (expired→begin_action/IO/action_done) + B (owner-dead→
 * reassign close+new), plus the load-bearing ordering: CAS-then-IO, bounded delay (skip action_pending), single
 * suspected ≠ dead. Drives the REAL wait reducer + commit engine with injected ops.
 */

function stampCommit(state: LogState, bodies: ChangeBody[]): { state: LogState; result: ReturnType<typeof commit>["result"] } {
  const changes = bodies.map((b) => { const key = entityKeyOf(b); const rev = state.revisions[key] ?? 0; return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev }; });
  const r = commit(state, state.seq, changes);
  return { state: r.state, result: r.result };
}
function mkState(waits: WaitRecord[]): LogState {
  let s = initialLogState();
  for (const w of waits) s = stampCommit(s, [{ put: "wait", wait: w }]).state;
  return s;
}
function liveWaits(state: LogState): WaitRecord[] {
  const out: WaitRecord[] = [];
  for (const b of Object.values(liveEntities(state))) if (b.put === "wait" && isLive(b.wait)) out.push(b.wait);
  return out;
}
function allWaits(state: LogState): WaitRecord[] {
  const out: WaitRecord[] = [];
  for (const b of Object.values(liveEntities(state))) if (b.put === "wait") out.push(b.wait);
  return out;
}
function mkOps(stateRef: { s: LogState }, order: string[], over: Partial<SweepOps> = {}): SweepOps {
  let n = 0;
  return {
    nowSec: () => 2000,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { order.push(`commit:${bodies.map((b) => b.put + ":" + ((b as { wait?: WaitRecord }).wait?.state ?? "")).join(",")}`); const r = stampCommit(state, bodies); stateRef.s = r.state; return r; },
    isAlive: () => "alive",
    pickReassignee: () => "claude:successor",
    newWaitId: (base) => `${base}/r${++n}`,
    newActionId: () => `act${++n}`,
    freshDeadlineSec: () => 9999,
    doAction: async (_w, action) => { order.push(`doAction:${action.actionKind}`); return true; },
    log: () => {},
    ...over,
  };
}
const wait = (p: Partial<WaitRecord> & { waitId: string }): WaitRecord =>
  openWait({ waitId: p.waitId, kind: p.kind ?? "wait", subject: p.subject ?? { jobId: "job" }, deadlineSec: p.deadlineSec ?? 1000, owner: p.owner ?? "claude:owner", timeoutPolicy: p.timeoutPolicy ?? "bypass" });

describe("sweep scenario A — expired wait ⇒ begin_action (CAS) → IO → action_done", () => {
  test("bypass: commits begin BEFORE the IO, then action_done ⇒ resolved", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000, timeoutPolicy: "bypass" })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:bypass", "commit:wait:resolved"]); // CAS strictly before IO
    expect(liveWaits(stateRef.s)).toHaveLength(0); // resolved
  });
  test("escalate policy sends an escalation action", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000, timeoutPolicy: "escalate" })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toContain("doAction:escalation");
  });
  test("not yet expired ⇒ untouched", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 5000 })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual([]);
  });
  test("bounded delay: an action_pending wait is skipped this tick (no re-begin)", async () => {
    // seed a wait already in action_pending.
    let s = mkState([wait({ waitId: "w1", deadlineSec: 1000 })]);
    const key = "wait:w1"; const rev = s.revisions[key] ?? 0;
    s = commit(s, s.seq, [{ put: "wait", wait: { ...liveWaits(s)[0]!, state: "action_pending", pendingAction: { actionId: "a", actionKind: "bypass", target: "job", expectedSubjectVersion: 0 } }, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev }]).state;
    const stateRef = { s }; const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual([]); // skipped — its IO is already in flight
  });
  test("IO unconfirmed ⇒ held in action_pending (not resolved), retried next tick", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000 })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { doAction: async (_w, action) => { order.push(`doAction:${action.actionKind}`); return false; } }));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:bypass"]); // no action_done commit
    expect(liveWaits(stateRef.s)[0]!.state).toBe("action_pending");
  });
});

describe("sweep scenario B — owner dead ⇒ reassign (close old + open new, same batch)", () => {
  test("dead owner ⇒ begin → IO → close(owner-dead) + open new for the successor", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 5000, owner: "claude:gone" })]) }; // not even expired
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "dead" }));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:reassign", "commit:wait:resolved,wait:open"]); // close + new same batch
    const live = liveWaits(stateRef.s);
    expect(live).toHaveLength(1); // old resolved, new open
    expect(live[0]!.owner).toBe("claude:successor");
    expect(live[0]!.waitId).not.toBe("w1");
  });
  test("single 'suspected' is NOT dead ⇒ untouched (F17: weak predicate disabled)", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000, owner: "claude:maybe" })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "suspected" }));
    expect(order).toEqual([]); // not reassigned, and expiry rule only fires for alive owners
  });
  test("dead owner but no reassignee ⇒ left for escalation (no change)", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000, owner: "claude:gone" })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "dead", pickReassignee: () => null }));
    expect(order).toEqual([]);
  });
});
