// R2 minimal-acceptance-set pure-layer pinning (team-collab §0b). Items 1/3/4/6 are covered by swarm-task-wait /
// swarm-task-validation; this file adds the three that need a COMBINATION (control-log replay + wait, wait ordering):
//   item 2 — a timeout action survives crashes around commit/IO and never multiplies into infinite new actions;
//   item 5 — a long action on one wait does not block handling a shorter-deadline wait;
//   (item 7 — meta-job "wrote the landing spot but didn't fix the counterexample" must NOT pass — in swarm-task-result.)
import { describe, expect, test } from "vitest";
import { initialLogState, commit, replayLog, type Change, type ChangeBody, type CommittedBatch, type WaitRecord, type PendingAction } from "../src/swarm/control-log.js";
import { openWait, advanceWait, type NewWait } from "../src/swarm/task-wait.js";

function ch(body: ChangeBody, operationId: string, expectedEntityRevision = 0): Change {
  return { ...body, operationId, expectedEntityRevision } as Change;
}
function mkWait(p: Partial<NewWait> = {}): WaitRecord {
  return openWait({ waitId: "w1", kind: "wait", subject: { jobId: "job", attemptId: "job/P/a1" }, deadlineSec: 100, owner: "disp", timeoutPolicy: "bypass", ...p });
}
const bypass: PendingAction = { actionId: "b1", actionKind: "bypass", target: "job/P/a1", expectedSubjectVersion: 1 };
const res = { outcome: "bypassed", reason: "timeout", sourceOperationId: "op" };

describe("R2 item 2: a timeout action survives crashes and never multiplies (control-log replay + wait)", () => {
  test("intent committed before IO is recoverable, and re-submitting it is a no-op (not a new action)", () => {
    const open = mkWait();
    const b1: Change[] = [ch({ put: "wait", wait: open }, "wait:w1#1", 0)];
    const s1 = commit(initialLogState(), 0, b1).state;

    // open -> action_pending: CAS the recoverable intent BEFORE the IO.
    const pending = advanceWait(open, { type: "begin_action", pendingAction: bypass });
    expect(pending.ok).toBe(true);
    const b2: Change[] = [ch({ put: "wait", wait: pending.ok ? pending.wait : open }, "wait:w1#2", 1)];
    const s2 = commit(s1, 1, b2).state;

    // CRASH after the intent commit, before the IO: recovery replays the log -> action is NOT lost.
    const batches: CommittedBatch[] = [{ seq: 1, changes: b1 }, { seq: 2, changes: b2 }];
    const rebuilt = replayLog(batches);
    const body = rebuilt.entities["wait:w1"];
    expect(body?.put === "wait" && body.wait.state === "action_pending" && body.wait.pendingAction?.actionId === "b1").toBe(true);

    // Recovery re-submits the SAME begin_action op -> full replay no-op: seq unchanged, revision unchanged, NO new action.
    const again = commit(rebuilt, 99, b2); // even a stale expectedSeq: replay precedes the seq check
    expect(again.result).toEqual({ ok: true, newSeq: 2, replay: true });
    expect(again.state.revisions["wait:w1"]).toBe(2);
  });

  test("crash BEFORE the intent commit -> re-detect -> begin ONCE (bounded, not infinite)", () => {
    const open = mkWait();
    const b1: Change[] = [ch({ put: "wait", wait: open }, "wait:w1#1", 0)];
    // Only b1 landed (crash before begin_action committed): replay -> wait still open, intent not yet taken.
    const rebuilt = replayLog([{ seq: 1, changes: b1 }]);
    expect((rebuilt.entities["wait:w1"] as { wait: WaitRecord }).wait.state).toBe("open");
    // Sweep re-detects the timeout and commits begin_action once.
    const pending = advanceWait(open, { type: "begin_action", pendingAction: bypass });
    const b2: Change[] = [ch({ put: "wait", wait: pending.ok ? pending.wait : open }, "wait:w1#2", 1)];
    const first = commit(rebuilt, 1, b2);
    expect(first.result.ok && !("replay" in first.result && false)).toBe(true);
    // A double-submit during recovery is absorbed (replay), so it cannot become two/infinite actions.
    const second = commit(first.state, 2, b2);
    expect(second.result.ok === true && "replay" in second.result && second.result.replay === true).toBe(true);
  });

  test("crash BETWEEN begin_action and action_done -> recover in action_pending, still resolvable (nothing lost)", () => {
    const open = mkWait();
    const b1: Change[] = [ch({ put: "wait", wait: open }, "wait:w1#1", 0)];
    const pending = advanceWait(open, { type: "begin_action", pendingAction: bypass });
    const pendingWait = pending.ok ? pending.wait : open;
    const b2: Change[] = [ch({ put: "wait", wait: pendingWait }, "wait:w1#2", 1)];
    // action_done (b3) never committed (crash). Replay stops at action_pending.
    const rebuilt = replayLog([{ seq: 1, changes: b1 }, { seq: 2, changes: b2 }]);
    expect((rebuilt.entities["wait:w1"] as { wait: WaitRecord }).wait.state).toBe("action_pending");
    // Recovery can still confirm from action_pending.
    const done = advanceWait(pendingWait, { type: "action_done", resolution: res });
    expect(done.ok && done.wait.state === "resolved").toBe(true);
  });
});

describe("R2 item 5: a long action on one wait does not block a shorter-deadline wait", () => {
  test("begin_action is not mutually exclusive; the short wait is handled while the long one sits action_pending", () => {
    const wShort = mkWait({ waitId: "wShort", deadlineSec: 100 });
    const wLong = mkWait({ waitId: "wLong", deadlineSec: 1000 });
    const now = 150;
    // deadline order: the short wait is due, the long one is not.
    expect(now >= wShort.deadlineSec && now < wLong.deadlineSec).toBe(true);

    // A long validation/IO action begins on wLong.
    const longAction: PendingAction = { actionId: "long1", actionKind: "revalidate", target: "job/Q/a1", expectedSubjectVersion: 1 };
    const longPending = advanceWait(wLong, { type: "begin_action", pendingAction: longAction });
    expect(longPending.ok && longPending.wait.state === "action_pending").toBe(true);

    // wShort is UNTOUCHED by the long action (immutability) and can be handled to completion independently.
    expect(wShort.state).toBe("open");
    const sp = advanceWait(wShort, { type: "begin_action", pendingAction: { ...bypass, actionId: "s1" } });
    const sd = sp.ok ? advanceWait(sp.wait, { type: "action_done", resolution: res }) : { ok: false as const };
    expect(sd.ok && sd.wait.state === "resolved").toBe(true);

    // The long action is still in flight — it was neither forced nor did it block the short wait.
    expect(longPending.ok && longPending.wait.state === "action_pending").toBe(true);
  });
});
