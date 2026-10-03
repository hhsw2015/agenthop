// R2 minimal-acceptance pure-layer pinning (team-collab §0b). Items 1/3/4/6 are covered by swarm-task-wait /
// swarm-task-validation. This file pins the crash-window and shared-log behaviours that the pure layer CAN prove.
//
// Honesty about layers (Codex 1cfa162 review): the FULL liveness guarantee needs a real persistence/action adapter and
// the sweep's scheduler — those are the IO batch, not the pure layer. Specifically:
//   - W1 (intent-persist fails / ACK unknown => zero action IO) and W4 (IO succeeded, action_done not yet durable =>
//     recover by querying external evidence) need a persistence barrier + action adapter. NOT asserted here; they are
//     explicitly the IO batch's job. Faking them in the pure layer would be a lie.
//   - R2 item 5 (a slow action must not delay a shorter-deadline wait's handling) is a SCHEDULER property proved with
//     virtual time in the sweep batch. Here we pin only the pure prerequisite it rests on: single-record independence
//     in the shared log (one wait's pending action never evicts another from the projection).
// What the pure layer DOES prove below: a committed intent survives a crash via replayLog with its FULL payload (W0/W2),
// a durably-resolved action stays resolved after restart (W5), and re-submitting any committed op is a bounded replay
// no-op (W6) — so recovery never loses an intent nor multiplies it into new actions.
import { describe, expect, test } from "vitest";
import { initialLogState, commit, replayLog, type Change, type CommittedBatch, type WaitRecord } from "../src/swarm/control-log.js";
import { openWait, advanceWait } from "../src/swarm/task-wait.js";

const action = { actionId: "a1", actionKind: "bypass", target: "job/P/a1", expectedSubjectVersion: 7 };
const w = (id = "w1"): WaitRecord => openWait({ waitId: id, kind: "wait", subject: { jobId: "job", attemptId: "job/P/a1" }, owner: "disp", deadlineSec: 100, timeoutPolicy: "bypass" });
// Deterministic per-transition operationId (entityKey-style `#rev`), matching the IO-side convention — so a replayed
// batch is a full no-op.
function changes(wait: WaitRecord, n: number): Change[] {
  return [{ put: "wait", wait, operationId: `wait:${wait.waitId}#${n}`, expectedEntityRevision: n - 1 } as Change];
}
function doneLog(): CommittedBatch[] {
  // Resolved terminal is reached via close (subject completion), not action_done — a timeout action only re-arms
  // (§0b erratum 94284fc2). The intermediate action_pending is still exercised (begin_action), then close resolves.
  const open = w();
  const pending = advanceWait(open, { type: "begin_action", pendingAction: action });
  if (!pending.ok) throw new Error("begin");
  const done = advanceWait(pending.wait, { type: "close", resolution: { outcome: "subject-completed", reason: "confirmed", sourceOperationId: "a1" } });
  if (!done.ok) throw new Error("close");
  return [{ seq: 1, changes: changes(open, 1) }, { seq: 2, changes: changes(pending.wait, 2) }, { seq: 3, changes: changes(done.wait, 3) }];
}
const waitBody = (s: ReturnType<typeof initialLogState>, key: string): WaitRecord => {
  const b = s.entities[key];
  if (!b || b.put !== "wait") throw new Error(`no wait at ${key}`);
  return b.wait;
};

describe("R2 item 2 crash windows (pure layer: control-log replay + task-wait)", () => {
  test("W0: recovery re-discovers an overdue open from the REPLAY-REBUILT entity, not a pre-crash object; begin is bounded", () => {
    const open = w();
    const rebuilt = replayLog([{ seq: 1, changes: changes(open, 1) }]); // crash before begin_action committed
    expect(waitBody(rebuilt, "wait:w1").state).toBe("open");
    const recovered = waitBody(rebuilt, "wait:w1"); // continue from the rebuilt entity
    const pending = advanceWait(recovered, { type: "begin_action", pendingAction: action });
    expect(pending.ok).toBe(true);
    const b2 = changes(pending.ok ? pending.wait : recovered, 2);
    const first = commit(rebuilt, 1, b2);
    expect(first.result.ok).toBe(true);
    const again = commit(first.state, 2, b2); // recovery double-submit
    expect(again.result.ok === true && "replay" in again.result && again.result.replay === true).toBe(true);
  });

  test("W2 (catches M1): replay restores the FULL action payload (kind/target/version), not only actionId", () => {
    const open = w();
    const pending = advanceWait(open, { type: "begin_action", pendingAction: action });
    expect(pending.ok).toBe(true);
    const log = [{ seq: 1, changes: changes(open, 1) }, { seq: 2, changes: changes(pending.ok ? pending.wait : open, 2) }];
    const rebuilt = replayLog(JSON.parse(JSON.stringify(log))); // durable round-trip, not in-memory objects
    expect(waitBody(rebuilt, "wait:w1").pendingAction).toEqual(action);
  });

  test("W5 (catches M2): a durably-committed resolved batch is replayed; restart stays resolved", () => {
    const log = doneLog();
    let state = initialLogState();
    for (const b of log) {
      const c = commit(state, state.seq, b.changes);
      expect(c.result.ok).toBe(true);
      state = c.state;
    }
    const rebuilt = replayLog(JSON.parse(JSON.stringify(log)));
    expect(rebuilt.entities["wait:w1"]).toEqual(state.entities["wait:w1"]); // replay projection == committed projection
    expect(waitBody(rebuilt, "wait:w1").state).toBe("resolved");
  });

  test("W6: after resolved, re-submitting the completion op OR a late begin op is a no-op (terminal + revision unchanged)", () => {
    const log = doneLog();
    let state = initialLogState();
    for (const b of log) state = commit(state, state.seq, b.changes).state;
    const revBefore = state.revisions["wait:w1"];
    const r3 = commit(state, 99, log[2]!.changes); // re-submit the completion op
    expect(r3.result.ok === true && "replay" in r3.result && r3.result.replay === true).toBe(true);
    expect(r3.state.revisions["wait:w1"]).toBe(revBefore);
    const r2 = commit(state, 99, log[1]!.changes); // late re-submit of the begin op
    expect(r2.result.ok === true && "replay" in r2.result && r2.result.replay === true).toBe(true);
    expect(waitBody(r2.state, "wait:w1").state).toBe("resolved");
  });
});

describe("R2 item 5 is a scheduler property (sweep batch); here we pin only its pure prerequisite", () => {
  test("single-record independence (catches M3): one wait's pending action does not evict another from the shared log", () => {
    let s = commit(initialLogState(), 0, [...changes(w("short"), 1), ...changes(w("long"), 1)]).state;
    const lp = advanceWait(w("long"), { type: "begin_action", pendingAction: { ...action, actionId: "long-action" } });
    expect(lp.ok).toBe(true);
    s = commit(s, 1, changes(lp.ok ? lp.wait : w("long"), 2)).state;
    expect(waitBody(s, "wait:short").state).toBe("open"); // the short wait survives untouched
    expect(waitBody(s, "wait:long").state).toBe("action_pending");
  });
});
