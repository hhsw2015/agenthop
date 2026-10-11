// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/output-contract-wiring.selftest.mts
//
// Pins the WIRING of the output-contract VERIFICATION tag (SWARM_OUTPUT_CONTRACT) into the LIVE control-log task axis:
//  (a) a plan node WITH expectedOutput + flag ON ⇒ the dispatched intent carries `expectedOutput` (sanitized);
//  (b) flag OFF (SWARM_OUTPUT_CONTRACT=0)        ⇒ no `expectedOutput` on the intent;
//  (c) a node WITHOUT expectedOutput             ⇒ no `expectedOutput`;
//  (d) read-side FC-7: a malformed intent.expectedOutput (replayLog) AND a malformed node.expectedOutput (loadPlan) both
//      parse fine with ONLY the bad field dropped/sanitized — never a whole reject;
//  (d3) AW-1: the read-side trims the ENTITY VIEW ONLY — the OPERATION digest stays on the committed payload, so a historical
//      record with a malformed/extra expectedOutput still accepts a BYTE-IDENTICAL retry (idempotent), while a genuinely
//      different payload still conflicts. Also proves the SAME holds when an intent carries BOTH tags (accountable + expectedOutput);
//  (e) RECEIPT seam: an accepted result whose intent carries expectedOutput fires ops.verifyOutputContract ONCE (gated on the
//      flag — a kill-switch at accept-time silences even a stale-stamped intent); a node with no expectedOutput never fires it.
//  (f) verifyExpectedOutput / probeExpectedOutput / validateExpectedOutput are BYTE-UNCHANGED — covered by
//      output-contract.selftest.mts (run separately).
//
// The contract math (validate/probe/verify) lives in the pure core; this selftest only proves the SEAM: stamp-at-dispatch
// (gated on outputContractEnabled), read-side tolerance, and verify-at-receipt (gated, fail-soft, once).

import {
  commit, entityKeyOf, initialLogState, liveEntities, replayLog,
  type ChangeBody, type LogState, type DispatchIntent, type Change, type CommittedBatch,
} from "./control-log.js";
import { loadPlan, type TaskPlan } from "./task-plan.js";
import { taskPass, type TaskOps, type GitFacts } from "./task-pass.js";
import type { TaskAttempt } from "./task-state.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- the real shell's commit stamping (operationId = entityKey#targetRev, expectedEntityRevision = current rev) ---
function stampCommit(state: LogState, bodies: ChangeBody[]): { state: LogState; result: ReturnType<typeof commit>["result"] } {
  const changes: Change[] = bodies.map((b) => {
    const key = entityKeyOf(b);
    const rev = state.revisions[key] ?? 0;
    return { ...b, operationId: `${key}#${rev + 1}`, expectedEntityRevision: rev };
  });
  const r = commit(state, state.seq, changes);
  return { state: r.state, result: r.result };
}

type Spy = { calls: Array<{ intent: DispatchIntent; attempt: TaskAttempt }> };
function mkOps(stateRef: { s: LogState }, over: Partial<TaskOps> = {}): TaskOps {
  let lid = 0;
  return {
    nowSec: () => 1000, cap: 3, budgetSec: 3480, planCommittedAtSec: 1000, remainingLifeSec: 3000, checkpointBudgetSec: 300,
    handoffMarginSec: 180, tokenMarginSec: 600, jitterSec: () => 0,
    newLaunchId: () => `rw-t${++lid}`,
    loadState: () => stateRef.s,
    commit: (state, bodies) => { const r = stampCommit(state, bodies); stateRef.s = r.state; return r; },
    observeGit: async () => null,
    startTask: async () => ({ alloc: "created", delivered: true }),
    log: () => {},
    ...over,
  };
}

function mkPlan(expectedOutput?: unknown): TaskPlan {
  const node: Record<string, unknown> = {
    nodeId: "build", kind: "work", goal: "g", dependsOn: [], outputContract: { requiredOutputs: [{ logicalName: "o", kind: "report" }] },
    acceptance: [], artifactScope: ["out/"], estimatedRuntimeSec: 600, retryBudget: 2, required: true, runtime: "ephemeral",
  };
  if (expectedOutput !== undefined) node.expectedOutput = expectedOutput;
  const res = loadPlan({ jobId: "job", planRevision: 1, nodes: [node], jobBudget: { maxTotalAttempts: 10, maxWallClockSec: 36000 } });
  if (!res.ok) throw new Error(res.reason);
  return res.plan;
}

function theIntent(state: LogState): DispatchIntent | undefined {
  for (const b of Object.values(liveEntities(state))) if (b.put === "intent") return b.intent;
  return undefined;
}

async function dispatchWith(plan: TaskPlan): Promise<DispatchIntent | undefined> {
  const stateRef = { s: initialLogState() };
  await taskPass(plan, mkOps(stateRef));
  return theIntent(stateRef.s);
}

