import { describe, expect, test } from "vitest";
import { commit, entityKeyOf, initialLogState, liveEntities, type ChangeBody, type LogState, type WaitRecord, type ValidationRun } from "../src/swarm/control-log.js";
import { openWait, openQueryWait, isLive, advanceWait } from "../src/swarm/task-wait.js";
import { openValidationRun } from "../src/swarm/task-validation.js";
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
function allRuns(state: LogState): ValidationRun[] {
  const out: ValidationRun[] = [];
  for (const b of Object.values(liveEntities(state))) if (b.put === "validationRun") out.push(b.validationRun);
  return out;
}
function mkOps(stateRef: { s: LogState }, order: string[], over: Partial<SweepOps> = {}): SweepOps {
  let n = 0;
  return {
    nowSec: () => 2000,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { order.push(`commit:${bodies.map((b) => b.put + ":" + ((b as { wait?: WaitRecord }).wait?.state ?? (b as { validationRun?: ValidationRun }).validationRun?.state ?? "")).join(",")}`); const r = stampCommit(state, bodies); stateRef.s = r.state; return r; },
    isAlive: () => "alive",
    pickReassignee: () => "claude:successor",
    pickValidator: () => "codex:val2",
    newWaitId: (base) => `${base}/r${++n}`,
    newValidationRunId: (base) => `${base}/g${++n}`,
    newActionId: () => `act${++n}`,
    freshDeadlineSec: () => 9999,
    doAction: async (_w, action) => { order.push(`doAction:${action.actionKind}`); return true; },
    actionTimeoutMs: 1000,
    log: () => {},
    ...over,
  };
}
const wait = (p: Partial<WaitRecord> & { waitId: string }): WaitRecord =>
  openWait({ waitId: p.waitId, kind: p.kind ?? "wait", subject: p.subject ?? { jobId: "job" }, deadlineSec: p.deadlineSec ?? 1000, owner: p.owner ?? "claude:owner", timeoutPolicy: p.timeoutPolicy ?? "bypass" });

describe("sweep scenario A — expired wait ⇒ begin_action (CAS) → IO → action_done", () => {
  test("bypass: begin BEFORE the IO, then action_done ⇒ RE-ARM (open, not resolved — §0b erratum 94284fc2)", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000, timeoutPolicy: "bypass" })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:bypass", "commit:wait:open"]); // CAS before IO; re-arm, not resolve
    const live = liveWaits(stateRef.s);
    expect(live).toHaveLength(1);                 // still live — a single bypass ping never resolves the wait
    expect(live[0]!.state).toBe("open");
    expect(live[0]!.deadlineSec).toBe(9999);      // fresh deadline (freshDeadlineSec)
    expect(live[0]!.escalatedAt).toBe(2000);      // nowSec — supervision transferred
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
  test("recovery (P1-2): an action_pending residue is RE-FIRED (idempotent, same actionId) + confirmed, not skipped forever", async () => {
    // seed a wait already in action_pending — e.g. a crash after begin, before the IO/confirm.
    let s = mkState([wait({ waitId: "w1", deadlineSec: 1000 })]);
    const key = "wait:w1"; const rev = s.revisions[key] ?? 0;
    s = commit(s, s.seq, [{ put: "wait", wait: { ...liveWaits(s)[0]!, state: "action_pending", pendingAction: { actionId: "a", actionKind: "bypass", target: "job", expectedSubjectVersion: 0 } }, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev }]).state;
    const stateRef = { s }; const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual(["doAction:bypass", "commit:wait:open"]); // re-fired its stored intent, then confirmed (re-arm)
    const live = liveWaits(stateRef.s);
    expect(live[0]!.state).toBe("open");      // recovered — no longer stranded in action_pending
    expect(live[0]!.deadlineSec).toBe(9999);  // re-armed with a fresh deadline
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
  test("single 'suspected' is NOT dead ⇒ never reassigned (F17); a non-expired suspected wait is untouched", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 5000, owner: "claude:maybe" })]) }; // not expired
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "suspected" }));
    expect(order).toEqual([]); // suspected ⇒ no reassign; not expired ⇒ no action
  });
  test("suspected owner + EXPIRED ⇒ re-arms (supervision continues, P1-4/F17), NOT reassigned", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000, owner: "claude:maybe" })]) }; // expired
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "suspected" }));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:bypass", "commit:wait:open"]); // re-armed, NOT reassigned
    const live = liveWaits(stateRef.s);
    expect(live[0]!.state).toBe("open");       // supervision continues (not stalled, not reassigned)
    expect(live[0]!.deadlineSec).toBe(9999);
  });
  test("dead owner but no reassignee ⇒ left for escalation (no change)", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000, owner: "claude:gone" })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "dead", pickReassignee: () => null }));
    expect(order).toEqual([]);
  });
  test("reassigning an APPROVAL wait carries the approval context to the successor (no silent strip)", async () => {
    const appr = openWait({ waitId: "ap1", kind: "approval", subject: { jobId: "job" }, deadlineSec: 5000, owner: "claude:gone", timeoutPolicy: "escalate", actionRef: "act-ref", paramsDigest: "pd-123", approvalAuthority: "user", approvalReason: "needs human" });
    const stateRef = { s: mkState([appr]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "dead", pickReassignee: () => "claude:successor" }));
    const live = liveWaits(stateRef.s);
    expect(live).toHaveLength(1);
    expect(live[0]!.owner).toBe("claude:successor");
    expect(live[0]!.actionRef).toBe("act-ref");          // what needs deciding — carried
    expect(live[0]!.paramsDigest).toBe("pd-123");
    expect(live[0]!.approvalAuthority).toBe("user");
    expect(live[0]!.decision).toBe("pending");            // fresh decider
  });
});

describe("sweep scenario C — expired APPROVAL ⇒ escalation REOPENS, never resolves (§0b 终审②, safety red line)", () => {
  const approval = (p: Partial<WaitRecord> & { waitId: string }): WaitRecord =>
    openWait({ waitId: p.waitId, kind: "approval", subject: p.subject ?? { jobId: "job" }, deadlineSec: p.deadlineSec ?? 1000, owner: p.owner ?? "claude:owner", timeoutPolicy: p.timeoutPolicy ?? "escalate" });

  test("expired approval (decision pending) ⇒ begin → escalation → REOPEN with fresh deadline + escalatedAt (not resolved, not granted)", async () => {
    const stateRef = { s: mkState([approval({ waitId: "a1", deadlineSec: 1000 })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:escalation", "commit:wait:open"]); // reopened, NOT resolved
    const live = liveWaits(stateRef.s);
    expect(live).toHaveLength(1);                 // still open — supervision transferred, approval did not vanish
    expect(live[0]!.state).toBe("open");
    expect(live[0]!.deadlineSec).toBe(9999);      // fresh deadline (freshDeadlineSec)
    expect(live[0]!.escalatedAt).toBe(2000);      // nowSec
    expect(live[0]!.decision).toBe("pending");    // never auto-granted — only a real `decide` ends an approval
  });

  test("safety red line: an approval with timeoutPolicy=bypass is STILL escalated, never bypass-resolved (no auto-grant on timeout)", async () => {
    const stateRef = { s: mkState([approval({ waitId: "a1", deadlineSec: 1000, timeoutPolicy: "bypass" })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toContain("doAction:escalation");
    expect(order).not.toContain("doAction:bypass"); // bypass policy MUST NOT auto-resolve a privileged approval
    const live = liveWaits(stateRef.s);
    expect(live).toHaveLength(1);
    expect(live[0]!.state).toBe("open");
    expect(live[0]!.decision).toBe("pending");
  });

  test("escalation notice unconfirmed ⇒ held in action_pending, retried next tick (no reopen)", async () => {
    const stateRef = { s: mkState([approval({ waitId: "a1", deadlineSec: 1000 })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { doAction: async (_w, a) => { order.push(`doAction:${a.actionKind}`); return false; } }));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:escalation"]); // no reopen commit
    expect(liveWaits(stateRef.s)[0]!.state).toBe("action_pending");
  });

  test("a non-expired approval is untouched", async () => {
    const stateRef = { s: mkState([approval({ waitId: "a1", deadlineSec: 5000 })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual([]);
  });
});

describe("sweep scenario D — RPV validation-wait: stuck/dead validator ⇒ moveValidator (same pinned candidate, gen+1)", () => {
  const CAND = { observedResultId: "obs1", observedWorkCommit: "c0ffee", resultClosureDigest: "dig1" };
  const vrun = (over: Partial<ValidationRun> = {}): ValidationRun =>
    openValidationRun({ validationRunId: over.validationRunId ?? "vr1", attemptId: "att1", candidateRef: CAND, generation: over.generation ?? 0, validatorLocation: over.validatorLocation ?? "codex:val1", openedAtSeq: 1 });
  const vwait = (over: { waitId?: string; deadlineSec?: number; owner?: string; timeoutPolicy?: WaitRecord["timeoutPolicy"]; validationRunId?: string } = {}): WaitRecord =>
    openWait({ waitId: over.waitId ?? "vw1", kind: "wait", subject: { jobId: "job", attemptId: "att1", validationRunId: over.validationRunId ?? "vr1" }, deadlineSec: over.deadlineSec ?? 1000, owner: over.owner ?? "codex:val1", timeoutPolicy: over.timeoutPolicy ?? "escalate" });
  const seed = (vr: ValidationRun, vw: WaitRecord) => ({ s: stampCommit(initialLogState(), [{ put: "validationRun", validationRun: vr }, { put: "wait", wait: vw }]).state });

  test("expired RPV (validator alive but over deadline) ⇒ begin → notify → close old run+wait + open new gen run+wait (same batch)", async () => {
    const stateRef = seed(vrun(), vwait({ deadlineSec: 1000 }));
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "alive", pickValidator: () => "codex:val2" }));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:move-validator", "commit:wait:resolved,validationRun:closed,validationRun:running,wait:open"]);
    const runs = allRuns(stateRef.s);
    expect(runs.find((r) => r.validationRunId === "vr1")!.state).toBe("closed");  // old run fenced (late verdict can't double-accept)
    const next = runs.find((r) => r.validationRunId !== "vr1")!;
    expect(next.generation).toBe(1);                                             // gen+1
    expect(next.candidateRef).toEqual(CAND);                                     // PINNED — business is NOT re-run
    expect(next.validatorLocation).toBe("codex:val2");
    const live = liveWaits(stateRef.s);
    expect(live).toHaveLength(1);                                                // old wait resolved, new open
    expect(live[0]!.owner).toBe("codex:val2");
    expect(live[0]!.subject.validationRunId).toBe(next.validationRunId);
  });

  test("dead validator (regardless of deadline) ⇒ moveValidator, NOT the owner-reassign path", async () => {
    const stateRef = seed(vrun(), vwait({ deadlineSec: 5000 })); // not even expired
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "dead", pickValidator: () => "codex:val2" }));
    expect(order).toContain("doAction:move-validator");
    expect(order).not.toContain("doAction:reassign");          // a validation-wait never takes the owner-reassign branch
    expect(allRuns(stateRef.s).find((r) => r.validationRunId !== "vr1")!.generation).toBe(1);
  });

  test("no replacement validator (pickValidator null) ⇒ left for escalation (no change)", async () => {
    const stateRef = seed(vrun(), vwait({ deadlineSec: 1000 }));
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { pickValidator: () => null }));
    expect(order).toEqual([]);
    expect(allRuns(stateRef.s).find((r) => r.validationRunId === "vr1")!.state).toBe("running"); // untouched
  });

  test("validator alive + within deadline ⇒ untouched (not moved)", async () => {
    const stateRef = seed(vrun(), vwait({ deadlineSec: 5000 }));
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "alive", pickValidator: () => "codex:val2" }));
    expect(order).toEqual([]);
  });

  test("single 'suspected' validator ⇒ not convicted (no move; a weak predicate never fences a candidate)", async () => {
    const stateRef = seed(vrun(), vwait({ deadlineSec: 1000 }));
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "suspected", pickValidator: () => "codex:val2" }));
    expect(order).toEqual([]);
  });

  test("notify unconfirmed ⇒ held in action_pending, old run NOT yet superseded (CAS strictly before the move)", async () => {
    const stateRef = seed(vrun(), vwait({ deadlineSec: 1000 }));
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { pickValidator: () => "codex:val2", doAction: async (_w, a) => { order.push(`doAction:${a.actionKind}`); return false; } }));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:move-validator"]);
    expect(allRuns(stateRef.s).find((r) => r.validationRunId === "vr1")!.state).toBe("running"); // not fenced until IO confirmed
    expect(liveWaits(stateRef.s)[0]!.state).toBe("action_pending");
  });
});