/** Drive a full dispatch (pass 1) then an accept (pass 2, observing a valid success), wiring a verifyOutputContract spy on
 *  the accept pass. `acceptFlag` optionally flips SWARM_OUTPUT_CONTRACT between the two passes (to prove the receipt gate). */
async function driveAccept(plan: TaskPlan, acceptFlag?: string): Promise<{ spy: Spy; state: LogState }> {
  const stateRef = { s: initialLogState() };
  await taskPass(plan, mkOps(stateRef)); // pass 1: dispatch ⇒ RUNNING attempt bound to rw-t1
  const att = (() => { for (const b of Object.values(liveEntities(stateRef.s))) if (b.put === "attempt") return b.attempt; throw new Error("no attempt"); })();
  const asgId = att.executionBindings[0]!.assignmentId;
  const resultText = JSON.stringify({
    schemaVersion: 1, jobId: "job", planRevision: 1, nodeId: "build", attemptId: att.attemptId, assignmentId: asgId,
    inputBindingDigest: att.inputBindingDigest, outcome: "success", outputs: [{ logicalName: "o", kind: "report", path: "out/report.md" }], validationEvidence: [],
  });
  const facts: GitFacts = {
    observedWorkCommit: "wc1", resultText, resultBlobOid: "blob1", closureFiles: [{ path: "out/report.md", blobOid: "b2" }],
    cumulativeChangedPaths: ["out/results/" + att.attemptId + "/result.json", "out/report.md"],
    contract: { requiredOutputsPresent: true, patchAppliesClean: true }, acceptancePassed: true, withinCutoffAncestry: true,
  };
  if (acceptFlag !== undefined) setFlag(acceptFlag);
  const spy: Spy = { calls: [] };
  await taskPass(plan, mkOps(stateRef, { observeGit: async () => facts, verifyOutputContract: (a) => { spy.calls.push(a); } }));
  return { spy, state: stateRef.s };
}

// save/restore the kill-switch across cases
const savedFlag = process.env.SWARM_OUTPUT_CONTRACT;
const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env.SWARM_OUTPUT_CONTRACT; else process.env.SWARM_OUTPUT_CONTRACT = v; };