describe("sweep P1-3 — bounded delay: a slow IO never blocks another wait or the loop", () => {
  test("one wait's IO never settles (bounded by actionTimeoutMs) while another's completes this tick", async () => {
    const stateRef = { s: mkState([wait({ waitId: "slow", deadlineSec: 1000 }), wait({ waitId: "fast", deadlineSec: 1000 })]) };
    const order: string[] = [];
    const start = Date.now();
    await sweepPass(mkOps(stateRef, order, {
      actionTimeoutMs: 30,
      doAction: async (w) => { order.push(`doAction:${w.waitId}`); if (w.waitId === "slow") return new Promise<boolean>(() => {}); return true; }, // slow never resolves
    }));
    expect(Date.now() - start).toBeLessThan(2000);       // bounded — did NOT block on the never-settling IO
    const byId = Object.fromEntries(liveWaits(stateRef.s).map((w) => [w.waitId, w]));
    expect(byId["fast"]!.state).toBe("open");            // fast confirmed (re-armed) despite slow still in flight
    expect(byId["slow"]!.state).toBe("action_pending");  // slow left recoverable, re-fired next tick (P1-2)
  });
});

describe("sweep recovery safety — frozen pending (R5) + stale-result actionId match (R2)", () => {
  function toActionPending(s: LogState, waitId: string, actionId: string): LogState {
    const key = `wait:${waitId}`; const rev = s.revisions[key] ?? 0;
    const w = allWaits(s).find((x) => x.waitId === waitId)!;
    return commit(s, s.seq, [{ put: "wait", wait: { ...w, state: "action_pending", pendingAction: { actionId, actionKind: "bypass", target: "job", expectedSubjectVersion: 0 } }, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev }]).state;
  }

  test("R5: a FROZEN action_pending wait is NOT auto-fired — it needs repair (confirm-failure is not the guard)", async () => {
    let s = toActionPending(mkState([wait({ waitId: "w1", deadlineSec: 1000 })]), "w1", "a");
    s = { ...s, frozen: [...s.frozen, "wait:w1"] }; // op-conflict froze the entity
    const stateRef = { s }; const order: string[] = []; const logs: string[] = [];
    await sweepPass(mkOps(stateRef, order, { log: (m) => logs.push(m) }));
    expect(order).toEqual([]);                                  // no IO fired on a frozen subject
    expect(logs.some((m) => m.includes("FROZEN"))).toBe(true);  // surfaced for repair
    expect(liveWaits(stateRef.s)[0]!.state).toBe("action_pending");
  });

  test("R2: a stale delivered result does NOT confirm a wait that moved to a NEW action (actionId match)", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000 })]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, {
      doAction: async (_w, a) => {
        order.push(`doAction:${a.actionKind}`);
        // during A's delivery, a legal concurrent transition re-begins the wait with a DIFFERENT actionId (B)
        const cur = liveWaits(stateRef.s).find((x) => x.waitId === "w1")!;
        const key = "wait:w1"; const rev = stateRef.s.revisions[key] ?? 0;
        stateRef.s = commit(stateRef.s, stateRef.s.seq, [{ put: "wait", wait: { ...cur, pendingAction: { ...cur.pendingAction!, actionId: "B-different" } }, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev }]).state;
        return true; // A reports delivered AFTER the wait already moved on
      },
    }));
    const w = liveWaits(stateRef.s).find((x) => x.waitId === "w1")!;
    expect(w.state).toBe("action_pending");                 // the stale A result did NOT re-arm/confirm it
    expect(w.pendingAction!.actionId).toBe("B-different");  // B's intent is intact, not overwritten by A's confirm
  });
});

describe("sweep P1-1 — a REJECTED commit blocks IO and never logs success (commit→IO barrier is checked, not just ordered)", () => {
  test("begin commit rejected ⇒ NO doAction, wait untouched, honest 'commit rejected' log", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000 })]) };
    const order: string[] = [];
    const logs: string[] = [];
    await sweepPass(mkOps(stateRef, order, {
      commit: (state) => ({ state, result: { ok: false, reason: "seq", currentSeq: state.seq } }), // every commit rejected
      log: (m) => logs.push(m),
    }));
    expect(order).toEqual([]);                                   // no IO at all — reject bailed before doAction
    expect(liveWaits(stateRef.s)[0]!.state).toBe("open");        // unchanged — not advanced
    expect(logs.some((m) => m.includes("commit rejected"))).toBe(true);
  });

  test("confirm commit rejected ⇒ IO happened but wait is NOT logged resolved; held action_pending (recoverable)", async () => {
    const stateRef = { s: mkState([wait({ waitId: "w1", deadlineSec: 1000 })]) };
    const order: string[] = [];
    const logs: string[] = [];
    let n = 0;
    await sweepPass(mkOps(stateRef, order, {
      commit: (state, bodies) => {
        n += 1;
        if (n === 1) { order.push("commit:begin"); const r = stampCommit(state, bodies); stateRef.s = r.state; return r; } // begin ok
        order.push("commit:confirm-attempt"); return { state, result: { ok: false, reason: "stale-entity", entityKey: "wait:w1", currentRevision: 99 } }; // confirm rejected
      },
      log: (m) => logs.push(m),
    }));
    expect(order).toEqual(["commit:begin", "doAction:bypass", "commit:confirm-attempt"]); // IO did happen (begin succeeded)
    expect(logs.some((m) => m.includes("resolved"))).toBe(false);       // never claimed success on a failed confirm
    expect(logs.some((m) => m.includes("commit rejected"))).toBe(true);
    expect(liveWaits(stateRef.s)[0]!.state).toBe("action_pending");     // held recoverable, not falsely resolved
  });
});