try {
  // ---------------- (a) node.expectedOutput + flag ON ⇒ intent carries the (sanitized) expectedOutput ----------------
  setFlag(undefined); // default ON
  {
    const i = await dispatchWith(mkPlan({ kind: "file", ref: "out/x.txt" }));
    t("(a) flag default-ON + node.expectedOutput(file) ⇒ intent.expectedOutput present",
      !!i && !!i.expectedOutput && i.expectedOutput.kind === "file" && i.expectedOutput.ref === "out/x.txt");

    const i2 = await dispatchWith(mkPlan({ kind: "branch", ref: "swarm/foo", check: "exists" }));
    t("(a) kind=branch with ref+check round-trips onto the intent",
      !!i2 && !!i2.expectedOutput && i2.expectedOutput.kind === "branch" && i2.expectedOutput.ref === "swarm/foo" && i2.expectedOutput.check === "exists");

    // explicit SWARM_OUTPUT_CONTRACT=1 behaves identically
    setFlag("1");
    const i3 = await dispatchWith(mkPlan({ kind: "report", ref: "docs/r.md" }));
    t("(a) SWARM_OUTPUT_CONTRACT=1 ⇒ expectedOutput stamped", !!i3 && !!i3.expectedOutput && i3.expectedOutput.kind === "report");

    // a VALID-with-extra-junk declaration is sanitized (extra stripped) by loadPlan before it ever reaches the intent
    setFlag(undefined);
    const i4 = await dispatchWith(mkPlan({ kind: "inbox-delivery", ref: "sid-1", bogus: "x" }));
    t("(a) extra fields are stripped (validateExpectedOutput) — intent carries only the known shape",
      !!i4 && !!i4.expectedOutput && i4.expectedOutput.kind === "inbox-delivery" && i4.expectedOutput.ref === "sid-1" && (i4.expectedOutput as Record<string, unknown>).bogus === undefined);
  }

  // ---------------- (b) flag OFF ⇒ no expectedOutput even when the node declares one ----------------
  setFlag("0");
  {
    const i = await dispatchWith(mkPlan({ kind: "file", ref: "out/x.txt" }));
    t("(b) SWARM_OUTPUT_CONTRACT=0 ⇒ NO expectedOutput on the intent (kill-switch)", !!i && i.expectedOutput === undefined);
  }
  setFlag("false");
  {
    const i = await dispatchWith(mkPlan({ kind: "file", ref: "out/x.txt" }));
    t("(b) SWARM_OUTPUT_CONTRACT=false ⇒ NO expectedOutput", !!i && i.expectedOutput === undefined);
  }

  // ---------------- (c) no expectedOutput ⇒ none (flag ON) ----------------
  setFlag(undefined);
  {
    const i = await dispatchWith(mkPlan(undefined));
    t("(c) flag ON but node has NO expectedOutput ⇒ no expectedOutput on intent", !!i && i.expectedOutput === undefined);
  }

  // ---------------- (d1) read-side FC-7 tolerance on intent.expectedOutput (replayLog) ----------------
  {
    const base: DispatchIntent = {
      intentId: "i1", attemptId: "a1", nodeId: "build", launchId: "rw-1", bindingId: "b1", assignmentDigest: "d",
      allocRequestStartSec: 0, workDeadlineSec: 100, allocOutcome: "created", status: "confirmed",
    };
    const mkBatch = (eo: unknown): CommittedBatch => ({
      seq: 1,
      changes: [{ put: "intent", intent: { ...base, expectedOutput: eo as DispatchIntent["expectedOutput"] }, operationId: "intent:i1#1", expectedEntityRevision: 0 }],
    });
    const projOf = (b: CommittedBatch) => theIntent(replayLog([b]));

    t("(d1) malformed expectedOutput: non-object ⇒ dropped, intent survives", (() => { const i = projOf(mkBatch("nope")); return !!i && i.expectedOutput === undefined && i.intentId === "i1"; })());
    t("(d1) malformed expectedOutput: unknown kind ⇒ dropped", (() => { const i = projOf(mkBatch({ kind: "weird", ref: "x" })); return !!i && i.expectedOutput === undefined; })());
    t("(d1) malformed expectedOutput: non-string ref ⇒ dropped", (() => { const i = projOf(mkBatch({ kind: "file", ref: 7 })); return !!i && i.expectedOutput === undefined; })());
    t("(d1) VALID expectedOutput is kept (and stripped to its known fields)", (() => {
      const i = projOf(mkBatch({ kind: "file", ref: "out/x", check: "c", extra: "junk" }));
      return !!i && !!i.expectedOutput && i.expectedOutput.kind === "file" && i.expectedOutput.ref === "out/x" && i.expectedOutput.check === "c" && (i.expectedOutput as Record<string, unknown>).extra === undefined;
    })());
    t("(d1) a legacy intent with NO expectedOutput replays unchanged", (() => {
      const legacy: CommittedBatch = { seq: 1, changes: [{ put: "intent", intent: base, operationId: "intent:i1#1", expectedEntityRevision: 0 }] };
      const i = theIntent(replayLog([legacy]));
      return !!i && i.expectedOutput === undefined && i.allocOutcome === "created";
    })());
  }

  // ---------------- (d2) loadPlan tolerance on node.expectedOutput ----------------
  {
    const okPlan = (eo: unknown) => mkPlan(eo); // mkPlan throws if loadPlan rejects
    t("(d2) node.expectedOutput not an object (string) ⇒ plan loads, dropped", okPlan("nope").nodes[0]!.expectedOutput === undefined);
    t("(d2) node.expectedOutput unknown kind ⇒ plan loads, dropped", okPlan({ kind: "bogus" }).nodes[0]!.expectedOutput === undefined);
    t("(d2) node.expectedOutput non-string ref ⇒ plan loads, dropped", okPlan({ kind: "file", ref: 9 }).nodes[0]!.expectedOutput === undefined);
    t("(d2) a valid node.expectedOutput round-trips through loadPlan (extra stripped)", (() => {
      const eo = okPlan({ kind: "report", ref: "r.md", extra: "x" }).nodes[0]!.expectedOutput;
      return !!eo && eo.kind === "report" && eo.ref === "r.md" && (eo as Record<string, unknown>).extra === undefined;
    })());
    t("(d2) legacy node with no expectedOutput ⇒ loads, undefined", mkPlan(undefined).nodes[0]!.expectedOutput === undefined);
    // FC-6 / V5: expectedOutput is EXCLUDED from specDigest (annotation family) — adding it must NOT change task identity.
    t("(d2) expectedOutput is NOT part of specDigest (adding it leaves the node's specDigest unchanged)",
      mkPlan(undefined).nodes[0]!.specDigest === mkPlan({ kind: "file", ref: "out/x" }).nodes[0]!.specDigest);
  }

  // ---------------- (d3) AW-1: op-identity stays on the committed payload; both tags sanitize together ----------------
  {
    const b9: DispatchIntent = {
      intentId: "i9", attemptId: "a9", nodeId: "build", launchId: "rw-9", bindingId: "b9", assignmentDigest: "d",
      allocRequestStartSec: 0, workDeadlineSec: 100, allocOutcome: "created", status: "confirmed",
    };
    const mkChange = (eo: unknown): Change => ({ put: "intent", intent: { ...b9, expectedOutput: eo as DispatchIntent["expectedOutput"] }, operationId: "intent:i9#1", expectedEntityRevision: 0 });
    for (const [label, eo] of ([["valid+extra", { kind: "file", ref: "x", extra: "junk" }], ["unknown-kind", { kind: "weird" }], ["non-object", "nope"]] as const)) {
      const orig = mkChange(eo);
      const state = replayLog([{ seq: 1, changes: [orig] }]); // the "new reader" folds the historical (tolerated) record
      const retry = commit(state, state.seq, [orig]);          // a byte-identical retry of the ORIGINAL committed payload
      t(`(d3) AW-1: historical ${label} expectedOutput ⇒ byte-identical retry is idempotent (no op-conflict)`, retry.result.ok === true && (retry.result as { replay?: boolean }).replay === true);
    }
    // the entity VIEW is still canonicalized (an extra key dropped) even though the op digest kept the original payload
    const trimmed = theIntent(replayLog([{ seq: 1, changes: [mkChange({ kind: "file", ref: "x", extra: "junk" })] }]));
    t("(d3) AW-1: entity view trimmed to the canonical shape (extra dropped)", !!trimmed && !!trimmed.expectedOutput && (trimmed.expectedOutput as Record<string, unknown>).extra === undefined);
    // a genuinely DIFFERENT payload for the SAME operationId ⇒ op-conflict STILL enforced
    const base9 = replayLog([{ seq: 1, changes: [mkChange({ kind: "file", ref: "x" })] }]);
    const conflict = commit(base9, base9.seq, [mkChange({ kind: "file", ref: "DIFFERENT" })]);
    t("(d3) AW-1: a genuinely different expectedOutput payload for the same op ⇒ op-conflict preserved", conflict.result.ok === false && (conflict.result as { reason?: string }).reason === "op-conflict");

    // BOTH tags on one intent: a byte-identical retry stays idempotent AND the entity view sanitizes BOTH to canonical form.
    const bothChange: Change = { put: "intent", intent: { ...b9, intentId: "iB", accountable: { accountableHuman: "u", resolutionLevel: "direct", x: 1 } as DispatchIntent["accountable"], expectedOutput: { kind: "file", ref: "x", y: 2 } as DispatchIntent["expectedOutput"] }, operationId: "intent:iB#1", expectedEntityRevision: 0 };
    const sB = replayLog([{ seq: 1, changes: [bothChange] }]);
    const retryB = commit(sB, sB.seq, [bothChange]);
    t("(d3) AW-1: an intent carrying BOTH tags ⇒ byte-identical retry idempotent", retryB.result.ok === true && (retryB.result as { replay?: boolean }).replay === true);
    const bothView = (() => { for (const b of Object.values(liveEntities(sB))) if (b.put === "intent" && b.intent.intentId === "iB") return b.intent; return undefined; })();
    t("(d3) AW-1: BOTH tags sanitized in the entity view (extras dropped from each)",
      !!bothView && !!bothView.accountable && (bothView.accountable as Record<string, unknown>).x === undefined
      && !!bothView.expectedOutput && (bothView.expectedOutput as Record<string, unknown>).y === undefined);
  }

  // ---------------- (e) RECEIPT seam: verifyOutputContract fired ONCE on accept, gated on the flag ----------------
  {
    setFlag(undefined); // ON for both passes
    const r1 = await driveAccept(mkPlan({ kind: "file", ref: "out/x.txt" }));
    t("(e) accept with an expectedOutput-carrying intent ⇒ verifyOutputContract fired exactly once", r1.spy.calls.length === 1);
    t("(e) the receipt hook gets the intent WITH its expectedOutput + the accepted attempt",
      r1.spy.calls.length === 1 && !!r1.spy.calls[0]!.intent.expectedOutput && r1.spy.calls[0]!.intent.expectedOutput!.kind === "file" && r1.spy.calls[0]!.attempt.nodeId === "build");

    setFlag(undefined);
    const r2 = await driveAccept(mkPlan(undefined));
    t("(e) accept with NO expectedOutput on the intent ⇒ hook NOT fired", r2.spy.calls.length === 0);

    // kill-switch AT RECEIPT: dispatch with the flag ON (intent gets stamped), then flip OFF before the accept pass ⇒
    // the receipt gate silences even a stale-stamped intent (hook not fired).
    setFlag(undefined);
    const r3 = await driveAccept(mkPlan({ kind: "file", ref: "out/x.txt" }), "0");
    t("(e) kill-switch at accept-time (flag flipped to 0 before accept) ⇒ hook NOT fired even on a stale-stamped intent", r3.spy.calls.length === 0);
  }

  console.log("\noutput-contract-wiring self-check OK");
} finally {
  setFlag(savedFlag);
}