describe("sweep — expired QUERY wait applies its default + closes (ab1bf81-E2), not a bypass re-arm", () => {
  test("decideAction → apply-default → applyDefaultOnTimeout close (resolved, default-applied); no bypass ping, no re-arm", async () => {
    const q = openQueryWait({ waitId: "q1", subject: { jobId: "job" }, deadlineSec: 1000, owner: "claude:owner", defaultOnTimeout: { outcome: "clarified", reason: "default-applied-reason", sourceOperationId: "op-q" } });
    const stateRef = { s: mkState([q]) };
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:apply-default", "commit:wait:resolved"]); // apply-default (not bypass); CLOSE (not re-arm)
    const all = allWaits(stateRef.s);
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("resolved");                      // closed, not re-armed to open
    expect(all[0]!.resolution?.outcome).toBe("default-applied"); // the pre-stored default was applied
    expect(all[0]!.deadlineSec).toBe(1000);                      // NOT bumped to freshDeadlineSec — no re-arm
  });
});

describe("sweep — query default is INDEPENDENT of the owner-liveness / disposition chain (review 4c617fa-E2)", () => {
  const q = (over: { deadlineSec?: number; owner?: string } = {}) =>
    openQueryWait({ waitId: "q1", subject: { jobId: "job" }, deadlineSec: over.deadlineSec ?? 1000, owner: over.owner ?? "claude:owner",
      defaultOnTimeout: { outcome: "clarified", reason: "default-reason", sourceOperationId: "op-q" }, payloadRef: "bundle-1" });

  test("E2-A: an EXPIRED query applies its default even with a DEAD owner and NO reassignee (default precedes owner-liveness)", async () => {
    const stateRef = { s: mkState([q()]) }; // deadline 1000 < nowSec 2000 ⇒ expired
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "dead", pickReassignee: () => null })); // dead + no picker used to STRAND it
    expect(order).toEqual(["commit:wait:action_pending", "doAction:apply-default", "commit:wait:resolved"]); // default, NOT reassign/stuck
    const all = allWaits(stateRef.s);
    expect(all).toHaveLength(1);                                  // no reassign ⇒ no second wait
    expect(all[0]!.state).toBe("resolved");
    expect(all[0]!.resolution?.outcome).toBe("default-applied");
    expect(all[0]!.resolution?.occurredAtSec).toBe(2000);        // R5-B: the close carries its true occurrence (the timeout instant)
  });

  test("E2-B: reassigning a NOT-yet-expired query preserves its default, payloadRef, and ORIGINAL deadline", async () => {
    const stateRef = { s: mkState([q({ deadlineSec: 3000, owner: "claude:dead" })]) }; // 3000 > nowSec 2000 ⇒ not expired; owner dead ⇒ reassign
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order, { isAlive: () => "dead", pickReassignee: () => "claude:successor" }));
    expect(order).toEqual(["commit:wait:action_pending", "doAction:reassign", "commit:wait:resolved,wait:open"]);
    const fresh = allWaits(stateRef.s).find((w) => w.state === "open")!;
    expect(fresh.owner).toBe("claude:successor");                 // only the decider changed
    expect(fresh.defaultOnTimeout?.outcome).toBe("clarified");    // the question's default survived the reassign
    expect(fresh.payloadRef).toBe("bundle-1");                    // the resume payload survived
    expect(fresh.deadlineSec).toBe(3000);                         // ORIGINAL semantic deadline, NOT freshDeadlineSec (9999)
  });

  test("E2-C: a STALE pending-bypass on a query applies the default on confirm, never a re-arm", async () => {
    const begun = advanceWait(q(), { type: "begin_action", pendingAction: { actionId: "stale", actionKind: "bypass", target: "job", expectedSubjectVersion: 0 } });
    if (!begun.ok) throw new Error(begun.error);
    const stateRef = { s: mkState([begun.wait]) }; // a query left in action_pending with a bypass by a pre-fix version / crash
    const order: string[] = [];
    await sweepPass(mkOps(stateRef, order));
    expect(order).toEqual(["doAction:bypass", "commit:wait:resolved"]); // fired the stale bypass, but CONFIRMED as a default close
    const all = allWaits(stateRef.s);
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("resolved");
    expect(all[0]!.resolution?.outcome).toBe("default-applied");  // default applied, NOT re-armed to open
    expect(all[0]!.deadlineSec).toBe(1000);                       // not bumped to 9999
  });
});
